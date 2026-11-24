// Weapon names and families. The pack spells a weapon three ways: the track column uses the
// game's display names (`header.weapons`: "AK-47", "Dual Berettas", "Zeus x27"), shot events
// use internal names (`weapon_ak47`, `weapon_m4a1` for the M4A4, `weapon_m4a1_silencer`), and
// `item_equip` uses short names that are ambiguous for the silenced weapons (`m4a1` for both
// M4s, `hkp2000` for the USP-S), so nothing should read a weapon from `item_equip`.
// `normaliseWeapon` is the only place the spelling is handled; everything else keys on its
// output, which is also the name of the model under /weapons/ (tools/lib/weapons.mjs) and of
// the per-weapon clips (tools/lib/players.mjs).

export type Family = 'rifle' | 'pistol' | 'knife' | 'grenade' | 'c4';

/** Internal and short spellings that differ from the model and clip name. */
const ALIASES: Readonly<Record<string, string>> = {
  m4a1: 'm4a4',
  m4a1_silencer: 'm4a1s',
  usp_silencer: 'usp',
  incgrenade: 'incendiary',
  glock18: 'glock',
  cz75: 'cz75a',
};

/** The game's display names, by model and clip name. */
const NAMES: Readonly<Record<string, string>> = {
  ak47: 'AK-47',
  m4a4: 'M4A4',
  m4a1s: 'M4A1-S',
  awp: 'AWP',
  famas: 'FAMAS',
  galilar: 'Galil AR',
  aug: 'AUG',
  sg556: 'SG 553',
  ssg08: 'SSG 08',
  scar20: 'SCAR-20',
  g3sg1: 'G3SG1',
  mp9: 'MP9',
  mac10: 'MAC-10',
  mp7: 'MP7',
  mp5sd: 'MP5-SD',
  ump45: 'UMP-45',
  p90: 'P90',
  bizon: 'PP-Bizon',
  nova: 'Nova',
  xm1014: 'XM1014',
  mag7: 'MAG-7',
  sawedoff: 'Sawed-Off',
  m249: 'M249',
  negev: 'Negev',
  glock: 'Glock-18',
  usp: 'USP-S',
  hkp2000: 'P2000',
  p250: 'P250',
  fiveseven: 'Five-SeveN',
  tec9: 'Tec-9',
  cz75a: 'CZ75-Auto',
  deagle: 'Desert Eagle',
  elite: 'Dual Berettas',
  revolver: 'R8 Revolver',
  taser: 'Zeus x27',
  hegrenade: 'High Explosive Grenade',
  flashbang: 'Flashbang',
  smokegrenade: 'Smoke Grenade',
  molotov: 'Molotov',
  incendiary: 'Incendiary Grenade',
  decoy: 'Decoy Grenade',
  c4: 'C4 Explosive',
  healthshot: 'Medi-Shot',
};

/** The display names (lower case), as the track column carries them → model name. */
const DISPLAY: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(NAMES).map(([model, name]) => [name.toLowerCase(), model])
);

/** Any knife, by its internal or display name ("Karambit", "Shadow Daggers", "M9 Bayonet"). */
const KNIFE = /knife|bayonet|karambit|daggers/;

const PISTOLS: ReadonlySet<string> = new Set([
  'glock',
  'usp',
  'hkp2000',
  'p250',
  'fiveseven',
  'tec9',
  'cz75a',
  'deagle',
  'elite',
  'revolver',
  'taser',
  'healthshot',
]);

const GRENADES: ReadonlySet<string> = new Set([
  'flashbang',
  'hegrenade',
  'smokegrenade',
  'molotov',
  'incendiary',
  'decoy',
]);

/**
 * Any pack spelling → model and clip name: `weapon_m4a1` → `m4a4`, `Dual Berettas` → `elite`,
 * `weapon_knife_t` → `knife`. Unknown names come back lower-cased.
 */
export function normaliseWeapon(name: string): string {
  let n = name.trim().toLowerCase();
  const display = DISPLAY[n];
  if (display) return display;
  if (n.startsWith('weapon_')) n = n.slice(7);
  if (KNIFE.test(n)) return 'knife';
  return ALIASES[n] ?? n;
}

/** What the game calls a weapon in any pack spelling (`m4a1_silencer` → `M4A1-S`); null for
 * one it has no single name for (a knife, `inferno`) or does not know. */
export function weaponName(name: string): string | null {
  return NAMES[normaliseWeapon(name)] ?? null;
}

/** The clip family a (normalised) weapon animates with. Unknown names count as rifles. */
export function familyOf(weapon: string): Family {
  if (weapon === 'knife') return 'knife';
  if (weapon === 'c4') return 'c4';
  if (GRENADES.has(weapon)) return 'grenade';
  if (PISTOLS.has(weapon)) return 'pistol';
  return 'rifle';
}

/**
 * Per-weapon clip suffixes, the same table as tools/lib/players.mjs `WEAPON_CLIP_SUFFIX`
 * (a test keeps them equal): `shoot_<suffix>`, `reload_<suffix>`, `draw_<suffix>`,
 * `idle_<suffix>`.
 */
export const WEAPON_CLIP_SUFFIX: Readonly<Record<string, string>> = {
  ak47: 'ak',
  m4a4: 'm4a4',
  m4a1s: 'm4a1s',
  awp: 'awp',
  famas: 'famas',
  galilar: 'galilar',
  aug: 'aug',
  sg556: 'sg556',
  ssg08: 'ssg08',
  scar20: 'scar20',
  g3sg1: 'g3sg1',
  mp9: 'mp9',
  mac10: 'mac10',
  mp7: 'mp7',
  mp5sd: 'mp5sd',
  ump45: 'ump45',
  p90: 'p90',
  bizon: 'bizon',
  nova: 'nova',
  xm1014: 'xm1014',
  mag7: 'mag7',
  sawedoff: 'sawedoff',
  m249: 'm249',
  negev: 'negev',
  glock: 'glock',
  usp: 'usp',
  hkp2000: 'hkp',
  p250: 'p250',
  fiveseven: 'fiveseven',
  tec9: 'tec9',
  cz75a: 'cz75a',
  deagle: 'deagle',
  elite: 'elite',
  revolver: 'revolver',
  taser: 'taser',
};

/** Shoot clips that break the `shoot_<suffix>` pattern. */
export const WEAPON_SHOOT_CLIP: Readonly<Record<string, string>> = {
  cz75a: 'shoot_cz75',
  elite: 'shoot_right1_elite',
};

/** Weapons the game ships no reload clip for. */
const NO_RELOAD: ReadonlySet<string> = new Set(['aug', 'taser']);

export type ClipKind = 'shoot' | 'reload' | 'draw' | 'idle';

/**
 * The clip for `kind` and a normalised weapon: the weapon's own when it has one, else the
 * family's (`idle_rifle`; `frontswing_knife` and `throw_overhand_grenade` for shoot), else
 * null (a rifle reload for a weapon without clips, a c4 shoot).
 */
export function weaponClip(kind: ClipKind, weapon: string): string | null {
  const suffix = WEAPON_CLIP_SUFFIX[weapon];
  if (suffix !== undefined) {
    if (kind === 'shoot') return WEAPON_SHOOT_CLIP[weapon] ?? `shoot_${suffix}`;
    if (kind === 'reload')
      return NO_RELOAD.has(weapon) ? null : `reload_${suffix}`;
    return `${kind}_${suffix}`;
  }
  const family = familyOf(weapon);
  if (kind === 'idle') {
    if (family === 'grenade')
      return weapon === 'molotov' || weapon === 'incendiary'
        ? 'idle_molotov'
        : 'idle_grenade';
    return `idle_${family}`;
  }
  if (kind === 'shoot') {
    if (family === 'knife') return 'frontswing_knife';
    if (family === 'grenade') return 'throw_overhand_grenade';
    return null;
  }
  return null;
}

/** Suppressed weapons: dimmer muzzle flash. */
export function isSuppressed(weapon: string): boolean {
  return weapon === 'm4a1s' || weapon === 'usp' || weapon === 'mp5sd';
}

/** The kind of muzzle flash a gun fires, which sets its size (`impacts.ts` `MUZZLE`). */
export type MuzzleClass =
  'rifle' | 'pistol' | 'smg' | 'sniper' | 'shotgun' | 'mg';

const MUZZLE_CLASSES: Readonly<Record<MuzzleClass, readonly string[]>> = {
  rifle: ['ak47', 'aug', 'famas', 'galilar', 'm4a1s', 'm4a4', 'sg556'],
  sniper: ['awp', 'g3sg1', 'scar20', 'ssg08'],
  smg: ['bizon', 'mac10', 'mp5sd', 'mp7', 'mp9', 'p90', 'ump45'],
  shotgun: ['mag7', 'nova', 'sawedoff', 'xm1014'],
  mg: ['m249', 'negev'],
  pistol: [
    'cz75a',
    'deagle',
    'elite',
    'fiveseven',
    'glock',
    'hkp2000',
    'p250',
    'revolver',
    'tec9',
    'usp',
  ],
};

const MUZZLE_CLASS: ReadonlyMap<string, MuzzleClass> = new Map(
  (
    Object.entries(MUZZLE_CLASSES) as [MuzzleClass, readonly string[]][]
  ).flatMap(([c, guns]) => guns.map((g) => [g, c] as const))
);

/**
 * The muzzle flash a (normalised) weapon fires; null for what fires none: knives, grenades, the
 * c4, the taser.
 */
export function muzzleClass(weapon: string): MuzzleClass | null {
  return MUZZLE_CLASS.get(weapon) ?? null;
}
