// First-person arms: each team's arms model (/viewmodels/arms_<side>.glb) and each weapon's
// viewmodel clips (/viewmodels/<model>.glb), fetched once each the first time POV needs them
// (tools/README.md, Viewmodels), and the rig that plays the clips on a copy of the arms with
// the gun in its hands. Both files carry CS2's viewmodel skeleton, whose `root_motion` is the
// eye (+Z forward, +X left, +Y up in the glTF frame); the rig turns it to face the viewmodel
// camera's −Z and moves it by the game's `viewmodel_offset_*`. A file that fails to load stays
// absent (one warning, no retry): the viewer then draws the gun alone.

import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { assetUrl } from '../api/assets';
import type { ClipLayer, ClipLengths, ViewmodelClip } from '../sim/firstperson';
import type { Family } from '../sim/weapons';
import { disposeObject } from './loaders';
import { modelDresser, type LookMaterial, type LookOptions } from './look';
import { HAND_PARTS, attachOf, cloneWeapon, placeHeld } from './weapons';

/** `/viewmodels/manifest.json` (tools/manifest.mjs viewmodels). */
export interface ViewmodelManifest {
  arms?: Record<string, { sha256?: string } | undefined>;
  weapons?: Record<string, { sha256?: string; clips?: string[] } | undefined>;
}

/** Where the arms sit from the eye: CS2's `viewmodel_offset_x/y/z`, inches right, forward, up. */
export interface ArmsOffset {
  x: number;
  y: number;
  z: number;
}

/** The user's own config (2, 2, −2): a little right, ahead and down of the game's default. */
export const ARMS_OFFSET: Readonly<ArmsOffset> = { x: 2, y: 2, z: -2 };

const INCH = 0.0254;

/** The rig's position in the viewmodel camera's frame (+X right, +Y up, −Z ahead), metres. */
export function rigPosition(
  o: Readonly<ArmsOffset> = ARMS_OFFSET
): [number, number, number] {
  return [o.x * INCH, o.z * INCH, -o.y * INCH];
}

/**
 * Places a rig's root at the eye: turned 180° about Y (the skeleton looks down +Z with +X to its
 * left, the camera down −Z with +X to its right), moved by `offset` and raised by `bob`.
 */
export function placeRig(
  root: THREE.Object3D,
  offset: Readonly<ArmsOffset>,
  bob: number
): void {
  root.rotation.set(0, Math.PI, 0);
  root.position.set(...rigPosition(offset));
  root.position.y += bob;
}

/** One weapon's viewmodel clips, as loaded. */
export interface ClipSet {
  clips: Map<string, THREE.AnimationClip>;
  lengths: ClipLengths;
  /** The file's skeleton at rest: bones the arms lack (the Dual Berettas' left pistol) come from here. */
  skeleton: THREE.Object3D;
}

/** What the loader gives for a GLB. */
export interface LoadedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

const CLIP_NAMES: ReadonlySet<string> = new Set<ViewmodelClip>([
  'idle',
  'draw',
  'shoot',
  'shoot_left',
  'reload',
  'pullpin',
  'throw',
  'throw_underhand',
  'plant',
]);

/** A loaded clip file as a `ClipSet`: its clips by name and the lengths of the known ones. */
export function clipSetFrom(g: LoadedGltf): ClipSet {
  const clips = new Map<string, THREE.AnimationClip>();
  const lengths: Partial<Record<ViewmodelClip, number>> = {};
  for (const c of g.animations) {
    if (clips.has(c.name)) continue;
    clips.set(c.name, c);
    if (CLIP_NAMES.has(c.name)) lengths[c.name as ViewmodelClip] = c.duration;
  }
  return { clips, lengths, skeleton: g.scene };
}

/** The arms file of a team: 2 is T, 3 is CT; nobody else has arms. */
export function armsSide(team: number): 't' | 'ct' | null {
  return team === 2 ? 't' : team === 3 ? 'ct' : null;
}

/**
 * Fetches the arms and the clip files once each. Nothing is asked for until the manifest is in
 * (`setManifest`), so every file goes out versioned; a null manifest (none on the server)
 * means nothing is there.
 */
export class ArmsCache {
  /** Called once each time a file finishes loading (and when the manifest arrives). */
  onLoad: (() => void) | null = null;
  private readonly load: (url: string) => Promise<LoadedGltf>;
  /** Undefined until it is known. */
  private manifest: ViewmodelManifest | null | undefined;
  private readonly arms = new Map<string, THREE.Group | null>();
  private readonly sets = new Map<string, ClipSet | null>();
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(
    load: (url: string) => Promise<LoadedGltf>,
    manifest?: ViewmodelManifest | null
  ) {
    this.load = load;
    this.manifest = manifest;
  }

  setManifest(m: ViewmodelManifest | null): void {
    this.manifest = m;
    this.onLoad?.();
  }

  /** The arms of `team` as loaded (rigs clone them), or null: not loaded yet, failed or absent. */
  armsFor(team: number): THREE.Group | null {
    const side = armsSide(team);
    if (!side) return null;
    return this.get(
      this.arms,
      `arms_${side}`,
      this.manifest?.arms?.[side]?.sha256,
      this.manifest ? this.manifest.arms?.[side] !== undefined : false,
      (g) => g.scene
    );
  }

  /** The clips of weapon model `name` (a `weaponModelName`), or null as for `armsFor`. */
  clips(name: string): ClipSet | null {
    return this.get(
      this.sets,
      name,
      this.manifest?.weapons?.[name]?.sha256,
      this.manifest ? this.manifest.weapons?.[name] !== undefined : false,
      clipSetFrom
    );
  }

  private get<T>(
    into: Map<string, T | null>,
    file: string,
    sha256: string | undefined,
    listed: boolean,
    make: (g: LoadedGltf) => T
  ): T | null {
    const have = into.get(file);
    if (have !== undefined) return have;
    if (this.manifest === undefined || this.pending.has(file) || this.disposed)
      return null;
    if (!listed) {
      into.set(file, null);
      return null;
    }
    this.pending.add(file);
    const url = assetUrl(`/viewmodels/${encodeURIComponent(file)}.glb`, sha256);
    this.load(url).then(
      (g) => {
        this.pending.delete(file);
        if (this.disposed) {
          disposeObject(g.scene);
          return;
        }
        into.set(file, make(g));
        this.onLoad?.();
      },
      (e: unknown) => {
        this.pending.delete(file);
        into.set(file, null);
        console.warn(
          `viewmodel ${file}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    );
    return null;
  }

  dispose(): void {
    this.disposed = true;
    for (const a of this.arms.values()) if (a) disposeObject(a);
    this.arms.clear();
    this.sets.clear();
  }
}

/**
 * The hand bones the clips bring are the hands' own frames, and the hands are mirrored (a
 * right-side bone points back up the arm): held as the bones say, the right piece points at
 * the eye and the left one hangs upside down. Each is turned half round about the bone's
 * origin (its grip) in the bone's frame: the right about Z, the left about X.
 */
const TURN_RIGHT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 0, 1),
  Math.PI
);
const TURN_LEFT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI
);

/** `o` in a group turned by `q`, which goes where `o` would have gone. */
function turned(o: THREE.Object3D, q: THREE.Quaternion): THREE.Object3D {
  const g = new THREE.Group();
  g.name = `${o.name}:turn`;
  g.quaternion.copy(q);
  g.add(o);
  return g;
}

/** The holster the Dual Berettas' world model carries, never in the hands. */
const HOLSTER = /holster$/i;

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

/**
 * Cuts copy `o` of a weapon model down to the triangles whose corners all pass `keep` (given
 * the corner in `o`'s own frame): each mesh gets a copy of its geometry (pushed to `owned`)
 * indexed with only those, and is hidden when none pass.
 */
export function keepWhere(
  o: THREE.Object3D,
  keep: (p: THREE.Vector3) => boolean,
  owned: THREE.BufferGeometry[]
): void {
  o.updateMatrixWorld(true);
  const toO = new THREE.Matrix4().copy(o.matrixWorld).invert();
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    _m.multiplyMatrices(toO, mesh.matrixWorld);
    const ok = new Uint8Array(pos.count);
    for (let i = 0; i < pos.count; i++)
      ok[i] = keep(_v.fromBufferAttribute(pos, i).applyMatrix4(_m)) ? 1 : 0;
    const src = mesh.geometry.index;
    const n = src ? src.count : pos.count;
    const kept: number[] = [];
    for (let t = 0; t + 2 < n; t += 3) {
      const a = src ? src.getX(t) : t;
      const b = src ? src.getX(t + 1) : t + 1;
      const d = src ? src.getX(t + 2) : t + 2;
      if (ok[a] && ok[b] && ok[d]) kept.push(a, b, d);
    }
    if (kept.length === 0) {
      mesh.visible = false;
      return;
    }
    const g = mesh.geometry.clone();
    g.setIndex(kept);
    owned.push(g);
    mesh.geometry = g;
  });
}

/**
 * One team's arms in first person: a copy of the arms model dressed in the look, a mixer that
 * plays a weapon's clips on it at the times it is given, and the guns it holds on `wpn` the way
 * third person holds them (`placeHeld`). Nothing carries over between poses: every action's
 * weight and time is written each time.
 */
export class ArmsRig {
  /** Placed in the viewmodel camera's frame by `placeRig`. */
  readonly root = new THREE.Group();
  private readonly arms: THREE.Object3D;
  private readonly look: LookOptions;
  private readonly mixer: THREE.AnimationMixer;
  private readonly nodes = new Map<string, THREE.Object3D>();
  private readonly actions = new Map<
    THREE.AnimationClip,
    THREE.AnimationAction
  >();
  private readonly adopted = new Set<ClipSet>();
  private readonly used = new Map<THREE.AnimationAction, number>();
  /** The rest pose of each bone taken from a clip file, relative to its parent. */
  private readonly rests = new Map<string, THREE.Matrix4>();
  /** The guns made so far by model name; one shown at a time. */
  private readonly guns = new Map<string, THREE.Object3D[]>();
  /** The gun in the hands now (a pair's right-hand piece), or null. */
  private held: THREE.Object3D | null = null;
  private readonly materials: LookMaterial[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly skeletons: THREE.Skeleton[] = [];

  constructor(template: THREE.Object3D, look: LookOptions) {
    this.look = look;
    this.arms = SkeletonUtils.clone(template);
    const dress = modelDresser(look, this.materials);
    this.arms.traverse((o) => {
      if (o.name && !this.nodes.has(o.name)) this.nodes.set(o.name, o);
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      dress(mesh);
      // A skinned mesh's bounds are its bind pose, far from where the clips hold the arms.
      mesh.frustumCulled = false;
      if (mesh.isSkinnedMesh && !this.skeletons.includes(mesh.skeleton))
        this.skeletons.push(mesh.skeleton);
    });
    this.root.add(this.arms);
    this.mixer = new THREE.AnimationMixer(this.arms);
  }

  /** The rig's node named `name` (a bone of the viewmodel skeleton), if it has one. */
  bone(name: string): THREE.Object3D | undefined {
    return this.nodes.get(name);
  }

  /** Plays `layers` of `set`'s clips (each at its time and weight) and nothing else. */
  pose(set: ClipSet, layers: readonly ClipLayer[]): void {
    this.adopt(set);
    const used = this.used;
    used.clear();
    for (const l of layers) {
      const clip = set.clips.get(l.clip);
      const action = clip ? this.actions.get(clip) : undefined;
      if (!clip || !action) continue;
      action.time = Math.min(Math.max(0, l.time), clip.duration);
      used.set(action, (used.get(action) ?? 0) + l.weight);
    }
    for (const a of this.actions.values())
      a.setEffectiveWeight(used.get(a) ?? 0);
    this.mixer.update(0);
  }

  /**
   * Shows the gun of weapon model `name` (`src`, the cache's model) in the hands, made on first
   * use, and hides the others; null shows none.
   */
  hold(name: string | null, src: THREE.Object3D | null, family: Family): void {
    let shown: THREE.Object3D[] | undefined;
    if (name && src) {
      shown = this.guns.get(name);
      if (!shown) {
        shown = this.makeGun(name, src, family);
        this.guns.set(name, shown);
      }
    }
    for (const list of this.guns.values())
      for (const g of list) g.visible = list === shown;
    this.held = shown?.[0] ?? null;
  }

  /** The gun in the hands now (of a pair, the right hand's), or null for none. */
  get gun(): THREE.Object3D | null {
    return this.held;
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.arms);
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
    for (const s of this.skeletons) s.dispose();
    this.root.removeFromParent();
  }

  /**
   * Makes `set`'s actions on first use, and the bones its clips move that the arms lack, at
   * their rest pose under their namesake parent. Actions are never stopped (an unused one
   * weighs 0), so every bone keeps the rest pose three.js recorded when it was first bound.
   */
  private adopt(set: ClipSet): void {
    if (this.adopted.has(set)) return;
    this.adopted.add(set);
    set.skeleton.traverse((src) => {
      if (!src.parent || !src.name || this.nodes.has(src.name)) return;
      const parent = this.nodes.get(src.parent.name);
      if (!parent) return;
      const n = new THREE.Object3D();
      n.name = src.name;
      n.position.copy(src.position);
      n.quaternion.copy(src.quaternion);
      n.scale.copy(src.scale);
      parent.add(n);
      this.nodes.set(n.name, n);
      this.rests.set(
        n.name,
        new THREE.Matrix4().compose(n.position, n.quaternion, n.scale)
      );
    });
    for (const clip of set.clips.values()) {
      if (this.actions.has(clip)) continue;
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions.set(clip, a);
    }
  }

  /**
   * The gun on `wpn`, held as third person holds it. A `HAND_PARTS` weapon whose clips brought
   * the hand bones is cut in two at its plane, each piece hung on its hand bone the way its
   * part of the model hangs from it at rest, and turned into the hand's frame.
   */
  private makeGun(
    name: string,
    src: THREE.Object3D,
    family: Family
  ): THREE.Object3D[] {
    const wpn = this.nodes.get('wpn');
    if (!wpn) return [];
    const gun = cloneWeapon(src, this.look, this.materials, false);
    gun.name = `weapon:${name}`;
    const parts = HAND_PARTS[name];
    const right = this.nodes.get('weapon_hand_r');
    const left = this.nodes.get('weapon_hand_l');
    const a = attachOf(gun);
    if (!parts || !right || !left || !a) {
      placeHeld(gun, family);
      wpn.add(gun);
      return [gun];
    }
    gun.traverse((c) => {
      if ((c as THREE.Mesh).isMesh && HOLSTER.test(c.name)) c.visible = false;
    });
    // The model's frame to the `weapon` bone's, where the plane is.
    const toBone = new THREE.Matrix4()
      .compose(
        new THREE.Vector3(...a.translation),
        new THREE.Quaternion(...a.rotation),
        new THREE.Vector3(1, 1, 1)
      )
      .invert();
    const p = new THREE.Vector3();
    const side = (v: THREE.Vector3) =>
      p.copy(v).applyMatrix4(toBone).getComponent(parts.axis) < parts.at;
    const other = gun.clone(true);
    other.name = `weapon:${name}:left`;
    keepWhere(gun, side, this.geometries);
    keepWhere(other, (v) => !side(v), this.geometries);
    // Each piece hangs from its bone as the model's part hangs from it at rest.
    for (const [piece, bone, turn] of [
      [gun, right, TURN_RIGHT],
      [other, left, TURN_LEFT],
    ] as const) {
      const rest = this.rests.get(bone.name) ?? new THREE.Matrix4();
      new THREE.Matrix4()
        .multiplyMatrices(toBone.clone().invert(), rest)
        .invert()
        .decompose(piece.position, piece.quaternion, piece.scale);
      bone.add(turned(piece, turn));
    }
    return [gun, other];
  }
}
