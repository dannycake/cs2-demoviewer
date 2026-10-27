#!/usr/bin/env node
// node tools/phone-tier.mjs <map>... | players | all
//
// The phone tier, the models the viewer's `low` preset (phones) loads: a shipped GLB again with
// its textures fitted within a phone's size, every other byte as it is.
//   assets/maps/<map>/world.glb → world_lo.glb   textures within 128 px, WebP q60 (world.glb's)
//   assets/players/<side>.glb   → <side>_lo.glb  textures within 512 px, WebP q80 (<side>.glb's)
// each with a gzip -9 `.gz` sibling (lib/gz.mjs) and a record, world_lo.json or <side>_lo.json:
// the source's bytes and sha256, the parameters, the output's bytes, sha256 and gz bytes, and its
// textures (how many fitted and copied, the largest side, the bytes they take as RGBA).
// manifest.mjs lists the output only while its record says it was made from the source there.
// `all` is every map under ASSETS_DIR/maps with a world.glb, then the players.
//
// A texture larger than the size is fitted within it as the shrinks fit theirs (lib/alpha.mjs
// fitImage: colour and alpha resized apart, the alpha kept only on a texture some MASK or BLEND
// material draws as its base colour) and encoded as WebP at the source's quality; one already
// within it is copied as it is, so a small texture loses nothing to a second encode. The GLB is
// edited, not read and written again by gltf-transform, which would decode and re-encode its
// meshopt-compressed geometry and animation: the new images take the old ones' places in the
// binary chunk, every other range of it is copied with its order and alignment, and the JSON
// changes only in those ranges' offsets and lengths and the buffer's length. world.glb,
// hull.glb, ct.glb and t.glb are only read.
//
// Idempotent: a target whose record names its source's current sha256 and these parameters, and
// whose file and `.gz` are the ones the record describes, is skipped ("up to date"). Otherwise it
// is built, checked against its source (phoneProblems: every byte but the images', and every
// image fitted or copied as above), written into <out>.tmp-<pid>/ and renamed into <out>
// (lib/stage.mjs): the `.gz`, the GLB, then the record. A failure leaves <out> as it was; the
// run goes on to the next target and exits 1 at the end. A signal leaves <out>.tmp-<pid>/
// behind, which build-assets.sh removes when it next starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { fitImage, fitWithin } from './lib/alpha.mjs';
import { isMain } from './lib/cli.mjs';
import { GZIP, gzSiblingState } from './lib/gz.mjs';
import { assetsDir } from './lib/paths.mjs';
import { SIDES } from './lib/players.mjs';
import { staging } from './lib/stage.mjs';
import { PARAMS as MAP_PARAMS } from './shrink-map.mjs';
import { PARAMS as PLAYER_PARAMS } from './shrink-player.mjs';

/** The world's phone tier: world.glb's textures within 128 px, at its WebP quality (shrink-map.mjs PARAMS.world). */
export const PHONE_WORLD = Object.freeze({ from: 'world.glb', to: 'world_lo.glb', record: 'world_lo.json', size: 128, quality: MAP_PARAMS.world.quality });

/** A player's phone tier: `<side>.glb`'s textures within 512 px, at its WebP quality (shrink-player.mjs PARAMS.texture). */
export function phonePlayer(side) {
  return Object.freeze({ from: `${side}.glb`, to: `${side}_lo.glb`, record: `${side}_lo.json`, size: 512, quality: PLAYER_PARAMS.texture.quality });
}

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const pad4 = (n) => Math.ceil(n / 4) * 4;

/** The JSON and the binary chunk of a glTF 2.0 GLB. */
export function parseGlb(bytes) {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(4) !== 2) throw new Error('not a glTF 2.0 GLB');
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error(`the GLB header says ${bytes.readUInt32LE(8)} bytes, the file has ${bytes.length}`);
  const jsonLength = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== CHUNK_JSON) throw new Error('the GLB does not start with its JSON chunk');
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const at = 20 + jsonLength;
  if (at >= bytes.length) return { json, bin: Buffer.alloc(0) };
  if (bytes.readUInt32LE(at + 4) !== CHUNK_BIN) throw new Error('the GLB\'s second chunk is not its binary chunk');
  return { json, bin: bytes.subarray(at + 8, at + 8 + bytes.readUInt32LE(at)) };
}

/** A GLB of `json` and `bin`, each chunk padded to 4 bytes as gltf-transform pads them (JSON with spaces, binary with zeros). */
export function formatGlb(json, bin) {
  const chunk = (data, type, fill) => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(pad4(data.length), 0);
    header.writeUInt32LE(type, 4);
    return [header, data, Buffer.alloc(pad4(data.length) - data.length, fill)];
  };
  const parts = [...chunk(Buffer.from(JSON.stringify(json), 'utf8'), CHUNK_JSON, 0x20), ...(bin.length ? chunk(bin, CHUNK_BIN, 0) : [])];
  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + parts.reduce((n, p) => n + p.length, 0), 8);
  return Buffer.concat([header, ...parts]);
}

/**
 * Every range of the binary chunk (buffer 0): each buffer view on it (`view` its index) and each
 * meshopt-compressed range on it (`view` -1), as `{ def, view }` where `def` holds its byteOffset
 * and byteLength, in byte order. Throws when buffer 0 is not the binary chunk or two ranges overlap.
 */
function binRanges(json) {
  if (!json.buffers?.[0] || json.buffers[0].uri !== undefined) throw new Error('buffer 0 is not the GLB\'s binary chunk');
  const ranges = [];
  (json.bufferViews ?? []).forEach((def, view) => {
    if (def.buffer === 0) ranges.push({ def, view });
    const meshopt = def.extensions?.EXT_meshopt_compression;
    if (meshopt?.buffer === 0) ranges.push({ def: meshopt, view: -1 });
  });
  ranges.sort((a, b) => (a.def.byteOffset ?? 0) - (b.def.byteOffset ?? 0));
  let end = 0;
  for (const r of ranges) {
    if ((r.def.byteOffset ?? 0) < end) throw new Error('two ranges of the binary chunk overlap');
    end = (r.def.byteOffset ?? 0) + r.def.byteLength;
  }
  return ranges;
}

/** The bytes of image `i`, which must be in a buffer view of its own on the binary chunk. */
function imageData({ json, bin }, i) {
  const image = json.images[i];
  const view = json.bufferViews?.[image.bufferView];
  if (!view || view.buffer !== 0 || view.extensions) throw new Error(`image ${i} is not in a buffer view of the binary chunk`);
  return bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
}

/**
 * The GLB `{ json, bin }` with each image of `replace` (image index → its new bytes) in place of
 * its own. Every range of the binary chunk keeps its order and its alignment (up to 8 bytes) and,
 * but for those images, its bytes; the JSON changes only in the ranges' offsets and lengths and
 * the binary buffer's length. Returns a new `{ json, bin }`.
 */
export function replaceImages({ json, bin }, replace) {
  json = structuredClone(json);
  const viewImage = new Map([...replace.keys()].map((i) => [json.images[i].bufferView, i]));
  if (viewImage.size !== replace.size) throw new Error('two images share a buffer view');
  const parts = [];
  let cursor = 0;
  for (const { def, view } of binRanges(json)) {
    const offset = def.byteOffset ?? 0;
    const data = viewImage.has(view) ? replace.get(viewImage.get(view)) : bin.subarray(offset, offset + def.byteLength);
    const align = offset % 8 === 0 ? 8 : offset % 4 === 0 ? 4 : offset % 2 === 0 ? 2 : 1;
    const at = Math.ceil(cursor / align) * align;
    parts.push(Buffer.alloc(at - cursor), data);
    if (def.byteOffset !== undefined || at !== 0) def.byteOffset = at;
    def.byteLength = data.length;
    cursor = at + data.length;
  }
  parts.push(Buffer.alloc(pad4(cursor) - cursor));
  json.buffers[0].byteLength = pad4(cursor);
  return { json, bin: Buffer.concat(parts) };
}

/** The image a glTF texture samples, plain or under one of the image-format extensions. */
const textureSource = (t) => t?.source ?? t?.extensions?.EXT_texture_webp?.source ?? t?.extensions?.EXT_texture_avif?.source ?? t?.extensions?.KHR_texture_basisu?.source;

/** Images some MASK or BLEND material reads as its base colour: the only alpha drawn (lib/alpha.mjs alphaTextures). */
function alphaImages(json) {
  const drawn = new Set();
  for (const m of json.materials ?? []) {
    const t = m.pbrMetallicRoughness?.baseColorTexture;
    if (t && (m.alphaMode ?? 'OPAQUE') !== 'OPAQUE') drawn.add(textureSource(json.textures?.[t.index]));
  }
  return drawn;
}

const dims = async (data) => {
  const { width, height } = await sharp(data).metadata();
  return [width, height];
};
const within = ([w, h], size) => w <= size && h <= size;
const label = (json, i) => `image ${i}${json.images[i].name ? ` (${json.images[i].name})` : ''}`;

/**
 * The phone tier of the GLB `bytes`: each image larger than `size` px fitted within it (lib/alpha.mjs
 * fitImage) and encoded as WebP at `quality`, each other image as it is (see the header). Returns
 * the new GLB and its textures: `{ count, fitted, copied, maxSide, rgbaBytes, sourceRgbaBytes }`
 * (`maxSide` the largest width or height, the RGBA bytes without mipmaps).
 */
export async function phoneTier(bytes, { size, quality }) {
  const glb = parseGlb(bytes);
  const drawn = alphaImages(glb.json);
  const replace = new Map();
  const textures = { count: 0, fitted: 0, copied: 0, maxSide: 0, rgbaBytes: 0, sourceRgbaBytes: 0 };
  for (let i = 0; i < (glb.json.images ?? []).length; i++) {
    const data = imageData(glb, i);
    const from = await dims(data);
    let to = from;
    if (within(from, size)) textures.copied++;
    else {
      if (glb.json.images[i].mimeType !== 'image/webp') throw new Error(`${label(glb.json, i)} is ${glb.json.images[i].mimeType}; only WebP images are fitted`);
      const png = await fitImage(data, [size, size], drawn.has(i));
      replace.set(i, await sharp(png).webp({ quality, lossless: false, nearLossless: false }).toBuffer());
      to = fitWithin(from, [size, size]);
      textures.fitted++;
    }
    textures.count++;
    textures.maxSide = Math.max(textures.maxSide, ...to);
    textures.rgbaBytes += to[0] * to[1] * 4;
    textures.sourceRgbaBytes += from[0] * from[1] * 4;
  }
  const out = replace.size ? replaceImages(glb, replace) : glb;
  return { bytes: formatGlb(out.json, out.bin), textures };
}

/** `json` without the layout of its binary chunk: its ranges' offsets and lengths and its buffer's length. */
function withoutLayout(json) {
  json = structuredClone(json);
  for (const { def } of binRanges(json)) {
    delete def.byteOffset;
    delete def.byteLength;
  }
  delete json.buffers[0].byteLength;
  return json;
}

/**
 * Whether `out` is the phone tier of `src` at `size` px: its JSON as `src`'s but for the binary
 * chunk's layout, every range of that chunk but the images' with `src`'s bytes, each image of
 * `src` within the size there as it is and each larger one a WebP of fitWithin's size. Returns
 * `{ problems, textures }`: what is not so, and `out`'s textures as phoneTier counts them.
 */
export async function phoneProblems(src, out, size) {
  const a = parseGlb(src);
  const b = parseGlb(out);
  const problems = [];
  if (JSON.stringify(withoutLayout(a.json)) !== JSON.stringify(withoutLayout(b.json))) problems.push('the JSON differs from the source\'s beyond the binary chunk\'s layout');
  else {
    // The same JSON but for the layout, so each range of `src` pairs with the one `out` defines
    // in the same place.
    const defs = (json) => (json.bufferViews ?? []).flatMap((v) => [v.buffer === 0 ? v : null, v.extensions?.EXT_meshopt_compression?.buffer === 0 ? v.extensions.EXT_meshopt_compression : null]);
    const bDefs = defs(b.json);
    const pair = new Map(defs(a.json).map((d, k) => [d, bDefs[k]]));
    const images = new Set((a.json.images ?? []).map((im) => im.bufferView));
    const slice = (bin, def) => bin.subarray(def.byteOffset ?? 0, (def.byteOffset ?? 0) + def.byteLength);
    for (const r of binRanges(a.json)) {
      if (r.view >= 0 && images.has(r.view)) continue;
      if (!slice(a.bin, r.def).equals(slice(b.bin, pair.get(r.def)))) {
        problems.push(`${r.view >= 0 ? `buffer view ${r.view}` : 'a meshopt-compressed range'} differs from the source's`);
        break;
      }
    }
  }
  const textures = { count: 0, fitted: 0, copied: 0, maxSide: 0, rgbaBytes: 0, sourceRgbaBytes: 0 };
  const n = (a.json.images ?? []).length;
  if ((b.json.images ?? []).length !== n) problems.push(`${(b.json.images ?? []).length} images, the source has ${n}`);
  else {
    for (let i = 0; i < n; i++) {
      const before = imageData(a, i);
      const after = imageData(b, i);
      const from = await dims(before);
      const to = await dims(after);
      if (within(from, size)) {
        if (!after.equals(before)) problems.push(`${label(a.json, i)} is within ${size} px in the source but not copied as it is`);
        textures.copied++;
      } else {
        const want = fitWithin(from, [size, size]);
        const { format } = await sharp(after).metadata();
        if (to[0] !== want[0] || to[1] !== want[1]) problems.push(`${label(a.json, i)} is ${to.join('×')}, not ${want.join('×')}`);
        else if (format !== 'webp' || b.json.images[i].mimeType !== 'image/webp') problems.push(`${label(a.json, i)} is ${format} (${b.json.images[i].mimeType}), not WebP`);
        textures.fitted++;
      }
      textures.count++;
      textures.maxSide = Math.max(textures.maxSide, ...to);
      textures.rgbaBytes += to[0] * to[1] * 4;
      textures.sourceRgbaBytes += from[0] * from[1] * 4;
    }
  }
  return { problems, textures };
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The record of `target` in `dir` (phone-tier.mjs writes it), or null when there is none or it does not parse. */
export function readPhoneRecord(dir, target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, target.record), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Builds `target` in `dir` (see the header) unless it is up to date. Returns its record and
 * whether it was skipped and how long it took; throws, leaving `dir` as it was, when its source is
 * missing or the build fails its check.
 */
export async function buildPhoneTarget(dir, target) {
  const t0 = performance.now();
  const srcFile = path.join(dir, target.from);
  if (!fs.existsSync(srcFile)) throw new Error(`${srcFile} is missing`);
  const src = fs.readFileSync(srcFile);
  const source = { file: target.from, bytes: src.length, sha256: sha256(src) };
  const params = { size: target.size, format: 'webp', quality: target.quality };
  const outFile = path.join(dir, target.to);
  const old = readPhoneRecord(dir, target);
  if (old && sameJson(old.source, source) && sameJson(old.params, params) && fs.existsSync(outFile)
    && sha256(fs.readFileSync(outFile)) === old.sha256 && gzSiblingState(outFile) === 'ok') {
    return { record: old, skipped: true, seconds: 0 };
  }

  const { bytes, textures } = await phoneTier(src, params);
  const { problems } = await phoneProblems(src, bytes, target.size);
  if (problems.length) throw new Error(`${target.to} is not ${target.from} with smaller textures: ${problems[0]}`);
  const gz = zlib.gzipSync(bytes, GZIP);
  const record = { file: target.to, bytes: bytes.length, sha256: sha256(bytes), gzBytes: gz.length, source, params, textures };

  const stage = staging(dir);
  try {
    const files = [[`${target.to}.gz`, gz], [target.to, bytes], [target.record, JSON.stringify(record, null, 2) + '\n']];
    for (const [name, data] of files) stage.write(name, data);
    stage.commit(dir, files.map(([name]) => name));
  } finally {
    stage.abort();
  }
  return { record, skipped: false, seconds: (performance.now() - t0) / 1000 };
}

/**
 * check-map.mjs's and check-players.mjs's rows for `target` in `dir`, as [check, actual, budget,
 * status]: one SKIP row without its GLB (the `low` preset loads the source); else whether its
 * record describes it, made from the source as it is now, the GLB against the source
 * (phoneProblems), its textures, its size against the source's and its `.gz`. `rerun` is the
 * command that rebuilds it.
 */
export async function phoneRows(dir, target, rerun) {
  const file = path.join(dir, target.to);
  const srcFile = path.join(dir, target.from);
  if (!fs.existsSync(file)) return [[target.to, `none (low loads ${target.from})`, 'optional', 'SKIP']];
  if (!fs.existsSync(srcFile)) return [[target.to, `there without ${target.from}`, `made from ${target.from}`, 'FAIL']];
  const status = (ok) => (ok ? 'OK' : 'FAIL');
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  const src = fs.readFileSync(srcFile);
  const out = fs.readFileSync(file);
  const record = readPhoneRecord(dir, target);
  const fresh = record?.source?.sha256 === sha256(src) && record?.sha256 === sha256(out);
  const rows = [[`${target.to} record`, !record ? `no ${target.record}` : fresh ? `${target.record}` : `${target.record} is stale (rerun ${rerun})`, `describes it, made from this ${target.from}`, status(fresh)]];
  let checked;
  try {
    checked = await phoneProblems(src, out, target.size);
  } catch (e) {
    checked = { problems: [String(e?.message ?? e)], textures: null };
  }
  const { problems, textures: t } = checked;
  rows.push([`${target.to} vs ${target.from}`, problems.length ? `${problems.length} problem(s): ${problems[0]}` : `${t.fitted} textures fitted, ${t.copied} copied, the rest the same`,
    `every byte but the textures' the same, each texture over ${target.size} px fitted within it`, status(!problems.length)]);
  if (t) rows.push([`${target.to} textures`, `${t.count}, largest side ${t.maxSide} px, ${mb(t.rgbaBytes)} as RGBA (${target.from} ${mb(t.sourceRgbaBytes)})`, `≤ ${target.size} px`, status(t.maxSide <= target.size)]);
  rows.push([`${target.to} size`, mb(out.length), `≤ ${target.from} (${mb(src.length)})`, status(out.length <= src.length)]);
  const gz = gzSiblingState(file);
  rows.push([`${target.to}.gz`, gz === 'ok' ? mb(fs.statSync(`${file}.gz`).size) : gz, 'inflates to the .glb', status(gz === 'ok')]);
  return rows;
}

const usage = 'usage: node tools/phone-tier.mjs <map>... | players | all';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.some((a) => !/^[a-z0-9_]+$/.test(a))) {
    console.error(usage);
    process.exit(2);
  }
  const root = assetsDir();
  const mapsDir = path.join(root, 'maps');
  const builtMaps = () => (fs.existsSync(mapsDir) ? fs.readdirSync(mapsDir).filter((m) => !m.includes('.tmp-') && fs.existsSync(path.join(mapsDir, m, 'world.glb'))).sort() : []);
  const jobs = [];
  for (const a of args) {
    if (a === 'all') jobs.push(...builtMaps().map((m) => ['map', m]), ['players']);
    else if (a === 'players') jobs.push(['players']);
    else jobs.push(['map', a]);
  }
  const targets = [];
  const seen = new Set();
  for (const [kind, map] of jobs) {
    const list = kind === 'map'
      ? [[map, path.join(mapsDir, map), PHONE_WORLD]]
      : SIDES.map((side) => ['players', path.join(root, 'players'), phonePlayer(side)]);
    for (const t of list) {
      const key = path.join(t[1], t[2].to);
      if (!seen.has(key)) { seen.add(key); targets.push(t); }
    }
  }

  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  let failed = false;
  for (const [name, dir, target] of targets) {
    try {
      const { record: r, skipped, seconds } = await buildPhoneTarget(dir, target);
      if (skipped) { console.log(`${name}: ${target.to} up to date`); continue; }
      const t = r.textures;
      console.log(`${name}: ${target.to} ${mb(r.bytes)} (${mb(r.gzBytes)} gz) from ${target.from} ${mb(r.source.bytes)}: ${t.count} textures (${t.fitted} fitted, ${t.copied} copied) within ${target.size} px q${target.quality}, largest side ${t.maxSide} px, ${mb(t.rgbaBytes)} as RGBA (${mb(t.sourceRgbaBytes)} before), in ${seconds.toFixed(1)}s`);
    } catch (e) {
      if (process.env.DEBUG) console.error(e?.stack);
      console.error(`phone-tier: ${name}: ${String(e?.message ?? e).split('\n')[0]}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) await main();
