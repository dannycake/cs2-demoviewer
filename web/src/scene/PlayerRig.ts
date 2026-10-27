// One player's animated model, posed in layers: looping locomotion (directional strides, idle,
// crouch, air, ladder, turns), the held weapon's own grip added over it, then actions (reloads,
// draws, knife swings, throws on the upper body; planting and defusing on the whole body; gun
// recoil and flinches added on top), then the aim (the spine bends with the pitch), then a
// death (knees give, the body falls away from the shot, lies, fades). Its pose is set, not advanced: every `apply` writes every action's weight and
// time from its input and evaluates the mixer at zero delta, so the result depends on the
// input alone, never on the previous call.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { toScene, yawToRotationY } from '../geo/coords';
import { FLAG, type MatchHeader } from '../pack/types';
import type { Action } from '../sim/actions';
import {
  ACTION_IN_S,
  ACTION_OUT_S,
  FLASH_IN_S,
  FLASH_OUT_S,
  FLINCH_IN_S,
  FLINCH_OUT_S,
  HEAD_SNAP_DEG,
  LIVING,
  SHOOT_IN_S,
  SHOOT_OUT_S,
  deathPhase,
  envelope,
  hitFlash,
} from '../sim/anim';
import { WEAPON_CLIP_SUFFIX, weaponClip, type Family } from '../sim/weapons';
import { TEAM_HEX } from './colors';
import type { RigInput } from './frame';
import type { RigTemplate } from './loaders';
import {
  UNLIT_LOOK,
  modelDresser,
  type LookMaterial,
  type LookOptions,
} from './look';
import {
  OUTLINE,
  OutlineMaterials,
  outlineMeshes,
  type OutlineColor,
} from './outline';
import { attachProbe, detachProbe, type ProbeSample } from './probes';
import {
  C4_BACK_OFFSET,
  cloneWeapon,
  muzzleOf,
  placeHeld,
  placeHold,
  weaponModelName,
  type WeaponCache,
} from './weapons';

export type Team = 2 | 3;

/** How far the team colour is lightened towards white before it tints the texture. */
export const TINT_TO_WHITE = 0.55;

/**
 * How much an overriding action outweighs the locomotion under it. three.js averages every
 * playing clip by weight, so an action at this weight over a locomotion summing to 1 owns
 * 24/25 = 96% of the bones it animates.
 */
export const DOMINANCE = 24;

/** Bones an upper-body action moves: the spine above the hips, the head, arms, hands, weapon. */
const UPPER_BODY =
  /^(spine_[123]|neck_0|head_0|clavicle_|scapula_|scap_|arm_|hand_|finger_|wpn)/;

export function isUpperBodyBone(name: string): boolean {
  return UPPER_BODY.test(name);
}

/** `clip` with only the tracks of bones `keep` accepts. */
export function makeUpperBodyClip(
  clip: THREE.AnimationClip,
  keep: (bone: string) => boolean = isUpperBodyBone
): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) =>
    keep(t.name.slice(0, t.name.lastIndexOf('.')))
  );
  return new THREE.AnimationClip(`${clip.name}#upper`, clip.duration, tracks);
}

/** The aim: how the pitch is shared down the spine, parent first. */
export const AIM_SHARE: readonly [string, number][] = [
  ['spine_1', 0.4],
  ['spine_2', 0.3],
  ['spine_3', 0.2],
  ['neck_0', 0.1],
];
export const AIM_LIMIT_DEG = 60;

const WHITE = new THREE.Color(0xffffff);
/** What a full hit flash multiplies the team tint by: red kept, green and blue mostly gone. */
const HIT_RED = new THREE.Color(1, 0.3, 0.3);
/** A lit model's red glow at a full hit flash, so it shows in the shade too. */
const HIT_GLOW = 0.08;
const _c = new THREE.Color();
const X = new THREE.Vector3(1, 0, 0);
const _axis = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
/** The rig's right-left axis in the world (`rigSideAxis`), and its rotation on the way. */
const _side = new THREE.Vector3();
const _rootQ = new THREE.Quaternion();

/**
 * Turns `bone` by `rad` about `worldAxis`, whatever its parents' rotation: the axis is carried
 * into the parent's frame and the turn applied before the bone's own rotation. The world
 * matrices under `bone` are left as they were: the parent's world rotation is read afresh
 * (`getWorldQuaternion` updates the bone's ancestors), so turns down a chain of bones need no
 * update between them; the caller updates the subtree once after the last.
 */
export function rotateBoneWorld(
  bone: THREE.Object3D,
  worldAxis: THREE.Vector3,
  rad: number
): void {
  if (rad === 0) return;
  if (bone.parent) bone.parent.getWorldQuaternion(_pq).invert();
  else _pq.identity();
  _axis.copy(worldAxis).applyQuaternion(_pq).normalize();
  bone.quaternion.premultiply(_q.setFromAxisAngle(_axis, rad));
}

/** The rig's own right-left axis (its +X) in the world, in a scratch vector. */
function rigSideAxis(root: THREE.Object3D): THREE.Vector3 {
  return _side.copy(X).applyQuaternion(root.getWorldQuaternion(_rootQ));
}

/**
 * Bends the spine by `pitchDeg` (CS pitch: positive looks down), shared by AIM_SHARE and
 * clamped to ±AIM_LIMIT_DEG, about the rig's own right-left axis. The model faces +Z, so its
 * +X is its left and a positive turn about it tips the chest forward and down.
 */
export function applyAim(
  bones: ReadonlyMap<string, THREE.Object3D>,
  root: THREE.Object3D,
  pitchDeg: number
): void {
  const pitch =
    (Math.max(-AIM_LIMIT_DEG, Math.min(AIM_LIMIT_DEG, pitchDeg)) * Math.PI) /
    180;
  if (pitch === 0) return;
  const axis = rigSideAxis(root);
  for (const [name, share] of AIM_SHARE) {
    const bone = bones.get(name);
    if (bone) rotateBoneWorld(bone, axis, pitch * share);
  }
  // Once for the turned spine and all it carries (the arms, the head, the gun).
  root.updateMatrixWorld(true);
}

/**
 * How a clip is played: whole (`full`); its upper-body bones replacing the pose under them
 * (`upper`); added on top as the change from its own first frame, every bone (`additive`) or
 * the upper body's only (`recoil`); or its upper-body bones added on top as the change from
 * the reference pose (`pose`).
 */
type Variant = 'full' | 'upper' | 'additive' | 'recoil' | 'pose';

/** The variants mixed by adding to the pose under them rather than averaging with it. */
const ADDED: ReadonlySet<Variant> = new Set(['additive', 'recoil', 'pose']);

interface Layer {
  variant: Variant;
  /** One action plays per slot at a time: the newest. */
  slot: string;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

/**
 * The clip whose first frame is the pose the game's delta clips are made against. Those clips
 * (every gun's `shoot_*`, the weapons' own `idle_*`, `idle_c4`, `idle_grenade`,
 * `idle_molotov`) keep most bones at that pose and only mean something added onto a full one:
 * played as poses, they throw the arms out to the bind pose. Measured on the CS2 models, its
 * first frame matches every gun shoot clip's within 1° on the body and weapon bones.
 */
export const REFERENCE_POSE_CLIP = 'breathing';

/** Which layer an action plays on, and how it fades. */
function actionLayer(a: Action): Layer {
  const slotted = (l: Omit<Layer, 'slot'>): Layer => ({
    ...l,
    slot: l.variant,
  });
  switch (a.kind) {
    case 'shoot':
      // A gun's shoot clip is recoil: added from its first frame, on its own slot so that a
      // flinch at the same moment does not cancel it. A knife swing or a throw is a whole
      // upper-body move.
      if (a.clip.startsWith('shoot_'))
        return {
          variant: 'recoil',
          slot: 'recoil',
          fadeIn: SHOOT_IN_S,
          fadeOut: SHOOT_OUT_S,
          loop: false,
        };
      return slotted({
        variant: 'upper',
        fadeIn: SHOOT_IN_S,
        fadeOut: SHOOT_OUT_S,
        loop: false,
      });
    case 'flashed':
      return slotted({
        variant: 'upper',
        fadeIn: FLASH_IN_S,
        fadeOut: FLASH_OUT_S,
        loop: false,
      });
    case 'flinch':
      return slotted({
        variant: 'additive',
        fadeIn: FLINCH_IN_S,
        fadeOut: FLINCH_OUT_S,
        loop: false,
      });
    case 'plant':
    case 'defuse':
      return slotted({
        variant: 'full',
        fadeIn: ACTION_IN_S,
        fadeOut: ACTION_OUT_S,
        loop: true,
      });
    default:
      return slotted({
        variant: 'upper',
        fadeIn: ACTION_IN_S,
        fadeOut: ACTION_OUT_S,
        loop: false,
      });
  }
}

/**
 * The delta clip that turns the family's locomotion into this weapon's own grip, played as a
 * `pose`: the weapon's `idle_*` when it has per-weapon clips, `idle_c4`, `idle_grenade` or
 * `idle_molotov` over the pistol strides those families move with; none for the knife (its
 * strides already hold it) or a weapon without clips.
 */
export function holdPoseClip(family: Family, weapon: string): string | null {
  if (family === 'c4' || family === 'grenade')
    return weaponClip('idle', weapon);
  if (family === 'knife' || WEAPON_CLIP_SUFFIX[weapon] === undefined)
    return null;
  return weaponClip('idle', weapon);
}

export class PlayerRig {
  readonly object: THREE.Object3D;
  /** One material per material of the model, owned by this rig: lit or not as the look. */
  readonly materials: LookMaterial[] = [];
  private _team: Team;
  private _opacity = 1;
  /** The team tint, and how far a hit has turned it red (`hitFlash`). */
  private readonly tint = new THREE.Color();
  private _flash = 0;
  private readonly template: RigTemplate;
  private readonly mixer: THREE.AnimationMixer;
  /** Every action made so far, by `variant:clip`; each `apply` sets every one of them. */
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly used = new Map<THREE.AnimationAction, number>();
  private readonly skeletons: THREE.Skeleton[] = [];
  private readonly bones = new Map<string, THREE.Object3D>();
  /**
   * Bones the last `apply` turned after the mixer (aim, head snap); `saved` holds each one's
   * value before the turn, one quaternion per bone kept from frame to frame. three.js writes a
   * bone only when its animated value changes, so a turn left in place would survive into the
   * next pose and add up; each `apply` puts these back first.
   */
  private readonly edited = new Set<THREE.Object3D>();
  private readonly saved = new Map<THREE.Object3D, THREE.Quaternion>();
  /** The action slots taken by a newer action in this `apply`. */
  private readonly taken = new Set<string>();
  private readonly look: LookOptions;
  private readonly weapons: WeaponCache | null;
  /** This rig's clones of the weapons it has held, by model name; one shown at a time. */
  private readonly held = new Map<string, THREE.Object3D>();
  /** The clone in the hand now, or null (none held, not loaded yet, or dying), and its model. */
  private inHand: THREE.Object3D | null = null;
  private inHandModel = '';
  /** The C4 on the carrier's back, made on first need. */
  private back: THREE.Object3D | null = null;
  /** The weapons' own materials: lit like the body, never team-tinted. */
  private readonly weaponMaterials: LookMaterial[] = [];
  /** The pool's outline materials (`outline.ts`), or null for a rig drawn without outlines. */
  private readonly outlines: OutlineMaterials | null;
  /** The hull and x-ray beside each mesh of the model. */
  private readonly outlined: { hull: THREE.Mesh; xray: THREE.Mesh }[] = [];
  /** The model's meshes and its weapons': drawn after the x-ray while opaque (`bodyOrder`). */
  private readonly drawn: THREE.Mesh[] = [];
  /** What `setOutline` last asked for. */
  private outlineOn = true;
  private outlineColor: OutlineColor;
  /** Outlines show on the living only: a dying body has none. */
  private living = true;
  /** The light grid's sample this rig is lit by (`setProbe`), or null for the sky light. */
  private probe: ProbeSample | null = null;

  /**
   * A rig of `template` for `team`, drawn in `look`. The template's materials are shared by
   * every rig and stay as they are; this rig converts them into its own, which it tints.
   * The model keeps its own normals: smooth where it has them, flat where it has none.
   * With `outlines`, every mesh of the model gets its hull and x-ray (`outlineMeshes`).
   */
  constructor(
    template: RigTemplate,
    team: Team,
    look: LookOptions = UNLIT_LOOK,
    weapons: WeaponCache | null = null,
    outlines: OutlineMaterials | null = null
  ) {
    this._team = team;
    this.template = template;
    this.look = look;
    this.weapons = weapons;
    this.outlines = outlines;
    this.outlineColor = team;
    this.object = SkeletonUtils.clone(template.scene);
    const dress = modelDresser(look, this.materials);
    const meshes: THREE.Mesh[] = [];
    this.object.traverse((o) => {
      if ((o as THREE.Bone).isBone && !this.bones.has(o.name))
        this.bones.set(o.name, o);
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes.push(mesh);
      dress(mesh);
      // A skinned mesh's bounds are its bind pose; a lying or crouching body leaves them.
      mesh.frustumCulled = false;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const sk = (o as THREE.SkinnedMesh).skeleton;
      if (
        (o as THREE.SkinnedMesh).isSkinnedMesh &&
        !this.skeletons.includes(sk)
      )
        this.skeletons.push(sk);
    });
    // After the world and the x-ray (`OUTLINE`); the outlines are added once the walk is done,
    // so it does not visit them.
    for (const mesh of meshes) {
      mesh.renderOrder = this.bodyOrder();
      this.drawn.push(mesh);
      if (outlines) this.outlined.push(outlineMeshes(mesh, outlines, team));
    }
    this.setTeam(team);
    // Every clip's action is made now, at the bind pose: three.js records a bone's resting
    // value when an action first binds it, so binding later, mid-pose, would let a pose depend
    // on what was shown before. Variants (upper body, additive) reuse these bindings.
    this.mixer = new THREE.AnimationMixer(this.object);
    for (const name of template.clips.keys()) this.action(name, 'full');
    this.object.visible = false;
  }

  get team(): Team {
    return this._team;
  }

  get opacity(): number {
    return this._opacity;
  }

  /**
   * Where the shots leave the gun in the hand now (`muzzleOf`, in the scene; impacts.ts), into
   * `out`; false with no weapon model in the hand (none held, not loaded yet, or dying).
   */
  muzzle(out: THREE.Vector3): boolean {
    const gun = this.inHand;
    if (!gun?.visible) return false;
    gun.updateWorldMatrix(true, false);
    out.copy(muzzleOf(gun, this.inHandModel)).applyMatrix4(gun.matrixWorld);
    return true;
  }

  /** The bone of this rig named `name`, if the model has it. */
  bone(name: string): THREE.Object3D | undefined {
    return this.bones.get(name);
  }

  /**
   * Poses the rig from `inp` (see `RigInput`). Hidden when the state is not present or a body
   * has finished fading.
   */
  apply(inp: RigInput, header: Pick<MatchHeader, 'tick_rate'>): void {
    const state = inp.state;
    const rate = header.tick_rate;
    const dying = inp.deathTicks !== null;
    if (this.living !== !dying) {
      this.living = !dying;
      this.paintOutline();
    }
    const death = dying
      ? deathPhase(inp.deathTicks! / rate, inp.death?.data?.headshot === true)
      : LIVING;
    const visible = state.present && !death.hidden;
    this.object.visible = visible;
    if (!visible) return;

    toScene(state.x, state.y, state.z, this.object.position);
    this.object.position.y += death.lift;
    this.object.rotation.set(0, yawToRotationY(state.yaw), 0);
    if (death.topple > 0) this.topple(inp.death, death.topple);
    this.setOpacity(death.opacity);
    this.setFlash(hitFlash(this.hitAge(inp, rate)));

    for (const bone of this.edited) bone.quaternion.copy(this.saved.get(bone)!);
    this.edited.clear();
    const used = this.used;
    used.clear();

    // Locomotion, falling back to the family idle, then the rifle idle, for a missing clip.
    for (const c of inp.locomotion) {
      const own = this.template.clips.has(c.clip);
      const name = own ? c.clip : this.fallback(c.clip);
      // A stand-in plays on the round clock, not the missing stride's distance.
      const time = own ? (c.time ?? inp.clipTime) : inp.clipTime;
      if (name) this.play(name, 'full', c.weight, time, true);
    }
    // Actions: the newest on each slot wins.
    const taken = this.taken;
    taken.clear();
    let overridden = 0;
    for (const a of inp.actions) {
      const layer = actionLayer(a);
      if (taken.has(layer.slot)) continue;
      const t = (inp.tick - a.startTick) / rate;
      const env = envelope(
        t,
        a.durationTicks / rate,
        layer.fadeIn,
        layer.fadeOut
      );
      if (env <= 0) continue;
      const added = ADDED.has(layer.variant);
      this.play(
        a.clip,
        layer.variant,
        added ? env : DOMINANCE * env,
        t,
        layer.loop
      );
      taken.add(layer.slot);
      if (!added) overridden = Math.max(overridden, env);
    }

    // The weapon's own grip, added over the locomotion; an action that replaces the upper
    // body (a reload, a throw, planting) brings its own, so the grip fades as it comes in.
    const hold = dying ? null : holdPoseClip(inp.family, inp.weapon);
    if (hold) this.play(hold, 'pose', 1 - overridden, 0, true);

    // A death: the hit's jolt, then the knees give into the crouch.
    if (dying) {
      const t = inp.deathTicks! / rate;
      if (inp.death && death.flinch > 0)
        this.play(inp.death.clip, 'additive', death.flinch, t, false);
      if (death.buckle > 0)
        this.play(
          `idle_crouch_${locoFamily(inp.family)}`,
          'full',
          DOMINANCE * death.buckle,
          0,
          true
        );
    }

    for (const action of this.actions.values())
      action.setEffectiveWeight(used.get(action) ?? 0);
    this.mixer.update(0);

    this.holdWeapon(inp, dying);
    if (!dying) {
      for (const [name] of AIM_SHARE) this.remember(name);
      applyAim(this.bones, this.object, state.pitch);
    } else if (death.headSnap > 0) {
      const head = this.bones.get('head_0');
      if (head) {
        this.remember('head_0');
        rotateBoneWorld(
          head,
          rigSideAxis(this.object),
          (-HEAD_SNAP_DEG * Math.PI * death.headSnap) / 180
        );
        this.object.updateMatrixWorld(true);
      }
    }
  }

  /**
   * Shows the model of the weapon held on the `wpn` bone (none while dying: the gun drops),
   * and the C4 on the back of a carrier holding something else. A model not loaded yet is
   * asked for and shown from the frame it arrives.
   */
  private holdWeapon(inp: RigInput, dying: boolean): void {
    const name = dying ? null : weaponModelName(inp.weapon, this._team);
    const shown = name ? this.clone(name, 'wpn') : null;
    if (shown) placeHeld(shown, inp.family);
    for (const o of this.held.values()) o.visible = o === shown;
    this.inHand = shown;
    this.inHandModel = shown && name ? name : '';
    const carrying =
      !dying && (inp.state.flags & FLAG.bomb) !== 0 && inp.family !== 'c4';
    if (carrying && !this.back) {
      this.back = this.clone('c4', 'spine_3', false);
      if (this.back) placeHold(this.back, C4_BACK_OFFSET);
    }
    if (this.back) this.back.visible = carrying;
  }

  /**
   * This rig's copy of model `name` on bone `boneName` (made on first use, with this rig's
   * lit or unlit materials), or null when the model is not loaded or the bone is missing.
   * `keep` false makes a copy that is not one of the held weapons.
   */
  private clone(
    name: string,
    boneName: string,
    keep = true
  ): THREE.Object3D | null {
    const have = keep ? this.held.get(name) : undefined;
    if (have) return have;
    const src = this.weapons?.get(name);
    const bone = this.bones.get(boneName);
    if (!src || !bone) return null;
    const made = this.weaponMaterials.length;
    const o = cloneWeapon(src, this.look, this.weaponMaterials, true);
    for (let i = made; i < this.weaponMaterials.length; i++)
      this.light(this.weaponMaterials[i]);
    o.name = `weapon:${name}`;
    // Drawn with the body, after the x-ray, or the x-ray would show through the gun in hand.
    // Meshes only: a group's render order would order all it holds before anything else.
    o.traverse((c) => {
      if (!(c as THREE.Mesh).isMesh) return;
      c.renderOrder = this.bodyOrder();
      this.drawn.push(c as THREE.Mesh);
    });
    bone.add(o);
    if (keep) this.held.set(name, o);
    return o;
  }

  /**
   * Plays clip `name` as `variant` at `weight` (none at 0 or less), at `time` seconds (wrapped
   * when it loops, else held within the clip), adding to what it already plays this `apply`.
   */
  private play(
    name: string,
    variant: Variant,
    weight: number,
    time: number,
    loop: boolean
  ): void {
    if (weight <= 0) return;
    const action = this.action(name, variant);
    if (!action) return;
    const d = action.getClip().duration;
    action.time =
      d <= 0
        ? 0
        : loop
          ? time - d * Math.floor(time / d)
          : Math.min(Math.max(0, time), d - 1e-4);
    this.used.set(action, (this.used.get(action) ?? 0) + weight);
  }

  /** Records `name`'s mixer-written rotation before a procedural turn (see `edited`). */
  private remember(name: string): void {
    const bone = this.bones.get(name);
    if (!bone || this.edited.has(bone)) return;
    let q = this.saved.get(bone);
    if (!q) this.saved.set(bone, (q = new THREE.Quaternion()));
    q.copy(bone.quaternion);
    this.edited.add(bone);
  }

  /**
   * Lights the body and every weapon it holds, now and later, by `s` (the light grid at the
   * player, filled in place each frame: `probes.ts`), or by the scene's sky light for null.
   * Its lit materials only; the outlines are the pool's and stay as they are. The same sample
   * again changes nothing.
   */
  setProbe(s: ProbeSample | null): void {
    if (s === this.probe) return;
    this.probe = s;
    for (const m of this.materials) this.light(m);
    for (const m of this.weaponMaterials) this.light(m);
  }

  private light(m: LookMaterial): void {
    if (!(m instanceof THREE.MeshLambertMaterial)) return;
    if (this.probe) attachProbe(m, this.probe);
    else detachProbe(m);
  }

  setTeam(team: Team): void {
    this._team = team;
    this.tint.set(TEAM_HEX[team]).lerp(WHITE, TINT_TO_WHITE);
    this.paint();
    if (this.outlineColor !== 'shown') this.outlineColor = team;
    this.paintOutline();
  }

  /**
   * Shows the outlines (`on`) in `color`: the team's, or `'shown'` for the followed player's
   * white. A dying player has none, whatever this asks.
   */
  setOutline(on: boolean, color: OutlineColor): void {
    if (on === this.outlineOn && color === this.outlineColor) return;
    this.outlineOn = on;
    this.outlineColor = color;
    this.paintOutline();
  }

  private paintOutline(): void {
    const m = this.outlines;
    if (!m) return;
    const shown = this.outlineOn && this.living;
    const hull = m.hull(this.outlineColor);
    const xray = m.xray(this.outlineColor);
    for (const o of this.outlined) {
      o.hull.visible = shown;
      o.xray.visible = shown;
      o.hull.material = hull;
      o.xray.material = xray;
    }
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.object);
    for (const m of this.materials) m.dispose();
    // The outlines share the model's geometry and the pool's materials, freed by their owners.
    // The weapon clones share their geometry with the cache, which frees it.
    for (const m of this.weaponMaterials) m.dispose();
    for (const s of this.skeletons) s.dispose();
    this.object.removeFromParent();
  }

  /**
   * Tips the body over its feet, away from the shot: `death.data.bearing` is where the attacker
   * stood (degrees from the victim's view, right positive); with none, the body falls back.
   * The model faces +Z with its right at −X.
   */
  private topple(death: Action | null, amount: number): void {
    const b = ((death?.data?.bearing ?? 0) * Math.PI) / 180;
    // Away from the attacker, in the rig's frame: −(−sin b, 0, cos b).
    const fx = Math.sin(b);
    const fz = -Math.cos(b);
    // The turn that tips +Y towards (fx, 0, fz): about Y × f.
    _axis.set(fz, 0, -fx).normalize();
    this.object.rotateOnAxis(_axis, (Math.PI / 2) * amount);
  }

  /** For a missing locomotion clip: the family idle of its suffix, then the rifle idle. */
  private fallback(clip: string): string | null {
    const family = clip.slice(clip.lastIndexOf('_') + 1);
    for (const name of [`idle_${family}`, 'idle_rifle'])
      if (this.template.clips.has(name)) return name;
    return null;
  }

  /** The action of `clip` on `variant`, made on first use; null when the model lacks the clip. */
  private action(name: string, variant: Variant): THREE.AnimationAction | null {
    const key = `${variant}:${name}`;
    let a = this.actions.get(key);
    if (a) return a;
    const clip = this.variantClip(name, variant);
    if (!clip) return null;
    a = this.mixer.clipAction(
      clip,
      undefined,
      ADDED.has(variant)
        ? THREE.AdditiveAnimationBlendMode
        : THREE.NormalAnimationBlendMode
    );
    a.play();
    a.setEffectiveWeight(0);
    this.actions.set(key, a);
    return a;
  }

  private variantClip(
    name: string,
    variant: Variant
  ): THREE.AnimationClip | null {
    const src = this.template.clips.get(name);
    if (!src) return null;
    if (variant === 'full') return src;
    const key = `${variant}:${name}`;
    let clip = this.template.variants.get(key);
    if (!clip) {
      if (variant === 'upper') clip = makeUpperBodyClip(src);
      else if (variant === 'pose') clip = this.poseClip(src);
      else {
        clip = THREE.AnimationUtils.makeClipAdditive(src.clone(), 0, src);
        if (variant === 'recoil') clip = makeUpperBodyClip(clip);
        clip.name = `${src.name}#${variant}`;
      }
      this.template.variants.set(key, clip);
    }
    return clip;
  }

  /**
   * `src`'s upper-body bones as the change from the reference pose (REFERENCE_POSE_CLIP's
   * first frame). Tracks the reference lacks are dropped: three.js would leave them absolute
   * and add them whole. Without the reference clip, nothing is added.
   */
  private poseClip(src: THREE.AnimationClip): THREE.AnimationClip {
    const ref = this.template.clips.get(REFERENCE_POSE_CLIP);
    const name = `${src.name}#pose`;
    if (!ref) return new THREE.AnimationClip(name, src.duration, []);
    const known = new Set(ref.tracks.map((t) => t.name));
    const delta = THREE.AnimationUtils.makeClipAdditive(src.clone(), 0, ref);
    const upper = makeUpperBodyClip(
      new THREE.AnimationClip(
        name,
        delta.duration,
        delta.tracks.filter((t) => known.has(t.name))
      )
    );
    upper.name = name;
    return upper;
  }

  /** Seconds since the player was last hit (the killing hit while dying), or NaN. */
  private hitAge(inp: RigInput, rate: number): number {
    if (inp.deathTicks !== null) return inp.deathTicks / rate;
    const flinch = inp.actions.find((a) => a.kind === 'flinch');
    return flinch ? (inp.tick - flinch.startTick) / rate : NaN;
  }

  private setFlash(flash: number) {
    if (flash === this._flash) return;
    this._flash = flash;
    this.paint();
  }

  /** The team tint, turned red by the hit flash. */
  private paint() {
    const f = this._flash;
    _c.copy(WHITE).lerp(HIT_RED, f).multiply(this.tint);
    for (const m of this.materials) {
      m.color.copy(_c);
      if (m instanceof THREE.MeshLambertMaterial)
        m.emissive.setRGB(HIT_GLOW * f, 0, 0);
    }
  }

  private setOpacity(opacity: number) {
    if (opacity === this._opacity) return;
    const transparent = opacity < 1;
    for (const m of [...this.materials, ...this.weaponMaterials]) {
      m.opacity = opacity;
      if (m.transparent !== transparent) {
        m.transparent = transparent;
        m.needsUpdate = true;
      }
    }
    const was = this.bodyOrder();
    this._opacity = opacity;
    const order = this.bodyOrder();
    if (order !== was) for (const m of this.drawn) m.renderOrder = order;
  }

  /**
   * The render order of the model and its weapons. Opaque, they draw after the x-ray
   * (`OUTLINE.rigOrder`), so a body hides the x-ray of whoever is behind it. Fading, they sort
   * by depth with the smoke and the other blended effects (order 0): three.js sorts the
   * transparent list by render order before depth, so at order 2 a fading body would draw over
   * a smoke in front of it. A fading body is dying and carries no outline.
   */
  private bodyOrder(): number {
    return this._opacity < 1 ? 0 : OUTLINE.rigOrder;
  }
}

function locoFamily(f: Family): 'rifle' | 'pistol' | 'knife' {
  return f === 'rifle' || f === 'pistol' || f === 'knife' ? f : 'pistol';
}

/**
 * The rigs of one match: per player, a CT and a T rig made on first use (players swap
 * models at half time), sized from `header.players.length` so a wingman demo or a bot-filled
 * slot has exactly as many as it has players.
 */
export class RigPool {
  readonly root = new THREE.Group();
  private readonly templates: Record<Team, RigTemplate>;
  private look: LookOptions;
  private readonly slots: Record<Team, PlayerRig | null>[];

  private readonly weapons: WeaponCache | null;
  /** The outline materials every rig of the pool shares. */
  private readonly outlines = new OutlineMaterials();
  /** What `setOutlines` last asked for, given to rigs made since. */
  private readonly outlineState: { on: boolean; shown: number | null } = {
    on: true,
    shown: null,
  };

  constructor(
    templates: Record<Team, RigTemplate>,
    players: number,
    look: LookOptions = UNLIT_LOOK,
    weapons: WeaponCache | null = null
  ) {
    this.weapons = weapons;
    this.templates = templates;
    this.look = look;
    this.root.name = 'players';
    this.slots = Array.from({ length: players }, () => ({ 2: null, 3: null }));
  }

  get size(): number {
    return this.slots.length;
  }

  /** The rig player `i` is shown with this frame, or null (not playing, or no such player). */
  active(i: number): PlayerRig | null {
    const slot = this.slots[i];
    if (!slot) return null;
    return slot[2]?.object.visible
      ? slot[2]
      : slot[3]?.object.visible
        ? slot[3]
        : null;
  }

  drive(inputs: readonly RigInput[], header: Pick<MatchHeader, 'tick_rate'>) {
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      const inp = inputs[i];
      const team = inp?.team;
      if (team !== 2 && slot[2]) slot[2].object.visible = false;
      if (team !== 3 && slot[3]) slot[3].object.visible = false;
      if (team !== 2 && team !== 3) continue;
      // A rig is made only once its player is first seen in the round.
      if (!slot[team] && !inp.state.present) continue;
      const rig = (slot[team] ??= this.make(team, i));
      rig.apply(inp, header);
    }
  }

  /**
   * Outlines every rig through walls (`on`) in its team colour, player `shown`'s in white
   * (null or past the players: nobody's); off, none. Asked every draw: the same again changes
   * nothing (a rig made since was outlined as it was made).
   */
  setOutlines(on: boolean, shown: number | null): void {
    const o = this.outlineState;
    if (o.on === on && o.shown === shown) return;
    o.on = on;
    o.shown = shown;
    for (let i = 0; i < this.slots.length; i++)
      for (const team of [2, 3] as const) this.outline(this.slots[i][team], i);
  }

  /** The canvas's size in CSS pixels, which the outlines' width is measured in. */
  setViewport(width: number, height: number): void {
    this.outlines.setViewport(width, height);
  }

  /**
   * Draws the players in `look` from now on: every rig made so far is made again in it (shown
   * or hidden as before, posed on the next `drive`) and the old one freed. A look that differs
   * only in what the players are not drawn with (their normals are their own, and they never
   * get the detail texture) keeps the rigs.
   */
  setLook(look: LookOptions): void {
    const was = this.look;
    this.look = look;
    if (was.lit === look.lit && was.maxAnisotropy === look.maxAnisotropy)
      return;
    this.slots.forEach((slot, i) => {
      for (const team of [2, 3] as const) {
        const old = slot[team];
        if (!old) continue;
        const rig = this.make(team, i);
        rig.object.visible = old.object.visible;
        old.dispose();
        slot[team] = rig;
      }
    });
  }

  dispose(): void {
    for (const slot of this.slots) {
      slot[2]?.dispose();
      slot[3]?.dispose();
    }
    this.slots.length = 0;
    this.outlines.dispose();
    this.root.removeFromParent();
  }

  /** Player `i`'s rig for `team`, outlined as `setOutlines` last asked. */
  private make(team: Team, i: number): PlayerRig {
    const rig = new PlayerRig(
      this.templates[team],
      team,
      this.look,
      this.weapons,
      this.outlines
    );
    this.outline(rig, i);
    this.root.add(rig.object);
    return rig;
  }

  private outline(rig: PlayerRig | null, i: number): void {
    const o = this.outlineState;
    rig?.setOutline(o.on, i === o.shown ? 'shown' : rig.team);
  }
}
