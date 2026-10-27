// The one place Source coordinates become three.js ones. Source is Z up with X forward and
// measures in units (1 inch); glTF/three is Y up, metres, and the player rigs face +Z.

/** Metres per Source unit. */
export const UNIT = 0.0254;

/** Eye heights above the feet, in Source units. */
export const EYE_STANDING = 64;
export const EYE_CROUCHED = 46;

const DEG = Math.PI / 180;

/** Structurally compatible with `THREE.Vector3`, so a Vector3 can be passed as `out`. */
export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

/** Source position (units) → scene position (metres): `(y, z, x) · UNIT`. */
export function toScene(
  x: number,
  y: number,
  z: number,
  out: Vector3Like = { x: 0, y: 0, z: 0 }
): Vector3Like {
  out.x = y * UNIT;
  out.y = z * UNIT;
  out.z = x * UNIT;
  return out;
}

/**
 * The eye point in scene metres; the eye drops from 64 to 46 units as `duck` goes to 255.
 * Takes any `PlayerState`-shaped value, so this module stays a leaf that imports nothing.
 */
export function eyePoint<T extends Vector3Like>(
  s: { x: number; y: number; z: number; duck: number },
  out: T
): T {
  const duck = Math.min(1, Math.max(0, s.duck / 255));
  const h = EYE_STANDING + (EYE_CROUCHED - EYE_STANDING) * duck;
  toScene(s.x, s.y, s.z + h, out);
  return out;
}

/**
 * Source yaw (degrees) → `rotation.y` of a +Z-forward rig. Yaw θ faces Source
 * `(cos θ, sin θ)`, which `toScene` puts at `(sin θ, ·, cos θ)`: exactly where a rotation of
 * θ about +Y turns +Z.
 */
export function yawToRotationY(yawDeg: number): number {
  return yawDeg * DEG;
}

/**
 * The unit look direction in scene axes. Source pitch is positive looking down, so
 * `p = -pitch`: `(cos p · sin θ, sin p, cos p · cos θ)`.
 */
export function viewDir(
  yawDeg: number,
  pitchDeg: number,
  out: Vector3Like = { x: 0, y: 0, z: 0 }
): Vector3Like {
  const t = yawDeg * DEG;
  const p = -pitchDeg * DEG;
  const c = Math.cos(p);
  out.x = c * Math.sin(t);
  out.y = Math.sin(p);
  out.z = c * Math.cos(t);
  return out;
}

/** Structurally compatible with `THREE.Quaternion`, so a Quaternion can be passed as `out`. */
export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Source angles (degrees) → the scene rotation of an entity at those angles, as a quaternion:
 * `S·R·Sᵀ`, where `R = Rz(yaw)·Ry(pitch)·Rx(roll)` is Source's `AngleMatrix` and `S` takes Source
 * `(x, y, z)` to the scene's `(y, z, x)` (`toScene`). `S` only renames the axes in turn, so this
 * is yaw about the scene's +Y, then pitch about +X, then roll about +Z, each by the same angle:
 * `q = qY(yaw)·qX(pitch)·qZ(roll)`. The tools write each entities.glb root's rotation the same
 * way (`tools/lib/entities.mjs` `anglesToGltfQuat`).
 */
export function sourceAnglesToQuaternion<T extends QuaternionLike>(
  pitch: number,
  yaw: number,
  roll: number,
  out: T
): T {
  const hp = (pitch * DEG) / 2;
  const hy = (yaw * DEG) / 2;
  const hr = (roll * DEG) / 2;
  const sp = Math.sin(hp);
  const cp = Math.cos(hp);
  const sy = Math.sin(hy);
  const cy = Math.cos(hy);
  const sr = Math.sin(hr);
  const cr = Math.cos(hr);
  // qY·qX = (cy·sp, sy·cp, −sy·sp, cy·cp), then times qZ = (0, 0, sr, cr).
  const x = cy * sp;
  const y = sy * cp;
  const z = -sy * sp;
  const w = cy * cp;
  out.x = x * cr + y * sr;
  out.y = y * cr - x * sr;
  out.z = w * sr + z * cr;
  out.w = w * cr - z * sr;
  return out;
}

/**
 * Source (x, y) → pixels of the map's 1024 px radar, the formula of `tools/lib/overview.mjs`:
 * `((x - posX) / scale, (posY - y) / scale)`.
 */
export function worldToRadar(
  x: number,
  y: number,
  ov: { posX: number; posY: number; scale: number }
): [number, number] {
  return [(x - ov.posX) / ov.scale, (ov.posY - y) / ov.scale];
}
