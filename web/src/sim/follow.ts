// The two camera modes, and who POV shows: a pure function of (pack, round, tick, follow,
// pinned), as `followLegs` plans it. The followed player (or, when they are not alive at all in
// the round, their first living teammate); once they die, their death view (`sim/deathview`: the
// eye where they died, looking where they looked) for `DEATH_VIEW_S`, then the killer, else the
// nearest living teammate, unless the user picked that player (pinned), whose death view is then
// held to the end of the round. The store answers "who the camera shows" from it (`shownAt`) for
// the player list, the radar and the HUD, as the POV camera does (`scene/cameras`), without
// three.js.

import { FLAG, type Pack } from '../pack/types';
import { DEATH_VIEW_S } from './deathview';

export type CameraMode = 'pov' | 'free';
export const CAMERA_MODES: readonly CameraMode[] = ['pov', 'free'];

export function isCameraMode(v: unknown): v is CameraMode {
  return CAMERA_MODES.includes(v as CameraMode);
}

/** From tick `from` on (until the next leg), the camera shows `player`. */
export interface FollowLeg {
  from: number;
  player: number;
}

/**
 * `killerOf` for round index `round`: each victim's first `player_death` in the round, by its
 * `attacker_idx`. A killer that is not one of `header.players` is null.
 */
export function killersOf(
  pack: Pack,
  round: number
): (player: number) => number | null {
  const info = pack.header.rounds[round];
  const n = pack.header.players.length;
  const killer = new Map<number, number | null>();
  if (info)
    for (const e of pack.events) {
      if (e.kind !== 'player_death') continue;
      if (e.tick < info.start_tick || e.tick > info.end_tick) continue;
      const victim = index(e.data.user_idx, n);
      if (victim === null || killer.has(victim)) continue;
      killer.set(victim, index(e.data.attacker_idx, n));
    }
  return (player) => killer.get(player) ?? null;
}

function index(v: unknown, n: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < n
    ? v
    : null;
}

/**
 * Who the camera shows through round `round`, as legs in tick order: `follow` (or, when they
 * are not alive at all this round, their first teammate who is, else the first player who is),
 * then after each death and `holdS` (their death view), the killer if alive, else the nearest
 * living teammate. A pinned `follow` is held on to the end of the round. Empty when nobody in
 * the round is ever alive.
 */
export function followLegs(
  pack: Pack,
  round: number,
  follow: number | null,
  pinned: boolean,
  killerOf: (player: number) => number | null,
  holdS = DEATH_VIEW_S
): FollowLeg[] {
  const { header } = pack;
  const info = header.rounds[round];
  const tracks = pack.rounds[round]?.players;
  if (!info || !tracks) return [];
  const n = Math.min(header.players.length, tracks.length);
  const count = (p: number) => Math.min(info.samples, tracks[p].flags.length);
  const alive = (p: number, k: number) =>
    k >= 0 && k < count(p) && (tracks[p].flags[k] & FLAG.alive) !== 0;
  const lives = (p: number) => {
    for (let k = 0; k < count(p); k++) if (alive(p, k)) return true;
    return false;
  };
  const team = (p: number) => header.players[p]?.team_by_round[round] ?? 0;
  const step = header.tick_step;

  let p: number | null =
    follow !== null && follow >= 0 && follow < n ? follow : null;
  let held = pinned && p !== null;
  if (p === null || !lives(p)) {
    const t = p === null ? 0 : team(p);
    let sub: number | null = null;
    for (let q = 0; q < n && sub === null; q++)
      if (t !== 0 && team(q) === t && lives(q)) sub = q;
    for (let q = 0; q < n && sub === null; q++) if (lives(q)) sub = q;
    if (sub === null) return [];
    p = sub;
    held = false;
  }

  const legs: FollowLeg[] = [{ from: -Infinity, player: p }];
  const hold = holdS * header.tick_rate;
  let k0 = 0;
  for (let guard = 0; guard <= n && !held; guard++) {
    // The first death from k0 on: a live sample followed by a dead one.
    let d = -1;
    for (let k = Math.max(1, k0); k < count(p) && d < 0; k++)
      if (alive(p, k - 1) && !alive(p, k)) d = k;
    if (d < 0) break;
    const at = info.start_tick + d * step + hold;
    if (at > info.end_tick) break;
    const ks = Math.ceil((at - info.start_tick) / step);
    const body = d - 1;
    let next = killerOf(p);
    if (next === null || next === p || next >= n || !alive(next, ks)) {
      next = null;
      let best = Infinity;
      const tp = tracks[p];
      for (let q = 0; q < n; q++) {
        if (q === p || team(q) === 0 || team(q) !== team(p) || !alive(q, ks))
          continue;
        const tq = tracks[q];
        const dist = Math.hypot(
          tq.x[ks] - tp.x[body],
          tq.y[ks] - tp.y[body],
          tq.z[ks] - tp.z[body]
        );
        if (dist < best) {
          best = dist;
          next = q;
        }
      }
    }
    if (next === null) break;
    legs.push({ from: at, player: next });
    p = next;
    k0 = ks;
  }
  return legs;
}

/** The player `legs` show at `tick`. */
export function legAt(legs: readonly FollowLeg[], tick: number): number | null {
  let who: number | null = null;
  for (const l of legs) {
    if (l.from > tick) break;
    who = l.player;
  }
  return who;
}
