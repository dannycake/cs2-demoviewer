// @vitest-environment jsdom
// DemoView's hooks (views/viewer-hooks), which run whether or not the 3D view is up: the clock
// loop moves play and the scrubber and draws the scene it is handed, the sound starts at the
// first gesture, a phone or a mobile GPU starts at `low`, and the debug handle reaches the store
// from the start and the scene once there is one.

import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SoundDirector } from '../src/audio/director';
import type { FrameScheduler } from '../src/state/clock';
import { playbackStore } from '../src/state/store';
import {
  useClockLoop,
  useDebugHandle,
  useDeviceQuality,
  useSound,
  useViewScene,
} from '../src/views/viewer-hooks';
import { FakeAudioContext } from './helpers/fake-audio';
import { fakeFrames } from './helpers/fake-frames';
import { asScene, FakeScene } from './helpers/fake-scene';
import { playbackPack } from './helpers/playback-pack';

// One round, 100..2000 at 64 ticks/s.
function openPack() {
  playbackStore
    .getState()
    .setPack(
      playbackPack({ rounds: [{ start: 100, end: 2000 }], tick_rate: 64 })
    );
}

const scene = () => new FakeScene(document.createElement('canvas'), 'medium');

/** A director that only records what the loop tells it. */
function fakeDirector() {
  return {
    frame: vi.fn(),
    onAdvance: vi.fn(),
    debug: { unlocked: false },
  };
}

beforeEach(() => {
  FakeScene.reset();
});

afterEach(() => {
  cleanup();
  playbackStore.getState().setPack(null);
  playbackStore.setState({ quality: 'medium', qualityFrom: 'default' });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useClockLoop', () => {
  function loop(frames: FrameScheduler) {
    const director = fakeDirector();
    const ref = { current: director as unknown as SoundDirector };
    const hook = renderHook(() => {
      const view = useViewScene();
      useClockLoop(view, ref, frames);
      return view;
    });
    return { director, view: () => hook.result.current, unmount: hook.unmount };
  }

  it('draws the scene once at start and once per seek while paused, as the scrubber moves', () => {
    openPack();
    playbackStore.getState().seekTick(500);
    const frames = fakeFrames();
    const { view, director } = loop(frames.sched);
    const s = scene();
    act(() => view().onScene(asScene(s)));
    frames.step(16);
    frames.step(16);
    expect(s.log).toEqual([
      'made at medium',
      'hidden false',
      'camera pov 0 false',
      'frame 0:500',
      'render',
    ]);
    act(() => playbackStore.getState().seekTick(800));
    act(() => playbackStore.getState().seekTick(900));
    frames.step(16);
    expect(s.render).toHaveBeenCalledTimes(2);
    expect(s.setFrame).toHaveBeenLastCalledWith(
      0,
      900,
      playbackStore.getState().pack
    );
    // The sound follows each frame drawn.
    expect(director.frame).toHaveBeenCalledTimes(2);
    expect(frames.pending).toBe(0);
  });

  it('advances the clock every frame while playing, without a scene, and the sound hears each advance', () => {
    openPack();
    playbackStore.getState().seekTick(500);
    const frames = fakeFrames();
    const { director } = loop(frames.sched);
    act(() => playbackStore.getState().play());
    frames.step(16); // the first playing frame: no time passed yet
    frames.step(250); // 0.25 s × 64 = 16 ticks
    frames.step(250);
    expect(playbackStore.getState().tick).toBe(532);
    expect(director.onAdvance.mock.calls).toEqual([
      [{ round: 0, tick: 500 }, { round: 0, tick: 516 }, 1],
      [{ round: 0, tick: 516 }, { round: 0, tick: 532 }, 1],
    ]);
    expect(director.frame).toHaveBeenCalledTimes(3);
    act(() => playbackStore.getState().pause());
    frames.step(16);
    frames.step(16);
    expect(playbackStore.getState().tick).toBe(532);
  });

  it('draws a new scene at once while paused, and never one let go', () => {
    openPack();
    const frames = fakeFrames();
    const { view } = loop(frames.sched);
    frames.step(16);
    const s = scene();
    act(() => view().onScene(asScene(s)));
    frames.step(16);
    expect(s.render).toHaveBeenCalledTimes(1);
    // Viewport lets go of its scene; a frame that comes before DemoView renders again does not
    // draw it.
    act(() => {
      playbackStore.getState().seekTick(700);
      view().onScene(null);
      frames.step(16);
    });
    frames.step(16);
    expect(s.render).toHaveBeenCalledTimes(1);
  });

  it('draws nothing under the full radar', () => {
    openPack();
    const frames = fakeFrames();
    const { view } = loop(frames.sched);
    const s = scene();
    act(() => view().onScene(asScene(s)));
    act(() => playbackStore.getState().setRadar(true));
    frames.step(16);
    expect(s.setHidden).toHaveBeenLastCalledWith(true);
    expect(s.render).not.toHaveBeenCalled();
  });

  it('stops with the demo', () => {
    openPack();
    const frames = fakeFrames();
    const { unmount } = loop(frames.sched);
    unmount();
    expect(frames.pending).toBe(0);
    playbackStore.getState().play();
    expect(frames.pending).toBe(0);
  });
});

describe('useSound', () => {
  /** The audio contexts made, in order. */
  let made: FakeAudioContext[];

  beforeEach(() => {
    made = [];
    vi.stubGlobal(
      'AudioContext',
      class extends FakeAudioContext {
        constructor(o?: AudioContextOptions) {
          super(o);
          made.push(this);
        }
      }
    );
    // The manifest and the banks, once unlocked: never answered here.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {}))
    );
  });

  function sound() {
    return renderHook(() => useSound(useViewScene()));
  }

  it('makes the audio context at the first gesture anywhere on the page, not before', () => {
    const { result } = sound();
    expect(made).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'a' });
    expect(made).toHaveLength(1);
    expect(made[0].sampleRate).toBe(48000);
    expect(result.current.current?.debug.unlocked).toBe(true);
    // A later gesture has nothing to make.
    fireEvent.pointerDown(document.body);
    expect(made).toHaveLength(1);
  });

  it('makes it at 24 kHz on the low preset of the moment', () => {
    sound();
    playbackStore.setState({ quality: 'low', qualityFrom: 'device' });
    fireEvent.pointerDown(document.body);
    expect(made[0].sampleRate).toBe(24000);
  });

  it('closes it with the demo, and no gesture after makes another', () => {
    const { unmount } = sound();
    fireEvent.click(document.body);
    unmount();
    expect(made[0].closed).toBe(true);
    fireEvent.click(document.body);
    expect(made).toHaveLength(1);
  });
});

describe('useDeviceQuality', () => {
  it('starts a phone or a mobile GPU at low, set for the device', () => {
    renderHook(() => useDeviceQuality(() => true));
    expect(playbackStore.getState()).toMatchObject({
      quality: 'low',
      qualityFrom: 'device',
    });
  });

  it('leaves anything else to be measured', () => {
    renderHook(() => useDeviceQuality(() => false));
    expect(playbackStore.getState()).toMatchObject({
      quality: 'medium',
      qualityFrom: 'default',
    });
  });

  it('does not ask once the viewer chose a preset', () => {
    playbackStore.setState({ quality: 'high', qualityFrom: 'chosen' });
    const ask = vi.fn(() => true);
    renderHook(() => useDeviceQuality(ask));
    expect(ask).not.toHaveBeenCalled();
    expect(playbackStore.getState().quality).toBe('high');
  });
});

describe('useDebugHandle', () => {
  function handle() {
    const director = { current: fakeDirector() as unknown as SoundDirector };
    const hook = renderHook(() => {
      const view = useViewScene();
      useDebugHandle(view, director);
      return view;
    });
    return { view: () => hook.result.current, director, ...hook };
  }

  it('holds the store and the sound from the start, and reaches the scene once there is one', () => {
    const { view, director } = handle();
    const d = window.__demoviewer!;
    expect(d.store).toBe(playbackStore);
    expect(d.sound).toBe(director.current!.debug);
    expect(d.stats.frames).toBe(0);
    expect(() => d.camera()).toThrow(/no scene/);
    const s = scene();
    act(() => view().onScene(asScene(s)));
    expect(window.__demoviewer).toBe(d);
    expect(d.stats).toBe(s.stats);
    expect(d.camera()).toEqual(s.cameraDebug.mock.results[0].value);
    act(() => view().onScene(null));
    expect(d.stats.frames).toBe(0);
  });

  it('goes with the demo', () => {
    const { unmount } = handle();
    expect(window.__demoviewer).toBeDefined();
    unmount();
    expect(window.__demoviewer).toBeUndefined();
  });
});
