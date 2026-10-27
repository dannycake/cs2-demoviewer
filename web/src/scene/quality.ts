// The three quality presets and the rule that picks one from a measured frame rate. `low` is
// phase 3's unlit scene; `medium` lights it, with shadows, smooth normals, anisotropic
// filtering, the map's sky and fog, and the detail texture; `high` adds a sharper shadow and
// the post stack. A map with CS2's bake (baked.ts) draws its world lit by it at every preset,
// `low` included, and tone-mapped at every preset; its players are lit by the bake's light
// grid at every preset too (probes.ts), and at `low` nothing draws a shadow but a sun drawn at
// runtime beside the bake (de_cache's, `LIVE_SUN_LOW_SHADOWS`). `low` (what phones get) loads
// the phone tier of the world and the players, with smaller textures, where the assets have it;
// a `low` measured on a desktop keeps the files it was measured with. `Scene.setQuality` applies
// a preset and swaps the world and the players for its tier; the store keeps the viewer's
// choice.

import type { ShadowSize } from './lighting';

export type Quality = 'low' | 'medium' | 'high';

/** In the order the `Q` key cycles them. */
export const QUALITIES: readonly Quality[] = ['low', 'medium', 'high'];

export const DEFAULT_QUALITY: Quality = 'medium';

export interface Preset {
  /**
   * Lambert materials lit by the sun and sky, tone-mapped (Neutral, at the map's exposure); off,
   * unlit and untouched. A baked world is lit by its bake either way, and tone-mapped.
   */
  lit: boolean;
  /**
   * The sun's shadow map side in texels; 0 casts none. Over a baked world with a sun, two maps of
   * this side: the world's, drawn once, which the players take, and the players', every frame,
   * which darkens the baked light, or de_cache's live sun on the world, too (lighting.ts); a bake
   * without a sun has none.
   */
  shadows: ShadowSize;
  /** The post stack (AO, bloom, vignette, SMAA); ignored where the device cannot run it. */
  post: boolean;
  /** The highest device pixel ratio drawn at. */
  dpr: number;
  /** Normals computed for the world's geometry, so it shades smoothly when lit. */
  smoothNormals: boolean;
  /** The tiling detail texture on the world's opaque surfaces. */
  detail: boolean;
  /** Anisotropic texture filtering, up to the device's and the look's cap. */
  aniso: boolean;
  /** The map's sky colour and fog; off, the dark background of phase 3 and no fog. */
  atmosphere: boolean;
  /**
   * The phone tier of the world and the players (`world_lo.glb`, `players/<side>_lo.glb`: the
   * same models, their textures within 128 and 512 px) where the assets have it, today's files
   * where they do not. Off, today's files. A preset measured on the device rather than chosen
   * keeps the tier it was measured at (`Scene.setQuality`).
   */
  phoneTier: boolean;
}

/**
 * The sun's shadow map at `low` on a map whose sun is drawn at runtime beside its bake (de_cache,
 * `sun.baked` false): there the sun is light.json's at the bake's scale (π × 1.9, about 6.0),
 * the world's only sun, and with no shadow map it would light every interior. Only such maps pay
 * for it; `low` is shadowless elsewhere. Split as at the other presets: the world's map is drawn
 * once, the players' (this side too) every frame.
 */
export const LIVE_SUN_LOW_SHADOWS: ShadowSize = 1024;

export const PRESETS: Readonly<Record<Quality, Readonly<Preset>>> = {
  low: {
    lit: false,
    shadows: 0,
    post: false,
    dpr: 1,
    smoothNormals: false,
    detail: false,
    aniso: false,
    atmosphere: false,
    phoneTier: true,
  },
  medium: {
    lit: true,
    shadows: 2048,
    post: false,
    dpr: 1.5,
    smoothNormals: true,
    detail: true,
    aniso: true,
    atmosphere: true,
    phoneTier: false,
  },
  high: {
    lit: true,
    shadows: 4096,
    post: true,
    dpr: 1.5,
    smoothNormals: true,
    detail: true,
    aniso: true,
    atmosphere: true,
    phoneTier: false,
  },
};

/** Frame rate at `medium` from which `high` is chosen. */
export const AUTO_HIGH_FPS = 100;
/** Frame rate at `medium` under which `low` is chosen. */
export const AUTO_LOW_FPS = 40;

/** The preset for a device that draws `medium` at `fpsAtMedium`; NaN keeps the default. */
export function autoQuality(fpsAtMedium: number): Quality {
  if (fpsAtMedium >= AUTO_HIGH_FPS) return 'high';
  if (fpsAtMedium < AUTO_LOW_FPS) return 'low';
  return DEFAULT_QUALITY;
}

/** The preset after `q`: low → medium → high → low. */
export function nextQuality(q: Quality): Quality {
  return QUALITIES[(QUALITIES.indexOf(q) + 1) % QUALITIES.length];
}

export function isQuality(v: unknown): v is Quality {
  return (QUALITIES as readonly unknown[]).includes(v);
}
