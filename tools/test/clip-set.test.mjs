import { describe, expect, test } from 'vitest';
import { CLIP_SET, CLIPS_OPTIONAL, CLIPS_REQUESTED, CLIPS_REQUIRED, WEAPON_CLIP_SUFFIX, WEAPON_SHOOT_CLIP } from '../lib/players.mjs';

// The phase 3c animation allow list (plan Global Constraints): exact VRF short names,
// no duplicates, the required clips inside it, and the per-weapon family built from
// the suffix table so a typo in one place cannot drop a weapon's clips.
describe('CLIP_SET', () => {
  const all = Object.values(CLIP_SET).flat();

  test('every name is a VRF short name and appears once', () => {
    for (const c of all) expect(c).toMatch(/^[a-z0-9_]+$/);
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(CLIPS_REQUESTED).size).toBe(CLIPS_REQUESTED.length);
  });

  test('the required clips are requested first and the rest are optional', () => {
    for (const c of CLIPS_REQUIRED) expect(CLIPS_REQUESTED).toContain(c);
    expect(CLIPS_REQUESTED.slice(0, CLIPS_REQUIRED.length)).toEqual([...CLIPS_REQUIRED]);
    expect(CLIPS_OPTIONAL.length).toBe(CLIPS_REQUESTED.length - CLIPS_REQUIRED.length);
    for (const c of CLIPS_OPTIONAL) expect(CLIPS_REQUIRED).not.toContain(c);
  });

  test('rifle has eight run and walk directions, four crouch directions', () => {
    for (const d of ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']) {
      expect(CLIP_SET.rifle).toContain(`run_${d}_rifle`);
      expect(CLIP_SET.rifle).toContain(`walk_${d}_rifle`);
      expect(CLIP_SET.pistol).toContain(`run_${d}_pistol`);
    }
    for (const d of ['n', 'e', 's', 'w']) expect(CLIP_SET.rifle).toContain(`crouch_${d}_rifle`);
  });

  test('per-weapon clips follow the suffix table, with the known exceptions', () => {
    for (const [weapon, suffix] of Object.entries(WEAPON_CLIP_SUFFIX)) {
      expect(CLIP_SET.weapon).toContain(`idle_${suffix}`);
      expect(CLIP_SET.weapon).toContain(`draw_${suffix}`);
      expect(CLIP_SET.weapon).toContain(WEAPON_SHOOT_CLIP[weapon] ?? `shoot_${suffix}`);
    }
    expect(CLIP_SET.weapon).toContain('shoot_cz75');
    expect(CLIP_SET.weapon).toContain('shoot_right1_elite');
    expect(CLIP_SET.weapon).toContain('reload_hkp');
    expect(CLIP_SET.weapon).not.toContain('reload_aug');
    expect(CLIP_SET.weapon).not.toContain('reload_taser');
    expect(Object.keys(WEAPON_CLIP_SUFFIX)).toHaveLength(35);
  });

  test('the shared, grenade and c4 families carry the state and action clips', () => {
    for (const c of ['flashed', 'flashed_crouch', 'jump_additive_start_rifle', 'jump_additive_land_rifle', 'defuse_loop_rifle', 'flinch_head', 'flinch_chest_rear', 'flinch_molotov']) {
      expect(CLIP_SET.shared).toContain(c);
    }
    expect(CLIP_SET.grenade).toEqual(expect.arrayContaining(['pullpin_grenade', 'throw_overhand_grenade', 'throw_underhand_grenade']));
    expect(CLIP_SET.c4).toEqual(['idle_c4', 'planting', 'planting_crouch']);
  });

  test('the list is about ninety clips per model plus the per-weapon set', () => {
    const base = all.length - CLIP_SET.weapon.length;
    expect(base).toBeGreaterThanOrEqual(85);
    expect(base).toBeLessThanOrEqual(110);
    expect(CLIP_SET.weapon.length).toBe(35 * 4 - 2);
  });
});
