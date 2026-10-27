// @vitest-environment jsdom
// The viewer's error boundaries (components/ErrorBoundary): a panel that throws in render gives
// way to a quiet note, and the rest of the viewer stays and plays on. DemoView runs whole on a
// synthetic pack, with its server calls, the 3D view and the radar stubbed (jsdom has no WebGL
// nor a 2D canvas); every other HUD widget is the real one, and the clock loop and the sound are
// DemoView's own.

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import ErrorBoundary from '../src/components/ErrorBoundary';
import { playbackStore } from '../src/state/store';
import DemoView from '../src/views/DemoView';
import { event, trackPack, withSecondRound } from './helpers/track-pack';

/** The panels that throw in render, by the names below. */
const broken = vi.hoisted(() => new Set<string>());

/** Throws for `name` while it is in `broken`. */
function check(name: string): void {
  if (broken.has(name)) throw new Error(`${name} is broken`);
}

vi.mock('../src/api/demos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/demos')>()),
  pollDemo: async () => ({
    id: 'demo1',
    status: 'done',
    map: 'de_mirage',
    rounds: 2,
    error: null,
    summary: null,
  }),
}));

vi.mock('../src/api/assets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/assets')>()),
  mapManifest: async () => ({ files: {} }),
}));

vi.mock('../src/pack/client', () => ({
  loadPack: async () => PACK.value,
}));

vi.mock('../src/components/Viewport', () => ({
  default: function Viewport() {
    check('3d');
    return <div data-testid="viewport" />;
  },
}));

vi.mock('../src/components/Radar', () => ({
  default: function Radar({ mode }: { mode: string }) {
    check('radar');
    return <div data-testid={`radar-${mode}`} />;
  },
}));

vi.mock('../src/components/hud/RoundBar', async (importOriginal) => {
  const Real = (
    await importOriginal<typeof import('../src/components/hud/RoundBar')>()
  ).default;
  return {
    default: function RoundBar() {
      check('round bar');
      return <Real />;
    },
  };
});

/** The pack `loadPack` hands DemoView: a fresh `pack()` for each test. */
const PACK = vi.hoisted(() => ({ value: null as unknown }));

const R = 64;

/** Two rounds of four players, a kill in the first. */
function pack() {
  return withSecondRound(
    trackPack({
      samples: 3000,
      freeze: 10 * R,
      teams: [2, 2, 3, 3],
      players: [0, 1, 2, 3].map((i) => () => ({ x: i * 100, y: 0 })),
      events: [
        event('player_death', 3000, {
          user_idx: 3,
          attacker_idx: 0,
          weapon: 'ak47',
        }),
      ],
    })
  );
}

let errors: MockInstance<typeof console.error>;

beforeEach(() => {
  PACK.value = pack();
  broken.clear();
  // React reports each caught error too; the boundaries' own lines are checked below.
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  // jsdom has no 2D canvas (and says so on every call): the first-person overlay draws
  // nothing, as it does in a browser without one.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** The console lines the boundaries wrote. */
const logged = () =>
  errors.mock.calls
    .map((c) => String(c[0]))
    .filter((line) => line.startsWith('demoviewer:'));

const notes = () =>
  screen.queryAllByTestId('panel-error').map((n) => n.textContent);

describe('ErrorBoundary around a panel', () => {
  function Bomb({ name }: { name: string }) {
    check(name);
    return <p>{name} is fine</p>;
  }

  it('shows a quiet note naming the panel, keeps its siblings, and logs the error', () => {
    broken.add('widget');
    render(
      <div>
        <ErrorBoundary region="the widget">
          <Bomb name="widget" />
        </ErrorBoundary>
        <Bomb name="sibling" />
      </div>
    );
    const note = screen.getByTestId('panel-error');
    expect(note.textContent).toBe('the widget stopped working');
    expect(note.getAttribute('role')).toBe('status');
    expect(note.title).toBe('widget is broken');
    expect(screen.getByText('sibling is fine')).toBeTruthy();
    expect(logged()).toEqual(['demoviewer: render error in the widget']);
  });

  it('tries its children again when its reset key changes, not before', () => {
    broken.add('widget');
    const at = (key: number) => (
      <ErrorBoundary region="the widget" resetKey={key}>
        <Bomb name="widget" />
      </ErrorBoundary>
    );
    const { rerender } = render(at(1));
    broken.delete('widget');
    rerender(at(1));
    expect(notes()).toEqual(['the widget stopped working']);
    rerender(at(2));
    expect(notes()).toEqual([]);
    expect(screen.getByText('widget is fine')).toBeTruthy();
  });

  it('at the root, still replaces everything with the reload panel', () => {
    broken.add('app');
    render(
      <ErrorBoundary>
        <Bomb name="app" />
      </ErrorBoundary>
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Something went wrong'
    );
    expect(screen.queryByTestId('panel-error')).toBeNull();
  });
});

describe('DemoView with a panel that throws', () => {
  async function open() {
    render(<DemoView demoId="demo1" />);
    await waitFor(() => expect(playbackStore.getState().pack).not.toBeNull());
  }

  /** The parts of the viewer that must outlive any one panel. */
  function expectViewerUp() {
    expect(screen.getByTestId('transport')).toBeTruthy();
    expect(screen.getByTestId('clock')).toBeTruthy();
    expect(screen.getAllByTestId('player-row')).toHaveLength(4);
  }

  it('draws every panel with nothing broken', async () => {
    await open();
    expect(notes()).toEqual([]);
    // The 3D view is a chunk of its own: in once its import settles.
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expectViewerUp();
  });

  it('loses only the round bar when it throws, and tries it again the next round', async () => {
    broken.add('round bar');
    await open();
    expect(notes()).toEqual(['the round bar stopped working']);
    // The 3D view is a chunk of its own: in once its import settles.
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expectViewerUp();
    expect(logged()).toContain('demoviewer: render error in the round bar');

    broken.delete('round bar');
    act(() => playbackStore.getState().seekRound(1));
    expect(notes()).toEqual([]);
  });

  it('loses only the 3D view when it throws', async () => {
    broken.add('3d');
    await open();
    await waitFor(() =>
      expect(notes()).toEqual(['the 3D view stopped working · reload the page'])
    );
    expect(screen.queryByTestId('viewport')).toBeNull();
    expectViewerUp();
    // A new round does not build the scene again: only a new pack does.
    broken.delete('3d');
    act(() => playbackStore.getState().seekRound(1));
    expect(notes()).toEqual(['the 3D view stopped working · reload the page']);
  });

  it('plays on without the 3D view: Play moves the clock, and the sound stays', async () => {
    broken.add('3d');
    await open();
    await waitFor(() =>
      expect(notes()).toEqual(['the 3D view stopped working · reload the page'])
    );
    const from = playbackStore.getState().tick;
    act(() => playbackStore.getState().play());
    // jsdom's animation frames come at 60 Hz.
    await waitFor(() =>
      expect(playbackStore.getState().tick).toBeGreaterThan(from + 10)
    );
    act(() => playbackStore.getState().pause());
    expect(window.__demoviewer?.sound).toBeDefined();
  });

  it('loses only the radar when it throws, the 3D view under it included', async () => {
    broken.add('radar');
    await open();
    // The minimap is the radar too.
    expect(notes()).toEqual(['the minimap stopped working']);
    act(() => playbackStore.getState().setRadar(true));
    expect(notes()).toEqual(['the radar stopped working']);
    // The 3D view is a chunk of its own: in once its import settles.
    expect(await screen.findByTestId('viewport')).toBeTruthy();
    expectViewerUp();
  });
});
