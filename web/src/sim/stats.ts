// Scoreboard numbers for the match so far: kills, deaths, assists, damage, ADR, HS%, KAST,
// utility damage, flash assists and a rating, through a given tick of a given round. Pure.
// Conventions (ours, close to the usual scoreboard):
// - a kill counts only against an enemy; a team kill or suicide counts the victim's death only;
// - an assist counts for an enemy of the victim, and is a flash assist too when the
//   `player_death` has `assistedflash`;
// - damage counts only against enemies and is capped at the victim's remaining health, which
//   is followed through the round from the `health` field of every `player_hurt` (players
//   spawn at 100), so an overkill headshot adds the health that was left, not 119; utility
//   damage is the part of it from `STATS.utilityWeapons`;
// - ADR divides by the rounds started so far, the current one included;
// - a player survives a round with no death from its start through its `end_tick`, and is
//   traded when killed by an enemy whom a teammate kills within `STATS.tradeS` after;
// - KAST and the rating are over the decided rounds (`tick ≥ end_tick`) the player was on a
//   side for, and the rating takes its kills, deaths, assists and damage from those rounds only.
// Each round's own numbers are a `RoundRecord`; a whole round's is kept per pack, so the match
// so far is the sum of the kept rounds and the current round's record up to the tick.

import type { Pack, PackEvent } from '../pack/types';

export interface PlayerStats {
  kills: number;
  deaths: number;
  assists: number;
  /** Health damage dealt to enemies, capped per hit at the victim's remaining health. */
  damage: number;
  /** Average damage per round started so far. */
  adr: number;
  /** Headshot kills as a percentage of kills (0 without kills). */
  hsPct: number;
  headshots: number;
  /** Decided rounds (`tick ≥ end_tick`) the player was on a side for. */
  rounds: number;
  /** The percentage of `rounds` with a kill, an assist, survival or a trade (0 without). */
  kast: number;
  /** The part of `damage` from utility (`STATS.utilityWeapons`). */
  utilityDamage: number;
  /** Assists on flash-assisted kills, each also in `assists`. */
  flashAssists: number;
  /** `rating` over the decided rounds (0 without). */
  rating: number;
}

export const STATS = Object.freeze({
  /** A death is traded when a teammate kills the killer within this many seconds after. */
  tradeS: 5,
  /** The `weapon` of a `player_hurt` whose damage is utility damage. */
  utilityWeapons: Object.freeze([
    'hegrenade',
    'inferno',
    'molotov',
    'incendiary',
  ]),
});

const UTILITY: ReadonlySet<string> = new Set(STATS.utilityWeapons);

/**
 * The public approximation of HLTV Rating 2.0 from per-round rates, with `kast` in percent.
 * Never below 0.
 */
export function rating(r: {
  kast: number;
  kpr: number;
  dpr: number;
  apr: number;
  adr: number;
}): number {
  const impact = 2.13 * r.kpr + 0.42 * r.apr - 0.41;
  return Math.max(
    0,
    0.0073 * r.kast +
      0.3591 * r.kpr -
      0.5329 * r.dpr +
      0.2372 * impact +
      0.0032 * r.adr +
      0.1587
  );
}

const SPAWN_HEALTH = 100;

function idx(v: unknown, n: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n
    ? v
    : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** One player's own numbers in one round. */
export interface PlayerRound {
  /** On a side (T or CT) in the round. */
  played: boolean;
  kills: number;
  deaths: number;
  assists: number;
  /** Health damage dealt to enemies, capped per hit at the victim's remaining health. */
  damage: number;
  headshots: number;
  /** The part of `damage` from utility (`STATS.utilityWeapons`). */
  utilityDamage: number;
  /** Assists on flash-assisted kills, each also in `assists`. */
  flashAssists: number;
  /** On a side, and no death from the round's start through its `end_tick` (so far, before). */
  survived: boolean;
  /** Killed by an enemy whom a teammate then killed within `STATS.tradeS` (so far). */
  traded: boolean;
  /** On a side, with a kill, an assist, survival or a trade. */
  kast: boolean;
}

/** One round's numbers, per player in header order. */
export interface RoundRecord {
  readonly players: readonly Readonly<PlayerRound>[];
}

interface PackStats {
  /** The pack's `player_hurt` and `player_death` events by tick, a tick's in pack order. */
  events: PackEvent[];
  /** The whole rounds' records, by round index, once made. */
  whole: (RoundRecord | undefined)[];
}

const cache = new WeakMap<Pack, PackStats>();

function packStats(pack: Pack): PackStats {
  let c = cache.get(pack);
  if (!c) {
    const events = pack.events
      .filter(
        (e) =>
          (e.kind === 'player_hurt' || e.kind === 'player_death') &&
          Number.isFinite(e.tick)
      )
      .sort((a, b) => a.tick - b.tick);
    c = { events, whole: [] };
    cache.set(pack, c);
  }
  return c;
}

/** Forgets the whole rounds kept for `pack` (for tests). */
export function clearStatsCache(pack: Pack): void {
  cache.delete(pack);
}

/** The index of the first of `events` (by tick) at or after `tick`. */
function firstAt(events: readonly PackEvent[], tick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Round `round`'s numbers from its `start_tick` through `upTo`. */
function record(
  pack: Pack,
  events: readonly PackEvent[],
  round: number,
  upTo: number
): RoundRecord {
  const { header } = pack;
  const n = header.players.length;
  const team = (p: number) => header.players[p].team_by_round[round] ?? 0;
  const players: PlayerRound[] = header.players.map((_, p) => ({
    played: team(p) === 2 || team(p) === 3,
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    headshots: 0,
    utilityDamage: 0,
    flashAssists: 0,
    survived: false,
    traded: false,
    kast: false,
  }));
  const info = header.rounds[round];
  if (!info) return { players };
  const enemies = (a: number, b: number) => {
    const ta = team(a);
    const tb = team(b);
    return (ta === 2 || ta === 3) && (tb === 2 || tb === 3) && ta !== tb;
  };
  const hp = new Array<number>(n).fill(SPAWN_HEALTH);
  const died = new Array<boolean>(n).fill(false);
  // The enemy kills so far: who died, to whom, when; open to a trade for `tradeS` after.
  const enemyKills: { victim: number; killer: number; tick: number }[] = [];
  const tradeTicks = STATS.tradeS * header.tick_rate;
  for (
    let i = firstAt(events, info.start_tick);
    i < events.length && events[i].tick <= upTo;
    i++
  ) {
    const e = events[i];
    const d = e.data;
    if (e.kind === 'player_hurt') {
      const victim = idx(d.user_idx, n);
      if (victim === null) continue;
      const attacker = idx(d.attacker_idx, n);
      const dealt = Math.min(num(d.dmg_health), hp[victim]);
      if (
        attacker !== null &&
        attacker !== victim &&
        enemies(attacker, victim)
      ) {
        players[attacker].damage += Math.max(0, dealt);
        if (UTILITY.has(String(d.weapon)))
          players[attacker].utilityDamage += Math.max(0, dealt);
      }
      hp[victim] =
        typeof d.health === 'number'
          ? Math.max(0, d.health)
          : Math.max(0, hp[victim] - dealt);
    } else {
      const victim = idx(d.user_idx, n);
      if (victim === null) continue;
      players[victim].deaths++;
      if (e.tick <= info.end_tick) died[victim] = true;
      const attacker = idx(d.attacker_idx, n);
      if (
        attacker !== null &&
        attacker !== victim &&
        enemies(attacker, victim)
      ) {
        players[attacker].kills++;
        if (d.headshot === true) players[attacker].headshots++;
        // When the victim had killed a teammate of the attacker in the last `tradeS`, this kill
        // trades that teammate's death.
        for (const k of enemyKills)
          if (
            k.killer === victim &&
            e.tick - k.tick <= tradeTicks &&
            k.victim !== attacker &&
            team(k.victim) === team(attacker)
          )
            players[k.victim].traded = true;
        enemyKills.push({ victim, killer: attacker, tick: e.tick });
      }
      const assister = idx(d.assister_idx, n);
      if (
        assister !== null &&
        assister !== victim &&
        assister !== attacker &&
        enemies(assister, victim)
      ) {
        players[assister].assists++;
        if (d.assistedflash === true) players[assister].flashAssists++;
      }
    }
  }
  for (const [p, x] of players.entries()) {
    x.survived = x.played && !died[p];
    x.kast =
      x.played && (x.kills > 0 || x.assists > 0 || x.survived || x.traded);
  }
  return { players };
}

/** `rec`, frozen through its players: a kept record is shared by every reader. */
function frozen(rec: RoundRecord): RoundRecord {
  return Object.freeze({
    players: Object.freeze(rec.players.map((p) => Object.freeze(p))),
  });
}

/**
 * Round `round`'s own numbers through `upTo` (default: its `post_end_tick`, or its `end_tick`
 * when the pack has none: the whole round). A whole round's record is kept per pack, frozen,
 * and returned again.
 */
export function roundRecord(
  pack: Pack,
  round: number,
  upTo?: number
): RoundRecord {
  const info = pack.header.rounds[round];
  const c = packStats(pack);
  if (!info) return record(pack, c.events, round, Number.NaN);
  const end = info.post_end_tick ?? info.end_tick;
  if (upTo !== undefined && !(upTo >= end))
    return record(pack, c.events, round, upTo);
  let rec = c.whole[round];
  if (!rec) c.whole[round] = rec = frozen(record(pack, c.events, round, end));
  return rec;
}

/** Stats per player (header order) through `tick` of `round`, the earlier rounds whole. */
export function statsThrough(
  pack: Pack,
  round: number,
  tick: number
): PlayerStats[] {
  const { header } = pack;
  const out: PlayerStats[] = header.players.map(() => ({
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    adr: 0,
    hsPct: 0,
    headshots: 0,
    rounds: 0,
    kast: 0,
    utilityDamage: 0,
    flashAssists: 0,
    rating: 0,
  }));
  // The decided rounds' own sums, which KAST and the rating are over.
  const decided = header.players.map(() => ({
    kills: 0,
    deaths: 0,
    assists: 0,
    damage: 0,
    kast: 0,
  }));
  const last = Math.min(round, header.rounds.length - 1);
  for (let r = 0; r <= last; r++) {
    const partial = r === round;
    const rec = roundRecord(pack, r, partial ? tick : undefined);
    const isDecided = !partial || tick >= header.rounds[r].end_tick;
    for (const [i, p] of rec.players.entries()) {
      const s = out[i];
      s.kills += p.kills;
      s.deaths += p.deaths;
      s.assists += p.assists;
      s.damage += p.damage;
      s.headshots += p.headshots;
      s.utilityDamage += p.utilityDamage;
      s.flashAssists += p.flashAssists;
      if (isDecided && p.played) {
        const d = decided[i];
        s.rounds++;
        d.kills += p.kills;
        d.deaths += p.deaths;
        d.assists += p.assists;
        d.damage += p.damage;
        if (p.kast) d.kast++;
      }
    }
  }
  const rounds = Math.max(1, last + 1);
  for (const [i, s] of out.entries()) {
    s.adr = s.damage / rounds;
    s.hsPct = s.kills ? (100 * s.headshots) / s.kills : 0;
    if (s.rounds) {
      const d = decided[i];
      s.kast = (100 * d.kast) / s.rounds;
      s.rating = rating({
        kast: s.kast,
        kpr: d.kills / s.rounds,
        dpr: d.deaths / s.rounds,
        apr: d.assists / s.rounds,
        adr: d.damage / s.rounds,
      });
    }
  }
  return out;
}
