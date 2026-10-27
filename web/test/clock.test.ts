import { describe, expect, it } from 'vitest';
import {
  advance,
  MAX_FRAME_S,
  startLoop,
  type ClockPosition,
} from '../src/state/clock';
import { createPlaybackStore } from '../src/state/store';
import { fakeFrames } from './helpers/fake-frames';
import { playbackPack } from './helpers/playback-pack';

// Two rounds, [100..300] and [400..600], at 64 ticks/s.
function twoRounds() {
  const store = createPlaybackStore({ storage: null });
  store.getState().setPack(
    playbackPack({
      rounds: [
        { start: 100, freeze: 150, end: 300 },
        { start: 400, freeze: 450, end: 600 },
      ],
      tick_rate: 64,
    })
  );
  return store;
}

describe('advance', () => {
  it('rolls over into the next round, carrying the overshoot past end_tick', () => {
    const store = twoRounds();
    store.getState().setSpeed(2);
    store.getState().seekTick(290);
    store.getState().play();
    // 0.25 s x 64 ticks/s x 2 = 32 ticks: 10 to reach 300, 22 into the second round.
    expect(advance(store.getState(), 0.25)).toEqual({ round: 1, tick: 422 });
  });

  it('plays the after-round out to post_end_tick before rolling over', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(
      playbackPack({
        rounds: [
          { start: 100, end: 300, post: 350 },
          { start: 400, end: 600 },
        ],
        tick_rate: 64,
      })
    );
    store.getState().seekTick(290);
    store.getState().play();
    // 0.25 s x 64 ticks/s = 16 ticks: past end_tick (300), still in the round's after-round.
    expect(advance(store.getState(), 0.25)).toEqual({ tick: 306 });
    store.getState().seekTick(345);
    expect(advance(store.getState(), 0.25)).toEqual({ round: 1, tick: 411 });
  });

  it('pauses on end_tick at the end of the last round', () => {
    const store = twoRounds();
    store.getState().seekRound(1);
    store.getState().seekTick(600);
    const atEnd = { ...store.getState(), playing: true };
    expect(advance(atEnd, 0.1)).toEqual({ tick: 600, playing: false });
    store.getState().seekTick(590);
    store.getState().play();
    expect(advance(store.getState(), 1)).toEqual({
      tick: 600,
      playing: false,
    });
  });

  it('play at the end of the last round starts again from the first', () => {
    const store = twoRounds();
    store.getState().seekRound(1);
    store.getState().seekTick(600);
    store.getState().play();
    expect(store.getState()).toMatchObject({
      round: 0,
      tick: 150,
      playing: true,
    });
  });

  it('moves by dt x tick_rate x speed inside a round', () => {
    const store = twoRounds();
    store.getState().seekTick(200);
    store.getState().setSpeed(0.5);
    store.getState().play();
    expect(advance(store.getState(), 0.5)).toEqual({ tick: 216 });
  });

  it('crosses several rounds in one large step', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(
      playbackPack({
        rounds: [
          { start: 0, end: 100 },
          { start: 200, end: 210 },
          { start: 300, end: 400 },
        ],
        tick_rate: 100,
      })
    );
    store.getState().seekTick(90);
    store.getState().play();
    // 10 to the first end, 10 through the second, 5 into the third.
    expect(advance(store.getState(), 0.25)).toEqual({ round: 2, tick: 305 });
  });

  it('reports the new round when one step enters the last round and passes its end', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(
      playbackPack({
        rounds: [
          { start: 0, end: 100 },
          { start: 200, end: 210 },
        ],
        tick_rate: 100,
      })
    );
    store.getState().seekTick(90);
    store.getState().play();
    // 10 to the first end, then 15 into a last round that is only 10 long.
    const next = advance(store.getState(), 0.25);
    expect(next).toEqual({ round: 1, tick: 210, playing: false });
    // Applied, the clock sits at the end of the last round, so play restarts from the first.
    store.setState(next);
    store.getState().play();
    expect(store.getState()).toMatchObject({ round: 0, playing: true });
  });

  it('does nothing while paused, without a pack, or for dt <= 0', () => {
    const store = twoRounds();
    expect(advance(store.getState(), 1)).toEqual({});
    store.getState().play();
    expect(advance(store.getState(), 0)).toEqual({});
    expect(advance(store.getState(), -1)).toEqual({});
    const empty = createPlaybackStore({ storage: null });
    expect(advance({ ...empty.getState(), playing: true }, 1)).toEqual({});
  });
});

describe('seekTick', () => {
  it('clamps into the current round', () => {
    const store = twoRounds();
    store.getState().seekTick(50);
    expect(store.getState().tick).toBe(100);
    store.getState().seekTick(1000);
    expect(store.getState().tick).toBe(300);
    store.getState().seekRound(1);
    store.getState().seekTick(50);
    expect(store.getState()).toMatchObject({ round: 1, tick: 400 });
  });
});

describe('startLoop', () => {
  it('draws once at start and once per change while paused, coalesced per frame', () => {
    const store = twoRounds();
    const frames = fakeFrames();
    let drawn = 0;
    const stop = startLoop(store, () => drawn++, frames.sched);
    frames.step(16);
    expect(drawn).toBe(1);
    frames.step(16);
    expect(drawn).toBe(1);
    store.getState().seekTick(200);
    store.getState().setCamera('free');
    frames.step(16);
    expect(drawn).toBe(2);
    expect(frames.pending).toBe(0);
    stop();
  });

  it('advances the clock every frame while playing and stops when paused', () => {
    const store = twoRounds();
    store.getState().seekTick(200);
    const frames = fakeFrames();
    const ticks: number[] = [];
    const stop = startLoop(
      store,
      () => ticks.push(store.getState().tick),
      frames.sched
    );
    store.getState().play();
    frames.step(16); // first playing frame: no elapsed time yet
    frames.step(250); // 0.25 s x 64 = 16 ticks
    frames.step(10_000); // a hidden tab coming back: capped at MAX_FRAME_S
    expect(ticks).toEqual([200, 216, 216 + MAX_FRAME_S * 64]);
    const last = ticks[2];
    store.getState().pause();
    frames.step(16); // one draw for the pause, then idle
    frames.step(16);
    expect(ticks).toEqual([200, 216, last, last]);
    expect(frames.pending).toBe(0);
    stop();
  });

  it('pauses itself at the end of the last round and stops requesting frames', () => {
    const store = twoRounds();
    store.getState().seekRound(1);
    store.getState().seekTick(590);
    const frames = fakeFrames();
    let drawn = 0;
    const stop = startLoop(store, () => drawn++, frames.sched);
    store.getState().play();
    frames.step(16);
    frames.step(1000);
    expect(store.getState()).toMatchObject({ tick: 600, playing: false });
    frames.step(16);
    expect(frames.pending).toBe(0);
    expect(drawn).toBe(2);
    stop();
  });

  it('draws once per frame while playing when the drawing asks for a frame of its own', () => {
    // Like Scene: render() cancels its own pending frame, draws, and while the fly camera is
    // still moving asks for one more frame.
    const store = twoRounds();
    const frames = fakeFrames();
    let own: number | null = null;
    let drawn = 0;
    const render = () => {
      if (own !== null) frames.sched.cancel(own);
      drawn++;
      own = frames.sched.request(() => {
        own = null;
        render();
      });
    };
    const stop = startLoop(store, render, frames.sched);
    store.getState().play();
    for (let i = 0; i < 10; i++) frames.step(16);
    expect(drawn).toBe(10);
    stop();
  });

  it('stops drawing after stop()', () => {
    const store = twoRounds();
    const frames = fakeFrames();
    let drawn = 0;
    const stop = startLoop(store, () => drawn++, frames.sched);
    stop();
    store.getState().play();
    frames.step(16);
    expect(drawn).toBe(0);
    expect(frames.pending).toBe(0);
  });

  it("reports each frame's advance once, after the store update and before the draw", () => {
    const store = createPlaybackStore({ storage: null });
    store
      .getState()
      .setPack(playbackPack({ rounds: [{ start: 500, end: 9000 }] }));
    store.getState().seekTick(1000);
    store.getState().setSpeed(2);
    const frames = fakeFrames();
    const log: string[] = [];
    const calls: [ClockPosition, ClockPosition, number][] = [];
    const stop = startLoop(
      store,
      () => log.push(`draw ${store.getState().tick}`),
      frames.sched,
      (from, to, speed) => {
        calls.push([from, to, speed]);
        log.push(`advance ${store.getState().tick}`);
      }
    );
    store.getState().play();
    frames.step(16); // the first playing frame: no time has passed, nothing moved
    expect(calls).toEqual([]);
    frames.step(100);
    const to = 1000 + 0.1 * 64 * 2;
    expect(calls).toEqual([
      [{ round: 0, tick: 1000 }, { round: 0, tick: to }, 2],
    ]);
    expect(log).toEqual(['draw 1000', `advance ${to}`, `draw ${to}`]);
    stop();
  });

  it('reports an advance across rounds from the old round to the new', () => {
    const store = twoRounds();
    store.getState().seekTick(290);
    const frames = fakeFrames();
    const calls: [ClockPosition, ClockPosition, number][] = [];
    const stop = startLoop(
      store,
      () => {},
      frames.sched,
      (...a) => calls.push(a)
    );
    store.getState().play();
    frames.step(16);
    frames.step(250); // 16 ticks: 10 to 300, 6 into the second round
    expect(calls).toEqual([
      [{ round: 0, tick: 290 }, { round: 1, tick: 406 }, 1],
    ]);
    stop();
  });

  it('never reports a seek, paused or playing', () => {
    const store = createPlaybackStore({ storage: null });
    store
      .getState()
      .setPack(playbackPack({ rounds: [{ start: 500, end: 9000 }] }));
    store.getState().seekTick(1000);
    const frames = fakeFrames();
    const calls: [ClockPosition, ClockPosition, number][] = [];
    const stop = startLoop(
      store,
      () => {},
      frames.sched,
      (...a) => calls.push(a)
    );
    frames.step(16);
    store.getState().seekTick(2000); // paused
    frames.step(16);
    expect(calls).toEqual([]);
    store.getState().play();
    frames.step(16);
    frames.step(125); // 8 ticks
    store.getState().seekTick(5000); // playing
    frames.step(125);
    // Each advance runs from where the store was: the seek itself is never one.
    expect(calls).toEqual([
      [{ round: 0, tick: 2000 }, { round: 0, tick: 2008 }, 1],
      [{ round: 0, tick: 5000 }, { round: 0, tick: 5008 }, 1],
    ]);
    stop();
  });

  it('reports nothing for a frame that does not move the clock', () => {
    const store = twoRounds();
    store.getState().seekRound(1);
    store.getState().seekTick(600);
    const frames = fakeFrames();
    const calls: unknown[] = [];
    const stop = startLoop(
      store,
      () => {},
      frames.sched,
      (...a) => calls.push(a)
    );
    // Playing at the very end of the last round: the clock only stops.
    store.setState({ playing: true });
    frames.step(16);
    frames.step(16);
    expect(store.getState()).toMatchObject({ tick: 600, playing: false });
    expect(calls).toEqual([]);
    stop();
  });
});
