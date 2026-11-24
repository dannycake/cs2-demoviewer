// What the playback HUD shows, as plain data from the pack and the round timeline at a tick:
// the round bar, the killfeed, the round strip, the scrubber's event markers, the scoreboard,
// the highlights panel and the banner over a reel. Pure, so the components only lay it out.

import {
  FLAG,
  GEAR,
  zoomOf,
  type MatchHeader,
  type Pack,
} from '../../pack/types';
import { profilePath } from '../../links';
import { highlightLabel, highlightsOf } from '../../sim/highlights';
import { newPlayerState, playerStateAt, sampleIndex } from '../../sim/sample';
import type { PlayerStats } from '../../sim/stats';
import {
  timelineFor,
  type FeedKind,
  type RoundPhase,
  type Timeline,
} from '../../sim/timeline';
import { familyOf, normaliseWeapon } from '../../sim/weapons';
import { blindAlpha } from '../../sim/impacts';
import type { Reel } from '../../state/reel';

export type Team = 2 | 3;

export interface Named {
  name: string;
  /** 2 T, 3 CT, 0 not playing. */
  team: number;
}

function named(pack: Pack, round: number, p: number | null): Named | null {
  const info = p === null ? undefined : pack.header.players[p];
  return info
    ? { name: info.name, team: info.team_by_round[round] ?? 0 }
    : null;
}

/** `m:ss` of `seconds`, rounded up so a timer reads 0:00 only at the end. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds - 1e-9));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- round bar

export interface Side {
  team: Team;
  score: number;
  /** One per player on the side this round, in header order: alive or not. */
  alive: boolean[];
}

export interface RoundBarModel {
  ct: Side;
  t: Side;
  timer: { phase: RoundPhase; text: string };
  /** The round's number, from 1. */
  round: number;
  /** '1st half', '2nd half' or 'OT n' (MR12, overtime in halves of 3). */
  half: string;
}

export function halfOf(number: number): string {
  if (number <= 12) return '1st half';
  if (number <= 24) return '2nd half';
  return `OT ${Math.floor((number - 25) / 6) + 1}`;
}

/** Each side's score (going into the round until it is decided, then after it), alive, clock. */
export function roundBarModel(
  pack: Pack,
  tl: Timeline,
  round: number,
  tick: number
): RoundBarModel {
  const { header } = pack;
  const info = header.rounds[round];
  const decided = info ? tick >= info.end_tick : false;
  const score = (team: Team) => {
    if (!info) return 0;
    const after = team === 2 ? info.score_t : info.score_ct;
    return decided
      ? after
      : Math.max(0, after - (info.winner === team ? 1 : 0));
  };
  const tracks = pack.rounds[round]?.players;
  const k =
    info && info.samples > 0 ? sampleIndex(info, tick, header.tick_step).k : -1;
  const alive = (team: Team) =>
    header.players.flatMap((p, i) =>
      p.team_by_round[round] === team
        ? [
            k >= 0 && tracks?.[i]
              ? (tracks[i].flags[k] & FLAG.alive) !== 0
              : false,
          ]
        : []
    );
  const timer = tl.roundTimer(round, tick);
  return {
    ct: { team: 3, score: score(3), alive: alive(3) },
    t: { team: 2, score: score(2), alive: alive(2) },
    timer: { phase: timer.phase, text: clock(timer.secondsLeft) },
    round: info?.number ?? round + 1,
    half: halfOf(info?.number ?? round + 1),
  };
}

// ---------------------------------------------------------------- killfeed

export type Badge =
  'blind' | 'noscope' | 'wallbang' | 'smoke' | 'headshot' | 'flash';

export interface KillRow {
  /**
   * Stable across frames, for list keys: the round and the kill's place in the round's whole
   * list, which never shifts as the feed scrolls (its place among the rows shown does).
   */
  key: string;
  tick: number;
  attacker: Named | null;
  assister: Named | null;
  victim: Named;
  /** The victim's index into `header.players`: with `tick`, it finds the kill again. */
  victimIndex: number;
  /** Normalised weapon name (`sim/weapons.ts`). */
  weapon: string;
  /** In the order they are drawn. */
  badges: Badge[];
}

/** The killfeed shows a kill this long while playing. */
export const KILLFEED_S = 8;
export const KILLFEED_ROWS = 5;

/**
 * The kills to show at `tick`, oldest first: the last `rows` (five; three in the narrow
 * layout) within 8 s while playing; paused (scrubbing), the most recent at or before the tick
 * whatever their age.
 */
export function killfeedRows(
  tl: Timeline,
  round: number,
  tick: number,
  playing: boolean,
  rows: number = KILLFEED_ROWS
): KillRow[] {
  const pack = tl.pack;
  const window = KILLFEED_S * pack.header.tick_rate;
  const kills = tl.kills(round);
  const shown: number[] = [];
  kills.forEach((k, i) => {
    if (k.tick <= tick && (!playing || tick - k.tick <= window)) shown.push(i);
  });
  return shown.slice(-rows).map((i) => {
    const k = kills[i];
    const badges: Badge[] = [];
    if (k.blind) badges.push('blind');
    if (k.noscope) badges.push('noscope');
    if (k.wallbang) badges.push('wallbang');
    if (k.smoke) badges.push('smoke');
    if (k.headshot) badges.push('headshot');
    if (k.flashAssist) badges.push('flash');
    return {
      key: `${round}:${i}`,
      tick: k.tick,
      attacker: named(pack, round, k.attacker),
      assister: named(pack, round, k.assister),
      victim: named(pack, round, k.victim) ?? { name: '?', team: 0 },
      victimIndex: k.victim,
      weapon: k.weapon,
      badges,
    };
  });
}

// ---------------------------------------------------------------- round strip

export type ReasonGlyph = 'elim' | 'bomb' | 'defuse' | 'time' | '';

export interface StripCell {
  /** Index into `header.rounds`. */
  index: number;
  number: number;
  /** 2 T, 3 CT, 0 unknown. */
  winner: number;
  glyph: ReasonGlyph;
  current: boolean;
  /** The first round of a half (round 13, and every third round of overtime). */
  halfStart: boolean;
}

export function reasonGlyph(reason: string): ReasonGlyph {
  if (reason.includes('killed')) return 'elim';
  if (reason.includes('defuse')) return 'defuse';
  if (reason.includes('bomb') || reason === 'target_bombed') return 'bomb';
  if (reason.includes('time') || reason.includes('saved')) return 'time';
  return '';
}

/** How a round was won, after "won" ('' when unknown). */
export const REASON_TEXT: Readonly<Record<ReasonGlyph, string>> = {
  elim: 'by elimination',
  bomb: 'by the bomb',
  defuse: 'by the defuse',
  time: 'on time',
  '': '',
};

export function roundStripModel(pack: Pack, current: number): StripCell[] {
  return pack.header.rounds.map((r, i) => ({
    index: i,
    number: r.number,
    winner: r.winner,
    glyph: reasonGlyph(r.reason),
    current: i === current,
    halfStart: i === 12 || (i >= 24 && (i - 24) % 3 === 0),
  }));
}

// ---------------------------------------------------------------- scrubber markers

export type MarkerKind =
  'kill' | 'death' | 'plant' | 'defuse' | 'smoke' | 'flash' | 'he' | 'fire';

export interface Marker {
  kind: MarkerKind;
  tick: number;
  /** The colour's team: the killer's, the planter's, the thrower's; null for the world. */
  team: number | null;
}

/**
 * The round's events along the scrubber, in tick order: kills in the killer's colour (the
 * followed player's death as `death`), the plant, the defuse, and where each grenade went off.
 */
export function markers(
  tl: Timeline,
  round: number,
  followed: number | null
): Marker[] {
  const pack = tl.pack;
  const info = pack.header.rounds[round];
  const team = (p: number | null) =>
    p === null ? null : (pack.header.players[p]?.team_by_round[round] ?? null);
  const out: Marker[] = [];
  for (const k of tl.kills(round))
    out.push({
      kind: followed !== null && k.victim === followed ? 'death' : 'kill',
      tick: k.tick,
      team: team(k.attacker),
    });
  for (const f of tl.allFeed(round)) {
    if (f.kind === 'plant')
      out.push({ kind: 'plant', tick: f.tick, team: f.team });
    else if (f.kind === 'defused')
      out.push({ kind: 'defuse', tick: f.tick, team: f.team });
  }
  if (info) {
    const KIND: Partial<Record<string, MarkerKind>> = {
      smoke: 'smoke',
      flash: 'flash',
      he: 'he',
      molotov: 'fire',
      incendiary: 'fire',
    };
    for (const g of pack.grenades) {
      const kind = KIND[g.kind];
      if (
        !kind ||
        g.start_tick < info.start_tick ||
        g.start_tick > info.post_end_tick
      )
        continue;
      out.push({
        kind,
        tick: g.detonate_tick ?? g.start_tick,
        team: team(g.thrower < pack.header.players.length ? g.thrower : null),
      });
    }
  }
  return out.sort((a, b) => a.tick - b.tick);
}

// ---------------------------------------------------------------- scoreboard

/** The scoreboard's stat columns, in order, between the name and the money. */
export const SCORE_COLUMNS = Object.freeze([
  'K',
  'A',
  'D',
  '+/−',
  'ADR',
  'KAST',
  'HS%',
  'UD',
  'FA',
  'Rating',
] as const);

export type ScoreColumn = (typeof SCORE_COLUMNS)[number];

/** The narrow layout's columns: kills, deaths, ADR and rating. */
const COMPACT_COLUMNS: ReadonlySet<ScoreColumn> = new Set<ScoreColumn>([
  'K',
  'D',
  'ADR',
  'Rating',
]);
const COMPACT_SCORE_COLUMNS = Object.freeze(
  SCORE_COLUMNS.filter((c) => COMPACT_COLUMNS.has(c))
);

/** The stat columns of a set, in `SCORE_COLUMNS` order. */
export function scoreColumns(set: 'all' | 'compact'): readonly ScoreColumn[] {
  return set === 'compact' ? COMPACT_SCORE_COLUMNS : SCORE_COLUMNS;
}

/** What a cell reads for a value that has no score yet (KAST and Rating before a decided round). */
export const NO_SCORE = '–';

/** The text of `row`'s cell in stat column `col`. */
export function scoreCell(row: ScoreRow, col: ScoreColumn): string {
  switch (col) {
    case 'K':
      return String(row.kills);
    case 'A':
      return String(row.assists);
    case 'D':
      return String(row.deaths);
    case '+/−':
      return row.diff > 0
        ? `+${row.diff}`
        : row.diff < 0
          ? `−${-row.diff}`
          : '0';
    case 'ADR':
      return String(Math.round(row.adr));
    case 'KAST':
      return row.kast === null ? NO_SCORE : `${Math.round(row.kast)}%`;
    case 'HS%':
      return `${Math.round(row.hsPct)}%`;
    case 'UD':
      return String(Math.round(row.utilityDamage));
    case 'FA':
      return String(row.flashAssists);
    case 'Rating':
      return row.rating === null ? NO_SCORE : row.rating.toFixed(2);
  }
}

export interface ScoreRow {
  index: number;
  name: string;
  /** The player's profile on the site (`/profiles/<steamid>`); null for a bot. */
  profile: string | null;
  kills: number;
  assists: number;
  deaths: number;
  /** Kills minus deaths. */
  diff: number;
  adr: number;
  /**
   * The percentage of decided rounds with a kill, an assist, survival or a trade; null before
   * the player's first decided round.
   */
  kast: number | null;
  hsPct: number;
  /** Health damage to enemies from grenades and fire. */
  utilityDamage: number;
  flashAssists: number;
  /** The rating (`sim/rating.ts`) over the decided rounds; null before the first. */
  rating: number | null;
  /** Money at the tick; null when the pack has none. */
  money: number | null;
  /** The best gun carried (a rifle, else a pistol) as a silhouette name, '' for none. */
  gun: string;
  /** The grenades carried, as silhouette names. */
  grenades: string[];
}

export interface ScoreTeam {
  team: Team;
  score: number;
  rows: ScoreRow[];
}

/** Both teams of the round, CT first, each by kills (then fewer deaths), with its score. */
export function scoreboardRows(
  stats: readonly PlayerStats[],
  pack: Pack,
  tl: Timeline,
  round: number,
  tick: number
): ScoreTeam[] {
  const bar = roundBarModel(pack, tl, round, tick);
  const known = moneyKnown(pack, round);
  const info = pack.header.rounds[round];
  const k =
    info && info.samples > 0
      ? sampleIndex(info, tick, pack.header.tick_step).k
      : -1;
  const kit = carried(pack, round, tick);
  return ([3, 2] as const).map((team) => ({
    team,
    score: team === 3 ? bar.ct.score : bar.t.score,
    rows: pack.header.players
      .flatMap((p, index) => {
        if (p.team_by_round[round] !== team) return [];
        const s = stats[index];
        const decided = (s?.rounds ?? 0) > 0;
        return [
          {
            index,
            name: p.name,
            profile: profilePath(p.steamid),
            kills: s?.kills ?? 0,
            assists: s?.assists ?? 0,
            deaths: s?.deaths ?? 0,
            diff: (s?.kills ?? 0) - (s?.deaths ?? 0),
            adr: s?.adr ?? 0,
            kast: decided ? s.kast : null,
            hsPct: s?.hsPct ?? 0,
            utilityDamage: s?.utilityDamage ?? 0,
            flashAssists: s?.flashAssists ?? 0,
            rating: decided ? s.rating : null,
            money:
              known && k >= 0
                ? (pack.rounds[round]?.players[index]?.money[k] ?? null)
                : null,
            gun: kit[index]?.gun ?? '',
            grenades: kit[index]?.grenades ?? [],
          },
        ];
      })
      .sort(
        (a, b) => b.kills - a.kills || a.deaths - b.deaths || a.index - b.index
      ),
  }));
}

/**
 * What each player carries at `tick` of `round`, from the inventory changes (`INV1`): the best
 * gun and the grenades, as silhouette names. Empty without inventory data.
 */
export function carried(
  pack: Pack,
  round: number,
  tick: number
): { gun: string; grenades: string[] }[] {
  const items: number[][] = pack.header.players.map(() => []);
  for (const c of pack.inventory)
    if (c.round === round && c.tick <= tick && items[c.player])
      items[c.player] = c.items;
  return items.map((list, p) => {
    const team = pack.header.players[p]?.team_by_round[round] ?? 0;
    const names = list.map((i) => pack.header.weapons[i] ?? '');
    const best = (family: string) =>
      names.find((n) => n && familyOf(normaliseWeapon(n)) === family);
    const gun = best('rifle') ?? best('pistol') ?? '';
    return {
      gun: gun ? weaponIcon(gun, team) : '',
      grenades: names
        .map((n) => normaliseWeapon(n))
        .filter((w) => w && familyOf(w) === 'grenade'),
    };
  });
}

// ---------------------------------------------------------------- followed player

export interface PlayerCardModel {
  index: number;
  name: string;
  team: number;
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  /** `label` as shown; `icon` the weapon silhouette's name; empty-handed: both ''. */
  weapon: { label: string; icon: string };
  /** Rounds in the magazine; null for a knife, grenade or c4 (the game reports 0) or without the data. */
  ammo: number | null;
  /** Null when the pack has no money data. */
  money: number | null;
  /** The grenades carried, as silhouette names, in the game's order. */
  grenades: string[];
  kills: number;
  deaths: number;
  /** Sentence-case state tags: Bomb, Defusing, Flashed, Scoped. */
  tags: string[];
}

/**
 * Whether the round's tracks carry money: a pack without `TRK2` gives every player of a round
 * the same zero-filled array (`pack/reader.ts`).
 */
export function moneyKnown(pack: Pack, round: number): boolean {
  const tracks = pack.rounds[round]?.players ?? [];
  return tracks.length < 2 || tracks[0].money !== tracks[1].money;
}

/** The icon name of a weapon (a display name from the pack): T knives are drawn as `knife_t`. */
export function weaponIcon(display: string, team: number): string {
  if (!display || display === 'none') return '';
  const n = normaliseWeapon(display);
  return n === 'knife' && team === 2 ? 'knife_t' : n;
}

/** Whether a weapon (a display name) has a magazine to show. */
function isGun(display: string): boolean {
  const f = familyOf(normaliseWeapon(display));
  return f === 'rifle' || f === 'pistol';
}

function weaponText(display: string): string {
  if (!display || display === 'none') return '';
  return normaliseWeapon(display) === 'knife' ? 'Knife' : display;
}

/** Player `p` at `tick` of round `round`, for the player card; null when not in the round. */
export function playerCardModel(
  pack: Pack,
  round: number,
  tick: number,
  p: number,
  stats: readonly { kills: number; deaths: number }[]
): PlayerCardModel | null {
  const { header } = pack;
  const info = header.rounds[round];
  const player = header.players[p];
  const track = pack.rounds[round]?.players[p];
  const team = player?.team_by_round[round] ?? 0;
  if (!info || !player || !track || team === 0) return null;
  const s = playerStateAt(track, info, tick, header, newPlayerState());
  const display = header.weapons[s.weapon] ?? 'none';
  const known = moneyKnown(pack, round);
  let items: number[] = [];
  for (const c of pack.inventory)
    if (c.round === round && c.player === p && c.tick <= tick) items = c.items;
  const tags: string[] = [];
  if (s.flags & FLAG.bomb) tags.push('Bomb');
  if (s.flags & FLAG.defusing) tags.push('Defusing');
  if (s.flags & FLAG.flashed) tags.push('Flashed');
  if (s.flags & FLAG.scoped || zoomOf(s.gear) > 0) tags.push('Scoped');
  return {
    index: p,
    name: player.name,
    team,
    alive: s.present && s.health > 0,
    health: s.health,
    armor: s.armor,
    helmet: (s.gear & GEAR.helmet) !== 0,
    kit: (s.gear & GEAR.kit) !== 0,
    weapon: { label: weaponText(display), icon: weaponIcon(display, team) },
    ammo: known && s.ammo !== GEAR.ammoNone && isGun(display) ? s.ammo : null,
    money: known ? s.money : null,
    grenades: items
      .map((i) => normaliseWeapon(header.weapons[i] ?? ''))
      .filter((w) => w && familyOf(w) === 'grenade'),
    kills: stats[p]?.kills ?? 0,
    deaths: stats[p]?.deaths ?? 0,
    tags,
  };
}

// ---------------------------------------------------------------- round feed

export interface FeedRow {
  /** Stable across frames, for list keys: as `KillRow.key`, by the place in `allFeed`. */
  key: string;
  tick: number;
  kind: FeedKind;
  text: string;
  team: number | null;
}

export const ROUND_FEED_S = 12;
export const ROUND_FEED_ROWS = 4;

/**
 * The round's latest events (throws, plant, defuse, and kills unless `kills` is false: the HUD
 * leaves them to the killfeed beside it), oldest first: as the killfeed.
 */
export function roundFeedRows(
  tl: Timeline,
  round: number,
  tick: number,
  playing: boolean,
  kills = true
): FeedRow[] {
  const window = ROUND_FEED_S * tl.pack.header.tick_rate;
  // The last rows at or before `tick`, each keyed by its place in the round's whole feed, which
  // a new event does not shift.
  const all = tl.allFeed(round);
  const items: { f: (typeof all)[number]; at: number }[] = [];
  for (let i = all.length - 1; i >= 0 && items.length < ROUND_FEED_ROWS; i--) {
    const f = all[i];
    if (f.tick > tick || (!kills && f.kind === 'kill')) continue;
    items.push({ f, at: i });
  }
  return items
    .reverse()
    .filter(({ f }) => !playing || tick - f.tick <= window)
    .map(({ f, at }) => ({
      key: `${round}:${at}`,
      tick: f.tick,
      kind: f.kind,
      text: f.text,
      team: f.team,
    }));
}

// ---------------------------------------------------------------- highlights

export interface HighlightRow {
  key: string;
  /** The highlight's position in `highlightsOf(pack)`. */
  index: number;
  /** `highlightLabel`: '3k', '1v2 clutch', 'No-scope · Wallbang'. */
  label: string;
  player: Named;
  /** The round bar's timer text at the highlight's tick, or the round's last live tick. */
  clock: string;
  /** False for a plain opening kill, which the reel leaves out. */
  reel: boolean;
}

/**
 * The match's highlights for the panel, grouped by round in round order: the opening-only
 * ones (not in the reel) only `withOpenings`, and rounds with no rows left out.
 */
export function highlightRows(
  pack: Pack,
  withOpenings: boolean
): { round: number; rows: HighlightRow[] }[] {
  const tl = timelineFor(pack);
  const groups: { round: number; rows: HighlightRow[] }[] = [];
  // `highlightsOf` is sorted by round, then tick: each round's rows are consecutive.
  highlightsOf(pack).forEach((h, index) => {
    if (!h.reel && !withOpenings) return;
    let group = groups[groups.length - 1];
    if (group?.round !== h.round) {
      group = { round: h.round, rows: [] };
      groups.push(group);
    }
    // A round-winning kill and every clutch sit on end_tick, where the timer reads 0:00.
    const end = pack.header.rounds[h.round]?.end_tick ?? Infinity;
    const at = Math.min(h.tick, end - 1);
    group.rows.push({
      key: `h${index}`,
      index,
      label: highlightLabel(h),
      player: named(pack, h.round, h.player) ?? { name: '?', team: 0 },
      clock: roundBarModel(pack, tl, h.round, at).timer.text,
      reel: h.reel,
    });
  });
  return groups;
}

// ---------------------------------------------------------------- reel banner

export interface ReelBanner {
  title: string;
  /** `'2 / 7'`: the segment playing and how many; `''` for a kill cam, which has one. */
  position: string;
  /** Whether there is a segment after this one (`N`). */
  canNext: boolean;
}

/**
 * The banner over a reel: the segment's title, which a kill cam's already names both players
 * in, and a highlight's names its player before its kinds; then where the reel is.
 */
export function reelBanner(reel: Reel, pack: Pack): ReelBanner {
  const seg = reel.segments[reel.index];
  const count = reel.segments.length;
  let title = seg?.title ?? '';
  if (seg && reel.kind === 'highlights') {
    const who = seg.player ?? seg.follow;
    const name = pack.header.players[who]?.name ?? `player ${who + 1}`;
    title = title ? `${name} · ${title}` : name;
  }
  return {
    title,
    position: reel.kind === 'killcam' ? '' : `${reel.index + 1} / ${count}`,
    canNext: reel.index < count - 1,
  };
}

// ---------------------------------------------------------------- brand line

/** The maps the viewer has a 3D world and a radar for: Active Duty and Cache. */
export const MAP_NAMES: Readonly<Record<string, string>> = {
  de_ancient: 'Ancient',
  de_anubis: 'Anubis',
  de_cache: 'Cache',
  de_dust2: 'Dust II',
  de_inferno: 'Inferno',
  de_mirage: 'Mirage',
  de_nuke: 'Nuke',
  de_overpass: 'Overpass',
  de_train: 'Train',
  de_vertigo: 'Vertigo',
};

/** Names players use that the file name does not give. */
const OTHER_NAMES: Readonly<Record<string, string>> = {
  de_cbble: 'Cobblestone',
};

/** A map's name as players say it: `de_dust2` is Dust II, `de_some_map` is Some map. */
export function mapName(map: string): string {
  const known = MAP_NAMES[map] ?? OTHER_NAMES[map];
  if (known) return known;
  const bare = map.replace(/^[a-z]+_/, '').replace(/_/g, ' ');
  return bare.charAt(0).toUpperCase() + bare.slice(1);
}

/** A Valve region as people write it: `us_north_central` is US North Central. */
export function regionName(region: string): string {
  return region
    .split('_')
    .filter(Boolean)
    .map((w) =>
      w.length <= 2
        ? w.toUpperCase()
        : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
    )
    .join(' ');
}

/** The map's name and where the match was played, for the top left. */
export function brandModel(header: Pick<MatchHeader, 'map' | 'server_name'>): {
  map: string;
  place: string;
} {
  const map = mapName(header.map);
  const valve = /^Valve Counter-Strike 2 (\S+) Server/.exec(header.server_name);
  return {
    map,
    place: valve
      ? `Valve matchmaking, ${regionName(valve[1])}`
      : header.server_name,
  };
}

// ---------------------------------------------------------------- flash whiteout

/** The whiteout's most: a replay keeps the scene faintly visible through a full flash. */
export const WHITEOUT_MAX = 0.85;

/**
 * How white the view is at `tick`: in POV, the followed player's blindness through
 * `blindAlpha` (the strongest if two flashes overlap) times `WHITEOUT_MAX`; 0 otherwise.
 */
export function whiteoutAlpha(
  tl: Timeline,
  round: number,
  tick: number,
  follow: number | null,
  camera: string
): number {
  if (follow === null || camera !== 'pov') return 0;
  let a = 0;
  for (const b of tl.blindsAt(round, tick))
    if (b.player === follow)
      a = Math.max(a, blindAlpha(b.startTick, b.endTick, tick));
  return a * WHITEOUT_MAX;
}
