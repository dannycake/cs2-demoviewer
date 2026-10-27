// lib/light.mjs: the map's baked light as shrink-map ships it (the H2 tier of Task 1b): which
// primitives keep their lightmap UV, the per-vertex light of every other primitive, light.json,
// and the checks check-map.mjs runs on the result.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Document } from '@gltf-transform/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeLightGrid } from '../lib/probes.mjs';
import { encodeLightmap, lightBytes, lightmapWebp } from '../lib/lightmap.mjs';
import {
  LIGHT_PARAMS,
  TIER_LADDER,
  ladderRuns,
  walkLadder,
  applyVertexLight,
  keepsLightmapUv,
  lightChecks,
  lightJson,
  lightJsonProblem,
  litCheck,
  materialIds,
  sampleLight,
  sourceLight,
  texelsPerVertex,
} from '../lib/light.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'light-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const T = 1 / 2048; // one texel of the 2048 sample size, in UV units

/**
 * A document with one node per entry. Each entry has `positions` (flat xyz), optional `indices`,
 * `uv1`/`uv2` (flat uv, TEXCOORD_1/TEXCOORD_2), `normals` (flat), `material` (a key: entries with
 * the same key share one Material), `translation` and `mesh` (a key: entries with the same key
 * share one Mesh, the first entry's primitive).
 */
function scene(entries) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
  const s = doc.createScene();
  const materials = new Map();
  const meshes = new Map();
  const nodes = [];
  for (const e of entries) {
    let mesh = e.mesh !== undefined ? meshes.get(e.mesh) : undefined;
    if (!mesh) {
      const p = doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array(e.positions)));
      const n = e.positions.length / 3;
      p.setIndices(acc('SCALAR', new Uint32Array(e.indices ?? Array.from({ length: n }, (_, i) => i))));
      if (e.uv1) p.setAttribute('TEXCOORD_1', acc('VEC2', new Float32Array(e.uv1)));
      if (e.uv2) p.setAttribute('TEXCOORD_2', acc('VEC2', new Float32Array(e.uv2)));
      if (e.normals) p.setAttribute('NORMAL', acc('VEC3', new Float32Array(e.normals)));
      if (e.material !== undefined) {
        if (!materials.has(e.material)) materials.set(e.material, doc.createMaterial(String(e.material)));
        p.setMaterial(materials.get(e.material));
      }
      mesh = doc.createMesh().addPrimitive(p);
      if (e.mesh !== undefined) meshes.set(e.mesh, mesh);
    }
    const node = doc.createNode().setMesh(mesh);
    if (e.translation) node.setTranslation(e.translation);
    s.addChild(node);
    nodes.push(node);
  }
  return { doc, nodes, prims: nodes.map((n) => n.getMesh().listPrimitives()[0]) };
}

/** An HdrImage `w`×`h` whose texel (x, y) is fn(x, y). */
function image(w, h, fn) {
  const data = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fn(x, y), 3 * (y * w + x));
  return { width: w, height: h, data };
}

/** COLOR_0 of a primitive as [r, g, b, a] bytes per vertex. */
const colours = (prim) => {
  const a = prim.getAttribute('COLOR_0');
  return a ? Array.from({ length: a.getCount() }, (_, i) => Array.from(a.getArray().subarray(4 * i, 4 * i + 4))) : null;
};

describe('LIGHT_PARAMS', () => {
  // Its values are tuning (the H2 tier); the functions that read them are tested below with them,
  // and COLOR_0's bits against the viewer's decode in web/test/tools-parity.test.ts.
  it('is frozen, and COLOR_0 a whole number of bits a channel no more than a byte holds', () => {
    expect(Object.isFrozen(LIGHT_PARAMS)).toBe(true);
    expect(Number.isInteger(LIGHT_PARAMS.colorBits) && LIGHT_PARAMS.colorBits >= 1 && LIGHT_PARAMS.colorBits <= 8).toBe(true);
  });
});

describe('texelsPerVertex, keepsLightmapUv', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 0, 1];
  it('is the lightmap UV area in texels at 2048 over the vertices the primitive indexes', () => {
    // A right triangle with 4-texel legs: 8 texels over 3 vertices.
    const { prims: [big] } = scene([{ positions: tri, uv1: [0, 0, 4 * T, 0, 0, 4 * T] }]);
    expect(texelsPerVertex(big)).toBeCloseTo(8 / 3, 6);
    expect(keepsLightmapUv(big)).toBe(true);
    const { prims: [small] } = scene([{ positions: tri, uv1: [0, 0, 2 * T, 0, 0, 2 * T] }]);
    expect(texelsPerVertex(small)).toBeCloseTo(2 / 3, 6);
    expect(keepsLightmapUv(small)).toBe(false);
  });
  it('counts only the vertices the primitive indexes (VRF primitives share their mesh\'s vertex buffer)', () => {
    const { prims: [p] } = scene([{
      positions: [...tri, 5, 5, 5, 6, 6, 6, 7, 7, 7], indices: [0, 1, 2],
      uv1: [0, 0, 4 * T, 0, 0, 4 * T, 0.5, 0.5, 0.6, 0.6, 0.7, 0.7],
    }]);
    expect(texelsPerVertex(p)).toBeCloseTo(8 / 3, 6);
  });
  it('reads TEXCOORD_2 before TEXCOORD_1, keeps exactly 2 texels per vertex, and is 0 without a lightmap UV', () => {
    const { prims: [p] } = scene([{ positions: tri, uv1: [0, 0, 1, 0, 0, 1], uv2: [0, 0, 2 * T, 0, 0, 6 * T] }]);
    expect(texelsPerVertex(p)).toBeCloseTo(2, 6);
    expect(keepsLightmapUv(p)).toBe(true);
    const { prims: [none] } = scene([{ positions: tri }]);
    expect(texelsPerVertex(none)).toBe(0);
    expect(keepsLightmapUv(none)).toBe(false);
  });
});

describe('sampleLight', () => {
  it('is bilinear between texel centres, row 0 at v = 0, clamped at the edges', () => {
    const img = image(2, 2, (x, y) => (y === 0 ? (x === 0 ? [0, 0, 0] : [2, 4, 6]) : [8, 8, 8]));
    expect(sampleLight(img, 0.25, 0.25)).toEqual([0, 0, 0]);
    expect(sampleLight(img, 0.75, 0.25)).toEqual([2, 4, 6]);
    expect(sampleLight(img, 0.5, 0.25)).toEqual([1, 2, 3]);
    expect(sampleLight(img, 0, 0)).toEqual([0, 0, 0]);
    expect(sampleLight(img, 1, 0)).toEqual([2, 4, 6]);
    expect(sampleLight(img, 0.25, 0.75)).toEqual([8, 8, 8]);
    expect(sampleLight(img, 0.25, 0.5)).toEqual([4, 4, 4]);
  });
});

describe('sourceLight, applyVertexLight', () => {
  // A probe stand-in that reports where it was asked: light = [x, y, z] of the point + 10.
  const probe = (p) => [p[0] + 10, p[1] + 10, p[2] + 10];
  const lm = image(4, 4, (x, y) => [x + 1, y + 1, 0]); // texel (x, y) = [x + 1, y + 1, 0]
  const centre = (x, y) => [(x + 0.5) / 4, (y + 0.5) / 4];
  const bytes = (light, range = 16) => [...lightBytes(light, range, 6), 255];

  it('gives a vertex-lit primitive the light of its own vertices: the lightmap at its lightmap UV, or the probes', () => {
    const { doc, prims: [lit, prop] } = scene([
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uv1: [...centre(0, 0), ...centre(1, 0), ...centre(0, 1)], material: 'a' },
      { positions: [5, 0, 0, 6, 0, 0, 5, 0, 1], material: 'b' },
    ]);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: lm, probe });
    lit.setAttribute('TEXCOORD_1', null); // H2 left it for vertex light
    const stats = applyVertexLight(doc, ids, pool, 16);
    expect(colours(lit)).toEqual([bytes([1, 1, 0]), bytes([2, 1, 0]), bytes([1, 2, 0])]);
    expect(colours(prop)).toEqual([bytes([15, 10, 10]), bytes([16, 10, 10]), bytes([15, 10, 11])]);
    expect(stats).toMatchObject({ primitives: 2, vertices: 6, hit: 6, neighbour: 0, otherMaterial: 0, fallback: 0 });
    const c = lit.getAttribute('COLOR_0');
    expect(c.getType()).toBe('VEC4');
    expect(c.getNormalized()).toBe(true);
    expect(c.getArray()).toBeInstanceOf(Uint8Array);
  });

  it('leaves a primitive that ships its lightmap UV (TEXCOORD_1) without COLOR_0', () => {
    const { doc, prims: [lit] } = scene([{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uv1: [...centre(0, 0), ...centre(1, 0), ...centre(0, 1)], material: 'a' }]);
    const ids = materialIds(doc);
    const stats = applyVertexLight(doc, ids, sourceLight(doc, ids, { lightmap: lm, probe }), 16);
    expect(lit.getAttribute('COLOR_0')).toBeNull();
    expect(stats.primitives).toBe(0);
  });

  it('averages the source vertices of one material in one 5 mm cell (a chart seam), never across materials', () => {
    const { doc, prims: [a1, a2, b] } = scene([
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uv1: [...centre(0, 0), ...centre(1, 0), ...centre(0, 1)], material: 'a' },
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uv1: [...centre(3, 3), ...centre(1, 0), ...centre(0, 1)], material: 'a' },
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], material: 'b' },
    ]);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: lm, probe });
    for (const p of [a1, a2]) p.setAttribute('TEXCOORD_1', null);
    applyVertexLight(doc, ids, pool, 16);
    // (0, 0, 0): [1, 1, 0] and [4, 4, 0] meet → [2.5, 2.5, 0], for both a's; b keeps its own.
    expect(colours(a1)[0]).toEqual(bytes([2.5, 2.5, 0]));
    expect(colours(a2)[0]).toEqual(bytes([2.5, 2.5, 0]));
    expect(colours(b)[0]).toEqual(bytes([10, 10, 10]));
  });

  it('places vertices in world space (node transforms), and counts only the vertices a primitive indexes', () => {
    const { doc, prims: [p] } = scene([{
      positions: [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0], indices: [1, 2, 3], material: 'a', translation: [100, 0, 0],
    }]);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: lm, probe });
    // Vertex 0 is not indexed: its cell holds only vertex 3 (same place, also probe light).
    expect(pool.sources).toBe(3);
    applyVertexLight(doc, ids, pool, 256);
    expect(colours(p)[1]).toEqual(bytes([111, 10, 10], 256));
  });

  it('looks in the neighbouring cells for a vertex that moved across a cell edge, and never leaves a vertex black', () => {
    const { doc, prims: [p] } = scene([{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], material: 'a' }]);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: lm, probe });
    // Simplify moved vertex 0 by 3 mm and vertex 1 somewhere no source vertex was.
    p.getAttribute('POSITION').setArray(new Float32Array([0.003, 0, 0, 50, 0, 0, 0, 0, 1]));
    const stats = applyVertexLight(doc, ids, pool, 16);
    expect(stats).toMatchObject({ hit: 1, neighbour: 1, fallback: 1 });
    expect(colours(p)[0]).toEqual(bytes([10, 10, 10]));
    // The material's mean light: (10 + 11 + 10, …) / 3.
    expect(colours(p)[1]).toEqual(bytes([31 / 3, 10, 31 / 3]));
  });

  it('gives each node of a shared mesh its own copy, lit where that node stands', () => {
    const { doc, nodes } = scene([
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], material: 'a', mesh: 'm' },
      { positions: [], material: 'a', mesh: 'm', translation: [2, 0, 0] },
    ]);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: lm, probe });
    const stats = applyVertexLight(doc, ids, pool, 16);
    expect(stats.copiedMeshes).toBe(1);
    const [m0, m1] = nodes.map((n) => n.getMesh());
    expect(m0).not.toBe(m1);
    expect(colours(m0.listPrimitives()[0])[0]).toEqual(bytes([10, 10, 10]));
    expect(colours(m1.listPrimitives()[0])[0]).toEqual(bytes([12, 10, 10]));
  });

  it('hands the probes the world normal (NORMAL through the node), or the face normal without NORMAL', () => {
    const seen = [];
    const record = (p, n) => { seen.push(n.map((x) => +x.toFixed(6))); return [1, 1, 1]; };
    const { doc } = scene([
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], normals: [0, 0, 2, 0, 0, 2, 0, 0, 2], material: 'a' },
      { positions: [0, 0, 0, 0, 0, 1, 1, 0, 0], material: 'a' }, // counter-clockwise seen from +y
    ]);
    sourceLight(doc, materialIds(doc), { lightmap: lm, probe: record });
    expect(seen.slice(0, 3)).toEqual([[0, 0, 1], [0, 0, 1], [0, 0, 1]]);
    expect(seen.slice(3)).toEqual([[0, 1, 0], [0, 1, 0], [0, 1, 0]]);
  });

  it('without a lightmap (the doors and breakables) lights every vertex from the probes where it stands under its entity root, a lightmap UV notwithstanding', () => {
    const { doc, nodes: [model], prims: [p] } = scene([
      { positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], uv1: [...centre(0, 0), ...centre(1, 0), ...centre(0, 1)], material: 'a', translation: [1, 0, 0] },
    ]);
    // entities.mjs splitMovables' shape: a root at the entity's spawn (20 m along x, a quarter
    // turn about +y), the model under it.
    const root = doc.createNode('2:1:3').setTranslation([20, 0, 0]).setRotation([0, Math.SQRT1_2, 0, Math.SQRT1_2]);
    doc.getRoot().listScenes()[0].removeChild(model).addChild(root);
    root.addChild(model);
    const ids = materialIds(doc);
    const pool = sourceLight(doc, ids, { lightmap: null, probe });
    p.setAttribute('TEXCOORD_1', null); // shrink-map strips it: entities.glb ships no lightmap UV
    const stats = applyVertexLight(doc, ids, pool, 64);
    expect(stats).toMatchObject({ primitives: 1, vertices: 3, hit: 3, fallback: 0 });
    // A quarter turn about +y takes (x, y, z) to (z, y, −x): the model's (1, 0, 0) is the world's (20, 0, −1).
    expect(colours(p)).toEqual([bytes([30, 10, 9], 64), bytes([30, 10, 8], 64), bytes([31, 10, 9], 64)]);
  });

  it('gives the same light to a clone\'s primitives through its own material ids', async () => {
    const { cloneDocument } = await import('@gltf-transform/functions');
    const { doc } = scene([{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], material: 'a' }]);
    const pool = sourceLight(doc, materialIds(doc), { lightmap: lm, probe });
    const copy = cloneDocument(doc);
    const stats = applyVertexLight(copy, materialIds(copy), pool, 16);
    expect(stats).toMatchObject({ hit: 3, otherMaterial: 0, fallback: 0 });
  });
});

describe('lightJson', () => {
  const sun = { dir: [0.3346, 0.866, -0.3716], color: [1, 0.7379, 0.4508], intensity: 3, baked: true, shadowChannel: 0 };
  it('names the lightmap, the sun and the light grid, with the map\'s one range', () => {
    expect(lightJson({ range: 8, lightmapSize: [1024, 1024], sun })).toEqual({
      version: 2,
      range: 8,
      lightmap: { file: 'lightmap.webp', size: [1024, 1024] },
      sun: { dir: [0.3346, 0.866, -0.3716], color: [1, 0.7379, 0.4508], intensity: 3, baked: true },
      probes: { file: 'probes.bin' },
    });
  });
  it('has no lightmap under tier V, and no sun on a map without one', () => {
    expect(lightJson({ range: 16, lightmapSize: null, sun: null })).toEqual({
      version: 2, range: 16, lightmap: null, sun: null, probes: { file: 'probes.bin' },
    });
    expect(lightJson({ range: 16, lightmapSize: null, sun: { ...sun, baked: false } }).sun.baked).toBe(false);
  });
});

describe('TIER_LADDER', () => {
  it('tries H2, H2 with world.glb\'s textures a step smaller (192 px), then tier V and tier V at 192 px: the plan\'s budget rule drops the textures before the lightmap', () => {
    expect(TIER_LADDER).toEqual([
      { tier: 'H2', worldSize: null },
      { tier: 'H2', worldSize: 192 },
      { tier: 'V', worldSize: null },
      { tier: 'V', worldSize: 192 },
    ]);
    expect(Object.isFrozen(TIER_LADDER)).toBe(true);
    expect(TIER_LADDER.every(Object.isFrozen)).toBe(true);
  });
});

describe('ladderRuns', () => {
  it('walks the ladder in its written order, one run per tier with its world sizes in order', () => {
    expect(ladderRuns()).toEqual([
      { tier: 'H2', sizes: [null, 192] },
      { tier: 'V', sizes: [null, 192] },
    ]);
    // Written order, not H2 first: a ladder that starts at tier V walks it first.
    expect(ladderRuns([{ tier: 'V', worldSize: null }, { tier: 'H2', worldSize: 192 }])).toEqual([
      { tier: 'V', sizes: [null] },
      { tier: 'H2', sizes: [192] },
    ]);
  });
  it('refuses a tier that comes back after another (its geometry is built once) or an unknown tier', () => {
    expect(() => ladderRuns([{ tier: 'H2', worldSize: null }, { tier: 'V', worldSize: null }, { tier: 'H2', worldSize: 192 }])).toThrow(/H2/);
    expect(() => ladderRuns([{ tier: 'X', worldSize: null }])).toThrow(/X/);
    expect(() => ladderRuns([])).toThrow();
  });
});

describe('walkLadder', () => {
  /**
   * The walk over TIER_LADDER with first loads from `loads` (`<tier>@<size>`, null size as 256):
   * what each tier's geometry and each try were asked with.
   */
  const walk = async (loads, cap = 1000) => {
    const lit = [];
    const shipped = [];
    const result = await walkLadder(ladderRuns(), cap, {
      light: async (tier, tries) => {
        lit.push({ tier, triesBefore: tries.length });
        return { tier };
      },
      ship: async (geometry, size, rest) => {
        const key = `${geometry.tier}@${size ?? 256}`;
        shipped.push({ key, rest: [...rest] });
        return { firstLoad: loads[key], key };
      },
    });
    return { result, lit, shipped };
  };

  it('ships H2 with 192 px textures when H2 at 256 px is over the cap, never lighting tier V', async () => {
    const { result, lit, shipped } = await walk({ 'H2@256': 1001, 'H2@192': 999, 'V@256': 900, 'V@192': 800 });
    expect(result.tier).toBe('H2');
    expect(result.size).toBe(192);
    expect(result.lit).toEqual({ tier: 'H2' });
    expect(result.shipped).toEqual({ firstLoad: 999, key: 'H2@192' });
    expect(result.tries).toEqual([
      { tier: 'H2', size: null, firstLoad: 1001 },
      { tier: 'H2', size: 192, firstLoad: 999 },
    ]);
    // One lit geometry for both sizes; a copy of it ships while a size is still to come.
    expect(lit).toEqual([{ tier: 'H2', triesBefore: 0 }]);
    expect(shipped).toEqual([{ key: 'H2@256', rest: [192] }, { key: 'H2@192', rest: [] }]);
  });

  it('stops at the first try that fits: H2 at 256 px, exactly at the cap, is the only try', async () => {
    const { result, lit, shipped } = await walk({ 'H2@256': 1000 });
    expect([result.tier, result.size]).toEqual(['H2', null]);
    expect(result.tries).toHaveLength(1);
    expect(lit.map((l) => l.tier)).toEqual(['H2']);
    expect(shipped.map((s) => s.key)).toEqual(['H2@256']);
  });

  it('goes on to tier V, lit once and told the tries so far, when both of H2\'s sizes are over; past the last rung it ships the last try', async () => {
    const v = await walk({ 'H2@256': 1300, 'H2@192': 1200, 'V@256': 1000, 'V@192': 900 });
    expect([v.result.tier, v.result.size]).toEqual(['V', null]);
    expect(v.lit).toEqual([{ tier: 'H2', triesBefore: 0 }, { tier: 'V', triesBefore: 2 }]);
    const none = await walk({ 'H2@256': 1300, 'H2@192': 1200, 'V@256': 1100, 'V@192': 1050 });
    expect([none.result.tier, none.result.size]).toEqual(['V', 192]);
    expect(none.result.shipped.firstLoad).toBe(1050);
    expect(none.result.tries.map((a) => `${a.tier}@${a.size ?? 256}`)).toEqual(['H2@256', 'H2@192', 'V@256', 'V@192']);
  });
});

describe('lightChecks', () => {
  const budget = { lightmapBytes: 2e6, gridBytes: 0.4e6 };
  const write = (name, bytes) => fs.writeFileSync(path.join(root, name), bytes);
  const gz = (name) => write(`${name}.gz`, zlib.gzipSync(fs.readFileSync(path.join(root, name))));
  const grid = { origin: [0, 0, 0], step: 2.5, size: [2, 1, 1], up: new Float32Array(6).fill(1), down: new Float32Array(6).fill(0.5), side: new Float32Array(6).fill(0.75), sun: new Float32Array(2).fill(1) };
  async function bake({ range = 8, size = [4, 4], lightmap = true, probesRange = range } = {}) {
    const json = lightJson({ range, lightmapSize: lightmap ? size : null, sun: null });
    write('light.json', `${JSON.stringify(json)}\n`);
    gz('light.json');
    if (lightmap) write('lightmap.webp', await lightmapWebp(encodeLightmap({ width: 4, height: 4, data: new Float32Array(48).fill(1) }, range), 4, 4));
    write('probes.bin', encodeLightGrid(grid, probesRange));
    gz('probes.bin');
  }
  const status = (rows) => Object.fromEntries(rows.map(([check, , , s]) => [check, s]));

  it('passes a whole bake: light.json, the lightmap its size says, a light grid that decodes, gz siblings', async () => {
    await bake();
    const rows = await lightChecks(root, budget);
    expect(status(rows)).toEqual({
      'light.json': 'OK',
      'lightmap.webp size': 'OK',
      'lightmap.webp dimensions': 'OK',
      'probes.bin': 'OK',
      'light.json.gz': 'OK',
      'probes.bin.gz': 'OK',
      'probes.bin.gz size': 'OK',
    });
    // The grid's row names its version (2: up, down, side and the sun per cell).
    expect(rows.find(([check]) => check === 'probes.bin')[1]).toMatch(/^version 2, 2×1×1 cells of 2\.5 m, range 8$/);
  });
  it('fails a light grid whose gz sibling is over its budget', async () => {
    await bake();
    const rows = await lightChecks(root, { ...budget, gridBytes: 10 });
    const row = rows.find(([check]) => check === 'probes.bin.gz size');
    expect(row[2]).toBe('≤ 0.00 MB');
    expect(row[3]).toBe('FAIL');
  });
  it('fails a lightmap over its budget or of another size than light.json says', async () => {
    await bake({ size: [8, 8] });
    const rows = status(await lightChecks(root, { lightmapBytes: 10 }));
    expect(rows['lightmap.webp size']).toBe('FAIL');
    expect(rows['lightmap.webp dimensions']).toBe('FAIL');
  });
  it('fails a light grid that does not decode or whose range is not light.json\'s', async () => {
    await bake({ probesRange: 16 });
    expect(status(await lightChecks(root, budget))['probes.bin']).toBe('FAIL');
    await bake();
    write('probes.bin', fs.readFileSync(path.join(root, 'probes.bin')).subarray(0, 40));
    const rows = status(await lightChecks(root, budget));
    expect(rows['probes.bin']).toBe('FAIL');
    expect(rows['probes.bin.gz']).toBe('FAIL'); // the sibling no longer inflates to it
  });
  it('under tier V wants no lightmap.webp, and a stale one fails', async () => {
    await bake({ lightmap: false });
    let rows = status(await lightChecks(root, budget));
    expect(rows['lightmap.webp']).toBe('SKIP');
    write('lightmap.webp', Buffer.from('stale'));
    rows = status(await lightChecks(root, budget));
    expect(rows['lightmap.webp']).toBe('FAIL');
  });
  it('skips a map built without a bake, but fails bake files left without light.json', async () => {
    expect(status(await lightChecks(root, budget))).toEqual({ 'light.json': 'SKIP' });
    write('probes.bin', Buffer.from('stale'));
    expect(status(await lightChecks(root, budget))['light.json']).toBe('FAIL');
  });
  it('fails a map that must ship the bake (LIGHTMAP_MAPS) built without one, and passes it whole', async () => {
    const rows = await lightChecks(root, budget, undefined, { required: true });
    expect(rows).toEqual([['light.json', 'none (built without a bake: AO in COLOR_0)', 'present (the map is in LIGHTMAP_MAPS)', 'FAIL']]);
    await bake();
    expect(Object.values(status(await lightChecks(root, budget, undefined, { required: true }))).every((s) => s === 'OK')).toBe(true);
  });
  it('fails a light.json that does not parse or lacks its fields', async () => {
    write('light.json', '{');
    expect(status(await lightChecks(root, budget))['light.json']).toBe('FAIL');
    write('light.json', JSON.stringify({ version: 1, range: 8 }));
    expect(status(await lightChecks(root, budget))['light.json']).toBe('FAIL');
    // Version 1 was the RGBM lightmap: a whole one of those fails too.
    write('light.json', JSON.stringify({ version: 1, range: 8, lightmap: null, sun: null, probes: { file: 'probes.bin' } }));
    expect(status(await lightChecks(root, budget))['light.json']).toBe('FAIL');
  });
  it('fails a light.json the viewer would draw as no bake: no light grid, a sun without a direction or a negative brightness', async () => {
    await bake();
    const whole = JSON.parse(fs.readFileSync(path.join(root, 'light.json'), 'utf8'));
    const sun = { dir: [0, 1, 0], color: [1, 1, 1], intensity: 2, baked: true };
    expect(lightJsonProblem({ ...whole, sun })).toBeNull();
    for (const bad of [
      { ...whole, probes: null },
      { ...whole, sun: { ...sun, dir: [0, 0, 0] } },
      { ...whole, sun: { ...sun, intensity: -1 } },
    ]) {
      expect(lightJsonProblem(bad)).not.toBeNull();
      write('light.json', JSON.stringify(bad));
      expect(status(await lightChecks(root, budget))['light.json']).toBe('FAIL');
    }
  });
});

describe('litCheck', () => {
  const tri = [0, 0, 0, 1, 0, 0, 0, 0, 1];
  const withColour = (prim) => prim.setAttribute('COLOR_0', prim.getAttribute('POSITION'));
  it('with a bake: every primitive has TEXCOORD_1 (lightmap) or COLOR_0 (vertex light)', () => {
    const { doc, prims: [a, b] } = scene([{ positions: tri, uv1: [0, 0, 1, 0, 0, 1] }, { positions: tri }]);
    const light = { lightmap: { file: 'lightmap.webp', size: [4, 4] } };
    expect(litCheck(doc, light).ok).toBe(false);
    withColour(b);
    expect(litCheck(doc, light)).toMatchObject({ ok: true, actual: '2/2 primitives (1 lightmap, 1 vertex light)' });
    expect(litCheck(doc, { lightmap: null }).ok).toBe(false); // a lightmap UV without a lightmap
    a.setAttribute('TEXCOORD_1', null);
    expect(litCheck(doc, { lightmap: null }).ok).toBe(false);
  });
  it('without a bake: every primitive has COLOR_0 (the AO), as before', () => {
    const { doc, prims: [a] } = scene([{ positions: tri }]);
    expect(litCheck(doc, null)).toMatchObject({ check: 'COLOR_0', ok: false });
    withColour(a);
    expect(litCheck(doc, null)).toMatchObject({ check: 'COLOR_0', ok: true, actual: '1/1 primitives' });
  });
});
