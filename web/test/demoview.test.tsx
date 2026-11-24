// @vitest-environment jsdom
// DemoView's own orchestration: the load (the server's status, then the pack with its progress,
// then the link's moment, then the map's manifest) and what it puts over the viewer while it
// cannot be watched (a demo the server could not parse, a pack that did not load, a map without
// assets, a demo without rounds), each case's panel winning as it should. The 3D view and the
// radar are stubbed and the server calls answered by the test, as in panel-boundaries.test.tsx.

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DemoStatus } from '../src/api/demos';
import type { Pack } from '../src/pack/types';
import { playbackStore } from '../src/state/store';
import DemoView from '../src/views/DemoView';
import { mapNotice, noRoundsNotice } from '../src/views/notices';
import { dropPre, preShown, putPre } from './helpers/pre';
import { trackPack, withSecondRound } from './helpers/track-pack';

/** What the stubbed server calls answer; each test sets its own. */
const server = vi.hoisted(() => ({
  /** The statuses `pollDemo` reports in turn, the last one returned. */
  statuses: [] as unknown[],
  /** Holds `pollDemo` before its last status, when set. */
  holdStatus: null as Promise<void> | null,
  /** The pack `loadPack` answers per demo, or the error it fails with. */
  packs: new Map<string, unknown>(),
  /** Holds `loadPack` per demo, when set. */
  holdPack: new Map<string, Promise<void>>(),
  /** The bytes `loadPack` reports before answering: [loaded, total]. */
  progress: null as [number, number | null] | null,
  /** What `mapManifest` answers: a manifest, or null for a 404. */
  manifest: { files: {} } as unknown,
}));

vi.mock('../src/api/demos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/demos')>()),
  pollDemo: async (_id: string, onStatus: (s: unknown) => void) => {
    const all = server.statuses;
    for (const s of all.slice(0, -1)) onStatus(s);
    if (server.holdStatus) await server.holdStatus;
    const last = all[all.length - 1];
    onStatus(last);
    return last;
  },
}));

vi.mock('../src/pack/client', () => ({
  loadPack: async (
    demoId: string,
    onProgress: (loaded: number, total: number | null) => void
  ) => {
    if (server.progress) onProgress(...server.progress);
    const hold = server.holdPack.get(demoId);
    if (hold) await hold;
    const p = server.packs.get(demoId);
    if (p instanceof Error) throw p;
    return p;
  },
}));

vi.mock('../src/api/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/assets')>()),
  mapManifest: async () => server.manifest,
}));

vi.mock('../src/components/Viewport', () => ({
  default: function Viewport() {
    return <div data-testid="viewport" />;
  },
}));

vi.mock('../src/components/Radar', () => ({
  default: function Radar({ mode }: { mode: string }) {
    return <div data-testid={`radar-${mode}`} />;
  },
}));

function status(s: DemoStatus['status'], more: Partial<DemoStatus> = {}) {
  return {
    id: 'demo1',
    status: s,
    map: 'de_mirage',
    rounds: 2,
    error: null,
    summary: null,
    ...more,
  };
}

/** Two rounds of two players. */
function pack(): Pack {
  return withSecondRound(
    trackPack({
      samples: 600,
      teams: [2, 3],
      players: [() => ({}), () => ({})],
    })
  );
}

/** A panel's title and text, as the viewer shows it. */
const panel = (role: 'alert' | 'status') =>
  screen
    .getAllByRole(role)
    .map((p) => p.textContent)
    .join(' | ');

beforeEach(() => {
  server.statuses = [status('done')];
  server.holdStatus = null;
  server.packs = new Map([['demo1', pack()]]);
  server.holdPack = new Map();
  server.progress = null;
  server.manifest = { files: {} };
  // jsdom has no WebGL nor a 2D canvas.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  window.history.replaceState(null, '', '/d/demo1');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  playbackStore.setState({ quality: 'medium', qualityFrom: 'default' });
  window.history.replaceState(null, '', '/');
  dropPre();
});

describe('DemoView', () => {
  it('says what the server is doing, then how much of the pack is in, then shows the match', async () => {
    let release!: () => void;
    server.holdStatus = new Promise((r) => (release = r));
    server.statuses = [status('queued'), status('parsing'), status('done')];
    let packIn!: () => void;
    server.holdPack.set('demo1', new Promise((r) => (packIn = r)));
    server.progress = [2 * 1048576, 4 * 1048576];
    render(<DemoView demoId="demo1" />);
    await waitFor(() => expect(panel('status')).toContain('Parsing the demo'));
    expect(panel('status')).toContain('Mirage · 2 rounds');
    // Nothing of the HUD while it loads: no transport, camera bar or player list to press.
    expect(screen.queryByTestId('transport')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Camera' })).toBeNull();
    await act(async () => release());
    await waitFor(() =>
      expect(panel('status')).toContain('Loading the match · 2.0 of 4.0 MB')
    );
    await act(async () => packIn());
    await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
    expect(screen.queryByText(/Loading the match/)).toBeNull();
    expect(playbackStore.getState().status).toBe('ready');
  });

  it('says why a demo the server could not parse cannot be opened, with no HUD under it', async () => {
    server.statuses = [status('error', { error: 'not a CS2 demo' })];
    render(<DemoView demoId="demo1" />);
    await waitFor(() =>
      expect(panel('alert')).toBe(
        "This match couldn't be openedNot a CS2 demo.Upload a demo"
      )
    );
    expect(playbackStore.getState().pack).toBeNull();
    expect(
      screen.getByRole('link', { name: 'Upload a demo' }).getAttribute('href')
    ).toBe('/');
    expect(screen.queryByTestId('transport')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Camera' })).toBeNull();
  });

  it('says why a pack that did not load cannot be opened', async () => {
    server.packs.set('demo1', new Error('the pack is truncated'));
    render(<DemoView demoId="demo1" />);
    await waitFor(() =>
      expect(panel('alert')).toContain('The pack is truncated.')
    );
  });

  it("applies the link's moment once the pack is in", async () => {
    window.history.replaceState(null, '', '/d/demo1?r=2&cam=free');
    render(<DemoView demoId="demo1" />);
    await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
    expect(playbackStore.getState()).toMatchObject({
      round: 1,
      camera: 'free',
    });
  });

  it('puts a notice over a map without assets, which "Watch without the map" puts away', async () => {
    server.manifest = null;
    render(<DemoView demoId="demo1" />);
    const notice = await screen.findByTestId('notice');
    const { title } = mapNotice('de_mirage');
    expect(notice.textContent).toContain(title);
    expect(playbackStore.getState().assetsMissing).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Watch without the map' })
    );
    expect(screen.queryByTestId('notice')).toBeNull();
    // The viewer is under it, whole.
    expect(screen.getByTestId('transport')).toBeTruthy();
  });

  it('shows no download size in the transport bar (there is no HD to choose)', async () => {
    server.manifest = null;
    render(<DemoView demoId="demo1" />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Watch without the map' })
    );
    const transport = screen.getByTestId('transport');
    expect(screen.queryByTestId('traffic')).toBeNull();
    expect(transport.textContent).not.toMatch(/\d\s*(B|kB|KB|MB|GB)\b/);
  });

  it('says a demo without rounds has none, with no way to watch it, over the missing map', async () => {
    const p = pack();
    server.packs.set('demo1', {
      ...p,
      header: { ...p.header, rounds: [] },
      rounds: [],
    });
    server.manifest = null;
    render(<DemoView demoId="demo1" />);
    const notice = await screen.findByTestId('notice');
    expect(notice.textContent).toContain(noRoundsNotice().title);
    expect(
      screen.queryByRole('button', { name: 'Watch without the map' })
    ).toBeNull();
  });

  it("keeps the server's scoreboard in the page behind the viewer once the pack is in, and in sight while it loads", async () => {
    putPre();
    let packIn!: () => void;
    server.holdPack.set('demo1', new Promise((r) => (packIn = r)));
    render(<DemoView demoId="demo1" />);
    await waitFor(() => expect(panel('status')).toContain('Loading the match'));
    expect(preShown()).toBe(true);
    await act(async () => packIn());
    await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
    await waitFor(() =>
      expect('tucked' in document.getElementById('pre')!.dataset).toBe(true)
    );
  });

  it("keeps the server's scoreboard when the pack did not load", async () => {
    putPre();
    server.packs.set('demo1', new Error('the pack is truncated'));
    render(<DemoView demoId="demo1" />);
    await waitFor(() =>
      expect(panel('alert')).toContain('The pack is truncated.')
    );
    expect(preShown()).toBe(true);
  });

  it('leaves the pack of a demo it left alone', async () => {
    let first!: () => void;
    server.holdPack.set('demo1', new Promise((r) => (first = r)));
    const second = pack();
    server.packs.set('demo2', second);
    const { rerender } = render(<DemoView key="demo1" demoId="demo1" />);
    rerender(<DemoView key="demo2" demoId="demo2" />);
    await waitFor(() => expect(playbackStore.getState().pack).toBe(second));
    await act(async () => first());
    expect(playbackStore.getState().pack).toBe(second);
  });
});

describe('the site bar over the viewer', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404 }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says which site this is, with its search and a way home', async () => {
    render(<DemoView demoId="demo1" />);
    const home = await screen.findByRole('link', { name: /skunk\.club/ });
    expect(home.getAttribute('href')).toBe('/');
    expect(home.closest('.site-chrome')).toBeTruthy();
    expect(
      screen.getByRole('textbox', { name: 'A player or a match' })
    ).toBeTruthy();
    // Said once: the HUD's corner keeps the map and the place, not a second wordmark.
    expect(screen.getAllByRole('link', { name: /skunk\.club/ })).toHaveLength(
      1
    );
  });

  it('is not drawn with ?hud=0, the 3D view alone', async () => {
    window.history.replaceState(null, '', '/d/demo1?hud=0');
    render(<DemoView demoId="demo1" />);
    await screen.findByTestId('viewport');
    expect(screen.queryByRole('link', { name: /skunk\.club/ })).toBeNull();
    expect(document.querySelector('.site-chrome')).toBeNull();
  });
});
