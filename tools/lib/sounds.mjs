// Which CS2 sounds the viewer plays and how to read them. The tables say which soundevent
// stands behind each sound key (`shot:ak47`, `step:concrete:ct`, `bomb:plant`) and which
// bank it is packed into; the functions turn the decompiled soundevents (parseKv3, an object
// of event name to fields) into those keys and into the layers of one event: its files, its
// volume and pitch with their random spreads, its distance curve and its position offset.
// The rip decompiles SOUNDEVENT_FILES and exports the files under SOUND_DIRS.

/** Soundevent files (under the VPK root, no extension) the rip decompiles. */
export const SOUNDEVENT_FILES = Object.freeze([
  'soundevents/game_sounds_weapons',
  'soundevents/game_sounds_footsteps',
  'soundevents/game_sounds_player',
  'soundevents/game_sounds_ui',
  'soundevents/vo/announcer/game_sounds_cs2_classic',
]);

/** Directories whose every sound file is exported. */
export const SOUND_DIRS = Object.freeze(['sounds/weapons/', 'sounds/player/']);

const GRENADE_BANKS = {
  he: ['HEGrenade', 'grenade_he'],
  flash: ['Flashbang', 'grenade_flash'],
  smoke: ['SmokeGrenade', 'grenade_smoke'],
  molotov: ['Molotov', 'grenade_fire'],
  incendiary: ['IncGrenade', 'grenade_fire'],
  decoy: ['Decoy', 'grenade_decoy'],
};

const entries = {};
const add = (key, event, bank, loop) => {
  entries[key] = loop ? { event, bank, loop: true } : { event, bank };
};

for (const [kind, [prefix, bank]] of Object.entries(GRENADE_BANKS)) {
  add(`throw:${kind}`, `${prefix}.Throw`, bank);
  // CS2 has no Decoy.Bounce: the decoy bounces like a high explosive.
  add(`bounce:${kind}`, kind === 'decoy' ? 'HEGrenade.Bounce' : `${prefix}.Bounce`, bank);
}
add('explode:he', 'BaseGrenade.Explode', 'grenade_he');
add('explode:flash', 'Flashbang.Explode', 'grenade_flash');
add('smoke:emit', 'BaseSmokeEffect.Sound', 'grenade_smoke');
add('fire:start:molotov', 'Molotov.Start', 'grenade_fire');
add('fire:start:incendiary', 'IncGrenade.Start', 'grenade_fire');
add('fire:loop', 'Inferno.Loop', 'grenade_fire', true);
add('fire:out', 'Inferno.FadeOut', 'grenade_fire');
for (const [key, event] of [
  ['initiate', 'c4.initiate'], ['plant', 'c4.plant'], ['beep', 'C4.PlantSound'],
  ['defuse', 'c4.disarmstart'], ['defused', 'c4.disarmfinish'], ['explode', 'c4.explode'],
]) add(`bomb:${key}`, event, 'bomb');
for (const [kind, part] of [['body', 'Body'], ['armor', 'BodyArmor'], ['head', 'HeadShot'], ['helmet', 'HeadShotArmor']]) {
  add(`hit:${kind}`, `Player.Damage${part}.Onlooker`, 'player');
  // DeathHeadShotArmor.Onlooker is a body thud; the helmet's dink is the one worth hearing.
  add(`death:${kind}`, kind === 'helmet' ? 'Player.DeathHeadShot.Dink' : `Player.Death${part}.Onlooker`, 'player');
}
for (const [key, event] of [
  ['beep', 'UI.CounterBeep'], ['go', 'UI.CounterDoneBeep'], ['ct', 'Event.CTWin'], ['t', 'Event.TERWin'],
  ['draw', 'Event.RoundDraw'], ['planted', 'Event.BombPlanted'], ['defused', 'Event.BombDefused'],
]) add(`round:${key}`, event, 'round');

/**
 * Sounds with one fixed event, by key. Grenade kinds are the pack's `Grenade['kind']`.
 * The fire loop's WAV has no sidecar, so the loop flag comes from here.
 * @type {Readonly<Record<string, {event: string, bank: string, loop?: true}>>}
 */
export const STATIC_SOUNDS = Object.freeze(entries);

// Per weapon: `shot` is the event prefix (`<shot>.Single`); `reload` the prefix of the
// reload events when CS2 files them under another name; `bolt` the same for the bolt
// event; `silenced` a whole event name.
const W = (shot, extra = {}) => ({ shot: `Weapon_${shot}`, ...extra });
const R = (reload) => `Weapon_${reload}`;

/**
 * CS2 event prefixes per weapon name of lib/weapons.mjs: the guns, both knives and the
 * taser. Grenades, c4 and healthshot have no weapon sounds of their own.
 * @type {Readonly<Record<string, {shot: string, silenced?: string, reload?: string, bolt?: string}>>}
 */
export const WEAPON_SOUNDS = Object.freeze({
  ak47: W('AK47'),
  aug: W('AUG'),
  awp: W('AWP'),
  bizon: W('bizon'),
  cz75a: W('CZ75A', { reload: R('CZ') }),
  deagle: W('DEagle'),
  elite: W('ELITE'),
  famas: W('FAMAS'),
  fiveseven: W('FiveSeven'),
  g3sg1: W('G3SG1'),
  galilar: W('GalilAR'),
  glock: W('Glock'),
  hkp2000: W('hkp2000'),
  knife: W('Knife'),
  knife_t: W('Knife'),
  m249: W('M249'),
  m4a1s: W('M4A1', { silenced: 'Weapon_M4A1.Silenced', bolt: R('M4A1S') }),
  m4a4: W('M4A4', { reload: R('M4A1') }),
  mac10: W('MAC10'),
  mag7: W('Mag7'),
  mp5sd: W('MP5'),
  mp7: W('MP7'),
  mp9: W('MP9'),
  negev: W('Negev'),
  nova: W('Nova'),
  p250: W('P250'),
  p90: W('P90'),
  revolver: W('Revolver'),
  sawedoff: W('Sawedoff'),
  scar20: W('SCAR20'),
  sg556: W('sg556'),
  ssg08: W('SSG08'),
  taser: W('Taser'),
  tec9: W('tec9'),
  ump45: W('UMP45'),
  usp: W('USP', { silenced: 'Weapon_USP.SilencedShot' }),
  xm1014: W('XM1014'),
});

const isKnife = (weapon) => weapon === 'knife' || weapon === 'knife_t';
const first = (events, names) => names.find((n) => Object.hasOwn(events, n));

/**
 * The weapon sound keys the events can satisfy: `shot:<w>`, `shot:<w>:silenced`,
 * `reload:<w>:out|in|bolt`. A part the events lack is left out.
 * @param {Record<string, object>} events
 * @returns {Record<string, {event: string, bank: string}>}
 */
export function weaponSoundKeys(events) {
  const keys = {};
  for (const [weapon, def] of Object.entries(WEAPON_SOUNDS)) {
    const bank = `weapon_${isKnife(weapon) ? 'knife' : weapon}`;
    const put = (key, event) => {
      if (event) keys[key] = { event, bank };
    };
    put(`shot:${weapon}`, first(events, [isKnife(weapon) ? `${def.shot}.Slash` : `${def.shot}.Single`]));
    if (def.silenced) put(`shot:${weapon}:silenced`, first(events, [def.silenced]));
    const reload = def.reload ?? def.shot;
    const bolt = def.bolt ?? reload;
    put(`reload:${weapon}:out`, first(events, [`${reload}.Clipout`]));
    put(`reload:${weapon}:in`, first(events, ['.Clipin', '.Insertshell', '.InsertShell'].map((s) => reload + s)));
    put(`reload:${weapon}:bolt`,
      first(events, ['.BoltPull', '.Boltpull', '.Slideback', '.BoltBack', '.Pump'].map((s) => bolt + s)));
  }
  return keys;
}

/**
 * Which footstep set each surface plays, and the keys of the sets. `footsteps` is the parsed
 * scripts/surfaceproperties_footsteps.txt: `ct_player` and `t_player`, each holding a
 * `SurfacePropertiesList` of `{ surfacePropertyName, walkleft, walkright }`. `vsurf` is the
 * decompiled surfaceproperties: a `SurfacePropertiesList` of `{ surfacePropertyName, base?,
 * m_nameHash }`. A surface takes the set named by its ct_player `walkleft` (`CT_Concrete.StepLeft`
 * is `concrete`), else its `base`'s, else `default`. Every surface is listed by lowercased name
 * and again as `vrf_unknown_key_<m_nameHash>`, the name VRF prints for a surface whose name it
 * cannot recover.
 *
 * A set's terrorist step is the t_player walkleft of a surface in it when there is one, else
 * T_<Set>.StepLeft, else the CT step. `events` (the soundevents) is optional: when given, it
 * decides whether T_<Set> and Land_<Set> exist (a landing falls back to Land_Default); without
 * it every event is assumed to.
 * @param {object} footsteps
 * @param {object} vsurf
 * @param {Record<string, object>} [events]
 * @returns {{surfaces: Record<string, string>, keys: Record<string, {event: string, bank: string}>}}
 */
export function stepSets(footsteps, vsurf, events) {
  const walkOf = (team) => {
    const map = new Map();
    const list = footsteps?.[team]?.SurfacePropertiesList;
    for (const s of Array.isArray(list) ? list : []) {
      if (typeof s?.surfacePropertyName === 'string' && typeof s.walkleft === 'string') {
        map.set(s.surfacePropertyName.toLowerCase(), s.walkleft);
      }
    }
    return map;
  };
  const ctWalk = walkOf('ct_player');
  const tWalk = walkOf('t_player');
  const list = Array.isArray(vsurf?.SurfacePropertiesList) ? vsurf.SurfacePropertiesList : [];
  const bases = new Map(list.map((s) => [String(s.surfacePropertyName).toLowerCase(), s.base]));

  // Set names keep the casing of the event they came from (MetalGrate), for the event names.
  const cased = new Map([['default', 'Default']]);
  const tEvent = new Map();
  const direct = (name) => {
    const m = /^CT_(.+)\.StepLeft$/i.exec(ctWalk.get(name) ?? '');
    if (!m) return null;
    const set = m[1].toLowerCase();
    cased.set(set, m[1]);
    if (tWalk.has(name) && !tEvent.has(set)) tEvent.set(set, tWalk.get(name));
    return set;
  };
  const setOf = (name, seen = new Set()) => {
    name = String(name).toLowerCase();
    if (seen.has(name)) return 'default';
    seen.add(name);
    const own = direct(name);
    if (own) return own;
    const base = bases.get(name);
    return base ? setOf(base, seen) : 'default';
  };

  const surfaces = {};
  for (const s of list) {
    const set = setOf(s.surfacePropertyName);
    surfaces[String(s.surfacePropertyName).toLowerCase()] = set;
    if (s.m_nameHash !== undefined) surfaces[`vrf_unknown_key_${s.m_nameHash}`] = set;
  }
  surfaces.default ??= 'default';

  const known = (event) => !events || Object.hasOwn(events, event);
  const keys = {};
  for (const set of new Set(Object.values(surfaces))) {
    const name = cased.get(set);
    const bank = `steps_${set}`;
    const ct = `CT_${name}.StepLeft`;
    const t = tEvent.get(set) ?? `T_${name}.StepLeft`;
    const land = `Land_${name}.StepLeft`;
    keys[`step:${set}:ct`] = { event: ct, bank };
    keys[`step:${set}:t`] = { event: known(t) ? t : ct, bank };
    keys[`land:${set}`] = { event: known(land) ? land : 'Land_Default.StepLeft', bank };
  }
  return { surfaces, keys };
}

// A hull node's words before its surface, past `physics_`: what the group is, not what it is
// made of. The same list as the web app's `surfaceOfNode` (web/src/audio/surfaces.ts).
const NODE_KIND = /^(?:ladder|group|passbullets|window|blocksound|conditionallysolid)(?:_|$)/;

/**
 * The surface a hull node stands for, from its name, in any case (VRF names a map's collision
 * groups `physics_group_<surface>`, `physics_passbullets_…`, `physics_window_…`,
 * `physics_ladder_passbullets_…`, and on Train `physics_ConditionallySolid_…` and
 * `physics_blocksound_…`): the lowercased name past `physics_` and any of `ladder`, `group`,
 * `passbullets`, `window`, `blocksound` and `conditionallysolid` with their `_`, `default` when
 * nothing is left; null for a name that does not start with `physics_`. It reads the names as
 * the web app's `surfaceOfNode` (web/src/audio/surfaces.ts) does.
 * @param {string} name
 * @returns {string | null}
 */
export function surfaceOfNode(name) {
  if (typeof name !== 'string') return null;
  const lower = name.toLowerCase();
  if (!lower.startsWith('physics_')) return null;
  let rest = lower.slice('physics_'.length);
  for (let m = NODE_KIND.exec(rest); m; m = NODE_KIND.exec(rest)) rest = rest.slice(m[0].length);
  return rest || 'default';
}

/**
 * The banks a typical match loads, each list sorted: `weapons`, the banks of the shot and reload
 * keys of `weapons` (TYPICAL_MATCH; a knife's are weapon_knife, a grenade or the bomb has none);
 * `fixed`, the banks of STATIC_SOUNDS (the five grenade banks, bomb, player and round); `steps`,
 * the step set of each surface `nodeNames` (a map hull's node names, read with surfaceOfNode)
 * names, through `surfaces`, a surface the table lacks on `default` (empty without node names).
 * @param {{sounds: Record<string, {bank: string}>, surfaces: Record<string, string>}} build  build.json or the manifest
 * @param {readonly string[]} weapons
 * @param {readonly string[] | null} nodeNames
 * @returns {{weapons: string[], fixed: string[], steps: string[]}}
 */
export function typicalMatchBanks({ sounds, surfaces }, weapons, nodeNames) {
  const banksOf = (keys) => [...new Set(keys.filter((k) => Object.hasOwn(sounds, k)).map((k) => sounds[k].bank))].sort();
  const held = new Set(weapons);
  const weaponKeys = Object.keys(sounds).filter((k) => /^(shot|reload):/.test(k) && held.has(k.split(':')[1]));
  const sets = new Set();
  for (const name of nodeNames ?? []) {
    const surface = surfaceOfNode(name);
    if (surface !== null) sets.add(Object.hasOwn(surfaces, surface) ? surfaces[surface] : 'default');
  }
  return {
    weapons: banksOf(weaponKeys),
    fixed: banksOf(Object.keys(STATIC_SOUNDS)),
    steps: banksOf([...sets].flatMap((set) => [`step:${set}:ct`, `step:${set}:t`, `land:${set}`])),
  };
}

const MAX_DEPTH = 4;
const num = (v, d) => (typeof v === 'number' ? v : d);

// The event's fields merged over its `base` chain, own fields winning.
function merged(events, name) {
  const chain = [];
  for (let n = name; typeof n === 'string' && events[n] && !chain.includes(events[n]); n = events[n].base) {
    chain.push(events[n]);
  }
  return Object.assign({}, ...chain.reverse());
}

/**
 * @typedef {object} Layer
 * @property {string[]} files
 * @property {number} volume
 * @property {[number, number]} volumeRandom
 * @property {number} pitch
 * @property {[number, number]} pitchRandom
 * @property {[number, number][] | null} curve  [units, gain], sorted by units
 * @property {[number, number, number]} offset
 */

/**
 * The layers one event plays together: the event (its fields merged over its `base` chain),
 * then a layer for each non-empty `soundevent_0N` child, depth first, to depth 4 and never
 * revisiting an event on the way down. A layer without files is dropped.
 * @param {Record<string, object>} events
 * @param {string} name
 * @returns {Layer[]}
 */
export function resolveLayers(events, name) {
  const layers = [];
  const visit = (event, path) => {
    const f = merged(events, event);
    const files = [f.vsnd_files_track_01].flat().filter((s) => typeof s === 'string' && s !== '');
    if (files.length) {
      const points = Array.isArray(f.distance_volume_mapping_curve)
        ? f.distance_volume_mapping_curve.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])).map((p) => [p[0], p[1]])
        : [];
      const offset = Array.isArray(f.position_offset) ? f.position_offset : [];
      layers.push({
        files,
        volume: num(f.volume, 1),
        volumeRandom: [num(f.volume_random_min, 0), num(f.volume_random_max, 0)],
        pitch: num(f.pitch, 1),
        pitchRandom: [num(f.pitch_random_min, 0), num(f.pitch_random_max, 0)],
        curve: points.length ? points.sort((a, b) => a[0] - b[0]) : null,
        offset: [num(offset[0], 0), num(offset[1], 0), num(offset[2], 0)],
      });
    }
    if (path.length >= MAX_DEPTH) return;
    // A child is a name or, as the files write it, an array of names; each is its own layer.
    for (const key of Object.keys(f).filter((k) => /^soundevent_\d+$/.test(k)).sort()) {
      for (const child of [f[key]].flat()) {
        if (typeof child === 'string' && child !== '' && !path.includes(child) && events[child]) {
          visit(child, [...path, child]);
        }
      }
    }
  };
  if (events[name]) visit(name, [name]);
  return layers;
}
