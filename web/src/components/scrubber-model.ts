// Pure helpers of the transport bar and scrubber, kept out of the component files so they
// can be unit tested without React (and so those files export only components).

import type { RoundInfo } from '../pack/types';

export interface ScrubberModel {
  /** The round's `start_tick`. */
  min: number;
  /** The round's `post_end_tick` (the end of its after-round), at least `min`. */
  max: number;
  /** The round's `end_tick` (decided), clamped into `[min, max]`. */
  end: number;
  /** The round's `freeze_end_tick`, clamped into `[min, max]`. */
  freezeEnd: number;
  /** The range input's step: one sample. */
  step: number;
}

/** The scrubber across one round and its after-round, with the freeze end and the round's end marked. */
export function scrubberModel(
  round: RoundInfo,
  tickStep: number
): ScrubberModel {
  const min = round.start_tick;
  const max = Math.max(min, round.post_end_tick);
  return {
    min,
    max,
    freezeEnd: Math.min(Math.max(round.freeze_end_tick, min), max),
    end: Math.min(Math.max(round.end_tick, min), max),
    step: tickStep > 0 ? tickStep : 1,
  };
}

/** Where `tick` sits along the scrubber, 0..1 (0 for a round with no length). */
export function fractionOf(m: ScrubberModel, tick: number): number {
  const span = m.max - m.min;
  if (!(span > 0)) return 0;
  return Math.min(1, Math.max(0, (tick - m.min) / span));
}

/**
 * The tick the scrubber's range input shows for `tick`: the nearest step from `min` (a tie
 * goes up), within the steps from `min` to `max`, as the browser rounds an input's value.
 */
export function stepTick(m: ScrubberModel, tick: number): number {
  const last = Math.floor((m.max - m.min) / m.step);
  const k = Math.min(Math.max(Math.round((tick - m.min) / m.step), 0), last);
  return m.min + k * m.step;
}

/**
 * Time in the round as `m:ss` from the freeze end; the freeze time before it counts down
 * as `-m:ss` (whole seconds, rounded away from the freeze end).
 */
export function roundClock(
  round: RoundInfo,
  tick: number,
  tickRate: number
): string {
  const s = (tick - round.freeze_end_tick) / (tickRate > 0 ? tickRate : 64);
  const whole = s < 0 ? Math.ceil(-s) : Math.floor(s);
  const text = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  return s < 0 && whole > 0 ? `-${text}` : text;
}

/**
 * "Round 7 · T 4 : 3 CT": the round's number and the score going into it, so the title does
 * not give the round's result away. It is the round's own score after it, less the winner's
 * point: the pack's scores are by side, so the round before (`rounds[r - 1]`) has them on the
 * other sides after a halftime or overtime switch. Empty when there is no round `r`.
 */
export function roundTitle(rounds: readonly RoundInfo[], r: number): string {
  const info = rounds[r];
  if (!info) return '';
  const t = Math.max(0, info.score_t - (info.winner === 2 ? 1 : 0));
  const ct = Math.max(0, info.score_ct - (info.winner === 3 ? 1 : 0));
  return `Round ${info.number} · T ${t} : ${ct} CT`;
}
