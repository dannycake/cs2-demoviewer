// The map's sky and fog, a part of the scene (Scene.ts): the background (the map's sky.webp once
// it has loaded, its horizon colour until then, the dark without a map or at a preset that draws
// no sky), the distance fog in the sky's colour (closing in to a smoke's inside it in POV), and
// the tone mapping's exposure and the bloom's threshold, which the map's atmosphere and its bake
// set and the sky is held to. The scene tells it the map's sky, its atmosphere and the preset.

import * as THREE from 'three';
import type { MapManifest } from '../api/assets';
import { DEFAULT_ATMOSPHERE, type Atmosphere } from './atmosphere';
import { loadSky } from './loaders';
import {
  BAKED_BLOOM_WHITE,
  BLOOM_THRESHOLD,
  SkyBehindNeutral,
  behindNeutral,
  inSmokeFog,
  skyWhite,
  type PostStack,
} from './post';

/** The background while no map is loaded, and under a preset without the map's sky: the page's black. */
const BACKGROUND = 0x000000;
/** Fog distances that put the fog out of reach. */
const NO_FOG = 1e8;
/** The fog of a view from inside a smoke, in metres. */
const SMOKE_FOG = { near: 0.4, far: 3.5 };

/**
 * The current map's sky.webp: its URL, its horizon colour from the manifest (the fog's, and
 * the background's until the texture draws), and how far its one load got. `failed` keeps
 * the colour sky for the map without asking again.
 */
interface SkySource {
  map: string;
  url: string;
  horizon: string | null;
  state: 'idle' | 'loading' | 'ready' | 'failed';
  texture: THREE.Texture | null;
}

/** The manifest's sky horizon colour when it is a `#rrggbb`, else null. */
export function horizonOf(manifest: MapManifest | null): string | null {
  const h = manifest?.sky?.horizon;
  return typeof h === 'string' && /^#[0-9a-f]{6}$/i.test(h) ? h : null;
}

export class SkyAndFog {
  /** Called when the map's sky texture has arrived and is the background, so the scene draws. */
  onLoad: (() => void) | null = null;
  /** Always set, so a map change never recompiles the shaders: out of reach without a map. */
  readonly fog = new THREE.Fog(BACKGROUND, NO_FOG, 2 * NO_FOG);
  /** The background whenever the map's sky texture is not drawn: the sky colour, or the dark. */
  readonly skyColor = new THREE.Color(BACKGROUND);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly post: PostStack;
  /** The map's sky.webp, loaded on the first preset that shows it; null for a map without one. */
  private sky: SkySource | null = null;
  /** The sky texture as the post stack holds it (`SkyBehindNeutral`), made when `high` draws it. */
  private skyBehind: SkyBehindNeutral | null = null;
  private atmosphere: Readonly<Atmosphere> | null = null;
  /** Whether the world is drawn with the map's bake, which has its own exposure. */
  private baked = false;
  /** Whether the preset draws the map's sky and fog (`Preset.atmosphere`). */
  private shows: boolean;

  /**
   * The dark empty scene's sky and fog in `scene`, drawn by `renderer` through `post` when it is
   * on; `shows`: whether the preset draws the map's sky and fog.
   */
  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    post: PostStack,
    shows: boolean
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.post = post;
    this.shows = shows;
    renderer.toneMappingExposure = DEFAULT_ATMOSPHERE.exposure;
    scene.background = this.skyColor;
    scene.fog = this.fog;
  }

  /**
   * The preset changed: whether it draws the map's sky and fog (`shows`), and whether the post
   * stack tone-maps the sky (`PostStack.enabled`, already set), which the sky depends on.
   */
  setPreset(shows: boolean): void {
    this.shows = shows;
    this.paintSky();
  }

  /**
   * The map's atmosphere (null for none: the dark empty scene) and whether its world is drawn
   * with its bake: the exposure and the bloom's threshold, the sky and the fog follow.
   */
  setAtmosphere(a: Readonly<Atmosphere> | null, baked: boolean): void {
    this.atmosphere = a;
    this.baked = baked;
    this.applyExposure();
    this.paintSky();
  }

  /**
   * The tone mapping's exposure, and the bloom's threshold with it: on a baked world, what is
   * BAKED_BLOOM_WHITE times the exposure's white, with the effects blooming by their own light
   * beside it (they never pass that threshold); else BLOOM_THRESHOLD as before the bake, which
   * the effects pass as they always did.
   */
  private applyExposure(): void {
    this.renderer.toneMappingExposure = this.exposure;
    this.post.setBloomThreshold(this.bloomThreshold);
    this.post.setEffectsBloom(this.baked);
  }

  /**
   * The bloom's threshold in force: a baked world's BAKED_BLOOM_WHITE / exposure, else
   * BLOOM_THRESHOLD.
   */
  private get bloomThreshold(): number {
    return this.baked ? BAKED_BLOOM_WHITE / this.exposure : BLOOM_THRESHOLD;
  }

  /**
   * The tone mapping's exposure: the map's (for its bake when the world is drawn with one), or
   * the default's without a map.
   */
  private get exposure(): number {
    const a = this.atmosphere ?? DEFAULT_ATMOSPHERE;
    return this.baked ? a.bakedExposure : a.exposure;
  }

  /** The map's sky and fog when the preset shows them, or the dark background. */
  private shownAtmosphere(): Readonly<Atmosphere> | null {
    return this.shows ? this.atmosphere : null;
  }

  /**
   * The background and the fog colour. Where the preset shows the map's sky, the background is
   * the map's sky texture once it has loaded (the first call that wants it starts the load),
   * else the sky colour: the sky's horizon colour (from the manifest), which is also the fog's
   * and the colour sky.webp has below the horizon, or the atmosphere's for a map without
   * one; without, the dark. Drawn straight to the canvas, the colours and the (sRGB) texture
   * show untouched; through the post stack they are tone-mapped with the rest of the frame,
   * so the scene holds what the tone mapping turns back into them, held to the same white as
   * the texture (`skyWhite`, under the bloom's threshold in force). What the preset does not
   * draw is freed from the GPU: the post
   * stack's copy off `high`, and at `low` the texture's upload too (its image is kept, so a
   * later preset uploads it again without asking the server).
   */
  private paintSky(): void {
    const a = this.shownAtmosphere();
    // By the preset, not by `a`: a world swap clears the atmosphere for a moment.
    const shows = this.shows;
    if (!shows || !this.post.enabled) this.freeSkyBehind();
    if (!shows) this.sky?.texture?.dispose();
    const sky = new THREE.Color(a ? (this.sky?.horizon ?? a.sky) : BACKGROUND);
    if (this.post.enabled)
      sky.copy(
        behindNeutral(
          sky,
          this.exposure,
          skyWhite(this.exposure, this.bloomThreshold)
        )
      );
    this.skyColor.copy(sky);
    this.fog.color.copy(sky);
    const texture = a ? this.skyTexture(a) : null;
    this.scene.background = texture ?? this.skyColor;
    // The post stack's copy has the intensity in it.
    this.scene.backgroundIntensity =
      texture && a && !this.post.enabled ? a.skyIntensity : 1;
  }

  /**
   * The map's sky texture as the current preset draws it, or null while there is none to draw:
   * a map without one, one still loading (asked for here the first time), or one that failed.
   */
  private skyTexture(a: Readonly<Atmosphere>): THREE.Texture | null {
    const src = this.sky;
    if (!src) return null;
    if (src.state === 'idle') this.fetchSky(src);
    if (!src.texture) return null;
    if (!this.post.enabled) return src.texture;
    const b = this.skyBehind;
    if (
      !b ||
      b.source !== src.texture ||
      b.exposure !== this.exposure ||
      b.intensity !== a.skyIntensity ||
      b.threshold !== this.bloomThreshold
    ) {
      b?.dispose();
      this.skyBehind = new SkyBehindNeutral(
        this.renderer,
        src.texture,
        this.exposure,
        a.skyIntensity,
        this.bloomThreshold
      );
      // The copy is all `high` draws: free the source's upload (its image stays).
      src.texture.dispose();
    }
    return this.skyBehind!.texture;
  }

  /**
   * Loads `src`'s sky.webp once; a sky that arrives after it was replaced (the scene disposed
   * included) is freed.
   */
  private fetchSky(src: SkySource): void {
    src.state = 'loading';
    loadSky(src.url).then(
      (texture) => {
        if (this.sky !== src) {
          texture.dispose();
          return;
        }
        src.texture = texture;
        src.state = 'ready';
        this.paintSky();
        this.onLoad?.();
      },
      (e: unknown) => {
        if (this.sky !== src) return;
        src.state = 'failed';
        // TextureLoader rejects with the image's error event, which says nothing.
        const why =
          e instanceof Error ? e.message : `could not load ${src.url}`;
        console.warn(
          `${src.map}: no sky texture (${why}); the sky stays a flat colour`
        );
      }
    );
  }

  /**
   * The map whose sky is `url` (null for a map without sky.webp, or none) with its `horizon`
   * colour, freeing the sky it replaces; nothing is fetched until a preset shows it.
   */
  setSky(map: string | null, url: string | null, horizon: string | null): void {
    const s = this.sky;
    if (s && s.map === map && s.url === url && s.horizon === horizon) return;
    s?.texture?.dispose();
    this.freeSkyBehind();
    this.sky =
      map && url ? { map, url, horizon, state: 'idle', texture: null } : null;
  }

  private freeSkyBehind(): void {
    this.skyBehind?.dispose();
    this.skyBehind = null;
  }

  /**
   * Fog counts from the eye, which in every camera is the camera. With the eye inside a smoke in
   * POV (`inSmoke`), the fog closes in to a few metres in the smoke's colour, so the view goes
   * thick with it instead of showing the puffs from inside: on a baked map the smoke's lit
   * grey-white (`lit`, `inSmokeFog`), on any other (`lit` null) the fog's own colour, which the
   * smoke is drawn in.
   */
  placeFog(inSmoke: boolean, lit: THREE.Color | null): void {
    if (inSmoke) {
      this.fog.near = SMOKE_FOG.near;
      this.fog.far = SMOKE_FOG.far;
      if (lit)
        inSmokeFog(lit, this.post.enabled, this.exposure, this.fog.color);
      else this.fog.color.copy(this.skyColor);
      return;
    }
    this.fog.color.copy(this.skyColor);
    const a = this.shownAtmosphere();
    this.fog.near = a ? a.fogNear : NO_FOG;
    this.fog.far = a ? a.fogFar : 2 * NO_FOG;
  }

  /**
   * A lost WebGL context came back: the post stack's sky copy was drawn once, into a target
   * that is now blank. Makes it again.
   */
  restore(): void {
    this.freeSkyBehind();
    this.paintSky();
  }

  /** Frees the sky texture and the post stack's copy; a sky still on its way is freed when in. */
  dispose(): void {
    this.setSky(null, null, null);
  }
}
