// A colour lit by the map's light grid (probes.ts) at a point, for what is drawn in the world
// without lighting of its own (a smoke's puffs, an HE's smoke, blood): sampled once and kept
// until the grid, the point or the sun changes, so a frame that changes none of them samples
// nothing and makes nothing. And the light on a wall there, by its normal (`wallLight`), for what
// lies flat on it (bullet holes, blood on the walls).

import * as THREE from 'three';
import { makeProbeSample, sampleLightGrid, type LightGrid } from './probes';

/** A colour lit by the light grid, kept until what it was sampled for changes (`lightAt`). */
export interface LitCache {
  /** Its albedo times the light, or null without a grid. */
  lit: THREE.Color | null;
  /** What `lit` was sampled for: the grid, the point and the sun's light. */
  litGrid: LightGrid | null;
  litAt: THREE.Vector3;
  litSun: THREE.Color;
}

export const litCache = (): LitCache => ({
  lit: null,
  litGrid: null,
  litAt: new THREE.Vector3(),
  litSun: new THREE.Color(),
});

/** The grid's sample, and the sun's light when there is none. */
const _sample = makeProbeSample();
const _noSun = new THREE.Color(0, 0, 0);

/**
 * On a baked map (`grid`), `c.lit` ← `albedo` times the light at `at` (a vector of the caller's
 * own), keeping `tint` of its colour (1 all of it, 0 its brightness alone): the grid's cube
 * averaged over every direction (up/6 + down/6 + 2·side/3 under CS2's weighting) and a quarter
 * of `sun` (the sun's light in the grid's units, null for none) past the grid's sun (a Lambert
 * sphere's share). Sampled again only when the grid, the point or the sun changes; nothing is
 * made but `c.lit` the first time. Without a grid, null.
 */
export function lightAt(
  c: LitCache,
  at: THREE.Vector3,
  albedo: number,
  tint: number,
  grid: LightGrid | null,
  sunLight: THREE.Color | null
): void {
  if (!grid) {
    c.lit = null;
    c.litGrid = null;
    return;
  }
  const sun = sunLight ?? _noSun;
  if (c.lit && c.litGrid === grid && c.litAt.equals(at) && c.litSun.equals(sun))
    return;
  const q = sampleLightGrid(grid, at, _sample);
  const light = (u: number, d: number, side: number, sn: number) =>
    u / 6 + d / 6 + (2 * side) / 3 + 0.25 * q.sun * sn;
  const r = light(q.up.r, q.down.r, q.side.r, sun.r);
  const g = light(q.up.g, q.down.g, q.side.g, sun.g);
  const b = light(q.up.b, q.down.b, q.side.b, sun.b);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const grey = (v: number) => albedo * (lum + tint * (v - lum));
  c.lit = (c.lit ?? new THREE.Color()).setRGB(grey(r), grey(g), grey(b));
  c.litGrid = grid;
  c.litAt.copy(at);
  c.litSun.copy(sun);
}

/**
 * Into `out`: on a baked map (`grid`) the light on a surface at `at` facing `normal` (unit), as
 * the players are lit (probes.ts `attachProbe`): the grid's up, down and side weighed by the
 * normal, up·max(n.y, 0)² + down·max(−n.y, 0)² + side·(1 − n.y²), and `sun` (the sun's light in
 * the grid's units, null for none) from `toSun` by the cosine, past the grid's sun at `at`. For
 * what lies flat on a wall (a bullet hole, blood): a wall turned from the sun takes none of it.
 * Allocates nothing.
 */
export function wallLight(
  grid: LightGrid,
  at: THREE.Vector3,
  normal: THREE.Vector3,
  sun: THREE.Color | null,
  toSun: Readonly<THREE.Vector3> | null,
  out: THREE.Color
): THREE.Color {
  const q = sampleLightGrid(grid, at, _sample);
  const ny = normal.y;
  const up = Math.max(ny, 0) ** 2;
  const down = Math.max(-ny, 0) ** 2;
  const side = 1 - ny * ny;
  const lit = sun && toSun ? Math.max(0, normal.dot(toSun)) * q.sun : 0;
  const s = sun ?? _noSun;
  return out.setRGB(
    q.up.r * up + q.down.r * down + q.side.r * side + s.r * lit,
    q.up.g * up + q.down.g * down + q.side.g * side + s.g * lit,
    q.up.b * up + q.down.b * down + q.side.b * side + s.b * lit
  );
}
