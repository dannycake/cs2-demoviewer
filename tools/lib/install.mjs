// Puts a map shrink's outputs in place: shrink-map.mjs writes everything into <out>.tmp-<pid>/
// and calls this at the end, so a failed run changes nothing in <out>.
import fs from 'node:fs';
import path from 'node:path';
import { MAP_BAKE_FILES, MAP_OPTIONAL_GLBS, MAP_RETIRED } from './maps.mjs';
import { renameInto } from './stage.mjs';

/**
 * The outputs only some builds make, with their `.gz` siblings: entities.glb and the bake files;
 * and the retired ones no build makes any more (MAP_RETIRED: world_hd.glb).
 */
const OPTIONAL = Object.freeze([...MAP_OPTIONAL_GLBS, ...MAP_BAKE_FILES, ...MAP_RETIRED].flatMap((f) => [f, `${f}.gz`]));

/**
 * Renames each of `written` (every file name the build wrote into `tmp`: GLBs, bake files, their
 * `.gz` siblings and shrink.json) from `tmp` into `out`, one rename per file, so the radar,
 * overview, sky and manifest files beside them are left alone. An optional output
 * (MAP_OPTIONAL_GLBS, MAP_BAKE_FILES, or their `.gz`) that this build did not write is stale and
 * removed: entities.glb from a build of a map that has since lost its doors and breakables, the
 * bake files from a build with a bake, lightmap.webp from an H2 build after tier V, and
 * world_hd.glb from any build before it retired.
 */
export function installMapOutputs(tmp, out, written) {
  renameInto(tmp, out, written);
  for (const f of OPTIONAL.filter((g) => !written.includes(g))) fs.rmSync(path.join(out, f), { force: true });
}
