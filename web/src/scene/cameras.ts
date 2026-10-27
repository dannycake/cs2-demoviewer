// The two camera modes: POV, the view from the eyes of the player it shows, and Free, a fly
// camera.
//
// Who POV shows is planned in `sim/follow` (`followLegs`), which the store reads too. While the
// director drives POV, the store hands it the director's pick as `follow`, never pinned. Free
// starts from the view drawn last and nothing but its keys move it.

import * as THREE from 'three';
import { eyePoint, viewDir } from '../geo/coords';
import { FLAG, zoomOf, type Pack } from '../pack/types';
import { deathView } from '../sim/deathview';
import {
  followLegs,
  legAt,
  type CameraMode,
  type FollowLeg,
} from '../sim/follow';
import { newPlayerState, type PlayerState } from '../sim/sample';
import { scopeFov, verticalFov } from '../sim/scope';
import { normaliseWeapon } from '../sim/weapons';
import { FlyCam } from './flycam';

/** Where playback is, for the POV camera. */
export interface CameraContext {
  /** Index into `header.rounds`. */
  round: number;
  /** A float tick of that round. */
  tick: number;
  pack: Pack | null;
  /** Who killed `player` in this round (an index into `header.players`), or null. */
  killerOf: (player: number) => number | null;
}

/** Free's vertical field of view in degrees, and the overview's it starts from. */
export const FREE_FOV = 60;
/** CS2's default 90 degree horizontal field of view at 4:3, as a vertical one. */
export const POV_FOV = 73.74;
/**
 * A fly move that starts (a key goes down with none held, or Free is entered with one held)
 * covers at most this many seconds on its first frame: nothing may have been drawn for long
 * before it (paused), so the time since the last draw is not how long the key has been down.
 */
export const FLY_START_S = 1 / 60;
/** Legs kept: a round's worth of players and a few more. */
const LEGS_CACHE = 32;
/** Bounds for an empty scene (no map loaded, or none found): 100 m around the origin. */
export const EMPTY_MAP_BOUNDS = new THREE.Box3(
  new THREE.Vector3(-50, -10, -50),
  new THREE.Vector3(50, 10, 50)
);
const DEG = Math.PI / 180;

export class Cameras {
  mode: CameraMode = 'pov';
  /** Index into `header.players` (and the states passed to `update`). */
  follow: number | null = null;
  /** The user picked `follow`: their death view is held on to the end of the round. */
  pinned = false;
  readonly pov: THREE.PerspectiveCamera;
  readonly free: THREE.PerspectiveCamera;
  readonly fly: FlyCam;
  /** True while a camera is still moving with nothing else changing: draw again. */
  settling = false;
  /**
   * The player the POV camera showed last (the followed player, or after their death and its
   * hold whoever it cut to), or null.
   */
  shown: number | null = null;

  private readonly home: THREE.PerspectiveCamera;
  private aspect = 1;
  private pack: Pack | null = null;
  private readonly legs = new Map<string, FollowLeg[]>();
  /** Whether the POV camera has a pose on the current map yet. */
  private povPlaced = false;
  /** The camera `update` returned last: an unplaced camera starts from it. */
  private last: THREE.PerspectiveCamera;
  /** The mode drawn last; null after a new map, so every mode starts afresh. */
  private lastMode: CameraMode | null = null;
  /** A fly key was held at the last Free frame: the move goes on rather than starting. */
  private flying = false;
  private readonly v = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly dead = newPlayerState();

  constructor(
    renderer: THREE.WebGLRenderer | null,
    domElement: HTMLElement | null,
    mapBounds: THREE.Box3
  ) {
    if (renderer) {
      const size = renderer.getSize(new THREE.Vector2());
      if (size.x > 0 && size.y > 0) this.aspect = size.x / size.y;
    }
    const cam = (fov: number) =>
      new THREE.PerspectiveCamera(fov, this.aspect, 0.05, 1000);
    this.pov = cam(POV_FOV);
    this.free = cam(FREE_FOV);
    this.home = cam(FREE_FOV);
    this.last = this.home;
    this.fly = new FlyCam(this.free, domElement);
    this.setBounds(mapBounds);
  }

  /** The camera of the current mode. */
  get camera(): THREE.PerspectiveCamera {
    return this.mode === 'free' ? this.free : this.pov;
  }

  /** The camera drawn last. */
  get drawn(): THREE.PerspectiveCamera {
    return this.last;
  }

  /**
   * The player whose model to leave out of a draw from the camera `update` returned last, or
   * null: in POV the player it shows, whose model (or body, in their death view) would fill
   * the view from inside.
   */
  hiddenPlayer(): number | null {
    return this.mode === 'pov' ? (this.shown ?? this.follow) : null;
  }

  /**
   * The next entry into Free keeps Free's own pose, from before it was left, instead of taking
   * the view drawn last (`FlyCam.keep`): a reel that left Free goes back to it.
   */
  keepFree(): void {
    this.fly.keep();
  }

  /** A new pack (or none): the legs are made again. */
  setPack(pack: Pack | null): void {
    if (pack === this.pack) return;
    this.pack = pack;
    this.legs.clear();
  }

  /**
   * Fits the far planes and the overview pose (from the radar's bottom edge, 45 degrees
   * down, the whole box in view) to a new map. Every mode starts afresh on it: POV from the
   * overview until it has a player, Free from the overview.
   */
  setBounds(box: THREE.Box3): void {
    const b = box.isEmpty() ? EMPTY_MAP_BOUNDS : box;
    const c = b.getCenter(new THREE.Vector3());
    const radius = Math.max(b.getSize(new THREE.Vector3()).length() / 2, 1);
    const far = Math.max(radius * 8, 100);
    for (const cam of [this.pov, this.free, this.home]) {
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    const vHalf = (this.home.fov / 2) * DEG;
    const hHalf = Math.atan(Math.tan(vHalf) * this.aspect);
    const back = new THREE.Vector3(-1, 1, 0).normalize();
    this.home.position
      .copy(c)
      .addScaledVector(back, radius / Math.sin(Math.min(vHalf, hHalf)));
    this.home.lookAt(c);
    this.home.updateMatrixWorld();
    this.povPlaced = false;
    this.last = this.home;
    this.lastMode = null;
  }

  resize(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
    for (const cam of [this.pov, this.free, this.home]) {
      cam.aspect = this.aspect;
      cam.updateProjectionMatrix();
    }
  }

  /**
   * Moves the camera of the current mode and returns it. `states` are the players at
   * `ctx.tick` (in `header.players` order); `dt` is wall time in seconds since the last draw,
   * for the fly camera. A camera with nobody to show holds where it is, starting from the view
   * drawn last (never the scene origin).
   */
  update(
    states: readonly PlayerState[],
    dt: number,
    ctx: CameraContext
  ): THREE.Camera {
    this.settling = false;
    this.fly.enabled = this.mode === 'free';
    if (ctx.pack !== this.pack) this.setPack(ctx.pack);
    if (this.mode === 'free') {
      const entered = this.lastMode !== 'free';
      if (entered) this.fly.takeFrom(this.last);
      const moved = this.fly.update(
        entered || !this.flying ? Math.min(dt, FLY_START_S) : dt
      );
      this.flying = this.fly.held;
      this.settling = moved || this.flying;
    } else this.updatePov(states, ctx);
    this.lastMode = this.mode;
    return (this.last = this.camera);
  }

  dispose(): void {
    this.fly.dispose();
  }

  /**
   * Places the POV camera at the eye of the player the legs show at the tick, else `follow`'s,
   * narrowed to the scope's field of view when they are scoped in. While that player is dead it
   * holds their death view, at the normal field of view.
   */
  private updatePov(states: readonly PlayerState[], ctx: CameraContext): void {
    const pack = ctx.pack;
    const i =
      (pack ? legAt(this.legsFor(pack, ctx), ctx.tick) : null) ?? this.follow;
    this.shown = i;
    const s = i === null ? undefined : states[i];
    if (s?.present) {
      const weapon = normaliseWeapon(pack?.header.weapons[s.weapon] ?? '');
      const zoom = Math.max(zoomOf(s.gear), s.flags & FLAG.scoped ? 1 : 0);
      const scoped = zoom > 0 ? scopeFov(weapon, zoom) : null;
      this.placePov(s, scoped === null ? POV_FOV : verticalFov(scoped));
      return;
    }
    const track = i === null ? undefined : pack?.rounds[ctx.round]?.players[i];
    const info = pack?.header.rounds[ctx.round];
    const dead =
      pack && track && info
        ? deathView(track, info, ctx.tick, pack.header, this.dead)
        : null;
    if (dead) this.placePov(dead, POV_FOV);
    else this.hold();
  }

  /** The POV camera at `s`'s eye, looking along their view, with field of view `fov`. */
  private placePov(s: PlayerState, fov: number): void {
    eyePoint(s, this.v);
    this.pov.position.copy(this.v);
    this.pov.lookAt(this.v.add(viewDir(s.yaw, s.pitch, this.fwd)));
    if (this.pov.fov !== fov) {
      this.pov.fov = fov;
      this.pov.updateProjectionMatrix();
    }
    this.povPlaced = true;
  }

  private legsFor(pack: Pack, ctx: CameraContext): FollowLeg[] {
    const key = `${ctx.round}:${this.follow}:${this.pinned ? 1 : 0}`;
    let legs = this.legs.get(key);
    if (!legs) {
      legs = followLegs(
        pack,
        ctx.round,
        this.follow,
        this.pinned,
        ctx.killerOf
      );
      if (this.legs.size >= LEGS_CACHE)
        this.legs.delete(this.legs.keys().next().value!);
      this.legs.set(key, legs);
    }
    return legs;
  }

  /** Keeps the POV camera with nobody to show where it is, placing it first if it has no pose. */
  private hold(): void {
    if (this.povPlaced) return;
    this.pov.position.copy(this.last.position);
    this.pov.quaternion.copy(this.last.quaternion);
    this.pov.updateMatrixWorld();
    this.povPlaced = true;
  }
}
