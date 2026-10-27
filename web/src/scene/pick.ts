// Where the players are on screen, for picking one with a tap (`geo/pick`'s `nearestWithin`):
// each living player's chest as the camera drew it, in CSS pixels.

import * as THREE from 'three';
import { UNIT, eyePoint } from '../geo/coords';
import { FLAG } from '../pack/types';
import type { PlayerState } from '../sim/sample';

/** The chest is this far below the eye, in Source units. */
const CHEST_BELOW_EYE = 20;

const _p = new THREE.Vector3();

/**
 * The chest (the eye point lowered 20 units) of each present, living player in front of
 * `camera`, in CSS pixels of a `width` × `height` view, with their index in `states`.
 * `hidden` (the player whose eyes the view looks through) is left out. The camera's matrices
 * are used as last updated, which after a draw is the view on screen.
 */
export function screenPoints(
  states: readonly PlayerState[],
  camera: THREE.Camera,
  width: number,
  height: number,
  hidden: number | null
): { index: number; x: number; y: number }[] {
  const out: { index: number; x: number; y: number }[] = [];
  for (let i = 0; i < states.length; i++) {
    const s = states[i];
    if (i === hidden || !s?.present || (s.flags & FLAG.alive) === 0) continue;
    eyePoint(s, _p);
    _p.y -= CHEST_BELOW_EYE * UNIT;
    // The camera looks down its -z: anything at or behind z = 0 is not in front of it.
    _p.applyMatrix4(camera.matrixWorldInverse);
    if (!(_p.z < 0)) continue;
    _p.applyMatrix4(camera.projectionMatrix);
    out.push({
      index: i,
      x: ((_p.x + 1) / 2) * width,
      y: ((1 - _p.y) / 2) * height,
    });
  }
  return out;
}
