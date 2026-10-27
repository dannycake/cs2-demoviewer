// The light grid (probes.ts) on what the players drop and throw: a grenade in flight, an item
// on the ground, the bomb. Each is a copy of a weapon model of its own (`cloneWeapon`, in the
// players' look: lit on a baked map), so each takes a sample of the grid of its own, as a player
// does: the grid's light in place of the sky light, and the sun past the shadow maps at
// `medium` and `high` (its meshes then take them: `receiveShadow`) or by the grid's sun at
// `low`, which has none. Without a grid (a map without a bake) it is left as the look made it:
// the sky light, the sun, and its own shadows or none.

import * as THREE from 'three';
import {
  attachProbe,
  detachProbe,
  makeProbeSample,
  sampleLightGrid,
  type LightGrid,
  type ProbeSample,
} from './probes';

/**
 * How far above what lies on the floor (an item on the ground, the bomb) the grid is read: the
 * lowest height its refit fits the cells to (tools/README.md, "The refit at volume borders").
 */
export const FLOOR_LIFT = 0.5;

/** The grid's light on one thing in the world, whatever copies of its model it shows. */
export class ItemLight {
  /** The grid's light where it was sampled last, which its lit materials read on every draw. */
  readonly sample: ProbeSample = makeProbeSample();
  /** Whether its meshes take the shadow maps without the grid (`cloneWeapon`'s `shadows`). */
  private readonly shadows: boolean;
  private readonly meshes: THREE.Mesh[] = [];
  /** The lit materials of `meshes`, each once. */
  private readonly materials: THREE.MeshLambertMaterial[] = [];
  /** The grid it is lit by, or null for the look's own light. */
  private grid: LightGrid | null = null;
  /** Where `sample` was taken; NaN before the first. */
  private readonly at = new THREE.Vector3(Number.NaN, 0, 0);

  constructor(shadows: boolean) {
    this.shadows = shadows;
  }

  /** Lights copy `o` (its meshes and lit materials) as the others, at once. */
  add(o: THREE.Object3D): void {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);
      mesh.receiveShadow = this.shadows || this.grid !== null;
      const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of ms) {
        if (
          !(m instanceof THREE.MeshLambertMaterial) ||
          this.materials.includes(m)
        )
          continue;
        this.materials.push(m);
        if (this.grid) attachProbe(m, this.sample);
      }
    });
  }

  /** Forgets copy `o`, which its maker is about to free: it is lit no further. */
  remove(o: THREE.Object3D): void {
    o.traverse((c) => {
      const mesh = c as THREE.Mesh;
      if (!mesh.isMesh) return;
      const i = this.meshes.indexOf(mesh);
      if (i >= 0) this.meshes.splice(i, 1);
      const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of ms) {
        const k = this.materials.indexOf(m as THREE.MeshLambertMaterial);
        if (k >= 0) this.materials.splice(k, 1);
      }
    });
  }

  /** Forgets every copy; their materials are their maker's to free. */
  clear(): void {
    this.meshes.length = 0;
    this.materials.length = 0;
    this.grid = null;
    this.at.x = Number.NaN;
  }

  /**
   * Lights its copies by `grid` at `p` (scene metres): samples the grid there when `p` or the
   * grid is not the last call's, else does nothing. With null, the look's own light and
   * shadows again. Allocates nothing.
   */
  set(grid: LightGrid | null, p: THREE.Vector3): void {
    if (grid !== this.grid) {
      this.grid = grid;
      this.at.x = Number.NaN;
      for (const m of this.materials) {
        if (grid) attachProbe(m, this.sample);
        else detachProbe(m);
      }
      for (const mesh of this.meshes)
        mesh.receiveShadow = this.shadows || grid !== null;
    }
    if (!grid || this.at.equals(p)) return;
    this.at.copy(p);
    sampleLightGrid(grid, p, this.sample);
  }
}
