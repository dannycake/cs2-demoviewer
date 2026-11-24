// The three.js world of the viewer: the lit map under its map's own sky (CS2's, from
// sky.webp), fog and shadow-casting sun, lit by CS2's baked light where the map has it
// (light.json, baked.ts), its players by the bake's light grid (probes.ts), with a tiling
// detail texture on its opaque surfaces, its doors and breakables moving as they did in the
// match (lit as the world is), the map's collision hull (where tracers stop, and what the
// first-person arms' sun ray is cast against), one rig per player, the cameras, and the post
// stack (AO, bloom, vignette, SMAA) for `high`, all as the quality preset says (quality.ts),
// switchable at any time. It knows nothing of React; the viewer calls
// `setFrame` when the clock moves and the scene draws on the next animation frame. Nothing
// is drawn while nothing changes.
//
// The scene is the composition root of its parts, each owning its state and its loads: the
// map's world, hull, bake and doors (mapassets.ts), the players' models (players.ts), the sky
// and fog (sky.ts), what is made of the pack drawn (packcontext.ts), the cameras, the lights,
// the post stack and the effect layers. It holds the preset, the look and the phone tier, tells
// the parts when they change, and poses and draws the frame.

import * as THREE from 'three';
import { fetchManifest } from '../api/assets';
import type { ListenerPose } from '../audio/engine';
import { FLAG, zoomOf, type MatchHeader, type Pack } from '../pack/types';
import type { Action } from '../sim/actions';
import { LOOKBACK_S, strideBob } from '../sim/firstperson';
import type { PlayerState } from '../sim/sample';
import type { FreePose } from '../router';
import { PICK, nearestWithin } from '../geo/pick';
import { isFlyKey } from '../state/fly-keys';
import { settingsStore } from '../state/settings';
import { shakeOffset } from '../sim/impacts';
import { normaliseWeapon } from '../sim/weapons';
import type { CameraMode } from '../sim/follow';
import { Cameras, type CameraContext } from './cameras';
import { sunModeOf, type Baked } from './baked';
import { loadDetailTexture } from './detail';
import { BulletMarks, type MarkOptions } from './bulletmarks';
import { EffectAtlases } from './effects';
import { viewAngles } from './flycam';
import type { RigInput } from './frame';
import type { Hull } from './hull';
import { onImagesRestored, restoreImages } from './images';
import { loadGltf } from './loaders';
import { GroundItems } from './ground';
import { Lighting } from './lighting';
import { sameLook, type LookOptions } from './look';
import { MapAssets } from './mapassets';
import { PackContext } from './packcontext';
import { PlayerModels } from './players';
import { makeProbeSample } from './probes';
import { screenPoints } from './pick';
import { Impacts, type FirstPersonMuzzle, type ImpactOptions } from './impacts';
import { NameTags, type TagOptions } from './nametags';
import { Utility, type UtilityOptions } from './utility';
import { ArmsCache, type ViewmodelManifest } from './arms';
import { Viewmodel, viewmodelToScene, type ViewmodelFrame } from './viewmodel';
import { WeaponCache, weaponModelName, type WeaponManifest } from './weapons';
import { PostStack } from './post';
import { Prop, type PropPose } from './prop';
import { SkyAndFog } from './sky';
import {
  LIVE_SUN_LOW_SHADOWS,
  DEFAULT_QUALITY,
  PRESETS,
  isQuality,
  type Preset,
  type Quality,
} from './quality';

/** `CameraContext.killerOf` without a pack: nobody killed anyone. */
const NO_KILLER = (): number | null => null;
/** How long `probeFps` measures, and the fewest frames it measures. */
const PROBE_MS = 1000;
const PROBE_MIN_FRAMES = 5;
const DEG = 180 / Math.PI;
/** How long a restored WebGL context waits for the released images before it draws anyway. */
const RESTORE_WAIT_MS = 10_000;

/** The vertical field of view of `camera` in degrees: its own when perspective, else 70. */
function fovOf(camera: THREE.Camera): number {
  const p = camera as THREE.PerspectiveCamera;
  return p.isPerspectiveCamera === true ? p.fov : 70;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export { MissingAssetsError } from './mapassets';

export class Scene {
  /**
   * Frame rate, triangles of the last frame, and the last `probeFps` answer (NaN before).
   * `frames` counts draws (the e2e checks the view stops drawing under the full radar).
   * `worldShadows` counts draws of the world's own shadow map (once per map, not per frame).
   */
  readonly stats = {
    fps: 0,
    tris: 0,
    probe: Number.NaN,
    frames: 0,
    worldShadows: 0,
  };

  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly cameras: Cameras;
  private readonly canvas: HTMLCanvasElement;
  private readonly resizeObserver: ResizeObserver | null;
  /**
   * Matches the device pixel ratio the renderer was last set for, and fires when it changes
   * (the window moved to another monitor, the page zoomed), which the CSS size never shows.
   */
  private dprQuery: MediaQueryList | null = null;
  /** The device pixel ratio the renderer was last set for. */
  private dpr = 0;
  private _quality: Quality;
  /** How the current preset dresses the world and the players. */
  private look: LookOptions;
  /** Sky light and a shadow-casting sun fitted to the map, coloured by the map. */
  private readonly lighting: Lighting;
  /** Draws every frame: through the post stack when it is on, straight to the canvas if not. */
  private readonly post: PostStack;
  /** The map's sky and fog, and the exposure (`sky.ts`). */
  private readonly sky: SkyAndFog;
  /** The map's world, hull, bake and doors and breakables (`mapassets.ts`). */
  private readonly mapAssets: MapAssets;
  /** The tiling detail texture, asked for with the scene; null if it failed to load. */
  private readonly detail: Promise<THREE.Texture | null>;
  /** The weapon models players hold, fetched on first sight. */
  private readonly weapons: WeaponCache;
  /** The players' models and the rigs made of them for the match (`players.ts`). */
  private readonly players: PlayerModels;
  /** CS2's effect atlases (`effects.ts`), each fetched the first time an effect draws. */
  private readonly effects = new EffectAtlases();
  /** Grenades in flight and their effects (`utility.ts`), posed from `timeline` each draw. */
  private readonly utility: Utility;
  /** Tracers, hits, damage numbers and the bomb (`impacts.ts`), posed beside the utility. */
  private readonly impacts: Impacts;
  /**
   * What the shots leave on the walls (`bulletmarks.ts`): puffs, holes, wallbangs' marks and
   * blood, found once a round against the hull.
   */
  private readonly marks: BulletMarks;
  /** Weapons, grenades and kits lying where they fell (`ground.ts`), posed beside the utility. */
  private readonly ground: GroundItems;
  /** Names and health over heads (`nametags.ts`), posed beside the utility. */
  private readonly nameTags = new NameTags();
  /** The first-person arms and the clips per weapon, fetched the first time POV shows them. */
  private readonly arms: ArmsCache;
  /** The arms and the held weapon in first person (`viewmodel.ts`), drawn over the scene in POV. */
  private readonly viewmodel: Viewmodel;
  /** `ActionIndex.recent` of the player POV shows, reused each draw. */
  private readonly recentActions: Action[] = [];
  /**
   * Where the gun POV draws fires from, in the scene (`placeFirstPersonMuzzle`), for the shots'
   * flashes; filled in place each draw.
   */
  private readonly firstPerson: FirstPersonMuzzle = {
    player: -1,
    point: null,
    scale: 1,
  };
  private readonly firstPersonPoint = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  /** The camera's right and up in the world, for screen-aligned labels. */
  private readonly screenRight = new THREE.Vector3();
  private readonly screenUp = new THREE.Vector3();
  private readonly screen = { right: this.screenRight, up: this.screenUp };
  /**
   * The bullet marks' options (`poseUtility`), filled in place each draw: the camera's axes and
   * eye, and the utility's smokes, which fade the marks' puffs behind them.
   */
  private readonly markOptions: MarkOptions = {
    exposure: 1,
    tickRate: 64,
    grid: null,
    sunLight: null,
    toSun: null,
    screen: this.screen,
    eye: this.eye,
    smokes: null,
  };
  private readonly shakeBy = new THREE.Vector3();
  /** Redraws when the viewer changes a display setting (labels, trails, damage numbers). */
  private readonly unsubscribeSettings: () => void;
  /** `detail` once it is in (the first map load waits for it); null until then. */
  private detailTexture: THREE.Texture | null = null;
  /**
   * The sun's light the smokes, the blood and the bullet marks take on a baked map
   * (`poseUtility`), made once.
   */
  private readonly smokeSun = new THREE.Color();
  /**
   * The options of the camera, the first-person arms, the utility, the shots and hits and the
   * name tags for each draw (`render`, `poseViewmodel`, `poseUtility`), filled in place as the
   * bullet marks' are, so a draw makes none.
   */
  private readonly cameraCtx: CameraContext = {
    round: 0,
    tick: 0,
    pack: null,
    killerOf: NO_KILLER,
  };
  private readonly viewmodelFrame: ViewmodelFrame = {
    weapon: 'none',
    team: 0,
    family: 'rifle',
    actions: [],
    recent: [],
    tick: 0,
    tickRate: 64,
    clock: 0,
    stride: 0,
    bobWeight: 0,
    scoped: false,
    alive: false,
  };
  /** The first-person bob (`strideBob`), filled in place each draw. */
  private readonly bob = { stride: 0, bobWeight: 0 };
  private readonly utilityOptions: UtilityOptions;
  /** The rig shown for player `i` (`ImpactOptions.rig`). */
  private readonly rigOf = (i: number) => this.players.active(i);
  private readonly impactOptions: ImpactOptions = {
    states: [],
    rig: this.rigOf,
    hull: null,
    damageNumbers: false,
    screen: this.screen,
    shown: null,
    eye: this.eye,
    worldPerPixel: 0,
    grid: null,
    sunLight: null,
    exposure: 1,
    firstPerson: null,
    smokes: undefined,
  };
  private readonly tagOptions: TagOptions = {
    on: false,
    throughWalls: false,
    shown: null,
    hideShown: false,
    eye: this.eye,
    worldPerPixel: 0,
  };
  /** The canvas's size in CSS pixels, as `resize` last read it (no layout read per draw). */
  private width = 1;
  private height = 1;
  /**
   * Whether the world and the players are loaded as their phone tier (`world_lo.glb`,
   * `players/<side>_lo.glb`) where the manifests list it: the preset's `phoneTier`, but for a
   * preset measured on the device, which keeps the tier it was measured at (`setQuality`).
   */
  private phone: boolean;
  /** `listener`'s axis, made once. */
  private readonly listenAxis = new THREE.Vector3();
  /** What is made of the pack drawn last (`setFrame`), once per pack. */
  private packCtx: PackContext | null = null;
  private inputs: RigInput[] = [];
  private states: PlayerState[] = [];
  /** The first-person arms' light (`lightViewmodel`): the shown player's, the sun from the eye. */
  private readonly viewmodelSample = makeProbeSample();
  private readonly viewmodelEye = new THREE.Vector3();
  private lastFrame: { round: number; tick: number; pack: Pack } | null = null;
  private raf = 0;
  private lastRender = 0;
  private fpsFrames = 0;
  private fpsSince = 0;
  /** A running `probeFps`: when it ends, the draw times so far, and its answer. */
  private probe: {
    end: number;
    times: number[];
    resolve: (fps: number) => void;
    answer: Promise<number>;
  } | null = null;
  private readonly pixel = new Uint8Array(4);
  private disposed = false;
  /** Covered by the full radar: nothing is drawn until it is shown again. */
  private hidden = false;
  /**
   * A lost WebGL context came back and the decoded images released after their upload are
   * fetched again (`restoreImages`): nothing is drawn until they are back, so nothing draws
   * black first. Null otherwise.
   */
  private restoring: Promise<void> | null = null;
  /** Stops redrawing when released images come back. */
  private readonly unsubscribeImages: () => void;

  /**
   * A scene drawn at preset `quality`; `setQuality` switches it later. `measured`: the preset
   * was measured on this device at `DEFAULT_QUALITY` (the store's `detectQuality`) for an
   * earlier scene of the page, not chosen: the scene loads the tier it was measured at, as
   * `setQuality(q, true)` keeps it, so a desktop measured at `low` draws every later demo of
   * the page with the files it was measured with, not the phone tier. `canvas` is the scene's
   * for good: `dispose` loses its context.
   */
  constructor(
    canvas: HTMLCanvasElement,
    quality: Quality = DEFAULT_QUALITY,
    measured = false
  ) {
    this.canvas = canvas;
    this._quality = isQuality(quality) ? quality : DEFAULT_QUALITY;
    this.phone = measured
      ? PRESETS[DEFAULT_QUALITY].phoneTier
      : this.preset.phoneTier;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    // A frame through the post stack is many draws: `stats.tris` counts them all, once.
    this.renderer.info.autoReset = false;
    this.look = this.lookFor(this.preset, null);
    this.detail = loadDetailTexture();
    this.weapons = new WeaponCache((url) => loadGltf(url).then((g) => g.scene));
    // A model that arrives after the players were posed is put in their hands now, not when
    // the tick next moves: a paused replay would show empty hands until play.
    this.weapons.onLoad = () => {
      if (!this.repose()) this.invalidate();
    };
    this.players = new PlayerModels(this.scene, this.weapons, {
      phone: () => this.phone,
      look: () => this.playerLook(),
      repose: () => this.repose(),
      invalidate: this.invalidate,
    });
    // An atlas that arrives while paused is drawn now, not when the tick next moves.
    this.effects.onReady(() => this.invalidate());
    // In the players' look, as `relook` dresses them.
    this.utility = new Utility(
      this.weapons,
      this.effects,
      this.playerLook(this.look)
    );
    this.impacts = new Impacts(
      this.weapons,
      this.playerLook(this.look),
      this.effects
    );
    this.marks = new BulletMarks(this.effects);
    this.ground = new GroundItems(this.weapons, this.playerLook(this.look));
    this.arms = new ArmsCache(loadGltf);
    this.arms.onLoad = this.invalidate;
    this.viewmodel = new Viewmodel(
      this.weapons,
      this.playerLook(this.look),
      this.arms
    );
    this.unsubscribeSettings = settingsStore.subscribe(() => this.invalidate());
    // A texture's image back (images.ts) is drawn now, paused or not.
    this.unsubscribeImages = onImagesRestored(this.invalidate);
    // Versioned URLs once the manifest is in; a model asked for before it loads unversioned.
    void fetch('/weapons/manifest.json')
      .then((r) => (r.ok ? (r.json() as Promise<WeaponManifest>) : null))
      .then((m) => {
        if (m && !this.disposed) this.weapons.setManifest(m);
      })
      .catch(() => {});
    // The arms ask for nothing until this is in; without it (an older asset set) the gun is
    // drawn alone.
    void fetchManifest<ViewmodelManifest>('/viewmodels/manifest.json').then(
      (m) => {
        if (!this.disposed) this.arms.setManifest(m);
      }
    );
    this.scene.add(
      this.utility.root,
      this.impacts.root,
      this.marks.root,
      this.ground.root,
      this.nameTags.root
    );
    this.lighting = new Lighting(this.scene);
    this.cameras = new Cameras(this.renderer, canvas, new THREE.Box3());
    this.cameras.fly.onChange = this.invalidate;
    this.post = new PostStack(this.renderer, this.scene, this.cameras.camera);
    this.sky = new SkyAndFog(
      this.renderer,
      this.scene,
      this.post,
      this.preset.atmosphere
    );
    this.sky.onLoad = this.invalidate;
    this.mapAssets = new MapAssets({
      scene: this.scene,
      lighting: this.lighting,
      cameras: this.cameras,
      sky: this.sky,
      marks: this.marks,
      effects: this.effects,
      phone: () => this.phone,
      look: () => this.look,
      lookReady: async () => {
        this.detailTexture = await this.detail;
        if (!this.disposed) this.relook();
      },
      relight: () => {
        this.applyLight();
        this.relook();
      },
      changed: () => {
        this.lightPlayers();
        this.invalidate();
      },
      invalidate: this.invalidate,
    });
    this.utilityOptions = {
      labels: false,
      trails: false,
      lights: false,
      fogColor: this.sky.fog.color,
      eye: this.eye,
      worldPerPixel: 0,
      exposure: 1,
      grid: null,
      sunLight: null,
    };
    // While paused nothing else would draw once a lost context comes back.
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    this.applyPreset();
    this.watchDpr();
  }

  /**
   * The map's collision hull, or null without a map, while it loads, or when the map has
   * none (tracers then run their whole reach).
   */
  get hull(): Hull | null {
    return this.mapAssets.hull;
  }

  /**
   * Counts the hulls taken and dropped: it changes whenever `hull` does (a map's hull loaded,
   * replaced or freed), so what was found on the hull (the surfaces under the footsteps) is
   * found again.
   */
  get hullVersion(): number {
    return this.mapAssets.hullVersion;
  }

  /** The preset the scene is drawn at. */
  get quality(): Quality {
    return this._quality;
  }

  private get preset(): Readonly<Preset> {
    return PRESETS[this._quality];
  }

  /**
   * Draws at preset `q` from the next frame: the world and the players are dressed again in
   * its look (the previous materials freed, their textures kept), and the tone mapping, the
   * shadow map (the old one freed), the post stack (its targets freed when it goes off), the
   * sky and fog and the pixel ratio follow it. `high` on a device that cannot run the post
   * stack draws as `medium`. A running `probeFps` stops, answering NaN. The current preset
   * changes nothing.
   *
   * A change to or from a preset with the phone tier (`low`) loads the map and the players last
   * asked for again at the new tier (`loadMap`, `loadRigs`, which a caller joins to hear how it
   * went). Where the manifests name other files for it, the world and the players drawn are
   * left as they are until the new ones replace them, not dressed in the new look on their way
   * out: their textures' images were released after upload (images.ts), and a new anisotropy
   * would fetch their GLBs again and decode and upload every texture, only to free them.
   * `measured`: the preset was measured on this device (the store's `detectQuality`), not
   * chosen: it keeps the tier the scene is at, since the phone tier is for a phone's memory and
   * the world and the players measured would download a second time for a desktop. A scene made
   * after the measure is told so by its constructor. A change of `measured` alone, at the same
   * preset, changes nothing: the tier follows a change of preset only.
   */
  setQuality(q: Quality, measured = false): void {
    if (this.disposed || !isQuality(q) || q === this._quality) return;
    this.endProbe(Number.NaN);
    this._quality = q;
    const phone = measured ? this.phone : this.preset.phoneTier;
    const swap = phone !== this.phone;
    this.phone = phone;
    this.applyPreset();
    this.relook();
    // The sky depends on the preset, and on whether the post stack tone-maps it.
    this.sky.setPreset(this.preset.atmosphere);
    if (swap) {
      // Each caller hears its own failures: the viewer's calls join these.
      this.mapAssets.reload();
      this.players.reload();
    }
    this.invalidate();
  }

  /** The look `p` dresses the world and the players in, on a world drawn with bake `baked`. */
  private lookFor(p: Readonly<Preset>, baked: Baked | null): LookOptions {
    return {
      lit: p.lit,
      smoothNormals: p.smoothNormals,
      // The look caps the anisotropy itself.
      maxAnisotropy: p.aniso
        ? this.renderer.capabilities.getMaxAnisotropy()
        : 1,
      detail: p.detail ? (this.detailTexture ?? undefined) : undefined,
      baked: baked ?? undefined,
    };
  }

  /**
   * The look the players, their weapons and the first-person arms are drawn in: `look`, lit at
   * every preset where the map's bake has a light grid (they take their light from it), as the
   * preset says elsewhere. The grenades in flight, the items on the ground and the bomb are
   * drawn in it too, and take the grid's light as the players do (`ItemLight`).
   */
  private playerLook(look: LookOptions = this.look): LookOptions {
    return look.baked && !look.lit ? { ...look, lit: true } : look;
  }

  /**
   * Dresses the world, its doors and breakables, the players, the utility and the items on the
   * ground in the current preset's look, if it changed; the world and the players only where
   * they are the files of the scene's tier (a change of tier is swapping them otherwise).
   */
  private relook(): void {
    const look = this.lookFor(this.preset, this.mapAssets.baked);
    if (sameLook(look, this.look)) return;
    this.look = look;
    const players = this.playerLook(look);
    this.viewmodel.setLook(players);
    this.ground.setLook(players);
    this.utility.setLook(players);
    this.impacts.setLook(players);
    this.mapAssets.relook();
    this.players.relook();
  }

  /**
   * The renderer's side of the preset: tone mapping, pixel ratio, shadows and post. A preset
   * with post on a device that cannot run the stack draws with `medium`'s settings, so the
   * weakest devices do not get `high`'s 4096² shadow map either.
   */
  private applyPreset(): void {
    const p = this.drawnPreset;
    this.applyLight();
    this.setPixelRatio();
    this.post.setEnabled(p.post);
    this.resize();
  }

  /**
   * Tone mapping and the sun's shadow, by the drawn preset and the map's bake. A baked world
   * is lit at every preset, so it is tone-mapped at every preset, `low` included; a bake
   * without a sun (none, or Train's brightness 0) has no runtime shadow from it; a bake with a
   * sun, in it or drawn at runtime beside it (de_cache), splits the shadow, the world's drawn
   * once apart from the players' (Lighting).
   */
  private applyLight(): void {
    const p = this.drawnPreset;
    const b = this.mapAssets.baked;
    this.renderer.toneMapping =
      p.lit || b ? THREE.NeutralToneMapping : THREE.NoToneMapping;
    const mode = b ? sunModeOf(b.info) : null;
    // A sun drawn at runtime beside the bake (de_cache) keeps a shadow map even at `low`.
    const size =
      mode === 'none'
        ? 0
        : mode === 'live' && p.shadows === 0
          ? LIVE_SUN_LOW_SHADOWS
          : p.shadows;
    this.lighting.setShadows(
      size,
      this.renderer,
      mode === 'baked' || mode === 'live'
    );
  }

  /** The preset the renderer draws with: `medium` for one with post the device cannot run. */
  private get drawnPreset(): Readonly<Preset> {
    const want = this.preset;
    return want.post && !this.post.supported ? PRESETS.medium : want;
  }

  /** The device's pixel ratio, capped at the drawn preset's. */
  private setPixelRatio(): void {
    this.dpr = globalThis.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(this.dpr, this.drawnPreset.dpr));
  }

  /**
   * Re-targets the renderer and the post stack, at the same CSS size, when the device pixel
   * ratio is not the one they were set for. Run by `onDpr` and before every draw, as not
   * every ratio change fires the media query (DevTools' device emulation does not).
   */
  private followDpr(): void {
    if ((globalThis.devicePixelRatio || 1) === this.dpr) return;
    this.setPixelRatio();
    this.resize();
  }

  /** Listens for the device pixel ratio to leave the one it is now. */
  private watchDpr(): void {
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery =
      typeof globalThis.matchMedia === 'function'
        ? globalThis.matchMedia(
            `(resolution: ${globalThis.devicePixelRatio || 1}dppx)`
          )
        : null;
    this.dprQuery?.addEventListener('change', this.onDpr);
  }

  /** A new device pixel ratio: follow it now, paused or not, and watch for the next. */
  private readonly onDpr = () => {
    if (this.disposed) return;
    this.followDpr();
    this.watchDpr();
  };

  /**
   * How fast the scene draws at its current preset, in frames per second. For `ms` it draws
   * every animation frame, paused or not, waits for the GPU after each draw, and answers
   * with the rate the median draw time allows: unlike counting frames, that is not capped
   * by the display's refresh rate. A call during a probe joins it. NaN when the scene is
   * disposed or the preset changes first.
   */
  probeFps(ms = PROBE_MS): Promise<number> {
    if (this.disposed) return Promise.resolve(Number.NaN);
    if (!this.probe) {
      let resolve!: (fps: number) => void;
      const answer = new Promise<number>((r) => (resolve = r));
      this.probe = { end: performance.now() + ms, times: [], resolve, answer };
    }
    this.invalidate();
    return this.probe.answer;
  }

  /** Times a draw that started at `start` for the running probe, and asks for the next. */
  private sampleProbe(start: number): void {
    const p = this.probe;
    if (!p) return;
    // Reading a pixel back waits for the GPU to finish the frame.
    const gl = this.renderer.getContext();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.pixel);
    const now = performance.now();
    p.times.push(now - start);
    if (now >= p.end && p.times.length >= PROBE_MIN_FRAMES) {
      this.stats.probe = 1000 / Math.max(1e-3, median(p.times));
      this.endProbe(this.stats.probe);
    } else this.invalidate();
  }

  private endProbe(fps: number): void {
    const p = this.probe;
    this.probe = null;
    p?.resolve(fps);
  }

  /** The fog for this draw: closed in to the smoke the eye is in, in POV (`SkyAndFog.placeFog`). */
  private placeFog(): void {
    const inSmoke =
      this.cameras.mode === 'pov' && this.utility.eyeInSmoke(this.eye);
    this.sky.placeFog(
      inSmoke,
      inSmoke ? this.utility.smokeColorAt(this.eye) : null
    );
  }

  /**
   * Loads map `map`'s world, hull, bake and doors (`MapAssets.load`): the first call names the
   * map, a change of tier swaps the world under the same view, and of overlapping calls only the
   * last one has an effect. Rejects with `MissingAssetsError` when the server has no assets for
   * the map.
   */
  loadMap(map: string): Promise<void> {
    return this.mapAssets.load(map);
  }

  /**
   * Hears the world file's bytes as they arrive, and its size by the map's manifest (null when
   * it does not say), for a progress bar; null stops it.
   */
  set onWorldBytes(
    fn: ((loaded: number, total: number | null) => void) | null
  ) {
    this.mapAssets.onWorldBytes = fn;
  }

  /**
   * Makes the rig pool for this match of the players' models, at the scene's phone tier
   * (`PlayerModels.load`: of overlapping calls only the last one has an effect).
   */
  loadRigs(header: MatchHeader): Promise<void> {
    return this.players.load(header);
  }

  /** Poses the frame drawn last again (the models changed under it); false before the first. */
  private repose(): boolean {
    const last = this.lastFrame;
    if (!last) return false;
    this.setFrame(last.round, last.tick, last.pack);
    return true;
  }

  /** Poses every player at `tick` (a float) of round index `round`. */
  setFrame(round: number, tick: number, pack: Pack): void {
    if (this.packCtx?.pack !== pack) this.packCtx = new PackContext(pack);
    const ctx = this.packCtx;
    const last = this.lastFrame;
    if (last?.pack !== pack || last.round !== round)
      this.fetchWeapons(ctx, round);
    if (last) {
      last.round = round;
      last.tick = tick;
      last.pack = pack;
    } else this.lastFrame = { round, tick, pack };
    this.mapAssets.bind(pack);
    this.inputs = ctx.solver.solve(round, tick, this.inputs);
    this.states.length = this.inputs.length;
    for (let i = 0; i < this.inputs.length; i++)
      this.states[i] = this.inputs[i].state;
    this.players.drive(this.inputs, pack.header);
    this.lightPlayers();
    this.invalidate();
  }

  /** Lights every player shown by the map's light grid (`PlayerModels.light`). */
  private lightPlayers(): void {
    this.players.light(this.mapAssets.baked?.lightGrid ?? null);
  }

  /**
   * Asks for the model of every weapon held or lying on the ground in round `round`, so each
   * is drawn the moment it shows instead of a moment after.
   */
  private fetchWeapons(ctx: PackContext, round: number): void {
    const { pack } = ctx;
    const { header } = pack;
    const names = new Set<string>();
    pack.rounds[round]?.players.forEach((track, i) => {
      const team = header.players[i]?.team_by_round[round] ?? 0;
      const seen = new Set(track.weapon);
      for (const w of seen) {
        const name = weaponModelName(
          normaliseWeapon(header.weapons[w] ?? 'none'),
          team
        );
        if (name) names.add(name);
      }
    });
    for (const name of ctx.ground.weaponsIn(round)) names.add(name);
    for (const name of names) this.weapons.get(name);
  }

  /**
   * `follow` is a player index; one past the players (or null) follows nobody. `pinned`: the
   * user picked them, so POV holds their death view to the end of the round.
   */
  setCamera(mode: CameraMode, follow: number | null, pinned = false): void {
    const c = this.cameras;
    if (c.mode === mode && c.follow === follow && c.pinned === pinned) return;
    c.mode = mode;
    c.follow = follow;
    c.pinned = pinned;
    this.invalidate();
  }

  /**
   * A key of the fly camera (`W A S D Q E`, Shift) went down or up; anything else is
   * ignored. Returns whether it was one. The keys are tracked in every mode and move the
   * camera in Free.
   */
  flyKey(code: string, down: boolean): boolean {
    if (!isFlyKey(code)) return false;
    const keys = this.cameras.fly.keys;
    if (down) keys.add(code);
    else keys.delete(code);
    if (this.cameras.mode === 'free') this.invalidate();
    return true;
  }

  /** Lets go of every fly key (the window lost focus, or the page was hidden). */
  clearFlyKeys(): void {
    this.cameras.fly.clear();
  }

  /** The GLB prop at `url` (`Prop`) put in the scene, replacing any before: the homepage
   * video's chicken (`tools/home-video.mjs`). */
  async loadProp(
    url: string
  ): Promise<{ clips: string[]; height: number; durations: number[] }> {
    const prop = await Prop.load(url, this.playerLook());
    if (this.disposed) {
      prop.dispose();
      return { clips: [], height: 0, durations: [] };
    }
    this.prop?.dispose();
    this.prop = prop;
    this.scene.add(prop.root);
    this.invalidate();
    return {
      clips: prop.clips,
      height: prop.height,
      durations: prop.durations,
    };
  }

  /** Poses the prop (`Prop.pose`), lit by the map's light grid; null hides it. */
  poseProp(p: PropPose | null): void {
    if (!this.prop) return;
    this.prop.root.visible = p !== null;
    if (p) this.prop.pose(p, this.mapAssets.baked?.lightGrid ?? null);
    this.invalidate();
  }

  private prop: Prop | null = null;

  /** The post stack's depth of field (`PostStack.setDof`); null turns it off. */
  setDof(o: { focus: number; scale: number; max: number } | null): void {
    this.post.setDof(o);
    this.invalidate();
  }

  /**
   * Puts the free camera at `p` (a shared link's `at`, in `cameraDebug`'s metres and degrees,
   * with its field of view when it has one): it shows at once in Free, and otherwise the next
   * entry into Free keeps it instead of taking the view drawn last. The map's first world
   * frames Free afresh, so this is for after the map is in.
   */
  setFreePose(p: FreePose): void {
    this.cameras.fly.place(
      new THREE.Vector3(p.x, p.y, p.z),
      p.yaw,
      p.pitch,
      p.fov
    );
    this.invalidate();
  }

  /**
   * The next entry into Free keeps the free camera's own pose (`Cameras.keepFree`): a reel
   * started in Free goes back to where it was flown, not to the reel's last view.
   */
  keepFreePose(): void {
    this.cameras.keepFree();
    this.invalidate();
  }

  /**
   * The camera drawn last, for the e2e and the Share button's pose in Free: its position
   * (scene metres), its view as Source yaw and pitch in degrees (`viewAngles`: pitch positive
   * looking down), its vertical field of view in degrees, the mode, and the player the POV
   * camera showed last (null for nobody).
   */
  cameraDebug(): {
    x: number;
    y: number;
    z: number;
    yaw: number;
    pitch: number;
    fov: number;
    mode: CameraMode;
    shown: number | null;
  } {
    const cam = this.cameras.drawn;
    const { yaw, pitch } = viewAngles(cam);
    return {
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
      yaw,
      pitch,
      fov: cam.fov,
      mode: this.cameras.mode,
      shown: this.cameras.shown,
    };
  }

  /**
   * Player `i` as drawn last, for the e2e: where the rig stands (scene metres) and the
   * Source yaw it faces, its duck amount and speed, and the locomotion clips it blends; null
   * when no rig of theirs is shown.
   */
  rigDebug(i: number): {
    x: number;
    y: number;
    z: number;
    yaw: number;
    duck: number;
    speed: number;
    clips: { clip: string; weight: number; time: number | null }[];
  } | null {
    const rig = this.players.active(i);
    const input = this.inputs[i];
    if (!rig || !input) return null;
    const p = rig.object.position;
    return {
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: rig.object.rotation.y * DEG,
      duck: input.state.duck,
      speed: input.state.speed,
      clips: input.locomotion.map((c) => ({ ...c })),
    };
  }

  /**
   * The items on the ground as posed for the last frame drawn (`GroundItems.debug`), each with
   * where on the canvas the camera drawn last shows it, for the e2e.
   */
  groundDebug(): ReturnType<GroundItems['debug']> {
    return this.ground.debug({
      camera: this.cameras.drawn,
      width: Math.max(1, this.canvas.clientWidth),
      height: Math.max(1, this.canvas.clientHeight),
    });
  }

  /** The bullet marks as drawn for the last frame (`BulletMarks.debug`), for the e2e. */
  marksDebug(): ReturnType<BulletMarks['debug']> {
    return this.marks.debug();
  }

  /**
   * What the renderer holds on the GPU, and the draw calls of the last frame (shadow map and
   * post passes included): the e2e checks that switching presets frees the one and leaves
   * no stale draws in the other.
   */
  memory(): {
    textures: number;
    geometries: number;
    programs: number;
    calls: number;
  } {
    const info = this.renderer.info;
    return {
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      programs: info.programs?.length ?? 0,
      calls: info.render.calls,
    };
  }

  /**
   * Turns the effects' own bloom (post.ts `EffectsBloomPass`) on or off and draws again, until the
   * map or its exposure next sets it (on with a bake, off without): for the e2e's frames with and
   * without it.
   */
  setEffectsBloom(on: boolean): void {
    this.post.setEffectsBloom(on);
    this.invalidate();
  }

  /** Metres from the scene point `(x, y, z)` to the map's hull, or null without a hull. */
  hullDistance(x: number, y: number, z: number): number | null {
    const hull = this.mapAssets.hull;
    if (!hull) return null;
    return hull.closestPoint(new THREE.Vector3(x, y, z), new THREE.Vector3());
  }

  /**
   * The surface under the feet at the Source point `(x, y, z)` (units), as the hull names it,
   * or null (`MapAssets.surfaceBelow`).
   */
  surfaceBelow(x: number, y: number, z: number): string | null {
    return this.mapAssets.surfaceBelow(x, y, z);
  }

  /**
   * Where the sound is heard from: the camera drawn last (in POV the player's eye), its
   * position in scene metres, and its forward (−Z) and up (+Y) turned by its rotation. False,
   * with `out` left alone, before the first draw and while hidden (the full radar).
   */
  listener(out: ListenerPose): boolean {
    if (this.hidden || this.disposed || this.stats.frames === 0) return false;
    const cam = this.cameras.drawn;
    out.x = cam.position.x;
    out.y = cam.position.y;
    out.z = cam.position.z;
    const a = this.listenAxis.set(0, 0, -1).applyQuaternion(cam.quaternion);
    out.fx = a.x;
    out.fy = a.y;
    out.fz = a.z;
    a.set(0, 1, 0).applyQuaternion(cam.quaternion);
    out.ux = a.x;
    out.uy = a.y;
    out.uz = a.z;
    return true;
  }

  private cameraContext(): CameraContext {
    const c = this.cameraCtx;
    const f = this.lastFrame;
    // The last frame's pack's (`setFrame` makes both).
    const ctx = this.packCtx;
    if (!f || !ctx) {
      c.round = 0;
      c.tick = 0;
      c.pack = null;
      c.killerOf = NO_KILLER;
      return c;
    }
    c.round = f.round;
    c.tick = f.tick;
    c.pack = f.pack;
    c.killerOf = ctx.killerOf(f.round);
    return c;
  }

  /**
   * In POV, poses the shown player's arms and weapon for this draw, played from their actions
   * (the gun alone until the arms and its clips are in); hidden while scoped or dead (a death
   * view included). Before the shots are posed, which flash at the gun's muzzle. Returns the
   * player shown, or null when nothing is drawn.
   */
  private poseViewmodel(): number | null {
    const f = this.lastFrame;
    // POV shows the player its legs name (after a death and its hold, the killer).
    const shown = this.cameras.hiddenPlayer();
    const input = shown !== null ? this.inputs[shown] : undefined;
    if (!f || !input || shown === null) return null;
    const s = input.state;
    const solver = this.packCtx?.solver;
    // One bob up and down per stride, with the distance walked, as big as the speed makes it.
    const bob = strideBob(
      solver?.distanceAt(
        f.round,
        shown,
        input.tick,
        f.pack.header.rounds[f.round]
      ) ?? 0,
      s.speed,
      this.bob
    );
    const recent =
      solver?.actionIndex.recent(
        f.round,
        shown,
        input.tick,
        LOOKBACK_S,
        this.recentActions
      ) ?? [];
    const vf = this.viewmodelFrame;
    vf.weapon = input.weapon;
    vf.team = input.team;
    vf.family = input.family;
    vf.actions = input.actions;
    vf.recent = recent;
    vf.tick = input.tick;
    vf.tickRate = f.pack.header.tick_rate;
    vf.clock = input.clipTime;
    vf.stride = bob.stride;
    vf.bobWeight = bob.bobWeight;
    vf.scoped = (s.flags & FLAG.scoped) !== 0 || zoomOf(s.gear) > 0;
    vf.alive = s.present && input.deathTicks === null;
    this.viewmodel.show(vf);
    return this.viewmodel.visible ? shown : null;
  }

  /**
   * Where player `shown`'s first-person gun fires from in the scene: its muzzle in the
   * viewmodel's frame carried into `camera`'s (`viewmodelToScene`), so it lands where the gun's
   * muzzle is drawn on screen; `scale` is how much bigger than life the viewmodel draws it. No
   * point while no gun is drawn (scoped).
   */
  private placeFirstPersonMuzzle(
    shown: number | null,
    pov: number | null,
    camera: THREE.Camera
  ): FirstPersonMuzzle | null {
    if (pov === null) return null;
    const fp = this.firstPerson;
    fp.player = pov;
    fp.point = null;
    fp.scale = 1;
    const p = this.firstPersonPoint;
    if (shown !== pov || !this.viewmodel.muzzle(p)) return fp;
    const fov = fovOf(camera);
    camera.updateWorldMatrix(true, false);
    fp.scale = viewmodelToScene(
      p,
      this.viewmodel.camera.fov,
      fov,
      camera.matrixWorld,
      p
    );
    fp.point = p;
    return fp;
  }

  /**
   * Draws the arms posed by `poseViewmodel` over the scene, lit as `lightViewmodel` says; when
   * hidden (scoped, or dead: in their death view the eye is where they died) they take no
   * light: no copy of the grid's, no ray to the sun.
   */
  private drawViewmodel(camera: THREE.Camera, shown: number | null): void {
    if (shown === null || !this.viewmodel.visible) return;
    this.viewmodel.matchLights(this.lighting.hemi, this.lighting.sun, camera);
    this.lightViewmodel(shown, camera.getWorldPosition(this.viewmodelEye));
    this.viewmodel.render(this.renderer, this.width / this.height);
  }

  /**
   * Lights the first-person arms by the light of player `shown` (their grid sample, which the
   * arms take a copy of) and by the sun as the eye at `eye` sees it: one ray along the sun
   * against the hull wherever the sun casts a shadow map (`medium` and `high`, and de_cache's
   * live sun at `low` too), where the players take the shadow maps; without a shadow map (`low`
   * elsewhere) or without a hull, the grid's sun, as the players there. The sky light without a
   * grid or a sample. Makes nothing per frame.
   */
  private lightViewmodel(shown: number, eye: THREE.Vector3): void {
    const from = this.mapAssets.baked ? this.players.lightOf(shown) : undefined;
    if (!from) {
      this.viewmodel.setProbe(null);
      return;
    }
    const s = this.viewmodelSample;
    s.up.copy(from.up);
    s.down.copy(from.down);
    s.side.copy(from.side);
    const hull = this.mapAssets.hull;
    if (this.lighting.sun.castShadow && hull)
      s.sun = hull.sees(eye, this.lighting.direction) ? 1 : 0;
    else s.sun = from.sun;
    this.viewmodel.setProbe(s);
  }

  /** The camera offset of the bomb's blast at the last frame, in POV; zero otherwise. */
  private shake(): THREE.Vector3 {
    const f = this.lastFrame;
    const ctx = this.packCtx;
    this.shakeBy.set(0, 0, 0);
    if (!f || !ctx || this.cameras.mode === 'free') return this.shakeBy;
    // Asked every draw: `explodedAt` makes nothing, where `bombAt` makes the bomb's state.
    const at = ctx.timeline.explodedAt(f.round, f.tick);
    if (at === null) return this.shakeBy;
    return shakeOffset(at, f.tick, f.pack.header.tick_rate, this.shakeBy);
  }

  /**
   * Poses the doors and breakables, grenades, effects, items on the ground, shots, hits, bomb,
   * bullet marks and name tags of the last frame for `camera`, after `cameras.update` has
   * picked who is on screen.
   */
  private poseUtility(camera: THREE.Camera, viewmodel: number | null): void {
    const f = this.lastFrame;
    const ctx = this.packCtx;
    if (!f || !ctx) return;
    const timeline = ctx.timeline;
    const fov = fovOf(camera);
    // The eye the options below share (`this.eye`), where the camera is.
    camera.getWorldPosition(this.eye);
    const worldPerPixel = (2 * Math.tan((fov * Math.PI) / 360)) / this.height;
    const shown = settingsStore.getState().settings;
    // What the flames and a window's dust divide out to show as chosen on every map.
    const exposure =
      this.renderer.toneMapping === THREE.NoToneMapping
        ? 1
        : this.renderer.toneMappingExposure;
    const { entities, baked, hull } = this.mapAssets;
    if (entities) {
      const moved = entities.set(
        f.round,
        f.tick,
        ctx.entities,
        f.pack.header.tick_rate,
        exposure
      );
      // The sun's shadow of the world holds the doors as they stand (lighting.ts): drawn again
      // on the frames one turns or a window breaks, where the shadow is split; free elsewhere.
      if (moved) this.lighting.invalidateWorldShadow();
    }
    // On a baked map what lies or flies in it takes the grid's light, as the players do.
    const grid = baked?.lightGrid ?? null;
    this.ground.set(f.round, f.tick, ctx.ground, grid);
    // The sun in the grid's units: three's sun over π (a Lambert without π, as the bake).
    const sunLight = grid
      ? this.smokeSun
          .copy(this.lighting.sun.color)
          .multiplyScalar(this.lighting.sun.intensity / Math.PI)
      : null;
    this.screenRight.setFromMatrixColumn(camera.matrixWorld, 0);
    this.screenUp.setFromMatrixColumn(camera.matrixWorld, 1);
    const uo = this.utilityOptions;
    uo.labels = shown.labels;
    uo.trails = shown.trails;
    uo.lights = this.drawnPreset === PRESETS.high;
    uo.worldPerPixel = worldPerPixel;
    uo.exposure = exposure;
    uo.grid = grid;
    uo.sunLight = sunLight;
    this.utility.set(f.round, f.tick, timeline, uo);
    const io = this.impactOptions;
    io.states = this.states;
    io.hull = hull;
    io.damageNumbers = shown.damageNumbers;
    io.shown =
      this.cameras.follow !== null &&
      this.cameras.follow < f.pack.header.players.length
        ? this.cameras.follow
        : null;
    io.worldPerPixel = worldPerPixel;
    io.grid = grid;
    io.sunLight = sunLight;
    io.exposure = exposure;
    io.firstPerson = this.placeFirstPersonMuzzle(
      viewmodel,
      this.cameras.hiddenPlayer(),
      camera
    );
    // The smokes just posed, which fade the flashes and the blood behind them.
    io.smokes = this.utility.smokeSpheres;
    this.impacts.set(f.round, f.tick, timeline, io);
    const marks = this.markOptions;
    marks.exposure = exposure;
    marks.tickRate = f.pack.header.tick_rate;
    marks.grid = grid;
    marks.sunLight = sunLight;
    marks.toSun = this.lighting.direction;
    marks.smokes = this.utility.smokeSpheres;
    this.marks.set(f.round, f.tick, timeline, hull, marks);
    // No tag over the player on screen: in POV, whose eyes it looks through, the killer after
    // a death, as for the hidden model; in Free, the followed player.
    const to = this.tagOptions;
    to.on = shown.nameTags;
    to.throughWalls = shown.xray;
    to.shown =
      this.cameras.mode === 'pov'
        ? this.cameras.hiddenPlayer()
        : this.cameras.follow;
    to.hideShown = this.cameras.mode !== 'free';
    to.worldPerPixel = worldPerPixel;
    to.camera = camera;
    to.width = this.width;
    to.height = this.height;
    this.nameTags.update(this.states, f.pack.header, f.round, to);
  }

  /**
   * The player under CSS pixel (x, y) of the canvas, as drawn last: the living player whose
   * chest is nearest within `PICK.radiusPx`, leaving out the one whose eyes the view looks
   * through; null for nobody, or while hidden.
   */
  pickPlayer(x: number, y: number): number | null {
    if (this.hidden || this.disposed) return null;
    const points = screenPoints(
      this.states,
      this.cameras.drawn,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.cameras.hiddenPlayer()
    );
    return nearestWithin(points, x, y, PICK.radiusPx);
  }

  /**
   * Stops drawing while something covers the view (the full radar), so the GPU idles; showing
   * it again draws on the next frame.
   */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    if (!hidden) {
      // The time spent hidden is not a frame's worth of camera motion.
      this.lastRender = 0;
      this.invalidate();
    }
  }

  /** Draws now. Normally not needed: every change schedules a draw on the next frame. */
  render(): void {
    if (this.disposed) return;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.hidden || this.restoring) return;
    this.stats.frames++;
    this.followDpr();
    const now = performance.now();
    const dt = this.lastRender
      ? Math.min(0.1, (now - this.lastRender) / 1000)
      : 0;
    this.lastRender = now;
    const camera = this.cameras.update(this.states, dt, this.cameraContext());
    // The arms first: the shots seen in first person flash at the gun's muzzle.
    const viewmodel = this.poseViewmodel();
    this.poseUtility(camera, viewmodel);

    // Team outlines through walls; white for the followed player.
    this.players.setOutlines(
      settingsStore.getState().settings.xray,
      this.cameras.follow
    );
    // In a player's own view their model (or body, in their death view) would fill the screen
    // (and its outlines with it).
    const hide = this.cameras.hiddenPlayer();
    const own = hide !== null ? this.players.active(hide) : null;
    if (own) own.object.visible = false;
    this.placeFog();
    // Where the shadow is split, the world's map is drawn only when it is stale.
    if (
      this.lighting.drawWorldShadow(
        this.renderer,
        this.mapAssets.world,
        this.mapAssets.entities?.models ?? null
      )
    )
      this.stats.worldShadows++;
    this.renderer.info.reset();
    // The bomb's blast shakes the view in POV, for this draw only.
    const shake = this.shake();
    camera.position.add(shake);
    this.post.render(camera);
    this.drawViewmodel(camera, viewmodel);
    camera.position.sub(shake);
    if (own) own.object.visible = true;
    if (this.probe) this.sampleProbe(now);

    this.stats.tris = this.renderer.info.render.triangles;
    this.fpsFrames++;
    if (!this.fpsSince) this.fpsSince = now;
    else if (now - this.fpsSince >= 500) {
      this.stats.fps = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }
    if (this.cameras.settling) this.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.endProbe(Number.NaN);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resizeObserver?.disconnect();
    this.dprQuery?.removeEventListener('change', this.onDpr);
    this.dprQuery = null;
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this.onContextRestored
    );
    this.cameras.dispose();
    this.players.dispose();
    this.utility.dispose();
    this.ground.dispose();
    this.effects.dispose();
    this.impacts.dispose();
    this.marks.dispose();
    this.nameTags.dispose();
    this.viewmodel.dispose();
    this.arms.dispose();
    this.unsubscribeSettings();
    this.weapons.dispose();
    this.mapAssets.dispose();
    this.sky.dispose();
    this.lighting.dispose();
    this.post.dispose();
    this.detail.then((t) => t?.dispose());
    this.unsubscribeImages();
    this.renderer.dispose();
    // The context and its drawing buffers go now, not when the canvas is collected: a phone
    // going from demo to demo would hold every left demo's until then, and WebKit loses the
    // oldest context itself at its limit. After `dispose`, which frees three.js's own objects
    // through the context and takes its context-lost listener away. The canvas gives no other
    // context: a new scene needs a new canvas.
    this.renderer.forceContextLoss();
  }

  /**
   * three.js rebuilds its GL state when a lost context comes back but does not draw (and
   * while paused nothing else would), and the post stack's sky copy and the world's shadow
   * were drawn once, into targets that are now blank: make them again, and draw. three.js
   * uploads every texture again from its image, and the GLB textures released theirs after
   * their first upload (images.ts): their images are fetched again first (from the HTTP cache,
   * one GLB at a time, so the restore does not hold every model's file at once), and nothing is
   * drawn until they are back (at most `RESTORE_WAIT_MS`), so nothing shows black. A texture
   * not drawn now gets its image when it is next drawn.
   */
  private readonly onContextRestored = () => {
    if (this.disposed) return;
    this.lighting.invalidateWorldShadow();
    this.sky.restore();
    const restoring = Promise.race([
      restoreImages([this.scene, this.viewmodel.scene]),
      new Promise<void>((r) => setTimeout(r, RESTORE_WAIT_MS)),
    ]);
    this.restoring = restoring;
    void restoring.then(() => {
      if (this.restoring !== restoring) return;
      this.restoring = null;
      this.invalidate();
    });
  };

  /** Schedules one draw on the next animation frame. */
  private readonly invalidate = () => {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  };

  private resize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.width = w;
    this.height = h;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);
    this.post.resize(w, h, this.renderer.getPixelRatio());
    this.cameras.resize(w, h);
    this.players.setViewport(w, h);
    this.invalidate();
  }
}
