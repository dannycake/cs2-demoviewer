import { describe, expect, it } from 'vitest';
import { SHAKE, blindAlpha, shakeAt, shakeOffset } from '../src/sim/impacts';

describe('blindAlpha', () => {
  it('holds white for the first 40 % of the blindness, then eases out to nothing', () => {
    const start = 1000;
    const end = 1100;
    expect(blindAlpha(start, end, 999)).toBe(0);
    expect(blindAlpha(start, end, 1000)).toBe(1);
    expect(blindAlpha(start, end, 1020)).toBe(1);
    expect(blindAlpha(start, end, 1040)).toBe(1);
    expect(blindAlpha(start, end, 1070)).toBeCloseTo(0.5, 9);
    expect(blindAlpha(start, end, 1099.999)).toBeCloseTo(0, 6);
    expect(blindAlpha(start, end, 1100)).toBe(0);
    expect(blindAlpha(start, start, start)).toBe(0);
  });
});

describe('shakeAt', () => {
  it('peaks within the first 0.1 s of an explosion and is gone at 0.6 s', () => {
    const r = 64;
    const at = (s: number) => shakeAt(1000, 1000 + s * r, r);
    const peak = Math.max(...[0.02, 0.04, 0.05, 0.06, 0.08].map(at));
    expect(peak).toBeCloseTo(SHAKE.amplitude, 9);
    expect(at(0.05)).toBe(peak);
    expect(at(0.3)).toBeLessThan(peak);
    expect(at(0.6)).toBe(0);
    expect(at(-0.01)).toBe(0);
    expect(shakeAt(null, 1000, r)).toBe(0);
  });

  it('shakes in a direction fixed by the tick, never longer than the amplitude', () => {
    const a = shakeOffset(1000, 1010, 64, { x: 0, y: 0, z: 0 });
    const b = shakeOffset(1000, 1010, 64, { x: 0, y: 0, z: 0 });
    expect(a).toEqual(b);
    for (let t = 1000; t < 1040; t++) {
      const o = shakeOffset(1000, t, 64, { x: 0, y: 0, z: 0 });
      expect(Math.hypot(o.x, o.y, o.z)).toBeLessThanOrEqual(
        shakeAt(1000, t, 64) + 1e-12
      );
    }
  });
});
