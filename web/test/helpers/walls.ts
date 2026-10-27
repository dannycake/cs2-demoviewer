// Walls for the bullets' tests: 20 m planes across scene +z, each a mesh named as a hull
// collision group, merged into a hull as `loadHull` merges hull.glb (`mergeMeshes`), so each
// carries its surface.

import * as THREE from 'three';
import { Hull } from '../../src/scene/hull';
import { mergeMeshes } from '../../src/scene/loaders';

/**
 * A 20 m wall across +z at `z`, named as a hull group: facing the origin (−z) by its winding, or
 * away from it (+z) when `away`.
 */
export function wall(name: string, z: number, away = false): THREE.Mesh {
  const g = new THREE.PlaneGeometry(20, 20);
  if (!away) g.rotateY(Math.PI);
  const m = new THREE.Mesh(g);
  m.name = name;
  m.position.z = z;
  return m;
}

/** The walls merged into one hull. */
export function wallsHull(...walls: THREE.Mesh[]): Hull {
  const root = new THREE.Group();
  root.add(...walls);
  return new Hull(mergeMeshes(root));
}

/**
 * A chainlink fence 2 m ahead (bullets pass it), metal at 5 m facing the origin and wood at 8 m
 * facing away (a bullet leaves a solid by such a face).
 */
export const fenceMetalWood = () =>
  wallsHull(
    wall('physics_passbullets_chainlink', 2),
    wall('physics_group_metal', 5),
    wall('physics_group_wood', 8, true)
  );
