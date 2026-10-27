// The map's baked light as shrink-map.mjs ships it: the H2 tier the user approved (Task 1b in
// the m2a plan), light.json, and the checks check-map.mjs runs on the result.
//
// A primitive keeps its lightmap UV (lightmap.mjs lightmapUv, shipped as TEXCOORD_1) when it has
// at least LIGHT_PARAMS.minTexelsPerVertex lightmap texels at `sampleSize` per vertex, where the
// lightmap carries more than its vertices could. Every other primitive gets per-vertex light in
// COLOR_0 (normalized u8 RGBA, rgb = sqrt(min(light / range, 1)) rounded to `colorBits` bits,
// the three channels jointly so the hue holds (lightBytes), which the viewer squares and
// multiplies by the map's range):
// - with a lightmap UV: the baked light (irradiance plus, on a baked-sun map, the offline sun) at
//   `sampleSize`, coverage-weighted and padded, bilinear at that UV;
// - without one: CS2's probe volumes at full resolution (never the coarse grid; probes.mjs
//   probeSampler), `probeOffset` off the surface along its normal: the ambient cube along the
//   normal (Σ n_axis² · the face it points at), plus on a baked-sun map the sun · max(N·L, 0) ·
//   its visibility there.
// The light is taken per source vertex before anything is stripped (sourceLight) and pooled per
// material in `cell`-sized cells. After weld and simplify each final vertex takes the mean of the
// source vertices of its material in its cell (applyVertexLight), so a chart seam (one place,
// several lightmap UVs) is averaged and the bake splits no vertices (D8, D9).
import fs from 'node:fs';
import path from 'node:path';
import { Primitive } from '@gltf-transform/core';
import sharp from 'sharp';
import { gzSiblingState } from './gz.mjs';
import { floats, lightBytes, lightmapUv, normalMatrix } from './lightmap.mjs';
import { MAP_BAKE_FILES } from './maps.mjs';
import { decodeLightGrid } from './probes.mjs';

/**
 * The worlds a baked map tries, in this written order, until its first load (lib/maps.mjs
 * firstLoadBytes) fits its cap (lib/budgets.mjs): H2 (the lightmap), then H2 with world.glb's
 * textures a step smaller, 192 px for 256, then tier V (vertex light only: the user's ruling of
 * 2026-10-24) at 256 and at 192 px. The plan's budget rule drops the world textures from 256 to
 * 192 px before the lightmap, and stops there to ask the user (the controller's ruling,
 * 2026-10-25). `worldSize` null is shrink-map.mjs's own (PARAMS.world.size); entities.glb keeps
 * its. shrink-map walks it by `ladderRuns`; past the last step check-map.mjs
 * fails the map.
 */
export const TIER_LADDER = Object.freeze([
  Object.freeze({ tier: 'H2', worldSize: null }),
  Object.freeze({ tier: 'H2', worldSize: 192 }),
  Object.freeze({ tier: 'V', worldSize: null }),
  Object.freeze({ tier: 'V', worldSize: 192 }),
]);

/**
 * `ladder` (TIER_LADDER) as shrink-map.mjs walks it, in its written order: one run per tier, each
 * the world sizes its steps give in order. A tier's lit geometry is built once and its textures
 * tried at each size, so a tier that comes back after another, an unknown tier or an empty ladder
 * throws.
 * @returns {{ tier: 'H2' | 'V', sizes: (number | null)[] }[]}
 */
export function ladderRuns(ladder = TIER_LADDER) {
  if (!ladder.length) throw new Error('an empty tier ladder');
  const runs = [];
  for (const { tier, worldSize } of ladder) {
    if (tier !== 'H2' && tier !== 'V') throw new Error(`tier ladder: unknown tier ${tier}`);
    const last = runs[runs.length - 1];
    if (last?.tier === tier) {
      last.sizes.push(worldSize);
      continue;
    }
    if (runs.some((r) => r.tier === tier)) throw new Error(`tier ladder: ${tier} comes back after another tier`);
    runs.push({ tier, sizes: [worldSize] });
  }
  return runs;
}

/**
 * shrink-map.mjs's walk of `runs` (`ladderRuns`) against the first-load `cap`: for each tier in
 * order, `light(tier, tries)` once (its lit geometry, built once a tier; `tries` the tries so far),
 * then `ship(lit, size, rest)` at each of its sizes in turn (`rest`: the tier's sizes after this
 * one, none for its last), which answers `{ firstLoad }` and what else it shipped. It stops at the
 * first try whose first load fits the cap; past the last, the last try is what ships. Returns the
 * tier, size, lit geometry and `ship`'s answer of the try that ships, and every try in order
 * (`tries`: `{ tier, size, firstLoad }`).
 * @template L, S
 * @param {{ tier: string, sizes: (number | null)[] }[]} runs
 * @param {number} cap
 * @param {{ light: (tier: string, tries: object[]) => Promise<L>, ship: (lit: L, size: number | null, rest: (number | null)[]) => Promise<S & { firstLoad: number }> }} steps
 */
export async function walkLadder(runs, cap, { light, ship }) {
  if (!runs.length) throw new Error('an empty tier ladder');
  const tries = [];
  let at = null;
  for (const run of runs) {
    const lit = await light(run.tier, tries);
    for (const [i, size] of run.sizes.entries()) {
      const shipped = await ship(lit, size, run.sizes.slice(i + 1));
      tries.push({ tier: run.tier, size, firstLoad: shipped.firstLoad });
      at = { tier: run.tier, size, lit, shipped };
      if (shipped.firstLoad <= cap) return { ...at, tries };
    }
  }
  return { ...at, tries };
}

/**
 * The H2 tier (Task 1b): `sampleSize` is the baked light vertex-lit primitives read and the size
 * the density test counts texels at, padded `samplePadding` rings; a primitive keeps its lightmap
 * UV at `minTexelsPerVertex` texels per vertex or more (2 is the knee: Mirage keeps 86.5 % of the
 * lightmap's area); COLOR_0 light in `colorBits` bits (6: Mirage −0.34 MB, Nuke −1.0 MB against
 * 8, no visible banding); probes read `probeOffset` metres off the surface; source vertices pool
 * in `cell`-metre cells.
 */

export const LIGHT_PARAMS = Object.freeze({
  sampleSize: 2048,
  samplePadding: 4,
  minTexelsPerVertex: 2,
  colorBits: 6,
  probeOffset: 0.1,
  cell: 0.005,
});

/** light.json's version: 2 since the lightmap is sqrt(light / range) (1 was RGBM). */
const VERSION = 2;

/** Which vertices the primitive's index list uses (VRF's primitives share their mesh's buffer). */
function usedVertices(prim, count) {
  const used = new Uint8Array(count);
  const idx = prim.getIndices()?.getArray();
  if (idx) for (let i = 0; i < idx.length; i++) used[idx[i]] = 1;
  else used.fill(1);
  return used;
}

/**
 * The primitive's lightmap texels at `size`² per vertex it indexes: its lightmap UV's area ×
 * size² over those vertices. 0 without a lightmap UV, or for a primitive not of triangles.
 */
export function texelsPerVertex(prim, size = LIGHT_PARAMS.sampleSize) {
  const acc = lightmapUv(prim);
  if (!acc || prim.getMode() !== Primitive.Mode.TRIANGLES) return 0;
  const uv = floats(acc);
  const n = acc.getCount();
  const idx = prim.getIndices()?.getArray();
  const corners = idx ? idx.length : n;
  let area = 0;
  for (let t = 0; t + 2 < corners; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    area += Math.abs((uv[2 * b] - uv[2 * a]) * (uv[2 * c + 1] - uv[2 * a + 1]) - (uv[2 * c] - uv[2 * a]) * (uv[2 * b + 1] - uv[2 * a + 1])) / 2;
  }
  const used = usedVertices(prim, n);
  let vertices = 0;
  for (let j = 0; j < n; j++) vertices += used[j];
  return vertices ? (area * size * size) / vertices : 0;
}

/** H2: whether the primitive ships its lightmap UV (else it is vertex-lit). */
export function keepsLightmapUv(prim, params = LIGHT_PARAMS) {
  return texelsPerVertex(prim, params.sampleSize) >= params.minTexelsPerVertex;
}

/**
 * `img` (lightmap.mjs HdrImage, row 0 at v = 0) at lightmap UV (u, v): bilinear between texel
 * centres, clamped at the edges, into `out`.
 */
export function sampleLight(img, u, v, out = [0, 0, 0]) {
  const { width: W, height: H, data } = img;
  const x = Math.min(W - 1, Math.max(0, (Number.isFinite(u) ? u : 0) * W - 0.5));
  const y = Math.min(H - 1, Math.max(0, (Number.isFinite(v) ? v : 0) * H - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[3 * (y0 * W + x0) + c], b = data[3 * (y0 * W + x1) + c];
    const d = data[3 * (y1 * W + x0) + c], e = data[3 * (y1 * W + x1) + c];
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
  return out;
}

/**
 * Each material of `doc` by its index in the document: the keys sourceLight pools by, so that a
 * clone (cloneDocument keeps the order) reads the same pool through its own materialIds.
 */
export function materialIds(doc) {
  return new Map(doc.getRoot().listMaterials().map((m, i) => [m, i]));
}

/** Calls fn(node, prim, world matrix, used vertices) for every primitive of every mesh node. */
function eachInstance(doc, fn) {
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const n = prim.getAttribute('POSITION')?.getCount() ?? 0;
      if (n) fn(node, prim, m, usedVertices(prim, n));
    }
  }
}

/** `m` (column-major 4 × 4) times point (x, y, z), into `out`. */
function transform(m, x, y, z, out) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

/** Per-vertex normals of a primitive without NORMAL: the area-weighted normals of its triangles. */
function faceNormals(prim, pos) {
  const n = new Float64Array(pos.length);
  const idx = prim.getIndices()?.getArray();
  const corners = idx ? idx.length : pos.length / 3;
  for (let t = 0; t + 2 < corners; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    const ux = pos[3 * b] - pos[3 * a], uy = pos[3 * b + 1] - pos[3 * a + 1], uz = pos[3 * b + 2] - pos[3 * a + 2];
    const vx = pos[3 * c] - pos[3 * a], vy = pos[3 * c + 1] - pos[3 * a + 1], vz = pos[3 * c + 2] - pos[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    for (const j of [a, b, c]) { n[3 * j] += cx; n[3 * j + 1] += cy; n[3 * j + 2] += cz; }
  }
  return n;
}

/**
 * The light of every source vertex, pooled per material in `cell`-metre cells (world space):
 * at its lightmap UV in `lightmap` (an HdrImage, the baked light) where the primitive has one,
 * else `probe(p, n, out)` (probes.mjs probeSampler, writing into `out` or returning the light) at
 * its world position with its world normal (NORMAL through the node, or its triangles' normal
 * without NORMAL). Only the vertices a primitive indexes count, once per
 * node that draws it. `ids` is materialIds(doc).
 * @returns {object} the pool applyVertexLight reads; `sources` counts the vertices pooled
 */
export function sourceLight(doc, ids, { lightmap, probe, cell = LIGHT_PARAMS.cell }) {
  // Cell keys are integers over the source vertices' box, a few cells wider on each side.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const g = [0, 0, 0];
  eachInstance(doc, (node, prim, m, used) => {
    const pos = floats(prim.getAttribute('POSITION'));
    for (let j = 0; j < used.length; j++) {
      if (!used[j]) continue;
      transform(m, pos[3 * j], pos[3 * j + 1], pos[3 * j + 2], g);
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], g[a]); hi[a] = Math.max(hi[a], g[a]); }
    }
  });
  const MARGIN = 4;
  const origin = lo.map((x) => (Number.isFinite(x) ? Math.round(x / cell) - MARGIN : 0));
  const dims = hi.map((x, a) => (Number.isFinite(x) ? Math.round(x / cell) - origin[a] + MARGIN + 1 : 1));
  if (dims[0] * dims[1] * dims[2] > Number.MAX_SAFE_INTEGER) throw new Error(`sourceLight: ${dims.join(' × ')} cells of ${cell} m do not fit one integer key`);

  const nm = ids.size + 1; // the last slot is primitives without a material
  const pool = {
    cell, origin, dims,
    cells: new Map(), // key → [material, r, g, b, count, material, …]
    materials: new Float64Array(4 * nm), // per material: r, g, b, count
    all: new Float64Array(4),
    sources: 0,
    slot: (material) => ids.get(material) ?? ids.size,
  };
  const light = [0, 0, 0], nrm = [0, 0, 0];
  eachInstance(doc, (node, prim, m, used) => {
    const mid = pool.slot(prim.getMaterial());
    const pos = floats(prim.getAttribute('POSITION'));
    const uvAcc = lightmap ? lightmapUv(prim) : null;
    const uv = uvAcc ? floats(uvAcc) : null;
    let normals = null, matrix = null;
    if (!uv) {
      const acc = prim.getAttribute('NORMAL');
      normals = acc ? floats(acc) : faceNormals(prim, pos);
      matrix = normalMatrix(m);
    }
    for (let j = 0; j < used.length; j++) {
      if (!used[j]) continue;
      transform(m, pos[3 * j], pos[3 * j + 1], pos[3 * j + 2], g);
      if (uv) {
        sampleLight(lightmap, uv[2 * j], uv[2 * j + 1], light);
      } else {
        const x = normals[3 * j], y = normals[3 * j + 1], z = normals[3 * j + 2];
        nrm[0] = matrix[0] * x + matrix[1] * y + matrix[2] * z;
        nrm[1] = matrix[3] * x + matrix[4] * y + matrix[5] * z;
        nrm[2] = matrix[6] * x + matrix[7] * y + matrix[8] * z;
        const len = Math.hypot(nrm[0], nrm[1], nrm[2]);
        if (len > 0) { nrm[0] /= len; nrm[1] /= len; nrm[2] /= len; } else { nrm[0] = 0; nrm[1] = 1; nrm[2] = 0; }
        const l = probe(g, nrm, light);
        if (l !== light) { light[0] = l[0]; light[1] = l[1]; light[2] = l[2]; }
      }
      add(pool, mid, g, light);
    }
  });
  return pool;
}

/** The pool's integer key of world point `g`, or −1 outside its box. */
function keyOf(pool, g, dx = 0, dy = 0, dz = 0) {
  const { cell, origin, dims } = pool;
  const x = Math.round(g[0] / cell) - origin[0] + dx;
  const y = Math.round(g[1] / cell) - origin[1] + dy;
  const z = Math.round(g[2] / cell) - origin[2] + dz;
  if (x < 0 || y < 0 || z < 0 || x >= dims[0] || y >= dims[1] || z >= dims[2]) return -1;
  return (x * dims[1] + y) * dims[2] + z;
}

function add(pool, mid, g, light) {
  const key = keyOf(pool, g);
  let e = pool.cells.get(key);
  if (!e) { e = []; pool.cells.set(key, e); }
  let i = 0;
  while (i < e.length && e[i] !== mid) i += 5;
  if (i === e.length) e.push(mid, 0, 0, 0, 0);
  for (let k = 0; k < 3; k++) {
    e[i + 1 + k] += light[k];
    pool.materials[4 * mid + k] += light[k];
    pool.all[k] += light[k];
  }
  e[i + 4]++;
  pool.materials[4 * mid + 3]++;
  pool.all[3]++;
  pool.sources++;
}

/** The index of material `mid`'s entry in cell entry list `e`, or −1. */
function find(e, mid) {
  if (!e) return -1;
  for (let i = 0; i < e.length; i += 5) if (e[i] === mid) return i;
  return -1;
}

/**
 * COLOR_0 for every primitive of `doc` without TEXCOORD_1 (those that ship no lightmap UV): each
 * vertex, in world space, takes the mean light of the source vertices of its material (`ids`, its
 * materialIds) in its cell of `pool` (sourceLight). Failing that, the nearest neighbouring cell
 * with that material; then the cell's other material; then the material's mean light (the
 * map's, for a material never pooled), so no vertex is left black. Each node drawing a shared
 * mesh with such primitives gets its own copy, since the light is per place. The light is stored
 * as lightBytes(·, range, bits), alpha 255.
 * @returns {{ primitives: number, vertices: number, hit: number, neighbour: number,
 *   otherMaterial: number, fallback: number, copiedMeshes: number }}
 */
export function applyVertexLight(doc, ids, pool, range, bits = LIGHT_PARAMS.colorBits) {
  const root = doc.getRoot();
  const stats = { primitives: 0, vertices: 0, hit: 0, neighbour: 0, otherMaterial: 0, fallback: 0, copiedMeshes: 0 };
  const vertexLit = (mesh) => mesh.listPrimitives().some((p) => !p.getAttribute('TEXCOORD_1'));
  const users = new Map();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (mesh) users.set(mesh, (users.get(mesh) ?? 0) + 1);
  }
  const first = new Set();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || users.get(mesh) < 2 || !vertexLit(mesh)) continue;
    if (!first.has(mesh)) { first.add(mesh); continue; }
    const copy = doc.createMesh(mesh.getName());
    for (const p of mesh.listPrimitives()) copy.addPrimitive(p.clone());
    node.setMesh(copy);
    stats.copiedMeshes++;
  }

  const buffer = root.listBuffers()[0] ?? doc.createBuffer();
  const mean = new Float64Array(3);
  const codes = [0, 0, 0];
  const g = [0, 0, 0];
  const meanOf = (sums, o) => { for (let k = 0; k < 3; k++) mean[k] = sums[o + k] / sums[o + 3]; };
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      if (prim.getAttribute('TEXCOORD_1')) continue;
      const mid = ids.get(prim.getMaterial()) ?? ids.size;
      const pos = floats(prim.getAttribute('POSITION'));
      const n = pos.length / 3;
      const colour = new Uint8Array(4 * n);
      for (let j = 0; j < n; j++) {
        transform(m, pos[3 * j], pos[3 * j + 1], pos[3 * j + 2], g);
        const key = keyOf(pool, g);
        const e = key < 0 ? undefined : pool.cells.get(key);
        let entry = e, i = find(e, mid);
        if (i >= 0) {
          stats.hit++;
        } else {
          // Weld or simplify moved it across a cell edge (or rounding did).
          let best = Infinity;
          for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const d2 = dx * dx + dy * dy + dz * dz;
            if (!d2 || d2 >= best) continue;
            const k = keyOf(pool, g, dx, dy, dz);
            const f = k < 0 ? undefined : pool.cells.get(k);
            const fi = find(f, mid);
            if (fi >= 0) { entry = f; i = fi; best = d2; }
          }
          if (i >= 0) stats.neighbour++;
          else if (e?.length) { entry = e; i = 0; stats.otherMaterial++; }
        }
        if (i >= 0) {
          for (let k = 0; k < 3; k++) mean[k] = entry[i + 1 + k] / entry[i + 4];
        } else {
          stats.fallback++;
          if (pool.materials[4 * mid + 3] > 0) meanOf(pool.materials, 4 * mid);
          else if (pool.all[3] > 0) meanOf(pool.all, 0);
          else mean.fill(0);
        }
        lightBytes(mean, range, bits, codes);
        colour[4 * j] = codes[0];
        colour[4 * j + 1] = codes[1];
        colour[4 * j + 2] = codes[2];
        colour[4 * j + 3] = 255;
      }
      prim.setAttribute('COLOR_0', doc.createAccessor('light').setType('VEC4').setArray(colour).setNormalized(true).setBuffer(buffer));
      stats.primitives++;
      stats.vertices += n;
    }
  }
  return stats;
}

/**
 * light.json: what the viewer needs to use the bake. `range` is the map's one light
 * range (the lightmap and COLOR_0's vertex light, both sqrt(light / range), which the viewer
 * squares); `lightmap` names lightmap.webp and its size, null under tier V (vertex light only); `sun` is the map's sun (sunOf: `dir` towards it in glTF,
 * linear `color`, `intensity`, and `baked`: in the lightmap and the vertex light already, so the
 * viewer adds it only to what moves; false on a dynamic-sun map like de_cache, which keeps the
 * runtime sun), null without one; `probes` names the light grid for players, which every bake
 * has: the viewer (web/src/scene/baked.ts parseLightInfo) draws a light.json without one as no
 * bake at all.
 * @param {{ range: number, lightmapSize: number[] | null, sun: object | null }} bake
 */
export function lightJson({ range, lightmapSize, sun }) {
  const r6 = (x) => +x.toFixed(6);
  return {
    version: VERSION,
    range,
    lightmap: lightmapSize ? { file: 'lightmap.webp', size: [...lightmapSize] } : null,
    sun: sun ? { dir: sun.dir.map(r6), color: sun.color.map(r6), intensity: r6(sun.intensity), baked: sun.baked } : null,
    probes: { file: 'probes.bin' },
  };
}

/**
 * Why `j` is not a light.json this pipeline writes, or null. Every light.json it passes the
 * viewer reads (web/src/scene/baked.ts parseLightInfo; web/test/tools-parity.test.ts holds the
 * two together): a sun has a direction (not zero length) and a brightness of 0 or more, and the
 * light grid is named.
 */
export function lightJsonProblem(j) {
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  const vec3 = (v) => Array.isArray(v) && v.length === 3 && v.every(finite);
  if (j === null || typeof j !== 'object') return 'not an object';
  if (j.version !== VERSION) return `version ${JSON.stringify(j.version)}`;
  if (!finite(j.range) || j.range <= 0) return `range ${JSON.stringify(j.range)}`;
  for (const k of ['lightmap', 'sun', 'probes']) if (!(k in j)) return `no ${k}`;
  const { lightmap, sun, probes } = j;
  if (lightmap !== null && (lightmap?.file !== 'lightmap.webp' || !Array.isArray(lightmap.size) || lightmap.size.length !== 2 || !lightmap.size.every((s) => Number.isInteger(s) && s > 0))) {
    return `lightmap ${JSON.stringify(lightmap)}`;
  }
  if (sun !== null && (!vec3(sun?.dir) || Math.hypot(...sun.dir) < 1e-6 || !vec3(sun.color) || !finite(sun.intensity) || sun.intensity < 0 || typeof sun.baked !== 'boolean')) return `sun ${JSON.stringify(sun)}`;
  if (probes?.file !== 'probes.bin') return `probes ${JSON.stringify(probes)}`;
  return null;
}

/**
 * check-map.mjs's rows for a map's bake in `dir`, each [check, actual, budget, OK | FAIL | SKIP]:
 * light.json valid; lightmap.webp within `budget.lightmapBytes` and of the size light.json says
 * (none under tier V); probes.bin decodes, its length what its header says, with light.json's
 * range (the row names its version); the gz siblings inflate to their files, and probes.bin.gz is
 * within `budget.gridBytes`. A map built without a bake fails if bake files lie there without
 * light.json, and with `required` (a map in LIGHTMAP_MAPS, which ships CS2's baked light) in any
 * case; otherwise it has a SKIP row. `tag(key)` marks an overridden budget.
 */
export async function lightChecks(dir, budget, tag = () => '', { required = false } = {}) {
  const rows = [];
  const row = (check, actual, want, ok) => rows.push([check, String(actual), want, ok === null ? 'SKIP' : ok ? 'OK' : 'FAIL']);
  const file = (f) => path.join(dir, f);
  const has = (f) => fs.existsSync(file(f));
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
  if (!has('light.json')) {
    const stray = MAP_BAKE_FILES.filter(has);
    if (stray.length) row('light.json', `missing beside ${stray.join(', ')}`, 'with the bake files it names', false);
    else if (required) row('light.json', 'none (built without a bake: AO in COLOR_0)', 'present (the map is in LIGHTMAP_MAPS)', false);
    else row('light.json', 'none (built without a bake: AO in COLOR_0)', 'optional', null);
    return rows;
  }
  let light;
  try {
    light = JSON.parse(fs.readFileSync(file('light.json'), 'utf8'));
  } catch (e) {
    row('light.json', `unparseable: ${e.message}`, 'valid JSON', false);
    return rows;
  }
  const problem = lightJsonProblem(light);
  if (problem) {
    row('light.json', problem, `version ${VERSION}: range, lightmap, sun, probes`, false);
    return rows;
  }
  const sun = light.sun ? `sun ${light.sun.baked ? 'baked' : 'at runtime'}` : 'no sun';
  row('light.json', `range ${light.range}, ${light.lightmap ? 'lightmap' : 'tier V'}, ${sun}`, 'valid', true);

  if (light.lightmap) {
    if (!has('lightmap.webp')) {
      row('lightmap.webp', 'missing', 'present (light.json names it)', false);
    } else {
      const bytes = fs.statSync(file('lightmap.webp')).size;
      row('lightmap.webp size', mb(bytes), `≤ ${mb(budget.lightmapBytes)}${tag('lightmapBytes')}`, bytes <= budget.lightmapBytes);
      const { width, height, format } = await sharp(file('lightmap.webp')).metadata();
      const [w, h] = light.lightmap.size;
      row('lightmap.webp dimensions', `${width}×${height}${format === 'webp' ? '' : ` ${format}`}`, `${w}×${h} (light.json)`, format === 'webp' && width === w && height === h);
    }
  } else {
    row('lightmap.webp', has('lightmap.webp') ? 'present, stale' : 'none (tier V: vertex light only)', 'none under tier V', has('lightmap.webp') ? false : null);
  }

  // A valid light.json names probes.bin: every bake has its light grid.
  if (!has('probes.bin')) {
    row('probes.bin', 'missing', 'present (light.json names it)', false);
  } else {
    try {
      const grid = decodeLightGrid(fs.readFileSync(file('probes.bin')));
      row('probes.bin', `version ${grid.version}, ${grid.size.join('×')} cells of ${grid.step} m, range ${grid.range}`, `decodes, range ${light.range} (light.json)`, grid.range === light.range);
    } catch (e) {
      row('probes.bin', e.message, 'decodes, as long as its header says', false);
    }
  }

  for (const f of ['light.json', ...(has('probes.bin') ? ['probes.bin'] : [])]) {
    const state = gzSiblingState(file(f));
    row(`${f}.gz`, state === 'ok' ? mb(fs.statSync(file(`${f}.gz`)).size) : state, `inflates to ${f}`, state === 'ok');
  }
  // What the players' light costs the first load (D7's 0.4 MB).
  if (has('probes.bin.gz')) {
    const bytes = fs.statSync(file('probes.bin.gz')).size;
    row('probes.bin.gz size', mb(bytes), `≤ ${mb(budget.gridBytes)}${tag('gridBytes')}`, bytes <= budget.gridBytes);
  }
  return rows;
}

/**
 * Whether every primitive of `doc` (a built world) is lit: with a bake (`light`, the parsed
 * light.json), by its lightmap (TEXCOORD_1, only when light.json has one) or its vertex light
 * (COLOR_0); without one (`light` null), by the AO in COLOR_0, as before M2a.
 * @returns {{ check: string, actual: string, budget: string, ok: boolean }}
 */
export function litCheck(doc, light) {
  let prims = 0, lightmapped = 0, vertexLit = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const p of mesh.listPrimitives()) {
      prims++;
      if (p.getAttribute('TEXCOORD_1')) lightmapped++;
      else if (p.getAttribute('COLOR_0')) vertexLit++;
    }
  }
  if (!light) {
    let coloured = 0;
    for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) if (p.getAttribute('COLOR_0')) coloured++;
    return { check: 'COLOR_0', actual: `${coloured}/${prims} primitives`, budget: 'every primitive', ok: prims > 0 && coloured === prims };
  }
  return {
    check: 'lit',
    actual: `${lightmapped + vertexLit}/${prims} primitives (${lightmapped} lightmap, ${vertexLit} vertex light)`,
    budget: light.lightmap ? 'every primitive has TEXCOORD_1 or COLOR_0' : 'every primitive has COLOR_0 (tier V)',
    ok: prims > 0 && lightmapped + vertexLit === prims && (lightmapped === 0 || !!light.lightmap),
  };
}
