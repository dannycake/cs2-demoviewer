// First person: the followed player's arms holding their weapon, drawn after the scene by a
// camera of its own over a cleared depth buffer, so they never clip into a wall. The arms are
// the team's arms model played by the weapon's own viewmodel clips (arms.ts; which clip at
// what time is `firstPersonPose`, sim/firstperson.ts), the gun on their `wpn` bone as third
// person holds it, at the game's viewmodel offset from the eye, with a bob with the stride;
// nothing while scoped or dead. Until the arms or the weapon's clips are in (or when the server
// has none), the gun is drawn alone, placed from the player's actions: a kick on each shot, a
// rise on a draw, a dip and tilt over a reload (`viewmodelPose`). Lit by copies of the scene's
// hemisphere and sun, the sun turned into the view's frame, without shadows; on a map with a
// light grid, by the grid at the shown player in place of the hemisphere, and the sun as far
// as the sample says it reaches the eye (probes.ts; Scene fills it). The gun's muzzle (`muzzle`)
// is where the player's own shots flash (impacts.ts).

import * as THREE from 'three';
import type { Action } from '../sim/actions';
import { BOB, firstPersonPose } from '../sim/firstperson';
import { verticalFov } from '../sim/scope';
import type { Family } from '../sim/weapons';
import {
  ArmsRig,
  armsSide,
  placeRig,
  ARMS_OFFSET,
  type ArmsCache,
  type ArmsOffset,
} from './arms';
import type { LookMaterial, LookOptions } from './look';
import { attachProbe, detachProbe, type ProbeSample } from './probes';
import {
  attachOf,
  cloneWeapon,
  muzzleOf,
  weaponModelName,
  type WeaponCache,
} from './weapons';

export { BOB };

export interface ViewmodelOffset {
  right: number;
  down: number;
  forward: number;
  /** Degrees about X, Y, Z: the inward turn that shows the weapon's side; the knife tipped forward. */
  turn: [number, number, number];
}

/**
 * The gun drawn alone (no arms or clips yet): where each family's weapon sits from the eye
 * (metres, to its `weapon` bone: the point the game holds it by, `userData.attach`) and how it
 * is turned; tuned by eye on Mirage in POV
 * (2026-10-22) with the AK, the Glock, the knife, the HE and the c4, and moved onto the bone
 * when the models gained it, so those five stay where they were tuned. The plan's first guesses
 * held the guns at a quarter of a metre, where a pistol filled a third of the screen.
 */
export const VIEWMODEL_OFFSETS: Readonly<Record<Family, ViewmodelOffset>> = {
  rifle: { right: 0.141, down: 0.072, forward: 0.432, turn: [2, -5, 0] },
  pistol: { right: 0.136, down: 0.083, forward: 0.484, turn: [1, -8, 0] },
  knife: { right: 0.158, down: 0.164, forward: 0.351, turn: [-62, -10, 8] },
  grenade: { right: 0.13, down: 0.15, forward: 0.34, turn: [0, -10, 0] },
  c4: { right: 0.219, down: 0.098, forward: 0.324, turn: [10, -10, 0] },
};

/** The viewmodel camera's field of view, 4:3 degrees like the game's `viewmodel_fov`. */
export const VIEWMODEL_FOV = 68;
/** A shot: back and up over `riseS`, settling over `settleS`. */
export const KICK = { back: 0.03, upDeg: 2.5, riseS: 0.05, settleS: 0.15 };
/** A draw starts this far below and rises over the draw. */
export const DRAW_DROP = 0.25;
/** A reload dips and tilts, deepest halfway through. */
export const RELOAD = { dip: 0.08, tiltDeg: 20 };

const DEG = Math.PI / 180;

export interface ViewmodelInput {
  family: Family;
  /** The followed player's actions at `tick`, newest first (`ActionIndex.at`). */
  actions: readonly Action[];
  tick: number;
  tickRate: number;
  /** The stride's phase, 0 to 1. */
  stride: number;
  /** How much of the bob shows, 0 to 1 (`strideBob`); all of it when left out. */
  bobWeight?: number;
  scoped: boolean;
  alive: boolean;
}

/** What `Viewmodel.show` draws: the followed player at a tick. */
export interface ViewmodelFrame extends ViewmodelInput {
  /** The weapon held, normalised; `team` picks the knife and the arms (2 T, 3 CT). */
  weapon: string;
  team: number;
  /**
   * The player's actions that started in the last `LOOKBACK_S` (`ActionIndex.recent`), finished
   * or not, newest first: the clips outlast the actions.
   */
  recent: readonly Action[];
  /** Seconds since the round's start: the idle clip's clock. */
  clock: number;
}

export interface ViewmodelPose {
  /** Metres in the viewmodel camera's frame. */
  position: [number, number, number];
  /** Radians, XYZ Euler, on top of the model facing −Z. */
  rotation: [number, number, number];
  visible: boolean;
}

const HIDDEN: ViewmodelPose = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  visible: false,
};

/** 0 → 1 → 0: up over `riseS`, back down over `settleS`. */
function kick(t: number): number {
  if (t < 0) return 0;
  if (t < KICK.riseS) return t / KICK.riseS;
  return Math.max(0, 1 - (t - KICK.riseS) / KICK.settleS);
}

const smooth = (p: number) => p * p * (3 - 2 * p);

/** Where the weapon is drawn for `i`; a pure function of it. */
export function viewmodelPose(i: ViewmodelInput): ViewmodelPose {
  if (!i.alive || i.scoped) return HIDDEN;
  const o = VIEWMODEL_OFFSETS[i.family];
  const x = o.right;
  let y = -o.down + BOB * (i.bobWeight ?? 1) * Math.sin(2 * Math.PI * i.stride);
  let z = -o.forward;
  let pitch = 0;
  let roll = 0;
  const seen = new Set<Action['kind']>();
  for (const a of i.actions) {
    if (seen.has(a.kind)) continue;
    seen.add(a.kind);
    const t = (i.tick - a.startTick) / i.tickRate;
    const d = a.durationTicks / i.tickRate;
    if (a.kind === 'shoot') {
      const k = kick(t);
      z += KICK.back * k;
      pitch += KICK.upDeg * DEG * k;
    } else if (a.kind === 'draw' && t >= 0 && t < d) {
      y -= DRAW_DROP * (1 - smooth(t / d));
    } else if (a.kind === 'reload' && t >= 0 && t < d) {
      const k = Math.sin((Math.PI * t) / d);
      y -= RELOAD.dip * k;
      roll += RELOAD.tiltDeg * DEG * k;
    }
  }
  const [tx, ty, tz] = o.turn;
  return {
    position: [x, y, z],
    rotation: [tx * DEG + pitch, ty * DEG, tz * DEG + roll],
    visible: true,
  };
}

/** The weapon models face +Z with +Y up; the viewmodel camera looks down −Z. */
const FACE_FORWARD = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 1, 0),
  Math.PI
);
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** The tangent of half a field of view of `deg` degrees. */
const tanHalf = (deg: number) => Math.tan((deg * Math.PI) / 360);

/**
 * A point of the viewmodel's frame (`p`: the viewmodel camera at the origin, looking down −Z),
 * into `out` in the scene where a camera of field of view `fov` placed by `cameraWorld` shows it
 * on the same pixel: at the same depth, its x and y spread by tan(fov/2) / tan(viewmodelFov/2)
 * (both cameras have the canvas's aspect), then placed by the camera. Returns that ratio: how
 * much bigger than life the viewmodel draws what is there.
 */
export function viewmodelToScene(
  p: THREE.Vector3,
  viewmodelFov: number,
  fov: number,
  cameraWorld: THREE.Matrix4,
  out: THREE.Vector3
): number {
  const k = tanHalf(fov) / tanHalf(viewmodelFov);
  out.set(p.x * k, p.y * k, p.z).applyMatrix4(cameraWorld);
  return k;
}

export class Viewmodel {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(
    verticalFov(VIEWMODEL_FOV),
    1,
    0.01,
    10
  );
  readonly hemi = new THREE.HemisphereLight();
  readonly sun = new THREE.DirectionalLight();
  /** The world's up in the view's frame (`matchLights`), which the light grid is mixed along. */
  readonly zenith = new THREE.Vector3(0, 1, 0);
  /** The light grid's sample at the shown player (`setProbe`), or null for the sky light. */
  private probe: ProbeSample | null = null;
  private readonly weapons: WeaponCache;
  private readonly arms: ArmsCache | null;
  private readonly offset: Readonly<ArmsOffset>;
  private look: LookOptions;
  /** Clones by model name for the gun drawn alone; one shown at a time. */
  private readonly held = new Map<string, THREE.Object3D>();
  private readonly materials: LookMaterial[] = [];
  /** One rig per team side, made the first time it is shown. */
  private readonly rigs = new Map<string, ArmsRig>();
  private shown: THREE.Object3D | null = null;
  /** The gun drawn now, alone or in the hands, or null, and its model. */
  private gun: THREE.Object3D | null = null;
  private gunModel = '';

  constructor(
    weapons: WeaponCache,
    look: LookOptions,
    arms: ArmsCache | null = null,
    offset: Readonly<ArmsOffset> = ARMS_OFFSET
  ) {
    this.weapons = weapons;
    this.arms = arms;
    this.offset = offset;
    this.look = look;
    this.scene.add(this.hemi, this.sun, this.sun.target);
  }

  /** Whether anything is drawn now: the arms, or the gun alone; not while scoped or dead. */
  get visible(): boolean {
    return this.shown !== null;
  }

  /** The arms rig shown, if the arms are drawn now (for the tests and the e2e). */
  get rig(): ArmsRig | null {
    for (const r of this.rigs.values()) if (r.root === this.shown) return r;
    return null;
  }

  /**
   * Shows frame `f`: the team's arms playing the weapon's clips with the gun in their hands
   * when the arms, the clips and the gun are all in (each is asked for here, together), else
   * the gun alone at `viewmodelPose`.
   */
  show(f: ViewmodelFrame): void {
    const model = weaponModelName(f.weapon, f.team);
    const side = armsSide(f.team);
    const template =
      model && side && this.arms ? this.arms.armsFor(f.team) : null;
    const set = model && side && this.arms ? this.arms.clips(model) : null;
    const gun = model ? this.weapons.get(model) : null;
    const pose =
      template && set && gun
        ? firstPersonPose(
            {
              weapon: f.weapon,
              actions: f.recent,
              tick: f.tick,
              tickRate: f.tickRate,
              clock: f.clock,
              stride: f.stride,
              bobWeight: f.bobWeight,
              scoped: f.scoped,
              alive: f.alive,
            },
            set.lengths
          )
        : null;
    if (!template || !set || !gun || !pose || !side || !model) {
      for (const r of this.rigs.values()) r.root.visible = false;
      this.set(f.weapon, f.team, viewmodelPose(f));
      return;
    }
    for (const c of this.held.values()) c.visible = false;
    let rig = this.rigs.get(side);
    if (!rig) {
      rig = new ArmsRig(template, this.look);
      this.scene.add(rig.root);
      this.rigs.set(side, rig);
    }
    for (const r of this.rigs.values())
      r.root.visible = r === rig && pose.visible;
    this.shown = pose.visible ? rig.root : null;
    this.gun = null;
    if (!pose.visible) return;
    placeRig(rig.root, this.offset, pose.bob);
    rig.pose(set, pose.layers);
    rig.hold(model, gun, f.family);
    this.gun = rig.gun;
    this.gunModel = model;
  }

  /**
   * Shows `weapon` (a normalised name; `team` picks the knife) alone at `pose`: nothing for no
   * weapon, a model not loaded yet (asked for) or failed, or a hidden pose.
   */
  set(weapon: string, team: number, pose: ViewmodelPose): void {
    const name = pose.visible ? weaponModelName(weapon, team) : null;
    const o = name ? this.clone(name) : null;
    for (const c of this.held.values()) c.visible = c === o;
    this.shown = o;
    this.gun = o;
    this.gunModel = name ?? '';
    if (!o) return;
    _q.setFromEuler(_e.set(...pose.rotation));
    o.quaternion.copy(_q).multiply(FACE_FORWARD);
    // The `weapon` bone (a point of the model) at the pose; a model without it, its origin.
    const a = attachOf(o);
    o.position.set(...pose.position);
    if (a)
      o.position.sub(_a.set(...a.translation).applyQuaternion(o.quaternion));
  }

  /**
   * The muzzle of the gun drawn now (`muzzleOf`), into `out`, in the viewmodel camera's frame
   * (metres; the camera at the origin, looking down −Z), as the last `show` or `set` posed it;
   * false when no gun is drawn (scoped, dead, not loaded yet).
   */
  muzzle(out: THREE.Vector3): boolean {
    const gun = this.gun;
    if (!gun || !gun.visible) return false;
    gun.updateWorldMatrix(true, false);
    out.copy(muzzleOf(gun, this.gunModel)).applyMatrix4(gun.matrixWorld);
    return true;
  }

  /** Lights the weapon as the world is lit: the scene's colours, the sun from where `view` looks. */
  matchLights(
    hemi: THREE.HemisphereLight,
    sun: THREE.DirectionalLight,
    view: THREE.Camera
  ): void {
    this.hemi.color.copy(hemi.color);
    this.hemi.groundColor.copy(hemi.groundColor);
    this.hemi.intensity = hemi.intensity;
    this.sun.color.copy(sun.color);
    this.sun.intensity = sun.intensity;
    const dir = sun
      .getWorldPosition(_a)
      .sub(sun.target.getWorldPosition(_b))
      .normalize();
    dir.applyQuaternion(view.getWorldQuaternion(_q).invert());
    this.zenith.set(0, 1, 0).applyQuaternion(_q);
    this.sun.position.copy(dir).multiplyScalar(10);
    this.sun.target.position.set(0, 0, 0);
    this.sun.updateMatrixWorld();
    this.sun.target.updateMatrixWorld();
  }

  /**
   * Lights the arms and the gun by `s`, the light grid at the player shown with the sun as the
   * eye sees it (filled in place each frame), from the next draw; null lights them by the sky
   * light.
   */
  setProbe(s: ProbeSample | null): void {
    this.probe = s;
  }

  /** Draws over what the renderer holds (colour kept, depth cleared); nothing when hidden. */
  render(renderer: THREE.WebGLRenderer, aspect: number): void {
    if (!this.shown) return;
    // The arms and guns are made as they are first shown: light whatever is there now.
    this.scene.traverse(this.light);
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
    renderer.autoClear = autoClear;
  }

  /** Re-dresses in `look`: the clones are made again on next use. */
  setLook(look: LookOptions): void {
    this.look = look;
    this.drop();
  }

  dispose(): void {
    this.drop();
    this.scene.remove(this.hemi, this.sun, this.sun.target);
  }

  private drop(): void {
    for (const r of this.rigs.values()) r.dispose();
    this.rigs.clear();
    for (const o of this.held.values()) o.removeFromParent();
    this.held.clear();
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
    this.shown = null;
    this.gun = null;
  }

  /** Lights `o`'s lit materials by the probe, or by the sky light without one. */
  private readonly light = (o: THREE.Object3D): void => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    if (!Array.isArray(m)) this.lightMaterial(m);
    else for (let i = 0; i < m.length; i++) this.lightMaterial(m[i]);
  };

  private lightMaterial(m: THREE.Material): void {
    if (!(m instanceof THREE.MeshLambertMaterial)) return;
    if (this.probe) attachProbe(m, this.probe, this.zenith);
    else detachProbe(m);
  }

  private clone(name: string): THREE.Object3D | null {
    const have = this.held.get(name);
    if (have) return have;
    const src = this.weapons.get(name);
    if (!src) return null;
    const o = cloneWeapon(src, this.look, this.materials, false);
    o.name = `weapon:${name}`;
    this.scene.add(o);
    this.held.set(name, o);
    return o;
  }
}
