// lib/probes.mjs: CS2's light probe volumes as the coarse light grid the viewer ships
// (probes.bin), and the per-vertex light it gives unlightmapped geometry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { DataTexture, FloatType, RGBAFormat } from 'three';
import { EXRExporter } from 'three/addons/exporters/EXRExporter.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UNIT, parseEntities } from '../lib/entities.mjs';
import {
  GRID_BAND,
  GRID_STEP,
  buildLightGrid,
  decodeLightGrid,
  encodeLightGrid,
  probeSampler,
  probeVolumes,
  readProbeAtlas,
  vertexLight,
  walkableTriangles,
} from '../lib/probes.mjs';

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'probes-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const vec = (v) => `[ ${v.map((x) => x.toFixed(6)).join(', ')} ]`;

/** One probe volume entity as VRF decompiles it (Source units, as in default_ents.vents). */
function volumeBlock({
  classname = 'env_combined_light_probe_volume', origin = [0, 0, 0], mins, maxs, size,
  atlas = [1, 1, 1], level = 0, angles = [0, 0, 0],
}) {
  return [
    `box_mins                       ${vec(mins)}`,
    `box_maxs                       ${vec(maxs)}`,
    'voxel_size                     "24.0"',
    `indoor_outdoor_level           ${level}`,
    `classname                      "${classname}"`,
    `origin                         ${vec(origin)}`,
    `angles                         ${vec(angles)}`,
    'scales                         [ 1.0, 1.0, 1.0 ]',
    ...['x', 'y', 'z'].map((a, i) => `light_probe_size_${a}             ${size[i]}`),
    ...['x', 'y', 'z'].map((a, i) => `light_probe_atlas_${a}            ${atlas[i]}`),
  ].join('\n');
}
const vents = (...blocks) => blocks.map((b, i) => `====${i}====\n${b}\n`).join('');

/**
 * A probe volume over the glTF box `min`..`max` (metres), placed by an unrotated entity at the
 * Source origin: glTF (x, y, z) = Source (y, z, x) · UNIT. `size` is in the volume's own
 * (Source) x, y, z order, as the entity has it.
 */
function boxVolume(min, max, { size = [1, 1, 1], level = 0 } = {}) {
  const src = (g) => [g[2] / UNIT, g[0] / UNIT, g[1] / UNIT];
  return probeVolumes(parseEntities(vents(volumeBlock({ mins: src(min), maxs: src(max), size, level }))))[0];
}

/** A cube of 18 values (+X −X +Y −Y +Z −Z, RGB) with every face `rgb`. */
const flat = (rgb) => Float32Array.from({ length: 18 }, (_, i) => rgb[i % 3]);

/** An atlas whose cube and sun come from functions of (volume, i, j, k). */
const fakeAtlas = (cube, sun = () => 1) => ({ cube, sun });

/** Cell `c` of a LightGrid as { up, down, side, sun }. */
const cell = (g, c) => ({
  up: Array.from(g.up.subarray(3 * c, 3 * c + 3)),
  down: Array.from(g.down.subarray(3 * c, 3 * c + 3)),
  side: Array.from(g.side.subarray(3 * c, 3 * c + 3)),
  sun: g.sun[c],
});

describe('probeVolumes', () => {
  it('maps the box (relative to origin) to glTF metres, with size, atlas and priority', () => {
    const vols = probeVolumes(parseEntities(vents(
      'classname                      "worldspawn"',
      volumeBlock({ origin: [100, 0, 0], mins: [-10, -20, -30], maxs: [10, 20, 30], size: [4, 4, 2], atlas: [21, 45, 41], level: 2 }),
    )));
    expect(vols).toHaveLength(1);
    const [v] = vols;
    // Source x 90..110, y −20..20, z −30..30 → glTF (y, z, x).
    [-20, -30, 90].forEach((m, i) => expect(v.min[i]).toBeCloseTo(m * UNIT, 9));
    [20, 30, 110].forEach((m, i) => expect(v.max[i]).toBeCloseTo(m * UNIT, 9));
    expect(v.size).toEqual([4, 4, 2]);
    expect(v.atlas).toEqual([21, 45, 41]);
    expect(v.priority).toBe(2);
  });

  it('counts env_light_probe_volume as well as env_combined_light_probe_volume', () => {
    const vols = probeVolumes(parseEntities(vents(
      volumeBlock({ mins: [-1, -1, -1], maxs: [1, 1, 1], size: [1, 1, 1] }),
      volumeBlock({ classname: 'env_light_probe_volume', mins: [-2, -2, -2], maxs: [2, 2, 2], size: [2, 2, 2], level: -1 }),
      volumeBlock({ classname: 'env_cubemap_box', mins: [-2, -2, -2], maxs: [2, 2, 2], size: [2, 2, 2] }),
    )));
    expect(vols.map((v) => v.priority)).toEqual([0, -1]);
  });

  it('turns a rotated volume by its angles (Source pitch, yaw, roll) about its origin', () => {
    // Yaw 90: the volume's x axis is Source +y, which is glTF +x.
    const [v] = probeVolumes(parseEntities(vents(
      volumeBlock({ origin: [0, 0, 0], mins: [0, -20, -20], maxs: [80, 20, 20], size: [4, 1, 1], angles: [0, 90, 0] }),
    )));
    [0, -20, -20].forEach((m, i) => expect(v.min[i]).toBeCloseTo(m * UNIT, 6));
    [80, 20, 20].forEach((m, i) => expect(v.max[i]).toBeCloseTo(m * UNIT, 6));
  });

  it('applies pitch and roll in the order of Source\'s AngleMatrix', () => {
    // AngleMatrix(pitch, yaw, roll): x = (cp·cy, cp·sy, −sp), y = (sr·sp·cy − cr·sy, …), z = (cr·sp·cy + sr·sy, …).
    // Pitch 90 then yaw 90: x → Source −z, y → Source −x, z → Source +y, so the box
    // x 0..80, y 0..40, z 0..20 spans Source x −40..0, y 0..20, z −80..0.
    const box = { mins: [0, 0, 0], maxs: [80, 40, 20], size: [4, 1, 1] };
    const [pitched] = probeVolumes(parseEntities(vents(volumeBlock({ ...box, angles: [90, 90, 0] }))));
    [0, -80, -40].forEach((m, i) => expect(pitched.min[i]).toBeCloseTo(m * UNIT, 6));
    [20, 0, 0].forEach((m, i) => expect(pitched.max[i]).toBeCloseTo(m * UNIT, 6));
    // Roll 90: y → Source +z, z → Source −y: Source x 0..80, y −20..0, z 0..40.
    const [rolled] = probeVolumes(parseEntities(vents(volumeBlock({ ...box, angles: [0, 0, 90] }))));
    [-20, 0, 0].forEach((m, i) => expect(rolled.min[i]).toBeCloseTo(m * UNIT, 6));
    [0, 40, 80].forEach((m, i) => expect(rolled.max[i]).toBeCloseTo(m * UNIT, 6));
    // The pitched volume's probe 0 is its top (glTF y −10 units), probe 3 its bottom.
    const g = buildLightGrid([pitched], fakeAtlas((v, i) => flat([i, 0, 0])), null, 20 * UNIT);
    expect(g.size).toEqual([1, 4, 2]);
    for (let c = 0; c < 8; c++) expect(cell(g, c).up[0]).toBeCloseTo(3 - (c % 4), 5);
  });

  it('reads vectors in the text form too ("a b c")', () => {
    const text = volumeBlock({ mins: [-10, -20, -30], maxs: [10, 20, 30], size: [4, 4, 2] })
      .replace(/^origin .*$/m, 'origin                         "100 0 0"');
    const [v] = probeVolumes(parseEntities(vents(text)));
    expect(v.min[2]).toBeCloseTo(90 * UNIT, 9);
  });

  it('rejects a volume with a missing or an empty box', () => {
    const missing = volumeBlock({ mins: [0, 0, 0], maxs: [1, 1, 1], size: [1, 1, 1] }).replace(/^box_mins .*\n/m, '');
    expect(() => probeVolumes(parseEntities(vents(missing)))).toThrow(/missing box_mins/);
    const empty = parseEntities(vents(volumeBlock({ mins: [0, 0, 0], maxs: [0, 1, 1], size: [1, 1, 1] })));
    expect(() => probeVolumes(empty)).toThrow(/empty box/);
  });
});

describe('readProbeAtlas', () => {
  // A W×H×6D atlas whose centre texel (1, 1) of slice z holds RGB (z, z + 100, z + 200), its
  // texel (1, 0) on the top row (the file's first line) z + 300, … and (1, 2) on the bottom row
  // z + 600, …, every other texel −1; and a _dlshd whose centre texel of slice k holds `shadow[k]`
  // in r, its top-row texel (1, 0) 255 and bottom-row (1, 2) 0.
  const W = 3, H = 3, D = 2, SHADOW = [0, 255];
  async function writeExr(file, rows, width = W) {
    // EXRExporter writes a DataTexture bottom row first (GL order): flip so `rows[0]` is the top.
    const data = new Float32Array(width * rows.length * 4);
    rows.forEach((row, y) => data.set(row, 4 * width * (rows.length - 1 - y)));
    const exr = await new EXRExporter().parse(new DataTexture(data, width, rows.length, RGBAFormat, FloatType), { type: FloatType, compression: 0 });
    fs.writeFileSync(file, exr);
  }
  async function writeAtlas(dir, slices = 6 * D) {
    for (let z = 0; z < slices; z++) {
      const row = (mid) => [-1, -1, -1, 1, ...mid, 1, -1, -1, -1, 1];
      await writeExr(path.join(dir, `env_light_probe_volume_atlas_z${String(z).padStart(3, '0')}.exr`), [
        row([z + 300, z + 400, z + 500]), row([z, z + 100, z + 200]), row([z + 600, z + 700, z + 800]),
      ]);
    }
    for (let k = 0; k < D; k++) {
      const px = Buffer.alloc(W * H * 4, 128);
      px[4 * (0 * W + 1)] = 255;
      px[4 * (1 * W + 1)] = SHADOW[k];
      px[4 * (2 * W + 1)] = 0;
      await sharp(px, { raw: { width: W, height: H, channels: 4 } }).png()
        .toFile(path.join(dir, `env_light_probe_volume_atlas_dlshd_z${String(k).padStart(3, '0')}.png`));
    }
  }
  const vol = { atlas: [1, 1, 0], size: [1, 1, 2] };

  it('returns the six faces in glTF order (+X −X +Y −Y +Z −Z) from the Source-ordered z blocks', async () => {
    await writeAtlas(root);
    const atlas = await readProbeAtlas(root, [vol]);
    // Face f of probe k is slice f·D + k; Source order +x +y +z −x −y −z, and glTF +X = Source +y,
    // +Y = Source +z, +Z = Source +x.
    const sourceFace = [1, 4, 2, 5, 0, 3];
    for (const k of [0, 1]) {
      const cube = atlas.cube(vol, 0, 0, k);
      expect(cube).toBeInstanceOf(Float32Array);
      expect(cube).toHaveLength(18);
      const z = sourceFace.map((f) => f * D + k);
      expect(Array.from(cube)).toEqual(z.flatMap((s) => [s, s + 100, s + 200]));
    }
  });

  it('reads sun visibility as 1 − the _dlshd shadow (r, 1 = shadowed)', async () => {
    await writeAtlas(root);
    const atlas = await readProbeAtlas(root, [vol]);
    expect(atlas.sun(vol, 0, 0, 0)).toBe(1);
    expect(atlas.sun(vol, 0, 0, 1)).toBe(0);
  });

  it('rejects an atlas that is not 6 slices per _dlshd slice', async () => {
    await writeAtlas(root, 6 * D - 1);
    await expect(readProbeAtlas(root, [vol])).rejects.toThrow(/6 ×/);
  });

  it('rejects a volume that does not fit in the atlas', async () => {
    await writeAtlas(root);
    await expect(readProbeAtlas(root, [{ atlas: [1, 1, 1], size: [1, 1, 2] }])).rejects.toThrow(/outside the atlas/);
  });

  it('rejects slices of different sizes', async () => {
    await writeAtlas(root);
    await writeExr(path.join(root, 'env_light_probe_volume_atlas_z003.exr'), [[0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0, 1, 0, 0, 0, 1]], 2);
    await expect(readProbeAtlas(root, [vol])).rejects.toThrow(/2×3, not 3×3/);
  });

  it('reads the EXR and PNG slices the same way up: atlas y 0 is the top row of both', async () => {
    await writeAtlas(root);
    const top = { atlas: [1, 0, 0], size: [1, 1, 2] }, bottom = { atlas: [1, 2, 0], size: [1, 1, 2] };
    const atlas = await readProbeAtlas(root, [top, bottom]);
    expect(Array.from(atlas.cube(top, 0, 0, 0)).slice(0, 3)).toEqual([2 + 300, 2 + 400, 2 + 500]); // +X = Source +y, slice 1·D
    expect(Array.from(atlas.cube(bottom, 0, 0, 0)).slice(0, 3)).toEqual([2 + 600, 2 + 700, 2 + 800]);
    expect(atlas.sun(top, 0, 0, 0)).toBe(0);
    expect(atlas.sun(bottom, 0, 0, 0)).toBe(1);
  });

  it('reads a rotated volume\'s faces in world axes: cube() ignores its frame', async () => {
    await writeAtlas(root);
    const [turned] = probeVolumes(parseEntities(vents(
      volumeBlock({ mins: [0, 0, 0], maxs: [24, 24, 48], size: [1, 1, 2], atlas: [1, 1, 0], angles: [0, 90, 0] }),
    )));
    const atlas = await readProbeAtlas(root, [vol, turned]);
    expect(Array.from(atlas.cube(turned, 0, 0, 1))).toEqual(Array.from(atlas.cube(vol, 0, 0, 1)));
  });
});

describe('buildLightGrid', () => {
  const RED = [1, 0, 0], BLUE = [0, 0, 1];

  it('fills cells outside every volume from the nearest covered cell', () => {
    // A covers cells 0–1 of the row; B sits off the row (y 5..6), so the union's box spans x 0..4
    // but, clipped to the bounds, cells 2–3 lie in no volume.
    const A = boxVolume([0, 0, 0], [2, 1, 1]);
    const B = boxVolume([2, 5, 0], [4, 6, 1]);
    const atlas = fakeAtlas((v) => flat(v === A ? RED : BLUE));
    const g = buildLightGrid([A, B], atlas, { min: [0, 0, 0], max: [4, 1, 1] }, 1);
    expect(g.size).toEqual([4, 1, 1]);
    expect(g.step).toBe(1);
    g.origin.forEach((o) => expect(o).toBeCloseTo(0.5, 9));
    expect(cell(g, 0).up).toEqual(RED);
    expect(cell(g, 1).up).toEqual(RED);
    expect(cell(g, 2)).toEqual(cell(g, 1));
    expect(cell(g, 3)).toEqual(cell(g, 1));
    expect(g.probed).toBe(2);
  });

  it('samples probes at their texel centres along the volume axes (Source x = glTF z)', () => {
    // 4 probes along Source x over glTF z 0..4: probe i sits at z = i + 0.5, a cell centre.
    const V = boxVolume([0, 0, 0], [1, 1, 4], { size: [4, 1, 1] });
    const g = buildLightGrid([V], fakeAtlas((v, i) => flat([i, 0, 0])), null, 1);
    expect(g.size).toEqual([1, 1, 4]);
    [0, 1, 2, 3].forEach((i) => expect(cell(g, i).up[0]).toBeCloseTo(i, 6));
  });

  it('places a rotated volume\'s probes by its angles', () => {
    // Yaw 90: probe i (along the volume's x) runs along glTF +x.
    const [V] = probeVolumes(parseEntities(vents(
      volumeBlock({ mins: [0, -20, -20], maxs: [80, 20, 20], size: [4, 1, 1], angles: [0, 90, 0] }),
    )));
    const g = buildLightGrid([V], fakeAtlas((v, i) => flat([i, 0, 0])), null, 20 * UNIT);
    expect(g.size).toEqual([4, 2, 2]);
    for (let c = 0; c < 16; c++) expect(cell(g, c).up[0]).toBeCloseTo(c % 4, 5);
  });

  it('takes up, down and side from the cube: +Y, −Y and the mean of the four sides', () => {
    const V = boxVolume([0, 0, 0], [1, 1, 1]);
    // +X −X +Y −Y +Z −Z
    const cube = Float32Array.from([1, 1, 1, 3, 3, 3, 9, 9, 9, 1, 1, 1, 2, 2, 2, 6, 6, 6]);
    const g = buildLightGrid([V], fakeAtlas(() => cube, () => 0.25), null, 1);
    expect(cell(g, 0)).toEqual({ up: [9, 9, 9], down: [1, 1, 1], side: [3, 3, 3], sun: 0.25 });
  });

  it('gives a cell the volume of highest priority containing it, then the smallest', () => {
    const outer = boxVolume([0, 0, 0], [4, 1, 1]);
    const inner = boxVolume([1, 0, 0], [2, 1, 1]);
    const lower = boxVolume([2, 0, 0], [3, 1, 1], { level: -1 });
    const value = new Map([[outer, RED], [inner, BLUE], [lower, [0, 1, 0]]]);
    const g = buildLightGrid([outer, inner, lower], fakeAtlas((v) => flat(value.get(v))), null, 1);
    expect([0, 1, 2, 3].map((c) => cell(g, c).up)).toEqual([RED, BLUE, RED, RED]);
    const higher = boxVolume([0, 0, 0], [4, 1, 1], { level: 1 });
    value.set(higher, [1, 1, 1]);
    const h = buildLightGrid([inner, higher], fakeAtlas((v) => flat(value.get(v))), null, 1);
    expect(cell(h, 1).up).toEqual([1, 1, 1]);
  });

  it('samples only cells up to the band above a walkable surface; the rest copy the nearest', () => {
    // 10 probes up glTF y (Source z); a floor at y = 0 keeps the cells centred at 0.5, 1.5, 2.5.
    const V = boxVolume([0, 0, 0], [1, 10, 1], { size: [1, 1, 10] });
    const floor = Float32Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0]);
    const g = buildLightGrid([V], fakeAtlas((v, i, j, k) => flat([k + 1, 0, 0])), null, 1, floor);
    expect(g.size).toEqual([1, 10, 1]);
    expect(GRID_BAND).toBe(2.5);
    const ys = Array.from({ length: 10 }, (_, c) => cell(g, c).up[0]);
    ys.slice(0, 3).forEach((y, c) => expect(y).toBeCloseTo(c + 1, 6));
    ys.slice(3).forEach((y) => expect(y).toBeCloseTo(3, 6));
    expect(g.probed).toBe(3);
  });

  it('clips the grid to the bounds and steps 2.5 m by default', () => {
    expect(GRID_STEP).toBe(2.5);
    const V = boxVolume([-100, 0, 0], [100, 5, 5]);
    const g = buildLightGrid([V], fakeAtlas(() => flat(RED)), { min: [0, 0, 0], max: [10, 5, 5] });
    expect(g.step).toBe(2.5);
    expect(g.size).toEqual([4, 2, 2]);
    g.origin.forEach((o) => expect(o).toBeCloseTo(1.25, 9));
  });
});

describe('buildLightGrid: the fit to the players\' points', () => {
  // An outdoor volume (priority 0, light 4) with an indoor one inside it (priority 1, light 0.1)
  // from x = 0 to 6.25, over a floor at y = 0: the cells straddling the indoor volume's border mix
  // the two when only their centres are sampled.
  const W = boxVolume([-10, 0, -5], [10, 5, 5]);
  const V = boxVolume([0, 0, -5], [6.25, 5, 5], { level: 1 });
  const atlas = fakeAtlas((v) => flat(v === V ? [0.1, 0.1, 0.1] : [4, 4, 4]), (v) => (v === V ? 0 : 1));
  const floor = Float32Array.from([-10, 0, -5, -10, 0, 5, 10, 0, 5, -10, 0, -5, 10, 0, 5, 10, 0, -5]);
  const own = (x) => (x >= 0 && x <= 6.25 ? 0.1 : 4);
  /**
   * The mean |log2(grid / own light)| over points 0.5–1.5 m above the floor, of the light on a
   * surface facing `normal` (up by default) against `ownLight(x)`.
   */
  function stops(g, normal = [0, 1, 0], ownLight = own) {
    let sum = 0, n = 0;
    for (let x = -9.75; x <= 9.75; x += 0.5) {
      for (const h of [0.5, 1, 1.5]) {
        for (const z of [-4.5, -1.7, 0.3, 2.9]) {
          sum += Math.abs(Math.log2(vertexLight(g, [x, h, z], normal, null)[0] / ownLight(x)));
          n++;
        }
      }
    }
    return sum / n;
  }

  it('reads the light of the volume each player point is in more closely than centre samples do', () => {
    const centres = buildLightGrid([W, V], atlas, null, 2.5);
    const fitted = buildLightGrid([W, V], atlas, null, 2.5, floor);
    expect(fitted.fitted).toBeGreaterThan(0);
    expect(fitted.probed).toBe(centres.probed);
    expect(stops(fitted)).toBeLessThan(0.8 * stops(centres));
    // Inside the indoor volume by its border: centre samples read 1.27, 3.7 stops over.
    const inside = (g) => Math.abs(Math.log2(vertexLight(g, [0.5, 1, 0.3], [0, 1, 0], null)[0] / 0.1));
    expect(inside(centres)).toBeGreaterThan(3);
    expect(inside(fitted)).toBeLessThan(2);
    // Away from the border both are right.
    for (const x of [-7, 3]) expect(Math.abs(Math.log2(vertexLight(fitted, [x, 1, 0.3], [0, 1, 0], null)[0] / own(x)))).toBeLessThan(0.2);
  });

  it('fits the side term to each point\'s own four sides too, and up and down to its own ±Y', () => {
    // Faces +X −X +Y −Y +Z −Z: indoors dim with brighter sides (mean 0.2), outdoors bright from
    // above (4), sides 2.5 on average, 1 from below.
    const cubes = new Map([
      [V, Float32Array.from([0.3, 0.3, 0.3, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.05, 0.05, 0.05, 0.25, 0.25, 0.25, 0.15, 0.15, 0.15])],
      [W, Float32Array.from([3, 3, 3, 2, 2, 2, 4, 4, 4, 1, 1, 1, 2.5, 2.5, 2.5, 2.5, 2.5, 2.5])],
    ]);
    const sided = fakeAtlas((v) => cubes.get(v), (v) => (v === V ? 0 : 1));
    const centres = buildLightGrid([W, V], sided, null, 2.5);
    const fitted = buildLightGrid([W, V], sided, null, 2.5, floor);
    const indoor = (x) => x >= 0 && x <= 6.25;
    const ownSide = (x) => (indoor(x) ? 0.2 : 2.5);
    const ownDown = (x) => (indoor(x) ? 0.05 : 1);
    // Away from the border, each face reads its own term exactly.
    for (const g of [centres, fitted]) {
      const far = (n, ownLight) => Math.abs(Math.log2(vertexLight(g, [-7, 1, 0.3], n, null)[0] / ownLight(-7)));
      expect(far([1, 0, 0], ownSide)).toBeLessThan(0.2);
      expect(far([0, 0, -1], ownSide)).toBeLessThan(0.2);
      expect(far([0, -1, 0], ownDown)).toBeLessThan(0.2);
    }
    expect(Math.abs(Math.log2(vertexLight(fitted, [3, 1, 0.3], [1, 0, 0], null)[0] / 0.2))).toBeLessThan(0.2);
    // At the border, the fit follows each point's own sides and its own −Y (side 0.48 → 0.40
    // stops on average, down 0.59 → 0.49; side 0.5 m inside the indoor box 2.15 → 1.29).
    expect(stops(fitted, [1, 0, 0], ownSide)).toBeLessThan(0.9 * stops(centres, [1, 0, 0], ownSide));
    expect(stops(fitted, [0, -1, 0], ownDown)).toBeLessThan(0.9 * stops(centres, [0, -1, 0], ownDown));
    const inside = (g) => Math.abs(Math.log2(vertexLight(g, [0.5, 1, 0.3], [0, 0, 1], null)[0] / 0.2));
    expect(inside(fitted)).toBeLessThan(inside(centres) - 0.5);
  });

  it('is deterministic', () => {
    const a = encodeLightGrid(buildLightGrid([W, V], atlas, null, 2.5, floor), 8);
    const b = encodeLightGrid(buildLightGrid([W, V], atlas, null, 2.5, floor), 8);
    expect(a.equals(b)).toBe(true);
  });
});

describe('walkableTriangles', () => {
  it('keeps the triangles facing up (normal y ≥ 0.7), in world space', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from([
        0, 0, 0, 0, 0, 1, 1, 0, 0, // floor, facing +y
        0, 0, 0, 1, 0, 0, 0, 0, 1, // ceiling, facing −y
        0, 0, 0, 0, 1, 0, 0, 0, 1, // wall, facing +x
      ])))
      .setIndices(acc('SCALAR', Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8])));
    doc.createScene().addChild(doc.createNode().setMesh(doc.createMesh().addPrimitive(prim)).setTranslation([0, 2, 0]));
    expect(Array.from(walkableTriangles(doc))).toEqual([0, 2, 0, 0, 2, 1, 1, 2, 0]);
  });

  it('keeps a floor mirrored across x (its winding reversed) and drops one mirrored upside down', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const acc = (type, arr) => doc.createAccessor().setType(type).setArray(arr).setBuffer(buffer);
    const floor = () => doc.createMesh().addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', acc('VEC3', Float32Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0]))));
    const scene = doc.createScene();
    scene.addChild(doc.createNode().setMesh(floor()).setScale([-1, 1, 1]));
    scene.addChild(doc.createNode().setMesh(floor()).setScale([1, -1, 1]).setTranslation([0, 5, 0]));
    expect(Array.from(walkableTriangles(doc))).toEqual([0, 0, 0, 0, 0, 1, -1, 0, 0]);
  });
});

describe('encodeLightGrid / decodeLightGrid', () => {
  const grid = {
    origin: [1.5, -2.25, 3], step: 2.5, size: [2, 1, 1],
    up: Float32Array.from([0.4, 1, 8, 7.9, 0.5, 2]),
    down: Float32Array.from([2, 3.3, 5, 0.41, 6, 4]),
    side: Float32Array.from([1.2, 0.9, 3, 6.5, 0.45, 8]),
    sun: Float32Array.from([1, 0.5]),
  };

  it('writes the 36-byte header and 10 bytes per cell: up, down, side, sun', () => {
    const buf = encodeLightGrid(grid, 8);
    expect(buf.length).toBe(36 + 2 * 10);
    expect(buf.toString('latin1', 0, 4)).toBe('DVLG');
    expect(buf.readUInt16LE(4)).toBe(2);
    expect(buf.readUInt16LE(6)).toBe(0);
    expect([buf.readFloatLE(8), buf.readFloatLE(12), buf.readFloatLE(16)]).toEqual([1.5, -2.25, 3]);
    expect(buf.readFloatLE(20)).toBe(2.5);
    expect([buf.readUInt16LE(24), buf.readUInt16LE(26), buf.readUInt16LE(28)]).toEqual([2, 1, 1]);
    expect(buf.readUInt16LE(30)).toBe(0);
    expect(buf.readFloatLE(32)).toBe(8);
    // Light is sqrt(v / range); the sun byte is linear visibility.
    const light = (v) => Math.round(Math.sqrt(v / 8) * 255);
    expect([...buf.subarray(36, 46)]).toEqual([light(0.4), light(1), 255, light(2), light(3.3), light(5), light(1.2), light(0.9), light(3), 255]);
    expect([...buf.subarray(46, 56)]).toEqual([light(7.9), light(0.5), light(2), light(0.41), light(6), light(4), light(6.5), light(0.45), 255, 128]);
  });

  it('round-trips the header exactly and light within 2 % from 0.05 · range up', () => {
    const back = decodeLightGrid(encodeLightGrid(grid, 8));
    expect(back.origin).toEqual(grid.origin);
    expect(back.step).toBe(2.5);
    expect(back.size).toEqual([2, 1, 1]);
    expect(back.range).toBe(8);
    expect(back.version).toBe(2);
    for (const k of ['up', 'down', 'side']) {
      grid[k].forEach((v, i) => expect(Math.abs(back[k][i] - v) / v).toBeLessThan(0.02));
    }
    expect(back.sun[0]).toBe(1);
    expect(back.sun[1]).toBeCloseTo(0.5, 2);
  });

  it('clamps light above the range', () => {
    const back = decodeLightGrid(encodeLightGrid({ ...grid, up: Float32Array.from([20, 0, 0, 0, 0, 0]), side: Float32Array.from([0, 0, 0, 0, 0, 9]) }, 8));
    expect(back.up[0]).toBe(8);
    expect(back.side[5]).toBe(8);
  });

  it('rejects a grid whose arrays do not match its size', () => {
    expect(() => encodeLightGrid({ ...grid, side: new Float32Array(3) }, 8)).toThrow(/arrays/);
    const { side, ...noSide } = grid;
    expect(side).toBeDefined();
    expect(() => encodeLightGrid(noSide, 8)).toThrow(/arrays/);
  });

  it('rejects a bad magic, version or length', () => {
    const buf = encodeLightGrid(grid, 8);
    const magic = Buffer.from(buf); magic.write('XXXX', 0, 'latin1');
    expect(() => decodeLightGrid(magic)).toThrow(/magic/);
    for (const v of [0, 3]) {
      const version = Buffer.from(buf); version.writeUInt16LE(v, 4);
      expect(() => decodeLightGrid(version)).toThrow(new RegExp(`version ${v}, not 1 or 2`));
    }
    expect(() => decodeLightGrid(buf.subarray(0, buf.length - 1))).toThrow(/length/);
    // Version 2's cells under version 1's header: 10 bytes a cell are not 8.
    const asOne = Buffer.from(buf); asOne.writeUInt16LE(1, 4);
    expect(() => decodeLightGrid(asOne)).toThrow(/length 56, not 52/);
  });

  it('reads version 1 (8 bytes a cell: up, down, sun, 0) with its side the mean of its up and down', () => {
    // As 146d893–4ef350d wrote it: a stale asset set still reads.
    const one = Buffer.alloc(36 + 2 * 8);
    const fresh = encodeLightGrid(grid, 8);
    fresh.copy(one, 0, 0, 36);
    one.writeUInt16LE(1, 4);
    [[255, 64, 0, 128, 64, 32, 255, 0], [10, 20, 30, 40, 50, 60, 51, 0]].forEach((c, i) => Buffer.from(c).copy(one, 36 + 8 * i));
    const back = decodeLightGrid(one);
    expect(back.version).toBe(1);
    expect(back.size).toEqual([2, 1, 1]);
    const light = (b) => (b / 255) ** 2 * 8;
    expect(Array.from(back.up)).toEqual([255, 64, 0, 10, 20, 30].map(light).map(Math.fround));
    expect(Array.from(back.down)).toEqual([128, 64, 32, 40, 50, 60].map(light).map(Math.fround));
    [[255, 128], [64, 64], [0, 32], [10, 40], [20, 50], [30, 60]].forEach(([u, d], i) => expect(back.side[i]).toBeCloseTo((light(u) + light(d)) / 2, 6));
    expect(back.sun[0]).toBe(1);
    expect(back.sun[1]).toBeCloseTo(0.2, 6);
  });

  it('rejects a buffer shorter than the header, and a header encode would not write', () => {
    const buf = encodeLightGrid(grid, 8);
    expect(() => decodeLightGrid(buf.subarray(0, 20))).toThrow(/20 bytes is shorter than its 36-byte header/);
    const edit = (f) => { const b = Buffer.from(buf); f(b); return b; };
    expect(() => decodeLightGrid(edit((b) => b.writeUInt16LE(0, 26)))).toThrow(/no cells/);
    expect(() => decodeLightGrid(edit((b) => b.writeFloatLE(0, 20)))).toThrow(/step 0/);
    expect(() => decodeLightGrid(edit((b) => b.writeFloatLE(-1, 32)))).toThrow(/range -1/);
    expect(() => decodeLightGrid(edit((b) => b.writeFloatLE(NaN, 12)))).toThrow(/origin/);
    expect(() => encodeLightGrid({ ...grid, step: 0 }, 8)).toThrow(/step/);
  });
});

describe('vertexLight', () => {
  const one = {
    origin: [0, 0, 0], step: 1, size: [1, 1, 1],
    up: Float32Array.from([1, 2, 3]), down: Float32Array.from([0.1, 0.2, 0.3]), side: Float32Array.from([0.4, 0.8, 2]),
    sun: Float32Array.from([1]),
  };
  const close = (a, b) => b.forEach((x, i) => expect(a[i]).toBeCloseTo(x, 6));

  it('is up facing up, down facing down and side facing sideways, without a sun', () => {
    close(vertexLight(one, [0, 0, 0], [0, 1, 0], null), [1, 2, 3]);
    close(vertexLight(one, [0, 0, 0], [0, -1, 0], null), [0.1, 0.2, 0.3]);
    for (const n of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.6, 0, -0.8]]) close(vertexLight(one, [0, 0, 0], n, null), [0.4, 0.8, 2]);
  });

  it('weighs them as CS2 weighs its cube faces: by the square of the normal along each', () => {
    // up · max(n.y, 0)² + down · max(−n.y, 0)² + side · (1 − n.y²)
    close(vertexLight(one, [0, 0, 0], [0.6, 0.8, 0], null), [0.64 * 1 + 0.36 * 0.4, 0.64 * 2 + 0.36 * 0.8, 0.64 * 3 + 0.36 * 2]);
    close(vertexLight(one, [0, 0, 0], [0, -0.6, 0.8], null), [0.36 * 0.1 + 0.64 * 0.4, 0.36 * 0.2 + 0.64 * 0.8, 0.36 * 0.3 + 0.64 * 2]);
  });

  it('adds the sun\'s colour · intensity, times visibility and N·L', () => {
    const sun = { dir: [0.6, 0.8, 0], color: [1, 0.5, 0.25], intensity: 2 };
    const base = vertexLight(one, [0, 0, 0], sun.dir, null);
    close(vertexLight(one, [0, 0, 0], sun.dir, sun), base.map((b, i) => b + sun.color[i] * 2));
    close(vertexLight(one, [0, 0, 0], [-0.6, -0.8, 0], sun), vertexLight(one, [0, 0, 0], [-0.6, -0.8, 0], null));
    const shadowed = { ...one, sun: Float32Array.from([0]) };
    close(vertexLight(shadowed, [0, 0, 0], sun.dir, sun), base);
  });

  it('interpolates between cells and clamps beyond the grid', () => {
    const two = {
      origin: [0, 0, 0], step: 2, size: [2, 1, 1],
      up: Float32Array.from([0, 0, 0, 4, 4, 4]), down: Float32Array.from([0, 0, 0, 4, 4, 4]), side: Float32Array.from([0, 0, 0, 2, 2, 2]),
      sun: Float32Array.from([1, 1]),
    };
    close(vertexLight(two, [1, 0, 0], [0, 1, 0], null), [2, 2, 2]);
    close(vertexLight(two, [9, 5, -5], [0, 1, 0], null), [4, 4, 4]);
    close(vertexLight(two, [-9, 0, 0], [0, 1, 0], null), [0, 0, 0]);
    close(vertexLight(two, [1, 0, 0], [0, 0, 1], null), [1, 1, 1]);
  });
});

/** A ProbeVolume (lib/probes.mjs) along the glTF axes over `lo`..`hi` with `size` probes. */
const volume = (lo, hi, size, { priority = 0, atlas = [0, 0, 0] } = {}) => ({
  min: lo, max: hi, size, atlas, priority,
  volume: (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]),
  frame: { origin: [0, 0, 0], axes: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], lo, hi },
});

/**
 * A ProbeAtlas whose probe (i, j, k) of volume v has every face `light(v, i, j, k)` times the
 * face's own colour (+X red, −X green, +Y blue, −Y white, +Z (1, 1, 0), −Z (0, 1, 1)), and sun
 * visibility `sun(v, i, j, k)`.
 */
const FACE = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1], [1, 1, 0], [0, 1, 1]];
function atlasOf(light = () => 1, sun = () => 1) {
  return {
    cube(v, i, j, k) {
      const s = light(v, i, j, k);
      return Float32Array.from(FACE.flatMap((c) => c.map((x) => x * s)));
    },
    sun,
  };
}

describe('probeSampler (geometry: the volumes at full resolution)', () => {
  const box = volume([0, 0, 0], [2, 2, 2], [2, 2, 2]);
  it('gives the ambient cube along the normal: Σ n_axis² · the face n points at', () => {
    const at = probeSampler([box], atlasOf(), 0);
    expect(at([1, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 1]);
    expect(at([1, 1, 1], [-1, 0, 0], null, [0, 0, 0])).toEqual([0, 1, 0]);
    const [r, g, b] = at([1, 1, 1], [0.6, -0.8, 0], null, [0, 0, 0]);
    expect([r, g, b].map((x) => +x.toFixed(6))).toEqual([1, 0.64, 0.64]); // 0.36·red + 0.64·white
  });
  it('writes into `out` and hands the atlas one scratch cube for every probe it reads', () => {
    const seen = new Set();
    const atlas = { cube: (v, i, j, k, out) => { seen.add(out); out.fill(1); return out; }, sun: () => 1 };
    const at = probeSampler([box], atlas, 0);
    const out = [9, 9, 9];
    expect(at([1, 1, 1], [0, 1, 0], null, out)).toBe(out);
    expect(out).toEqual([1, 1, 1]);
    at([0.7, 1.2, 1], [1, 0, 0], null, out);
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBeInstanceOf(Float32Array);
  });
  it('samples `offset` metres off the surface along the normal, trilinear between probes at texel centres', () => {
    // Probes at x = 0.5 (light 1) and 1.5 (light 3): x = 0.9 + 0.1 lands halfway.
    const at = probeSampler([box], atlasOf((v, i) => (i === 0 ? 1 : 3)), 0.1);
    expect(at([0.9, 1, 1], [1, 0, 0], null, [0, 0, 0]).map((x) => +x.toFixed(6))).toEqual([2, 0, 0]);
    expect(probeSampler([box], atlasOf((v, i) => (i === 0 ? 1 : 3)), 0)([0.9, 1, 1], [1, 0, 0], null, [0, 0, 0]).map((x) => +x.toFixed(6))).toEqual([1.8, 0, 0]);
  });
  it('adds the sun where it is given: colour · intensity · max(0, n·dir) · visibility', () => {
    const at = probeSampler([box], atlasOf(() => 0, () => 0.5), 0);
    const sun = { dir: [0, 1, 0], color: [1, 0.5, 0.25], intensity: 2 };
    expect(at([1, 1, 1], [0, 1, 0], sun, [0, 0, 0])).toEqual([1, 0.5, 0.25]);
    expect(at([1, 1, 1], [0, -1, 0], sun, [0, 0, 0])).toEqual([0, 0, 0]);
    expect(at([1, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 0]);
  });
  it('takes the volume of highest priority containing the point, then the smallest', () => {
    const big = volume([0, 0, 0], [8, 8, 8], [1, 1, 1]);
    const small = volume([0, 0, 0], [2, 2, 2], [1, 1, 1]);
    const indoor = volume([0, 0, 0], [4, 4, 4], [1, 1, 1], { priority: 1 });
    const light = (v) => (v === big ? 1 : v === small ? 2 : 3);
    expect(probeSampler([big, small], atlasOf(light), 0)([1, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 2]);
    expect(probeSampler([big, small, indoor], atlasOf(light), 0)([1, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 3]);
    expect(probeSampler([big, small, indoor], atlasOf(light), 0)([6, 6, 6], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 1]);
  });
  it('lights a point outside every volume from the nearest one, clamped to its outermost probes, never black', () => {
    const near = volume([0, 0, 0], [2, 2, 2], [2, 1, 1]);
    const far = volume([10, 0, 0], [12, 2, 2], [1, 1, 1]);
    const at = probeSampler([far, near], atlasOf((v, i) => (v === far ? 9 : i === 0 ? 1 : 5)), 0);
    expect(at([3, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 5]);
    expect(at([-4, 1, 1], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 1]);
  });
  it('turns world points into a rotated volume\'s own frame', () => {
    // The volume's x axis runs along glTF −z: its probe 0 sits at glTF z = −0.5, probe 1 at −1.5.
    const turned = { ...volume([0, 0, -2], [1, 1, 0], [2, 1, 1]), frame: { origin: [0, 0, 0], axes: [[0, 0, -1], [0, 1, 0], [1, 0, 0]], lo: [0, 0, 0], hi: [2, 1, 1] } };
    const at = probeSampler([turned], atlasOf((v, i) => (i === 0 ? 1 : 3)), 0);
    expect(at([0.5, 0.5, -0.5], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 1]);
    expect(at([0.5, 0.5, -1.5], [0, 1, 0], null, [0, 0, 0])).toEqual([0, 0, 3]);
  });
});
