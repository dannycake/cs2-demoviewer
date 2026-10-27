// The viewer's display settings: grenade labels and trails, damage numbers, the minimap, the
// outlines through walls, the names over heads, the kill cam after each death, the round
// summary, the HUD's scale, and the sound's volume and mute. Remembered per browser under `demoviewer.settings`; storage
// that is blocked or holds something unreadable just leaves the defaults.

import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { browserStorage, type PrefsStorage } from './storage';

export interface Settings {
  labels: boolean;
  trails: boolean;
  damageNumbers: boolean;
  /** Multiplies the HUD's size: 0.8 to 1.4. */
  hudScale: number;
  /** The radar in the top-left corner over the 3D view. */
  minimap: boolean;
  /** Team outlines around the players, and their silhouettes through walls (`X`). */
  xray: boolean;
  /** Each living player's name and health over their head. */
  nameTags: boolean;
  /** A kill cam after each death of the followed player, once the camera has held on it. */
  autoKillcam: boolean;
  /** The panel at the end of each round: winner, MVP, damage and the next round's buys. */
  roundSummary: boolean;
  /** The sound's volume, 0 to 1. */
  volume: number;
  /** No sound at all: nothing under `/sounds/` is fetched while muted. */
  muted: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  labels: true,
  trails: true,
  damageNumbers: true,
  hudScale: 1,
  minimap: true,
  xray: true,
  nameTags: true,
  autoKillcam: false,
  roundSummary: true,
  volume: 0.6,
  muted: false,
};

export const SETTINGS_KEY = 'demoviewer.settings';
export const HUD_SCALE = { min: 0.8, max: 1.4 } as const;

export interface SettingsState {
  settings: Settings;
  set(patch: Partial<Settings>): void;
}

function clean(raw: unknown): Settings {
  const o =
    typeof raw === 'object' && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const flag = (
    k:
      | 'labels'
      | 'trails'
      | 'damageNumbers'
      | 'minimap'
      | 'xray'
      | 'nameTags'
      | 'autoKillcam'
      | 'roundSummary'
      | 'muted'
  ) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_SETTINGS[k]);
  const scale =
    typeof o.hudScale === 'number' && Number.isFinite(o.hudScale)
      ? o.hudScale
      : 1;
  const volume =
    typeof o.volume === 'number' && Number.isFinite(o.volume)
      ? o.volume
      : DEFAULT_SETTINGS.volume;
  return {
    labels: flag('labels'),
    trails: flag('trails'),
    damageNumbers: flag('damageNumbers'),
    minimap: flag('minimap'),
    xray: flag('xray'),
    nameTags: flag('nameTags'),
    autoKillcam: flag('autoKillcam'),
    roundSummary: flag('roundSummary'),
    hudScale: Math.min(HUD_SCALE.max, Math.max(HUD_SCALE.min, scale)),
    volume: Math.min(1, Math.max(0, volume)),
    muted: flag('muted'),
  };
}

function read(storage: PrefsStorage): Settings {
  try {
    const text = storage?.getItem(SETTINGS_KEY);
    return text ? clean(JSON.parse(text)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function createSettingsStore(
  storage: PrefsStorage = browserStorage()
): StoreApi<SettingsState> {
  return createStore<SettingsState>()((set, get) => ({
    settings: read(storage),
    set(patch) {
      const settings = clean({ ...get().settings, ...patch });
      set({ settings });
      try {
        storage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // Blocked storage: the change holds for this page only.
      }
    },
  }));
}

export const settingsStore = createSettingsStore();

export function useSettings<T>(select: (s: SettingsState) => T): T {
  return useStore(settingsStore, select);
}
