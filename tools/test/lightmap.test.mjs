// lib/lightmap.mjs: CS2's baked irradiance (plus the sun, where the bake left it out) as the
// lightmap the viewer ships: sqrt(light / range) in lossless WebP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  LIGHTMAP_PARAMS,
  bakeSun,
  chooseRange,
  coverage,
  decodeLightmap,
  dilate,
  downscale,
  dropLightmapUv,
  encodeLightmap,
  fitsCharts,
  lightmapInputs,
  lightmapUv,
  readChart,
  readHdr,
  readShadow,
  lightBytes,
  lightmapWebp,
} from '../lib/lightmap.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'lightmap-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

/** An HdrImage of `w`×`h` texels, every one `rgb`. */
function image(w, h, rgb = [0, 0, 0]) {
  const data = new Float32Array(w * h * 3);
  for (let k = 0; k < w * h; k++) data.set(rgb, 3 * k);
  return { width: w, height: h, data };
}
const texel = (img, x, y) => Array.from(img.data.subarray(3 * (y * img.width + x), 3 * (y * img.width + x) + 3));

/**
 * A scene of one node per entry, each with one triangle primitive: `uv1`/`uv2` (three
 * [u, v] corners) become TEXCOORD_1/TEXCOORD_2, `normal` every vertex's NORMAL, `node`
 * the node's TRS.
 */
function scene(prims) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const s = doc.createScene();
  for (const { uv1, uv2, normal, node = {} } of prims) {
    const p = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])))
      .setIndices(acc('SCALAR', new Uint32Array([0, 1, 2])));
    if (uv1) p.setAttribute('TEXCOORD_1', acc('VEC2', new Float32Array(uv1.flat())));
    if (uv2) p.setAttribute('TEXCOORD_2', acc('VEC2', new Float32Array(uv2.flat())));
    if (normal) p.setAttribute('NORMAL', acc('VEC3', new Float32Array([...normal, ...normal, ...normal])));
    const n = doc.createNode().setMesh(doc.createMesh().addPrimitive(p));
    if (node.rotation) n.setRotation(node.rotation);
    s.addChild(n);
  }
  return doc;
}

/**
 * A minimal uncompressed scanline OpenEXR, float32 channels A, B, G, R (the order VRF writes,
 * alphabetical as the format requires): `rows[y][x]` is [r, g, b, a], y = 0 the first scanline.
 */
function writeExr(file, rows) {
  const h = rows.length, w = rows[0].length;
  const parts = [];
  const u8 = (...b) => parts.push(Buffer.from(b));
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); parts.push(b); };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); parts.push(b); };
  const str = (s) => parts.push(Buffer.from(`${s}\0`, 'latin1'));
  const attr = (name, type, size, write) => { str(name); str(type); i32(size); write(); };
  i32(20000630);
  i32(2);
  const channels = ['A', 'B', 'G', 'R'];
  attr('channels', 'chlist', channels.length * 18 + 1, () => {
    for (const c of channels) { str(c); i32(2); u8(0, 0, 0, 0); i32(1); i32(1); }
    u8(0);
  });
  attr('compression', 'compression', 1, () => u8(0));
  attr('dataWindow', 'box2i', 16, () => { i32(0); i32(0); i32(w - 1); i32(h - 1); });
  attr('displayWindow', 'box2i', 16, () => { i32(0); i32(0); i32(w - 1); i32(h - 1); });
  attr('lineOrder', 'lineOrder', 1, () => u8(0));
  attr('pixelAspectRatio', 'float', 4, () => f32(1));
  attr('screenWindowCenter', 'v2f', 8, () => { f32(0); f32(0); });
  attr('screenWindowWidth', 'float', 4, () => f32(1));
  u8(0);
  const headerBytes = parts.reduce((n, b) => n + b.length, 0);
  const block = 8 + w * 4 * 4;
  for (let y = 0; y < h; y++) {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(headerBytes + h * 8 + y * block));
    parts.push(b);
  }
  for (let y = 0; y < h; y++) {
    i32(y);
    i32(w * 4 * 4);
    for (const c of [3, 2, 1, 0]) for (let x = 0; x < w; x++) f32(rows[y][x][c]);
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

describe('LIGHTMAP_PARAMS', () => {
  // Its values are tuning (the H2 tier the user approved); what reads them is tested where they
  // act, and the 8-bit sqrt encoding against the viewer's decode in web/test/tools-parity.test.ts.
  it('is frozen, and a whole number of bits a channel no more than a byte holds', () => {
    expect(Object.isFrozen(LIGHTMAP_PARAMS)).toBe(true);
    expect(Number.isInteger(LIGHTMAP_PARAMS.bits) && LIGHTMAP_PARAMS.bits >= 1 && LIGHTMAP_PARAMS.bits <= 8).toBe(true);
  });
});

describe('readHdr', () => {
  it("reads VRF's A,B,G,R float EXR as RGB with row 0 the file's first scanline (v = 0)", async () => {
    const file = path.join(root, 'irradiance.exr');
    writeExr(file, [
      [[1, 2, 3, 1], [4, 5, 6, 1], [7, 8, 9, 1]],
      [[0.5, 0.25, 0.125, 1], [0, 0, 0, 1], [20, 30, 31.5, 1]],
    ]);
    const img = await readHdr(file);
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect(img.data).toHaveLength(3 * 2 * 3);
    expect(texel(img, 0, 0)).toEqual([1, 2, 3]);
    expect(texel(img, 2, 0)).toEqual([7, 8, 9]);
    expect(texel(img, 0, 1)).toEqual([0.5, 0.25, 0.125]);
    expect(texel(img, 2, 1)).toEqual([20, 30, 31.5]);
  });
});

describe('readShadow', () => {
  it('takes one channel of direct_light_shadows (bakedshadowindex), 255 = shadowed', async () => {
    const file = path.join(root, 'direct_light_shadows.png');
    const px = Buffer.from([0, 10, 20, 255, 255, 30, 40, 128, 128, 50, 60, 0, 0, 70, 80, 255]);
    await sharp(px, { raw: { width: 2, height: 2, channels: 4 } }).png().toFile(file);
    const s0 = await readShadow(file, 0);
    expect(s0).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(s0.data)).toEqual([0, 255, 128, 0]);
    expect(Array.from((await readShadow(file, 1)).data)).toEqual([10, 30, 50, 70]);
    expect(Array.from((await readShadow(file, 3)).data)).toEqual([255, 128, 0, 255]);
  });

  it('reads the grey PNG VRF writes for a one-channel (BC4) shadow texture', async () => {
    const file = path.join(root, 'grey.png');
    await sharp(Buffer.from([0, 64, 200, 255]), { raw: { width: 2, height: 2, channels: 1 } }).png().toFile(file);
    expect(Array.from((await readShadow(file, 0)).data)).toEqual([0, 64, 200, 255]);
  });
});

describe('lightmapUv', () => {
  it('is TEXCOORD_2 when a primitive has one, else TEXCOORD_1, and none when all zero (unlit)', () => {
    const doc = scene([
      { uv1: [[0, 0], [1, 0], [0, 1]] },
      { uv1: [[0, 0], [2, 0], [0, 2]], uv2: [[0.5, 0], [1, 0], [1, 0.5]] },
      { uv1: [[0, 0], [0, 0], [0, 0]] },
      {},
    ]);
    const prims = doc.getRoot().listMeshes().map((m) => m.listPrimitives()[0]);
    expect(lightmapUv(prims[0])).toBe(prims[0].getAttribute('TEXCOORD_1'));
    expect(lightmapUv(prims[1])).toBe(prims[1].getAttribute('TEXCOORD_2'));
    expect(lightmapUv(prims[2])).toBeNull();
    expect(lightmapUv(prims[3])).toBeNull();
  });
});

describe('dropLightmapUv', () => {
  it('leaves no lightmap UV to fall back to: TEXCOORD_1 does not stand in for a dropped TEXCOORD_2', () => {
    const doc = scene([
      { uv1: [[0, 0], [2, 0], [0, 2]], uv2: [[0, 0], [1, 0], [0, 1]] },
      { uv1: [[0, 0], [1, 0], [0, 1]] },
      {},
    ]);
    const [both, one, none] = doc.getRoot().listMeshes().map((m) => m.listPrimitives()[0]);
    expect(dropLightmapUv(both)).toBe(true);
    expect(lightmapUv(both)).toBeNull();
    expect(dropLightmapUv(one)).toBe(true);
    expect(lightmapUv(one)).toBeNull();
    expect(dropLightmapUv(none)).toBe(false);
    expect(coverage(doc, 4, 4).every((v) => v === 0)).toBe(true);
  });
});

describe('coverage', () => {
  it('marks every texel centre inside a lightmap-UV triangle, edges included', () => {
    // Centres at (i + 0.5) / 4: u + v <= 1 holds for i + j <= 3, four of them on the hypotenuse.
    const cov = coverage(scene([{ uv1: [[0, 0], [1, 0], [0, 1]] }]), 4, 4);
    expect(cov).toBeInstanceOf(Uint8Array);
    expect(cov.reduce((a, b) => a + b, 0)).toBe(10);
    // Row 0 is v = 0.
    expect(Array.from(cov.subarray(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(cov.subarray(12, 16))).toEqual([1, 0, 0, 0]);
  });

  it('rasterizes TEXCOORD_2 over TEXCOORD_1, and skips all-zero lightmap UVs', () => {
    const cov = coverage(scene([
      { uv1: [[0, 0], [1, 0], [0, 1]], uv2: [[1, 1], [1, 0], [0, 1]] },
      { uv1: [[0, 0], [0, 0], [0, 0]] },
    ]), 4, 4);
    expect(cov.reduce((a, b) => a + b, 0)).toBe(10);
    expect(cov[0]).toBe(0);
    expect(cov[15]).toBe(1);
  });

  it('marks what a bilinear lookup reads along a triangle no texel centre falls in: CS2 maps small and thin faces to a point or a line', () => {
    const marked = (cov) => Array.from(cov).flatMap((c, k) => (c ? [[k % 4, Math.floor(k / 4)]] : []));
    // A line at v = 0.5, between rows 1 and 2, from u = 1/8 to 1/2 (texel x 0 to 1.5): columns 0..2 of both rows.
    const line = [[0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
    expect(marked(coverage(scene([{ uv1: [[1 / 8, 0.5], [0.5, 0.5], [3 / 8, 0.5]] }]), 4, 4))).toEqual(line);
    // A sliver as thin covers no centre either: its longest edge is read.
    expect(marked(coverage(scene([{ uv1: [[1 / 8, 0.5], [0.5, 0.5], [3 / 8, 0.5 + 1e-4]] }]), 4, 4))).toEqual(line);
    // A point on a texel centre reads that texel alone, one between four centres all four.
    expect(marked(coverage(scene([{ uv1: [[3 / 8, 5 / 8], [3 / 8, 5 / 8], [3 / 8, 5 / 8]] }]), 4, 4))).toEqual([[1, 2]]);
    expect(marked(coverage(scene([{ uv1: [[0.5, 0.25], [0.5, 0.25], [0.5, 0.25]] }]), 4, 4))).toEqual([[1, 0], [2, 0], [1, 1], [2, 1]]);
  });

  it('marks area texels 1 and footprint-only texels 2, area first whichever is drawn first', () => {
    const area = { uv1: [[0, 0], [0.375, 0], [0, 0.375]] }; // covers centre (0, 0) only
    const point = { uv1: [[0.25, 0.25], [0.25, 0.25], [0.25, 0.25]] }; // reads (0, 0), (1, 0), (0, 1), (1, 1)
    const want = [1, 2, 0, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(Array.from(coverage(scene([area, point]), 4, 4))).toEqual(want);
    expect(Array.from(coverage(scene([point, area]), 4, 4))).toEqual(want);
  });
});

describe('bakeSun', () => {
  const sun = { dir: [0, 1, 0], color: [1, 0.5, 0.25], intensity: 2, baked: true, shadowChannel: 0 };
  // The shadow: left half (x < 2) shadowed, right half lit.
  const shadow = { width: 4, height: 4, data: Uint8Array.from({ length: 16 }, (_, k) => (k % 4 < 2 ? 255 : 0)) };

  it('adds sun · intensity · N·L · (1 − shadow) to the covered texels only', () => {
    const img = image(4, 4, [0.1, 0.1, 0.1]);
    // NORMAL +z under a node turned −90° about x, so its world normal is +y: N·L = 1.
    const s = Math.SQRT1_2;
    const doc = scene([{ uv1: [[0, 0], [1, 0], [0, 1]], normal: [0, 0, 1], node: { rotation: [-s, 0, 0, s] } }]);
    expect(bakeSun(img, doc, shadow, sun)).toBe(10);
    // (2, 0) and (3, 0): covered and lit.
    for (const [x, y] of [[2, 0], [3, 0], [2, 1]]) {
      const [r, g, b] = texel(img, x, y);
      expect(r).toBeCloseTo(2.1, 5);
      expect(g).toBeCloseTo(1.1, 5);
      expect(b).toBeCloseTo(0.6, 5);
    }
    // Covered but shadowed, and uncovered: irradiance alone.
    for (const [x, y] of [[0, 0], [1, 1], [3, 3], [2, 2]]) expect(texel(img, x, y)).toEqual([0.1, 0.1, 0.1].map(Math.fround));
  });

  it('lights the texels a line chart reads, with N·L along the line', () => {
    const img = image(4, 4, [0.1, 0.1, 0.1]);
    const open = { width: 4, height: 4, data: new Uint8Array(16) };
    expect(bakeSun(img, scene([{ uv1: [[1 / 8, 0.5], [0.5, 0.5], [3 / 8, 0.5]], normal: [0, 1, 0] }]), open, sun)).toBe(6);
    for (const [x, y] of [[0, 1], [2, 2]]) {
      const [r, g, b] = texel(img, x, y);
      expect(r).toBeCloseTo(2.1, 5);
      expect(g).toBeCloseTo(1.1, 5);
      expect(b).toBeCloseTo(0.6, 5);
    }
    expect(texel(img, 3, 1)).toEqual([0.1, 0.1, 0.1].map(Math.fround));
  });

  it('gives a texel an area triangle covers that triangle\'s N·L, not a footprint\'s, in either order', () => {
    const open = { width: 4, height: 4, data: new Uint8Array(16) };
    const area = { uv1: [[0, 0], [0.375, 0], [0, 0.375]], normal: [0, 1, 0] }; // N·L 1 at (0, 0) only
    const point = { uv1: [[0.25, 0.25], [0.25, 0.25], [0.25, 0.25]], normal: [0, -1, 0] }; // N·L 0
    for (const order of [[area, point], [point, area]]) {
      const img = image(4, 4);
      bakeSun(img, scene(order), open, sun);
      expect(texel(img, 0, 0)).toEqual([2, 1, 0.5]);
      expect(texel(img, 1, 1)).toEqual([0, 0, 0]);
    }
  });

  it('adds nothing where the surface faces away from the sun, and half at 50 % shadow', () => {
    const img = image(4, 4);
    bakeSun(img, scene([{ uv1: [[0, 0], [1, 0], [0, 1]], normal: [0, -1, 0] }]), shadow, sun);
    expect(img.data.every((v) => v === 0)).toBe(true);
    const half = { width: 4, height: 4, data: new Uint8Array(16).fill(128) };
    bakeSun(img, scene([{ uv1: [[0, 0], [1, 0], [0, 1]], normal: [0, 2, 0] }]), half, sun);
    expect(texel(img, 0, 0)[0]).toBeCloseTo(2 * (1 - 128 / 255), 5);
  });

  it('refuses a shadow texture of another size', () => {
    expect(() => bakeSun(image(4, 4), scene([]), { width: 2, height: 2, data: new Uint8Array(4) }, sun)).toThrow(/size/);
  });

  it('lights a primitive without NORMAL by its face normal from POSITION', () => {
    // The triangle (0,0,0), (1,0,0), (0,0,1) winds to face −y: away from the sun.
    const away = image(4, 4);
    bakeSun(away, scene([{ uv1: [[0, 0], [1, 0], [0, 1]] }]), shadow, sun);
    expect(away.data.every((v) => v === 0)).toBe(true);
    // Turned 180° about x it faces +y: the full sun on the covered, lit texels.
    const up = image(4, 4);
    expect(bakeSun(up, scene([{ uv1: [[0, 0], [1, 0], [0, 1]], node: { rotation: [1, 0, 0, 0] } }]), shadow, sun)).toBe(10);
    const [r, g, b] = texel(up, 3, 0);
    expect(r).toBeCloseTo(2, 5);
    expect(g).toBeCloseTo(1, 5);
    expect(b).toBeCloseTo(0.5, 5);
    expect(texel(up, 0, 0)).toEqual([0, 0, 0]);
  });

  it('refuses a sun the bake left to the engine, or one without a shadow channel', () => {
    const doc = scene([{ uv1: [[0, 0], [1, 0], [0, 1]], normal: [0, 1, 0] }]);
    expect(() => bakeSun(image(4, 4), doc, shadow, { ...sun, baked: false })).toThrow(/baked/);
    expect(() => bakeSun(image(4, 4), doc, shadow, { ...sun, shadowChannel: null })).toThrow(/shadow channel/);
  });
});

describe('dilate', () => {
  it('fills uncovered texels from their covered 8-neighbours, a ring per pass', () => {
    const img = image(4, 4);
    img.data.set([2, 4, 8], 3 * (1 * 4 + 1));
    const covered = new Uint8Array(16);
    covered[5] = 1;
    dilate(img, covered, 1);
    expect(covered.reduce((a, b) => a + b, 0)).toBe(9);
    expect(texel(img, 3, 3)).toEqual([0, 0, 0]);
    dilate(img, covered, 1);
    expect(Array.from(covered)).toEqual(new Array(16).fill(1));
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(texel(img, x, y)).toEqual([2, 4, 8]);
  });

  it('averages the covered neighbours and leaves covered texels alone', () => {
    const img = image(3, 1);
    img.data.set([1, 1, 1], 0);
    img.data.set([3, 5, 7], 6);
    const covered = Uint8Array.from([1, 0, 1]);
    dilate(img, covered, 4);
    expect(texel(img, 0, 0)).toEqual([1, 1, 1]);
    expect(texel(img, 1, 0)).toEqual([2, 3, 4]);
    expect(texel(img, 2, 0)).toEqual([3, 5, 7]);
  });
});

describe('downscale', () => {
  it('averages only covered texels: no uncovered garbage leaks in', () => {
    const img = image(4, 4);
    const covered = new Uint8Array(16);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const left = x < 2;
      img.data.set(left ? [1, 1, 1] : [100, 100, 100], 3 * (y * 4 + x));
      covered[y * 4 + x] = left ? 1 : 0;
    }
    const out = downscale(img, covered, 2);
    expect(out.img).toMatchObject({ width: 2, height: 2 });
    expect(Array.from(out.covered)).toEqual([1, 0, 1, 0]);
    expect(texel(out.img, 0, 0)).toEqual([1, 1, 1]);
    expect(texel(out.img, 0, 1)).toEqual([1, 1, 1]);
    expect(texel(out.img, 1, 0)).toEqual([0, 0, 0]);
    expect(texel(out.img, 1, 1)).toEqual([0, 0, 0]);
  });

  it('lets a chart\'s own texels outweigh the point and line footprints in its block (coverage 2)', () => {
    const img = image(2, 2);
    img.data.set([1, 1, 1, 3, 3, 3, 50, 50, 50, 9, 9, 9]);
    // Two area texels and a footprint texel: the area ones alone.
    const mixed = downscale(img, Uint8Array.from([1, 1, 2, 0]), 2);
    expect(texel(mixed.img, 0, 0)).toEqual([2, 2, 2]);
    expect(Array.from(mixed.covered)).toEqual([1]);
    // Footprints alone: their mean, and the block counts as covered.
    const lines = downscale(img, Uint8Array.from([0, 0, 2, 2]), 2);
    expect(texel(lines.img, 0, 0)).toEqual([29.5, 29.5, 29.5]);
    expect(Array.from(lines.covered)).toEqual([1]);
  });

  it('weighs a partly covered block by its covered texels', () => {
    const img = image(2, 2);
    img.data.set([1, 2, 3, 3, 4, 5, 50, 50, 50, 9, 9, 9]);
    const out = downscale(img, Uint8Array.from([1, 1, 0, 0]), 2);
    expect(texel(out.img, 0, 0)).toEqual([2, 3, 4]);
    expect(Array.from(out.covered)).toEqual([1]);
  });

  it('refuses a factor that does not divide the size', () => {
    expect(() => downscale(image(6, 6), new Uint8Array(36), 4)).toThrow(/divide/);
  });
});

describe('chooseRange', () => {
  /** n covered texels at `v` (plus `outliers` at 1e4), and 100 uncovered ones at 1e4. */
  function at(v, n = 10000, outliers = 0) {
    const img = image(n + 100, 1);
    const covered = new Uint8Array(n + 100);
    for (let k = 0; k < n + 100; k++) {
      const c = k < n;
      img.data.set(c && k >= outliers ? [v * 0.3, v, v * 0.5] : [1e4, 1e4, 1e4], 3 * k);
      covered[k] = c ? 1 : 0;
    }
    return [img, covered];
  }

  it("is the power of two from 2 to 64 at or above the covered texels' p99.9 max channel", () => {
    expect(chooseRange(...at(5.3))).toBe(8);
    expect(chooseRange(...at(0.4))).toBe(2);
    expect(chooseRange(...at(1000))).toBe(64);
    expect(chooseRange(...at(8))).toBe(8);
    expect(chooseRange(...at(11.35))).toBe(16);
  });

  it('ignores uncovered texels and the brightest 0.1 %', () => {
    expect(chooseRange(...at(5.3, 10000, 5))).toBe(8);
  });

  it('is 2 when nothing is covered', () => {
    expect(chooseRange(image(2, 2, [50, 50, 50]), new Uint8Array(4))).toBe(2);
  });
});

describe('encodeLightmap, decodeLightmap', () => {
  it('stores each texel as lightBytes at 8 bits, 3 bytes, and decodes (byte / 255)² · range', () => {
    const vs = [0, 0.001, 0.5, 1, 7.9, 16, 40];
    const img = image(vs.length, 1);
    vs.forEach((v, i) => img.data.set([v, v * 0.8, v * 0.5], 3 * i));
    const rgb = encodeLightmap(img, 16);
    expect(rgb).toBeInstanceOf(Uint8Array);
    expect(rgb).toHaveLength(vs.length * 3);
    vs.forEach((v, i) => expect(Array.from(rgb.subarray(3 * i, 3 * i + 3))).toEqual(lightBytes([v, v * 0.8, v * 0.5], 16, 8)));
    const d = decodeLightmap(rgb, 16);
    expect(d).toBeInstanceOf(Float32Array);
    // Within a code of the exact sqrt, up to the range: 2/255 of sqrt(v / range), relatively.
    vs.slice(0, 6).forEach((v, i) => {
      if (!v) return expect(d[3 * i]).toBe(0);
      expect(Math.abs(Math.sqrt(d[3 * i] / 16) - Math.sqrt(v / 16))).toBeLessThanOrEqual(1 / 255);
    });
    expect(d[3 * 6]).toBeCloseTo(16, 5);
    expect(Array.from(encodeLightmap(image(1, 1), 8))).toEqual([0, 0, 0]);
  });
});

describe('lightmapWebp', () => {
  it('is a lossless RGB WebP of the codes (no alpha, no chroma subsampling), the same bytes every time', async () => {
    const w = 64, h = 32;
    const img = image(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set([x / 8, y / 8, (x + y) / 16], 3 * (y * w + x));
    const rgb = encodeLightmap(img, 8);
    const webp = await lightmapWebp(rgb, w, h);
    const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ format: 'raw', width: w, height: h, channels: 3 });
    expect(Buffer.compare(Buffer.from(data), Buffer.from(rgb))).toBe(0);
    expect(Buffer.compare(webp, await lightmapWebp(rgb, w, h))).toBe(0);
  });
});

describe('lightBytes', () => {
  const GRID = [...Array.from({ length: 64 }, (_, k) => 4 * k), 255];
  const exact = (v, range) => 255 * Math.sqrt(Math.min(Math.max(v, 0) / range, 1));
  /** The light of the 8-bit-exact code s, at range r. */
  const at = (s, r) => (s / 255) ** 2 * r;
  /** Hue error in stops: the largest change of a channel's share of the sum, log2. */
  const hueError = (rgb, q, range) => {
    const d = q.map((x) => at(x, range) + 1e-4), t = rgb.map((x) => x + 1e-4);
    const sd = d[0] + d[1] + d[2], st = t[0] + t[1] + t[2];
    return Math.max(...[0, 1, 2].map((c) => Math.abs(Math.log2(d[c] / sd / (t[c] / st)))));
  };

  it('is sqrt(light / range) per channel on the 6-bit grid (0, 4, … 252, 255) the viewer squares', () => {
    expect(lightBytes([0, 0, 0], 8, 6)).toEqual([0, 0, 0]);
    expect(lightBytes([8, 8, 8], 8, 6)).toEqual([255, 255, 255]);
    expect(lightBytes([100, 100, 100], 8, 6)).toEqual([255, 255, 255]);
    expect(lightBytes([-1, NaN, 0], 8, 6)).toEqual([0, 0, 0]);
    expect(lightBytes([2, 2, 2], 8, 6)).toEqual([128, 128, 128]); // sqrt(1/4) · 255 = 127.5
    expect(lightBytes([1.9, 1.9, 1.9], 8, 8)).toEqual([124, 124, 124]); // 8 bits: 124.3
    const out = [9, 9, 9];
    expect(lightBytes([2, 2, 2], 8, 6, out)).toBe(out);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2000; i++) {
      const rgb = [rand() * 8, rand() * 8, rand() * 8]; // within the range: above it the hue is kept instead
      lightBytes(rgb, 8, 6).forEach((q, c) => {
        expect(GRID).toContain(q);
        expect(Math.abs(q - exact(rgb[c], 8))).toBeLessThanOrEqual(4); // a grid point beside the exact code
      });
    }
  });

  it('keeps the hue of light above the range: scaled down to it whole, not clipped per channel', () => {
    const at = (q, r) => (q / 255) ** 2 * r;
    const q = lightBytes([40, 20, 10], 16, 8);
    expect(q[0]).toBe(255);
    [16, 8, 4].forEach((v, c) => expect(Math.abs(at(q[c], 16) - v) / v).toBeLessThan(0.03));
    // +∞ is the range, NaN and −∞ are 0, channel by channel, before the hue is kept.
    expect(lightBytes([Infinity, 1, NaN], 16, 8)).toEqual(lightBytes([16, 1, 0], 16, 8));
    expect(lightBytes([-Infinity, NaN, 2], 16, 8)).toEqual(lightBytes([0, 0, 2], 16, 8));
  });

  it('keeps near-grey light grey where rounding each channel alone would tint it', () => {
    // Exact codes 49.9, 50.1, 50.0: alone they round to 48, 52, 52, a red step down.
    const rgb = [49.9, 50.1, 50].map((s) => at(s, 16));
    const q = lightBytes(rgb, 16, 6);
    expect(q[0]).toBe(q[1]);
    expect(q[1]).toBe(q[2]);
  });

  it('keeps the hue better than rounding each channel alone (Nuke silo light: bluish grey, mid-dark)', () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    let alone = 0, joint = 0;
    for (let i = 0; i < 5000; i++) {
      const base = 0.3 + rand() * 1.2;
      const rgb = [base * (0.85 + 0.1 * rand()), base * (0.95 + 0.1 * rand()), base * (1.05 + 0.1 * rand())];
      alone += hueError(rgb, rgb.map((v) => Math.min(255, Math.round(exact(v, 16) / 4) * 4)), 16);
      joint += hueError(rgb, lightBytes(rgb, 16, 6), 16);
    }
    expect(joint).toBeLessThan(0.8 * alone);
  });
});

describe('readChart, fitsCharts', () => {
  // debug_chart_color: one flat colour per chart; here four 32×32 quadrants.
  const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
  async function chartFile() {
    const px = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) px.set(colours[(y >> 5) * 2 + (x >> 5)], 3 * (y * 64 + x));
    const file = path.join(root, 'debug_chart_color.png');
    await sharp(px, { raw: { width: 64, height: 64, channels: 3 } }).png().toFile(file);
    return file;
  }
  /** A primitive of `n` triangles 8 texels a side, each at (x, y) texels of the 64 px chart. */
  function prim(corners) {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const uv = new Float32Array(corners.flatMap(([x, y]) => [x / 64, y / 64, (x + 8) / 64, y / 64, x / 64, (y + 8) / 64]));
    return doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(uv.length * 1.5)).setBuffer(buffer))
      .setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer));
  }
  const inside = Array.from({ length: 24 }, (_, i) => [2 + (i % 2) * 34, 2 + ((i >> 1) % 2) * 34]);
  const across = Array.from({ length: 24 }, (_, i) => [28 - (i % 3), 28 - (i % 4)]);

  it('reads the chart as RGB', async () => {
    const chart = await readChart(await chartFile());
    expect(chart).toMatchObject({ width: 64, height: 64 });
    expect(Array.from(chart.data.subarray(0, 3))).toEqual([255, 0, 0]);
  });

  it('passes a UV whose big triangles each fall inside one chart', async () => {
    const chart = await readChart(await chartFile());
    expect(fitsCharts(chart, prim(inside))).toBe(true);
  });

  it('fails a UV with >= 20 big triangles of which under 25 % fall inside one chart (a material UV)', async () => {
    const chart = await readChart(await chartFile());
    expect(fitsCharts(chart, prim(across))).toBe(false);
    // Too few big triangles to judge: kept.
    expect(fitsCharts(chart, prim(across.slice(0, 19)))).toBe(true);
    // A quarter inside is enough.
    expect(fitsCharts(chart, prim([...across.slice(0, 18), ...inside.slice(0, 6)]))).toBe(true);
  });
});

describe('lightmapInputs', () => {
  const write = (json) => fs.writeFileSync(path.join(root, 'lightmaps.json'), JSON.stringify(json));
  const all = ['irradiance', 'env_light_probe_volume_atlas', 'env_light_probe_volume_atlas_dlshd', 'debug_chart_color', 'direct_light_shadows'];

  it('names the exported files of a baked map', () => {
    write({ map: 'de_x', sunBaked: true, textures: all, atlasSlices: 12, dlshdSlices: 2 });
    expect(lightmapInputs(root)).toEqual({
      irradiance: path.join(root, 'irradiance.exr'),
      shadow: path.join(root, 'direct_light_shadows.png'),
      chart: path.join(root, 'debug_chart_color.png'),
      probes: true,
    });
  });

  it('has no sun shadow on a map whose sun is dynamic (de_cache: the engine draws it)', () => {
    write({ map: 'de_x', sunBaked: false, textures: all.slice(0, 4) });
    expect(lightmapInputs(root)).toMatchObject({ shadow: null, chart: path.join(root, 'debug_chart_color.png'), probes: true });
    write({ map: 'de_x', sunBaked: false, textures: ['irradiance', 'debug_chart_color'] });
    expect(lightmapInputs(root)).toMatchObject({ shadow: null, probes: false });
  });

  it('is null for a half-set: a baked sun without its shadow, or no chart to check lightmap UVs against', () => {
    // A null shadow here would read as a dynamic sun: the viewer would light it unshadowed.
    write({ map: 'de_x', sunBaked: true, textures: all.filter((t) => t !== 'direct_light_shadows') });
    expect(lightmapInputs(root)).toBeNull();
    write({ map: 'de_x', sunBaked: true, textures: all.filter((t) => t !== 'debug_chart_color') });
    expect(lightmapInputs(root)).toBeNull();
    write({ map: 'de_x', sunBaked: false, textures: ['irradiance'] });
    expect(lightmapInputs(root)).toBeNull();
  });

  it('is null (no bake: the map builds as before) without irradiance or without the export', () => {
    write({ map: 'de_x', sunBaked: true, textures: [] });
    expect(lightmapInputs(root)).toBeNull();
    expect(lightmapInputs(path.join(root, 'missing'))).toBeNull();
  });
});
