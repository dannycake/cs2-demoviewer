import { describe, expect, it } from 'vitest';
import {
  familyOf,
  isSuppressed,
  muzzleClass,
  normaliseWeapon,
  WEAPON_CLIP_SUFFIX,
  WEAPON_SHOOT_CLIP,
  weaponClip,
  weaponName,
} from '../src/sim/weapons';

describe('normaliseWeapon', () => {
  it('strips the event prefix and folds the spellings the pack uses', () => {
    const cases: [string, string][] = [
      ['weapon_ak47', 'ak47'],
      ['ak47', 'ak47'],
      ['weapon_m4a1', 'm4a4'],
      ['weapon_m4a1_silencer', 'm4a1s'],
      ['weapon_usp_silencer', 'usp'],
      ['usp_silencer', 'usp'],
      ['weapon_incgrenade', 'incendiary'],
      ['weapon_knife', 'knife'],
      ['weapon_knife_t', 'knife'],
      ['knife_karambit', 'knife'],
      ['bayonet', 'knife'],
      ['weapon_glock', 'glock'],
      ['glock18', 'glock'],
      ['weapon_hkp2000', 'hkp2000'],
      ['weapon_taser', 'taser'],
      ['weapon_healthshot', 'healthshot'],
      ['weapon_c4', 'c4'],
      ['none', 'none'],
      ['weapon_newgun', 'newgun'],
      // The track column's display names.
      ['AK-47', 'ak47'],
      ['M4A1-S', 'm4a1s'],
      ['M4A4', 'm4a4'],
      ['USP-S', 'usp'],
      ['Glock-18', 'glock'],
      ['Desert Eagle', 'deagle'],
      ['Dual Berettas', 'elite'],
      ['Zeus x27', 'taser'],
      ['PP-Bizon', 'bizon'],
      ['SG 553', 'sg556'],
      ['SSG 08', 'ssg08'],
      ['Galil AR', 'galilar'],
      ['Five-SeveN', 'fiveseven'],
      ['High Explosive Grenade', 'hegrenade'],
      ['Incendiary Grenade', 'incendiary'],
      ['Smoke Grenade', 'smokegrenade'],
      ['Decoy Grenade', 'decoy'],
      ['C4 Explosive', 'c4'],
      ['knife_t', 'knife'],
      ['Karambit', 'knife'],
      ['Shadow Daggers', 'knife'],
      ['M9 Bayonet', 'knife'],
      ['CZ75-Auto', 'cz75a'],
      ['R8 Revolver', 'revolver'],
    ];
    for (const [input, want] of cases)
      expect(normaliseWeapon(input), input).toBe(want);
  });
});

describe('weaponName', () => {
  it('names a weapon as the game does, whatever the spelling', () => {
    const cases: [string, string][] = [
      ['ak47', 'AK-47'],
      ['m4a1', 'M4A4'],
      ['m4a1_silencer', 'M4A1-S'],
      ['usp_silencer', 'USP-S'],
      ['hkp2000', 'P2000'],
      ['weapon_deagle', 'Desert Eagle'],
      ['galilar', 'Galil AR'],
      ['sg556', 'SG 553'],
      ['elite', 'Dual Berettas'],
      ['taser', 'Zeus x27'],
      ['M4A1-S', 'M4A1-S'],
    ];
    for (const [name, shown] of cases)
      expect(weaponName(name), name).toBe(shown);
  });

  it('has no name for what the game does not', () => {
    expect(weaponName('knife')).toBeNull();
    expect(weaponName('inferno')).toBeNull();
    expect(weaponName('newgun')).toBeNull();
  });
});

describe('familyOf', () => {
  it('sorts weapons into the five clip families', () => {
    for (const w of [
      'ak47',
      'awp',
      'mp9',
      'nova',
      'm249',
      'ssg08',
      'newgun',
      'none',
    ])
      expect(familyOf(w), w).toBe('rifle');
    for (const w of [
      'glock',
      'usp',
      'deagle',
      'taser',
      'healthshot',
      'elite',
      'revolver',
    ])
      expect(familyOf(w), w).toBe('pistol');
    expect(familyOf('knife')).toBe('knife');
    expect(familyOf('c4')).toBe('c4');
    for (const w of [
      'flashbang',
      'hegrenade',
      'smokegrenade',
      'molotov',
      'incendiary',
      'decoy',
    ])
      expect(familyOf(w), w).toBe('grenade');
  });
});

describe('weaponClip', () => {
  it('names the per-weapon clips, with the known exceptions', () => {
    expect(weaponClip('shoot', 'ak47')).toBe('shoot_ak');
    expect(weaponClip('reload', 'ak47')).toBe('reload_ak');
    expect(weaponClip('draw', 'm4a1s')).toBe('draw_m4a1s');
    expect(weaponClip('idle', 'hkp2000')).toBe('idle_hkp');
    expect(weaponClip('shoot', 'cz75a')).toBe('shoot_cz75');
    expect(weaponClip('shoot', 'elite')).toBe('shoot_right1_elite');
    expect(weaponClip('reload', 'aug')).toBeNull();
    expect(weaponClip('reload', 'taser')).toBeNull();
    expect(weaponClip('shoot', 'taser')).toBe('shoot_taser');
  });

  it('falls back to the family for weapons without clips, or to null', () => {
    expect(weaponClip('idle', 'none')).toBe('idle_rifle');
    expect(weaponClip('idle', 'knife')).toBe('idle_knife');
    expect(weaponClip('idle', 'c4')).toBe('idle_c4');
    expect(weaponClip('idle', 'flashbang')).toBe('idle_grenade');
    expect(weaponClip('idle', 'molotov')).toBe('idle_molotov');
    expect(weaponClip('idle', 'incendiary')).toBe('idle_molotov');
    expect(weaponClip('shoot', 'knife')).toBe('frontswing_knife');
    expect(weaponClip('shoot', 'hegrenade')).toBe('throw_overhand_grenade');
    expect(weaponClip('shoot', 'c4')).toBeNull();
    expect(weaponClip('shoot', 'healthshot')).toBeNull();
    expect(weaponClip('reload', 'knife')).toBeNull();
    expect(weaponClip('draw', 'c4')).toBeNull();
  });

  it('agrees with the tools clip table', async () => {
    // @ts-expect-error the tools are plain ESM without declarations
    const tools = (await import('../../tools/lib/players.mjs')) as {
      WEAPON_CLIP_SUFFIX: Record<string, string>;
      WEAPON_SHOOT_CLIP: Record<string, string>;
    };
    expect(WEAPON_CLIP_SUFFIX).toEqual(tools.WEAPON_CLIP_SUFFIX);
    expect(WEAPON_SHOOT_CLIP).toEqual(tools.WEAPON_SHOOT_CLIP);
  });
});

describe('isSuppressed', () => {
  it('knows the three silenced weapons', () => {
    expect(isSuppressed('m4a1s')).toBe(true);
    expect(isSuppressed('usp')).toBe(true);
    expect(isSuppressed('mp5sd')).toBe(true);
    expect(isSuppressed('ak47')).toBe(false);
  });
});

describe('muzzleClass', () => {
  it('sorts the guns by the flash they fire; knives, grenades, the c4 and the taser fire none', () => {
    expect(muzzleClass('awp')).toBe('sniper');
    expect(muzzleClass('mag7')).toBe('shotgun');
    expect(muzzleClass('negev')).toBe('mg');
    expect(muzzleClass('usp')).toBe('pistol');
    expect(muzzleClass('mp5sd')).toBe('smg');
    expect(muzzleClass('m4a1s')).toBe('rifle');
    expect(muzzleClass('knife')).toBeNull();
    expect(muzzleClass('taser')).toBeNull();
    expect(muzzleClass('hegrenade')).toBeNull();
    expect(muzzleClass('c4')).toBeNull();
  });

  it('gives every gun with a clip of its own a class (all but the taser)', () => {
    const guns = Object.keys(WEAPON_CLIP_SUFFIX).filter((w) => w !== 'taser');
    expect(guns).toHaveLength(34);
    for (const w of guns) expect(muzzleClass(w), w).not.toBeNull();
  });
});
