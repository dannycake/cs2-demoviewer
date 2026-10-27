import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EYE_CROUCHED,
  EYE_STANDING,
  sourceAnglesToQuaternion,
  toScene,
  UNIT,
  viewDir,
  worldToRadar,
  yawToRotationY,
} from '../src/geo/coords';

// Mirage's overview (tools/test/overview.test.mjs).
const MIRAGE = { posX: -3230, posY: 1713, scale: 5 };

function xyz(v: { x: number; y: number; z: number }): [number, number, number] {
  return [v.x, v.y, v.z];
}

function expectClose(actual: number[], expected: number[]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => expect(a).toBeCloseTo(expected[i], 9));
}

describe('toScene', () => {
  it('maps Source (x, y, z) units to three (y, z, x) metres', () => {
    expect(UNIT).toBe(0.0254);
    expectClose(xyz(toScene(100, 200, 300)), [5.08, 7.62, 2.54]);
  });

  it('writes into and returns `out` when given', () => {
    const out = { x: 9, y: 9, z: 9 };
    expect(toScene(1, 0, 0, out)).toBe(out);
    expectClose(xyz(out), [0, 0, 0.0254]);
  });
});

describe('yawToRotationY', () => {
  it('turns degrees into radians about +Y', () => {
    expect(yawToRotationY(90)).toBeCloseTo(Math.PI / 2, 12);
    expect(yawToRotationY(0)).toBe(0);
    expect(yawToRotationY(-180)).toBeCloseTo(-Math.PI, 12);
  });

  it('points a +Z-forward rig along the Source facing', () => {
    // A rig turned by rotation.y = r faces (sin r, 0, cos r); Source yaw 90 faces +Y, which
    // toScene puts on three's +X.
    const r = yawToRotationY(90);
    const facing = toScene(Math.cos(Math.PI / 2), Math.sin(Math.PI / 2), 0);
    expectClose(
      [Math.sin(r), 0, Math.cos(r)],
      xyz(facing).map((c) => c / UNIT)
    );
  });
});

describe('viewDir', () => {
  it('looks along +Z at yaw 0, pitch 0', () => {
    expectClose(xyz(viewDir(0, 0)), [0, 0, 1]);
  });

  it('looks along +X at yaw 90', () => {
    expectClose(xyz(viewDir(90, 0)), [1, 0, 0]);
  });

  it('looks up for a negative Source pitch', () => {
    const d = viewDir(0, -45);
    expect(d.y).toBeGreaterThan(0);
    expectClose(xyz(d), [0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(viewDir(0, 45).y).toBeLessThan(0);
  });

  it('is a unit vector and fills `out`', () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(viewDir(-123.4, 31.5, out)).toBe(out);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 12);
  });
});

describe('worldToRadar', () => {
  it('puts the overview origin at the radar corner', () => {
    expect(worldToRadar(-3230, 1713, MIRAGE)).toEqual([0, 0]);
  });

  it('puts a point (px, py) radar pixels from the corner at posX + px·scale, posY − py·scale', () => {
    expect(worldToRadar(-3230 + 5 * 1024, 1713 - 5 * 1024, MIRAGE)).toEqual([
      1024, 1024,
    ]);
    expect(worldToRadar(-3230 + 5 * 100, 1713 - 5 * 200, MIRAGE)).toEqual([
      100, 200,
    ]);
  });
});

describe('eye heights', () => {
  it('are 64 standing and 46 crouched, in units', () => {
    expect(EYE_STANDING).toBe(64);
    expect(EYE_CROUCHED).toBe(46);
  });
});

describe('sourceAnglesToQuaternion', () => {
  /** The 3×3 rotation of `q` as its three columns. */
  const columns = (q: THREE.Quaternion) => {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
    return [0, 1, 2].map((j) => [m[4 * j], m[4 * j + 1], m[4 * j + 2]]);
  };

  it("is S·R·Sᵀ: the spike's traffic cone on Inferno", () => {
    const q = new THREE.Quaternion();
    expect(sourceAnglesToQuaternion(8.039667, 237.830719, 10.532831, q)).toBe(
      q
    );
    expect(q.length()).toBeCloseTo(1, 12);
    const want = [
      [-0.54509, 0.181, 0.8186],
      [-0.01907, 0.97349, -0.22794],
      [-0.83816, -0.13986, -0.52719],
    ];
    columns(q).forEach((col, j) =>
      col.forEach((v, i) => expect(Math.abs(v - want[j][i])).toBeLessThan(1e-4))
    );
  });

  it('turns the model forward (0, 0, 1) into viewDir(yaw, pitch)', () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const q = new THREE.Quaternion();
    const v = new THREE.Vector3();
    for (let i = 0; i < 5; i++) {
      const yaw = rand() * 360 - 180;
      const pitch = rand() * 178 - 89;
      sourceAnglesToQuaternion(pitch, yaw, rand() * 360 - 180, q);
      v.set(0, 0, 1).applyQuaternion(q);
      expectClose(xyz(v), xyz(viewDir(yaw, pitch)));
    }
  });

  it('fills any {x, y, z, w}', () => {
    const out = { x: 9, y: 9, z: 9, w: 9 };
    expect(sourceAnglesToQuaternion(0, 180, 0, out)).toBe(out);
    expectClose([out.x, Math.abs(out.y), out.z, out.w], [0, 1, 0, 0]);
  });
});
