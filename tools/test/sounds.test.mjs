import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseKv3 } from '../lib/kv3.mjs';
import { assetsDir } from '../lib/paths.mjs';
import { WEAPON_NAMES } from '../lib/weapons.mjs';
import { TYPICAL_MATCH } from '../lib/viewmodels.mjs';
import {
  SOUND_DIRS, SOUNDEVENT_FILES, STATIC_SOUNDS, WEAPON_SOUNDS,
  resolveLayers, stepSets, surfaceOfNode, typicalMatchBanks, weaponSoundKeys,
} from '../lib/sounds.mjs';

const events = (...names) => Object.fromEntries(names.map((n) => [n, { vsnd_files_track_01: [`sounds/${n}.vsnd`] }]));

describe('the tables', () => {
  it('has one WEAPON_SOUNDS entry per held gun, knife and taser, none for grenades, c4 or healthshot', () => {
    const none = new Set(['c4', 'healthshot', 'hegrenade', 'flashbang', 'smokegrenade', 'molotov', 'incendiary', 'decoy']);
    expect(Object.keys(WEAPON_SOUNDS).sort()).toEqual(WEAPON_NAMES.filter((n) => !none.has(n)));
  });

  it('names its sources and every static key once', () => {
    expect(SOUNDEVENT_FILES).toContain('soundevents/game_sounds_weapons');
    expect(SOUND_DIRS).toEqual(['sounds/weapons/', 'sounds/player/']);
    expect(STATIC_SOUNDS['throw:decoy']).toEqual({ event: 'Decoy.Throw', bank: 'grenade_decoy' });
    expect(STATIC_SOUNDS['bounce:decoy'].event).toBe('HEGrenade.Bounce');
    expect(STATIC_SOUNDS['bounce:incendiary'].bank).toBe('grenade_fire');
    expect(STATIC_SOUNDS['fire:loop']).toEqual({ event: 'Inferno.Loop', bank: 'grenade_fire', loop: true });
    expect(STATIC_SOUNDS['death:helmet'].event).toBe('Player.DeathHeadShot.Dink');
    expect(STATIC_SOUNDS['death:head'].event).toBe('Player.DeathHeadShot.Onlooker');
    expect(STATIC_SOUNDS['round:ct'].event).toBe('Event.CTWin');
    expect(Object.keys(STATIC_SOUNDS)).toHaveLength(6 * 2 + 3 + 4 + 6 + 8 + 7);
  });
});

describe('resolveLayers', () => {
  it('lets a child with a base take the parent curve and keep its own files', () => {
    const ev = {
      Parent: { vsnd_files_track_01: ['p.vsnd'], volume: 0.5, distance_volume_mapping_curve: [[30, 1, 0, 0]] },
      Child: { base: 'Parent', vsnd_files_track_01: ['c1.vsnd', 'c2.vsnd'], pitch: 1.1 },
    };
    expect(resolveLayers(ev, 'Child')).toEqual([{
      files: ['c1.vsnd', 'c2.vsnd'], volume: 0.5, volumeRandom: [0, 0], pitch: 1.1, pitchRandom: [0, 0],
      curve: [[30, 1]], offset: [0, 0, 0],
    }]);
  });

  it('adds a layer per soundevent_0N child, in order, after the event itself', () => {
    const ev = {
      'Weapon_X.Single': { vsnd_files_track_01: ['a', 'b', 'c'], soundevent_01: 'Weapon_X.SingleDistant', soundevent_02: '' },
      'Weapon_X.SingleDistant': {
        vsnd_files_track_01: ['far'], volume_random_min: 0.1, volume_random_max: 0.2,
        pitch_random_min: 0.9, pitch_random_max: 1.1, position_offset: [0, 0, 60],
      },
    };
    const layers = resolveLayers(ev, 'Weapon_X.Single');
    expect(layers.map((l) => l.files)).toEqual([['a', 'b', 'c'], ['far']]);
    expect(layers[1].volumeRandom).toEqual([0.1, 0.2]);
    expect(layers[1].pitchRandom).toEqual([0.9, 1.1]);
    expect(layers[1].offset).toEqual([0, 0, 60]);
  });

  it('reads soundevent_0N as an array of names, one layer each, and files as a bare string', () => {
    const ev = {
      A: { vsnd_files_track_01: 'a', soundevent_01: ['B', 'C', ''] },
      B: { vsnd_files_track_01: ['b'] },
      C: { vsnd_files_track_01: 'c' },
    };
    expect(resolveLayers(ev, 'A').map((l) => l.files)).toEqual([['a'], ['b'], ['c']]);
  });

  it('stops at a self-referencing child, a base cycle and depth 4', () => {
    const self = { A: { vsnd_files_track_01: ['a'], soundevent_01: 'A' } };
    expect(resolveLayers(self, 'A')).toHaveLength(1);
    const loop = { A: { vsnd_files_track_01: ['a'], base: 'B' }, B: { base: 'A', volume: 0.3 } };
    expect(resolveLayers(loop, 'A')[0].volume).toBe(0.3);
    const chain = {};
    for (let n = 0; n < 8; n++) chain[`E${n}`] = { vsnd_files_track_01: [`f${n}`], soundevent_01: `E${n + 1}` };
    expect(resolveLayers(chain, 'E0').map((l) => l.files[0])).toEqual(['f0', 'f1', 'f2', 'f3']);
  });

  it('sorts the curve by distance, takes two numbers a point and skips empty points', () => {
    const ev = { A: { vsnd_files_track_01: ['a'], distance_volume_mapping_curve: [[30, 1, 0.1, 0.1], [], [25, 0.8, 0, 0]] } };
    expect(resolveLayers(ev, 'A')[0].curve).toEqual([[25, 0.8], [30, 1]]);
  });

  it('skips curve points whose first two entries are not numbers', () => {
    const ev = { A: { vsnd_files_track_01: ['a'], distance_volume_mapping_curve: [['x', 1], [30, 1], [5]] } };
    expect(resolveLayers(ev, 'A')[0].curve).toEqual([[30, 1]]);
  });

  it('drops a layer without files and returns nothing for an unknown event', () => {
    expect(resolveLayers({ A: { volume: 1 } }, 'A')).toEqual([]);
    expect(resolveLayers({}, 'Nope')).toEqual([]);
  });

  it('reads KV3 text end to end', () => {
    const ev = parseKv3('{ A = { vsnd_files_track_01 = [ "x", ] distance_volume_mapping_curve = [ [ ], [ 30.0, 1.0, 0.0, 0.0, ], ] } }');
    expect(resolveLayers(ev, 'A')[0].curve).toEqual([[30, 1]]);
  });
});

describe('stepSets', () => {
  const walk = (...pairs) => pairs.map(([surfacePropertyName, walkleft]) => ({ surfacePropertyName, walkleft, walkright: walkleft }));
  const footsteps = {
    ct_player: {
      SurfacePropertiesList: walk(['plaster', 'CT_Concrete.StepLeft'], ['rock', 'CT_Dirt.StepLeft'],
        ['MetalGrate', 'CT_MetalGrate.StepLeft']),
    },
    t_player: { SurfacePropertiesList: walk(['plaster', 'T_Concrete.StepLeft']) },
  };
  const vsurf = {
    SurfacePropertiesList: [
      { surfacePropertyName: 'Plaster', m_nameHash: 111 },
      { surfacePropertyName: 'rock', m_nameHash: 222 },
      { surfacePropertyName: 'boulder', base: 'rock', m_nameHash: 333 },
      { surfacePropertyName: 'mystery', m_nameHash: 444 },
      { surfacePropertyName: 'metalgrate', m_nameHash: 555 },
    ],
  };
  const ev = events('CT_Concrete.StepLeft', 'T_Concrete.StepLeft', 'Land_Concrete.StepLeft', 'CT_Dirt.StepLeft',
    'Land_Dirt.StepLeft', 'CT_Default.StepLeft', 'Land_Default.StepLeft', 'CT_MetalGrate.StepLeft');
  const out = stepSets(footsteps, vsurf, ev);

  it('maps a surface to the set its ct_player walkleft names', () => {
    expect(out.surfaces.plaster).toBe('concrete');
  });

  it('follows base for a surface with no entry, and falls back to default', () => {
    expect(out.surfaces.boulder).toBe('dirt');
    expect(out.surfaces.mystery).toBe('default');
  });

  it('aliases each surface under vrf_unknown_key_<m_nameHash>', () => {
    expect(out.surfaces.vrf_unknown_key_111).toBe('concrete');
    expect(out.surfaces.vrf_unknown_key_333).toBe('dirt');
    expect(out.surfaces.vrf_unknown_key_444).toBe('default');
  });

  it('makes ct, t and land keys, the t one falling back to the ct one', () => {
    expect(out.keys['step:concrete:ct']).toEqual({ event: 'CT_Concrete.StepLeft', bank: 'steps_concrete' });
    expect(out.keys['step:concrete:t'].event).toBe('T_Concrete.StepLeft');
    expect(out.keys['step:dirt:t'].event).toBe('CT_Dirt.StepLeft');
    expect(out.keys['land:concrete'].event).toBe('Land_Concrete.StepLeft');
    expect(out.keys['step:default:ct'].bank).toBe('steps_default');
  });

  it('falls back to Land_Default when a set has no landing event', () => {
    expect(out.surfaces.metalgrate).toBe('metalgrate');
    expect(out.keys['land:metalgrate']).toEqual({ event: 'Land_Default.StepLeft', bank: 'steps_metalgrate' });
  });
});

describe('weaponSoundKeys', () => {
  const k = (e) => weaponSoundKeys(e);

  it('gives a gun its shot and reload keys', () => {
    const out = k(events('Weapon_AK47.Single', 'Weapon_AK47.Clipout', 'Weapon_AK47.Clipin', 'Weapon_AK47.BoltPull'));
    expect(out).toEqual({
      'shot:ak47': { event: 'Weapon_AK47.Single', bank: 'weapon_ak47' },
      'reload:ak47:out': { event: 'Weapon_AK47.Clipout', bank: 'weapon_ak47' },
      'reload:ak47:in': { event: 'Weapon_AK47.Clipin', bank: 'weapon_ak47' },
      'reload:ak47:bolt': { event: 'Weapon_AK47.BoltPull', bank: 'weapon_ak47' },
    });
  });

  it('takes the shell insert for a shotgun, with no out', () => {
    const out = k(events('Weapon_XM1014.Single', 'Weapon_XM1014.InsertShell'));
    expect(out['reload:xm1014:in'].event).toBe('Weapon_XM1014.InsertShell');
    expect(out).not.toHaveProperty('reload:xm1014:out');
    expect(out).not.toHaveProperty('reload:xm1014:bolt');
  });

  it('uses the CZ prefix for the cz75a reload, M4A1 for the m4a4, and the silenced shots', () => {
    const out = k(events('Weapon_CZ75A.Single', 'Weapon_CZ.Clipout', 'Weapon_CZ75A.Clipout', 'Weapon_M4A4.Single',
      'Weapon_M4A1.Clipout', 'Weapon_M4A1.Silenced', 'Weapon_M4A1S.Boltback', 'Weapon_M4A1S.BoltBack', 'Weapon_USP.SilencedShot'));
    expect(out['reload:cz75a:out'].event).toBe('Weapon_CZ.Clipout');
    expect(out['reload:m4a4:out'].event).toBe('Weapon_M4A1.Clipout');
    expect(out['shot:m4a1s:silenced']).toEqual({ event: 'Weapon_M4A1.Silenced', bank: 'weapon_m4a1s' });
    expect(out['reload:m4a1s:bolt'].event).toBe('Weapon_M4A1S.BoltBack');
    expect(out['shot:usp:silenced'].event).toBe('Weapon_USP.SilencedShot');
  });

  it('gives knives the slash, and the terrorist knife the CT knife bank', () => {
    const out = k(events('Weapon_Knife.Slash'));
    expect(out['shot:knife']).toEqual({ event: 'Weapon_Knife.Slash', bank: 'weapon_knife' });
    expect(out['shot:knife_t']).toEqual({ event: 'Weapon_Knife.Slash', bank: 'weapon_knife' });
  });

  it('leaves out what the events lack', () => {
    expect(k({})).toEqual({});
  });
});

describe('surfaceOfNode', () => {
  it("reads the surface from a hull node's name, past its physics_ prefixes", () => {
    expect(surfaceOfNode('physics_group_wood_plank')).toBe('wood_plank');
    expect(surfaceOfNode('physics_group')).toBe('default');
    expect(surfaceOfNode('physics_passbullets_vrf_unknown_key_2838185980')).toBe('vrf_unknown_key_2838185980');
    expect(surfaceOfNode('physics_window_glass')).toBe('glass');
    expect(surfaceOfNode('physics_ladder_passbullets_wood_ladder')).toBe('wood_ladder');
    expect(surfaceOfNode('physics_passbullets_window_chainlink')).toBe('chainlink');
    expect(surfaceOfNode('physics_passbullets')).toBe('default');
  });

  it("reads Train's names as the web app does: any case, and past blocksound and conditionallysolid", () => {
    expect(surfaceOfNode('physics_ConditionallySolid_foliage')).toBe('foliage');
    expect(surfaceOfNode('physics_blocksound_window_glass')).toBe('glass');
    expect(surfaceOfNode('Physics_Group_Metal')).toBe('metal');
    expect(surfaceOfNode('physics_conditionallysolid')).toBe('default');
  });

  it('is null for a node that is not a physics group', () => {
    expect(surfaceOfNode('world')).toBeNull();
    expect(surfaceOfNode('group_concrete')).toBeNull();
    expect(surfaceOfNode('')).toBeNull();
  });
});

describe('typicalMatchBanks', () => {
  // Every weapon's shot and clip-out, the static sounds, and four step sets, as build.json has them.
  const weaponEvents = Object.fromEntries(Object.values(WEAPON_SOUNDS).flatMap((d) => ['.Single', '.Slash', '.Clipout'].map((s) => [d.shot + s, {}])));
  const sounds = Object.fromEntries(Object.entries({ ...STATIC_SOUNDS, ...weaponSoundKeys(weaponEvents) }).map(([k, v]) => [k, { bank: v.bank, layers: [] }]));
  for (const set of ['concrete', 'default', 'metalrailing', 'wood']) {
    for (const key of [`step:${set}:ct`, `step:${set}:t`, `land:${set}`]) sounds[key] = { bank: `steps_${set}`, layers: [] };
  }
  const surfaces = { concrete: 'concrete', default: 'default', plaster: 'concrete', vrf_unknown_key_2838185980: 'metalrailing', wood: 'wood' };
  const nodes = ['physics_group_plaster', 'physics_group', 'physics_passbullets_vrf_unknown_key_2838185980', 'physics_group_brandnew', 'world', 'physics_group_plaster'];

  it("names the weapons' banks, the static banks and the step set of each surface the hull names", () => {
    const b = typicalMatchBanks({ sounds, surfaces }, ['ak47', 'knife', 'knife_t', 'usp', 'hegrenade', 'c4'], nodes);
    expect(b.weapons).toEqual(['weapon_ak47', 'weapon_knife', 'weapon_usp']);
    expect(b.fixed).toEqual(['bomb', 'grenade_decoy', 'grenade_fire', 'grenade_flash', 'grenade_he', 'grenade_smoke', 'player', 'round']);
    // plaster steps on concrete, physics_group and a surface the table lacks on default; no wood.
    expect(b.steps).toEqual(['steps_concrete', 'steps_default', 'steps_metalrailing']);
  });

  it('gives TYPICAL_MATCH its 15 guns and the knife, and no step set without a hull', () => {
    const b = typicalMatchBanks({ sounds, surfaces }, TYPICAL_MATCH, null);
    expect(b.weapons).toHaveLength(16);
    expect(b.weapons).toContain('weapon_knife');
    expect(b.weapons).not.toContain('weapon_nova');
    expect(b.steps).toEqual([]);
  });
});

// Real data: once the rip has run (assets/raw/sounds/rip.json), or from SOUNDS_RAW_DIR, a
// directory laid out like the rip (the VPK paths: soundevents/..., surfaceproperties/...).
const raw = process.env.SOUNDS_RAW_DIR || path.join(assetsDir(), 'raw', 'sounds');
const ripped = Boolean(process.env.SOUNDS_RAW_DIR) || fs.existsSync(path.join(raw, 'rip.json'));

describe.skipIf(!ripped)('against the ripped soundevents', () => {
  const text = (rel) => fs.readFileSync(path.join(raw, rel), 'utf8');
  let memo;
  const read = () => {
    if (!memo) {
      memo = {};
      for (const f of SOUNDEVENT_FILES) Object.assign(memo, parseKv3(text(`${f}.vsndevts`)));
    }
    return memo;
  };

  it('resolves every static and typical-match weapon event to a layer with files', () => {
    const all = read();
    const keys = { ...STATIC_SOUNDS };
    for (const [key, v] of Object.entries(weaponSoundKeys(all))) {
      if (TYPICAL_MATCH.includes(key.split(':')[1])) keys[key] = v;
    }
    for (const weapon of TYPICAL_MATCH.filter((w) => w in WEAPON_SOUNDS)) {
      expect(keys[`shot:${weapon}`], weapon).toBeDefined();
    }
    for (const [key, { event }] of Object.entries(keys)) {
      const layers = resolveLayers(all, event);
      expect(layers.length, key).toBeGreaterThanOrEqual(1);
      expect(layers[0].files.length, key).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives shot:ak47 two layers of 3 files and 1 file', () => {
    const all = read();
    const layers = resolveLayers(all, weaponSoundKeys(all)['shot:ak47'].event);
    expect(layers.map((l) => l.files.length)).toEqual([3, 1]);
  });

  it('maps plaster to concrete', () => {
    const { surfaces, keys } = stepSets(
      parseKv3(text('scripts/surfaceproperties_footsteps.txt')),
      parseKv3(text('surfaceproperties/surfaceproperties.vsurf')),
      read(),
    );
    expect(surfaces.plaster).toBe('concrete');
    expect(new Set(Object.values(surfaces)).size).toBeGreaterThan(5);
    const all = read();
    for (const [key, { event }] of Object.entries(keys)) expect(all, key).toHaveProperty([event]);
  });
});
