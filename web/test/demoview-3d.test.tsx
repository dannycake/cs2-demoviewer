// @vitest-environment jsdom
// When DemoView loads the 3D view, a chunk of its own (three.js and the scene with it): as the
// demo opens on a desktop, or a phone whose link names a camera; on a phone opening on the
// radar, only when the 3D view is first shown. Until the chunk is in, a note says it is on its
// way; once in, the view mounts at once; a chunk that will not load ends on the 3D view's note.
// The Viewport module is stubbed, and DemoView's requests for it counted; DemoView runs on a
// synthetic pack with its server calls stubbed, as in panel-boundaries.test.tsx. DemoView keeps
// the chunk for the page, so each test imports it afresh (`vi.resetModules`), with the store it
// reads: no test depends on another having run before it.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RELOAD_KEY } from '../src/chunk';
import type { playbackStore as Store } from '../src/state/store';
import type DemoViewComponent from '../src/views/DemoView';
import { trackPack } from './helpers/track-pack';

/** How often DemoView asked for the 3D view's chunk, and the pack `loadPack` hands over. */
const shared = vi.hoisted(() => ({
  viewportLoads: 0,
  pack: null as unknown,
  /** Holds `loadPack` until called, when set. */
  hold: null as Promise<void> | null,
  /** Holds the 3D view's chunk on its way until called, when set. */
  chunk: null as Promise<void> | null,
  /** The 3D view's chunk does not load, as one the server no longer has. */
  chunkFails: false,
}));

// The chunk as DemoView asks for it (`importOrReload`, the only call in its graph): counted,
// held or failed as the test says, then the real reload rule and the stub below.
vi.mock('../src/chunk', async (importOriginal) => {
  const chunk = await importOriginal<typeof import('../src/chunk')>();
  return {
    ...chunk,
    importOrReload: <T,>(load: () => Promise<T>) => {
      shared.viewportLoads++;
      return chunk.importOrReload(async () => {
        if (shared.chunk) await shared.chunk;
        if (shared.chunkFails)
          throw new TypeError('Failed to fetch dynamically imported module');
        return load();
      });
    },
  };
});

vi.mock('../src/components/Viewport', () => ({
  default: function Viewport() {
    return <div data-testid="viewport" />;
  },
}));

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
  loadPack: async () => {
    if (shared.hold) await shared.hold;
    return shared.pack;
  },
}));

vi.mock('../src/components/Radar', () => ({
  default: function Radar({ mode }: { mode: string }) {
    return <div data-testid={`radar-${mode}`} />;
  },
}));

let DemoView: typeof DemoViewComponent;
let playbackStore: typeof Store;

/** A phone's screen and finger (`state/device`), or with `false` a desktop's mouse. */
function device(phone: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (q: string) => ({
      matches: phone && q === '(pointer: coarse)',
      media: q,
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  Object.defineProperty(window.screen, 'width', {
    configurable: true,
    get: () => (phone ? 412 : 2560),
  });
  Object.defineProperty(window.screen, 'height', {
    configurable: true,
    get: () => (phone ? 915 : 1440),
  });
}

async function open(url: string) {
  window.history.replaceState(null, '', url);
  render(<DemoView demoId="demo1" />);
  await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
}

/** The 3D view's note while its chunk is on its way. */
const loadingNote = () => screen.queryByText('loading the 3D view…');

beforeEach(async () => {
  vi.resetModules();
  ({ default: DemoView } = await import('../src/views/DemoView'));
  ({ playbackStore } = await import('../src/state/store'));
  shared.viewportLoads = 0;
  shared.pack = trackPack({
    samples: 300,
    teams: [2, 3],
    players: [() => ({}), () => ({})],
  });
  shared.hold = null;
  shared.chunk = null;
  shared.chunkFails = false;
  // jsdom has no WebGL nor a 2D canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (window as { matchMedia?: unknown }).matchMedia;
  delete (window.screen as { width?: unknown }).width;
  delete (window.screen as { height?: unknown }).height;
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('DemoView and the 3D view', () => {
  it('on a phone opening on the radar, loads the 3D view only when it is first shown', async () => {
    device(true);
    await open('/d/demo1?debug=1');
    expect(playbackStore.getState()).toMatchObject({
      radar: true,
      quality: 'low',
    });
    // Time for an import already asked for to land.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(shared.viewportLoads).toBe(0);
    expect(screen.queryByTestId('viewport')).toBeNull();
    expect(loadingNote()).toBeNull();
    // The debug corner says the device set the preset, with no 3D view.
    expect(screen.getByTestId('hud-quality').textContent).toBe('low (device)');

    act(() => playbackStore.getState().setCamera('pov'));
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expect(shared.viewportLoads).toBe(1);
    // Once shown it stays, under the radar too.
    act(() => playbackStore.getState().setRadar(true));
    expect(screen.getByTestId('viewport')).toBeTruthy();
  });

  it('says the 3D view is on its way from the tap until its chunk is in', async () => {
    device(true);
    let arrive!: () => void;
    shared.chunk = new Promise((r) => (arrive = r));
    await open('/d/demo1');

    act(() => playbackStore.getState().setCamera('pov'));
    // In the tap's own render, before anything of the chunk is in.
    expect(loadingNote()?.getAttribute('role')).toBe('status');
    await waitFor(() => expect(shared.viewportLoads).toBe(1));
    expect(screen.queryByTestId('viewport')).toBeNull();
    expect(loadingNote()).toBeTruthy();

    arrive();
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expect(loadingNote()).toBeNull();
  });

  it('mounts the 3D view as soon as its chunk is in, without the 300 ms React holds a lazy reveal to', async () => {
    device(true);
    // In the HTTP cache already, as on any visit after the first.
    await import('../src/components/Viewport');
    await open('/d/demo1');

    const tapped = performance.now();
    act(() => playbackStore.getState().setCamera('pov'));
    await screen.findByTestId('viewport');
    // React.lazy under Suspense showed it 300 ms after its fallback (the tap), however soon
    // the module came.
    expect(performance.now() - tapped).toBeLessThan(250);
  });

  it('on a desktop, mounts the 3D view as the demo opens, before the pack is in', async () => {
    device(false);
    let release!: () => void;
    shared.hold = new Promise((r) => (release = r));
    window.history.replaceState(null, '', '/d/demo1');
    render(<DemoView demoId="demo1" />);
    expect(loadingNote()).toBeTruthy();
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expect(playbackStore.getState().pack).toBeNull();
    release();
    await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
    expect(playbackStore.getState().radar).toBe(false);
  });

  it('on a phone whose link names a camera, or without the HUD, opens in the 3D view', async () => {
    device(true);
    await open('/d/demo1?cam=pov');
    expect(playbackStore.getState().radar).toBe(false);
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    cleanup();
    await open('/d/demo1?hud=0');
    expect(playbackStore.getState().radar).toBe(false);
    expect(await screen.findByTestId('viewport')).toBeTruthy();
  });

  it('ends a chunk that will not load on the 3D view’s note, which says to reload the page', async () => {
    device(false);
    // The page was reloaded for it less than a minute ago (`importOrReload`): the failure stands.
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    shared.chunkFails = true;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await open('/d/demo1');

    const note = await screen.findByTestId('panel-error');
    expect(note.textContent).toBe(
      'the 3D view stopped working · reload the page'
    );
    expect(
      screen.getByRole('link', { name: 'reload the page' }).getAttribute('href')
    ).toBe(window.location.href);
    expect(loadingNote()).toBeNull();
    expect(screen.getByTestId('transport')).toBeTruthy();
    expect(errors.mock.calls.map((c) => String(c[0]))).toContain(
      'demoviewer: render error in the 3D view'
    );
  });
});
