// Picking under a finger: the nearest point within a radius, what counts as a tap, and where
// each living player's chest lands on screen.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { EYE_STANDING, UNIT } from '../src/geo/coords';
import { PICK, isTap, nearestWithin } from '../src/geo/pick';
import { FLAG } from '../src/pack/types';
import { newPlayerState, type PlayerState } from '../src/sim/sample';
import { screenPoints } from '../src/scene/pick';

describe('nearestWithin', () => {
  const points = [
    { index: 0, x: 0, y: 0 },
    { index: 3, x: 30, y: 0 },
    { index: 5, x: 100, y: 100 },
  ];

  it('picks the nearest point inside the radius', () => {
    expect(nearestWithin(points, 20, 0, 40)).toBe(3);
    expect(nearestWithin(points, 10, 0, 40)).toBe(0);
    expect(nearestWithin(points, 90, 90, PICK.radiusPx)).toBe(5);
  });

  it('returns null when no point is inside the radius', () => {
    expect(nearestWithin(points, 200, 200, 40)).toBeNull();
    expect(nearestWithin(points, 15, 0, 5)).toBeNull();
    expect(nearestWithin([], 0, 0, 40)).toBeNull();
  });
});

describe('isTap', () => {
  const down = { x: 100, y: 100, t: 1000 };

  it('is a press of 250 ms or less that moved 10 px or less', () => {
    expect(PICK).toEqual({ radiusPx: 40, tapMs: 250, tapPx: 10 });
    expect(Object.isFrozen(PICK)).toBe(true);
    expect(isTap(down, { x: 103, y: 104, t: 1200 })).toBe(true);
    expect(isTap(down, { x: 103, y: 104, t: 1300 })).toBe(false);
    expect(isTap(down, { x: 112, y: 100, t: 1200 })).toBe(false);
  });
});

describe('screenPoints', () => {
  const W = 1600;
  const H = 900;

  /** A living player standing at Source (x, y, z). */
  function player(x: number, y: number, z: number): PlayerState {
    return {
      ...newPlayerState(),
      x,
      y,
      z,
      health: 100,
      flags: FLAG.alive,
      present: true,
    };
  }

  /** A camera at the chest height of a player standing at Source z 0, looking along +x. */
  function camera(): THREE.PerspectiveCamera {
    const c = new THREE.PerspectiveCamera(60, W / H, 0.05, 1000);
    const chest = (EYE_STANDING - 20) * UNIT;
    c.position.set(0, chest, 0);
    // Source +x is scene +z.
    c.lookAt(0, chest, 10);
    c.updateMatrixWorld();
    return c;
  }

  it('puts a player straight ahead within 1 px of the centre', () => {
    const pts = screenPoints([player(1000, 0, 0)], camera(), W, H, null);
    expect(pts).toHaveLength(1);
    expect(pts[0].index).toBe(0);
    expect(Math.abs(pts[0].x - W / 2)).toBeLessThan(1);
    expect(Math.abs(pts[0].y - H / 2)).toBeLessThan(1);
  });

  it('leaves out a player behind the camera', () => {
    const pts = screenPoints(
      [player(-1000, 0, 0), player(1000, 0, 0)],
      camera(),
      W,
      H,
      null
    );
    expect(pts.map((p) => p.index)).toEqual([1]);
  });

  it('leaves out dead, absent and hidden players', () => {
    const dead = { ...player(1000, 50, 0), flags: 0, health: 0 };
    // A body inside its death window: the last live sample with `alive` cleared.
    const body = { ...player(1000, -50, 0), flags: 0 };
    const absent = { ...player(1000, 100, 0), present: false };
    const states = [
      player(1000, 0, 0),
      dead,
      body,
      absent,
      player(1000, -100, 0),
    ];
    const pts = screenPoints(states, camera(), W, H, 4);
    expect(pts.map((p) => p.index)).toEqual([0]);
    expect(
      screenPoints(states, camera(), W, H, null).map((p) => p.index)
    ).toEqual([0, 4]);
  });
});
