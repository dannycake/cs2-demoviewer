// @vitest-environment jsdom
// DemoView with the real Viewport, its Scene a stand-in (helpers/fake-scene): a mobile GPU's
// `low` is decided before the scene is made and before the world loads, so the phone tier is
// the only one asked for, on the page's first demo and on any after it; and the scene goes with
// the demo. Server calls stubbed as in panel-boundaries.test.tsx. DemoView keeps the 3D view's
// chunk for the page: only the file's first test loads it, and the order holds either way.

import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playbackStore } from '../src/state/store';
import DemoView from '../src/views/DemoView';
import { FakeScene } from './helpers/fake-scene';
import { trackPack } from './helpers/track-pack';

vi.mock('../src/scene/Scene', async (importOriginal) =>
  (await import('./helpers/fake-scene')).sceneModule(importOriginal)
);

vi.mock('../src/api/demos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/demos')>()),
  pollDemo: async () => ({
    id: 'demo1',
    status: 'done',
    map: 'de_mirage',
    rounds: 1,
    error: null,
    summary: null,
  }),
}));

vi.mock('../src/api/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/assets')>()),
  mapManifest: async () => ({ files: {} }),
}));

vi.mock('../src/pack/client', () => ({
  loadPack: async () =>
    trackPack({
      samples: 300,
      teams: [2, 3],
      players: [() => ({}), () => ({})],
    }),
}));

vi.mock('../src/components/Radar', () => ({
  default: function Radar({ mode }: { mode: string }) {
    return <div data-testid={`radar-${mode}`} />;
  },
}));

const UNMASKED_RENDERER_WEBGL = 0x9246;

/** WebGL 2 contexts naming `gpu`, for `isMobileDevice`; the ones made, and whether let go. */
function gpu(name: string) {
  const contexts: { lost: boolean }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((
    kind: string
  ) => {
    if (kind !== 'webgl2') return null;
    const made = { lost: false };
    contexts.push(made);
    return {
      getExtension: (ext: string) =>
        ext === 'WEBGL_debug_renderer_info'
          ? { UNMASKED_RENDERER_WEBGL }
          : ext === 'WEBGL_lose_context'
            ? { loseContext: () => (made.lost = true) }
            : null,
      getParameter: (p: number) =>
        p === UNMASKED_RENDERER_WEBGL ? name : 'WebKit WebGL',
    };
  }) as unknown as HTMLCanvasElement['getContext']);
  return contexts;
}

/**
 * What `s` was made at and asked to load, and any change of preset, in order: the clock loop's
 * draws, which may come before the pack is in, aside.
 */
const loads = (s: FakeScene) =>
  s.log.filter((l) => /^(made|quality|rigs|map) /.test(l));

/** Opens the demo; the scene its 3D view makes, the `n`th of the test's. */
async function open(n = 0) {
  window.history.replaceState(null, '', '/d/demo1');
  const r = render(<DemoView demoId="demo1" />);
  // The 3D view's chunk (the real Viewport, and three.js through scene/Scene) loads first.
  await waitFor(() => expect(FakeScene.made).toHaveLength(n + 1), {
    timeout: 10_000,
  });
  const s = FakeScene.made[n];
  await waitFor(() => expect(s.maps).toHaveLength(1));
  return { s, ...r };
}

beforeEach(() => {
  FakeScene.reset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  playbackStore.setState({ quality: 'medium', qualityFrom: 'default' });
  window.history.replaceState(null, '', '/');
});

describe('DemoView with the 3D view', () => {
  it("starts a mobile GPU at low before the scene is made, so the world's first load is low's", async () => {
    const contexts = gpu('Adreno (TM) X1-85');
    const { s } = await open();
    expect(playbackStore.getState()).toMatchObject({
      quality: 'low',
      qualityFrom: 'device',
    });
    // Made at low, never switched, and the world asked for once, at low.
    expect(loads(s)).toEqual([
      'made at low',
      'rigs at low',
      'map de_mirage at low',
    ]);
    // The question's own context, let go.
    expect(contexts).toEqual([{ lost: true }]);
  });

  it('leaves a desktop GPU at medium, to be measured', async () => {
    gpu('ANGLE (NVIDIA GeForce RTX 4070)');
    const { s } = await open();
    expect(loads(s)).toEqual([
      'made at medium',
      'rigs at medium',
      'map de_mirage at medium',
    ]);
  });

  it("asks the device first on the tab's next demo too, with the 3D view's chunk already in", async () => {
    gpu('ANGLE (NVIDIA GeForce RTX 4070)');
    const first = await open();
    first.unmount();
    // Nothing measured on the first demo; the next is opened on a phone's GPU.
    playbackStore.setState({ quality: 'medium', qualityFrom: 'default' });
    vi.restoreAllMocks();
    const contexts = gpu('Adreno (TM) X1-85');
    const { s } = await open(1);
    expect(loads(s)).toEqual([
      'made at low',
      'rigs at low',
      'map de_mirage at low',
    ]);
    expect(contexts).toEqual([{ lost: true }]);
  });

  it('disposes of the scene, and takes the debug handle away, when the demo closes', async () => {
    gpu('ANGLE (NVIDIA GeForce RTX 4070)');
    const { s, unmount } = await open();
    expect(window.__demoviewer?.stats).toBe(s.stats);
    unmount();
    expect(s.disposed).toBe(true);
    expect(window.__demoviewer).toBeUndefined();
  });
});
