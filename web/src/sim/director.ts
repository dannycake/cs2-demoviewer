// The auto-director: who the POV camera shows through a round, planned ahead from the
// round's events (phase 3c design, "Director"). Every 0.5 s each living player is scored on
// what they are about to do: +10 for a kill, +6 for a death, +4 per 50 damage dealt, +5 for
// a plant or defuse start, +3 for an own grenade that blinds or damages an enemy, at full
// weight over the next 6 s and half weight 6–12 s ahead, plus +1 per enemy within 15 m now.
// The director switches when the best beats the current target by 8 and the current target
// has been on screen for 4 s, landing the cut 1.5 s before the event that won, so a kill is
// seen from the killer's eyes. When the current target dies the camera holds their death view
// for 2 s (`DEATH_VIEW_S`), as POV does on its own, then cuts to the killer (else the nearest
// living teammate) unless someone beats them by 8. In the last 20 s of a planted bomb with no
// fight pending it follows the defuser, else the planter's teammate nearest the bomb.
//
// Everything is a pure function of (pack, round): the cuts are planned once per round and
// cached, so scrubbing in any direction shows the same target at a tick.

import { UNIT } from '../geo/coords';
import { FLAG, type Pack, type PlayerTrack } from '../pack/types';
import { DEATH_VIEW_S } from './deathview';
import { newPlayerState, playerStateAt, type PlayerState } from './sample';
import { BOMB_S } from './timeline';

/** From `tick` on (until the next cut) the director follows player `follow`. */
export interface DirectorCut {
  tick: number;
  /** Index into `header.players`. */
  follow: number;
  /** Why: `start`, `death`, `absent`, `bomb-defuser`, `bomb-guard`, or the winning event. */
  reason: string;
}

export const DIRECTOR = Object.freeze({
  /** Seconds between two evaluations. */
  evalS: 0.5,
  /** Events this far ahead count in full… */
  nearS: 6,
  /** …and up to this far ahead at `farWeight`. */
  farS: 12,
  farWeight: 0.5,
  kill: 10,
  death: 6,
  /** Per 50 damage dealt to enemies (each hit counts at most 100). */
  damage: 4,
  objective: 5,
  grenade: 3,
  /** Per enemy within `nearM` metres. */
  enemyNear: 1,
  nearM: 15,
  /** The best must beat the current target by this… */
  margin: 8,
  /** …and the current target must have been on screen this long. */
  holdS: 4,
  /** A cut lands this long before the event that won it. */
  leadS: 1.5,
  /** The last seconds of a planted bomb, when the defuser or a guard is followed. */
  bombLastS: 20,
  /** A flash blinds an enemy when it lasts at least this long. */
  blindMinS: 1,
  /** Hits by one player's grenades closer than this are one grenade. */
  grenadeChainS: 2,
});

/** A scored event of one player. */
interface Scored {
  tick: number;
  player: number;
  value: number;
  /** A kill, death, damage or grenade hit: a fight, as opposed to an objective. */
  fight: boolean;
  kind: string;
}

interface Bomb {
  planter: number;
  /** Where the planter stood at the plant (source units). */
  x: number;
  y: number;
  z: number;
  /** The last `bombLastS` of the fuse: [from, to]. */
  from: number;
  to: number;
}

interface RoundData {
  /** Sorted by tick, within [start_tick, post_end_tick]: the round and its after-round. */
  events: Scored[];
  /** Each player's defuse starts, sorted. */
  defuses: { tick: number; player: number }[];
  bomb: Bomb | null;
  /** Each victim's first killer this round (as `killersOf`). */
  killer: Map<number, number | null>;
}

const roundData = new WeakMap<Pack, Map<number, RoundData>>();
const plans = new WeakMap<Pack, Map<number, DirectorCut[]>>();

function index(v: unknown, n: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n
    ? v
    : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const GRENADE_WEAPONS = new Set([
  'hegrenade',
  'inferno',
  'molotov',
  'incgrenade',
  'flashbang',
  'smokegrenade',
  'decoy',
]);

function alive(t: PlayerTrack | undefined, k: number): boolean {
  return !!t && k >= 0 && k < t.flags.length && (t.flags[k] & FLAG.alive) !== 0;
}

function dataOf(pack: Pack, round: number): RoundData {
  let byRound = roundData.get(pack);
  if (!byRound) {
    byRound = new Map();
    roundData.set(pack, byRound);
  }
  let d = byRound.get(round);
  if (d) return d;
  d = buildRoundData(pack, round);
  byRound.set(round, d);
  return d;
}

function buildRoundData(pack: Pack, round: number): RoundData {
  const { header } = pack;
  const info = header.rounds[round];
  const n = header.players.length;
  const d: RoundData = {
    events: [],
    defuses: [],
    bomb: null,
    killer: new Map(),
  };
  if (!info) return d;
  const team = (p: number) => header.players[p]?.team_by_round[round] ?? 0;
  const enemies = (a: number, b: number) =>
    team(a) !== 0 && team(b) !== 0 && team(a) !== team(b);
  const rate = header.tick_rate;
  const inRound = pack.events.filter(
    (e) => e.tick >= info.start_tick && e.tick <= info.post_end_tick
  );
  const beginsPlant = inRound.some((e) => e.kind === 'bomb_beginplant');

  // Grenade hits, merged per thrower and grenade into one +3 at the first hit.
  const hits: { tick: number; player: number; key: string }[] = [];
  let plant: { tick: number; player: number } | null = null;
  let exploded: number | null = null;
  let defused: number | null = null;

  for (const e of inRound) {
    const data = e.data;
    switch (e.kind) {
      case 'player_death': {
        const victim = index(data.user_idx, n);
        if (victim === null) break;
        const attacker = index(data.attacker_idx, n);
        if (!d.killer.has(victim)) d.killer.set(victim, attacker);
        d.events.push({
          tick: e.tick,
          player: victim,
          value: DIRECTOR.death,
          fight: true,
          kind: 'death',
        });
        if (
          attacker !== null &&
          attacker !== victim &&
          enemies(attacker, victim)
        )
          d.events.push({
            tick: e.tick,
            player: attacker,
            value: DIRECTOR.kill,
            fight: true,
            kind: 'kill',
          });
        break;
      }
      case 'player_hurt': {
        const victim = index(data.user_idx, n);
        const attacker = index(data.attacker_idx, n);
        if (victim === null || attacker === null || attacker === victim) break;
        if (!enemies(attacker, victim)) break;
        const dmg = Math.min(100, Math.max(0, num(data.dmg_health)));
        if (dmg > 0)
          d.events.push({
            tick: e.tick,
            player: attacker,
            value: (DIRECTOR.damage * dmg) / 50,
            fight: true,
            kind: 'damage',
          });
        const weapon = String(data.weapon ?? '');
        if (GRENADE_WEAPONS.has(weapon))
          hits.push({ tick: e.tick, player: attacker, key: weapon });
        break;
      }
      case 'player_blind': {
        const victim = index(data.user_idx, n);
        const attacker = index(data.attacker_idx, n);
        if (victim === null || attacker === null || !enemies(attacker, victim))
          break;
        if (num(data.blind_duration) < DIRECTOR.blindMinS) break;
        hits.push({ tick: e.tick, player: attacker, key: 'flash' });
        break;
      }
      case 'bomb_beginplant':
      case 'bomb_planted': {
        const who = index(data.user_idx, n);
        if (e.kind === 'bomb_planted' && plant === null && who !== null)
          plant = { tick: e.tick, player: who };
        // The plant start scores; a pack without `bomb_beginplant` scores the plant.
        if (who !== null && (e.kind === 'bomb_beginplant') === beginsPlant)
          d.events.push({
            tick: e.tick,
            player: who,
            value: DIRECTOR.objective,
            fight: false,
            kind: 'plant',
          });
        break;
      }
      case 'bomb_exploded':
        exploded ??= e.tick;
        break;
      case 'bomb_defused':
        defused ??= e.tick;
        break;
    }
  }

  const chain = DIRECTOR.grenadeChainS * rate;
  const last = new Map<string, number>();
  for (const h of hits) {
    const key = `${h.player}:${h.key}`;
    const prev = last.get(key);
    last.set(key, h.tick);
    if (prev !== undefined && h.tick - prev <= chain) continue;
    d.events.push({
      tick: h.tick,
      player: h.player,
      value: DIRECTOR.grenade,
      fight: true,
      kind: 'grenade',
    });
  }

  // Defuse starts from the defusing flag (the pack carries no bomb_begindefuse).
  const tracks = pack.rounds[round]?.players ?? [];
  for (let p = 0; p < n && p < tracks.length; p++) {
    const t = tracks[p];
    let was = false;
    for (let k = 0; k < info.samples && k < t.flags.length; k++) {
      const on = (t.flags[k] & FLAG.defusing) !== 0 && alive(t, k);
      const tick = info.start_tick + k * header.tick_step;
      if (on && !was && tick <= info.post_end_tick) {
        d.defuses.push({ tick, player: p });
        d.events.push({
          tick,
          player: p,
          value: DIRECTOR.objective,
          fight: false,
          kind: 'defuse',
        });
      }
      was = on;
    }
  }
  d.defuses.sort((a, b) => a.tick - b.tick);
  d.events.sort((a, b) => a.tick - b.tick || a.player - b.player);

  if (plant) {
    const fuseEnd = exploded ?? plant.tick + BOMB_S * rate;
    const from = fuseEnd - DIRECTOR.bombLastS * rate;
    const to = Math.min(fuseEnd, defused ?? Infinity, info.post_end_tick);
    const where = newPlayerState();
    const t = tracks[plant.player];
    if (t) playerStateAt(t, info, plant.tick, header, where);
    if (from <= to)
      d.bomb = {
        planter: plant.player,
        x: where.x,
        y: where.y,
        z: where.z,
        from,
        to,
      };
  }
  return d;
}

/** The first event at or after `tick`. */
function lowerBound(events: readonly Scored[], tick: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].tick < tick) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Scratch states, one per player, reused across calls. */
const scratch: PlayerState[] = [];

/**
 * Every player's score at `tick`, in `header.players` order: what they are about to do over
 * the next 12 s (6–12 s at half weight) and the enemies within 15 m of them now.
 * `-Infinity` for a player who is not alive at `tick`.
 */
export function scorePlayers(
  pack: Pack,
  round: number,
  tick: number
): Float64Array {
  const { header } = pack;
  const n = header.players.length;
  const out = new Float64Array(n).fill(-Infinity);
  const info = header.rounds[round];
  const tracks = pack.rounds[round]?.players;
  if (!info || !tracks) return out;
  while (scratch.length < n) scratch.push(newPlayerState());
  const states = scratch;
  for (let p = 0; p < n; p++) {
    const t = tracks[p];
    if (!t) continue;
    playerStateAt(t, info, tick, header, states[p]);
    if (states[p].present) out[p] = 0;
  }

  const d = dataOf(pack, round);
  const rate = header.tick_rate;
  const near = tick + DIRECTOR.nearS * rate;
  const far = tick + DIRECTOR.farS * rate;
  for (let i = lowerBound(d.events, tick); i < d.events.length; i++) {
    const e = d.events[i];
    if (e.tick > far) break;
    if (out[e.player] === -Infinity) continue;
    out[e.player] += e.tick <= near ? e.value : e.value * DIRECTOR.farWeight;
  }

  const team = (p: number) => header.players[p]?.team_by_round[round] ?? 0;
  const range = DIRECTOR.nearM / UNIT;
  for (let p = 0; p < n; p++) {
    if (out[p] === -Infinity || team(p) === 0) continue;
    for (let q = 0; q < n; q++) {
      if (out[q] === -Infinity || team(q) === 0 || team(q) === team(p))
        continue;
      const a = states[p];
      const b = states[q];
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= range)
        out[p] += DIRECTOR.enemyNear;
    }
  }
  return out;
}

/** The highest score's player (the lowest index on a tie, `prefer` first), or null. */
function bestOf(scores: Float64Array, prefer: number | null): number | null {
  let best = prefer !== null && scores[prefer] > -Infinity ? prefer : null;
  for (let p = 0; p < scores.length; p++)
    if (scores[p] > -Infinity && (best === null || scores[p] > scores[best]))
      best = p;
  return best;
}

/**
 * Who the director follows through round `round`, as cuts in tick order, the first at
 * `start_tick`. Empty when nobody in the round is ever alive.
 */
export function planDirector(pack: Pack, round: number): DirectorCut[] {
  const { header } = pack;
  const info = header.rounds[round];
  const tracks = pack.rounds[round]?.players;
  if (!info || !tracks || info.samples <= 0) return [];
  const n = Math.min(header.players.length, tracks.length);
  const step = header.tick_step;
  const rate = header.tick_rate;
  const d = dataOf(pack, round);
  const team = (p: number) => header.players[p]?.team_by_round[round] ?? 0;
  const live = (p: number, k: number) =>
    p >= 0 && p < n && k < info.samples && alive(tracks[p], k);
  const tickOf = (k: number) => info.start_tick + k * step;
  /** The first sample at or after `tick`. */
  const sampleAt = (tick: number) =>
    Math.min(
      info.samples - 1,
      Math.max(0, Math.ceil((tick - info.start_tick) / step))
    );
  /** The living at sample `k` nearest (x, y, z) among `who`, or null. */
  const nearest = (
    k: number,
    x: number,
    y: number,
    z: number,
    who: (q: number) => boolean
  ): number | null => {
    let best = Infinity;
    let out: number | null = null;
    for (let q = 0; q < n; q++) {
      if (!who(q) || !live(q, k)) continue;
      const t = tracks[q];
      const dist = Math.hypot(t.x[k] - x, t.y[k] - y, t.z[k] - z);
      if (dist < best) {
        best = dist;
        out = q;
      }
    }
    return out;
  };
  /** The first scored event in [tick, tick + `windowTicks`] of whom `match` accepts. */
  const firstAhead = (
    tick: number,
    windowTicks: number,
    match: (e: Scored) => boolean
  ): Scored | null => {
    for (let i = lowerBound(d.events, tick); i < d.events.length; i++) {
      const e = d.events[i];
      if (e.tick > tick + windowTicks) break;
      if (match(e)) return e;
    }
    return null;
  };

  const every = Math.max(1, Math.round(DIRECTOR.evalS * header.sample_hz));
  const evalTicks = every * step;
  const lead = DIRECTOR.leadS * rate;
  const hold = DIRECTOR.holdS * rate;
  const deathHold = DEATH_VIEW_S * rate;
  const lastK = info.samples - 1;

  const cuts: DirectorCut[] = [];
  /** The current target, since when, and the last sample it was seen alive at or after. */
  let cur = -1;
  let since = info.start_tick;
  let seen = 0;
  const cutTo = (tick: number, follow: number, reason: string) => {
    if (follow === cur) return;
    cuts.push({ tick, follow, reason });
    cur = follow;
    since = tick;
    seen = sampleAt(tick);
  };

  // The first cut: the best of the living at the start, else the first player to live.
  let first = bestOf(scorePlayers(pack, round, info.start_tick), null);
  for (let k = 0; first === null && k <= lastK; k++)
    for (let p = 0; p < n && first === null; p++) if (live(p, k)) first = p;
  if (first === null) return [];
  cutTo(info.start_tick, first, 'start');

  /**
   * After the current target died at sample `dead`: at `tick`, the killer if alive, else the
   * nearest living teammate (as POV cuts on its own), unless someone beats them by the
   * margin. False when nobody is left to show.
   */
  const afterDeath = (tick: number, dead: number): boolean => {
    const victim = cur;
    const ks = sampleAt(tick);
    let next = d.killer.get(victim) ?? null;
    if (next === null || next === victim || !live(next, ks)) {
      const body = tracks[victim];
      const b = Math.max(0, dead - 1);
      const t = team(victim);
      next = nearest(
        ks,
        body.x[b],
        body.y[b],
        body.z[b],
        (q) => q !== victim && t !== 0 && team(q) === t
      );
    }
    const s = scorePlayers(pack, round, tick);
    for (let q = 0; q < s.length; q++) if (!live(q, ks)) s[q] = -Infinity;
    const top = bestOf(s, next);
    if (next === null || (top !== null && s[top] - s[next] >= DIRECTOR.margin))
      next = top;
    if (next === null) return false;
    cutTo(tick, next, 'death');
    return true;
  };

  /** What the current target's own death ahead adds to their score at `tick`. */
  const ownDeath = (tick: number): number => {
    const e = firstAhead(
      tick,
      DIRECTOR.farS * rate,
      (x) => x.player === cur && x.kind === 'death'
    );
    if (!e) return 0;
    return e.tick <= tick + DIRECTOR.nearS * rate
      ? e.value
      : e.value * DIRECTOR.farWeight;
  };

  /** The cut after the current target's death, and the sample they died at. */
  let pending: { tick: number; dead: number } | null = null;

  for (let k = every; k <= lastK; k += every) {
    const tau = tickOf(k);
    if (tau > info.post_end_tick) break;

    if (!pending && !live(cur, k)) {
      // Died since the last look: hold their death view, as POV does on its own.
      let dead = -1;
      for (let j = Math.max(1, seen + 1); j <= k && dead < 0; j++)
        if (live(cur, j - 1) && !live(cur, j)) dead = j;
      if (dead < 0) {
        // Never alive since the cut (absent, not spawned yet): the best of the living now.
        const top = bestOf(scorePlayers(pack, round, tau), null);
        if (top !== null) cutTo(tau, top, 'absent');
        continue;
      }
      const at = tickOf(dead) + deathHold;
      // A death too late to cut away from holds the death view to the end of the round.
      if (at > info.post_end_tick) break;
      pending = { tick: at, dead };
    }
    if (pending) {
      if (pending.tick >= tau + evalTicks) continue;
      const { tick, dead } = pending;
      pending = null;
      if (!afterDeath(tick, dead)) break;
      continue;
    }
    seen = k;

    // The bomb's last seconds with no fight ahead: the defuser, else a guard.
    const b = d.bomb;
    if (
      b &&
      tau >= b.from &&
      tau <= b.to &&
      !firstAhead(tau, DIRECTOR.nearS * rate, (e) => e.fight)
    ) {
      let target: number | null = null;
      let at = tau;
      let reason = 'bomb-defuser';
      for (let p = 0; p < n && target === null; p++)
        if (live(p, k) && (tracks[p].flags[k] & FLAG.defusing) !== 0)
          target = p;
      for (const df of d.defuses) {
        if (target !== null || df.tick >= tau + lead + evalTicks) break;
        if (df.tick < tau || !live(df.player, k)) continue;
        target = df.player;
        at = Math.max(tau, df.tick - lead);
      }
      if (target === null) {
        reason = 'bomb-guard';
        const t = team(b.planter);
        target = nearest(
          k,
          b.x,
          b.y,
          b.z,
          (q) => q !== b.planter && t !== 0 && team(q) === t
        );
        if (target === null && live(b.planter, k)) target = b.planter;
        at = Math.max(at, since + hold);
      }
      if (target !== null && target !== cur && at < tau + evalTicks)
        cutTo(at, target, reason);
      continue;
    }

    // Of those who beat the current target by the margin, the best whose cut lands before
    // the next look: a cut lands `lead` before the player's first scored event ahead, so a
    // kill 1.5 s away is not given up for a bigger score 10 s away.
    const s = scorePlayers(pack, round, tau);
    if (s[cur] === -Infinity) continue;
    const held = s[cur] - ownDeath(tau);
    let pick: number | null = null;
    let pickAt = 0;
    let pickWon: Scored | null = null;
    for (let p = 0; p < n; p++) {
      if (p === cur || s[p] - held < DIRECTOR.margin) continue;
      if (pick !== null && s[p] <= s[pick]) continue;
      const won = firstAhead(tau, DIRECTOR.farS * rate, (e) => e.player === p);
      const at = Math.max(tau, won ? won.tick - lead : tau, since + hold);
      if (at >= tau + evalTicks || at > info.post_end_tick) continue;
      pick = p;
      pickAt = at;
      pickWon = won;
    }
    if (pick !== null) cutTo(pickAt, pick, pickWon ? pickWon.kind : 'near');
  }
  if (pending && pending.tick <= info.post_end_tick)
    afterDeath(pending.tick, pending.dead);
  return cuts;
}

/**
 * `planDirector`, cached per pack and round. The plan never changes for a pack, so the
 * cache lives as long as the pack does.
 */
export function directorPlan(pack: Pack, round: number): DirectorCut[] {
  let byRound = plans.get(pack);
  if (!byRound) {
    byRound = new Map();
    plans.set(pack, byRound);
  }
  let cuts = byRound.get(round);
  if (!cuts) {
    cuts = planDirector(pack, round);
    byRound.set(round, cuts);
  }
  return cuts;
}

/** The player the director follows at `tick` (the first cut's before it); -1 without cuts. */
export function directorTargetAt(
  cuts: readonly DirectorCut[],
  tick: number
): number {
  if (cuts.length === 0) return -1;
  let lo = 0;
  let hi = cuts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cuts[mid].tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  return cuts[lo].follow;
}
