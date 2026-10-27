// The surface a bullet meets, from the name of the hull's collision group (`hull.glb` keeps one
// node per `physics_group_<surface>`): Nuke's and Mirage's real group names.

import { describe, expect, it } from 'vitest';
import { SURFACES, surfaceOf } from '../src/sim/surfaces';

describe('surfaceOf', () => {
  it("reads Nuke's hull groups", () => {
    const cases: [string, string][] = [
      ['physics_group_metal_box', 'metal'],
      ['physics_passbullets_chainlink', 'pass'],
      ['physics_group_glass', 'glass'],
      ['physics_group_concrete', 'stone'],
      ['physics_group_tile', 'stone'],
      ['physics_group', 'stone'],
      ['physics_group_vrf_unknown_key_2838185980', 'stone'],
      ['physics_group_wood', 'wood'],
      ['physics_group_carpet', 'soft'],
      ['physics_group_rubber', 'soft'],
      ['physics_group_metalgrate', 'metal'],
    ];
    for (const [name, surface] of cases)
      expect(surfaceOf(name), name).toBe(surface);
  });

  it('reads the Mirage groups the first table missed: no_decal, upholstery and computer', () => {
    expect(surfaceOf('physics_group_no_decal')).toBe('nodecal');
    expect(surfaceOf('physics_group_upholstery')).toBe('soft');
    expect(surfaceOf('physics_group_computer')).toBe('metal');
  });

  it('reads what a thing is made of over what it is: brass bells, canisters and paint cans are metal, foliage soft, a concrete window stone, a plastic barrel or milk crate soft', () => {
    expect(surfaceOf('physics_group_brass_bell_large')).toBe('metal');
    expect(surfaceOf('physics_group_brass_bell_smallest_g')).toBe('metal');
    expect(surfaceOf('physics_group_canister')).toBe('metal');
    expect(surfaceOf('physics_group_paintcan')).toBe('metal');
    expect(surfaceOf('physics_ConditionallySolid_foliage')).toBe('soft');
    expect(surfaceOf('physics_window_concrete')).toBe('stone');
    expect(surfaceOf('physics_window_glass')).toBe('glass');
    expect(surfaceOf('physics_group_plastic_barrel')).toBe('soft');
    expect(surfaceOf('physics_group_plastic_milkcrate')).toBe('soft');
  });

  it("reads every group of the ten maps' hull.glb (2026-10-25 assets) as its material", () => {
    const all: [string, string][] = [
      ['physics_blocksound_window_glass', 'glass'],
      ['physics_ConditionallySolid_foliage', 'soft'],
      ['physics_group', 'stone'],
      ['physics_group_boulder', 'stone'],
      ['physics_group_brass_bell_large', 'metal'],
      ['physics_group_brass_bell_medium', 'metal'],
      ['physics_group_brass_bell_small', 'metal'],
      ['physics_group_brass_bell_smallest', 'metal'],
      ['physics_group_brass_bell_smallest_g', 'metal'],
      ['physics_group_brick', 'stone'],
      ['physics_group_canister', 'metal'],
      ['physics_group_cardboard', 'soft'],
      ['physics_group_carpet', 'soft'],
      ['physics_group_chainlink', 'metal'],
      ['physics_group_clay', 'stone'],
      ['physics_group_cloth', 'soft'],
      ['physics_group_computer', 'metal'],
      ['physics_group_concrete', 'stone'],
      ['physics_group_concrete_block', 'stone'],
      ['physics_group_concrete_polished', 'stone'],
      ['physics_group_dirt', 'dirt'],
      ['physics_group_glass', 'glass'],
      ['physics_group_glassbottle', 'glass'],
      ['physics_group_metal', 'metal'],
      ['physics_group_metal_barrel', 'metal'],
      ['physics_group_metal_box', 'metal'],
      ['physics_group_metal_dumpster', 'metal'],
      ['physics_group_metalgrate', 'metal'],
      ['physics_group_metalpanel', 'metal'],
      ['physics_group_metal_sand_barrel', 'metal'],
      ['physics_group_metal_sheetmetal', 'metal'],
      ['physics_group_metalvehicle', 'metal'],
      ['physics_group_metalvent', 'metal'],
      ['physics_group_no_decal', 'nodecal'],
      ['physics_group_paintcan', 'metal'],
      ['physics_group_paper', 'soft'],
      ['physics_group_papercup', 'soft'],
      ['physics_group_plaster', 'stone'],
      ['physics_group_plastic', 'soft'],
      ['physics_group_plastic_barrel', 'soft'],
      ['physics_group_plasticbottle', 'soft'],
      ['physics_group_plastic_box', 'soft'],
      ['physics_group_plastic_milkcrate', 'soft'],
      ['physics_group_porcelain', 'stone'],
      ['physics_group_pottery', 'stone'],
      ['physics_group_potterylarge', 'stone'],
      ['physics_group_rock', 'stone'],
      ['physics_group_rubber', 'soft'],
      ['physics_group_rubbertire', 'soft'],
      ['physics_group_sand', 'dirt'],
      ['physics_group_sheetrock', 'stone'],
      ['physics_group_solidmetal', 'metal'],
      ['physics_group_tile', 'stone'],
      ['physics_group_upholstery', 'soft'],
      ['physics_group_vrf_unknown_key_2214245875', 'stone'],
      ['physics_group_vrf_unknown_key_2838185980', 'stone'],
      ['physics_group_wood', 'wood'],
      ['physics_group_wood_basket', 'wood'],
      ['physics_group_wood_crate', 'wood'],
      ['physics_group_wood_dense', 'wood'],
      ['physics_group_wood_furniture', 'wood'],
      ['physics_group_wood_panel', 'wood'],
      ['physics_group_wood_plank', 'wood'],
      ['physics_group_wood_solid', 'wood'],
      ['physics_group_wood_tree', 'wood'],
      ['physics_ladder_passbullets_wood_ladder', 'pass'],
      ['physics_passbullets', 'pass'],
      ['physics_passbullets_chainlink', 'pass'],
      ['physics_passbullets_glass', 'pass'],
      ['physics_passbullets_metal', 'pass'],
      ['physics_passbullets_metalgrate', 'pass'],
      ['physics_passbullets_pottery', 'pass'],
      ['physics_passbullets_vrf_unknown_key_2838185980', 'pass'],
      ['physics_passbullets_window_chainlink', 'pass'],
      ['physics_passbullets_wood', 'pass'],
      ['physics_window', 'glass'],
      ['physics_window_concrete', 'stone'],
      ['physics_window_glass', 'glass'],
      ['physics_window_water', 'glass'],
    ];
    for (const [name, surface] of all)
      expect(surfaceOf(name), name).toBe(surface);
  });

  it('takes the first match: a bullet passes a passbullets group whatever it is made of', () => {
    expect(surfaceOf('physics_passbullets_metal')).toBe('pass');
    expect(surfaceOf('physics_passbullets_window_chainlink')).toBe('pass');
    expect(surfaceOf('physics_group_chainlink')).toBe('metal');
    expect(surfaceOf('physics_group_wood_crate')).toBe('wood');
    expect(surfaceOf('physics_group_sand')).toBe('dirt');
    // three.js names a second node of the same name `<name>_1`.
    expect(surfaceOf('physics_group_metal_1')).toBe('metal');
    expect(surfaceOf('')).toBe('stone');
  });

  it("indexes the surfaces for the hull's attribute, nodecal last so the others keep their index", () => {
    expect(SURFACES).toEqual([
      'stone',
      'metal',
      'wood',
      'glass',
      'dirt',
      'soft',
      'pass',
      'nodecal',
    ]);
  });
});
