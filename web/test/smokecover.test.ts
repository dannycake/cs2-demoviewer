// How much of a point the smokes hide from the eye: the share of each smoke between them.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  SMOKE_COVER_DEPTH,
  smokeCover,
  type SmokeSphere,
} from '../src/scene/smokecover';
import { SMOKE } from '../src/scene/utility';

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
/** A smoke at full size and opacity, `SMOKE`'s, at `centre`. */
const full = (centre: THREE.Vector3, opacity = SMOKE.opacity): SmokeSphere => ({
  centre,
  radius: SMOKE.radius,
  opacity,
});
const cover = (smokes: SmokeSphere[], eye: THREE.Vector3, p: THREE.Vector3) =>
  smokeCover(smokes, eye, p.x, p.y, p.z);

describe('smokeCover', () => {
  const eye = v(0, 1.6, 0);
  // A smoke 10 m ahead (scene +z).
  const smoke = full(v(0, 1.6, 10));

  it('hides what is behind a full smoke, all but its opacity', () => {
    expect(cover([smoke], eye, v(0, 1.6, 20))).toBeCloseTo(SMOKE.opacity, 9);
    // Behind it off its middle, by a line still more than a radius deep in it.
    expect(cover([smoke], eye, v(1.5, 1.6, 20))).toBeCloseTo(SMOKE.opacity, 9);
  });

  it('hides nothing in front of a smoke, beside it or with none', () => {
    expect(cover([smoke], eye, v(0, 1.6, 5))).toBe(0);
    expect(cover([smoke], eye, v(0, 1.6, 9.99 - SMOKE.radius))).toBe(0);
    // Beside it: the line to the point passes it by.
    expect(cover([smoke], eye, v(8, 1.6, 20))).toBe(0);
    expect(cover([smoke], eye, v(-8, 1.6, 10))).toBe(0);
    expect(cover([], eye, v(0, 1.6, 20))).toBe(0);
  });

  it('counts only the part of a smoke between the eye and the point', () => {
    // At its middle: a radius of it in front, all of it hidden.
    expect(cover([smoke], eye, v(0, 1.6, 10))).toBeCloseTo(SMOKE.opacity, 9);
    // A metre into its near side: a metre of it.
    const metre = cover([smoke], eye, v(0, 1.6, 10 - SMOKE.radius + 1));
    expect(metre).toBeCloseTo(
      SMOKE.opacity / (SMOKE_COVER_DEPTH * SMOKE.radius),
      9
    );
    // Behind its rim, the line passing 3.6 m from its middle: a little.
    const rim = cover([smoke], eye, v(0, 9.3, 20));
    expect(rim).toBeGreaterThan(0);
    expect(rim).toBeLessThan(SMOKE.opacity / 2);
  });

  it('fades with the smoke: one going out hides less, one of no size nothing', () => {
    expect(cover([full(v(0, 1.6, 10), 0.4)], eye, v(0, 1.6, 20))).toBeCloseTo(
      0.4,
      9
    );
    expect(cover([full(v(0, 1.6, 10), 0)], eye, v(0, 1.6, 20))).toBe(0);
    expect(
      cover(
        [{ centre: v(0, 1.6, 10), radius: 0, opacity: 1 }],
        eye,
        v(0, 1.6, 20)
      )
    ).toBe(0);
  });

  it('hides what is in a smoke from an eye inside it by the part between them', () => {
    const around = full(v(0, 1.6, 0));
    expect(cover([around], eye, v(0, 1.6, 1))).toBeCloseTo(
      SMOKE.opacity / (SMOKE_COVER_DEPTH * SMOKE.radius),
      9
    );
    // Out of it: the radius between, all of it.
    expect(cover([around], eye, v(0, 1.6, 30))).toBeCloseTo(SMOKE.opacity, 9);
  });

  it('takes two smokes in a row as light through each in turn', () => {
    const a = full(v(0, 1.6, 10), 0.5);
    const b = full(v(0, 1.6, 20), 0.5);
    expect(cover([a, b], eye, v(0, 1.6, 30))).toBeCloseTo(0.75, 9);
    // Between them: the near one only.
    expect(cover([a, b], eye, v(0, 1.6, 15))).toBeCloseTo(0.5, 9);
  });

  it('hides nothing of a point at the eye', () => {
    expect(cover([full(eye.clone())], eye, eye.clone())).toBe(0);
  });
});
