// The Web Audio engine: plays a sound's layers where the sound is, heard from the listener.
// Each layer is a slice of its bank (`start(now, offset, duration)`) at the layer's pitch, into a
// gain of the layer's volume times CS2's distance curve, into an HRTF panner at the sound (the
// panner only places it: its own distance model does nothing), into the master gain (volume and
// mute) and a compressor against clipping. At most `MAX_VOICES` sound at once, the quietest
// dropped first. Loops (a burning fire) are state, set each frame and kept by id. No context
// exists until `unlock`, called from a user gesture (browsers require one), and nothing starts
// while it does not run: a press a browser does not count (a finger's `pointerdown`, Esc) makes
// it suspended, and the next gesture resumes it.

import { messageOf } from '../errors';
import { toScene, UNIT, type Vector3Like } from '../geo/coords';
import type { Quality } from '../scene/quality';
import {
  curveGain,
  pickClip,
  seeded,
  type SoundEntry,
  type SoundLayer,
  type Vec3,
} from './manifest';

/** The listener: scene metres, and its forward and up unit vectors. */
export interface ListenerPose {
  x: number;
  y: number;
  z: number;
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
}

/** A new listener at the origin, facing −z with +y up: Web Audio's own default. */
export function originListener(): ListenerPose {
  return { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: -1, ux: 0, uy: 1, uz: 0 };
}

// The subset of Web Audio the engine uses: a real `AudioContext` is one, and a test's fake.

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface SourceLike extends AudioNodeLike {
  buffer: AudioBuffer | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: AudioParamLike;
  onended: ((ev: Event) => unknown) | null;
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
}

export interface PannerLike extends AudioNodeLike {
  panningModel: PanningModelType;
  distanceModel: DistanceModelType;
  rolloffFactor: number;
  readonly positionX: AudioParamLike;
  readonly positionY: AudioParamLike;
  readonly positionZ: AudioParamLike;
}

export interface CompressorLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

/** Firefox has only `setPosition`/`setOrientation`; the others have the params too. */
export interface ListenerLike {
  readonly positionX?: AudioParamLike;
  readonly positionY?: AudioParamLike;
  readonly positionZ?: AudioParamLike;
  readonly forwardX?: AudioParamLike;
  readonly forwardY?: AudioParamLike;
  readonly forwardZ?: AudioParamLike;
  readonly upX?: AudioParamLike;
  readonly upY?: AudioParamLike;
  readonly upZ?: AudioParamLike;
  setPosition(x: number, y: number, z: number): void;
  setOrientation(
    fx: number,
    fy: number,
    fz: number,
    ux: number,
    uy: number,
    uz: number
  ): void;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly state: string;
  readonly destination: AudioNodeLike;
  readonly listener: ListenerLike;
  resume(): Promise<void>;
  createGain(): GainLike;
  createBufferSource(): SourceLike;
  createPanner(): PannerLike;
  createDynamicsCompressor(): CompressorLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  close(): Promise<void>;
}

/**
 * The events that unlock the sound: HTML's activation-triggering input events, the only ones a
 * browser lets start audio. A finger's `pointerdown` is not one (its `pointerup`, `touchend` and
 * `click` are), nor is Esc's `keydown`; the mouse's `pointerdown` is.
 */
export const GESTURES = [
  'pointerdown',
  'pointerup',
  'touchend',
  'click',
  'keydown',
] as const;

/**
 * Calls `unlock` on each of `GESTURES` at `target` (in the capture phase: before anything stops
 * it); returns what takes the listeners off.
 */
export function listenForGestures(
  target: EventTarget,
  unlock: () => void
): () => void {
  for (const type of GESTURES) target.addEventListener(type, unlock, true);
  return () => {
    for (const type of GESTURES) target.removeEventListener(type, unlock, true);
  };
}

/**
 * The sample rate on the `low` preset (phones): the banks decode to half the memory they take at
 * 48 kHz (a typical Mirage match's ~92 MB to ~46 MB), for the sound above 12 kHz.
 */
export const LOW_SAMPLE_RATE = 24000;

/** What makes an `AudioContext`: the browser's, or a test's. */
export type ContextMaker = new (
  options?: AudioContextOptions
) => AudioContextLike;

/**
 * A context for the quality preset `quality`: at `LOW_SAMPLE_RATE` on `low`, else at the
 * device's own rate, as also where the browser refuses that rate (its constructor throws).
 */
export function contextFor(
  quality: Quality,
  Context: ContextMaker = AudioContext
): AudioContextLike {
  if (quality === 'low')
    try {
      return new Context({ sampleRate: LOW_SAMPLE_RATE });
    } catch {
      // Not a rate this browser runs at: its own.
    }
  return new Context();
}

/** Voices (a sound with all its layers, or a loop) sounding at once at most. */
export const MAX_VOICES = 32;
/** A layer quieter than this is not started; a sound with every layer under it is not played. */
export const MIN_GAIN = 0.005;
/** Seconds a stopped voice takes to fade out. */
export const FADE_S = 0.05;

/**
 * The master's limiter (my call): it leaves the mix alone under −6 dBFS and holds stacked shots
 * (the banks peak near +3 dBFS) from clipping. Chromium's defaults (−24 dB, knee 30) would lift
 * quiet sounds by ~12 dB of make-up gain and flatten the distances.
 */
const COMPRESSOR = {
  threshold: -6,
  knee: 6,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
} as const;
/** Seconds the master gain and a loop's gain take to settle on a new value. */
const SETTLE_S = 0.02;

/** One layer as it plays: its nodes, its gain now, and what that gain is made of. */
interface Playing {
  def: SoundLayer;
  /** The layer's volume with its spread drawn. */
  volume: number;
  /** The gain now: `volume` × the curve at the distance. */
  level: number;
  source: SourceLike;
  gain: GainLike;
}

/** A sound (or loop) as it plays; `level` is its loudest layer's gain. */
interface Voice {
  layers: Playing[];
  level: number;
  at: Vec3 | null;
  /** Its layers still playing. */
  live: number;
}

/** A layer's draws for one play: the clip, the volume and the pitch. */
interface Drawn {
  clip: [number, number];
  volume: number;
  rate: number;
}

export class SoundEngine {
  private readonly create: () => AudioContextLike;
  private ctx: AudioContextLike | null = null;
  private master: GainLike | null = null;
  private failed = false;
  private closed = false;
  private volume = 1;
  private muted = false;
  /** The master gain last asked for, so the same setting schedules nothing. */
  private masterTarget = Number.NaN;
  private readonly pose: ListenerPose = originListener();
  /** One-shot sounds, oldest first. */
  private readonly sounding = new Set<Voice>();
  private readonly loops = new Map<string, Voice>();
  private readonly scratch: Vector3Like = { x: 0, y: 0, z: 0 };

  constructor(create: () => AudioContextLike = () => new AudioContext()) {
    this.create = create;
  }

  /** Whether sound plays: a gesture made the context and it runs. */
  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Whether banks decode: a gesture made the context (running or not yet). */
  get canDecode(): boolean {
    return this.ctx !== null;
  }

  /** Sounds and loops playing (a voice fading out after a stop no longer counts). */
  get voices(): number {
    return this.sounding.size + this.loops.size;
  }

  /**
   * From a user gesture: the first makes the context and its master chain; each later one
   * resumes the context while it does not run (a press the browser did not count, or something
   * suspended it). Without Web Audio: one warning, silent.
   */
  unlock(): void {
    if (this.ctx) {
      this.resume();
      return;
    }
    if (this.failed || this.closed) return;
    let ctx: AudioContextLike;
    try {
      ctx = this.create();
    } catch (e) {
      this.failed = true;
      console.warn(`sounds: no Web Audio (${messageOf(e)}); playing silent`);
      return;
    }
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = COMPRESSOR.threshold;
    compressor.knee.value = COMPRESSOR.knee;
    compressor.ratio.value = COMPRESSOR.ratio;
    compressor.attack.value = COMPRESSOR.attack;
    compressor.release.value = COMPRESSOR.release;
    compressor.connect(ctx.destination);
    const master = ctx.createGain();
    master.connect(compressor);
    this.ctx = ctx;
    this.master = master;
    this.applyVolume();
    this.applyListener();
    this.resume();
  }

  /**
   * Lets go of the context for good (the view that made the engine is gone): stops everything
   * and closes it. Nothing plays after, and no gesture makes another context.
   */
  close(): void {
    this.closed = true;
    const ctx = this.ctx;
    if (!ctx) return;
    this.stopAll();
    this.ctx = null;
    this.master = null;
    ctx.close().catch(() => {
      // Closed already: nothing to do.
    });
  }

  /** Decodes a bank (once a gesture made the context: decoding needs it, running or not). */
  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    if (!this.ctx)
      return Promise.reject(
        new Error(
          this.closed
            ? 'sound is closed'
            : 'sound is locked until a click or key'
        )
      );
    return this.ctx.decodeAudioData(data);
  }

  /** The master gain: `volume` (0–1), or 0 when muted. */
  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  /** Moves the listener, and re-weighs each loop's layers by its new distance. */
  setListener(p: ListenerPose): void {
    Object.assign(this.pose, p);
    const ctx = this.ctx;
    if (!ctx) return;
    this.applyListener();
    for (const loop of this.loops.values()) {
      loop.level = 0;
      for (const l of loop.layers) {
        l.level = this.layerLevel(l.def, l.volume, loop.at);
        l.gain.gain.setTargetAtTime(l.level, ctx.currentTime, SETTLE_S);
        loop.level = Math.max(loop.level, l.level);
      }
    }
  }

  /**
   * Plays `entry` once at `at` (Source units; null: heard the same everywhere), its clips and
   * spreads drawn from `seed`. False, with nothing started (no node made), while the context
   * does not run (before `unlock`, suspended, interrupted), when every layer is under
   * `MIN_GAIN` at the listener, or when `MAX_VOICES` louder voices are playing; a full cap
   * otherwise fades its quietest voice out. Nothing waits for the context to run.
   */
  play(
    entry: SoundEntry,
    buffer: AudioBuffer,
    at: Vec3 | null,
    seed: number
  ): boolean {
    if (!this.unlocked) return false;
    const drawn = entry.layers.map((l, i) => draw(l, i, seed));
    const levels = entry.layers.map((l, i) =>
      this.layerLevel(l, drawn[i].volume, at)
    );
    const level = Math.max(0, ...levels);
    if (!(level >= MIN_GAIN) || !this.admit(level)) return false;
    const voice: Voice = { layers: [], level, at, live: 0 };
    entry.layers.forEach((l, i) => {
      if (levels[i] >= MIN_GAIN)
        this.startLayer(voice, l, drawn[i], levels[i], buffer, false);
    });
    this.sounding.add(voice);
    return true;
  }

  /**
   * Keeps the loop `id` sounding: started the first time (its `loop` layers looping their clip,
   * the others once), left as it is after; not started while the context does not run, while
   * every layer is under `MIN_GAIN` or while the cap is full of louder voices (a later call
   * tries again).
   */
  setLoop(
    id: string,
    entry: SoundEntry,
    buffer: AudioBuffer,
    at: Vec3 | null
  ): void {
    if (!this.unlocked || this.loops.has(id)) return;
    const seed = hashId(id);
    const drawn = entry.layers.map((l, i) => draw(l, i, seed));
    const levels = entry.layers.map((l, i) =>
      this.layerLevel(l, drawn[i].volume, at)
    );
    const level = Math.max(0, ...levels);
    if (!(level >= MIN_GAIN) || !this.admit(level)) return;
    const voice: Voice = { layers: [], level, at, live: 0 };
    // Every layer, even one silent now: the listener may come nearer.
    entry.layers.forEach((l, i) =>
      this.startLayer(voice, l, drawn[i], levels[i], buffer, true)
    );
    this.loops.set(id, voice);
  }

  /** Fades out every loop whose id is not in `ids`. */
  keepLoops(ids: ReadonlySet<string>): void {
    for (const [id, loop] of this.loops)
      if (!ids.has(id)) {
        this.fade(loop);
        this.loops.delete(id);
      }
  }

  /** Fades out every sound and loop. */
  stopAll(): void {
    for (const v of this.sounding) this.fade(v);
    for (const v of this.loops.values()) this.fade(v);
    this.sounding.clear();
    this.loops.clear();
  }

  /**
   * Room for a voice of `level`: true under the cap; at the cap, fades out the quietest voice
   * (the oldest of equals) if it is quieter, else false.
   */
  private admit(level: number): boolean {
    if (this.voices < MAX_VOICES) return true;
    let quietest: Voice | null = null;
    for (const v of this.sounding)
      if (!quietest || v.level < quietest.level) quietest = v;
    let loopId: string | null = null;
    for (const [id, v] of this.loops)
      if (!quietest || v.level < quietest.level) {
        quietest = v;
        loopId = id;
      }
    if (!quietest || quietest.level >= level) return false;
    this.fade(quietest);
    if (loopId !== null) this.loops.delete(loopId);
    else this.sounding.delete(quietest);
    return true;
  }

  private startLayer(
    voice: Voice,
    def: SoundLayer,
    d: Drawn,
    level: number,
    buffer: AudioBuffer,
    looping: boolean
  ): void {
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = d.rate;
    const gain = ctx.createGain();
    gain.gain.value = level;
    source.connect(gain);
    let panner: PannerLike | null = null;
    if (voice.at) {
      panner = ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;
      const p = this.layerPoint(def, voice.at);
      panner.positionX.value = p.x;
      panner.positionY.value = p.y;
      panner.positionZ.value = p.z;
      gain.connect(panner);
      panner.connect(this.master!);
    } else gain.connect(this.master!);
    const playing: Playing = { def, volume: d.volume, level, source, gain };
    const [offset, duration] = d.clip;
    if (looping && def.loop) {
      source.loop = true;
      source.loopStart = offset;
      source.loopEnd = offset + duration;
      source.start(now, offset);
    } else source.start(now, offset, duration);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
      if (--voice.live === 0) this.sounding.delete(voice);
    };
    voice.layers.push(playing);
    voice.live++;
  }

  /** Ramps each of `voice`'s layers to silence over `FADE_S` and stops it there. */
  private fade(voice: Voice): void {
    const now = this.ctx!.currentTime;
    for (const l of voice.layers) {
      const g = l.gain.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(l.level, now);
      g.linearRampToValueAtTime(0, now + FADE_S);
      l.source.stop(now + FADE_S);
    }
  }

  /** `def`'s gain at the listener: `volume` × its curve at the distance (no position: NaN). */
  private layerLevel(def: SoundLayer, volume: number, at: Vec3 | null): number {
    let units = Number.NaN;
    if (at) {
      const p = this.layerPoint(def, at);
      const q = this.pose;
      units = Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) / UNIT;
    }
    return volume * curveGain(def.curve, units);
  }

  /** Where `def` sounds for a sound at `at`, in scene metres (shared scratch). */
  private layerPoint(def: SoundLayer, at: Vec3): Vector3Like {
    const [ox, oy, oz] = def.offset;
    return toScene(at.x + ox, at.y + oy, at.z + oz, this.scratch);
  }

  private applyVolume(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    const target = this.muted ? 0 : Math.min(1, Math.max(0, this.volume || 0));
    if (target === this.masterTarget) return;
    // The first setting (at unlock) is there at once; later ones glide, so a mute does not click.
    if (Number.isNaN(this.masterTarget)) this.master.gain.value = target;
    else this.master.gain.setTargetAtTime(target, ctx.currentTime, SETTLE_S);
    this.masterTarget = target;
  }

  private applyListener(): void {
    const l = this.ctx!.listener;
    const p = this.pose;
    if (l.positionX && l.positionY && l.positionZ) {
      l.positionX.value = p.x;
      l.positionY.value = p.y;
      l.positionZ.value = p.z;
    } else l.setPosition(p.x, p.y, p.z);
    if (l.forwardX && l.forwardY && l.forwardZ && l.upX && l.upY && l.upZ) {
      l.forwardX.value = p.fx;
      l.forwardY.value = p.fy;
      l.forwardZ.value = p.fz;
      l.upX.value = p.ux;
      l.upY.value = p.uy;
      l.upZ.value = p.uz;
    } else l.setOrientation(p.fx, p.fy, p.fz, p.ux, p.uy, p.uz);
  }

  private resume(): void {
    const ctx = this.ctx;
    if (ctx && ctx.state !== 'running')
      ctx.resume().catch(() => {
        // A closed context stays silent; nothing to do.
      });
  }
}

/**
 * Layer `i`'s clip (draw 0 of `seed`, `pickClip`), volume (draw 1 + 2i) and pitch (draw 2 + 2i):
 * the spreads drawn apart from the clip and from the other layers'. A volume under 0 is 0, a
 * pitch under 0.01 is 0.01 (a source cannot play backwards or stand still).
 */
function draw(l: SoundLayer, i: number, seed: number): Drawn {
  const [v0, v1] = l.volumeRandom;
  const [p0, p1] = l.pitchRandom;
  return {
    clip: pickClip(l, seed),
    volume: Math.max(0, l.volume + v0 + (v1 - v0) * seeded(seed, 1 + 2 * i)),
    rate: Math.max(0.01, l.pitch + p0 + (p1 - p0) * seeded(seed, 2 + 2 * i)),
  };
}

/** A loop's seed: FNV-1a over its id. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++)
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h >>> 0;
}
