// CS2's light probe volumes as the coarse light grid the viewer ships (probes.bin), and the
// per-vertex light that grid gives (the M2a spike, tools/spike/lightmap/probes.mjs; findings
// D6–D8 in the m2a plan; tools/README.md "Light grid" has the measurements).
//
// rip-lighting.sh exports raw/<map>/lightmaps/env_light_probe_volume_atlas_z<nnn>.exr (W × H ×
// 6D, float RGB) and env_light_probe_volume_atlas_dlshd_z<nnn>.png (W × H × D, RGBA8). Each
// env_combined_light_probe_volume / env_light_probe_volume entity places one volume (D6):
// - its box is box_mins..box_maxs in the entity's own frame (origin, then Source angles), and its
//   light_probe_size_{x,y,z} probes fill the box like texel centres, probe i at
//   mins + (i + 0.5) · (maxs − mins) / size (voxel_size is not the spacing);
// - face f of its probes is the atlas block at (light_probe_atlas_x, _y, _z + f·D), faces in the
//   order +x +y +z −x −y −z, Source world axes (not Source 1's ambient-cube order). They hold no
//   sun: the probes match the lightmap irradiance, which has none (D3);
// - _dlshd r is the sun's shadow (1 = shadowed), so its visibility is 1 − r.
// Rotated volumes (Nuke has one, yaw 270): scored on it by the median |log2(face along the normal
// / lightmap irradiance)|, positions turned by Source's angle matrix 0.127, turned the other way
// 0.400, not turned 0.255; on walls, faces in world axes 0.147, in the volume's axes (a quarter
// turn) 0.170, a half turn 0.292, three quarters 0.344. So positions are in the volume's frame
// and faces in world axes. The grid keeps only up, down and the mean of the four sides, which a
// yaw leaves alone: the face frame matters to it only for pitch or roll, which is unmeasured.
// Overlapping volumes: one lights each point. Where the highest `indoor_outdoor_level` and the
// smallest box pick differently, the level's probe matches the lightmap better (Nuke 2,449 points:
// median 0.205 vs 0.264 stops; Mirage 371: 0.113 vs 0.125), so priority is the level and a tie
// goes to the smaller box.
//
// The grid (D7): GRID_STEP cells over the union of the volumes clipped to the given bounds, sampled
// at their centres only up to GRID_BAND above a walkable surface. Read trilinearly, cells that sit
// in different volumes mix across the volumes' borders (an indoor player next to an outdoor volume
// read its light), so the cells around the players' points are then refitted by least squares to
// those points' own light (fitToPlayers). Every other cell copies the nearest such cell, so
// trilinear filtering anywhere in the grid reads real light. Per cell the grid keeps the probe
// cube as three terms, `up` (+Y), `down` (−Y) and `side` (the mean of the four sides), and the
// sun's visibility; a surface with unit normal n takes up·max(n.y, 0)² + down·max(−n.y, 0)² +
// side·(1 − n.y²), CS2's own Σ n_axis² · face with the four sides averaged (tools/README.md
// "Light grid" measures it against other weightings).
import fs from 'node:fs';
import path from 'node:path';
import { Primitive } from '@gltf-transform/core';
import sharp from 'sharp';
import { UNIT, vec3 } from './entities.mjs';
import { readExr } from './exr.mjs';

/** Grid spacing, metres (D7; tools/README.md "Light grid" has finer steps measured). */
export const GRID_STEP = 2.5;

/** Cells are sampled up to this many metres above a walkable surface (D7). */
export const GRID_BAND = 2.5;

/** A triangle is walkable when its normal's up (glTF y) component is at least this (~45°). */
const WALKABLE = 0.7;

/**
 * fitToPlayers: points every `spacing` metres over the walkable triangles (at least one per
 * triangle), `heights` above them (the viewer samples a player 1 m up); `rounds` of least squares
 * reweighted towards the error in stops, with `dark` added to each brightness; a pull of `prior`
 * towards each cell's centre sample; Jacobi-preconditioned conjugate gradients to a relative
 * residual of `tolerance`.
 */
export const FIT = Object.freeze({ spacing: 1.5, heights: Object.freeze([0.5, 1, 1.5]), dark: 0.05, prior: 0.05, rounds: 3, tolerance: 1e-3, iterations: 100 });

const PROBE_CLASSES = new Set(['env_combined_light_probe_volume', 'env_light_probe_volume']);

/** The Source face (+x +y +z −x −y −z) of each glTF face +X −X +Y −Y +Z −Z; glTF = Source (y, z, x). */
const GLTF_FACES = Object.freeze([1, 4, 2, 5, 0, 3]);

/**
 * The atlas is kept in half precision where the runtime has Float16Array (Node 24+; Cache's would
 * be 1.7 GB of float32), clamped to its largest finite value.
 */
const AtlasArray = globalThis.Float16Array ?? Float32Array;
const HALF_MAX = 65504;

/** probes.bin: 'DVLG', u16 version, u16 0, f32 origin[3], f32 step, u16 size[3], u16 0, f32 range. */
const MAGIC = 'DVLG';
const VERSION = 2;
const HEADER = 36;
/** Bytes per cell: version 2 up, down, side RGB and the sun; version 1 (146d893–4ef350d) up, down RGB, the sun and 0. */
const CELL = Object.freeze({ 1: 8, 2: 10 });
const MAX_SIZE = 0xffff;

/**
 * @typedef {object} ProbeVolume
 * @property {number[]} min  world box (glTF metres), the volume's box turned by its angles
 * @property {number[]} max
 * @property {number[]} size  probes along the volume's own x, y, z (Source axes, as the atlas)
 * @property {number[]} atlas  the volume's first texel in the atlas, x, y, z
 * @property {number} priority  indoor_outdoor_level: the highest wins where volumes overlap
 * @property {number} volume  m³ of the box: a tie in priority goes to the smaller
 * @property {{ origin: number[], axes: number[][], lo: number[], hi: number[] }} frame  the box in
 *   the volume's frame: `origin` (glTF metres), `axes` (its x, y, z as glTF unit vectors), `lo`/`hi`
 *   (box_mins/box_maxs in metres along those axes)
 *
 * @typedef {object} ProbeAtlas
 * @property {(v: ProbeVolume, i: number, j: number, k: number, out?: Float32Array) => Float32Array} cube
 *   probe (i, j, k) of `v` (along its x, y, z): 18 values, faces +X −X +Y −Y +Z −Z (glTF world
 *   axes, whatever the volume's angles), RGB linear; into `out` when given
 * @property {(v: ProbeVolume, i: number, j: number, k: number) => number} sun  the sun's visibility
 *   at that probe, 0..1 (1 − _dlshd r)
 *
 * @typedef {object} LightGrid
 * @property {number[]} origin  cell (0, 0, 0)'s centre, glTF metres; cell (x, y, z) is at
 *   origin + (x, y, z) · step
 * @property {number} step  metres
 * @property {number[]} size  cells along glTF x, y (up), z
 * @property {Float32Array} up  RGB per cell at x + nx·(y + ny·z): light on a surface facing up
 *   (the cube's +Y face)
 * @property {Float32Array} down  likewise facing down (−Y)
 * @property {Float32Array} side  likewise facing sideways: the mean of the ±X and ±Z faces
 * @property {Float32Array} sun  the sun's visibility per cell, 0..1
 */

/** Source vector to glTF axes (no scale). */
const toGltf = (v) => [v[1], v[2], v[0]];

/**
 * The volume's x, y, z axes in Source world axes: Source's AngleMatrix (pitch, yaw, roll in
 * degrees), forward (cp·cy, cp·sy, −sp), left and up.
 */
function sourceAxes([pitch, yaw, roll]) {
  const [p, y, r] = [pitch, yaw, roll].map((a) => (a * Math.PI) / 180);
  const sp = Math.sin(p), cp = Math.cos(p), sy = Math.sin(y), cy = Math.cos(y), sr = Math.sin(r), cr = Math.cos(r);
  return [
    [cp * cy, cp * sy, -sp],
    [sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp],
    [cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp],
  ];
}

/** One probe volume entity as a ProbeVolume. */
function volumeOf(e) {
  const kv = e.kv;
  const where = `${e.classname} at ${JSON.stringify(kv.origin)}`;
  const vec = (key, fallback) => {
    if (kv[key] === undefined && fallback) return fallback;
    const v = vec3(kv[key]);
    if (!v) throw new Error(`${where}: ${kv[key] === undefined ? 'missing' : 'bad'} ${key} ${JSON.stringify(kv[key] ?? null)}`);
    return v;
  };
  const ints = (prefix, least) => ['x', 'y', 'z'].map((a) => {
    const n = Number(kv[`${prefix}_${a}`]);
    if (!Number.isInteger(n) || n < least) throw new Error(`${where}: bad ${prefix}_${a} ${JSON.stringify(kv[`${prefix}_${a}`])}`);
    return n;
  });
  const origin = vec('origin');
  const mins = vec('box_mins');
  const maxs = vec('box_maxs');
  if (!mins.every((m, a) => maxs[a] > m)) throw new Error(`${where}: empty box ${JSON.stringify(mins)}..${JSON.stringify(maxs)}`);
  const size = ints('light_probe_size', 1);
  const atlas = ints('light_probe_atlas', 0);
  const level = Number(kv.indoor_outdoor_level ?? 0);
  const axes = sourceAxes(vec('angles', [0, 0, 0])).map(toGltf);
  const frame = { origin: toGltf(origin).map((x) => x * UNIT), axes, lo: mins.map((x) => x * UNIT), hi: maxs.map((x) => x * UNIT) };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const l = [0, 1, 2].map((a) => ((c >> a) & 1 ? frame.hi[a] : frame.lo[a]));
    for (let g = 0; g < 3; g++) {
      const w = frame.origin[g] + l[0] * axes[0][g] + l[1] * axes[1][g] + l[2] * axes[2][g];
      min[g] = Math.min(min[g], w);
      max[g] = Math.max(max[g], w);
    }
  }
  return {
    min, max, size, atlas,
    priority: Number.isFinite(level) ? level : 0,
    volume: (frame.hi[0] - frame.lo[0]) * (frame.hi[1] - frame.lo[1]) * (frame.hi[2] - frame.lo[2]),
    frame,
  };
}

/**
 * The map's light probe volumes: every `env_combined_light_probe_volume` and
 * `env_light_probe_volume` of `entities` (lib/entities.mjs parseEntities), in entity order.
 * @returns {ProbeVolume[]}
 */
export function probeVolumes(entities) {
  return entities.filter((e) => PROBE_CLASSES.has(e.classname)).map(volumeOf);
}

/** The slices of `dir` named `<prefix><nnn>.<ext>`, in slice order. */
function slices(dir, prefix, ext) {
  const re = new RegExp(`^${prefix}(\\d+)\\.${ext}$`);
  return fs.readdirSync(dir)
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
    .map((x) => path.join(dir, x.f));
}

/**
 * The probe atlas rip-lighting.sh exported into `dir` (raw/<map>/lightmaps/) for `volumes`:
 * the env_light_probe_volume_atlas_z<nnn>.exr slices (6 per _dlshd slice, D6) and the
 * env_light_probe_volume_atlas_dlshd_z<nnn>.png slices, both read top row first. Throws when the
 * slice counts disagree, the slices differ in size, or a volume does not fit in the atlas. Holds
 * W·H·6D·3 values in half precision (AtlasArray: Mirage 57 MB, Nuke 146 MB, Cache 0.85 GB).
 * @returns {Promise<ProbeAtlas & { width: number, height: number, depth: number }>}
 */
export async function readProbeAtlas(dir, volumes) {
  const exrs = slices(dir, 'env_light_probe_volume_atlas_z', 'exr');
  const pngs = slices(dir, 'env_light_probe_volume_atlas_dlshd_z', 'png');
  const D = pngs.length;
  if (!D || exrs.length !== 6 * D) {
    throw new Error(`${dir}: ${exrs.length} probe atlas slices for ${D} _dlshd slices, not 6 × ${D} (one per cube face, D6)`);
  }
  let W = 0, H = 0, rgb = null;
  const half = (x) => (x > HALF_MAX ? HALF_MAX : x < -HALF_MAX ? -HALF_MAX : x);
  exrs.forEach((file, z) => {
    const e = readExr(file);
    if (!rgb) {
      W = e.width; H = e.height;
      rgb = new AtlasArray(W * H * 6 * D * 3);
    } else if (e.width !== W || e.height !== H) {
      throw new Error(`${file}: ${e.width}×${e.height}, not ${W}×${H} like the first slice`);
    }
    const base = z * W * H * 3;
    for (let t = 0; t < W * H; t++) {
      rgb[base + 3 * t] = half(e.data[4 * t]);
      rgb[base + 3 * t + 1] = half(e.data[4 * t + 1]);
      rgb[base + 3 * t + 2] = half(e.data[4 * t + 2]);
    }
  });
  const shadow = new Uint8Array(W * H * D);
  for (let k = 0; k < D; k++) {
    const { data, info } = await sharp(pngs[k]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (info.width !== W || info.height !== H) throw new Error(`${pngs[k]}: ${info.width}×${info.height}, not ${W}×${H} like the atlas`);
    for (let t = 0; t < W * H; t++) shadow[k * W * H + t] = data[info.channels * t];
  }
  const dims = [W, H, D];
  for (const v of volumes) {
    if (!v.atlas.every((a, i) => a >= 0 && a + v.size[i] <= dims[i])) {
      throw new Error(`a probe volume at atlas ${v.atlas.join(',')} of ${v.size.join('×')} probes lies outside the atlas ${W}×${H}×${D}`);
    }
  }
  return {
    width: W, height: H, depth: D,
    cube(v, i, j, k, out = new Float32Array(18)) {
      const x = v.atlas[0] + i, y = v.atlas[1] + j, z = v.atlas[2] + k;
      for (let g = 0; g < 6; g++) {
        const o = (((GLTF_FACES[g] * D + z) * H + y) * W + x) * 3;
        out[3 * g] = rgb[o];
        out[3 * g + 1] = rgb[o + 1];
        out[3 * g + 2] = rgb[o + 2];
      }
      return out;
    },
    sun(v, i, j, k) {
      return 1 - shadow[((v.atlas[2] + k) * H + v.atlas[1] + j) * W + v.atlas[0] + i] / 255;
    },
  };
}

/**
 * Point `p` (glTF metres) in `v`'s probe coordinates (probe i at i) into `f`; whether it lies in
 * the box (its faces included).
 */
function locate(v, p, f) {
  const { origin, axes, lo, hi } = v.frame;
  const d0 = p[0] - origin[0], d1 = p[1] - origin[1], d2 = p[2] - origin[2];
  let inside = true;
  for (let a = 0; a < 3; a++) {
    const l = axes[a][0] * d0 + axes[a][1] * d1 + axes[a][2] * d2;
    f[a] = ((l - lo[a]) / (hi[a] - lo[a])) * v.size[a] - 0.5;
    if (!(l >= lo[a] && l <= hi[a])) inside = false;
  }
  return inside;
}

/** `volumes` in lookup order: the highest priority first, then the smallest, then entity order. */
function volumeOrder(volumes) {
  return volumes
    .map((v, i) => ({ v, i }))
    .sort((a, b) => b.v.priority - a.v.priority || a.v.volume - b.v.volume || a.i - b.i)
    .map(({ v }) => v);
}

/**
 * The volume that lights point `p`, with `p` in its probe coordinates in `f`, or null outside
 * every volume: the first of `order` (volumeOrder) containing it.
 */
function volumeAt(order, p, f) {
  for (const v of order) {
    if (p[0] < v.min[0] || p[0] > v.max[0] || p[1] < v.min[1] || p[1] > v.max[1] || p[2] < v.min[2] || p[2] > v.max[2]) continue;
    if (locate(v, p, f)) return v;
  }
  return null;
}

/** How far `p` lies outside `v`'s box, metres along the volume's axes (the largest); ≤ 0 inside. */
function outside(v, p) {
  const { origin, axes, lo, hi } = v.frame;
  const d0 = p[0] - origin[0], d1 = p[1] - origin[1], d2 = p[2] - origin[2];
  let out = -Infinity;
  for (let a = 0; a < 3; a++) {
    const l = axes[a][0] * d0 + axes[a][1] * d1 + axes[a][2] * d2;
    out = Math.max(out, lo[a] - l, l - hi[a]);
  }
  return out;
}

/**
 * volumeAt, or outside every volume the one `p` lies nearest (the first of `order` at that
 * distance), with `p` in its probe coordinates in `f` (sampleVolume clamps them to its probes).
 */
function volumeNear(order, p, f) {
  const inside = volumeAt(order, p, f);
  if (inside) return inside;
  let near = null, best = Infinity;
  for (const v of order) {
    const d = outside(v, p);
    if (d < best) { best = d; near = v; }
  }
  locate(near, p, f);
  return near;
}

/** sampleVolume's corner indices and weights, reused so that a sample allocates nothing. */
const SAMPLE_I0 = [0, 0, 0], SAMPLE_I1 = [0, 0, 0], SAMPLE_W = [0, 0, 0], SAMPLE_IJK = [0, 0, 0];

/**
 * The cube and sun visibility of `v` at probe coordinates `f`, trilinear between its probes
 * (clamped to the outermost ones): the cube into `cube` (18), the visibility returned. `scratch`
 * (18) takes each probe's cube.
 */
function sampleVolume(atlas, v, f, cube, scratch) {
  cube.fill(0);
  const i0 = SAMPLE_I0, i1 = SAMPLE_I1, w = SAMPLE_W, ijk = SAMPLE_IJK;
  for (let a = 0; a < 3; a++) {
    const x = Math.min(v.size[a] - 1, Math.max(0, f[a]));
    i0[a] = Math.floor(x);
    i1[a] = Math.min(v.size[a] - 1, i0[a] + 1);
    w[a] = x - i0[a];
  }
  let sun = 0;
  for (let c = 0; c < 8; c++) {
    let wt = 1;
    for (let a = 0; a < 3; a++) {
      const hi = (c >> a) & 1;
      wt *= hi ? w[a] : 1 - w[a];
      ijk[a] = hi ? i1[a] : i0[a];
    }
    if (wt === 0) continue;
    const q = atlas.cube(v, ijk[0], ijk[1], ijk[2], scratch);
    for (let n = 0; n < 18; n++) cube[n] += wt * q[n];
    sun += wt * atlas.sun(v, ijk[0], ijk[1], ijk[2]);
  }
  return sun;
}

/**
 * The grid's three terms from a cube (+X −X +Y −Y +Z −Z, RGB) into `out` (9): up = +Y, down = −Y,
 * side = the mean of ±X and ±Z, RGB each.
 */
function cubeTerms(cube, out) {
  for (let k = 0; k < 3; k++) {
    out[k] = cube[6 + k];
    out[3 + k] = cube[9 + k];
    out[6 + k] = (cube[k] + cube[3 + k] + cube[12 + k] + cube[15 + k]) / 4;
  }
}

/**
 * The light on surfaces from the volumes at full resolution, not the grid (shrink-map.mjs lights
 * geometry without a lightmap UV with it): `(p, n, sun, out) => out` for a surface point `p` with
 * unit normal `n` (glTF), read `offset` metres off it along `n`. The point takes volumeNear's
 * volume (the grid's choice, or outside every volume the nearest, clamped), trilinear between its
 * probes. The light is the ambient cube along `n` (Σ n_axis² · the face n points at) plus, when
 * `sun` is given (entities.mjs sunOf: `dir` towards the sun, linear `color`, `intensity`),
 * visibility · max(0, n·dir) · color · intensity, written into `out` (3). A sample allocates
 * nothing.
 */
export function probeSampler(volumes, atlas, offset) {
  if (!volumes.length) throw new Error('no probe volumes');
  const order = volumeOrder(volumes);
  const f = [0, 0, 0], q = [0, 0, 0];
  const cube = new Float32Array(18), scratch = new Float32Array(18);
  return (p, n, sun, out) => {
    for (let a = 0; a < 3; a++) q[a] = p[a] + n[a] * offset;
    const vis = sampleVolume(atlas, volumeNear(order, q, f), f, cube, scratch);
    out[0] = 0; out[1] = 0; out[2] = 0;
    for (let a = 0; a < 3; a++) {
      const w = n[a] * n[a];
      if (!w) continue;
      const face = 2 * a + (n[a] < 0 ? 1 : 0); // +X −X +Y −Y +Z −Z
      for (let k = 0; k < 3; k++) out[k] += w * cube[3 * face + k];
    }
    if (sun) {
      const lit = vis * Math.max(0, n[0] * sun.dir[0] + n[1] * sun.dir[1] + n[2] * sun.dir[2]) * sun.intensity;
      if (lit > 0) for (let k = 0; k < 3; k++) out[k] += lit * sun.color[k];
    }
    return out;
  };
}

/**
 * The triangles of `doc` facing up (normal glTF y ≥ 0.7 of its length), world space, 9 floats
 * each: where a player can stand. Pass the hull (the world's collision after the drop rule).
 * @returns {Float32Array}
 */
export function walkableTriangles(doc) {
  const out = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    // A mirroring transform flips the winding, and with it the normal.
    const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) + m[8] * (m[1] * m[6] - m[2] * m[5]);
    const sign = det < 0 ? -1 : 1;
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== Primitive.Mode.TRIANGLES) continue;
      const pos = prim.getAttribute('POSITION')?.getArray();
      if (!pos) continue;
      const idx = prim.getIndices()?.getArray();
      const count = idx ? idx.length : pos.length / 3;
      const world = (j) => {
        const x = pos[3 * j], y = pos[3 * j + 1], z = pos[3 * j + 2];
        return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
      };
      for (let t = 0; t + 2 < count; t += 3) {
        const a = world(idx ? idx[t] : t), b = world(idx ? idx[t + 1] : t + 1), c = world(idx ? idx[t + 2] : t + 2);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(n[0], n[1], n[2]);
        if (len === 0 || (sign * n[1]) / len < WALKABLE) continue;
        out.push(...a, ...b, ...c);
      }
    }
  }
  return Float32Array.from(out);
}

/**
 * The cells to sample: those whose centre lies from a walkable triangle up to `band` above it,
 * by column (each triangle marks the columns its footprint overlaps, from the cell centre at or
 * below its lowest point to the one at or above its highest point + band).
 */
function bandCells(floors, origin, size, step, band) {
  const [nx, ny, nz] = size;
  const keep = new Uint8Array(nx * ny * nz);
  const cellOf = (x, a) => Math.floor((x - origin[a]) / step + 0.5);
  for (let t = 0; t < floors.length; t += 9) {
    const lo = [0, 1, 2].map((a) => Math.min(floors[t + a], floors[t + 3 + a], floors[t + 6 + a]));
    const hi = [0, 1, 2].map((a) => Math.max(floors[t + a], floors[t + 3 + a], floors[t + 6 + a]));
    const x0 = cellOf(lo[0], 0), x1 = cellOf(hi[0], 0), z0 = cellOf(lo[2], 2), z1 = cellOf(hi[2], 2);
    const y0 = Math.floor((lo[1] - origin[1]) / step), y1 = Math.ceil((hi[1] + band - origin[1]) / step);
    if (x1 < 0 || x0 >= nx || y1 < 0 || y0 >= ny || z1 < 0 || z0 >= nz) continue;
    for (let z = Math.max(0, z0); z <= Math.min(nz - 1, z1); z++) {
      for (let y = Math.max(0, y0); y <= Math.min(ny - 1, y1); y++) {
        for (let x = Math.max(0, x0); x <= Math.min(nx - 1, x1); x++) keep[x + nx * (y + ny * z)] = 1;
      }
    }
  }
  return keep;
}

/** Copies every unset cell from the nearest set one (breadth first, 6-neighbour, in index order). */
function dilate(grid, set) {
  const [nx, ny, nz] = grid.size;
  const n = nx * ny * nz;
  const queue = new Int32Array(n);
  let tail = 0;
  for (let c = 0; c < n; c++) if (set[c]) queue[tail++] = c;
  for (let head = 0; head < tail; head++) {
    const c = queue[head];
    const x = c % nx, y = Math.floor(c / nx) % ny, z = Math.floor(c / (nx * ny));
    const near = [
      x > 0 ? c - 1 : -1, x < nx - 1 ? c + 1 : -1,
      y > 0 ? c - nx : -1, y < ny - 1 ? c + nx : -1,
      z > 0 ? c - nx * ny : -1, z < nz - 1 ? c + nx * ny : -1,
    ];
    for (const d of near) {
      if (d < 0 || set[d]) continue;
      set[d] = 1;
      grid.up.copyWithin(3 * d, 3 * c, 3 * c + 3);
      grid.down.copyWithin(3 * d, 3 * c, 3 * c + 3);
      grid.side.copyWithin(3 * d, 3 * c, 3 * c + 3);
      grid.sun[d] = grid.sun[c];
      queue[tail++] = d;
    }
  }
}

/**
 * The 8 cells around `p` (glTF metres) and their trilinear weights, clamped into the grid, into
 * `cells` (indices), `at` (x, y, z per cell) and `w`: the one way the grid is read.
 */
function corners(grid, p, cells, at, w) {
  const { origin, step, size } = grid;
  const i0 = [0, 0, 0], i1 = [0, 0, 0], t = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const f = Math.min(size[a] - 1, Math.max(0, (p[a] - origin[a]) / step));
    i0[a] = Math.floor(f);
    i1[a] = Math.min(size[a] - 1, i0[a] + 1);
    t[a] = f - i0[a];
  }
  for (let k = 0; k < 8; k++) {
    let wt = 1;
    for (let a = 0; a < 3; a++) {
      const hi = (k >> a) & 1;
      wt *= hi ? t[a] : 1 - t[a];
      at[3 * k + a] = hi ? i1[a] : i0[a];
    }
    w[k] = wt;
    cells[k] = at[3 * k] + size[0] * (at[3 * k + 1] + size[1] * at[3 * k + 2]);
  }
}

/**
 * Calls `visit(q)` at the points where players are lit: on every walkable triangle of `floors`,
 * the centroids of its m² sub-triangles (m = its longest edge / `spacing`, rounded up), each
 * `heights` above it.
 */
function forPlayerPoints(floors, spacing, heights, visit) {
  const q = [0, 0, 0];
  for (let t = 0; t < floors.length; t += 9) {
    const a = [floors[t], floors[t + 1], floors[t + 2]];
    const e1 = [floors[t + 3] - a[0], floors[t + 4] - a[1], floors[t + 5] - a[2]];
    const e2 = [floors[t + 6] - a[0], floors[t + 7] - a[1], floors[t + 8] - a[2]];
    const edge = Math.max(Math.hypot(...e1), Math.hypot(...e2), Math.hypot(e2[0] - e1[0], e2[1] - e1[1], e2[2] - e1[2]));
    const m = Math.max(1, Math.ceil(edge / spacing));
    for (let i = 0; i < m; i++) {
      for (let j = 0; i + j < m; j++) {
        // The upright sub-triangle at (i, j), then the inverted one beside it.
        for (let half = 0; half < (i + j < m - 1 ? 2 : 1); half++) {
          const u = (i + (half ? 2 : 1) / 3) / m, v = (j + (half ? 2 : 1) / 3) / m;
          for (const h of heights) {
            for (let k = 0; k < 3; k++) q[k] = a[k] + u * e1[k] + v * e2[k];
            q[1] += h;
            visit(q);
          }
        }
      }
    }
  }
}

/**
 * Solves (A + diag(lambda)) x = b from `x` by conjugate gradients, Jacobi-preconditioned by
 * `diagonal` (A's diagonal + lambda); `apply(x, out)` sets out = A x.
 */
function solve(apply, lambda, diagonal, b, x, tolerance, iterations) {
  const m = x.length;
  const r = new Float64Array(m), z = new Float64Array(m), d = new Float64Array(m), Ad = new Float64Array(m);
  apply(x, Ad);
  let rz = 0, rr = 0, bb = 0;
  for (let u = 0; u < m; u++) {
    r[u] = b[u] - Ad[u] - lambda[u] * x[u];
    z[u] = r[u] / diagonal[u];
    d[u] = z[u];
    rz += r[u] * z[u];
    rr += r[u] * r[u];
    bb += b[u] * b[u];
  }
  for (let it = 0; it < iterations && rr > tolerance * tolerance * bb; it++) {
    apply(d, Ad);
    let dAd = 0;
    for (let u = 0; u < m; u++) dAd += d[u] * (Ad[u] + lambda[u] * d[u]);
    if (!(dAd > 0)) break;
    const alpha = rz / dAd;
    let rz2 = 0;
    rr = 0;
    for (let u = 0; u < m; u++) {
      x[u] += alpha * d[u];
      r[u] -= alpha * (Ad[u] + lambda[u] * d[u]);
      z[u] = r[u] / diagonal[u];
      rz2 += r[u] * z[u];
      rr += r[u] * r[u];
    }
    const beta = rz2 / rz;
    rz = rz2;
    for (let u = 0; u < m; u++) d[u] = z[u] + beta * d[u];
  }
}

/**
 * Refits the cells around the players' points (forPlayerPoints) so that the grid, read the way
 * the viewer reads it (corners), matches each point's own light: that of the volume lighting the
 * point (volumeAt), not of the volumes the cells' centres fall in. Least squares over the points
 * with a pull of FIT.prior towards each cell's centre sample, for each of up, down and side (RGB)
 * and the sun. Each light term weighs each point by 1 / (own · read), the term's own brightness
 * there and the grid's (the mean of its RGB, both + FIT.dark): the first round reads its own, so
 * it is the relative error; later rounds reweight towards the error in stops, which treats a point
 * read too dark as badly as one read too bright. (One weight for all three terms, from their
 * mean, did as well on Mirage and worse on Nuke: held out, up over a stop at 133 points, not 119.)
 * The sun is unweighted. Marks the cells refitted in `sampled`; returns how many.
 */
function fitToPlayers(grid, order, atlas, floors, sampled) {
  const n = grid.sun.length;
  const [nx, ny] = grid.size;
  const index = new Int32Array(n).fill(-1);
  const cellOf = [];
  const cells = new Int32Array(8), at = new Int32Array(24), w = new Float64Array(8);
  forPlayerPoints(floors, FIT.spacing, FIT.heights, (q) => {
    corners(grid, q, cells, at, w);
    for (let k = 0; k < 8; k++) if (w[k] > 0 && index[cells[k]] < 0) { index[cells[k]] = cellOf.length; cellOf.push(cells[k]); }
  });
  const m = cellOf.length;
  // The channels solved: up, down and side R G B, each term its own weight set (0, 1, 2), then
  // the sun (weight set 3).
  const terms = [grid.up, grid.down, grid.side];
  const SUN = 9, SETS = 4;
  const channels = Array.from({ length: SUN + 1 }, (_, ch) => (ch < SUN
    ? { arr: terms[(ch / 3) | 0], stride: 3, off: ch % 3, s: (ch / 3) | 0 }
    : { arr: grid.sun, stride: 1, off: 0, s: 3 }));
  // Each cell's centre sample, which the fit is pulled towards in every round.
  const prior = channels.map(({ arr, stride, off }) => Float64Array.from(cellOf, (c) => arr[stride * c + off]));
  // The normal equations, one 27-point stencil per cell and weight set.
  const A = Array.from({ length: SETS }, () => new Float64Array(27 * m));
  const rhs = channels.map(() => new Float64Array(m));
  const pull = Array.from({ length: SETS }, () => new Float64Array(m)), touch = new Float64Array(m);
  const near = new Int32Array(27 * m).fill(-1);
  const f = [0, 0, 0], cube = new Float32Array(18), scratch = new Float32Array(18), b = new Float64Array(SUN + 1);
  const pw = new Float64Array(SETS).fill(1), own = new Float64Array(3), read = new Float64Array(3);
  for (let round = 0; round < FIT.rounds; round++) {
    for (const a of [...A, ...rhs, ...pull, touch]) a.fill(0);
    forPlayerPoints(floors, FIT.spacing, FIT.heights, (q) => {
      const v = volumeAt(order, q, f);
      if (!v) return;
      b[SUN] = sampleVolume(atlas, v, f, cube, scratch);
      cubeTerms(cube, b);
      corners(grid, q, cells, at, w);
      for (let t = 0; t < 3; t++) {
        own[t] = (b[3 * t] + b[3 * t + 1] + b[3 * t + 2]) / 3 + FIT.dark;
        read[t] = own[t];
        if (round === 0) continue;
        const arr = terms[t];
        read[t] = FIT.dark;
        for (let k = 0; k < 8; k++) {
          const c = 3 * cells[k];
          read[t] += (w[k] * (arr[c] + arr[c + 1] + arr[c + 2])) / 3;
        }
      }
      for (let t = 0; t < 3; t++) pw[t] = 1 / (own[t] * read[t]);
      for (let k = 0; k < 8; k++) {
        if (w[k] === 0) continue;
        const u = index[cells[k]];
        touch[u] += w[k];
        for (let s = 0; s < SETS; s++) pull[s][u] += pw[s] * w[k];
        for (let ch = 0; ch <= SUN; ch++) rhs[ch][u] += pw[channels[ch].s] * w[k] * b[ch];
        for (let l = 0; l < 8; l++) {
          if (w[l] === 0) continue;
          const o = at[3 * l] - at[3 * k] + 1 + 3 * (at[3 * l + 1] - at[3 * k + 1] + 1) + 9 * (at[3 * l + 2] - at[3 * k + 2] + 1);
          for (let s = 0; s < SETS; s++) A[s][27 * u + o] += pw[s] * w[k] * w[l];
        }
      }
    });
    if (round === 0) {
      // Every weight set has the same stencil: all its weights are above 0 (the sun's are 1).
      for (let u = 0; u < m; u++) {
        for (let o = 0; o < 27; o++) {
          if (A[3][27 * u + o] === 0) continue;
          near[27 * u + o] = index[cellOf[u] + (o % 3) - 1 + nx * ((((o / 3) | 0) % 3) - 1) + nx * ny * (((o / 9) | 0) - 1)];
        }
      }
    }
    // The sun's weights do not change between rounds: it is solved once.
    for (let ch = 0; ch < (round === 0 ? SUN + 1 : SUN); ch++) {
      const { arr, stride, off, s } = channels[ch];
      const S = A[s];
      const lambda = new Float64Array(m), diagonal = new Float64Array(m), x = new Float64Array(m), bb = new Float64Array(m);
      for (let u = 0; u < m; u++) {
        // The pull scales with the points' own weight at the cell, so it means the same everywhere.
        lambda[u] = touch[u] > 0 ? (FIT.prior * pull[s][u]) / touch[u] : 1;
        diagonal[u] = S[27 * u + 13] + lambda[u];
        x[u] = arr[stride * cellOf[u] + off];
        bb[u] = rhs[ch][u] + lambda[u] * prior[ch][u];
      }
      const apply = (y, out) => {
        for (let u = 0; u < m; u++) {
          let sum = 0;
          for (let o = 0; o < 27; o++) {
            const nb = near[27 * u + o];
            if (nb >= 0) sum += S[27 * u + o] * y[nb];
          }
          out[u] = sum;
        }
      };
      solve(apply, lambda, diagonal, bb, x, FIT.tolerance, FIT.iterations);
      for (let u = 0; u < m; u++) arr[stride * cellOf[u] + off] = ch < SUN ? Math.max(0, x[u]) : Math.min(1, Math.max(0, x[u]));
    }
  }
  let fitted = 0;
  for (let u = 0; u < m; u++) {
    if (touch[u] > 0) {
      sampled[cellOf[u]] = 1;
      fitted++;
    }
  }
  return fitted;
}

/**
 * The light grid of `volumes` (with their `atlas`): cells `step` metres apart over the union of
 * the volumes' world boxes clipped to `bounds` ({ min, max }, glTF metres; null: no clip, never
 * the world's bounds).
 * - Each cell's centre takes the volume containing it with the highest priority, then the
 *   smallest, trilinear between that volume's probes: `up` = +Y, `down` = −Y, `side` =
 *   mean(±X, ±Z), and the sun's visibility.
 * - With `floors` (walkableTriangles), only cells up to GRID_BAND above a walkable surface are
 *   sampled, and then the cells around the players' points are refitted to those points' own
 *   light (fitToPlayers).
 * - Every other cell copies the nearest sampled or refitted cell.
 * `probed` counts the cells sampled at their centre, `fitted` those refitted.
 * @returns {LightGrid & { probed: number, fitted: number }}
 */
export function buildLightGrid(volumes, atlas, bounds, step = GRID_STEP, floors = null) {
  if (!volumes.length) throw new Error('no probe volumes');
  if (!(step > 0)) throw new Error(`bad grid step ${step}`);
  const lo = [0, 1, 2].map((a) => Math.max(Math.min(...volumes.map((v) => v.min[a])), bounds ? bounds.min[a] : -Infinity));
  const hi = [0, 1, 2].map((a) => Math.min(Math.max(...volumes.map((v) => v.max[a])), bounds ? bounds.max[a] : Infinity));
  if (!lo.every((l, a) => hi[a] > l)) throw new Error(`the probe volumes do not overlap the bounds ${JSON.stringify(bounds)}`);
  const size = lo.map((l, a) => Math.max(1, Math.ceil((hi[a] - l) / step - 1e-6)));
  if (size.some((s) => s > MAX_SIZE)) throw new Error(`light grid ${size.join('×')} is over ${MAX_SIZE} cells on a side`);
  const origin = lo.map((l) => l + step / 2);
  const [nx, ny, nz] = size;
  const n = nx * ny * nz;
  const grid = {
    origin, step, size,
    up: new Float32Array(3 * n), down: new Float32Array(3 * n), side: new Float32Array(3 * n), sun: new Float32Array(n),
    probed: 0, fitted: 0,
  };
  const keep = floors ? bandCells(floors, origin, size, step, GRID_BAND) : null;
  const order = volumeOrder(volumes);
  const sampled = new Uint8Array(n);
  const cube = new Float32Array(18), scratch = new Float32Array(18), terms = new Float32Array(9);
  const p = [0, 0, 0], f = [0, 0, 0];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const c = x + nx * (y + ny * z);
        if (keep && !keep[c]) continue;
        p[0] = origin[0] + x * step; p[1] = origin[1] + y * step; p[2] = origin[2] + z * step;
        const v = volumeAt(order, p, f);
        if (!v) continue;
        grid.sun[c] = sampleVolume(atlas, v, f, cube, scratch);
        cubeTerms(cube, terms);
        grid.up.set(terms.subarray(0, 3), 3 * c);
        grid.down.set(terms.subarray(3, 6), 3 * c);
        grid.side.set(terms.subarray(6, 9), 3 * c);
        sampled[c] = 1;
        grid.probed++;
      }
    }
  }
  if (!grid.probed) throw new Error('no light grid cell lies in a probe volume');
  if (floors) {
    // Every cell a starting value for the fit (the cells it touches off the band included).
    dilate(grid, Uint8Array.from(sampled));
    grid.fitted = fitToPlayers(grid, order, atlas, floors, sampled);
  }
  dilate(grid, sampled);
  return grid;
}

/**
 * probes.bin version 2 (little-endian; tools/README.md "Light grid"): a 36-byte header ('DVLG',
 * u16 version 2, u16 0, f32 origin x y z, f32 step, u16 nx ny nz, u16 0, f32 range), then 10
 * bytes per cell at x + nx·(y + ny·z): up RGB, down RGB, side RGB as
 * round(sqrt(clamp(v / range, 0, 1))·255), and the sun's visibility as round(clamp(sun, 0, 1)·255)
 * (linear). No padding: both readers take the cells a byte at a time.
 * @param {LightGrid} grid
 * @param {number} range  the map's light range (light.json), as the lightmap's
 * @returns {Buffer}
 */
export function encodeLightGrid(grid, range) {
  if (!(range > 0)) throw new Error(`bad range ${range}`);
  const [nx, ny, nz] = grid.size;
  if (!grid.size.every((s) => Number.isInteger(s) && s >= 1 && s <= MAX_SIZE)) throw new Error(`bad grid size ${grid.size}`);
  if (!(grid.step > 0) || !grid.origin.every(Number.isFinite)) throw new Error(`bad grid origin ${grid.origin} or step ${grid.step}`);
  const n = nx * ny * nz;
  if (grid.up?.length !== 3 * n || grid.down?.length !== 3 * n || grid.side?.length !== 3 * n || grid.sun?.length !== n) throw new Error('grid arrays do not match its size');
  const cell = CELL[VERSION];
  const buf = Buffer.alloc(HEADER + cell * n);
  buf.write(MAGIC, 0, 'latin1');
  buf.writeUInt16LE(VERSION, 4);
  buf.writeUInt16LE(0, 6);
  grid.origin.forEach((o, a) => buf.writeFloatLE(o, 8 + 4 * a));
  buf.writeFloatLE(grid.step, 20);
  grid.size.forEach((s, a) => buf.writeUInt16LE(s, 24 + 2 * a));
  buf.writeUInt16LE(0, 30);
  buf.writeFloatLE(range, 32);
  const light = (v) => Math.round(Math.sqrt(Math.min(1, Math.max(0, v / range))) * 255);
  for (let c = 0; c < n; c++) {
    const o = HEADER + cell * c;
    for (let k = 0; k < 3; k++) {
      buf[o + k] = light(grid.up[3 * c + k]);
      buf[o + 3 + k] = light(grid.down[3 * c + k]);
      buf[o + 6 + k] = light(grid.side[3 * c + k]);
    }
    buf[o + 9] = Math.round(Math.min(1, Math.max(0, grid.sun[c])) * 255);
  }
  return buf;
}

/**
 * probes.bin back to a LightGrid (light = (byte / 255)² · range, sun = byte / 255), its range and
 * its version. Reads version 2 and version 1 (146d893–4ef350d: 8 bytes a cell, up and down RGB,
 * the sun, 0), whose side is the mean of its up and down, the light it gave a surface facing
 * sideways. Throws on a short buffer, a bad magic or another version, a header encode would not
 * write (a size below 1, a step or range not above 0, an origin not finite), or a length its
 * header does not say.
 * @param {Uint8Array | ArrayBuffer} bytes
 * @returns {LightGrid & { range: number, version: number }}
 */
export function decodeLightGrid(bytes) {
  const buf = ArrayBuffer.isView(bytes) ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : Buffer.from(bytes);
  if (buf.length < HEADER) throw new Error(`light grid of ${buf.length} bytes is shorter than its ${HEADER}-byte header`);
  if (buf.toString('latin1', 0, 4) !== MAGIC) throw new Error('not a light grid: bad magic');
  const version = buf.readUInt16LE(4);
  const cell = Object.hasOwn(CELL, version) ? CELL[version] : 0;
  if (!cell) throw new Error(`light grid version ${version}, not 1 or ${VERSION}`);
  const origin = [0, 1, 2].map((a) => buf.readFloatLE(8 + 4 * a));
  const step = buf.readFloatLE(20);
  const size = [0, 1, 2].map((a) => buf.readUInt16LE(24 + 2 * a));
  const range = buf.readFloatLE(32);
  if (!origin.every(Number.isFinite)) throw new Error(`light grid origin ${origin} is not finite`);
  if (!(step > 0)) throw new Error(`light grid step ${step} is not above 0`);
  if (!(range > 0)) throw new Error(`light grid range ${range} is not above 0`);
  if (size.some((s) => s < 1)) throw new Error(`light grid size ${size.join('×')} has no cells`);
  const n = size[0] * size[1] * size[2];
  if (buf.length !== HEADER + cell * n) throw new Error(`light grid length ${buf.length}, not ${HEADER + cell * n} for ${size.join('×')} cells of version ${version}`);
  const up = new Float32Array(3 * n), down = new Float32Array(3 * n), side = new Float32Array(3 * n), sun = new Float32Array(n);
  const light = (b) => (b / 255) ** 2 * range;
  for (let c = 0; c < n; c++) {
    const o = HEADER + cell * c;
    for (let k = 0; k < 3; k++) {
      const u = light(buf[o + k]), d = light(buf[o + 3 + k]);
      up[3 * c + k] = u;
      down[3 * c + k] = d;
      side[3 * c + k] = version === 1 ? (u + d) / 2 : light(buf[o + 6 + k]);
    }
    sun[c] = buf[o + (version === 1 ? 6 : 9)] / 255;
  }
  return { origin, step, size, range, version, up, down, side, sun };
}

/**
 * `grid` at `p` (glTF metres), trilinear between cell centres, clamped into the grid: `{ up, down,
 * side, sun }`. The viewer reads probes.bin the same way (web/src/scene/probes.ts
 * `sampleLightGrid`; web/test/tools-parity.test.ts holds the two together).
 */
export function sampleGrid(grid, p) {
  const cells = new Int32Array(8), at = new Int32Array(24), w = new Float64Array(8);
  corners(grid, p, cells, at, w);
  const up = [0, 0, 0], down = [0, 0, 0], side = [0, 0, 0];
  let sun = 0;
  for (let k = 0; k < 8; k++) {
    if (w[k] === 0) continue;
    const c = cells[k];
    for (let j = 0; j < 3; j++) {
      up[j] += w[k] * grid.up[3 * c + j];
      down[j] += w[k] * grid.down[3 * c + j];
      side[j] += w[k] * grid.side[3 * c + j];
    }
    sun += w[k] * grid.sun[c];
  }
  return { up, down, side, sun };
}

/**
 * The light on a surface at `p` with unit normal `n` (glTF), linear RGB:
 * up·max(n.y, 0)² + down·max(−n.y, 0)² + side·(1 − n.y²) from `grid` (trilinear, clamped), CS2's
 * ambient cube along n with its four sides averaged, plus, when `sun` is given (entities.mjs
 * sunOf: `dir` towards the sun in glTF, linear `color`, `intensity`),
 * visibility · max(0, n·dir) · color · intensity. The probes hold no sun (D6), so pass `sun`
 * wherever the sun is to be in the result, and null where something else adds it.
 * @returns {number[]}
 */
export function vertexLight(grid, p, n, sun) {
  const s = sampleGrid(grid, p);
  const y = n[1];
  const wUp = y > 0 ? y * y : 0, wDown = y < 0 ? y * y : 0, wSide = 1 - y * y;
  const out = [0, 1, 2].map((k) => s.up[k] * wUp + s.down[k] * wDown + s.side[k] * wSide);
  if (sun) {
    const lit = s.sun * Math.max(0, n[0] * sun.dir[0] + n[1] * sun.dir[1] + n[2] * sun.dir[2]) * sun.intensity;
    for (let k = 0; k < 3; k++) out[k] += lit * sun.color[k];
  }
  return out;
}
