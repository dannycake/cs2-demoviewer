// The sound director: plays a round's cues as the playback clock advances. An advance at up to
// `SOUND_MAX_SPEED` plays the one-shot cues it crossed (`from < tick ≤ to`), once each, and a
// cue never waits: one whose key the manifest lacks or whose bank is not decoded yet is skipped.
// A seek, a pause, a faster speed or the mute plays nothing and stops what is playing. A burning
// fire's loop is state: it sounds while playing at up to 2× and its span holds the tick.
// Nothing is fetched before the first gesture (`unlock`) or while muted; then the manifest, and
// each bank a round's cues name once that round is shown, or, while playing, once the clock is
// within `PREFETCH_S` of the round before it ending. Banks load as soon as a gesture made the
// audio context, but cues play only while it runs: one crossed while it waits for a gesture the
// browser counts (a finger's press made it suspended) is skipped, never played late. The
// listener is the scene's camera drawn last, else the eye of the player the camera shows
// (`shownAt`), else where it last was.

import type { StoreApi } from 'zustand/vanilla';
import type { Pack } from '../pack/types';
import { crossed, loopsAt, roundCues, type Cue } from '../sim/sounds';
import type { ClockPosition } from '../state/clock';
import type { SettingsState } from '../state/settings';
import { shownAt, type Playback, type PlaybackStore } from '../state/store';
import type { SoundBanks } from './banks';
import { originListener, type ListenerPose, type SoundEngine } from './engine';
import { eyeListener } from './listener';
import type { SoundEntry, SoundManifest } from './manifest';
import { stepSetOf } from './surfaces';

/** The fastest speed that sounds (my call): at 4× and 8× the replay is silent. */
export const SOUND_MAX_SPEED = 2;

/**
 * Seconds before a round's `post_end_tick` (playing) that the next round's cues are made, off the
 * frame, so its banks are in by the crossing.
 */
export const PREFETCH_S = 10;

/** Runs `task` once the page is idle (within a second), or soon where there is no idle callback. */
function whenIdle(task: () => void): void {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => task(), { timeout: 1000 });
  else setTimeout(task, 0);
}

export interface SoundDirectorDeps {
  store: PlaybackStore;
  settings: StoreApi<SettingsState>;
  engine: SoundEngine;
  banks: SoundBanks;
  /** The scene's listener (`Scene.listener`): false with no camera drawn or the view hidden. */
  listener: (out: ListenerPose) => boolean;
  /** The surface under a Source point, as the hull names it (`Scene.surfaceBelow`). */
  surfaceAt: (x: number, y: number, z: number) => string | null;
  /** Changes whenever `surfaceAt` may answer otherwise (`Scene.hullVersion`). */
  surfaceVersion: () => number;
  /** Runs work off the frame (the next round's cues); `requestIdleCallback` by default. */
  idle?: (task: () => void) => void;
}

/** What the director has done, live (`window.__demoviewer.sound`). */
export interface SoundDebug {
  /** Whether the audio context runs: a gesture made it and the browser let it start. */
  readonly unlocked: boolean;
  /** Cues the engine started. */
  readonly played: number;
  /**
   * Cues crossed whose key the manifest lacks or whose bank was not decoded yet, or while the
   * audio context did not run.
   */
  readonly skipped: number;
  /** Sounds and loops playing. */
  readonly voices: number;
  /** The banks decoded, in the order they came in. */
  readonly banks: readonly string[];
}

/** Where the clock was left, in which pack. */
interface Position extends ClockPosition {
  pack: Pack | null;
}

export class SoundDirector {
  readonly debug: SoundDebug;
  private readonly store: PlaybackStore;
  private readonly settings: StoreApi<SettingsState>;
  private readonly engine: SoundEngine;
  private readonly banks: SoundBanks;
  private readonly listener: (out: ListenerPose) => boolean;
  private readonly surfaceAt: SoundDirectorDeps['surfaceAt'];
  private readonly surfaceVersion: () => number;
  private readonly idle: (task: () => void) => void;
  /** The manifest: undefined until it comes in, null when it failed (silent for good). */
  private manifest: SoundManifest | null | undefined = undefined;
  private manifestAsked = false;
  private playedCount = 0;
  private skippedCount = 0;
  /** Each round's cues, made for `cuesPack` on the surfaces of `cuesVersion`. */
  private readonly cues = new Map<number, Cue[]>();
  private cuesPack: Pack | null = null;
  private cuesVersion = Number.NaN;
  /**
   * Where the last advance took the clock, or where the last frame found it (once `placed`): an
   * advance from anywhere else, or a frame elsewhere, means a seek came between.
   */
  private readonly at: Position = { pack: null, round: 0, tick: 0 };
  private placed = false;
  /** The round whose cues wait for an idle moment, or null. */
  private prefetching: number | null = null;
  /** Whether the last frame found the clock playing. */
  private playing = false;
  private muted: boolean;
  private readonly pose: ListenerPose = originListener();
  private readonly crossedCues: Cue[] = [];
  private readonly loopCues: Cue[] = [];
  private readonly loopIds = new Set<string>();
  private readonly unsubscribe: () => void;
  private disposed = false;

  constructor(deps: SoundDirectorDeps) {
    this.store = deps.store;
    this.settings = deps.settings;
    this.engine = deps.engine;
    this.banks = deps.banks;
    this.listener = deps.listener;
    this.surfaceAt = deps.surfaceAt;
    this.surfaceVersion = deps.surfaceVersion;
    this.idle = deps.idle ?? whenIdle;
    this.muted = deps.settings.getState().settings.muted;
    const live = (get: () => unknown) => ({ get, enumerable: true });
    this.debug = Object.defineProperties({} as SoundDebug, {
      unlocked: live(() => this.engine.unlocked),
      played: live(() => this.playedCount),
      skipped: live(() => this.skippedCount),
      voices: live(() => this.engine.voices),
      banks: live(() => this.banks.loaded),
    });
    this.applySettings();
    this.unsubscribe = deps.settings.subscribe(() => this.applySettings());
  }

  /**
   * From a user gesture (`GESTURES`): makes the audio context, or resumes it while it does not
   * run; unless muted, fetches the manifest (once), then the shown round's banks. Once it runs,
   * a gesture has nothing to do.
   */
  unlock(): void {
    if (this.disposed || this.engine.unlocked) return;
    this.engine.unlock();
    this.load();
  }

  /**
   * The clock's advance (`startLoop`'s `onAdvance`; a property, so it can be handed over as it
   * is). From anywhere but where the clock was left, a seek came first: everything stops. At up
   * to `SOUND_MAX_SPEED`, plays the one-shots crossed in `from`'s round up to `to`, or to its
   * `post_end_tick` and on from each next round's `start_tick − 1` when the advance crossed
   * rounds; faster, stops everything and plays nothing. In a round's last `PREFETCH_S`, the
   * next round's cues are asked for off the frame.
   */
  readonly onAdvance = (
    from: ClockPosition,
    to: ClockPosition,
    speed: number
  ): void => {
    if (this.disposed) return;
    const pack = this.store.getState().pack;
    const at = this.at;
    const sought =
      this.placed &&
      (at.pack !== pack || at.round !== from.round || at.tick !== from.tick);
    this.place(pack, to.round, to.tick);
    const fast = !(speed <= SOUND_MAX_SPEED);
    if (sought || fast) this.engine.stopAll();
    const m = this.ready();
    if (fast || !m || !pack) return;
    const rounds = pack.header.rounds;
    if (to.round < from.round || !rounds[from.round] || !rounds[to.round])
      return;
    for (let r = from.round; r <= to.round; r++) {
      const lo = r === from.round ? from.tick : rounds[r].start_tick - 1;
      const hi = r === to.round ? to.tick : rounds[r].post_end_tick;
      for (const cue of crossed(
        this.cuesFor(m, pack, r),
        lo,
        hi,
        this.crossedCues
      ))
        this.play(m, cue);
    }
    this.prefetch(pack, to);
  };

  /**
   * Once per drawn frame, after the scene's: stops everything when the clock is not where the
   * last advance left it (a seek while paused, a reel's jump) or stopped playing; moves the
   * listener; keeps the loops burning at the tick while playing at up to 2×, and none
   * otherwise; and makes the shown round's cues, so its banks load before it plays.
   */
  frame(): void {
    if (this.disposed) return;
    const s = this.store.getState();
    const at = this.at;
    const moved =
      at.pack !== s.pack || at.round !== s.round || at.tick !== s.tick;
    if ((moved && this.placed) || (this.playing && !s.playing))
      this.engine.stopAll();
    this.place(s.pack, s.round, s.tick);
    this.playing = s.playing;
    if (this.listener(this.pose) || this.trackListener(s))
      this.engine.setListener(this.pose);
    const m = this.ready();
    if (!m || !s.pack) return;
    const cues = this.cuesFor(m, s.pack, s.round);
    this.loopIds.clear();
    if (s.playing && s.speed <= SOUND_MAX_SPEED)
      for (const cue of loopsAt(cues, s.tick, this.loopCues)) {
        const sound = this.soundOf(m, cue);
        if (!sound) continue;
        const id = `${s.round}:${cue.tick}:${cue.seed}`;
        this.engine.setLoop(id, sound.entry, sound.buffer, cue.at);
        this.loopIds.add(id);
      }
    this.engine.keepLoops(this.loopIds);
  }

  /** Stops everything and lets go of the settings; the director does nothing after. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.engine.stopAll();
  }

  /** Where the clock is left (kept in one record, not one per frame). */
  private place(pack: Pack | null, round: number, tick: number): void {
    this.at.pack = pack;
    this.at.round = round;
    this.at.tick = tick;
    this.placed = true;
  }

  /**
   * Within `PREFETCH_S` of the end of `at`'s round, with a round after it whose cues are not
   * made: makes them (and so asks for their banks) once, off the frame, if sound may still play
   * and the pack is still the store's by then.
   */
  private prefetch(pack: Pack, at: ClockPosition): void {
    const rounds = pack.header.rounds;
    const next = at.round + 1;
    if (!rounds[next]) return;
    const end = rounds[at.round].post_end_tick;
    if (at.tick < end - PREFETCH_S * pack.header.tick_rate) return;
    if (this.prefetching === next || this.made(pack, next)) return;
    this.prefetching = next;
    this.idle(() => {
      this.prefetching = null;
      const m = this.ready();
      if (m && this.store.getState().pack === pack) this.cuesFor(m, pack, next);
    });
  }

  /** Whether `round`'s cues are made for `pack` on the surfaces there are now. */
  private made(pack: Pack, round: number): boolean {
    return (
      pack === this.cuesPack &&
      this.surfaceVersion() === this.cuesVersion &&
      this.cues.has(round)
    );
  }

  /** The volume and the mute: muting stops everything, unmuting loads what is missing. */
  private applySettings(): void {
    const { volume, muted } = this.settings.getState().settings;
    const muting = muted && !this.muted;
    this.muted = muted;
    this.engine.setVolume(volume, muted);
    if (muting) this.engine.stopAll();
    this.load();
  }

  /**
   * With the context made (running or not) and not muted: the manifest (asked for once), then
   * the shown round's banks.
   */
  private load(): void {
    if (this.disposed || this.muted || !this.engine.canDecode) return;
    if (!this.manifestAsked) {
      this.manifestAsked = true;
      void this.banks.manifest().then((m) => {
        this.manifest = m;
        this.load();
      });
      return;
    }
    const m = this.ready();
    const s = this.store.getState();
    if (m && s.pack) this.cuesFor(m, s.pack, s.round);
  }

  /** The manifest, while sound may load: the context made, not muted, the manifest in. */
  private ready(): SoundManifest | null {
    return !this.disposed && !this.muted && this.engine.canDecode
      ? (this.manifest ?? null)
      : null;
  }

  /**
   * `round`'s cues, made the first time it is asked for (and again when the pack or the
   * surfaces change), and then every bank they name asked for.
   */
  private cuesFor(m: SoundManifest, pack: Pack, round: number): Cue[] {
    const version = this.surfaceVersion();
    if (pack !== this.cuesPack || version !== this.cuesVersion) {
      this.cues.clear();
      this.cuesPack = pack;
      this.cuesVersion = version;
    }
    let cues = this.cues.get(round);
    if (cues) return cues;
    cues = roundCues(pack, round, (x, y, z) =>
      stepSetOf(m, this.surfaceAt(x, y, z))
    );
    this.cues.set(round, cues);
    const banks = new Set<string>();
    for (const cue of cues) {
      const entry = entryOf(m, cue.key);
      if (entry) banks.add(entry.bank);
    }
    for (const bank of banks) this.banks.ensure(bank);
    return cues;
  }

  /**
   * Plays `cue` now, or counts it skipped: its key is not in the manifest, its bank not in, or
   * the context does not run.
   */
  private play(m: SoundManifest, cue: Cue): void {
    const sound = this.soundOf(m, cue);
    if (!sound || !this.engine.unlocked) {
      this.skippedCount++;
      return;
    }
    if (this.engine.play(sound.entry, sound.buffer, cue.at, cue.seed))
      this.playedCount++;
  }

  private soundOf(
    m: SoundManifest,
    cue: Cue
  ): { entry: SoundEntry; buffer: AudioBuffer } | null {
    const entry = entryOf(m, cue.key);
    const buffer = entry ? this.banks.get(entry.bank) : null;
    return entry && buffer ? { entry, buffer } : null;
  }

  /** The eye of the player the camera shows, from the track, into the pose. */
  private trackListener(s: Playback): boolean {
    if (!s.pack) return false;
    const player = shownAt(s);
    return (
      player !== null && eyeListener(s.pack, s.round, s.tick, player, this.pose)
    );
  }
}

function entryOf(m: SoundManifest, key: string): SoundEntry | undefined {
  return Object.hasOwn(m.sounds, key) ? m.sounds[key] : undefined;
}
