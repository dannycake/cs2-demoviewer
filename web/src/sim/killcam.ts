// The kill cam (M4 plan, Task 6): a death replayed from `beforeS` before it to `afterS` after,
// clamped to the round's live part and after-round, `[freeze_end_tick, post_end_tick]`, in POV
// (`enterSegment`). It is on the attacker when the attacker is another player still alive at
// the kill, and otherwise on the victim, ending on their death view (`sim/deathview`): there
// is no kill cam from a dead player's eyes (a grenade or fire that killed after its thrower
// fell, a trade at one tick), nor from the world's or a suicide's. Kills come from
// `timelineFor(pack).kills(round)`, so a death is always in the round it is looked up in.

import type { Pack } from '../pack/types';
import type { ReelSegment } from '../state/reel';
import { DEATH_VIEW_S } from './deathview';
import { timelineFor, type Kill } from './timeline';

export const KILLCAM = Object.freeze({
  /** Seconds shown before the death… */
  beforeS: 5,
  /** …and after it. */
  afterS: 1,
});

/** The kill cam of `kill`, a death in `round`. */
export function killcamSegment(
  pack: Pack,
  round: number,
  kill: Kill
): ReelSegment {
  const { header } = pack;
  const info = header.rounds[round];
  const ticks = (s: number) => Math.round(s * header.tick_rate);
  const lo = info?.freeze_end_tick ?? -Infinity;
  const hi = info ? (info.post_end_tick ?? info.end_tick) : Infinity;
  // A death in the freeze time (or past the after-round) still starts or ends its window.
  const from = Math.min(
    kill.tick,
    Math.max(lo, kill.tick - ticks(KILLCAM.beforeS))
  );
  const to = Math.max(
    kill.tick,
    Math.min(hi, kill.tick + ticks(KILLCAM.afterS))
  );
  const name = (p: number) => header.players[p]?.name ?? `player ${p + 1}`;
  const attacker =
    kill.attacker !== null && kill.attacker !== kill.victim
      ? kill.attacker
      : null;
  const attackerAlive =
    attacker !== null && !diedBy(pack, round, attacker, kill.tick);
  return {
    round,
    from,
    to,
    follow: attackerAlive ? attacker : kill.victim,
    title:
      attacker !== null
        ? `Kill cam · ${name(attacker)} killed ${name(kill.victim)}`
        : `Kill cam · ${name(kill.victim)} died`,
  };
}

/**
 * Whether `player` has died in `round` by `tick`: a death of theirs at or before it, so a kill
 * at the tick of the killer's own death (a trade) is not from a living player's eyes either.
 */
export function diedBy(
  pack: Pack,
  round: number,
  player: number,
  tick: number
): boolean {
  return timelineFor(pack)
    .kills(round)
    .some((k) => k.victim === player && k.tick <= tick);
}

/** `player`'s last death in `round` at or before `tick`, or null. */
export function lastDeath(
  pack: Pack,
  round: number,
  player: number,
  tick: number
): Kill | null {
  const kills = timelineFor(pack).kills(round);
  for (let i = kills.length - 1; i >= 0; i--)
    if (kills[i].victim === player && kills[i].tick <= tick) return kills[i];
  return null;
}

/**
 * The followed player's kill whose death + `DEATH_VIEW_S` falls in (prevTick, tick] of one
 * round: the moment the camera has held their death view and would cut away, which is when an
 * automatic kill cam starts. Null with nobody followed.
 */
export function autoKillcamAt(
  pack: Pack,
  round: number,
  follow: number | null,
  prevTick: number,
  tick: number
): Kill | null {
  if (follow === null) return null;
  const hold = DEATH_VIEW_S * pack.header.tick_rate;
  for (const k of timelineFor(pack).kills(round)) {
    if (k.victim !== follow) continue;
    const at = k.tick + hold;
    if (at > prevTick && at <= tick) return k;
  }
  return null;
}
