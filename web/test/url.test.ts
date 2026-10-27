import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLAG } from '../src/pack/types';
import { DEATH_VIEW_S } from '../src/sim/deathview';
import { createPlaybackStore, DIRECTOR_KEY } from '../src/state/store';
import {
  applyUrlState,
  readUrlState,
  urlPlayer,
  writeUrlState,
  type UrlTarget,
} from '../src/state/url';
import { playbackPack, threeRoundStore } from './helpers/playback-pack';
import { event, trackPack } from './helpers/track-pack';

describe('URL state', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reads ?r (1-based) and ?t into a round index and tick', () => {
    const u = (q: string) => new URL(`http://x/d/abc${q}`);
    expect(readUrlState(u('?r=2&t=520'))).toEqual({ round: 1, tick: 520 });
    expect(readUrlState(u('?r=1'))).toEqual({ round: 0 });
    expect(readUrlState(u('?t=12.5'))).toEqual({ tick: 12.5 });
    expect(readUrlState(u('?r=0&t=-3'))).toEqual({});
    expect(readUrlState(u('?r=x&t=1e9'))).toEqual({});
    expect(readUrlState(u(''))).toEqual({});
  });

  it('reads cam, p (1-based, as a player index) and at', () => {
    const u = (q: string) => new URL(`http://x/d/abc${q}`);
    expect(readUrlState(u('?r=2&t=520&cam=pov&p=3'))).toEqual({
      round: 1,
      tick: 520,
      camera: 'pov',
      player: 2,
    });
    expect(readUrlState(u('?cam=free&at=1.5,2,-3,90,-10.5'))).toEqual({
      camera: 'free',
      at: { x: 1.5, y: 2, z: -3, yaw: 90, pitch: -10.5 },
    });
    expect(readUrlState(u('?cam=auto'))).toEqual({ camera: 'auto' });
    // Each bad part is dropped on its own.
    expect(readUrlState(u('?r=2&t=520&cam=orbit&p=0&at=1,2,3'))).toEqual({
      round: 1,
      tick: 520,
    });
    expect(readUrlState(new URL('http://x/?cam=pov&p=3'))).toEqual({});
  });

  it('applies a camera and a player: pinned, with the director off', () => {
    const store = threeRoundStore();
    store.getState().setDirector(true);
    expect(store.getState()).toMatchObject({
      director: true,
      camera: 'pov',
    });
    applyUrlState(store, { round: 1, tick: 520, camera: 'pov', player: 2 });
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 520,
      camera: 'pov',
      follow: 2,
      followPinned: true,
      director: false,
      playing: false,
    });
  });

  it('applies POV with a player, and free with its selected player', () => {
    const store = threeRoundStore();
    store.getState().setCamera('free');
    applyUrlState(store, { camera: 'pov', player: 7 });
    expect(store.getState()).toMatchObject({
      camera: 'pov',
      follow: 7,
      followPinned: true,
    });
    // Free shows nobody, but its player is the white outline and the HUD's selection.
    applyUrlState(store, { round: 2, camera: 'free', player: 3 });
    expect(store.getState()).toMatchObject({
      round: 2,
      camera: 'free',
      follow: 3,
      followPinned: true,
    });
  });

  it('turns the director on for auto', () => {
    const store = threeRoundStore();
    store.getState().setCamera('free');
    expect(store.getState().director).toBe(false);
    applyUrlState(store, { round: 0, camera: 'auto' });
    expect(store.getState()).toMatchObject({
      director: true,
      camera: 'pov',
    });
  });

  it('opens an old Follow link in POV, pinned on its player', () => {
    const store = threeRoundStore();
    store.getState().setCamera('free');
    const state = readUrlState(
      new URL('http://x/d/abc?r=2&t=520&cam=follow&p=8')
    );
    expect(state).toEqual({ round: 1, tick: 520, camera: 'pov', player: 7 });
    applyUrlState(store, state);
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 520,
      camera: 'pov',
      follow: 7,
      followPinned: true,
      director: false,
    });
  });

  it('keeps the camera and the followed player for a player past the pack', () => {
    const store = threeRoundStore();
    store.getState().setFollow(4);
    applyUrlState(store, { round: 1, camera: 'pov', player: 99 });
    expect(store.getState()).toMatchObject({
      round: 1,
      camera: 'pov',
      follow: 4,
    });
    applyUrlState(store, { camera: 'free', player: 10 });
    expect(store.getState()).toMatchObject({ camera: 'free', follow: 4 });
  });

  it('follows a player whose camera was dropped, in the camera there is', () => {
    const store = threeRoundStore();
    const state = readUrlState(new URL('http://x/d/abc?r=2&cam=orbit&p=6'));
    expect(state).toEqual({ round: 1, player: 5 });
    applyUrlState(store, state);
    expect(store.getState()).toMatchObject({
      round: 1,
      camera: 'pov',
      follow: 5,
      followPinned: true,
    });
    // With auto, a player would take the camera back from the director: it is left out.
    applyUrlState(store, { camera: 'auto', player: 2 });
    expect(store.getState()).toMatchObject({
      director: true,
      camera: 'pov',
    });
  });

  it("never saves the viewer's Auto setting while opening a link", () => {
    for (const saved of ['1', '0']) {
      const writes: [string, string][] = [];
      const m = new Map([[DIRECTOR_KEY, saved]]);
      const store = createPlaybackStore({
        storage: {
          getItem: (k) => m.get(k) ?? null,
          setItem: (k, v) => {
            writes.push([k, v]);
            m.set(k, v);
          },
        },
      });
      store
        .getState()
        .setPack(
          playbackPack({ players: 10, rounds: [{ start: 100, end: 300 }] })
        );
      expect(store.getState().director).toBe(saved === '1');
      // A player picked by the link takes the camera from the director, for this visit.
      applyUrlState(store, { camera: 'auto' });
      expect(store.getState().director).toBe(true);
      applyUrlState(store, { camera: 'pov', player: 3 });
      expect(store.getState()).toMatchObject({
        director: false,
        camera: 'pov',
        follow: 3,
        followPinned: true,
      });
      applyUrlState(store, { camera: 'auto' });
      applyUrlState(store, { player: 1 });
      expect(store.getState()).toMatchObject({ director: false, follow: 1 });
      expect(
        writes.filter(([k]) => k === DIRECTOR_KEY),
        saved
      ).toEqual([]);
      expect(m.get(DIRECTOR_KEY)).toBe(saved);
    }
  });

  it("opens a tick past the round's end at its post_end_tick, paused", () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(
      playbackPack({
        players: 10,
        rounds: [
          { start: 100, freeze: 150, end: 300, post: 340 },
          { start: 400, freeze: 450, end: 600, post: 680 },
        ],
      })
    );
    store.getState().play();
    applyUrlState(store, { round: 1, tick: 99999, camera: 'pov', player: 0 });
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 680,
      playing: false,
      camera: 'pov',
      follow: 0,
    });
  });

  it('applies a URL state through the clamping seeks', () => {
    const store = threeRoundStore();
    applyUrlState(store, { round: 1, tick: 520 });
    expect(store.getState()).toMatchObject({ round: 1, tick: 520 });
    applyUrlState(store, { round: 2 });
    expect(store.getState()).toMatchObject({ round: 2, tick: 750 });
    applyUrlState(store, { round: 99, tick: 5 });
    expect(store.getState()).toMatchObject({ round: 2, tick: 700 });
  });

  it('writes ?r&t with replaceState at most once a second, keeping other params', () => {
    vi.useFakeTimers();
    const store = threeRoundStore();
    const urls: string[] = [];
    const target: UrlTarget = {
      location: { href: 'http://x/d/abc?debug=1' },
      history: {
        state: { a: 1 },
        replaceState(data, _unused, url) {
          expect(data).toEqual({ a: 1 });
          urls.push(String(url));
          target.location.href = String(url);
        },
      },
    };
    store.getState().seekRound(1);
    writeUrlState(store, target);
    expect(urls).toEqual(['http://x/d/abc?debug=1&r=2&t=450&cam=pov&p=1']);
    store.getState().seekTick(500.4);
    writeUrlState(store, target);
    store.getState().seekTick(510.6);
    writeUrlState(store, target);
    expect(urls).toHaveLength(1);
    // The trailing write lands a second after the first, with the latest position.
    vi.advanceTimersByTime(1000);
    expect(urls).toEqual([
      'http://x/d/abc?debug=1&r=2&t=450&cam=pov&p=1',
      'http://x/d/abc?debug=1&r=2&t=511&cam=pov&p=1',
    ]);
    // Nothing changed: no write.
    vi.advanceTimersByTime(5000);
    writeUrlState(store, target);
    expect(urls).toHaveLength(2);
  });

  /** A URL target at `href` that records each write; each test has its own store. */
  function urlTarget(href: string) {
    const target: UrlTarget & { urls: string[] } = {
      urls: [],
      location: { href },
      history: {
        state: null,
        replaceState(_data, _unused, url) {
          target.urls.push(String(url));
          target.location.href = String(url);
        },
      },
    };
    return target;
  }

  it('writes cam=auto and no p while the director drives POV', () => {
    const store = threeRoundStore();
    store.getState().setFollow(3);
    store.getState().setDirector(true);
    const target = urlTarget('http://x/d/abc?p=4');
    writeUrlState(store, target);
    expect(target.urls).toEqual(['http://x/d/abc?r=1&t=150&cam=auto']);
  });

  it('writes the camera, p for POV and Free, and drops at', () => {
    vi.useFakeTimers();
    const store = threeRoundStore();
    store.getState().setCamera('pov');
    store.getState().setFollow(3);
    const target = urlTarget(
      'http://x/d/abc?r=1&t=150&cam=free&at=1.00,2.00,3.00,4.0,5.0&hud=0'
    );
    writeUrlState(store, target);
    expect(target.urls).toEqual(['http://x/d/abc?r=1&t=150&cam=pov&hud=0&p=4']);
    // Free names its selected player too, and still no at.
    store.getState().setCamera('free');
    vi.advanceTimersByTime(1000);
    writeUrlState(store, target);
    expect(target.urls[1]).toBe('http://x/d/abc?r=1&t=150&cam=free&hud=0&p=4');
    // Free with the director on: the director drives only POV, so Free keeps its player.
    store.setState({ director: true, tick: 160 });
    vi.advanceTimersByTime(1000);
    writeUrlState(store, target);
    expect(target.urls[2]).toBe('http://x/d/abc?r=1&t=160&cam=free&hud=0&p=4');
  });
});

describe('urlPlayer', () => {
  // Player 1 (index 0, T) dies at 1100, killed by player 2 (index 1, CT); the camera holds
  // their death view for 2 s (128 ticks) and then cuts to the killer.
  const pack = trackPack({
    players: [
      (k: number) => ({ x: 0, y: 0, flags: k < 50 ? FLAG.alive : 0 }),
      () => ({ x: 0, y: 200 }),
    ],
    teams: [2, 3],
    events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
  });
  const cut = 1100 + DEATH_VIEW_S * 64;
  function store() {
    const st = createPlaybackStore({ storage: null });
    st.getState().setPack(pack);
    st.setState({ director: false, camera: 'pov' });
    return st;
  }

  it('names the player on screen: the killer once an unpinned follow has cut to them', () => {
    expect(cut).toBe(1228);
    for (const camera of ['pov', 'free'] as const) {
      const st = store();
      st.setState({ camera });
      // As the viewer opens: POV on player 1, unpinned.
      expect(st.getState()).toMatchObject({ follow: 0, followPinned: false });
      st.setState({ tick: cut - 2 });
      expect(urlPlayer(st.getState()), camera).toBe(1);
      st.setState({ tick: cut });
      expect(st.getState().follow).toBe(0);
      expect(urlPlayer(st.getState()), camera).toBe(2);
    }
  });

  it('names a pinned follow, on their body too', () => {
    for (const camera of ['pov', 'free'] as const) {
      const st = store();
      st.getState().setFollow(0);
      st.setState({ camera, tick: cut + 50 });
      expect(urlPlayer(st.getState()), camera).toBe(1);
    }
  });

  it('writes the killer into the URL bar, and the link opens pinned on them', () => {
    const st = store();
    st.setState({ tick: cut + 10 });
    const target: UrlTarget = {
      location: { href: 'http://x/d/abc' },
      history: {
        state: null,
        replaceState(_data, _unused, url) {
          target.location.href = String(url);
        },
      },
    };
    writeUrlState(st, target);
    expect(target.location.href).toBe(
      `http://x/d/abc?r=1&t=${cut + 10}&cam=pov&p=2`
    );
    const other = store();
    applyUrlState(other, readUrlState(new URL(target.location.href)));
    expect(other.getState()).toMatchObject({
      camera: 'pov',
      follow: 1,
      followPinned: true,
    });
  });
});
