// Map constants shared by every Node script. tools/lib/env.sh carries the same
// list for the bash scripts; keep the two in step.
import fs from 'node:fs';
import path from 'node:path';

/** The Active Duty pool the pipeline builds, in alphabetical order. */
export const ACTIVE_DUTY = Object.freeze([
  'de_ancient',
  'de_anubis',
  'de_dust2',
  'de_inferno',
  'de_mirage',
  'de_nuke',
  'de_overpass',
  'de_train',
  'de_vertigo',
]);

/**
 * Maps that ship a second, lower-level radar
 * (panorama/images/overheadmaps/<map>_lower_radar_psd.vtex_c).
 */
/**
 * Every map the pipeline builds (`all` in build-assets.sh and rip-entities.sh): the Active Duty
 * pool and the maps outside it that players bring matches on.
 */
export const MAPS = Object.freeze([...ACTIVE_DUTY, 'de_cache']);

export const LOWER_RADAR = new Set(['de_nuke', 'de_train', 'de_vertigo']);

/** A built map's served models; each has a gzip -9 `.gz` sibling (lib/gz.mjs). */
export const MAP_GLBS = Object.freeze(['world.glb', 'hull.glb']);

/**
 * Files a map served once and the pipeline no longer builds, each with its `.gz` sibling:
 * world_hd.glb, the world with 1024 px textures, which nothing has loaded since the viewer's HD
 * toggle went (c34ff97). A shrink removes them from the map it rebuilds (lib/install.mjs), and
 * sync-assets.sh never sends them, so its --delete pass takes them off the server.
 */
export const MAP_RETIRED = Object.freeze(['world_hd.glb']);

/**
 * Served models only some maps have, with a `.gz` sibling like MAP_GLBS: entities.glb, the
 * doors and breakable windows (lib/entities.mjs), on maps that have any.
 */
export const MAP_OPTIONAL_GLBS = Object.freeze(['entities.glb']);

/**
 * Maps that ship CS2's own baked light (shrink-map.mjs; the M2a spike's gate passed on Mirage and
 * Nuke). Every layer fails one of them that has no whole bake, rather than ship the AO world in
 * its place: rip-lighting.sh when its VPK lacks a texture of the bake, shrink-map.mjs when its
 * raw export cannot bake (lightmap.mjs lightmapInputs, the probes, the sun), and check-map.mjs
 * when it has no light.json. Taking a map off this list is the one way to build it with AO (in
 * COLOR_0, no light.json), as a map never on it builds.
 */
export const LIGHTMAP_MAPS = MAPS;

/**
 * The files of a map's baked light, in manifest order: lightmap.webp (sqrt light, lossless;
 * absent under tier V), probes.bin (the light grid) and light.json (what the viewer needs to use
 * them). probes.bin and light.json have gzip -9 `.gz` siblings.
 */
export const MAP_BAKE_FILES = Object.freeze(['lightmap.webp', 'probes.bin', 'light.json']);

/**
 * What the viewer fetches to open a map, the first-load budget (lib/budgets.mjs): the world, the
 * doors and breakables (entities.glb, which the viewer fetches with the world), the radars,
 * overview.json, the sky and the bake. Task 1b's definition, less manifest.json, plus what M2a
 * and M2b add: the cap's baseline (budgets.mjs FIRST_LOAD_BEFORE_M2A) predates both, so
 * entities.glb counts against the same +2.5 MB as the bake, less the doors it takes out of
 * world.glb. hull.glb loads too but neither milestone
 * changes it, and manifest.json (~1 KB) is written after shrink-map.mjs and check-map.mjs run
 * (build-assets.sh removes it first), so both are left out of both sides of the cap.
 */
export const MAP_FIRST_LOAD = Object.freeze(['world.glb', ...MAP_OPTIONAL_GLBS, 'radar.png', 'radar_lower.png', 'overview.json', 'sky.webp', ...MAP_BAKE_FILES]);

/**
 * The bytes a client downloads for `names` (default MAP_FIRST_LOAD) in a map's directory: each
 * file's `.gz` sibling where it has one (the server sends that), else the file; missing files
 * count 0.
 */
export function firstLoadBytes(dir, names = MAP_FIRST_LOAD) {
  let total = 0;
  for (const name of names) {
    for (const f of [path.join(dir, `${name}.gz`), path.join(dir, name)]) {
      if (fs.existsSync(f)) { total += fs.statSync(f).size; break; }
    }
  }
  return total;
}
