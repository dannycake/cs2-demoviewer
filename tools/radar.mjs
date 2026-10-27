#!/usr/bin/env node
// node tools/radar.mjs <map>
//
// assets/raw/<map>/radar.png        → assets/maps/<map>/radar.png        (PNG, 1024×1024, alpha kept)
// assets/raw/<map>/radar_lower.png  → assets/maps/<map>/radar_lower.png  (only when the overview has a "lower" section)
// assets/raw/<map>/overview.txt     → assets/maps/<map>/overview.json    (lib/overview.mjs Overview, Source units)
//
// Every vertical section the overview declares needs its image in the raw dir, and
// every radar image in the raw dir needs a section; a mismatch exits 2 and writes
// nothing, so overview.json never names a missing image and no image goes unnamed.
// Images are re-encoded with sharp (PNG, compressionLevel 9, adaptive filtering; a
// square radar of another size is resized to 1024, a non-square one is an error), so
// the output is byte-identical across runs. Everything is written into
// <out>.tmp-<pid>/ (lib/stage.mjs) and renamed into <out>, images first and overview.json
// last; then a radar*.png in <out> that no section names (left by an earlier run) is removed.
// Other files in <out> (world, hull, manifest) are left alone.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { parseKv } from './lib/kv.mjs';
import { overviewFromKv, sectionsFromKv, sectionImage, RADAR_SIZE } from './lib/overview.mjs';
import { paths } from './lib/paths.mjs';
import { staging, tmpPath } from './lib/stage.mjs';

// adaptiveFiltering picks a PNG row filter per row: lossless and deterministic, and
// 5–15 % smaller than compressionLevel 9 alone (which came out larger than VRF's own PNGs).
export const PNG_OPTIONS = Object.freeze({ compressionLevel: 9, adaptiveFiltering: true });

/** radar.png, radar_<section>.png */
const RADAR_FILE = /^radar(?:_([a-z0-9_]+))?\.png$/i;

/** exitCode 2: the overview's sections and the radar images do not match. */
class RadarError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

/**
 * Writes radar.png, radar_<section>.png for every other section, and overview.json
 * into outDir from rawDir's overview.txt and radar images.
 * @param {string} map  e.g. 'de_nuke'
 * @param {string} rawDir  assets/raw/<map>
 * @param {string} outDir  assets/maps/<map>
 * @returns {Promise<import('./lib/overview.mjs').Overview>}
 */
export async function buildRadar(map, rawDir, outDir) {
  const overviewTxt = path.join(rawDir, 'overview.txt');
  if (!fs.existsSync(overviewTxt)) throw new RadarError(`${overviewTxt} is missing; run tools/rip-map.sh ${map}`);
  const kv = parseKv(fs.readFileSync(overviewTxt, 'utf8'));

  const sections = sectionsFromKv(map, kv);
  for (const s of sections) {
    const f = path.join(rawDir, s.image);
    if (!fs.existsSync(f)) {
      throw new RadarError(`${map}: overview.txt declares section "${s.name}" but ${f} is missing`, 2);
    }
  }
  const images = {};
  for (const f of fs.readdirSync(rawDir).sort()) {
    const m = RADAR_FILE.exec(f);
    const name = m && (m[1] ?? 'default');
    if (m && sectionImage(name) === f) images[name] = f;
  }
  const declared = new Set(sections.map((s) => s.name));
  for (const [name, f] of Object.entries(images)) {
    if (!declared.has(name)) {
      throw new RadarError(`${map}: ${path.join(rawDir, f)} exists but overview.txt has no "${name}" section in verticalsections`, 2);
    }
  }
  const ov = overviewFromKv(map, kv, images);

  // Decode, check and encode every image before anything is written.
  const encoded = [];
  for (const s of ov.sections) {
    const src = path.join(rawDir, s.image);
    const { width, height } = await sharp(src).metadata();
    if (width !== height) throw new RadarError(`${src} is ${width}x${height}; a radar must be square`);
    let img = sharp(src);
    if (width !== RADAR_SIZE) img = img.resize(RADAR_SIZE, RADAR_SIZE, { kernel: 'lanczos3' });
    encoded.push([s.image, await img.png(PNG_OPTIONS).toBuffer()]);
  }

  const stage = staging(outDir);
  try {
    for (const [f, bytes] of encoded) stage.write(f, bytes);
    stage.write('overview.json', JSON.stringify(ov, null, 2) + '\n');
    const written = ov.sections.map((s) => s.image);
    stage.commit(outDir, [...written, 'overview.json']);
    for (const f of fs.readdirSync(outDir)) {
      if (RADAR_FILE.test(f) && !written.includes(f)) fs.rmSync(path.join(outDir, f), { force: true });
    }
  } finally {
    stage.abort();
  }
  return ov;
}

function fail(msg, code = 1) {
  console.error(`radar: ${msg}`);
  process.exit(code);
}

async function main() {
  const map = process.argv[2];
  if (!map || process.argv.length > 3) fail('usage: node tools/radar.mjs <map>');
  let P;
  try { P = paths(map); } catch (e) { fail(e.message); }
  const cleanup = () => fs.rmSync(tmpPath(P.out), { recursive: true, force: true });
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
  let ov;
  try {
    ov = await buildRadar(map, P.raw, P.out);
  } catch (e) {
    if (process.env.DEBUG) console.error(e?.stack);
    fail(String(e?.message ?? e).split('\n')[0], e?.exitCode ?? 1);
  }
  const kb = (f) => `${(fs.statSync(path.join(P.out, f)).size / 1e3).toFixed(1)} kB`;
  const files = ov.sections.map((s) => `${s.image} ${kb(s.image)}`).join(', ');
  console.log(`radar: ${map} → ${path.relative(process.cwd(), P.out) || '.'}: ${files}, overview.json (sections ${ov.sections.map((s) => s.name).join(', ')}; pos ${ov.posX}, ${ov.posY}, scale ${ov.scale})`);
}

if (isMain(import.meta.url)) await main();
