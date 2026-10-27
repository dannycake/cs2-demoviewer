// The sounds manifest (`/sounds/manifest.json`, tools/build-sounds.mjs) as the browser reads it:
// each bank's file by its hash, each sound as the layers CS2's soundevent plays (clips cut from
// one bank, a volume and pitch with their random spread, a gain by distance), and which step
// set each surface walks with. Also what playing a layer needs before any audio exists: its gain
// at a distance and the clip a seed picks.

import { SeededRandom } from '../sim/random';

/** A point in Source units. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One layer of a sound: one of its clips, played at once with the sound's other layers. */
export interface SoundLayer {
  /** `[start, duration]` in seconds into the bank, one per variant. */
  clips: [number, number][];
  volume: number;
  /** Added to `volume`, between the two. */
  volumeRandom: [number, number];
  pitch: number;
  /** Added to `pitch`, between the two. */
  pitchRandom: [number, number];
  /** `[units, gain]` points by distance (`curveGain`), or null for the same gain everywhere. */
  curve: [number, number][] | null;
  /** Source units from the sound's origin (a shot at `[0, 0, 60]`, the gun's height). */
  offset: [number, number, number];
  loop: boolean;
}

export interface SoundEntry {
  /** The bank its clips are cut from (`SoundManifest.banks`). */
  bank: string;
  layers: SoundLayer[];
}

export interface SoundManifest {
  banks: Record<string, { sha256: string; bytes: number; seconds: number }>;
  /** By key: `shot:ak47`, `step:concrete:ct`, `bomb:beep`... */
  sounds: Record<string, SoundEntry>;
  /** A surface as the hull names it (`surfaceOfNode`) → its step set (`stepSetOf`). */
  surfaces: Record<string, string>;
}

/**
 * The manifest in `raw` (parsed JSON), or null when it has no `banks` or `sounds`. Keeps each
 * sound whose bank it lists and that has a clip, each layer that has one; what a layer leaves
 * out or gets wrong takes the plain value (volume and pitch 1, no spread, no curve, no offset).
 */
export function parseSoundManifest(raw: unknown): SoundManifest | null {
  if (!isRecord(raw) || !isRecord(raw.banks) || !isRecord(raw.sounds))
    return null;
  const banks: SoundManifest['banks'] = {};
  for (const [name, b] of Object.entries(raw.banks))
    if (isRecord(b) && typeof b.sha256 === 'string')
      banks[name] = {
        sha256: b.sha256,
        bytes: num(b.bytes, 0),
        seconds: num(b.seconds, 0),
      };
  const sounds: SoundManifest['sounds'] = {};
  for (const [key, s] of Object.entries(raw.sounds)) {
    if (
      !isRecord(s) ||
      typeof s.bank !== 'string' ||
      !Object.hasOwn(banks, s.bank)
    )
      continue;
    const layers = (Array.isArray(s.layers) ? s.layers : [])
      .map(parseLayer)
      .filter((l): l is SoundLayer => l !== null);
    if (layers.length > 0) sounds[key] = { bank: s.bank, layers };
  }
  const surfaces: SoundManifest['surfaces'] = {};
  if (isRecord(raw.surfaces))
    for (const [name, set] of Object.entries(raw.surfaces))
      if (typeof set === 'string') surfaces[name] = set;
  return { banks, sounds, surfaces };
}

/**
 * The gain of `curve` at `units` from the listener: linear between its points, the first's
 * gain before the first (and for a NaN distance) and the last's past the last; 1 without a
 * curve.
 */
export function curveGain(
  curve: readonly (readonly [number, number])[] | null,
  units: number
): number {
  if (!curve || curve.length === 0) return 1;
  // Not past the first point, or no distance at all (NaN).
  if (!(units > curve[0][0])) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [u1, g1] = curve[i];
    if (units > u1) continue;
    const [u0, g0] = curve[i - 1];
    return u1 === u0 ? g1 : g0 + ((units - u0) / (u1 - u0)) * (g1 - g0);
  }
  return curve[curve.length - 1][1];
}

/** `seeded`'s generator, reseeded each call, so a draw makes nothing. */
const random = new SeededRandom();

/**
 * Draw `i` of `seed`, in [0, 1): mulberry32's first number for `seed + i`. A sound's seed fixes
 * its clip (draw 0, `pickClip`) and its other choices, so a cue sounds the same each time.
 */
export function seeded(seed: number, i: number): number {
  return random.reset(seed + i).next();
}

/** The clip of `layer` that `seed` plays (draw 0 of the seed). */
export function pickClip(layer: SoundLayer, seed: number): [number, number] {
  return layer.clips[Math.floor(seeded(seed, 0) * layer.clips.length)];
}

function parseLayer(raw: unknown): SoundLayer | null {
  if (!isRecord(raw) || !Array.isArray(raw.clips)) return null;
  const clips = raw.clips.filter(isPair);
  if (clips.length === 0) return null;
  const curve = Array.isArray(raw.curve) ? raw.curve.filter(isPair) : null;
  return {
    clips,
    volume: num(raw.volume, 1),
    volumeRandom: isPair(raw.volumeRandom) ? raw.volumeRandom : [0, 0],
    pitch: num(raw.pitch, 1),
    pitchRandom: isPair(raw.pitchRandom) ? raw.pitchRandom : [0, 0],
    curve: curve && curve.length > 0 ? curve : null,
    offset: isTriple(raw.offset) ? raw.offset : [0, 0, 0],
    loop: raw.loop === true,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function isFiniteArray(v: unknown, n: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === n &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

function isPair(v: unknown): v is [number, number] {
  return isFiniteArray(v, 2);
}

function isTriple(v: unknown): v is [number, number, number] {
  return isFiniteArray(v, 3);
}
