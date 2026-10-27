// The store's camera state: two modes, POV by default on the first player, and whether the
// followed player was picked by the user (`followPinned`) or by the camera itself.

import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import {
  directorPlan,
  directorTargetAt,
  planDirector,
} from '../src/sim/director';
import { DEATH_VIEW_S } from '../src/sim/deathview';
import { timelineFor } from '../src/sim/timeline';
import { advance } from '../src/state/clock';
import type { Reel } from '../src/state/reel';
import {
  DIRECTOR_KEY,
  autoKillcamDue,
  createPlaybackStore,
  directedFollow,
  startAutoKillcam,
  shownAt,
  type Playback,
} from '../src/state/store';
import type { PrefsStorage } from '../src/state/storage';
import { playbackPack } from './helpers/playback-pack';
import { event, trackPack } from './helpers/track-pack';

function storeWith(players = 10) {
  const store = createPlaybackStore({ storage: null });
  store
    .getState()
    .setPack(playbackPack({ players, rounds: [{ start: 100, end: 300 }] }));
  return store;
}

describe('camera state', () => {
  it('starts in POV on the first player, not pinned', () => {
    const store = createPlaybackStore({ storage: null });
    expect(store.getState()).toMatchObject({
      camera: 'pov',
      follow: null,
      followPinned: false,
    });
    store
      .getState()
      .setPack(playbackPack({ players: 4, rounds: [{ start: 1, end: 9 }] }));
    expect(store.getState()).toMatchObject({
      camera: 'pov',
      follow: 0,
      followPinned: false,
    });
  });

  it('has no top, orbit or follow camera', () => {
    const store = storeWith();
    store.getState().setCamera('free');
    // @ts-expect-error 'top' is not a camera mode
    store.getState().setCamera('top');
    // @ts-expect-error 'orbit' is not a camera mode
    store.getState().setCamera('orbit');
    // @ts-expect-error 'follow' is not a camera mode any more
    store.getState().setCamera('follow');
    expect(store.getState().camera).toBe('free');
  });

  it('setFollow from the UI or the keys pins the player; the camera mode stays', () => {
    const store = storeWith();
    store.getState().setFollow(3);
    expect(store.getState()).toMatchObject({
      follow: 3,
      followPinned: true,
      camera: 'pov',
    });
    store.getState().setCamera('free');
    store.getState().setFollow(5);
    expect(store.getState()).toMatchObject({
      follow: 5,
      followPinned: true,
      camera: 'free',
    });
    // The director's picks are not pins.
    store.getState().setFollow(2, false);
    expect(store.getState()).toMatchObject({ follow: 2, followPinned: false });
    store.getState().setFollow(null);
    expect(store.getState()).toMatchObject({
      follow: null,
      followPinned: false,
    });
  });

  it("setCamera('free') keeps who is followed; POV takes the first player if nobody is", () => {
    const store = storeWith();
    store.getState().setFollow(4);
    store.getState().setCamera('free');
    expect(store.getState()).toMatchObject({
      camera: 'free',
      follow: 4,
      followPinned: true,
    });
    store.getState().setFollow(null);
    store.getState().setCamera('pov');
    expect(store.getState()).toMatchObject({
      camera: 'pov',
      follow: 0,
      followPinned: false,
    });
  });

  it('a new pack keeps a followed player it still has, else follows its first', () => {
    const store = storeWith(10);
    store.getState().setFollow(7);
    store
      .getState()
      .setPack(playbackPack({ players: 10, rounds: [{ start: 1, end: 9 }] }));
    expect(store.getState()).toMatchObject({ follow: 7, followPinned: true });
    store
      .getState()
      .setPack(playbackPack({ players: 2, rounds: [{ start: 1, end: 9 }] }));
    expect(store.getState()).toMatchObject({
      follow: 0,
      followPinned: false,
      camera: 'pov',
    });
    store
      .getState()
      .setPack(playbackPack({ players: 0, rounds: [{ start: 1, end: 9 }] }));
    expect(store.getState()).toMatchObject({ follow: null, camera: 'pov' });
  });
});

describe('the full radar', () => {
  it('opens and closes, and a camera choice or a new pack closes it', () => {
    const store = storeWith();
    expect(store.getState().radar).toBe(false);
    store.getState().setRadar(true);
    expect(store.getState().radar).toBe(true);
    store.getState().setCamera('pov');
    expect(store.getState().radar).toBe(false);
    store.getState().setRadar(true);
    store.getState().setPack(null);
    expect(store.getState().radar).toBe(false);
  });

  it('stays closed without a pack', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setRadar(true);
    expect(store.getState().radar).toBe(false);
  });
});

describe('the device preset', () => {
  it("takes the device's preset over the default, and not saved", () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().deviceQuality('low');
    expect(store.getState()).toMatchObject({
      quality: 'low',
      qualityFrom: 'device',
    });
    // Measuring no longer picks one.
    store.getState().detectQuality(500);
    expect(store.getState().quality).toBe('low');
  });

  it("leaves the viewer's choice alone", () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setQuality('high');
    store.getState().deviceQuality('low');
    expect(store.getState()).toMatchObject({
      quality: 'high',
      qualityFrom: 'chosen',
    });
  });
});

describe('director', () => {
  // Player 1 is nearest the enemies from the start; player 2 kills player 0 at 2000, so the
  // director cuts to player 2 at 1904.
  const standing =
    (x: number, y: number, deathTick = Infinity) =>
    (k: number) => ({
      x,
      y,
      flags: 1000 + k * 2 > deathTick ? 0 : FLAG.alive,
    });
  const pack = trackPack({
    samples: 800,
    players: [
      standing(5000, 0, 2000),
      standing(0, 0),
      standing(300, 0),
      standing(0, 300),
    ],
    events: [
      event('player_hurt', 2000, {
        user_idx: 0,
        attacker_idx: 2,
        dmg_health: 100,
      }),
      event('player_death', 2000, { user_idx: 0, attacker_idx: 2 }),
    ],
  });
  const plan = planDirector(pack, 0);

  function memory(init: Record<string, string> = {}) {
    const m = new Map(Object.entries(init));
    const storage: PrefsStorage = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => void m.set(k, v),
    };
    return { m, storage };
  }

  it('is off by default, and reads and saves the toggle', () => {
    expect(createPlaybackStore({ storage: null }).getState().director).toBe(
      false
    );
    const saved = memory({ [DIRECTOR_KEY]: '1' });
    expect(
      createPlaybackStore({ storage: saved.storage }).getState().director
    ).toBe(true);
    const { m, storage } = memory();
    const store = createPlaybackStore({ storage });
    store.getState().setDirector(true);
    expect(m.get(DIRECTOR_KEY)).toBe('1');
    store.getState().setDirector(false);
    expect(m.get(DIRECTOR_KEY)).toBe('0');
  });

  it('leaves the saved toggle alone with save: false, as a link being opened does', () => {
    const { m, storage } = memory({ [DIRECTOR_KEY]: '0' });
    const store = createPlaybackStore({ storage });
    store.getState().setPack(pack);
    store.getState().setDirector(true, { save: false });
    expect(store.getState().director).toBe(true);
    expect(m.get(DIRECTOR_KEY)).toBe('0');
    // A pinned pick still takes the camera from the director, unsaved.
    store.getState().setFollow(2, true, { save: false });
    expect(store.getState()).toMatchObject({
      director: false,
      follow: 2,
      followPinned: true,
    });
    expect(m.get(DIRECTOR_KEY)).toBe('0');
    // The defaults save, as before.
    store.getState().setDirector(true);
    expect(m.get(DIRECTOR_KEY)).toBe('1');
    store.getState().setFollow(3, true, { save: false });
    expect(m.get(DIRECTOR_KEY)).toBe('1');
    store.getState().setDirector(true);
    store.getState().setFollow(3);
    expect(m.get(DIRECTOR_KEY)).toBe('0');
  });

  it('writes its pick into follow, unpinned, on every seek and clock tick in POV', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(pack);
    store.getState().setFollow(3);
    store.getState().setDirector(true);
    expect(store.getState()).toMatchObject({ follow: 1, followPinned: false });
    expect(plan.find((c) => c.follow === 2)?.tick).toBe(1904);
    store.getState().seekTick(1950);
    expect(store.getState()).toMatchObject({ follow: 2, followPinned: false });
    store.getState().seekTick(1200);
    expect(store.getState().follow).toBe(1);
    // The clock writes the tick with setState.
    store.setState({ tick: 1904 });
    expect(store.getState().follow).toBe(directorTargetAt(plan, 1904));
    expect(directedFollow(store.getState())).toEqual({
      follow: 2,
      pinned: false,
    });
  });

  it('opens a pack in POV with the director driving when Auto is saved on', () => {
    const { storage } = memory({ [DIRECTOR_KEY]: '1' });
    const store = createPlaybackStore({ storage });
    store.getState().setPack(pack);
    const s = store.getState();
    const pick = directorTargetAt(plan, s.tick);
    expect(pick).toBeGreaterThanOrEqual(0);
    expect(s).toMatchObject({
      camera: 'pov',
      director: true,
      follow: pick,
      followPinned: false,
    });
    expect(directedFollow(s)).toEqual({ follow: pick, pinned: false });
    expect(shownAt(s)).toBe(pick);
  });

  it('only drives POV; turning it on in Free goes to POV', () => {
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(pack);
    store.getState().setCamera('free');
    store.getState().setFollow(3, false);
    store.setState({ director: true });
    store.getState().seekTick(1950);
    expect(store.getState()).toMatchObject({ camera: 'free', follow: 3 });
    expect(directedFollow(store.getState()).follow).toBe(3);
    store.getState().setDirector(false);
    store.getState().setDirector(true);
    expect(store.getState()).toMatchObject({ camera: 'pov', follow: 2 });
    expect(directedFollow(store.getState())).toEqual({
      follow: 2,
      pinned: false,
    });
  });

  it("is turned off by the user's pick", () => {
    const { m, storage } = memory();
    const store = createPlaybackStore({ storage });
    store.getState().setPack(pack);
    store.getState().setDirector(true);
    store.getState().setFollow(3);
    expect(store.getState()).toMatchObject({
      director: false,
      follow: 3,
      followPinned: true,
    });
    expect(m.get(DIRECTOR_KEY)).toBe('0');
    store.getState().seekTick(1950);
    expect(store.getState().follow).toBe(3);
  });
});

describe('shownAt', () => {
  // Player 0 (T) dies on sample 50 (tick 1100), killed by player 1 (CT).
  const pack = trackPack({
    players: [
      (k: number) => ({ x: 0, y: 0, flags: k < 50 ? FLAG.alive : 0 }),
      () => ({ x: 0, y: 200 }),
    ],
    teams: [2, 3],
    events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
  });
  const store = () => {
    const st = createPlaybackStore({ storage: null });
    st.getState().setPack(pack);
    st.setState({ director: false, camera: 'pov' });
    return st;
  };

  it('is the attacker 2 s after an unpinned follow dies, while follow still names the victim', () => {
    const st = store();
    st.getState().setFollow(0, false);
    st.setState({ tick: 1100 + DEATH_VIEW_S * 64 - 2 });
    expect(shownAt(st.getState())).toBe(0);
    st.setState({ tick: 1100 + DEATH_VIEW_S * 64 });
    expect(st.getState().follow).toBe(0);
    expect(shownAt(st.getState())).toBe(1);
  });

  it('stays on a pinned follow after the death', () => {
    const st = store();
    st.getState().setFollow(0);
    st.setState({ tick: 1300 });
    expect(shownAt(st.getState())).toBe(0);
  });
});

describe('the after-round', () => {
  it('lets the clock run and seek to post_end_tick, and play on from inside it', () => {
    const store = createPlaybackStore({ storage: null });
    store
      .getState()
      .setPack(playbackPack({ rounds: [{ start: 100, end: 300, post: 350 }] }));
    store.getState().seekTick(340);
    expect(store.getState().tick).toBe(340);
    store.getState().seekTick(999);
    expect(store.getState().tick).toBe(350);
    store.getState().seekTick(320);
    store.getState().play();
    // Past end_tick but inside the after-round: play carries on from here.
    expect(store.getState().tick).toBe(320);
  });
});

describe('reels', () => {
  // Two rounds at 64 tick; player 1 (index 0) kills player 6 (index 5) at 5000, and player 7
  // (index 6) kills player 2 (index 1) at 14000. Samples sit at start + 8k.
  const death = (tick: number, victim: number, attacker: number) =>
    event('player_death', tick, {
      user_idx: victim,
      attacker_idx: attacker,
      weapon: 'ak47',
    });
  const PACK = playbackPack({
    rounds: [
      { start: 1000, freeze: 2000, end: 10000, post: 10500 },
      { start: 11000, freeze: 12000, end: 20000, post: 20500 },
    ],
    events: [death(5000, 5, 0), death(14000, 1, 6)],
  });
  // The kill cam of the death at 5000: 4680 (5 s before) to 5064 (1 s after).
  const KC = { from: 4680, to: 5064 };
  const seg = (round: number, from: number, to: number, follow: number) => ({
    round,
    from,
    to,
    follow,
    title: `${round}`,
  });

  /**
   * A store with the director on (saved), following player index 5 at 2× in POV, paused at
   * 5500, and a spy on what it saves.
   */
  function reelStore() {
    const saved: [string, string][] = [];
    const m = new Map([[DIRECTOR_KEY, '1']]);
    const storage: PrefsStorage = {
      getItem: (k) => m.get(k) ?? null,
      setItem: (k, v) => {
        saved.push([k, v]);
        m.set(k, v);
      },
    };
    const store = createPlaybackStore({ storage });
    store.getState().setPack(PACK);
    store.getState().setFollow(5, false);
    store.getState().setSpeed(2);
    store.getState().seekTick(5500);
    expect(store.getState()).toMatchObject({
      director: true,
      camera: 'pov',
      follow: 5,
      followPinned: false,
      speed: 2,
      playing: false,
    });
    // The director has no plan without tracks: it keeps the follow.
    expect(directedFollow(store.getState()).follow).toBe(5);
    const directorWrites = () => saved.filter(([k]) => k === DIRECTOR_KEY);
    return { store, directorWrites };
  }

  /** Runs the clock (as the frame loop does) until the reel ends, or 30 s of play. */
  function playOut(store: ReturnType<typeof reelStore>['store']) {
    for (let i = 0; i < 300 && store.getState().reel; i++)
      store.setState(advance(store.getState(), 0.1));
  }

  const BEFORE = {
    round: 0,
    tick: 5500,
    camera: 'pov',
    follow: 5,
    followPinned: false,
    director: true,
    playing: false,
    speed: 2,
  };

  it('starts with no reel and the highlights closed', () => {
    const store = createPlaybackStore({ storage: null });
    expect(store.getState()).toMatchObject({ reel: null, highlights: false });
  });

  it("killcam() plays the followed player's last death in POV on the attacker, at 1×", () => {
    const { store } = reelStore();
    store.getState().killcam();
    const s = store.getState();
    expect(s.reel).toMatchObject({
      kind: 'killcam',
      index: 0,
      atEnd: 'resume',
      resume: BEFORE,
    });
    expect(s.reel?.segments).toEqual([
      {
        round: 0,
        ...KC,
        follow: 0,
        title: 'Kill cam · player1 killed player6',
      },
    ]);
    expect(s).toMatchObject({
      round: 0,
      tick: KC.from,
      camera: 'pov',
      follow: 0,
      followPinned: true,
      director: false,
      playing: true,
      speed: 1,
      radar: false,
    });
  });

  it('killcam() does nothing without a death of the followed player by the tick', () => {
    const { store } = reelStore();
    store.getState().seekTick(4999);
    const before = store.getState();
    store.getState().killcam();
    expect(store.getState()).toBe(before);
    store.getState().seekTick(6000);
    store.getState().setFollow(3, false);
    const other = store.getState();
    store.getState().killcam();
    expect(store.getState()).toBe(other);
  });

  it('killcam(kill) plays that kill', () => {
    const { store } = reelStore();
    store.getState().seekRound(1);
    store.getState().seekTick(15000);
    const kill = timelineFor(PACK).kills(1)[0];
    store.getState().killcam(kill);
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 14000 - 320,
      camera: 'pov',
      follow: 6,
    });
    expect(store.getState().reel?.resume).toMatchObject({
      round: 1,
      tick: 15000,
    });
  });

  it('advancing past the end goes back to the round, tick, camera, director and speed from before', () => {
    const { store, directorWrites } = reelStore();
    store.getState().killcam();
    store.setState({ tick: KC.to - 1 });
    expect(store.getState().reel).not.toBeNull();
    playOut(store);
    expect(store.getState()).toMatchObject({ ...BEFORE, reel: null });
    // The reel turned the director off and on again without saving either.
    expect(directorWrites()).toEqual([]);
  });

  it('a highlights reel moves to the next round’s segment as the clock passes the end, then plays on there in the old camera', () => {
    const { store, directorWrites } = reelStore();
    store
      .getState()
      .startReel(
        'highlights',
        [seg(0, 3000, 3500, 1), seg(1, 13000, 13500, 2)],
        'continue'
      );
    expect(store.getState()).toMatchObject({
      round: 0,
      tick: 3000,
      follow: 1,
      camera: 'pov',
      playing: true,
    });
    store.setState(advance(store.getState(), 0.5));
    expect(store.getState().reel?.index).toBe(0);
    store.setState(advance(store.getState(), 8));
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 13000,
      follow: 2,
      camera: 'pov',
      reel: { index: 1 },
    });
    store.setState({ tick: 13510 });
    expect(store.getState()).toMatchObject({
      reel: null,
      round: 1,
      tick: 13510,
      camera: 'pov',
      follow: 5,
      followPinned: false,
      director: true,
      speed: 2,
      playing: true,
    });
    expect(directorWrites()).toEqual([]);
  });

  it('nextInReel() skips to the next segment, and past the last leaves as the end would', () => {
    const { store } = reelStore();
    const segs = [seg(0, 3000, 3500, 1), seg(1, 13000, 13500, 2)];
    store.getState().startReel('highlights', segs, 'continue');
    store.getState().nextInReel();
    expect(store.getState()).toMatchObject({
      round: 1,
      tick: 13000,
      follow: 2,
      reel: { index: 1 },
    });
    store.setState({ tick: 13200 });
    store.getState().nextInReel();
    expect(store.getState()).toMatchObject({
      reel: null,
      round: 1,
      tick: 13200,
      camera: 'pov',
      director: true,
      speed: 2,
    });
    // A kill cam's only segment: next is back to where it started.
    store.getState().seekRound(0);
    store.getState().seekTick(5500);
    store.getState().pause();
    store.getState().killcam();
    store.getState().nextInReel();
    expect(store.getState()).toMatchObject({ ...BEFORE, reel: null });
    // Without a reel it does nothing.
    const now = store.getState();
    store.getState().nextInReel();
    expect(store.getState()).toBe(now);
  });

  it('endReel() goes back to where the reel started, from any segment', () => {
    const { store, directorWrites } = reelStore();
    store
      .getState()
      .startReel(
        'highlights',
        [seg(0, 3000, 3500, 1), seg(1, 13000, 13500, 2)],
        'continue'
      );
    store.getState().nextInReel();
    store.getState().endReel();
    expect(store.getState()).toMatchObject({ ...BEFORE, reel: null });
    expect(directorWrites()).toEqual([]);
  });

  it('a reel started during another goes back to where the first started', () => {
    const { store } = reelStore();
    store.getState().killcam();
    store
      .getState()
      .startReel('highlights', [seg(1, 13000, 13500, 2)], 'resume');
    expect(store.getState()).toMatchObject({ round: 1, tick: 13000 });
    expect(store.getState().reel?.resume).toEqual(BEFORE);
    store.getState().endReel();
    expect(store.getState()).toMatchObject({ ...BEFORE, reel: null });
  });

  it('startReel with no segments does nothing', () => {
    const { store } = reelStore();
    const before = store.getState();
    store.getState().startReel('highlights', [], 'continue');
    expect(store.getState()).toBe(before);
  });

  describe('interrupted, it ends where the user went with their director and speed back, for good', () => {
    const cases: [string, (s: Playback) => void, Record<string, unknown>][] = [
      [
        'seekTick',
        (s) => s.seekTick(6000),
        { round: 0, tick: 6000, camera: 'pov', follow: 5, director: true },
      ],
      [
        'seekRound',
        (s) => s.seekRound(1),
        { round: 1, tick: 12000, camera: 'pov', director: true },
      ],
      [
        'stepSample',
        (s) => s.stepSample(1),
        { round: 0, tick: 4704, playing: false, director: true },
      ],
      [
        'setFollow',
        (s) => s.setFollow(2),
        {
          round: 0,
          tick: 4700,
          camera: 'pov',
          follow: 2,
          followPinned: true,
          director: false,
        },
      ],
      [
        'setCamera',
        (s) => s.setCamera('free'),
        { round: 0, tick: 4700, camera: 'free', follow: 5, director: true },
      ],
      [
        'setDirector',
        (s) => s.setDirector(false),
        { round: 0, tick: 4700, camera: 'pov', director: false },
      ],
      [
        'setRadar',
        (s) => s.setRadar(true),
        {
          round: 0,
          tick: 4700,
          radar: true,
          camera: 'pov',
          follow: 5,
          director: true,
        },
      ],
    ];

    for (const [name, act, expected] of cases)
      it(name, () => {
        const { store } = reelStore();
        store.getState().killcam();
        store.setState({ tick: 4700 });
        act(store.getState());
        expect(store.getState()).toMatchObject({
          reel: null,
          speed: 2,
          ...expected,
        });
        // The clock running on past the kill cam's end does not take it back.
        const { round, tick } = store.getState();
        store.setState({ tick: tick + 500 });
        expect(store.getState()).toMatchObject({
          reel: null,
          round,
          tick: tick + 500,
        });
      });

    it('setRadar(false) and setSpeed leave the reel playing', () => {
      const { store } = reelStore();
      store.getState().killcam();
      store.getState().setRadar(false);
      store.getState().setSpeed(4);
      store.getState().pause();
      store.getState().play();
      expect(store.getState().reel).not.toBeNull();
      playOut(store);
      // Its speed comes back too.
      expect(store.getState()).toMatchObject({ ...BEFORE, reel: null });
    });

    it('a new pack', () => {
      const { store } = reelStore();
      store.getState().setHighlights(true);
      store.getState().killcam();
      store.getState().setPack(PACK);
      expect(store.getState()).toMatchObject({
        reel: null,
        highlights: false,
        round: 0,
        tick: 2000,
        camera: 'pov',
        follow: 5,
        director: true,
        speed: 2,
        playing: false,
      });
      store.getState().killcam();
      store.getState().setPack(null);
      expect(store.getState()).toMatchObject({
        reel: null,
        highlights: false,
      });
    });
  });

  it('a pick or a seek with nothing to do leaves the reel playing', () => {
    const { store } = reelStore();
    store.getState().killcam();
    store.getState().setFollow(99);
    store.getState().seekTick(Number.NaN);
    store.getState().seekRound(Number.NaN);
    store.getState().stepSample(0);
    // @ts-expect-error not a camera mode
    store.getState().setCamera('top');
    expect(store.getState().reel).not.toBeNull();
  });

  describe('the automatic kill cam', () => {
    // Player index 5 dies at 5000; the camera holds their death view for 2 s (128 ticks), so
    // its kill cam is due when the clock passes 5128.
    const DUE = 5000 + DEATH_VIEW_S * 64;
    function playing() {
      const store = createPlaybackStore({ storage: null });
      store.getState().setPack(PACK);
      store.getState().setFollow(5);
      store.getState().seekTick(5000);
      store.getState().play();
      return store;
    }

    it('is due as the clock passes the death and its hold, playing in one round with no reel', () => {
      expect(DUE).toBe(5128);
      const s = playing().getState();
      const at = (tick: number) => ({ ...s, tick });
      expect(autoKillcamDue(at(DUE + 4), at(DUE - 6))).toMatchObject({
        tick: 5000,
        victim: 5,
      });
      expect(autoKillcamDue(at(DUE - 6), at(DUE - 16))).toBeNull();
      expect(autoKillcamDue(at(DUE + 104), at(DUE + 4))).toBeNull();
      // Paused, after a round change, with another pack, or with a reel before or after.
      expect(
        autoKillcamDue({ ...at(DUE + 4), playing: false }, at(DUE - 6))
      ).toBeNull();
      expect(
        autoKillcamDue(at(DUE + 4), { ...at(DUE - 6), round: 1 })
      ).toBeNull();
      expect(
        autoKillcamDue(at(DUE + 4), {
          ...at(DUE - 6),
          pack: playbackPack({ rounds: [{ start: 0, end: 10000 }] }),
        })
      ).toBeNull();
      const reel: Reel = {
        kind: 'killcam',
        segments: [seg(0, 4680, 5064, 0)],
        index: 0,
        resume: {
          round: 0,
          tick: DUE + 4,
          camera: 'pov',
          follow: 5,
          followPinned: true,
          director: false,
          playing: true,
          speed: 1,
        },
        atEnd: 'resume',
      };
      expect(autoKillcamDue({ ...at(DUE + 4), reel }, at(DUE - 6))).toBeNull();
      expect(autoKillcamDue(at(DUE + 4), { ...at(DUE - 6), reel })).toBeNull();
    });

    it('is due only in POV with the 3D view up: never in Free, nor on the full radar', () => {
      const s = playing().getState();
      const at = (tick: number, o: Partial<Playback> = {}) => ({
        ...s,
        tick,
        ...o,
      });
      expect(
        autoKillcamDue(
          at(DUE + 4, { camera: 'pov' }),
          at(DUE - 6, { camera: 'pov' })
        )
      ).toMatchObject({ tick: 5000, victim: 5 });
      // A flying camera is not yanked into a kill cam by its stale follow's death.
      expect(
        autoKillcamDue(
          at(DUE + 4, { camera: 'free' }),
          at(DUE - 6, { camera: 'free' })
        )
      ).toBeNull();
      // The radar stays up: a kill cam would switch to the 3D view and leave it closed.
      expect(
        autoKillcamDue(
          at(DUE + 4, { radar: true }),
          at(DUE - 6, { radar: true })
        )
      ).toBeNull();
    });

    it('plays once per death: not again when it gives the clock back past the hold', async () => {
      const store = playing();
      // As DemoView wires it, in the store's subscription.
      store.subscribe((s, prev) => startAutoKillcam(store, s, prev));
      // A listener after it hears each start of a reel once, from the state before it.
      const started: { title: string; from: number }[] = [];
      store.subscribe((s, prev) => {
        if (s.reel && !prev.reel)
          started.push({ title: s.reel.segments[0].title, from: prev.tick });
      });
      const seen = { reel: false, after: false };
      for (let i = 0; i < 200; i++) {
        store.setState(advance(store.getState(), 0.1));
        // The frame ends: what it queued runs.
        await Promise.resolve();
        const s = store.getState();
        if (s.reel) seen.reel = true;
        else if (seen.reel) seen.after = true;
      }
      expect(started).toHaveLength(1);
      expect(started[0].title).toBe('Kill cam · player1 killed player6');
      expect(started[0].from).toBeGreaterThanOrEqual(DUE);
      expect(started[0].from).toBeLessThan(DUE + 7);
      expect(seen).toEqual({ reel: true, after: true });
      // It gave back the round, POV on player index 5, and kept playing.
      const s = store.getState();
      expect(s).toMatchObject({
        reel: null,
        round: 0,
        camera: 'pov',
        follow: 5,
        playing: true,
      });
      expect(s.tick).toBeGreaterThan(DUE + 64);
    });

    it('does not start once the store has moved on before it could', async () => {
      const store = playing();
      store.subscribe((s, prev) => startAutoKillcam(store, s, prev));
      store.setState({ tick: DUE + 4 });
      // In the same task, before the start runs, the user goes to the next round.
      store.getState().seekRound(1);
      await Promise.resolve();
      expect(store.getState()).toMatchObject({ reel: null, round: 1 });
    });
  });

  it('setHighlights opens and closes the panel, only with a pack', () => {
    const empty = createPlaybackStore({ storage: null });
    empty.getState().setHighlights(true);
    expect(empty.getState().highlights).toBe(false);
    const { store } = reelStore();
    store.getState().setHighlights(true);
    expect(store.getState().highlights).toBe(true);
    // The panel and a reel are independent.
    store.getState().killcam();
    expect(store.getState().highlights).toBe(true);
    store.getState().setHighlights(false);
    expect(store.getState()).toMatchObject({ highlights: false });
    expect(store.getState().reel).not.toBeNull();
  });

  it('leaving gives the camera back to the director, which picks the follow again', () => {
    // As in the director tests: player 2 kills player 0 at 2000, the director follows 1 from
    // the start and cuts to 2 at 1904.
    const standing =
      (x: number, y: number, deathTick = Infinity) =>
      (k: number) => ({
        x,
        y,
        flags: 1000 + k * 2 > deathTick ? 0 : FLAG.alive,
      });
    const pack = trackPack({
      samples: 800,
      players: [
        standing(5000, 0, 2000),
        standing(0, 0),
        standing(300, 0),
        standing(0, 300),
      ],
      events: [
        event('player_hurt', 2000, {
          user_idx: 0,
          attacker_idx: 2,
          dmg_health: 100,
        }),
        event('player_death', 2000, { user_idx: 0, attacker_idx: 2 }),
      ],
    });
    const store = createPlaybackStore({ storage: null });
    store.getState().setPack(pack);
    store.getState().setDirector(true);
    store.getState().seekTick(2100);
    expect(store.getState().follow).toBe(2);
    store.getState().killcam(timelineFor(pack).kills(0)[0]);
    expect(store.getState()).toMatchObject({
      camera: 'pov',
      follow: 2,
      director: false,
    });
    store.getState().seekTick(1500);
    expect(store.getState()).toMatchObject({
      reel: null,
      director: true,
      camera: 'pov',
      follow: 1,
      followPinned: false,
    });
    expect(directorTargetAt(directorPlan(pack, 0), 1500)).toBe(1);
  });
});
