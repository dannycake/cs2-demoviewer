import { shouldDrop, shouldDropWith, materialFails, perMapParams, PER_MAP, DROP_NODE, DROP_VMAT_PREFIXES, DROP_SHADERS } from '../lib/filters.mjs';
import { MAPS } from '../lib/maps.mjs';

test('black unlit backdrop under materials/dev is dropped', () => {
  expect(shouldDrop('n0_lr0_agg_merge_black_simple_0', 'materials/dev/black_simple.vmat', 'csgo_black_unlit.vfx')).toBe(true);
});
test('tool material is dropped', () => {
  expect(shouldDrop('unnamed_2_60417.hammer_mesh_0', 'materials/tools/toolsskybox.vmat', '')).toBe(true);
});
test('ordinary textured wall is kept', () => {
  expect(shouldDrop('n0_lr0_agg_merge_sitebwall13a_1', 'materials/de_dust/sitebwall13a.vmat', 'csgo_simple.vfx')).toBe(false);
});
test('overlay node is dropped by name', () => {
  expect(shouldDrop('x_s_mesh_overlay_3', 'materials/x.vmat', '')).toBe(true);
});
test('each rule fires on its own', () => {
  expect(shouldDrop('n0_lr0_c2_s_cb_bl_mesh_blocklight2_shadow.meshset_0', 'materials/x.vmat', 'csgo_simple.vfx')).toBe(true);
  expect(shouldDrop('x_FOG_CARD_1', '', '')).toBe(true);
  expect(shouldDrop('wall', 'materials/x.vmat', 'csgo_black_unlit.vfx')).toBe(true);
  expect(shouldDrop('wall', 'materials/dev/reflectivity_50.vmat', 'csgo_simple.vfx')).toBe(true);
  // prefixes match at the start only
  expect(shouldDrop('wall', 'materials/de_mirage/materials/tools/x.vmat', 'csgo_simple.vfx')).toBe(false);
  expect(shouldDrop('', '', '')).toBe(false);
});
test('constants are the Global Constraints rule', () => {
  expect(DROP_NODE.flags).toContain('i');
  expect(DROP_NODE.source).toBe('(_s_mesh_overlay|blocklight|_bl_mesh|^sky_|_sky$|fog_card|blocker|clip(?=_|$))');
  expect(DROP_VMAT_PREFIXES).toEqual(['materials/tools/', 'materials/dev/']);
  expect([...DROP_SHADERS]).toEqual(['csgo_black_unlit.vfx', 'csgo_effects.vfx']);
});
test('effects cards (the white dust sheets on Mirage) are dropped', () => {
  expect(shouldDrop('n0_lr0_c0_s_cb_nomerge4_dust_002.meshset_0', 'materials/effects/smoke/dust_002.vmat', 'csgo_effects.vfx')).toBe(true);
  expect(shouldDrop('n0_lr0_agg_merge_mall_trees_branches01_1', 'materials/models/props_foliage/mall_trees_branches01.vmat', 'csgo_foliage.vfx')).toBe(false);
});
test('world collision (hull) groups: clips are dropped, surface groups are kept', () => {
  // node names VRF gives maps/de_mirage/world_physics.vmdl_c's groups; no materials
  expect(shouldDrop('physics_npcclip_playerclip', '', '')).toBe(true);
  expect(shouldDrop('physics_csgo_grenadeclip', '', '')).toBe(true);
  expect(shouldDrop('physics_ladder_npcclip_playerclip_ladder', '', '')).toBe(true);
  expect(shouldDrop('physics_group_concrete', '', '')).toBe(false);
  expect(shouldDrop('physics_passbullets_metal', '', '')).toBe(false);
});
test('the collision sky group is dropped by name (hull groups carry no material)', () => {
  expect(shouldDrop('physics_sky', '', '')).toBe(true);
  // `_sky` matches only at the end of a name
  expect(shouldDrop('physics_group_skylight_frame', '', '')).toBe(false);
});
test('`clip` and `sky_` match only as name parts, so real props named after them stay', () => {
  expect(shouldDrop('n1_lr0_agg_merge_nuke_clipboard_color_2', 'materials/models/props/de_nuke/hr_nuke/nuke_office_desk/nuke_clipboard_color.vmat', 'csgo_complex.vfx')).toBe(false);
  expect(shouldDrop('n0_lr0_agg_prop_nuke_clipboard_holder_color_4', 'materials/models/props/de_nuke/hr_nuke/nuke_office_desk/nuke_clipboard_holder_color.vmat', 'csgo_complex.vfx')).toBe(false);
  expect(shouldDrop('n0_lr0_agg_merge_window_opaque_1b_lit_sky_3', 'materials/glass/window_opaque_1b_lit_sky.vmat', 'csgo_complex.vfx')).toBe(false);
  // every hull clip group still drops, with `clip` mid-name or at the end
  expect(shouldDrop('physics_npcclip_playerclip_vrf_unknown_key_3', '', '')).toBe(true);
  expect(shouldDrop('physics_npcclip_passbullets', '', '')).toBe(true);
  expect(shouldDrop('physics_navclip', '', '')).toBe(true);
  expect(shouldDrop('physics_playerclip', '', '')).toBe(true);
  expect(shouldDrop('sky_dome', '', '')).toBe(true);
});
test("the skybox props (Ancient's and Nuke's far buildings, trees and rock walls) are kept; the collision sky still drops", () => {
  // The sky itself is now drawn (sky.webp); these are real meshes around the map's edge.
  expect(shouldDrop('n0_lr0_agg_merge_nuke_skybox_buildings_color_0', 'materials/models/props/de_nuke/hr_nuke/nuke_skybox_buildings/nuke_skybox_buildings_color.vmat', 'csgo_vertexlitgeneric.vfx')).toBe(false);
  expect(shouldDrop('n0_lr0_agg_merge_ancient_skybox_bldg_a_0', 'materials/models/props/de_ancient/ancient_skybox/ancient_skybox_bldg_a.vmat', 'csgo_environment.vfx', 'de_ancient')).toBe(false);
  expect(shouldDrop('physics_sky', '', '')).toBe(true);
});
test('per-map overrides add to the rule for their map only', () => {
  // VRF exports csgo_water_fancy.vfx materials untextured and OPAQUE: without Valve's
  // shader they render as white planes (Anubis: the sea and the canal).
  const water = ['n0_lr0_c0_s_cb_nomerge2_anubis_water_coast.meshset_0', 'materials/anubis/anubis_water_coast.vmat', 'csgo_water_fancy.vfx'];
  expect(shouldDrop(...water, 'de_anubis')).toBe(true);
  expect(materialFails(water[1], water[2], 'de_anubis')).toBe(true);
  expect(shouldDrop(...water, 'de_mirage')).toBe(false);
  expect(shouldDrop(...water)).toBe(false);
  expect(materialFails(water[1], water[2])).toBe(false);
  // an unknown map, or a key Object.prototype carries, adds nothing
  expect(shouldDrop(...water, 'de_cache')).toBe(false);
  expect(shouldDrop(...water, 'constructor')).toBe(false);
  // the global rule still applies with a map
  expect(shouldDrop('wall', 'materials/dev/reflectivity_50.vmat', 'csgo_simple.vfx', 'de_anubis')).toBe(true);
  expect(shouldDrop('n0_lr0_agg_merge_stone_blocks_0', 'materials/anubis/models/structures/stone_blocks.vmat', 'csgo_vertexlitgeneric.vfx', 'de_anubis')).toBe(false);
});
test('Vertigo drops the intro news helicopter by node name, and nothing else of its by that rule', () => {
  const heli = 'news_helicoptor_map1_intro_v1.news_helicoptor_map1_intro_v1_bg_studio_lod0';
  expect(shouldDrop(heli, 'materials/models/hybridphysx/searchlight_small_01.vmat', 'csgo_complex.vfx', 'de_vertigo')).toBe(true);
  expect(shouldDrop(heli, 'materials/models/hybridphysx/searchlight_small_01.vmat', 'csgo_complex.vfx', 'de_nuke')).toBe(false);
  expect(shouldDrop('constructioncrane01_load.constructioncrane01_load_bg_body_lod0', 'materials/x.vmat', 'csgo_complex.vfx', 'de_vertigo')).toBe(false);
  // Vertigo has no water entry
  expect(shouldDrop('w', 'materials/x.vmat', 'csgo_water_fancy.vfx', 'de_vertigo')).toBe(false);
});
test('a per-map dropNode is tested against the node name', () => {
  expect(shouldDropWith({ dropNode: /_canal_/i }, 'n0_x_CANAL_1', 'materials/x.vmat', 'csgo_simple.vfx')).toBe(true);
  expect(shouldDropWith({ dropNode: /_canal_/i }, 'n0_x_coast_1', 'materials/x.vmat', 'csgo_simple.vfx')).toBe(false);
  expect(shouldDropWith(null, 'n0_x_coast_1', 'materials/x.vmat', 'csgo_effects.vfx')).toBe(true);
});
test('PER_MAP entries name built maps and only known keys', () => {
  for (const [map, entry] of Object.entries(PER_MAP)) {
    expect(MAPS).toContain(map);
    expect(Object.isFrozen(entry)).toBe(true);
    for (const key of Object.keys(entry)) expect(['dropNode', 'dropShaders']).toContain(key);
    if (entry.dropNode) { expect(entry.dropNode).toBeInstanceOf(RegExp); expect(entry.dropNode.flags).not.toMatch(/[gy]/); }
    if (entry.dropShaders) for (const s of entry.dropShaders) expect(s).toMatch(/^[a-z0-9_]+\.vfx$/);
  }
  expect(Object.keys(PER_MAP).sort()).toEqual(['de_ancient', 'de_anubis', 'de_inferno', 'de_nuke', 'de_train', 'de_vertigo']);
  expect(perMapParams('de_anubis')).toEqual({ dropShaders: ['csgo_water_fancy.vfx'] });
  expect(perMapParams('de_vertigo')).toEqual({ dropNode: '^news_helicoptor_' });
  expect(perMapParams('de_mirage')).toBe(null);
  expect(JSON.parse(JSON.stringify(perMapParams('de_nuke')))).toEqual(perMapParams('de_nuke'));
});
