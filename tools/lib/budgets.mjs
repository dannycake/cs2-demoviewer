// The budgets check-map.mjs asserts. BUDGET is the plan's Mirage acceptance and holds
// for every map by default. BUDGET_OVERRIDES are per-map ceilings for the maps that
// miss it with the fixed pipeline (stronger simplification either still misses it or
// shreds the foliage), set from each map's measured build, and apply only when
// check-map.mjs is run with --budget-override (which
// build-assets.sh passes). A key is overridden only where the map misses BUDGET.
// Ceilings come from CS2 build 2000934 (phase 2, Task 8): sizes and the triangle
// maximum are the measured value × 1.1 rounded up to two significant figures, so a
// CS2 update that grows a map still fails; shrink seconds (Inferno, Train) are the
// slower of two full builds × 1.25 rounded up to 100 s, because the AO bake time moves
// with machine load; since the phase 2 follow-up an exceeded shrinkSeconds only WARNs in
// check-map.mjs (a loaded machine is not a broken artefact). Mirage has no entry. Sizes
// are decimal bytes.
//
// M2a (CS2's baked light) adds three budgets, for every map: lightmap.webp at most 2 MB,
// probes.bin.gz at most 0.4 MB, and the first load (lib/maps.mjs MAP_FIRST_LOAD) at most the map's
// first load before M2a plus 2.5 MB, the cap the user chose (2026-10-24); on Anubis, Dust2, Inferno
// and Overpass plus 5.0 MB in place of the 2.5, so they ship the lightmap (FULL_LIGHTING_EXTRA,
// 2026-10-25). That ceiling is per map, so each map but Mirage carries
// its own firstLoadBytes in BUDGET_OVERRIDES; those entries are not part of the design doc's
// ladder. A map whose H2 bake would break it ships tier V instead (shrink-map.mjs). M2b's
// entities.glb (the doors and breakable windows) has a 500 KB budget of its own and counts in
// the first load too: the baseline predates it, so it shares the same +2.5 MB.

import { RADAR_SIZE } from './overview.mjs';

/**
 * Each map's first load (lib/maps.mjs firstLoadBytes) before M2a: measured 2026-10-24 in the main
 * checkout's assets/maps/<map>/, built from 228e0e4 (CS2 build 2000934; de_cache's on 2026-10-23):
 * world.glb.gz, the radars and overview.json. Mirage and Nuke are Task 1b's "today" (6.45 and
 * 12.25 MB) less manifest.json (962 and 1,110 B).
 */
export const FIRST_LOAD_BEFORE_M2A = Object.freeze({
  de_ancient: 31_293_380,
  de_anubis: 13_197_342,
  de_cache: 19_861_632,
  de_dust2: 14_540_965,
  de_inferno: 29_369_898,
  de_mirage: 6_453_417,
  de_nuke: 12_244_987,
  de_overpass: 19_998_162,
  de_train: 28_490_298,
  de_vertigo: 6_493_776,
});

/**
 * What M2a and M2b may add to a map's first load: the sky, the bake, the skybox geometry M2a
 * kept, and entities.glb (less the doors and windows it takes out of world.glb).
 */
export const FIRST_LOAD_EXTRA = 2.5e6;

/**
 * The maps whose first load may grow by more than FIRST_LOAD_EXTRA: the user chose "full lighting,
 * raise their cap" on 2026-10-25 for the four maps whose H2 build (CS2's lightmap, 256 px
 * textures) passed + 2.5 MB and had fallen to tier V (vertex light only; Inferno with 192 px
 * textures too). H2's first loads then: Anubis 16,520,759 B, Dust2 17,381,642, Overpass
 * 22,777,517, Inferno 33,992,103.
 */
export const FULL_LIGHTING_EXTRA = Object.freeze({
  de_anubis: 5e6,
  de_dust2: 5e6,
  de_inferno: 5e6,
  de_overpass: 5e6,
});

const firstLoadCap = (map) => FIRST_LOAD_BEFORE_M2A[map] + (Object.hasOwn(FULL_LIGHTING_EXTRA, map) ? FULL_LIGHTING_EXTRA[map] : FIRST_LOAD_EXTRA);

/** Decimal bytes as whole kilobytes (`19 KB`): how shrink-map, check-map and entities.glb's rows print sizes. */
export const kb = (n) => `${(n / 1e3).toFixed(0)} KB`;
/** Decimal bytes as megabytes to two places (`8.33 MB`), as shrink-map and check-map print the larger ones. */
export const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

/** The plan's Mirage acceptance. */
export const BUDGET = Object.freeze({
  worldBytes: 20e6,
  worldTris: Object.freeze([400_000, 800_000]),
  hullBytes: 2e6,
  radarSize: Object.freeze([RADAR_SIZE, RADAR_SIZE]),
  shrinkSeconds: 600,
  lightmapBytes: 2e6,
  firstLoadBytes: firstLoadCap('de_mirage'),
  // entities.glb (doors and breakables), on every map that has one; never overridden.
  entitiesBytes: 500e3,
  // probes.bin.gz, the light grid the players are lit by (D7), on every baked map.
  gridBytes: 400e3,
});

/** The BUDGET keys an override may relax (never the radar size). */
export const OVERRIDABLE = Object.freeze(['worldBytes', 'worldTris', 'hullBytes', 'shrinkSeconds', 'lightmapBytes', 'firstLoadBytes', 'gridBytes']);

const entry = (o) => Object.freeze(o.worldTris ? { ...o, worldTris: Object.freeze(o.worldTris) } : o);

/** Per-map ceilings; see the header. */
export const BUDGET_OVERRIDES = Object.freeze({
  de_ancient: entry({ worldBytes: 84e6, worldTris: [400_000, 3_900_000], hullBytes: 15e6, firstLoadBytes: firstLoadCap('de_ancient') }),
  de_anubis: entry({ worldBytes: 38e6, worldTris: [400_000, 1_700_000], hullBytes: 9.1e6, firstLoadBytes: firstLoadCap('de_anubis') }),
  de_cache: entry({ worldBytes: 42e6, worldTris: [400_000, 2_000_000], hullBytes: 19e6, firstLoadBytes: firstLoadCap('de_cache') }),
  de_dust2: entry({ worldBytes: 44e6, worldTris: [400_000, 2_100_000], hullBytes: 5.1e6, firstLoadBytes: firstLoadCap('de_dust2') }),
  de_inferno: entry({ worldBytes: 93e6, worldTris: [400_000, 4_200_000], hullBytes: 36e6, shrinkSeconds: 900, firstLoadBytes: firstLoadCap('de_inferno') }),
  // de_mirage: none; it meets BUDGET (552,195 triangles, 10.3 MB with its bake and its window out, 2026-10-24)
  de_nuke: entry({ worldBytes: 45e6, worldTris: [400_000, 1_900_000], firstLoadBytes: firstLoadCap('de_nuke') }),
  de_overpass: entry({ worldBytes: 68e6, worldTris: [400_000, 2_400_000], hullBytes: 12e6, firstLoadBytes: firstLoadCap('de_overpass') }),
  de_train: entry({ worldBytes: 100e6, worldTris: [400_000, 4_200_000], hullBytes: 19e6, shrinkSeconds: 1300, firstLoadBytes: firstLoadCap('de_train') }),
  // gridBytes 0.45 MB: accepted by the controller's ruling (Task 11 review, 2026-10-25). The light
  // grid covers the probe volumes clipped to the hull, which on Vertigo is the
  // 392 m tower down to the street (57×157×76 cells, 17,467 of them over a floor): 416,865 B gz
  // (2026-10-25), the map's first load still inside its cap.
  de_vertigo: entry({ worldBytes: 24e6, worldTris: [400_000, 1_100_000], hullBytes: 2.4e6, firstLoadBytes: firstLoadCap('de_vertigo'), gridBytes: 450e3 }),
});

/**
 * The budget check-map.mjs applies to `map`: BUDGET, with `map`'s BUDGET_OVERRIDES
 * entry over it when `override` is true. `overridden` lists the keys replaced.
 */
export function budgetFor(map, override) {
  const o = override && typeof map === 'string' && Object.hasOwn(BUDGET_OVERRIDES, map) ? BUDGET_OVERRIDES[map] : {};
  return { ...BUDGET, ...o, overridden: Object.keys(o) };
}
