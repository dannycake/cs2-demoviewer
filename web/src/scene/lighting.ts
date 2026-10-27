// The scene's light: a hemisphere sky light and a sun shining at the map's centre from above
// and to the side (from the map's own sun, light.json, when it has a bake), whose orthographic
// shadow box is fitted to the map's bounds. Colours and the sun's intensity come from the
// map's atmosphere; the shadow is off, or 2048² or 4096², as the quality says.
//
// Where the sun is in the bake, the world's shadows are baked and the players' are not, and
// each side needs the other's: a player in a doorway must be out of the sun (the world's
// shadow), and the baked floor must darken under a player (the players' alone: the world's
// own would darken its baked shadows twice). So the shadow is split in two maps of the same
// box: the sun's holds the world and its doors and breakables alone, drawn once and again only
// when something moves it (`drawWorldShadow`: a door swinging, a window breaking), and
// `playerShadow`, a light that lights nothing, holds what casts every frame (the players and
// their weapons), drawn by the renderer. The players take both; the baked world takes
// `playerShadow`'s alone (baked.ts), so a door's shadow never darkens it twice either. The
// world's meshes are also on `WORLD_CASTER_LAYER`, the only layer the sun's shadow camera
// sees, so its map is drawn of the scene itself with nothing but them in it. A sun drawn at
// runtime beside the bake (de_cache's) is split the same way: there the world takes the sun past
// both maps (baked.ts), as the players do, so its world (1.74 M triangles) is drawn into the
// shadow once, not every frame, at `low` too.

import * as THREE from 'three';
import type { Atmosphere } from './atmosphere';
import type { LightInfo } from './baked';

export const HEMI_SKY = '#e6ecf5';
export const HEMI_GROUND = '#9a8f80';
export const HEMI_INTENSITY = 2.6;
export const SUN_COLOR = '#fff2e0';
export const SUN_INTENSITY = 3.6;
/**
 * The sun sits this far from the map's centre, shining at it; farther on tall maps. Along this
 * for a map without its own sun direction, along the map's at this distance with one.
 */
export const SUN_OFFSET: Readonly<THREE.Vector3> = Object.freeze(
  new THREE.Vector3(40, 80, 20)
);
const SUN_DIR: Readonly<THREE.Vector3> = Object.freeze(
  SUN_OFFSET.clone().normalize()
);
/** Depth bias (of the shadow box's 0..1 depth): keeps the big flat floors free of acne. */
export const SHADOW_BIAS = -0.0005;
/** Metres along the normal: keeps the acne off surfaces at a grazing angle to the sun. */
export const SHADOW_NORMAL_BIAS = 0.05;
export const SHADOW_NEAR = 1;
/** The far plane, grown only when a map is too deep along the sun to fit in it. */
export const SHADOW_FAR = 400;
/** The shadow box's half-width, as a fraction of the map's largest side (height included). */
export const SHADOW_EXTENT = 0.6;
/** Slack in metres between the map and the shadow box's sides, near and far planes. */
const SLACK = 1;
/**
 * The least the sun shines while the shadow is split: the baked world's shader knows the
 * players' shadow by its light being black, so a black sun would pass for it and darken the
 * world under its own shadows. Too little to see.
 */
export const SPLIT_SUN_FLOOR = 1e-4;

/**
 * The layer the world and its doors and breakables are on besides the default one, once
 * `drawWorldShadow` has drawn them: the sun's shadow camera sees it alone, so that map holds
 * them and nothing else the scene draws (the players, their weapons, the utility). A camera
 * that draws the scene sees the default layer, so this changes nothing it draws.
 */
export const WORLD_CASTER_LAYER = 1;

export type ShadowSize = 0 | 1024 | 2048 | 4096;

export type LightColors = Pick<
  Atmosphere,
  'sunColor' | 'sunIntensity' | 'hemiSky' | 'hemiGround'
>;

export class Lighting {
  readonly hemi = new THREE.HemisphereLight(
    HEMI_SKY,
    HEMI_GROUND,
    HEMI_INTENSITY
  );
  readonly sun = new THREE.DirectionalLight(SUN_COLOR, SUN_INTENSITY);
  /**
   * Where the shadow is split (`setShadows`), the shadow of what casts every frame: the players
   * and their weapons (the world casts only while `drawWorldShadow` draws it). It stands with the
   * sun and lights nothing: black, which is how the baked world's shader tells its shadow from
   * the sun's where the sun is in the bake (baked.ts). Hidden otherwise, so no other map's
   * shaders count it.
   */
  readonly playerShadow = new THREE.DirectionalLight(0x000000, 0);
  /** The unit direction from the map's centre to the sun. */
  private readonly toSun = SUN_DIR.clone();
  /** Whether the shadow is split in two maps (see the file's head). */
  private split = false;
  /** Whether the sun's map of the world must be drawn again before the next frame. */
  private worldShadowStale = true;
  /** The scene the lights are in, whose shadow `drawWorldShadow` draws. */
  private readonly scene: THREE.Scene;
  /** The lights `drawWorldShadow` draws a map of: the sun alone. */
  private readonly sunOnly: THREE.Light[];
  /**
   * The world and the doors and breakables `casters` was listed from (`listCasters`): listed
   * again only when either is another, so a door's swing walks neither.
   */
  private readonly casterRoots: [THREE.Object3D | null, THREE.Object3D | null] =
    [null, null];
  /** Their meshes, on `WORLD_CASTER_LAYER`: those with an opaque material cast while drawn. */
  private readonly casters: THREE.Mesh[] = [];
  /**
   * An empty scene `drawWorldShadow` renders to draw the world's shadow from its
   * `onAfterRender`: three's shadow pass needs the state a render sets up, and outside one it
   * throws, leaving the shadow map bound as the target.
   */
  private readonly stage = new THREE.Scene();
  /** The renderer the stage's next render draws the world's shadow with, or null. */
  private pending: THREE.WebGLRenderer | null = null;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.sunOnly = [this.sun];
    for (const light of [this.sun, this.playerShadow]) {
      const s = light.shadow;
      s.bias = SHADOW_BIAS;
      s.normalBias = SHADOW_NORMAL_BIAS;
      s.camera.near = SHADOW_NEAR;
      s.camera.far = SHADOW_FAR;
      s.camera.updateProjectionMatrix();
      light.castShadow = false;
    }
    // The world's map holds the world alone (`WORLD_CASTER_LAYER`); in the renderer's own pass
    // every frame (a map without a split shadow) the camera that draws decides what casts.
    this.sun.shadow.camera.layers.set(WORLD_CASTER_LAYER);
    this.playerShadow.visible = false;
    this.stage.onAfterRender = this.drawPending;
    scene.add(
      this.hemi,
      this.sun,
      this.sun.target,
      this.playerShadow,
      this.playerShadow.target
    );
  }

  /** The unit direction from the map's centre towards the sun (`setSun`). */
  get direction(): Readonly<THREE.Vector3> {
    return this.toSun;
  }

  /**
   * How far the vertices of `world` (a scene graph, or one geometry in scene metres such as
   * the map's hull) reach across the view down `dir` (towards the sun; `direction`, or
   * `SUN_OFFSET`'s by default) of the centre of `bounds`: the largest |x| or |y| in the shadow
   * camera's frame, which three.js aims from the sun at its target with +y up. Only the sun's
   * direction matters here, not its distance, so this holds for wherever `fit` puts the sun. A
   * box seen down the sun's slant is wider than its sides, so pass this to `fit` to keep the
   * map's corners in the shadow. It walks every vertex (≈ 4 M in the big maps' worlds; a hull
   * has 124 k triangles on Mirage, 0.96 M on Ancient), once per map; an empty box measures 0.
   */
  static reachOf(
    world: THREE.Object3D | THREE.BufferGeometry,
    bounds: THREE.Box3,
    dir: Readonly<THREE.Vector3> = SUN_DIR
  ): number {
    if (bounds.isEmpty()) return 0;
    if (world instanceof THREE.BufferGeometry) world = new THREE.Mesh(world);
    const centre = bounds.getCenter(new THREE.Vector3());
    const view = new THREE.OrthographicCamera();
    view.position
      .copy(dir)
      .normalize()
      .multiplyScalar(SUN_OFFSET.length())
      .add(centre);
    view.lookAt(centre);
    view.updateMatrixWorld();
    world.updateWorldMatrix(true, true);
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    let reach = 0;
    world.traverse((o) => {
      const mesh = o as THREE.Mesh;
      const pos = mesh.isMesh ? mesh.geometry.getAttribute('position') : null;
      if (!pos) return;
      // Only the view's x and y rows: the light-space x and y of each world vertex.
      const e = m.multiplyMatrices(
        view.matrixWorldInverse,
        mesh.matrixWorld
      ).elements;
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i);
        const x = e[0] * p.x + e[4] * p.y + e[8] * p.z + e[12];
        const y = e[1] * p.x + e[5] * p.y + e[9] * p.z + e[13];
        reach = Math.max(reach, Math.abs(x), Math.abs(y));
      }
    });
    return reach;
  }

  /**
   * The direction the sun shines from: the map's own (light.json's `sun.dir`, towards the sun
   * in scene axes), or `SUN_OFFSET`'s for null. The sun turns about its target at once, at the
   * same distance; `fit` (and `reachOf` with `direction`) must run again to fit the shadow box
   * to the map along it. Its colour and intensity are the atmosphere's (`setColors`).
   */
  setSun(sun: LightInfo['sun']): void {
    if (sun) this.toSun.fromArray(sun.dir).normalize();
    else this.toSun.copy(SUN_DIR);
    const target = this.sun.target.position;
    const distance = Math.max(
      this.sun.position.distanceTo(target),
      SUN_OFFSET.length()
    );
    this.sun.position.copy(this.toSun).multiplyScalar(distance).add(target);
    this.followSun();
  }

  /**
   * Aims the sun at the centre of `bounds` from its direction (`setSun`) and fits the
   * shadow box to them: ±`SHADOW_EXTENT` of the largest side across (so Vertigo's tower
   * counts), grown to `reach` (from `reachOf`) and a metre when the map's vertices reach
   * farther across the sun's view than that, and deep enough to hold the whole box, the sun
   * moved back along its direction when the box would reach past it. An empty box changes
   * nothing.
   */
  fit(bounds: THREE.Box3, reach = 0): void {
    if (bounds.isEmpty()) return;
    const centre = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const dir = this.toSun;
    // How far the box reaches from its centre towards the sun (and away from it).
    const depthHalf =
      (Math.abs(size.x * dir.x) +
        Math.abs(size.y * dir.y) +
        Math.abs(size.z * dir.z)) /
      2;
    const offset = SUN_OFFSET.length();
    const distance = Math.max(offset, depthHalf + SHADOW_NEAR + SLACK);
    this.sun.position.copy(dir).multiplyScalar(distance).add(centre);
    this.sun.target.position.copy(centre);

    const extent = Math.max(
      Math.max(size.x, size.y, size.z) * SHADOW_EXTENT,
      reach + SLACK
    );
    const cam = this.sun.shadow.camera;
    cam.left = -extent;
    cam.right = extent;
    cam.bottom = -extent;
    cam.top = extent;
    cam.near = SHADOW_NEAR;
    cam.far = Math.max(SHADOW_FAR, distance + depthHalf + SLACK);
    cam.updateProjectionMatrix();
    this.followSun();
  }

  /**
   * The sun's and the sky's colours, and the sun's intensity, from the map's atmosphere; with
   * `sun` false (a bake without a sun: Train's) the sun is dark, for the players and the
   * viewmodel too.
   */
  setColors(c: Readonly<LightColors>, sun = true): void {
    this.sun.color.set(c.sunColor);
    this.sun.intensity = sun ? c.sunIntensity : 0;
    this.hemi.intensity = HEMI_INTENSITY;
    this.hemi.color.set(c.hemiSky);
    this.hemi.groundColor.set(c.hemiGround);
    this.keepSplitSunLit();
  }

  /**
   * The sun of a map with a bake (light.json's `sun`): its linear colour at π times its
   * brightness, which is how the bake lit the world's sunlit surfaces (a Lambert without π,
   * against three's 1/π). Where the sun is in the bake the players and the viewmodel take it;
   * where it is not (de_cache) the world takes it too, beside its irradiance-only lightmap. The
   * direction is `setSun`'s; the sky light stays the atmosphere's.
   */
  setBakedSun(sun: NonNullable<LightInfo['sun']>): void {
    this.sun.color.setRGB(sun.color[0], sun.color[1], sun.color[2]);
    this.sun.intensity = Math.PI * sun.intensity;
    this.keepSplitSunLit();
  }

  /**
   * Shadows of `size`² texels, or none for 0. `split` (a map with a bake and a sun, in the bake
   * or drawn beside it) splits them in two maps of that size (see the file's head): the sun's of
   * the world, drawn by `drawWorldShadow`, and `playerShadow`'s of the rest, every frame.
   * Otherwise the sun's one map holds everything that casts, every frame. The renderer allocates
   * a shadow map on the next draw and never resizes it itself, so a size change frees the old one
   * here, and the players' map is freed when the shadow is no longer split.
   */
  setShadows(
    size: ShadowSize,
    renderer: THREE.WebGLRenderer,
    split = false
  ): void {
    const on = size > 0;
    const mapSize = this.sun.shadow.mapSize;
    if (!on || mapSize.x !== size || mapSize.y !== size) {
      freeShadowMap(this.sun);
      freeShadowMap(this.playerShadow);
    }
    this.split = on && split;
    if (!this.split) freeShadowMap(this.playerShadow);
    if (on) {
      mapSize.set(size, size);
      this.playerShadow.shadow.mapSize.set(size, size);
    }
    this.sun.castShadow = on;
    this.sun.shadow.autoUpdate = !this.split;
    this.playerShadow.castShadow = this.split;
    this.playerShadow.visible = this.split;
    this.worldShadowStale = true;
    renderer.shadowMap.enabled = on;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.keepSplitSunLit();
  }

  /** While the shadow is split, the sun is never black (`SPLIT_SUN_FLOOR`). */
  private keepSplitSunLit(): void {
    if (!this.split) return;
    const c = this.sun.color;
    if (!(Math.max(c.r, c.g, c.b) > 0)) c.setRGB(1, 1, 1);
    if (!(this.sun.intensity >= SPLIT_SUN_FLOOR))
      this.sun.intensity = SPLIT_SUN_FLOOR;
  }

  /**
   * The world's shadow must be drawn again: the world, its doors and breakables (one moved,
   * broke or came or went), their materials or the GL context changed.
   */
  invalidateWorldShadow(): void {
    this.worldShadowStale = true;
  }

  /**
   * Where the shadow is split, draws the sun's map of `world` (the map's world, or null for
   * none yet) and `movables` (its doors and breakables as they stand now, or null for none)
   * when it is stale: once per map, preset, sun or context, and again on a frame a door or
   * window changed (`invalidateWorldShadow`), not every frame. Their opaque meshes cast only
   * while it is drawn, so the renderer's own pass, every frame, puts only the players in
   * `playerShadow`'s map. Their meshes are listed once per pair of roots (`listCasters`), so a
   * door's swing walks neither root and makes nothing. Run it before the frame is drawn (it
   * clears the current target); otherwise it does nothing. A lost context draws nothing and
   * leaves it stale. Where the shadow is not split, the last roots are forgotten instead
   * (taken off `WORLD_CASTER_LAYER` and out of the list), so a world the scene dropped is not
   * kept alive here. Returns whether it drew.
   */
  drawWorldShadow(
    renderer: THREE.WebGLRenderer,
    world: THREE.Object3D | null,
    movables: THREE.Object3D | null = null
  ): boolean {
    if (!this.split) {
      this.listCasters(null, null);
      return false;
    }
    if (!this.worldShadowStale) return false;
    this.listCasters(world, movables);
    this.pending = renderer;
    renderer.render(this.stage, this.sun.shadow.camera);
    this.pending = null;
    return !this.worldShadowStale;
  }

  /**
   * Lists the meshes of `world` and `movables` in `casters` and puts them on
   * `WORLD_CASTER_LAYER`, taking the last roots' off it, when either root is not the one listed
   * last; otherwise nothing.
   */
  private listCasters(
    world: THREE.Object3D | null,
    movables: THREE.Object3D | null
  ): void {
    const had = this.casterRoots;
    if (had[0] === world && had[1] === movables) return;
    for (const m of this.casters) m.layers.disable(WORLD_CASTER_LAYER);
    this.casters.length = 0;
    had[0] = world;
    had[1] = movables;
    const list = (o: THREE.Object3D) => {
      if (!(o as THREE.Mesh).isMesh) return;
      o.layers.enable(WORLD_CASTER_LAYER);
      this.casters.push(o as THREE.Mesh);
    };
    world?.traverse(list);
    movables?.traverse(list);
  }

  /**
   * The stage's `onAfterRender`: the world's shadow, inside the render three set up. three's
   * shadow pass (r186 `WebGLShadowMap.render` → `renderObject`) walks the scene it is given by
   * `children` from its root, skips a hidden object and what is under it, and draws a mesh
   * only when it casts and its `layers` share one with the camera it is handed, here the sun's
   * shadow camera, which sees `WORLD_CASTER_LAYER` alone: the world and its doors and
   * breakables, as they stand (a broken window is hidden), and nothing else in the scene.
   */
  private readonly drawPending = (): void => {
    const renderer = this.pending;
    if (!renderer) return;
    this.pending = null;
    this.worldShadowStale = false;
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
    // A door turned this frame, before the frame's own render updates the matrices.
    this.casterRoots[0]?.updateMatrixWorld();
    this.casterRoots[1]?.updateMatrixWorld();
    const casters = this.casters;
    for (let i = 0; i < casters.length; i++)
      casters[i].castShadow = opaque(casters[i]);
    this.sun.shadow.needsUpdate = true;
    try {
      renderer.shadowMap.render(
        this.sunOnly,
        this.scene,
        this.sun.shadow.camera
      );
    } finally {
      for (let i = 0; i < casters.length; i++) casters[i].castShadow = false;
    }
  };

  /** Takes the lights out of the scene and frees the shadow maps. */
  dispose(): void {
    freeShadowMap(this.sun);
    freeShadowMap(this.playerShadow);
    this.hemi.removeFromParent();
    this.sun.removeFromParent();
    this.sun.target.removeFromParent();
    this.playerShadow.removeFromParent();
    this.playerShadow.target.removeFromParent();
    this.sun.dispose();
    this.playerShadow.dispose();
    this.hemi.dispose();
  }

  /** Puts `playerShadow` where the sun is, with its shadow box; the world's map is stale. */
  private followSun(): void {
    const p = this.playerShadow;
    p.position.copy(this.sun.position);
    p.target.position.copy(this.sun.target.position);
    const from = this.sun.shadow.camera;
    const cam = p.shadow.camera;
    cam.left = from.left;
    cam.right = from.right;
    cam.bottom = from.bottom;
    cam.top = from.top;
    cam.near = from.near;
    cam.far = from.far;
    cam.updateProjectionMatrix();
    this.worldShadowStale = true;
  }
}

/** Frees `light`'s shadow map, which the renderer makes again on the next draw that needs it. */
function freeShadowMap(light: THREE.DirectionalLight): void {
  const s = light.shadow;
  if (s.map) {
    s.map.depthTexture?.dispose();
    s.map.depthTexture = null;
    s.map.dispose();
    s.map = null;
  }
  if (s.mapPass) {
    s.mapPass.dispose();
    s.mapPass = null;
  }
}

/**
 * Lets every mesh under `root` receive the sun's shadow and, with `cast`, every mesh with an
 * opaque or cut-out material cast it. Glass, decals and puddles (blended, transparent) cast
 * none. A baked world casts none (`cast` false) but while `Lighting.drawWorldShadow` draws it:
 * the renderer's pass every frame must hold the players' alone (the world's own shadows are
 * baked, or, under de_cache's live sun, in the world's map drawn once).
 */
export function castAndReceive(root: THREE.Object3D, cast = true): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
    mesh.castShadow = cast && opaque(mesh);
  });
}

/** Whether any of `mesh`'s materials is opaque or cut out: what casts the sun's shadow. */
function opaque(mesh: THREE.Mesh): boolean {
  const m = mesh.material;
  if (!Array.isArray(m)) return !m.transparent;
  for (let i = 0; i < m.length; i++) if (!m[i].transparent) return true;
  return false;
}
