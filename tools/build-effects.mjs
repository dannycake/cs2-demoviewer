#!/usr/bin/env node
// node tools/build-effects.mjs [<key>…]
//
// Packs the frames rip-effects.sh exported into one WebP flipbook atlas per EFFECTS key
// (lib/effects.mjs), all of them unless keys are named:
//   assets/effects/<key>.webp   cells of the key's size in rows of 1024 px, frame 0 top-left;
//                               each frame scaled by its sequence's one factor (placeFrame),
//                               colour and alpha resized apart, the colour under transparent
//                               pixels bled from the frame so filtering never darkens an edge
//   assets/effects/build.json   { cs2Build, vrfVersion, atlases: { <key>: { file, bytes, width,
//                               height, cell, cols, rows, frames, sequences, quality } } }
// An opaque decal takes its alpha from its darkness (decalAlpha). The same rip gives the same
// bytes on every run. Exit 1 naming the file when the rip lacks one.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { bleed, resizeApart } from './lib/alpha.mjs';
import { decalAlpha, EFFECT_KEYS, EFFECTS, effectsPaths, layoutAtlas, parseMks, placeFrame, selectFrames } from './lib/effects.mjs';
import { writeFileAtomic, writeJsonAtomic } from './lib/stage.mjs';

function fail(msg) {
  console.error(`build-effects: ${msg}`);
  process.exit(1);
}

const keys = process.argv.slice(2);
for (const k of keys) if (!EFFECT_KEYS.includes(k)) fail(`unknown effect '${k}'; one of ${EFFECT_KEYS.join(', ')}`);
const P = effectsPaths();
if (!fs.existsSync(P.ripJson)) fail(`${P.ripJson} is missing; run tools/rip-effects.sh`);
const rip = JSON.parse(fs.readFileSync(P.ripJson, 'utf8'));

/** The parsed `.mks` of a source, or null when its export has none. */
function sheetOf(vtex) {
  const files = rip.files?.[vtex];
  if (!Array.isArray(files)) throw new Error(`${P.ripJson} has no files for ${vtex}; run tools/rip-effects.sh --force`);
  const mks = files.find((f) => f.endsWith('.mks'));
  return mks ? parseMks(fs.readFileSync(path.join(P.raw, mks), 'utf8')) : null;
}

/** A frame's pixels as RGBA, with an opaque decal's alpha made from its darkness. */
async function framePixels(key, frame) {
  const file = path.join(P.raw, path.dirname(frame.vtex), frame.file);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing; run tools/rip-effects.sh --force`);
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (key === 'decals') decalAlpha(data);
  return { data, width: info.width, height: info.height };
}

async function buildAtlas(key) {
  const effect = EFFECTS[key];
  const sheets = Object.fromEntries(effect.sources.map((s) => [s.vtex, sheetOf(s.vtex)]));
  const { frames, sequences } = selectFrames(effect, sheets);
  const pixels = [];
  for (const f of frames) pixels.push(await framePixels(key, f));
  const seqMax = sequences.map(([first, count]) => {
    const own = pixels.slice(first, first + count);
    return [Math.max(...own.map((p) => p.width)), Math.max(...own.map((p) => p.height))];
  });

  const [cw, ch] = effect.cell;
  const layout = layoutAtlas(frames.length, effect.cell);
  const atlas = Buffer.alloc(layout.width * layout.height * 4);
  for (let i = 0; i < frames.length; i++) {
    const p = pixels[i];
    const [mw, mh] = seqMax[frames[i].sequence];
    const at = placeFrame(p.width, p.height, mw, mh, effect.cell, effect.anchor);
    bleed(p.data, p.width, p.height);
    const scaled = await resizeApart(p.data, p.width, p.height, at.width, at.height);
    // The cell on its own, so the colour bled under its transparent pixels is this frame's.
    const cell = Buffer.alloc(cw * ch * 4);
    for (let y = 0; y < at.height; y++) scaled.copy(cell, ((at.top + y) * cw + at.left) * 4, y * at.width * 4, (y + 1) * at.width * 4);
    bleed(cell, cw, ch);
    const x0 = (i % layout.cols) * cw;
    const y0 = Math.floor(i / layout.cols) * ch;
    for (let y = 0; y < ch; y++) cell.copy(atlas, ((y0 + y) * layout.width + x0) * 4, y * cw * 4, (y + 1) * cw * 4);
  }
  const webp = await sharp(atlas, { raw: { width: layout.width, height: layout.height, channels: 4 } })
    .webp({ quality: effect.quality, alphaQuality: 90, effort: 6 })
    .toBuffer();
  const file = `${key}.webp`;
  const out = path.join(P.out, file);
  writeFileAtomic(out, webp);
  return {
    file, bytes: webp.length, width: layout.width, height: layout.height, cell: [cw, ch],
    cols: layout.cols, rows: layout.rows, frames: frames.length, sequences, quality: effect.quality,
  };
}

fs.mkdirSync(P.out, { recursive: true });
let previous = {};
if (keys.length && fs.existsSync(P.buildJson)) {
  const b = JSON.parse(fs.readFileSync(P.buildJson, 'utf8'));
  if (b.cs2Build === rip.cs2Build) previous = b.atlases ?? {};
}
const atlases = {};
const kb = (n) => `${(n / 1e3).toFixed(1)} KB`;
try {
  for (const key of EFFECT_KEYS) {
    if (keys.length && !keys.includes(key)) {
      if (previous[key]) atlases[key] = previous[key];
      continue;
    }
    const a = await buildAtlas(key);
    atlases[key] = a;
    console.log(`build-effects: ${a.file.padEnd(15)} ${String(a.width).padStart(4)}×${String(a.height).padEnd(4)} ${String(a.frames).padStart(3)} frames in ${String(a.sequences.length).padStart(2)} sequence(s), ${kb(a.bytes)}`);
  }
} catch (e) {
  if (process.env.DEBUG) console.error(e?.stack);
  fail(String(e?.message ?? e).split('\n')[0]);
}
writeJsonAtomic(P.buildJson, { cs2Build: rip.cs2Build, vrfVersion: rip.vrfVersion, atlases });
const total = Object.values(atlases).reduce((n, a) => n + a.bytes, 0);
console.log(`build-effects: ${Object.keys(atlases).length} atlas(es), ${kb(total)} in ${path.relative(process.cwd(), P.out) || '.'}`);
