// The viewer's state: the loaded pack, the playback clock (round index, tick as a float,
// speed, playing), the camera and the viewer's settings (quality preset, the director).
// `round` indexes `header.rounds` (0-based, as `Scene.setFrame` takes it).
// `status`, `error`, `progress` and `assetsMissing` are set by the view that loads the pack,
// with `setState`. While the director drives the POV camera, every change of the state
// (a seek, the clock's tick, a new round or pack) writes the director's pick into `follow`.
// A reel (`state/reel.ts`: a kill cam, or the highlights) plays its segments on the clock's
// writes and then leaves; a seek, a round step, a player, camera or director pick, the full
// radar or a new pack ends it where the user went, with their camera, director and speed back.

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  followLegs,
  isCameraMode,
  killersOf,
  legAt,
  type CameraMode,
  type FollowLeg,
} from '../sim/follow';
import {
  DEFAULT_QUALITY,
  autoQuality,
  isQuality,
  type Quality,
} from '../scene/quality';
import type { Pack, RoundInfo } from '../pack/types';
import { directorPlan, directorTargetAt } from '../sim/director';
import { autoKillcamAt, killcamSegment, lastDeath } from '../sim/killcam';
import type { Kill } from '../sim/timeline';
import { browserStorage, type PrefsStorage } from './storage';
import {
  enterSegment,
  leaveReel,
  nextSegment,
  stepReel,
  type Reel,
  type ReelSegment,
  type Resume,
} from './reel';

export type Speed = 0.25 | 0.5 | 1 | 2 | 4 | 8;
export const SPEEDS: readonly Speed[] = [0.25, 0.5, 1, 2, 4, 8];

/** `localStorage` key of the quality preset the viewer chose. */
export const QUALITY_KEY = 'demoviewer.quality';
/** `localStorage` key of the director toggle. */
export const DIRECTOR_KEY = 'demoviewer.director';

/**
 * Where the quality came from: the default, waiting for the first measurement to pick one;
 * picked from that measurement (this visit only); chosen by the viewer and saved; or the
 * device's (a phone or a mobile GPU: this visit only, never measured).
 */
export type QualityFrom = 'default' | 'detected' | 'chosen' | 'device';

export interface PlaybackState {
  pack: Pack | null;
  map: string | null;
  round: number;
  tick: number;
  playing: boolean;
  speed: Speed;
  camera: CameraMode;
  /** Index into `header.players`, or null. */
  follow: number | null;
  /**
   * Whether the user picked `follow` (the player list, a digit): POV then holds that player's
   * death view to the end of the round instead of cutting away. False when the camera or the
   * director chose.
   */
  followPinned: boolean;
  /**
   * The director ("Auto"): while on and the camera is POV, it picks `follow` from the round's
   * plan (`sim/director`), never pinned.
   */
  director: boolean;
  /** The full-screen radar in place of the 3D view (`R`); not saved, closed with no pack. */
  radar: boolean;
  /** The kill cam or highlights playing, or null. */
  reel: Reel | null;
  /** The highlights panel is open (`H`); closed with no pack and by a new one. */
  highlights: boolean;
  quality: Quality;
  qualityFrom: QualityFrom;
  assetsMissing: boolean;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  progress: { loaded: number; total: number | null };
}

export interface PlaybackActions {
  /** Starts a pack paused at the first round's freeze end; null unloads it. */
  setPack(pack: Pack | null): void;
  /** At the end of the last round, plays again from the first round's freeze end. */
  play(): void;
  pause(): void;
  toggle(): void;
  /** Ignores anything but one of `SPEEDS`. */
  setSpeed(speed: number): void;
  /** Clamps into the current round's `[start_tick, post_end_tick]`. */
  seekTick(tick: number): void;
  /** Clamps `r` to the pack's rounds and moves to that round's `freeze_end_tick`. */
  seekRound(r: number): void;
  /** Pauses on the next (+1) or previous (-1) sample of the round, from an off-grid tick too. */
  stepSample(dir: number): void;
  /**
   * Ignores anything but a camera mode. `pov` with nobody followed takes the first player;
   * `free` keeps who is followed. Closes the full radar.
   */
  setCamera(mode: CameraMode): void;
  /**
   * Follows player `i` (ignored past `header.players`) in whatever camera is on: POV switches
   * to them, Free stays where it is. `pinned` (the user's pick, the default) sets
   * `followPinned`; the director passes false. Null follows nobody. A pinned pick turns the
   * director off, saved unless `save` is false.
   */
  setFollow(i: number | null, pinned?: boolean, opts?: SaveOpts): void;
  /**
   * Turns the director on or off, saved unless `save` is false. Turning it on in Free switches
   * to POV, as the director only drives POV. A player picked by the user (a pinned
   * `setFollow`) turns it off.
   */
  setDirector(on: boolean, opts?: SaveOpts): void;
  /** Opens or closes the full-screen radar; stays closed without a pack. */
  setRadar(on: boolean): void;
  /**
   * Plays `segments` from the first (nothing without a pack or segments). After the last it
   * goes back to where it started (`'resume'`) or plays on from there (`'continue'`). Started
   * during another reel, it goes back to where that one started.
   */
  startReel(
    kind: Reel['kind'],
    segments: readonly ReelSegment[],
    atEnd: Reel['atEnd']
  ): void;
  /** Leaves the reel back where it started, with the camera from then. */
  endReel(): void;
  /** Skips to the reel's next segment; past the last, leaves as its end would. */
  nextInReel(): void;
  /**
   * Plays `kill`'s kill cam (a death in the current round), then goes back. Without `kill`,
   * the last death at or before the tick of the player the camera follows (the director's
   * pick while it drives), and nothing if there is none.
   */
  killcam(kill?: Kill): void;
  /** Opens or closes the highlights panel; stays closed without a pack. */
  setHighlights(on: boolean): void;
  /** The viewer's choice: applied and saved. Ignores anything but a preset. */
  setQuality(q: Quality): void;
  /**
   * The preset `autoQuality` picks for a frame rate measured at `medium`, taken only while
   * the quality is still the default (nothing saved, nothing chosen), and not saved.
   */
  detectQuality(fpsAtMedium: number): void;
  /**
   * The preset for the device the page runs on (`low` on a phone or a mobile GPU), taken
   * only while the quality is still the default, and not saved: nothing is measured then.
   */
  deviceQuality(q: Quality): void;
}

/**
 * Whether an action saves the viewer's director toggle (the default). Opening a link passes
 * `save: false`: it sets the director for this visit and leaves the saved choice alone, as a
 * reel does.
 */
export interface SaveOpts {
  save?: boolean;
}

export type Playback = PlaybackState & PlaybackActions;
export type PlaybackStore = StoreApi<Playback>;

function readDirector(storage: PrefsStorage): boolean {
  try {
    return storage?.getItem(DIRECTOR_KEY) === '1';
  } catch {
    return false;
  }
}

function readQuality(
  storage: PrefsStorage
): Pick<PlaybackState, 'quality' | 'qualityFrom'> {
  let saved: string | null = null;
  try {
    saved = storage?.getItem(QUALITY_KEY) ?? null;
  } catch {
    // Blocked storage: the default, detected again.
  }
  return isQuality(saved)
    ? { quality: saved, qualityFrom: 'chosen' }
    : { quality: DEFAULT_QUALITY, qualityFrom: 'default' };
}

/** The round being played, or null without a pack (or with a pack of no rounds). */
export function currentRound(
  s: Pick<PlaybackState, 'pack' | 'round'>
): RoundInfo | null {
  return s.pack?.header.rounds[s.round] ?? null;
}

/** `tick` clamped into `[start_tick, post_end_tick]`: the round and its after-round. */
export function clampTick(info: RoundInfo, tick: number): number {
  return Math.min(
    Math.max(tick, info.start_tick),
    Math.max(info.start_tick, info.post_end_tick)
  );
}

function playerCount(s: PlaybackState): number {
  return s.pack?.header.players.length ?? 0;
}

type DirectedState = Pick<
  PlaybackState,
  'pack' | 'round' | 'tick' | 'camera' | 'director' | 'follow' | 'followPinned'
>;

/**
 * Who the camera follows: the director's pick at the store's tick while it drives POV (never
 * pinned), else the store's `follow`.
 */
export function directedFollow(s: DirectedState): {
  follow: number | null;
  pinned: boolean;
} {
  if (s.director && s.camera === 'pov' && s.pack) {
    const i = directorTargetAt(directorPlan(s.pack, s.round), s.tick);
    if (i >= 0) return { follow: i, pinned: false };
  }
  return { follow: s.follow, pinned: s.followPinned };
}

/**
 * The death whose automatic kill cam (the setting "Kill cam after each death") the store's
 * change from `prev` to `s` starts: `autoKillcamAt` between their ticks for whoever the camera
 * follows, while playing in one round of one pack with no reel before or after the change, in
 * POV with the 3D view up. Free keeps its flying camera, and the full radar stays up (a reel
 * closes it, and going back would not open it again).
 * The reel before it matters: a kill cam that ends goes back to where it started, a write
 * that jumps forward across the same death and its hold again, playing, in the same round.
 */
export function autoKillcamDue(
  s: PlaybackState,
  prev: PlaybackState
): Kill | null {
  if (
    !s.pack ||
    s.pack !== prev.pack ||
    s.round !== prev.round ||
    !s.playing ||
    s.reel ||
    prev.reel ||
    s.camera !== 'pov' ||
    s.radar
  )
    return null;
  return autoKillcamAt(
    s.pack,
    s.round,
    directedFollow(s).follow,
    prev.tick,
    s.tick
  );
}

/**
 * From a subscription to `store`: starts the automatic kill cam that its change from `prev` to
 * `s` makes due (`autoKillcamDue`). It starts a microtask later, once the change has reached
 * every listener: started inside it, the listeners after this one would hear the reel start
 * twice, the second time against the state from before the change. By then, it starts only if
 * the store is still in that round of that pack with no reel.
 */
export function startAutoKillcam(
  store: PlaybackStore,
  s: PlaybackState,
  prev: PlaybackState
): void {
  const kill = autoKillcamDue(s, prev);
  if (!kill) return;
  queueMicrotask(() => {
    const now = store.getState();
    if (!now.reel && now.pack === s.pack && now.round === s.round)
      now.killcam(kill);
  });
}

/** The camera's legs per pack, by `round:follow:pinned`. */
const legsCache = new WeakMap<Pack, Map<string, FollowLeg[]>>();

/**
 * Who the camera shows at the store's tick: the player `directedFollow` names, or, after
 * their death and its death view, whoever the camera cut to (the killer if alive, else the
 * nearest living teammate) — the same legs the POV camera plays. The one answer to "the
 * followed player" for the player list, the radar and the HUD. Without a pack, or with nobody
 * alive in the round, it is `follow`.
 */
export function shownAt(s: DirectedState): number | null {
  const d = directedFollow(s);
  if (!s.pack) return d.follow;
  let byKey = legsCache.get(s.pack);
  if (!byKey) legsCache.set(s.pack, (byKey = new Map()));
  const key = `${s.round}:${d.follow}:${d.pinned ? 1 : 0}`;
  let legs = byKey.get(key);
  if (!legs) {
    legs = followLegs(
      s.pack,
      s.round,
      d.follow,
      d.pinned,
      killersOf(s.pack, s.round)
    );
    byKey.set(key, legs);
  }
  return legAt(legs, s.tick) ?? d.follow;
}

/** `patch`, plus the director's pick when it drives POV in the state it leads to. */
function withDirector<T extends Partial<PlaybackState>>(
  prev: PlaybackState,
  patch: T
): T {
  const next = { ...prev, ...patch };
  const d = directedFollow(next);
  if (d.follow === next.follow && d.pinned === next.followPinned) return patch;
  return { ...patch, follow: d.follow, followPinned: d.pinned };
}

const IDLE = {
  pack: null,
  map: null,
  round: 0,
  tick: 0,
  playing: false,
  status: 'idle',
  error: null,
  assetsMissing: false,
  radar: false,
  reel: null,
  highlights: false,
} satisfies Partial<PlaybackState>;

export function createPlaybackStore(
  opts: { storage?: PrefsStorage } = {}
): PlaybackStore {
  const storage = opts.storage === undefined ? browserStorage() : opts.storage;

  return createStore<Playback>()((rawSet, get, api) => {
    // Every write, from the actions and from outside (the clock's tick), goes through the
    // director, so `follow` is its pick at the tick being written.
    const set = (patch: Partial<Playback>) =>
      rawSet(withDirector(get(), patch));
    const saveDirector = (on: boolean) => {
      try {
        storage?.setItem(DIRECTOR_KEY, on ? '1' : '0');
      } catch {
        // Storage full or blocked: the toggle still works for this visit.
      }
    };
    const external = api.setState;
    api.setState = ((partial, replace) => {
      const patch = typeof partial === 'function' ? partial(get()) : partial;
      if (replace) {
        external(patch as Playback, true);
        return;
      }
      const prev = get();
      const directed = withDirector(prev, patch);
      // The clock's writes step a reel: past a segment's end, the next one, or leaving.
      // Leaving can give the camera back to the director, so it picks again.
      const step = stepReel({ ...prev, ...directed });
      external(step ? withDirector(prev, { ...directed, ...step }) : directed);
    }) as typeof api.setState;

    /**
     * The user going somewhere ends a reel there: the patch that leaves it (`'here'`), to go
     * first in the action's own, and the state the action then works from.
     */
    const leaving = (): [Partial<PlaybackState>, Playback] => {
      const s = get();
      if (!s.reel) return [{}, s];
      const left = leaveReel(s.reel, 'here');
      return [left, { ...s, ...left }];
    };

    /** Round `r` (clamped) at its freeze end, as a state patch; {} without rounds. */
    const roundStart = (pack: Pack, r: number): Partial<PlaybackState> => {
      const rounds = pack.header.rounds;
      if (rounds.length === 0) return { round: 0, tick: 0 };
      const round = Math.min(
        Math.max(Math.trunc(r) || 0, 0),
        rounds.length - 1
      );
      return {
        round,
        tick: clampTick(rounds[round], rounds[round].freeze_end_tick),
      };
    };

    return {
      ...IDLE,
      speed: 1,
      camera: 'pov',
      follow: null,
      followPinned: false,
      director: readDirector(storage),
      ...readQuality(storage),
      progress: { loaded: 0, total: null },

      setPack(pack) {
        const [left, s] = leaving();
        if (!pack) {
          set({ ...left, ...IDLE, follow: null, followPinned: false });
          return;
        }
        const players = pack.header.players.length;
        const keep = s.follow !== null && s.follow < players;
        set({
          ...left,
          ...roundStart(pack, 0),
          pack,
          map: pack.header.map,
          playing: false,
          status: 'ready',
          error: null,
          assetsMissing: false,
          radar: false,
          reel: null,
          highlights: false,
          // A followed player the pack does not have gives way to its first player.
          follow: keep ? s.follow : players > 0 ? 0 : null,
          followPinned: keep && s.followPinned,
        });
      },

      play() {
        const s = get();
        const info = currentRound(s);
        if (!s.pack || !info || s.playing) return;
        const rounds = s.pack.header.rounds;
        const atEnd =
          s.round === rounds.length - 1 && s.tick >= info.post_end_tick;
        set(
          atEnd
            ? { ...roundStart(s.pack, 0), playing: true }
            : { playing: true }
        );
      },

      pause() {
        if (get().playing) set({ playing: false });
      },

      toggle() {
        if (get().playing) get().pause();
        else get().play();
      },

      setSpeed(speed) {
        const valid = SPEEDS.find((v) => v === speed);
        if (valid !== undefined) set({ speed: valid });
      },

      seekTick(tick) {
        const [left, s] = leaving();
        const info = currentRound(s);
        if (info && Number.isFinite(tick))
          set({ ...left, tick: clampTick(info, tick) });
      },

      seekRound(r) {
        const [left, s] = leaving();
        if (s.pack && Number.isFinite(r))
          set({ ...left, ...roundStart(s.pack, r) });
      },

      stepSample(dir) {
        const [left, s] = leaving();
        const info = currentRound(s);
        if (!s.pack || !info || dir === 0 || !Number.isFinite(dir)) return;
        const step = s.pack.header.tick_step;
        const pos = (s.tick - info.start_tick) / step;
        // A tick within float noise of a sample counts as on it.
        const EPS = 1e-6;
        let k = dir > 0 ? Math.floor(pos + EPS) + 1 : Math.ceil(pos - EPS) - 1;
        k = Math.min(Math.max(k, 0), Math.max(0, info.samples - 1));
        set({
          ...left,
          tick: clampTick(info, info.start_tick + k * step),
          playing: false,
        });
      },

      setCamera(mode) {
        if (!isCameraMode(mode)) return;
        const [left, s] = leaving();
        // Picking a camera is asking for the 3D view.
        if (mode === 'pov' && s.follow === null && playerCount(s) > 0)
          set({
            ...left,
            camera: mode,
            follow: 0,
            followPinned: false,
            radar: false,
          });
        else set({ ...left, camera: mode, radar: false });
      },

      setRadar(on) {
        const radar = on && get().pack !== null;
        // Closing it (a reel has it closed already) leaves a reel playing.
        const [left] = radar ? leaving() : [{}];
        set({ ...left, radar });
      },

      setFollow(i, pinned = true, opts) {
        if (
          i !== null &&
          (!Number.isInteger(i) || i < 0 || i >= playerCount(get()))
        )
          return;
        const [left, s] = leaving();
        if (i === null) {
          set({ ...left, follow: null, followPinned: false });
          return;
        }
        if (pinned && s.director) {
          // The user's pick takes the camera back from the director.
          if (opts?.save !== false) saveDirector(false);
          set({ ...left, follow: i, followPinned: true, director: false });
        } else set({ ...left, follow: i, followPinned: pinned });
      },

      setDirector(on, opts) {
        const [left, s] = leaving();
        const toPov = on && s.camera !== 'pov' && playerCount(s) > 0;
        set(
          toPov
            ? { ...left, director: on, camera: 'pov' }
            : { ...left, director: on }
        );
        if (opts?.save !== false) saveDirector(on);
      },

      startReel(kind, segments, atEnd) {
        const s = get();
        if (!s.pack || segments.length === 0) return;
        // A reel never saves the director: it is the user's toggle, given back on leaving.
        const resume: Resume = s.reel?.resume ?? {
          round: s.round,
          tick: s.tick,
          camera: s.camera,
          follow: s.follow,
          followPinned: s.followPinned,
          director: s.director,
          playing: s.playing,
          speed: s.speed,
        };
        set({
          ...enterSegment(segments[0]),
          reel: { kind, segments, index: 0, resume, atEnd },
        });
      },

      endReel() {
        const reel = get().reel;
        if (reel) set(leaveReel(reel, 'resume'));
      },

      nextInReel() {
        const reel = get().reel;
        if (reel) set(nextSegment(reel));
      },

      killcam(kill) {
        const s = get();
        if (!s.pack || !currentRound(s)) return;
        let k = kill ?? null;
        if (!k) {
          const { follow } = directedFollow(s);
          if (follow !== null) k = lastDeath(s.pack, s.round, follow, s.tick);
        }
        if (k)
          get().startReel(
            'killcam',
            [killcamSegment(s.pack, s.round, k)],
            'resume'
          );
      },

      setHighlights(on) {
        set({ highlights: on && get().pack !== null });
      },

      setQuality(q) {
        if (!isQuality(q)) return;
        set({ quality: q, qualityFrom: 'chosen' });
        try {
          storage?.setItem(QUALITY_KEY, q);
        } catch {
          // Storage full or blocked: the choice still holds for this visit.
        }
      },

      detectQuality(fpsAtMedium) {
        if (get().qualityFrom !== 'default') return;
        set({ quality: autoQuality(fpsAtMedium), qualityFrom: 'detected' });
      },

      deviceQuality(q) {
        if (get().qualityFrom !== 'default' || !isQuality(q)) return;
        set({ quality: q, qualityFrom: 'device' });
      },
    };
  });
}

/** The app's one store. */
export const playbackStore = createPlaybackStore();

/** React hook over `playbackStore`: `usePlayback((s) => s.tick)`. */
export function usePlayback<T>(selector: (s: Playback) => T): T {
  return useStore(playbackStore, selector);
}
