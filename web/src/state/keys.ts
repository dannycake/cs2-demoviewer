// The keyboard map. Keys match the physical key (`code`) first, so digits work on AZERTY and
// the map follows the key positions a CS2 player knows; a key whose `code` is not in the map
// falls back to the character it typed (`key`). Shortcuts with Ctrl, Alt or Meta are left to
// the browser, and a key typed into a text field, or Space on a control the keyboard focused,
// to that field or control (`state/focus`). In the free camera, `W A S D Q E` belong to the fly
// camera (the viewport reads them).
// Escape is used only to close the highlights or leave a reel: otherwise it is left to the
// panels that close on it themselves (the settings, the player sheet, the Share field, the
// scoreboard). One Escape does one thing: those panels listen first (capture) and spend the
// Escape that closes them (`useDismiss`, `escapeCloses` in `state/dismiss`), and the key map
// leaves a spent one alone.

import type { StoreApi } from 'zustand/vanilla';
import type { CameraMode } from '../sim/follow';
import { nextQuality } from '../scene/quality';
import { FLY_KEYS } from './fly-keys';
import { isPressable, isTextEntry } from './focus';
import { settingsStore, type SettingsState } from './settings';
import type { PlaybackStore } from './store';

export type KeyAction =
  | { kind: 'toggle' }
  | { kind: 'round'; dir: 1 | -1 }
  | { kind: 'step'; dir: 1 | -1 }
  | { kind: 'follow'; index: number }
  | { kind: 'camera'; mode: CameraMode }
  | { kind: 'director' }
  | { kind: 'radar' }
  | { kind: 'quality' }
  | { kind: 'xray' }
  | { kind: 'killcam' }
  | { kind: 'next' }
  | { kind: 'highlights' }
  | { kind: 'escape' };

const BY_CODE: Record<string, KeyAction> = {
  Space: { kind: 'toggle' },
  ArrowLeft: { kind: 'round', dir: -1 },
  ArrowRight: { kind: 'round', dir: 1 },
  Comma: { kind: 'step', dir: -1 },
  Period: { kind: 'step', dir: 1 },
  KeyV: { kind: 'camera', mode: 'pov' },
  KeyC: { kind: 'camera', mode: 'free' },
  KeyA: { kind: 'director' },
  KeyR: { kind: 'radar' },
  KeyQ: { kind: 'quality' },
  KeyX: { kind: 'xray' },
  KeyK: { kind: 'killcam' },
  KeyN: { kind: 'next' },
  KeyH: { kind: 'highlights' },
  Escape: { kind: 'escape' },
};

const BY_KEY: Record<string, KeyAction> = {
  ' ': BY_CODE.Space,
  ArrowLeft: BY_CODE.ArrowLeft,
  ArrowRight: BY_CODE.ArrowRight,
  ',': BY_CODE.Comma,
  '.': BY_CODE.Period,
  v: BY_CODE.KeyV,
  V: BY_CODE.KeyV,
  c: BY_CODE.KeyC,
  C: BY_CODE.KeyC,
  a: BY_CODE.KeyA,
  A: BY_CODE.KeyA,
  r: BY_CODE.KeyR,
  R: BY_CODE.KeyR,
  q: BY_CODE.KeyQ,
  Q: BY_CODE.KeyQ,
  x: BY_CODE.KeyX,
  X: BY_CODE.KeyX,
  k: BY_CODE.KeyK,
  K: BY_CODE.KeyK,
  n: BY_CODE.KeyN,
  N: BY_CODE.KeyN,
  h: BY_CODE.KeyH,
  H: BY_CODE.KeyH,
  Escape: BY_CODE.Escape,
};

// `1`..`9`, `0` follow players 1..10 (indices 0..9).
for (let d = 0; d <= 9; d++) {
  const action: KeyAction = { kind: 'follow', index: d === 0 ? 9 : d - 1 };
  BY_CODE[`Digit${d}`] = action;
  BY_KEY[String(d)] = action;
}

export interface KeyInput {
  key: string;
  code: string;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  /** Where the key was typed: a text field keeps its keys. */
  target?: EventTarget | null;
  /** A panel already closed on this Escape (`escapeCloses`). */
  defaultPrevented?: boolean;
}

/** The action a key maps to, or null (unmapped, or with Ctrl, Alt or Meta). */
export function keyAction(e: KeyInput): KeyAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  return BY_CODE[e.code] ?? BY_KEY[e.key] ?? null;
}

/**
 * Applies the key map (Space play/pause, `←`/`→` round, `,`/`.` one sample and pause,
 * `1`–`0` follow, `V` POV, `C` Free, `A` the director on or off, `R` the full
 * radar, `Q` the next quality preset, `X` the outlines through walls in `settings`, `K` the
 * followed player's kill cam, `H` the highlights panel, `N` the next segment of a reel,
 * `Escape` the highlights closed, else the reel left) and returns whether the key was used, so
 * the caller can `preventDefault`.
 * A digit past the pack's players, or a playback key, `A`, `R`, `K` or `H` before a pack is
 * loaded, is not used; nor `N` without a reel, nor `Escape` with neither the highlights nor a
 * reel up, or one a panel closed on (`escapeCloses`); nor, in Free, is any of the fly
 * camera's keys (`A` among them); nor a key typed into a text field, nor Space on a checkbox,
 * radio or button the keyboard focused (`isPressable`). A held toggle key acts once; `←`/`→`
 * and `,`/`.` repeat.
 */
export function handleKey(
  e: KeyInput,
  store: PlaybackStore,
  settings: StoreApi<SettingsState> = settingsStore
): boolean {
  const action = keyAction(e);
  if (!action || isTextEntry(e.target ?? null)) return false;
  // Space presses a checkbox or button the keyboard focused (Enter, unmapped, reaches it
  // anyway).
  if (action.kind === 'toggle' && isPressable(e.target ?? null)) return false;
  const s = store.getState();
  if (s.camera === 'free' && FLY_KEYS.has(e.code)) return false;
  const rounds = s.pack?.header.rounds.length ?? 0;
  switch (action.kind) {
    case 'toggle':
      if (!s.pack) return false;
      // A held Space would flicker between play and pause.
      if (!e.repeat) s.toggle();
      return true;
    case 'round': {
      if (rounds === 0) return false;
      const r = s.round + action.dir;
      if (r >= 0 && r < rounds) s.seekRound(r);
      else if (r < 0) s.seekRound(0); // `←` on the first round restarts it
      return true;
    }
    case 'step':
      if (rounds === 0) return false;
      s.stepSample(action.dir);
      return true;
    case 'follow': {
      const players = s.pack?.header.players.length ?? 0;
      if (action.index >= players) return false;
      s.setFollow(action.index);
      return true;
    }
    case 'camera':
      s.setCamera(action.mode);
      return true;
    case 'director':
      if (!s.pack) return false;
      // A held A would flicker the director on and off.
      if (!e.repeat) s.setDirector(!s.director);
      return true;
    case 'radar':
      if (!s.pack) return false;
      // A held R would flicker between the radar and the 3D view.
      if (!e.repeat) s.setRadar(!s.radar);
      return true;
    case 'quality':
      // A held Q would race through the presets, recompiling at each.
      if (!e.repeat) s.setQuality(nextQuality(s.quality));
      return true;
    case 'xray': {
      // A held X would flicker the outlines.
      if (e.repeat) return true;
      const { settings: now, set } = settings.getState();
      set({ xray: !now.xray });
      return true;
    }
    case 'killcam':
      if (!s.pack) return false;
      // A held K would restart the kill cam.
      if (!e.repeat) s.killcam();
      return true;
    case 'next':
      if (!s.reel) return false;
      // A held N would race through the segments.
      if (!e.repeat) s.nextInReel();
      return true;
    case 'highlights':
      if (!s.pack) return false;
      // A held H would flicker the panel.
      if (!e.repeat) s.setHighlights(!s.highlights);
      return true;
    case 'escape':
      if (e.defaultPrevented || (!s.highlights && !s.reel)) return false;
      // A held Escape that closed the panel would leave the reel too.
      if (e.repeat) return true;
      if (s.highlights) s.setHighlights(false);
      else s.endReel();
      return true;
  }
}
