// Locomotion: which looping clips a moving player blends, from the track alone. Pure.
//
// Direction: the horizontal velocity relative to the yaw picks the two nearest of a family's
// directional clips, weighted by angle. Gait: idle below SPEED_IDLE; walk with the walking
// flag or below SPEED_RUN; run above. Crouch: the stand and crouch sets blend by the duck
// amount. Airborne, ladders and turning in place override. Thresholds from the phase 3
// plan, the rest from the phase 3c animation plan.

import {
  FLAG,
  type MatchHeader,
  type Pack,
  type PlayerTrack,
  type RoundInfo,
} from '../pack/types';
import { newPlayerState, playerStateAt } from './sample';
import type { Family } from './weapons';

export interface ClipWeight {
  clip: string;
  weight: number;
  /** Seconds into the clip, or null for "the round clock modulo the clip's length". */
  time: number | null;
}

export interface LocomotionInput {
  /** Horizontal speed, units/s. */
  speed: number;
  /** Degrees between the velocity and the view yaw: 0 forward, +90 right, ±180 back. */
  velocityAngle: number;
  /** Vertical speed, units/s (up positive). */
  vertical: number;
  /** 0..255. */
  duck: number;
  /** Bit set of `FLAG`. */
  flags: number;
  /** Degrees/s, right positive. */
  yawRate: number;
  family: Family;
}

/** Below this horizontal speed a player stands. */
export const SPEED_IDLE = 20;
/** At or above this speed (and without the walking flag) a player runs. */
export const SPEED_RUN = 140;
/** Vertical speed above which a player off the ground is on a ladder. */
export const LADDER_VERTICAL = 60;
/** Horizontal speed below which a climbing player is only climbing. */
export const LADDER_HORIZONTAL = 40;
/** Turning in place: more than 25° within 0.3 s. */
export const TURN_RATE = 25 / 0.3;
/** Turn clips: 45° below this many degrees per 0.3 s, 90° above. */
export const TURN_90_DEG = 70;

const DIRS8 = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const DIRS4 = ['n', 'e', 's', 'w'];

/** The directional clips each family ships, per gait (tools/lib/players.mjs CLIP_SET). */
const SETS: Record<
  'rifle' | 'pistol' | 'knife',
  { run: string[]; walk: string[]; crouch: string[] }
> = {
  rifle: { run: DIRS8, walk: DIRS8, crouch: DIRS4 },
  pistol: { run: DIRS8, walk: DIRS4, crouch: ['n', 's'] },
  knife: { run: DIRS4, walk: ['n', 's'], crouch: ['n'] },
};

/** Grenades and the c4 move with the pistol set (they have no locomotion clips). */
export function locomotionFamily(f: Family): 'rifle' | 'pistol' | 'knife' {
  return f === 'rifle' || f === 'pistol' || f === 'knife' ? f : 'pistol';
}

const DEG = {
  n: 0,
  ne: 45,
  e: 90,
  se: 135,
  s: 180,
  sw: 225,
  w: 270,
  nw: 315,
} as const;

function wrap360(d: number): number {
  return ((d % 360) + 360) % 360;
}

/**
 * The two directional clips nearest `angle` (degrees, 0 forward, clockwise), weighted by
 * angle. One clip when the angle hits it, or when the set has one entry.
 */
export function directionBlend(
  angle: number,
  dirs: readonly string[]
): { dir: string; weight: number }[] {
  const a = wrap360(angle);
  if (dirs.length === 1) return [{ dir: dirs[0], weight: 1 }];
  // The set's directions sorted by angle, with the first repeated at 360 so the wrap blends.
  const sorted: { dir: string; deg: number }[] = dirs
    .map((d) => ({ dir: d, deg: DEG[d as keyof typeof DEG] as number }))
    .sort((p, q) => p.deg - q.deg);
  sorted.push({ dir: sorted[0].dir, deg: sorted[0].deg + 360 });
  for (let i = 0; i + 1 < sorted.length; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    if (a < lo.deg || a > hi.deg) continue;
    if (a === lo.deg) return [{ dir: lo.dir, weight: 1 }];
    if (a === hi.deg) return [{ dir: hi.dir, weight: 1 }];
    const t = (a - lo.deg) / (hi.deg - lo.deg);
    return [
      { dir: lo.dir, weight: 1 - t },
      { dir: hi.dir, weight: t },
    ];
  }
  return [{ dir: sorted[0].dir, weight: 1 }];
}

function push(out: ClipWeight[], clip: string, weight: number): void {
  if (weight <= 0) return;
  const hit = out.find((c) => c.clip === clip);
  if (hit) hit.weight += weight;
  else out.push({ clip, weight, time: null });
}

/** The clips a player blends at this instant; weights sum to 1. */
export function locomotionBlend(i: LocomotionInput): ClipWeight[] {
  const f = locomotionFamily(i.family);
  const out: ClipWeight[] = [];
  const crouch = Math.min(1, Math.max(0, i.duck / 255));
  if (i.flags & FLAG.airborne) {
    if (f === 'rifle' && crouch >= 0.5)
      push(out, 'inair_crouch_stand_rifle', 1);
    else push(out, `inair_stand_${f}`, 1);
    return out;
  }
  if (Math.abs(i.vertical) > LADDER_VERTICAL && i.speed < LADDER_HORIZONTAL) {
    push(
      out,
      crouch >= 0.5 ? 'ladder_facing_crouch_rifle' : 'ladder_facing_fast_rifle',
      1
    );
    return out;
  }
  if (i.speed < SPEED_IDLE) {
    if (Math.abs(i.yawRate) > TURN_RATE) {
      const side = i.yawRate > 0 ? 'right' : 'left';
      const deg = Math.abs(i.yawRate) * 0.3 < TURN_90_DEG ? 45 : 90;
      push(out, `turn_${side}_loop_${deg}_rifle`, 1);
      return out;
    }
    push(out, `idle_${f}`, 1 - crouch);
    push(out, `idle_crouch_${f}`, crouch);
    return out;
  }
  const gait = i.flags & FLAG.walking || i.speed < SPEED_RUN ? 'walk' : 'run';
  const set = SETS[f];
  for (const { dir, weight } of directionBlend(i.velocityAngle, set[gait]))
    push(out, `${gait}_${dir}_${f}`, weight * (1 - crouch));
  for (const { dir, weight } of directionBlend(i.velocityAngle, set.crouch))
    push(out, `crouch_${dir}_${f}`, weight * crouch);
  return out;
}

export interface Velocity {
  /** Horizontal speed, units/s. */
  speed: number;
  /** Degrees between the velocity and the yaw: 0 forward, +90 right. */
  velocityAngle: number;
  /** Units/s, up positive. */
  vertical: number;
  /** Degrees/s, right positive. */
  yawRate: number;
}

function wrapDeg(d: number): number {
  const w = d - 360 * Math.floor((d + 180) / 360);
  return w === -180 ? 180 : w;
}

const a = newPlayerState();
const b = newPlayerState();
const c = newPlayerState();

/**
 * The player's velocity at `tick`: a central difference one sample step either side (one-sided
 * at a round edge or next to a dead sample; zero when alone). Source coordinates: yaw 0 is +x,
 * counterclockwise seen from above, so the right-hand side is (sin yaw, −cos yaw).
 */
export function playerVelocityAt(
  track: PlayerTrack,
  round: RoundInfo,
  tick: number,
  header: MatchHeader,
  out: Velocity = { speed: 0, velocityAngle: 0, vertical: 0, yawRate: 0 }
): Velocity {
  const step = header.tick_step;
  const t0 = Math.max(round.start_tick, tick - step);
  const t1 = Math.min(round.post_end_tick, tick + step);
  playerStateAt(track, round, tick, header, c);
  playerStateAt(track, round, t0, header, a);
  playerStateAt(track, round, t1, header, b);
  const p0 = a.present && (a.flags & FLAG.alive) !== 0 ? a : c;
  const p1 = b.present && (b.flags & FLAG.alive) !== 0 ? b : c;
  const ticks = (p0 === a ? tick - t0 : 0) + (p1 === b ? t1 - tick : 0);
  out.speed = 0;
  out.velocityAngle = 0;
  out.vertical = 0;
  out.yawRate = 0;
  if (ticks <= 0 || !c.present) return out;
  const dt = ticks / header.tick_rate;
  const vx = (p1.x - p0.x) / dt;
  const vy = (p1.y - p0.y) / dt;
  out.vertical = (p1.z - p0.z) / dt;
  out.yawRate = wrapDeg(p1.yaw - p0.yaw) / dt;
  out.speed = Math.hypot(vx, vy);
  if (out.speed > 0) {
    const yaw = (c.yaw * Math.PI) / 180;
    const fwd = vx * Math.cos(yaw) + vy * Math.sin(yaw);
    const right = vx * Math.sin(yaw) - vy * Math.cos(yaw);
    out.velocityAngle = (Math.atan2(right, fwd) * 180) / Math.PI;
  }
  return out;
}

/** Convenience over a pack: the input `locomotionBlend` wants for player `p` at `tick`. */
export function locomotionInputAt(
  pack: Pack,
  round: number,
  p: number,
  tick: number,
  family: Family,
  out?: LocomotionInput
): LocomotionInput | null {
  const info = pack.header.rounds[round];
  const track = pack.rounds[round]?.players[p];
  if (!info || !track) return null;
  const v = playerVelocityAt(track, info, tick, pack.header);
  const s = playerStateAt(track, info, tick, pack.header, c);
  if (!s.present) return null;
  const o = out ?? {
    speed: 0,
    velocityAngle: 0,
    vertical: 0,
    duck: 0,
    flags: 0,
    yawRate: 0,
    family,
  };
  o.speed = s.speed;
  o.velocityAngle = v.velocityAngle;
  o.vertical = v.vertical;
  o.duck = s.duck;
  o.flags = s.flags;
  o.yawRate = v.yawRate;
  o.family = family;
  return o;
}
