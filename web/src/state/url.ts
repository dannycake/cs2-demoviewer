// The URL state of the viewer: `?r=<round>&t=<tick>&cam=<camera>`, with `p=<player>` for POV
// and Free, and in a shared link `at=<x,y,z,yaw,pitch>` for Free (`router.ts`). Read when a
// demo opens (`readUrlState`, `applyUrlState`), and written back as the clock, the camera and
// the followed player move, at most once a second (`writeUrlState`).

import { parseRoute, type FreePose, type UrlCamera } from '../router';
import { shownAt, type PlaybackState, type PlaybackStore } from './store';

/**
 * The moment a URL asks for: `round` as an index into `header.rounds`, the camera (`auto` is
 * POV driven by the director), `player` as an index into `header.players`, and Free's pose.
 */
export interface UrlState {
  round?: number;
  tick?: number;
  camera?: UrlCamera;
  /** 0-based. */
  player?: number;
  at?: FreePose;
}

/**
 * Reads the moment of a viewer URL (`/d/<id>`). `r` and `p` are 1-based (`?r=1` is the first
 * round, `?p=1` the player the key `1` follows) and come back as 0-based indices; each invalid
 * part is dropped on its own.
 */
export function readUrlState(url: URL): UrlState {
  const route = parseRoute(url);
  if (route.view !== 'demo') return {};
  const out: UrlState = {};
  if (route.round !== undefined && route.round >= 1)
    out.round = route.round - 1;
  if (route.tick !== undefined) out.tick = route.tick;
  if (route.cam !== undefined) out.camera = route.cam;
  if (route.p !== undefined) out.player = route.p - 1;
  if (route.at !== undefined) out.at = route.at;
  return out;
}

/**
 * Moves the store to a URL state, paused: the round (at its freeze end), then the tick within
 * it (clamped into the round), then the camera, then the player. `auto` turns the director on;
 * POV and Free follow `player`, pinned, when given (one past the pack's players is
 * ignored and the camera still applies), as does the camera there is when the URL names none;
 * Free's pose is the viewport's to place (`Scene.setFreePose`). A player with `auto`, which a
 * shared link never has, is left out. The director it turns on or off is for this visit: the
 * viewer's saved Auto setting stays as it was.
 */
export function applyUrlState(store: PlaybackStore, state: UrlState): void {
  const s = () => store.getState();
  const visit = { save: false };
  s().pause();
  if (state.round !== undefined) s().seekRound(state.round);
  if (state.tick !== undefined) s().seekTick(state.tick);
  const cam = state.camera;
  if (cam === 'auto') s().setDirector(true, visit);
  else if (cam !== undefined) s().setCamera(cam);
  if (state.player !== undefined && cam !== 'auto')
    s().setFollow(state.player, true, visit);
}

/** The camera a URL names for the store's state: `auto` while the director drives POV. */
export function urlCamera(
  s: Pick<PlaybackState, 'camera' | 'director'>
): UrlCamera {
  return s.director && s.camera === 'pov' ? 'auto' : s.camera;
}

/**
 * The 1-based player a URL names (`p`), without the director: the player on screen in POV,
 * as selected in Free. That is the followed player when pinned; unpinned, whoever the camera
 * cut to after their death (`shownAt`), as the link opens pinned on its player.
 */
export function urlPlayer(
  s: Pick<
    PlaybackState,
    | 'pack'
    | 'round'
    | 'tick'
    | 'camera'
    | 'director'
    | 'follow'
    | 'followPinned'
  >
): number | undefined {
  if (urlCamera(s) === 'auto') return undefined;
  const p = s.followPinned ? s.follow : shownAt(s);
  return p !== null ? p + 1 : undefined;
}

/** The parts of `window` that `writeUrlState` uses. */
export interface UrlTarget {
  location: { href: string };
  history: {
    state: unknown;
    replaceState(
      data: unknown,
      unused: string,
      url?: string | URL | null
    ): void;
  };
}

/** Minimum time between two URL writes. */
export const URL_WRITE_MS = 1000;

const throttles = new WeakMap<
  PlaybackStore,
  { last: number; timer: ReturnType<typeof setTimeout> | null }
>();

function writeNow(store: PlaybackStore, target: UrlTarget): void {
  const s = store.getState();
  if (!s.pack) return;
  const url = new URL(target.location.href);
  const q = url.searchParams;
  q.set('r', String(s.round + 1));
  q.set('t', String(Math.round(s.tick)));
  q.set('cam', urlCamera(s));
  const p = urlPlayer(s);
  if (p !== undefined) q.set('p', String(p));
  else q.delete('p');
  // A shared pose is the moment it was shared at: the view moves on from it.
  q.delete('at');
  const href = url.toString();
  if (href !== target.location.href)
    target.history.replaceState(target.history.state, '', href);
}

/**
 * Writes the store's round (1-based), tick (rounded), camera (`urlCamera`) and player
 * (`urlPlayer`, when there is one) into the URL with `replaceState`, dropping any `at` and
 * keeping the other parameters, at most once per `URL_WRITE_MS`: a call inside that window
 * schedules one trailing write at its end, with the position at that time, so the URL always
 * catches up.
 */
export function writeUrlState(
  store: PlaybackStore,
  target: UrlTarget | undefined = typeof window !== 'undefined'
    ? window
    : undefined
): void {
  if (!target) return;
  let t = throttles.get(store);
  if (!t) {
    t = { last: -Infinity, timer: null };
    throttles.set(store, t);
  }
  if (t.timer !== null) return;
  const now = Date.now();
  const wait = t.last + URL_WRITE_MS - now;
  if (wait <= 0) {
    t.last = now;
    writeNow(store, target);
    return;
  }
  const state = t;
  state.timer = setTimeout(() => {
    state.timer = null;
    state.last = Date.now();
    writeNow(store, target);
  }, wait);
}
