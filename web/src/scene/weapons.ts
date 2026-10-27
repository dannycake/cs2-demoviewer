// Weapon models: the world models under /weapons/ (tools/rip-weapons.sh), fetched once each the
// first time a player holds one, and how a rig holds them. A weapon that fails to load stays
// absent (one warning, no retry storm); a rig without the model simply holds nothing.

import * as THREE from 'three';
import { assetUrl } from '../api/assets';
import type { Family } from '../sim/weapons';
import { modelDresser, type LookMaterial, type LookOptions } from './look';

export interface WeaponManifest {
  weapons: Record<string, { sha256: string; bytes: number; tris?: number }>;
}

/**
 * The model file for a held weapon (a normalised name, `sim/weapons.ts`): the same name,
 * except that a T holds the T knife. `none` and unknown weapons have no model.
 */
export function weaponModelName(weapon: string, team: number): string | null {
  if (!weapon || weapon === 'none') return null;
  if (weapon === 'knife') return team === 2 ? 'knife_t' : 'knife';
  return weapon;
}

export interface Hold {
  /** Metres, in the `wpn` bone's frame. */
  position: [number, number, number];
  /** Radians, XYZ Euler, in the `wpn` bone's frame. */
  rotation: [number, number, number];
}

/**
 * The weapon models' glTF axes (Y up, the barrel along +Z: the export's `(y, z, x)` swap) turned
 * into the game's, which `wpn` keeps (X forward, Y left, Z up): +Z to +X, +X to +Y, +Y to +Z.
 */
const GAME_AXES: Hold['rotation'] = [Math.PI / 2, Math.PI / 2, 0];

/**
 * The rest pose of a model's `weapon` bone, in the model's frame: what the game puts on the
 * player's `wpn` bone. `tools/shrink-weapon.mjs` writes it as the scene's `extras.attach`, which
 * the loader reads into `userData.attach`.
 */
export interface Attach {
  /** Metres. */
  translation: [number, number, number];
  /** Quaternion, x y z w. */
  rotation: [number, number, number, number];
}

const isNumbers = (v: unknown, n: number): boolean =>
  Array.isArray(v) &&
  v.length === n &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x));

/**
 * Weapons whose clips leave `wpn` at the eye and carry the model's parts on its own hand bones
 * (`weapon_hand_r`, `weapon_hand_l`, which follow the hands): the Dual Berettas' two pistols,
 * 0.508 m apart along the `weapon` bone's Y in the model, and the molotov's bottle and lighter,
 * the lighter 0.10 m ahead along X. `split` is the plane, in the `weapon` bone's frame (game
 * axes: X ahead, Y left, Z up), that parts the right hand's piece (the side of the bone's
 * origin) from the left hand's.
 */
export const HAND_PARTS: Readonly<
  Record<string, { axis: 0 | 1 | 2; at: number }>
> = {
  elite: { axis: 1, at: 0.25 },
  molotov: { axis: 0, at: 0.06 },
};

/** How far behind the gun's foremost point the vertices of its front end reach (metres). */
export const MUZZLE_DEPTH = 0.01;

/** Each gun's muzzle in its own frame (`muzzleOf`), found once per gun. */
const muzzles = new WeakMap<THREE.Object3D, THREE.Vector3>();

/**
 * The muzzle of `gun`, a copy of weapon model `name`, in its own frame: the middle of its front
 * end, the models facing +Z: the vertices of its shown meshes within `MUZZLE_DEPTH` of the
 * foremost one, averaged (the exported models keep no muzzle attachment). Of a model in two
 * parts (`HAND_PARTS`: the Dual Berettas), the right hand's part's. Found once per gun.
 */
export function muzzleOf(gun: THREE.Object3D, name: string): THREE.Vector3 {
  const have = muzzles.get(gun);
  if (have) return have;
  gun.updateWorldMatrix(true, true);
  const toGun = new THREE.Matrix4().copy(gun.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const meshes: THREE.Mesh[] = [];
  gun.traverseVisible((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  // The right hand's part: its side of the plane, in the `weapon` bone's frame (as `ArmsRig`
  // splits it).
  const part = HAND_PARTS[name];
  const a = part ? attachOf(gun) : null;
  const toBone = a
    ? new THREE.Matrix4()
        .compose(
          new THREE.Vector3(...a.translation),
          new THREE.Quaternion(...a.rotation),
          new THREE.Vector3(1, 1, 1)
        )
        .invert()
    : null;
  const w = new THREE.Vector3();
  /** Calls `f` with each shown vertex of the right hand's part in the gun's frame. */
  const each = (f: (p: THREE.Vector3) => void) => {
    for (const mesh of meshes) {
      const pos = mesh.geometry.getAttribute('position');
      if (!pos) continue;
      m.multiplyMatrices(toGun, mesh.matrixWorld);
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(m);
        if (
          part &&
          toBone &&
          w.copy(v).applyMatrix4(toBone).getComponent(part.axis) >= part.at
        )
          continue;
        f(v);
      }
    }
  };
  let front = -Infinity;
  each((p) => (front = Math.max(front, p.z)));
  const sum = new THREE.Vector3();
  let n = 0;
  each((p) => {
    if (p.z < front - MUZZLE_DEPTH) return;
    sum.x += p.x;
    sum.y += p.y;
    n++;
  });
  const muzzle = n > 0 ? sum.set(sum.x / n, sum.y / n, front) : sum;
  muzzles.set(gun, muzzle);
  return muzzle;
}

/** The `userData.attach` of a loaded model (or a copy of one), or null without a valid one. */
export function attachOf(model: THREE.Object3D): Attach | null {
  const a = (model.userData as { attach?: Partial<Attach> }).attach;
  return a && isNumbers(a.translation, 3) && isNumbers(a.rotation, 4)
    ? (a as Attach)
    : null;
}

/**
 * The fallback for a model without `userData.attach` (an asset set from before it): how each
 * family sits on `wpn`, turned into the game's axes with the origin on the bone. Right for
 * models whose `weapon` bone is near their origin, the AK's within 11 cm; the M4A4's is 56 cm.
 */
export const WEAPON_OFFSETS: Readonly<Record<Family, Hold>> = {
  rifle: { position: [0, 0, 0], rotation: GAME_AXES },
  pistol: { position: [0, 0, 0], rotation: GAME_AXES },
  knife: { position: [0, 0, 0], rotation: GAME_AXES },
  grenade: { position: [0, 0, 0], rotation: GAME_AXES },
  c4: { position: [0, 0, 0], rotation: GAME_AXES },
};

/** The C4 strapped to a carrier's back (on `spine_3`) while another weapon is out. */
export const C4_BACK_OFFSET: Hold = {
  position: [0, -0.05, -0.17],
  rotation: [0, Math.PI / 2, Math.PI / 2],
};

export function placeHold(o: THREE.Object3D, h: Hold): void {
  o.position.set(...h.position);
  o.rotation.set(...h.rotation);
}

const bone = new THREE.Matrix4();
const boneAt = new THREE.Vector3();
const boneTurn = new THREE.Quaternion();
const ONE = new THREE.Vector3(1, 1, 1);

/**
 * Puts a held copy of a weapon model on `wpn` (its parent) the way the game does: the model's
 * `weapon` bone on `wpn`, so the copy's transform is the inverse of the bone's rest pose. A model
 * without the pose falls back to its family's `WEAPON_OFFSETS`.
 */
export function placeHeld(o: THREE.Object3D, family: Family): void {
  const a = attachOf(o);
  if (!a) {
    placeHold(o, WEAPON_OFFSETS[family]);
    return;
  }
  bone
    .compose(boneAt.set(...a.translation), boneTurn.set(...a.rotation), ONE)
    .invert()
    .decompose(o.position, o.quaternion, o.scale);
}

/**
 * A copy of weapon model `src` dressed in `look`: one material per source material, made here
 * and pushed to `materials` for the caller to free (they are never team-tinted); the geometry
 * stays shared with the cache, which frees it.
 */
export function cloneWeapon(
  src: THREE.Object3D,
  look: LookOptions,
  materials: LookMaterial[],
  shadows: boolean
): THREE.Object3D {
  const o = src.clone(true);
  const dress = modelDresser(look, materials);
  o.traverse((c) => {
    const mesh = c as THREE.Mesh;
    if (!mesh.isMesh) return;
    dress(mesh);
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
  });
  return o;
}

/**
 * `m` as a manifest whose `weapons` is an object: a manifest's JSON without one (or that is not
 * an object) lists nothing. Null stays null (no manifest: models load unversioned).
 */
function listed(m: WeaponManifest | null | undefined): WeaponManifest | null {
  if (m === null || m === undefined) return null;
  const weapons: unknown = typeof m === 'object' ? m.weapons : undefined;
  return typeof weapons === 'object' && weapons !== null ? m : { weapons: {} };
}

/** Fetches a weapon's model once; rigs clone what it holds. */
export class WeaponCache {
  /** Called once each time a model finishes loading, so the scene can draw again. */
  onLoad: (() => void) | null = null;
  private readonly load: (url: string) => Promise<THREE.Object3D>;
  private manifest: WeaponManifest | null;
  private readonly models = new Map<string, THREE.Object3D | null>();
  private readonly pending = new Set<string>();
  private disposed = false;

  constructor(
    load: (url: string) => Promise<THREE.Object3D>,
    manifest: WeaponManifest | null = null
  ) {
    this.load = load;
    this.manifest = listed(manifest);
  }

  /**
   * The server's `/weapons/manifest.json` (null: none). One without a `weapons` table (or not an
   * object at all) lists no weapon, as the arms' and a map's manifest read then: nothing is
   * asked for.
   */
  setManifest(m: WeaponManifest | null): void {
    this.manifest = listed(m);
  }

  /**
   * The model named `name` (a `weaponModelName`), or null: not loaded yet (a load starts on
   * the first ask), failed, or not in the manifest when there is one. Never cloned: callers
   * clone it.
   */
  get(name: string): THREE.Object3D | null {
    const have = this.models.get(name);
    if (have !== undefined) return have;
    if (this.pending.has(name) || this.disposed) return null;
    if (this.manifest && !this.manifest.weapons[name]) {
      this.models.set(name, null);
      return null;
    }
    this.pending.add(name);
    const url = assetUrl(
      `/weapons/${encodeURIComponent(name)}.glb`,
      this.manifest?.weapons[name]?.sha256
    );
    this.load(url).then(
      (o) => {
        this.pending.delete(name);
        if (this.disposed) return;
        this.models.set(name, o);
        this.onLoad?.();
      },
      (e: unknown) => {
        this.pending.delete(name);
        this.models.set(name, null);
        console.warn(
          `weapon ${name}: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    );
    return null;
  }

  /** Whether `name`'s model is on its way: asked for, neither loaded nor failed yet. */
  loading(name: string): boolean {
    return this.pending.has(name);
  }

  dispose(): void {
    this.disposed = true;
    for (const o of this.models.values()) {
      o?.traverse((c) => {
        const mesh = c as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.dispose();
        for (const m of Array.isArray(mesh.material)
          ? mesh.material
          : [mesh.material])
          m.dispose();
      });
    }
    this.models.clear();
  }
}
