// @vitest-environment jsdom
// The 3D view's own orchestration (components/Viewport), with its Scene a stand-in
// (helpers/fake-scene; jsdom has no WebGL): the scene it hands over and lets go, when the world
// and the player models load and when `data-ready` turns true, the banners, the swap on a change
// to `low`, the first second's measure, a link's Free pose, and the taps and fly keys.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Viewport from '../src/components/Viewport';
import { MissingAssetsError } from '../src/scene/Scene';
import type { Scene } from '../src/scene/Scene';
import { playbackStore } from '../src/state/store';
import { FakeScene } from './helpers/fake-scene';
import { playbackPack } from './helpers/playback-pack';

vi.mock('../src/scene/Scene', async (importOriginal) =>
  (await import('./helpers/fake-scene')).sceneModule(importOriginal)
);

function openPack() {
  playbackStore
    .getState()
    .setPack(
      playbackPack({ rounds: [{ start: 100, end: 2000 }], tick_rate: 64 })
    );
}

/** The scene the view made. */
const made = () => {
  expect(FakeScene.made).toHaveLength(1);
  return FakeScene.made[0];
};

const view = () => screen.getByTestId('viewport');
const ready = () => view().getAttribute('data-ready');

function mount(props: { pose?: Parameters<typeof Viewport>[0]['pose'] } = {}) {
  const onScene = vi.fn();
  const r = render(<Viewport onScene={onScene} pose={props.pose ?? null} />);
  return { onScene, ...r };
}

/** Settles the scene's loads made so far (each the latest of its kind). */
async function land(
  s: FakeScene,
  { rigs, map }: { rigs?: unknown; map?: unknown } = {}
) {
  await act(async () => {
    const r = s.rigs.at(-1)!;
    const m = s.maps.at(-1)!;
    if (rigs === undefined) r.resolve();
    else r.reject(rigs);
    if (map === undefined) m.resolve();
    else m.reject(map);
  });
}

beforeEach(() => {
  FakeScene.reset();
  // The quality is chosen unless a test says otherwise, so no measure runs.
  playbackStore.setState({ quality: 'medium', qualityFrom: 'chosen' });
});

afterEach(() => {
  cleanup();
  playbackStore.getState().setPack(null);
  playbackStore.setState({
    quality: 'medium',
    qualityFrom: 'default',
    camera: 'pov',
  });
  vi.restoreAllMocks();
});

describe('Viewport', () => {
  it('hands its scene over, made at the preset, and lets it go before disposing it', () => {
    playbackStore.setState({ quality: 'low', qualityFrom: 'detected' });
    const { onScene, unmount } = mount();
    const s = made();
    expect(s.log[0]).toBe('made at low measured');
    expect(onScene.mock.calls).toEqual([[s]]);
    onScene.mockImplementation((scene: Scene | null) => {
      expect(scene).toBeNull();
      expect(s.disposed).toBe(false);
    });
    unmount();
    expect(onScene).toHaveBeenLastCalledWith(null);
    expect(s.disposed).toBe(true);
  });

  it('makes each scene on a canvas of its own, which goes with it', () => {
    // A scene let go loses its canvas's context for good: StrictMode, as in development, makes
    // the scene twice on one mount.
    const onScene = vi.fn();
    const { unmount } = render(
      <StrictMode>
        <Viewport onScene={onScene} pose={null} />
      </StrictMode>
    );
    expect(FakeScene.made).toHaveLength(2);
    const [first, second] = FakeScene.made;
    expect(first.disposed).toBe(true);
    expect(second.canvas).not.toBe(first.canvas);
    expect(first.canvas.isConnected).toBe(false);
    expect([...view().querySelectorAll('canvas')]).toEqual([second.canvas]);
    expect(onScene).toHaveBeenLastCalledWith(second);
    unmount();
    expect(second.disposed).toBe(true);
    expect(second.canvas.isConnected).toBe(false);
  });

  it('loads the player models and the world with a pack, and is ready once both are in', async () => {
    mount();
    expect(made().log).toEqual(['made at medium']);
    act(() => openPack());
    const s = made();
    expect(s.log).toEqual([
      'made at medium',
      'rigs at medium',
      'map de_mirage at medium',
    ]);
    expect(ready()).toBe('false');
    await act(async () => s.rigs[0].resolve());
    expect(ready()).toBe('false');
    await act(async () => s.maps[0].resolve());
    expect(ready()).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('loads nothing under the radar until the 3D view first shows', async () => {
    openPack();
    playbackStore.getState().setRadar(true);
    mount();
    expect(made().log).toEqual(['made at medium']);
    act(() => playbackStore.getState().setRadar(false));
    expect(made().log).toEqual([
      'made at medium',
      'rigs at medium',
      'map de_mirage at medium',
    ]);
    // Shown once, the radar no longer holds anything back.
    await land(made());
    act(() => playbackStore.getState().setRadar(true));
    expect(ready()).toBe('true');
  });

  it("is ready with the grid and a banner for a map without assets, which a later world's load clears", async () => {
    openPack();
    mount();
    await land(made(), { map: new MissingAssetsError('de_mirage', 404) });
    expect(ready()).toBe('true');
    expect(playbackStore.getState().assetsMissing).toBe(true);
    expect(screen.getByRole('status').textContent).toBe('No 3D map for Mirage');
    // The preset changes the tier: the world loads again, and this time it is there.
    act(() => playbackStore.setState({ quality: 'low' }));
    await act(async () => made().maps[1].resolve());
    expect(playbackStore.getState().assetsMissing).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names a world or the player models that failed, and is ready all the same', async () => {
    openPack();
    mount();
    await land(made(), {
      rigs: new Error('ct.glb: 500'),
      map: new Error('world.glb: 500'),
    });
    expect(ready()).toBe('true');
    expect(screen.getAllByRole('alert').map((a) => a.textContent)).toEqual([
      'the de_mirage world did not load: world.glb: 500',
      'the player models did not load: ct.glb: 500',
    ]);
  });

  it('waits again for the world on a change to low, saying so, and is ready once the swap is in', async () => {
    openPack();
    mount();
    const s = made();
    await land(s);
    act(() => playbackStore.getState().setQuality('low'));
    expect(s.log.slice(3)).toEqual([
      'quality low',
      'rigs at low',
      'map de_mirage at low',
    ]);
    expect(ready()).toBe('false');
    await act(async () => s.rigs[1].resolve());
    expect(screen.getByRole('status').textContent).toBe('loading the world…');
    await act(async () => s.maps[1].resolve());
    expect(ready()).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('measures the first second at medium with nothing chosen, and the store picks the preset from it', async () => {
    playbackStore.setState({ quality: 'medium', qualityFrom: 'default' });
    openPack();
    mount();
    const s = made();
    s.probeAnswer = 150;
    expect(s.log).not.toContain('probe');
    await land(s);
    await waitFor(() =>
      expect(playbackStore.getState()).toMatchObject({
        quality: 'high',
        qualityFrom: 'detected',
      })
    );
    expect(s.log.filter((l) => l === 'probe')).toHaveLength(1);
  });

  it('measures nothing once a preset was chosen or set for the device', async () => {
    playbackStore.setState({ quality: 'low', qualityFrom: 'device' });
    openPack();
    mount();
    await land(made());
    expect(made().log).not.toContain('probe');
  });

  it("places a link's Free pose once the map is in, and only in Free", async () => {
    const pose = { x: 1, y: 2, z: 3, yaw: 90, pitch: 10 };
    openPack();
    playbackStore.getState().setCamera('free');
    mount({ pose });
    const s = made();
    expect(s.setFreePose).not.toHaveBeenCalled();
    await land(s);
    expect(s.setFreePose.mock.calls).toEqual([[pose]]);
  });

  it('shows a banner instead of the 3D view without WebGL 2, and hands over no scene', () => {
    FakeScene.failNext = new Error('Error creating WebGL context.');
    const { onScene } = mount();
    expect(screen.getByRole('alert').textContent).toBe(
      'This browser cannot draw the 3D view (WebGL 2 is unavailable)'
    );
    expect(onScene).not.toHaveBeenCalled();
  });

  it("plays or pauses on a finger's tap on empty space, follows a player tapped, and a mouse click on nothing does nothing", () => {
    openPack();
    mount();
    const s = made();
    const canvas = s.canvas;
    const tap = (pointerType: string) => {
      fireEvent.pointerDown(canvas, {
        button: 0,
        pointerId: 1,
        clientX: 50,
        clientY: 60,
        pointerType,
      });
      fireEvent.pointerUp(canvas, {
        button: 0,
        pointerId: 1,
        clientX: 52,
        clientY: 61,
        pointerType,
      });
    };
    tap('mouse');
    expect(playbackStore.getState().playing).toBe(false);
    tap('touch');
    expect(playbackStore.getState().playing).toBe(true);
    s.pickPlayer.mockReturnValue(3);
    tap('mouse');
    expect(playbackStore.getState()).toMatchObject({
      follow: 3,
      followPinned: true,
    });
  });

  it('flies on W outside text fields, and lets go of every key when the window loses focus', () => {
    mount();
    const s = made();
    fireEvent.keyDown(window, { code: 'KeyW' });
    expect(s.flyKey).toHaveBeenLastCalledWith('KeyW', true);
    const field = document.createElement('input');
    document.body.append(field);
    fireEvent.keyDown(field, { code: 'KeyS' });
    expect(s.flyKey).not.toHaveBeenCalledWith('KeyS', true);
    field.remove();
    fireEvent.blur(window);
    expect(s.clearFlyKeys).toHaveBeenCalled();
  });
});
