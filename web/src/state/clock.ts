// The playback clock: a pure `advance` step, and the frame loop that runs it while playing
// and draws on demand while paused.

import type { PlaybackState, PlaybackStore } from './store';

/** A frame longer than this (a hidden tab coming back, a long stall) advances only this much. */
export const MAX_FRAME_S = 0.25;

/**
 * The clock after `dtSeconds` of wall time: `tick += dt * tick_rate * speed`. Crossing
 * the round's `post_end_tick` (the end of its after-round) carries the overshoot into the next
 * round from its `start_tick` (across several rounds if need be); past the last round's
 * `post_end_tick` it stops there with `playing: false`.
 * Returns only what changed: {} while paused, without a pack, or for `dtSeconds <= 0`.
 */
export function advance(
  state: Pick<PlaybackState, 'pack' | 'round' | 'tick' | 'playing' | 'speed'>,
  dtSeconds: number
): Partial<PlaybackState> {
  const header = state.pack?.header;
  if (!state.playing || !header || !(dtSeconds > 0)) return {};
  const rounds = header.rounds;
  let round = state.round;
  if (!rounds[round]) return {};
  let tick = state.tick + dtSeconds * header.tick_rate * state.speed;
  while (tick > rounds[round].post_end_tick) {
    if (round === rounds.length - 1) {
      const end = rounds[round].post_end_tick;
      return round === state.round
        ? { tick: end, playing: false }
        : { round, tick: end, playing: false };
    }
    const over = tick - rounds[round].post_end_tick;
    round++;
    tick = rounds[round].start_tick + over;
  }
  return round === state.round ? { tick } : { round, tick };
}

/** Where the clock is: a round (index into `header.rounds`) and a tick in it. */
export interface ClockPosition {
  round: number;
  tick: number;
}

/** `requestAnimationFrame` and `cancelAnimationFrame`, replaceable in tests. */
export interface FrameScheduler {
  request(cb: (timeMs: number) => void): number;
  cancel(id: number): void;
}

/** `requestAnimationFrame`, for anything that draws once per frame. */
export const browserFrames: FrameScheduler = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (id) => cancelAnimationFrame(id),
};

/**
 * Runs the clock: one animation frame per frame while playing (advance, then `onFrame`),
 * and while paused one frame after any batch of store changes (render on demand), plus one
 * at start. `onFrame` reads the store itself. `onAdvance` hears each frame's advance that moved
 * the clock, from where the store was to where the advance put it at the speed it played,
 * after the store's update and before `onFrame`; a seek is never one (the next advance runs
 * from where it landed). Returns a function that stops the loop.
 */
export function startLoop(
  store: PlaybackStore,
  onFrame: () => void,
  frames: FrameScheduler = browserFrames,
  onAdvance?: (from: ClockPosition, to: ClockPosition, speed: number) => void
): () => void {
  let handle: number | null = null;
  /** Time of the previous playing frame; null when the last frame was paused. */
  let last: number | null = null;
  /** True while the loop writes its own advance, which needs no extra frame. */
  let advancing = false;
  let stopped = false;

  const schedule = () => {
    if (handle === null && !stopped) handle = frames.request(frame);
  };

  function frame(timeMs: number) {
    handle = null;
    if (stopped) return;
    try {
      const s = store.getState();
      if (s.playing) {
        const dt =
          last === null
            ? 0
            : Math.min(MAX_FRAME_S, Math.max(0, (timeMs - last) / 1000));
        last = timeMs;
        const patch = advance(s, dt);
        if (Object.keys(patch).length > 0) {
          advancing = true;
          try {
            store.setState(patch);
          } finally {
            advancing = false;
          }
        }
        const to = {
          round: patch.round ?? s.round,
          tick: patch.tick ?? s.tick,
        };
        if (onAdvance && (to.round !== s.round || to.tick !== s.tick)) {
          // What hears the clock (the sound) never keeps the frame from drawing.
          try {
            onAdvance({ round: s.round, tick: s.tick }, to, s.speed);
          } catch (e) {
            console.error(e);
          }
        }
      } else {
        last = null;
      }
      // Ask for the next frame before drawing: a draw that requests a frame of its own (Scene
      // does while the fly camera moves) then queues behind this one, and the next frame's
      // draw cancels it instead of the frame drawing twice.
      if (store.getState().playing) schedule();
      onFrame();
    } finally {
      // Keeps playing through a frame whose advance or drawing threw (a no-op otherwise).
      if (store.getState().playing) schedule();
      else last = null;
    }
  }

  const unsubscribe = store.subscribe(() => {
    if (!advancing) schedule();
  });
  schedule();

  return () => {
    stopped = true;
    unsubscribe();
    if (handle !== null) frames.cancel(handle);
    handle = null;
  };
}
