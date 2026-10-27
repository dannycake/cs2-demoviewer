import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document } from '@gltf-transform/core';
import { EXTTextureWebP } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import sharp from 'sharp';
import { createIO, MeshoptEncoder } from '../lib/gltf.mjs';
import { formatGlb, parseGlb, phoneProblems, phoneRows, phoneTier, PHONE_WORLD, phonePlayer } from '../phone-tier.mjs';

const PHONE_TIER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'phone-tier.mjs');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-tier-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const run = (...args) => spawnSync(process.execPath, [PHONE_TIER, ...args], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f.includes('.tmp-'));

/** A `w`×`h` WebP (q60) of a pattern that depends on `seed`; alpha from `alpha(x, y)`, or none. */
function webp(w, h, seed, alpha = null) {
  const channels = alpha ? 4 : 3;
  const data = Buffer.alloc(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * channels;
      data[p] = (x * 7 + seed * 31) & 255;
      data[p + 1] = (y * 5 + seed * 17) & 255;
      data[p + 2] = ((x ^ y) + seed) & 255;
      if (alpha) data[p + 3] = alpha(x, y);
    }
  }
  return sharp(data, { raw: { width: w, height: h, channels } }).webp({ quality: 60 }).toBuffer();
}

/**
 * A GLB as the shrinks write one: one quad per texture spec (`{ w, h, alpha?, mode? }`, `mode` its
 * material's alpha mode), the textures WebP under EXT_texture_webp, meshopt-compressed with one
 * quantization volume.
 */
async function fixtureGlb(specs) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const position = doc.createAccessor().setType('VEC3').setBuffer(buffer)
    .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]));
  const uv = doc.createAccessor().setType('VEC2').setBuffer(buffer).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
  const indices = doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(new Uint16Array([0, 1, 2, 2, 1, 3]));
  for (const [i, s] of specs.entries()) {
    const texture = doc.createTexture(`t${i}`).setImage(await webp(s.w, s.h, i + 1, s.alpha)).setMimeType('image/webp');
    const material = doc.createMaterial(`m${i}`).setBaseColorTexture(texture).setAlphaMode(s.mode ?? 'OPAQUE');
    const prim = doc.createPrimitive().setAttribute('POSITION', position).setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material);
    scene.addChild(doc.createNode(`n${i}`).setMesh(doc.createMesh(`mesh${i}`).addPrimitive(prim)).setTranslation([i * 2, 0, 0]));
  }
  doc.createExtension(EXTTextureWebP).setRequired(true);
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high', quantizationVolume: 'scene' }));
  const io = await createIO();
  return Buffer.from(await io.writeBinary(doc));
}

// The world: a 1024² texture whose alpha no material draws, a 256×64 cutout a MASK material
// draws, and a 64×32 one already within the phone's 128 px.
const half = (x) => (x < 128 ? 255 : 0);
const WORLD = [
  { w: 1024, h: 1024, alpha: (x, y) => (x + y) & 255 },
  { w: 256, h: 64, alpha: (x) => half(x), mode: 'MASK' },
  { w: 64, h: 32 },
];

function writeMap(map, bytes) {
  const dir = path.join(root, 'maps', map);
  fs.mkdirSync(dir, { recursive: true });
  if (bytes) fs.writeFileSync(path.join(dir, 'world.glb'), bytes);
  return dir;
}

/** Each image's size, alpha and bytes. */
async function images(bytes) {
  const { json, bin } = parseGlb(bytes);
  return Promise.all(json.images.map(async (image) => {
    const view = json.bufferViews[image.bufferView];
    const data = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    const m = await sharp(data).metadata();
    return { size: [m.width, m.height], format: m.format, hasAlpha: m.hasAlpha, mimeType: image.mimeType, data };
  }));
}

/**
 * `json` without what moving the images changes: the offsets and lengths of the ranges of the
 * binary chunk (its buffer views, and the meshopt-compressed ranges in it) and its buffer's length.
 */
function withoutLayout(json) {
  const j = structuredClone(json);
  for (const v of j.bufferViews) {
    if (v.buffer === 0) { delete v.byteOffset; delete v.byteLength; }
    const m = v.extensions?.EXT_meshopt_compression;
    if (m?.buffer === 0) { delete m.byteOffset; delete m.byteLength; }
  }
  delete j.buffers[0].byteLength;
  return j;
}

/** The bytes of every range of the binary chunk that is not an image, in buffer view order. */
function nonImageRanges({ json, bin }) {
  const imageViews = new Set(json.images.map((i) => i.bufferView));
  const out = [];
  json.bufferViews.forEach((v, i) => {
    const slice = (r) => bin.subarray(r.byteOffset ?? 0, (r.byteOffset ?? 0) + r.byteLength);
    if (v.buffer === 0 && !imageViews.has(i)) out.push(slice(v));
    const m = v.extensions?.EXT_meshopt_compression;
    if (m?.buffer === 0) out.push(slice(m));
  });
  return out;
}

describe('GLB chunks', () => {
  test('parseGlb then formatGlb gives the same bytes back', async () => {
    const bytes = await fixtureGlb(WORLD);
    const { json, bin } = parseGlb(bytes);
    expect(formatGlb(json, bin).equals(bytes)).toBe(true);
  });

  test('parseGlb refuses what is not a GLB', () => {
    expect(() => parseGlb(Buffer.from('{"asset":{}}'))).toThrow(/GLB/);
  });
});

describe('phoneTier', () => {
  test('fits the 1024² and 256×64 textures within 128 (128² and 128×32, WebP), copies the 64×32 one, and keeps every other byte', async () => {
    const src = await fixtureGlb(WORLD);
    const { bytes, textures } = await phoneTier(src, { size: 128, quality: 60 });
    const out = await images(bytes);
    expect(out.map((i) => i.size)).toEqual([[128, 128], [128, 32], [64, 32]]);
    for (const i of out) expect([i.format, i.mimeType]).toEqual(['webp', 'image/webp']);
    // Alpha kept only where a MASK or BLEND material draws it (lib/alpha.mjs fitTextures).
    expect(out.map((i) => i.hasAlpha)).toEqual([false, true, false]);
    const before = await images(src);
    expect(out[2].data.equals(before[2].data)).toBe(true);
    expect(textures).toEqual({
      count: 3, fitted: 2, copied: 1, maxSide: 128,
      rgbaBytes: (128 * 128 + 128 * 32 + 64 * 32) * 4,
      sourceRgbaBytes: (1024 * 1024 + 256 * 64 + 64 * 32) * 4,
    });

    const a = parseGlb(src);
    const b = parseGlb(bytes);
    expect(withoutLayout(b.json)).toEqual(withoutLayout(a.json));
    const ra = nonImageRanges(a);
    const rb = nonImageRanges(b);
    expect(rb.length).toBe(ra.length);
    expect(ra.length).toBeGreaterThan(0);
    ra.forEach((r, i) => expect(rb[i].equals(r)).toBe(true));

    // gltf-transform reads it as the same model: meshes, accessors and their values.
    const io = await createIO();
    const da = await io.readBinary(new Uint8Array(src));
    const db = await io.readBinary(new Uint8Array(bytes));
    for (const list of ['listMeshes', 'listAccessors', 'listMaterials', 'listNodes', 'listTextures']) {
      expect(db.getRoot()[list]().length).toBe(da.getRoot()[list]().length);
    }
    da.getRoot().listAccessors().forEach((acc, i) => {
      expect([...db.getRoot().listAccessors()[i].getArray()]).toEqual([...acc.getArray()]);
    });
    expect(await phoneProblems(src, bytes, 128)).toEqual({ problems: [], textures });
  });

  test('a GLB whose textures are all within the size comes back byte for byte', async () => {
    const src = await fixtureGlb([{ w: 64, h: 32 }, { w: 128, h: 128 }]);
    const { bytes, textures } = await phoneTier(src, { size: 128, quality: 60 });
    expect(bytes.equals(src)).toBe(true);
    expect(textures).toMatchObject({ count: 2, fitted: 0, copied: 2 });
  });

  test('phoneProblems names a texture over the size, a copy that changed and a model that changed', async () => {
    const src = await fixtureGlb(WORLD);
    expect((await phoneProblems(src, src, 128)).problems[0]).toMatch(/image 0.*1024×1024.*128×128/);
    const { bytes } = await phoneTier(src, { size: 128, quality: 60 });
    const other = await phoneTier(await fixtureGlb([...WORLD.slice(0, 2), { w: 64, h: 32, alpha: () => 9 }]), { size: 128, quality: 60 });
    expect((await phoneProblems(src, other.bytes, 128)).problems.join('; ')).toMatch(/image 2.*copied/);
    const moved = parseGlb(bytes);
    moved.json.nodes[0].translation = [5, 5, 5];
    expect((await phoneProblems(src, formatGlb(moved.json, moved.bin), 128)).problems.join('; ')).toMatch(/JSON/);
    // One byte of the compressed geometry changed, the JSON as it was.
    const flipped = parseGlb(bytes);
    const geometry = flipped.json.bufferViews.find((v) => v.extensions?.EXT_meshopt_compression).extensions.EXT_meshopt_compression;
    const bin = Buffer.from(flipped.bin);
    bin[geometry.byteOffset] ^= 1;
    expect((await phoneProblems(src, formatGlb(flipped.json, bin), 128)).problems).toEqual(['a meshopt-compressed range differs from the source\'s']);
  });
});

describe('CLI', () => {
  test('<map>: world_lo.glb, its .gz and world_lo.json beside world.glb, which is left alone', async () => {
    const src = await fixtureGlb(WORLD);
    const dir = writeMap('de_test', src);
    const r = run('de_test');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/de_test: world_lo\.glb .*3 textures \(2 fitted, 1 copied\)/);
    expect(fs.readFileSync(path.join(dir, 'world.glb')).equals(src)).toBe(true);
    const lo = fs.readFileSync(path.join(dir, 'world_lo.glb'));
    expect((await images(lo)).map((i) => i.size)).toEqual([[128, 128], [128, 32], [64, 32]]);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'world_lo.glb.gz'))).equals(lo)).toBe(true);
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'world_lo.json'), 'utf8'));
    expect(record).toEqual({
      file: 'world_lo.glb', bytes: lo.length, sha256: sha256(lo), gzBytes: fs.statSync(path.join(dir, 'world_lo.glb.gz')).size,
      source: { file: 'world.glb', bytes: src.length, sha256: sha256(src) },
      params: { size: 128, format: 'webp', quality: 60 },
      textures: { count: 3, fitted: 2, copied: 1, maxSide: 128, rgbaBytes: (128 * 128 + 128 * 32 + 64 * 32) * 4, sourceRgbaBytes: (1024 * 1024 + 256 * 64 + 64 * 32) * 4 },
    });
    expect(leftovers(dir)).toEqual([]);
    expect(leftovers(path.join(root, 'maps'))).toEqual([]);
  });

  test('run twice: the second skips it as up to date; rebuilt, it is byte-identical; a new world.glb rebuilds it', async () => {
    const dir = writeMap('de_test', await fixtureGlb(WORLD));
    const lo = path.join(dir, 'world_lo.glb');
    expect(run('de_test').status).toBe(0);
    const first = fs.readFileSync(lo);
    const inode = fs.statSync(lo).ino;

    const again = run('de_test');
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/de_test: world_lo\.glb up to date/);
    expect(fs.statSync(lo).ino).toBe(inode);

    fs.rmSync(lo);
    expect(run('de_test').status).toBe(0);
    expect(fs.readFileSync(lo).equals(first)).toBe(true);

    // A stale .gz alone is rebuilt too.
    fs.writeFileSync(`${lo}.gz`, 'stale');
    expect(run('de_test').stdout).not.toMatch(/up to date/);
    expect(zlib.gunzipSync(fs.readFileSync(`${lo}.gz`)).equals(first)).toBe(true);

    const next = await fixtureGlb([{ w: 512, h: 512 }]);
    fs.writeFileSync(path.join(dir, 'world.glb'), next);
    expect(run('de_test').status).toBe(0);
    expect((await images(fs.readFileSync(lo))).map((i) => i.size)).toEqual([[128, 128]]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'world_lo.json'), 'utf8')).source.sha256).toBe(sha256(next));
  });

  test('a map without world.glb exits 1 and writes nothing', () => {
    const dir = writeMap('de_test', null);
    fs.writeFileSync(path.join(dir, 'radar.png'), 'png');
    const r = run('de_test');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/de_test.*world\.glb/);
    expect(fs.readdirSync(dir)).toEqual(['radar.png']);
    expect(leftovers(path.join(root, 'maps'))).toEqual([]);
  });

  test('players: ct_lo.glb and t_lo.glb within 512 px beside ct.glb and t.glb', async () => {
    const dir = path.join(root, 'players');
    fs.mkdirSync(dir, { recursive: true });
    const src = { ct: await fixtureGlb([{ w: 1024, h: 1024 }, { w: 256, h: 256 }]), t: await fixtureGlb([{ w: 1024, h: 512 }]) };
    for (const side of ['ct', 't']) fs.writeFileSync(path.join(dir, `${side}.glb`), src[side]);
    const r = run('players');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    for (const [side, sizes] of [['ct', [[512, 512], [256, 256]]], ['t', [[512, 256]]]]) {
      expect(fs.readFileSync(path.join(dir, `${side}.glb`)).equals(src[side])).toBe(true);
      const lo = fs.readFileSync(path.join(dir, `${side}_lo.glb`));
      expect((await images(lo)).map((i) => i.size)).toEqual(sizes);
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, `${side}_lo.glb.gz`))).equals(lo)).toBe(true);
      const record = JSON.parse(fs.readFileSync(path.join(dir, `${side}_lo.json`), 'utf8'));
      expect(record).toMatchObject({ file: `${side}_lo.glb`, source: { file: `${side}.glb`, sha256: sha256(src[side]) }, params: { size: 512, format: 'webp', quality: 80 } });
    }
    expect(leftovers(dir)).toEqual([]);
    expect(leftovers(root)).toEqual([]);
  });

  test('all: every map with a world.glb, then the players; a failing one exits 1 after the rest', async () => {
    writeMap('de_a', await fixtureGlb([{ w: 256, h: 256 }]));
    writeMap('de_b', await fixtureGlb([{ w: 256, h: 256 }]));
    writeMap('de_empty', null); // no world.glb: not a built map
    const r = run('all');
    expect(r.status).toBe(1); // no players
    expect(r.stdout).toMatch(/de_a: world_lo\.glb/);
    expect(r.stdout).toMatch(/de_b: world_lo\.glb/);
    expect(r.stderr).toMatch(/players.*ct\.glb/);
    expect(r.stderr).not.toMatch(/de_empty/);
    expect(fs.existsSync(path.join(root, 'maps', 'de_a', 'world_lo.glb'))).toBe(true);
  });

  test('usage errors exit 2', () => {
    expect(run().status).toBe(2);
    expect(run('-x').status).toBe(2);
    expect(run('De Test').status).toBe(2);
  });
});

describe('phoneRows (check-map.mjs, check-players.mjs)', () => {
  const statuses = (rows) => Object.fromEntries(rows.map((r) => [r[0], r[3]]));

  test('a SKIP row without the phone tier; every row OK once built; FAIL on a stale record, a .gz or a GLB that is not the record\'s', async () => {
    const dir = writeMap('de_test', await fixtureGlb(WORLD));
    expect(await phoneRows(dir, PHONE_WORLD, 'rerun')).toEqual([['world_lo.glb', 'none (low loads world.glb)', 'optional', 'SKIP']]);

    expect(run('de_test').status).toBe(0);
    expect(statuses(await phoneRows(dir, PHONE_WORLD, 'rerun'))).toEqual({
      'world_lo.glb record': 'OK', 'world_lo.glb vs world.glb': 'OK', 'world_lo.glb textures': 'OK', 'world_lo.glb size': 'OK', 'world_lo.glb.gz': 'OK',
    });

    fs.writeFileSync(path.join(dir, 'world_lo.glb.gz'), 'stale');
    expect(statuses(await phoneRows(dir, PHONE_WORLD, 'rerun'))['world_lo.glb.gz']).toBe('FAIL');

    // world.glb rebuilt since: the record no longer names it, and its textures are not these.
    fs.writeFileSync(path.join(dir, 'world.glb'), await fixtureGlb([{ w: 512, h: 512 }]));
    const rows = await phoneRows(dir, PHONE_WORLD, 'tools/phone-tier.mjs de_test');
    expect(statuses(rows)).toMatchObject({ 'world_lo.glb record': 'FAIL', 'world_lo.glb vs world.glb': 'FAIL' });
    expect(rows[0][1]).toMatch(/world_lo\.json is stale \(rerun tools\/phone-tier\.mjs de_test\)/);
  });
});

test('the targets: world.glb → world_lo.glb at 128 px q60, <side>.glb → <side>_lo.glb at 512 px q80', () => {
  expect(PHONE_WORLD).toEqual({ from: 'world.glb', to: 'world_lo.glb', record: 'world_lo.json', size: 128, quality: 60 });
  expect(phonePlayer('ct')).toEqual({ from: 'ct.glb', to: 'ct_lo.glb', record: 'ct_lo.json', size: 512, quality: 80 });
});
