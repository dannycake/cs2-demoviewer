// Where a player's feet fall, read from the track: the pack's own `player_footstep` is too
// sparse to drive the steps (993 on the Mirage pack, a median 5 s apart per player), so a
// running player steps on a beat and a player coming down from the air lands. Pure.

import {
  FLAG,
  type MatchHeader,
  type PlayerTrack,
  type RoundInfo,
} from '../pack/types';
import { newPlayerState, playerStateAt } from './sample';

/** Units/s at and over which a player steps: CS2's walk threshold, 260 × 0.52. */
export const STEP_SPEED = 135.2;
/** Seconds between two steps of a running player. */
export const STEP_S = 0.3;
/** Seconds in the air before coming down is a landing. */
export const LAND_MIN_AIR_S = 0.2;
/** A player crouched this far (`duck`, 0..255) or further does not step. */
const DUCKED = 128;

export interface Footfall {
  tick: number;
  kind: 'step' | 'land';
  /** Source units: the player's origin at the sample. */
  x: number;
  y: number;
  z: number;
}

const state = newPlayerState();

/**
 * The player's steps and landings over the round, in tick order. A step falls on the first
 * sample that is alive, on the ground, not walking, crouched less than half and at
 * `STEP_SPEED` or more (`PlayerState.speed`), then every `STEP_S` while that holds; any sample
 * that breaks it starts the beat again. A landing is the first grounded sample after
 * `LAND_MIN_AIR_S` or more airborne (a death in the air is none).
 */
export function footfalls(
  track: PlayerTrack,
  info: RoundInfo,
  header: MatchHeader
): Footfall[] {
  const out: Footfall[] = [];
  const beat = STEP_S * header.tick_rate;
  const minAir = LAND_MIN_AIR_S * header.tick_rate;
  /** The tick of the next step while running, or null while not. */
  let next: number | null = null;
  /** The tick the player left the ground, or null on it. */
  let airFrom: number | null = null;
  const fall = (k: number, tick: number, kind: Footfall['kind']) =>
    out.push({ tick, kind, x: track.x[k], y: track.y[k], z: track.z[k] });
  for (let k = 0; k < info.samples; k++) {
    const tick = info.start_tick + k * header.tick_step;
    const flags = track.flags[k];
    if (!(flags & FLAG.alive)) {
      next = null;
      airFrom = null;
      continue;
    }
    if (flags & FLAG.airborne) {
      next = null;
      airFrom ??= tick;
      continue;
    }
    if (airFrom !== null) {
      if (tick - airFrom >= minAir) fall(k, tick, 'land');
      airFrom = null;
    }
    const running =
      !(flags & FLAG.walking) &&
      track.duck[k] < DUCKED &&
      playerStateAt(track, info, tick, header, state).speed >= STEP_SPEED;
    if (!running) {
      next = null;
      continue;
    }
    next ??= tick;
    if (tick >= next) {
      fall(k, tick, 'step');
      next += beat;
    }
  }
  return out;
}
