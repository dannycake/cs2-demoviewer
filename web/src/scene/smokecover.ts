// How much of an effect the smokes hide from the eye. The effects are drawn in batches that all
// stand at the origin (`FlipbookBatch`), so three's sort cannot put them behind or in front of
// the smokes' batch by their depth: they tie, and go by when they were made. The smokes' batch is
// made first (the utility is made before the impacts and the marks, and its smokes first in it),
// so it is drawn first and whatever stands in front of a smoke is drawn over it. What stands
// behind one is faded by it here, sprite by sprite, as it is pushed: by the share of each smoke
// between it and the eye.

import type * as THREE from 'three';

/** A smoke as what is behind it sees it: a ball `radius` metres about `centre`. */
export interface SmokeSphere {
  readonly centre: Readonly<THREE.Vector3>;
  readonly radius: number;
  /** How much of what is behind it at its thickest it hides, 0 to 1. */
  readonly opacity: number;
}

/**
 * How far into a smoke, as a share of its radius, the line from the eye must run for the smoke
 * to hide what is at its end at its full opacity; less, a share of that. A line through a smoke's
 * middle runs twice that, so a smoke hides all of what is behind it but its rim, and what stands
 * at its middle; what stands just inside its near side shows through it.
 */
export const SMOKE_COVER_DEPTH = 1;

/**
 * How much of the point (x, y, z) the `smokes` hide from `eye`, 0 (none) to 1: for each smoke,
 * its opacity times the share of `SMOKE_COVER_DEPTH` of the line from the eye to the point that
 * runs inside it, only the part between them (a smoke behind the point, or beside the line,
 * hides none of it), the smokes together as light through each in turn. A function of the
 * smokes and the eye alone; allocates nothing.
 */
export function smokeCover(
  smokes: readonly SmokeSphere[],
  eye: Readonly<THREE.Vector3>,
  x: number,
  y: number,
  z: number
): number {
  const n = smokes.length;
  if (n === 0) return 0;
  let dx = x - eye.x;
  let dy = y - eye.y;
  let dz = z - eye.z;
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(length > 1e-6)) return 0;
  dx /= length;
  dy /= length;
  dz /= length;
  let through = 1;
  for (let i = 0; i < n; i++) {
    const s = smokes[i];
    const r = s.radius;
    if (!(r > 0) || !(s.opacity > 0)) continue;
    const ox = eye.x - s.centre.x;
    const oy = eye.y - s.centre.y;
    const oz = eye.z - s.centre.z;
    // The line meets the ball where t² + 2bt + c = 0.
    const b = ox * dx + oy * dy + oz * dz;
    const c = ox * ox + oy * oy + oz * oz - r * r;
    const d = b * b - c;
    if (!(d > 0)) continue;
    const root = Math.sqrt(d);
    const inside = Math.min(length, -b + root) - Math.max(0, -b - root);
    if (!(inside > 0)) continue;
    through *=
      1 -
      Math.min(1, s.opacity) * Math.min(1, inside / (SMOKE_COVER_DEPTH * r));
  }
  return 1 - through;
}
