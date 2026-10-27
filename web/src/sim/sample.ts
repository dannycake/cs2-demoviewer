// A player's state at a fractional tick, read from the round's tracks. Pure: the result
// depends only on (track, round, tick), so scrubbing in any direction gives the same pose.

import {
  FLAG,
  type MatchHeader,
  type PlayerTrack,
  type RoundInfo,
} from '../pack/types';

export interface PlayerState {
  /** Source units. */
  x: number;
  y: number;
  z: number;
  /** Degrees, yaw in (-180, 180]. */
  yaw: number;
  pitch: number;
  health: number;
  armor: number;
  /** Bit set of `FLAG`. */
  flags: number;
  /** 0..255, fractional between samples. */
  duck: number;
  /** Index into `MatchHeader.weapons`. */
  weapon: number;
  /** Money; 0 without data. */
  money: number;
  /** Rounds in the magazine; `GEAR.ammoNone` (255) without one or without data. */
  ammo: number;
  /** Bit set of `GEAR`: helmet, defuse kit, zoom level. */
  gear: number;
  /**
   * Horizontal speed in units/s: the displacement across a sample interval, widened by
   * `speedHalfWindow(sample_hz)` live samples on each side. That is the speed at the middle of
   * the interval; between two middles it moves linearly, so it never steps at a sample.
   */
  speed: number;
  /** False when the player has no live sample at this tick (dead, or not in the round). */
  present: boolean;
}

/**
 * Speed is measured over about this many seconds. Positions are whole units, so between
 * consecutive samples at 32 Hz speed only comes in steps of 32 u/s, and a player standing
 * still with a one-unit wobble reads as walking. On the Mirage pack, measuring across
 * consecutive samples gave 34,246 clip changes, 12,082 of them lasting a single sample;
 * a 0.15 s window gave 20,953 and 1,914.
 */
export const SPEED_WINDOW_S = 0.15;

/**
 * A step this long or longer between two live samples is a teleport (a respawn), not motion:
 * nothing is smoothed across it.
 */
export const TELEPORT_UNITS = 64;

/** Extra live samples taken on each side of the current interval when measuring speed. */
export function speedHalfWindow(sampleHz: number): number {
  return Math.max(0, Math.round((SPEED_WINDOW_S * sampleHz - 1) / 2));
}

export function newPlayerState(): PlayerState {
  return {
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 0,
    armor: 0,
    flags: 0,
    duck: 0,
    weapon: 0,
    money: 0,
    ammo: 255,
    gear: 0,
    speed: 0,
    present: false,
  };
}

/**
 * The sample at or before `tick` and the fraction `f` in [0, 1) towards the next one,
 * clamped to the round (`f = 0` on the last sample), written into `out` (a caller that runs
 * every frame passes its own, so nothing is allocated).
 */
export function sampleIndex(
  round: RoundInfo,
  tick: number,
  tickStep: number,
  out: { k: number; f: number } = { k: 0, f: 0 }
): { k: number; f: number } {
  const last = round.samples - 1;
  const pos = (tick - round.start_tick) / tickStep;
  if (last <= 0 || !(pos > 0)) {
    out.k = 0;
    out.f = 0;
  } else if (pos >= last) {
    out.k = last;
    out.f = 0;
  } else {
    out.k = Math.floor(pos);
    out.f = pos - out.k;
  }
  return out;
}

/** Wraps degrees into (-180, 180]. */
function wrapDeg(d: number): number {
  const w = d - 360 * Math.floor((d + 180) / 360);
  return w === -180 ? 180 : w;
}

/**
 * Fills `out` with the player's state at `tick`.
 *
 * - Between two live samples, the motion is smooth across samples, not only within them:
 *   - position follows a uniform cubic B-spline with the live samples around the interval
 *     as its control points: velocity and acceleration are continuous, so there is no kink
 *     every sample, and the whole-unit rounding of the pack (up to half a unit per axis, a
 *     32 u/s step in speed between samples) is evened out. At a sample it passes a sixth of
 *     the bend there inside it; it stays within the samples (no overshoot at a stop), keeps a
 *     straight steady run exact, and meets a sample with no live neighbour (a spawn, the last
 *     sample before a death) exactly. Measured on the Mirage demo against its own 64-tick
 *     positions at 1/8 unit, it is nearer the truth than straight lines between samples
 *     (0.30 against 0.36 units RMS while running);
 *   - yaw (by the shortest arc) and pitch follow a monotone cubic through the samples: the
 *     turn rate is continuous, every sample is met exactly (where the crosshair was is where
 *     it was), and a flick that stops dead does not swing past where it stopped;
 *   - `duck` moves linearly, so the eye height and the crouch blend do not step every sample;
 *   - the other `u8` columns come from the lower sample;
 *   - `speed` is as `PlayerState.speed` says; on the last sample, the last interval's.
 *   A step of `TELEPORT_UNITS` or more ends the smoothing: across it everything is linear, and
 *   samples beyond it do not bend the path before it.
 * - Between a live and a dead sample (spawning or dying): everything is the live sample's,
 *   with `speed` 0, so a rig neither slides in from nor towards a dead sample's position.
 * - `present = alive at k || (f > 0 && alive at k + 1)`.
 * - With no live sample, `present` is false and the fields are the lower sample's.
 */
export function playerStateAt(
  track: PlayerTrack,
  round: RoundInfo,
  tick: number,
  header: MatchHeader,
  out: PlayerState
): PlayerState {
  const { k, f } = sampleIndex(round, tick, header.tick_step);
  if (round.samples === 0) {
    Object.assign(out, newPlayerState());
    return out;
  }
  const last = round.samples - 1;
  const k1 = Math.min(k + 1, last);
  const aliveK = alive(track, k);
  const aliveK1 = alive(track, k1);
  out.present = aliveK || (f > 0 && aliveK1);

  if (aliveK && aliveK1 && k1 !== k) {
    const yaw0 = track.yaw[k] / 100;
    const turn = wrapDeg(track.yaw[k1] / 100 - yaw0);
    const pitch0 = track.pitch[k] / 100;
    const pitch = track.pitch[k1] / 100 - pitch0;
    copyU8(track, k, out);
    out.duck = track.duck[k] + (track.duck[k1] - track.duck[k]) * f;
    out.speed = speedAt(track, k, f, last, header.sample_hz);
    if (teleport(track, k, k1)) {
      out.x = track.x[k] + (track.x[k1] - track.x[k]) * f;
      out.y = track.y[k] + (track.y[k1] - track.y[k]) * f;
      out.z = track.z[k] + (track.z[k1] - track.z[k]) * f;
      out.yaw = wrapDeg(yaw0 + turn * f);
      out.pitch = pitch0 + pitch * f;
      return out;
    }
    // The live neighbours on each side, or -1 for none (a death, a spawn, a teleport, the
    // round's edge): the path then carries on in a straight line past that end.
    const prev =
      k > 0 && alive(track, k - 1) && !teleport(track, k - 1, k) ? k - 1 : -1;
    const next =
      k1 < last && alive(track, k1 + 1) && !teleport(track, k1, k1 + 1)
        ? k1 + 1
        : -1;
    out.x = bspline(track.x, prev, k, k1, next, f);
    out.y = bspline(track.y, prev, k, k1, next, f);
    out.z = bspline(track.z, prev, k, k1, next, f);
    const turnIn = prev < 0 ? turn : wrapDeg(yaw0 - track.yaw[prev] / 100);
    const turnOut =
      next < 0 ? turn : wrapDeg(track.yaw[next] / 100 - track.yaw[k1] / 100);
    out.yaw = wrapDeg(yaw0 + monotone(turnIn, turn, turnOut, f));
    const pitchIn = prev < 0 ? pitch : pitch0 - track.pitch[prev] / 100;
    const pitchOut =
      next < 0 ? pitch : track.pitch[next] / 100 - track.pitch[k1] / 100;
    out.pitch = pitch0 + monotone(pitchIn, pitch, pitchOut, f);
    return out;
  }

  // One endpoint (or none) is live, or this is the last sample.
  const src = !aliveK && f > 0 && aliveK1 ? k1 : k;
  sampleAt(track, src, out);
  // On the last sample of a live player, keep the last segment's speed so the clip does not
  // drop to idle at the round's end.
  out.speed =
    src === last && last > 0 && aliveK && alive(track, last - 1)
      ? windowSpeed(track, last - 1, last, last, header.sample_hz)
      : 0;
  return out;
}

/**
 * `out` ← sample `k` of `track` as the pack stores it: position, angles (yaw wrapped into
 * (-180, 180]) and the u8 columns. `present` and `speed` are left alone.
 */
export function sampleAt(
  track: PlayerTrack,
  k: number,
  out: PlayerState
): PlayerState {
  out.x = track.x[k];
  out.y = track.y[k];
  out.z = track.z[k];
  out.yaw = wrapDeg(track.yaw[k] / 100);
  out.pitch = track.pitch[k] / 100;
  copyU8(track, k, out);
  return out;
}

function copyU8(track: PlayerTrack, k: number, out: PlayerState) {
  out.health = track.health[k];
  out.armor = track.armor[k];
  out.flags = track.flags[k];
  out.duck = track.duck[k];
  out.weapon = track.weapon[k];
  out.money = track.money[k] ?? 0;
  out.ammo = track.ammo[k] ?? 255;
  out.gear = track.gear[k] ?? 0;
}

function alive(track: PlayerTrack, k: number): boolean {
  return (track.flags[k] & FLAG.alive) !== 0;
}

/** Whether samples `a` and `b` are a teleport apart (`TELEPORT_UNITS`). */
function teleport(track: PlayerTrack, a: number, b: number): boolean {
  return (
    Math.hypot(
      track.x[b] - track.x[a],
      track.y[b] - track.y[a],
      track.z[b] - track.z[a]
    ) >= TELEPORT_UNITS
  );
}

/**
 * The uniform cubic B-spline of `col` at `f` between samples `b` and `c`, with the control
 * points `a` before and `d` after; a missing one (-1) is reflected through its neighbour
 * (`2b − c`, `2c − b`), which makes the curve meet that end's sample with the interval's own
 * velocity.
 */
function bspline(
  col: ArrayLike<number>,
  a: number,
  b: number,
  c: number,
  d: number,
  f: number
): number {
  const p1 = col[b];
  const p2 = col[c];
  const p0 = a < 0 ? 2 * p1 - p2 : col[a];
  const p3 = d < 0 ? 2 * p2 - p1 : col[d];
  const g = 1 - f;
  const f2 = f * f;
  const f3 = f2 * f;
  return (
    (g * g * g * p0 +
      (3 * f3 - 6 * f2 + 4) * p1 +
      (-3 * f3 + 3 * f2 + 3 * f + 1) * p2 +
      f3 * p3) /
    6
  );
}

/**
 * The offset at `f` along an interval that moves `d1`, after one that moved `d0` and before
 * one that moves `d2`: a cubic Hermite with the harmonic mean of the neighbouring steps as its
 * slope at each end (zero where the motion turns back), which is monotone within the interval
 * and meets both samples exactly (Fritsch and Butland, 1984).
 */
function monotone(d0: number, d1: number, d2: number, f: number): number {
  const m1 = d0 * d1 > 0 ? (2 * d0 * d1) / (d0 + d1) : 0;
  const m2 = d1 * d2 > 0 ? (2 * d1 * d2) / (d1 + d2) : 0;
  const f2 = f * f;
  const f3 = f2 * f;
  return (f3 - 2 * f2 + f) * m1 + (3 * f2 - 2 * f3) * d1 + (f3 - f2) * m2;
}

/**
 * `PlayerState.speed` at `f` into the live interval from sample `k`: its window speed at the
 * middle, moving linearly to the next live interval's at the next middle (the same speed
 * where there is none).
 */
function speedAt(
  track: PlayerTrack,
  k: number,
  f: number,
  last: number,
  sampleHz: number
): number {
  const here = windowSpeed(track, k, k + 1, last, sampleHz);
  const j = f < 0.5 ? k - 1 : k + 1;
  const there =
    j >= 0 && j + 1 <= last && alive(track, j) && alive(track, j + 1)
      ? windowSpeed(track, j, j + 1, last, sampleHz)
      : here;
  return here + (there - here) * Math.abs(f - 0.5);
}

/** Speed across the live interval [lo, hi], widened on each side without crossing a death. */
function windowSpeed(
  track: PlayerTrack,
  lo: number,
  hi: number,
  last: number,
  sampleHz: number
): number {
  const a = speedHalfWindow(sampleHz);
  for (let i = 0; i < a && lo > 0 && alive(track, lo - 1); i++) lo--;
  for (let i = 0; i < a && hi < last && alive(track, hi + 1); i++) hi++;
  return (
    (Math.hypot(track.x[hi] - track.x[lo], track.y[hi] - track.y[lo]) *
      sampleHz) /
    (hi - lo)
  );
}
