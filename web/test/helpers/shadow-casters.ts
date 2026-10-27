// What three's shadow pass draws of a scene, for the tests of the sun's map of the world
// (lighting.ts `drawWorldShadow`), which the renderer stub does not draw.

import type * as THREE from 'three';

/**
 * What three r186's shadow pass (`WebGLShadowMap.renderObject`) draws of `root` for `camera`:
 * it walks `children` from `root`, skips what is hidden and what is under it, and draws every
 * mesh that shares a layer with `camera` and casts.
 */
export function shadowCasters(
  root: THREE.Object3D,
  camera: THREE.Camera
): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  const walk = (o: THREE.Object3D) => {
    if (!o.visible) return;
    if (
      (o as THREE.Mesh).isMesh &&
      o.layers.test(camera.layers) &&
      o.castShadow
    )
      out.push(o);
    for (const c of o.children) walk(c);
  };
  walk(root);
  return out;
}
