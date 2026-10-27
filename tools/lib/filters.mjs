// Which world meshes the map pipeline drops before shrinking: lightmap blockers,
// overlays, sky and fog cards, clip brushes, tool and dev materials, the black
// unlit backdrop meshes, and csgo_effects.vfx cards; shrink-map.mjs runs it on the
// world and on the collision hull. This is the plan's Global Constraints rule as
// recorded in the design doc. csgo_effects.vfx was added in phase 2: on Mirage the
// big white planes in the spike screenshots are materials/effects/smoke/dust_002.vmat
// sheets (10 primitives, 74 triangles, 3,389 m², exported OPAQUE) whose translucent
// dust texture renders as an opaque white plane without Valve's effects shader; on
// Nuke the same shader carries steam cards, the skylight tint and the retakes blocker.
// `_sky$` was added for the collision mesh's `physics_sky` group (Mirage: a 17.5k m²
// ceiling at 24 m; Nuke: a 21.5k m² sheet at -12.8..-8.1 m): the render export holds
// no sky brushes, but the collision keeps them in that group, with no material to match.
// `sky_` became `^sky_` and `clip` became `clip(?=_|$)` after the final review: matched
// anywhere in a name they also dropped real props, Nuke's and Overpass's desk clipboards
// (`nuke_clipboard{,_holder}_color`, 7,498 + 2,752 triangles) and Inferno's lit windows
// (`window_opaque_1b_lit_sky_<n>`). Over every node of the nine raw world.glb and
// world_collision.glb files those are the only names whose verdict changed; every hull
// clip group (`physics_*clip*`), `physics_sky`, the skybox and the blocker nodes still drop.
// `skybox` left the rule in milestone 2a, when the viewer began drawing CS2's own sky
// (sky.mjs): the only nodes it matched are real meshes around the map's edge, Ancient's
// distant buildings, tree cards and rock walls (63 primitives, which reach 12 m past the
// rest of the world) and Nuke's skyline buildings (2 primitives, 8 m), with nothing behind
// them but the sky. No collision group has `skybox` in its name; `physics_sky` drops by `_sky$`.
//
// PER_MAP adds to the rule for one map only, where that map's export carries meshes
// the global rule keeps but that render wrong (phase 2, Task 8, from the viewer
// screenshots and spike/list-untextured.mjs on each raw world.glb):
// - csgo_water_fancy.vfx: VRF exports every material of this shader untextured and
//   OPAQUE, so without Valve's water shader it renders as a flat white plane. On
//   Anubis that is the sea and the canal (anubis_water_coast/_canal, 21k m² of
//   bounding boxes, the big white sheet beside the map), on Ancient the shallow pool
//   (hr_aztec_water_shallow, 1.6k m²), on Nuke nuke_water (469 m²), on Train the
//   chemical spill (83 m²) and on Inferno the fountain (56 m²). Dust2, Mirage,
//   Overpass and Vertigo have no material of that shader; textured water (Nuke's
//   river is csgo_lightmappedgeneric, Ancient's cascades csgo_unlitgeneric) is kept.
// - Vertigo's news helicopter from the map intro (`news_helicoptor_map1_intro_v1`,
//   7,467 triangles) hangs 130 m above the roof and 250 m to the side of the tower.

/** Node names that never belong in the rendered world. */
export const DROP_NODE = /(_s_mesh_overlay|blocklight|_bl_mesh|^sky_|_sky$|fog_card|blocker|clip(?=_|$))/i;

/** Material `extras.vmat.Name` prefixes that are editor-only. */
export const DROP_VMAT_PREFIXES = Object.freeze(['materials/tools/', 'materials/dev/']);

/** Material `extras.vmat.ShaderName` values that are dropped. */
export const DROP_SHADERS = new Set(['csgo_black_unlit.vfx', 'csgo_effects.vfx']);

/**
 * Per-map additions to the rule. An entry may carry `dropNode` (a RegExp, without the
 * g or y flag, tested against the node name like DROP_NODE) and `dropShaders`
 * (ShaderName values dropped like DROP_SHADERS); both add to the global rule, never
 * replace it. shrink-map.mjs applies its map's entry to the world and the hull and
 * records it in shrink.json (`params.drop.perMap`); check-map.mjs asserts it.
 */
const WATER = Object.freeze(['csgo_water_fancy.vfx']);
export const PER_MAP = Object.freeze({
  de_ancient: Object.freeze({ dropShaders: WATER }),
  de_anubis: Object.freeze({ dropShaders: WATER }),
  de_inferno: Object.freeze({ dropShaders: WATER }),
  de_nuke: Object.freeze({ dropShaders: WATER }),
  de_train: Object.freeze({ dropShaders: WATER }),
  de_vertigo: Object.freeze({ dropNode: /^news_helicoptor_/ }),
});

/** The PER_MAP entry of `map`, or null (also for a missing or unknown map). */
export function perMap(map) {
  return typeof map === 'string' && Object.hasOwn(PER_MAP, map) ? PER_MAP[map] : null;
}

/** `map`'s PER_MAP entry as JSON-safe values (the RegExp as its source), or null. */
export function perMapParams(map) {
  const extra = perMap(map);
  if (!extra) return null;
  const out = {};
  if (extra.dropNode) out.dropNode = extra.dropNode.source;
  if (extra.dropShaders) out.dropShaders = [...extra.dropShaders];
  return out;
}

function materialFailsWith(extra, vmatName, shaderName) {
  const name = vmatName || '';
  const shader = shaderName || '';
  return DROP_VMAT_PREFIXES.some((p) => name.startsWith(p)) || DROP_SHADERS.has(shader)
    || (extra?.dropShaders?.includes(shader) ?? false);
}

/**
 * True when the material half of the rule fails (tool/dev vmat or a dropped shader),
 * including `map`'s PER_MAP shaders when a map is given.
 */
export function materialFails(vmatName, shaderName, map) {
  return materialFailsWith(perMap(map), vmatName, shaderName);
}

/** shouldDrop with an explicit per-map entry (`null` for none) instead of a map name. */
export function shouldDropWith(extra, nodeName, vmatName, shaderName) {
  const node = nodeName || '';
  return DROP_NODE.test(node) || (extra?.dropNode?.test(node) ?? false) || materialFailsWith(extra, vmatName, shaderName);
}

/**
 * @param {string} nodeName    glTF node name
 * @param {string} vmatName    material extras.vmat.Name ('' when absent)
 * @param {string} shaderName  material extras.vmat.ShaderName ('' when absent)
 * @param {string} [map]       map name; adds its PER_MAP entry to the rule
 * @returns {boolean} true when the mesh must not reach the output
 */
export function shouldDrop(nodeName, vmatName, shaderName, map) {
  return shouldDropWith(perMap(map), nodeName, vmatName, shaderName);
}

/** `{ name, shader }` from a gltf-transform Material's extras ('' when missing). */
export function vmatOf(material) {
  const vmat = material?.getExtras()?.vmat ?? {};
  return { name: typeof vmat.Name === 'string' ? vmat.Name : '', shader: typeof vmat.ShaderName === 'string' ? vmat.ShaderName : '' };
}
