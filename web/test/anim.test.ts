import { describe, expect, it } from 'vitest';
import {
  DEATH_COLLAPSE_S,
  DEATH_LIFT_M,
  DEATH_TOTAL_S,
  deathPhase,
  envelope,
  HIT_FLASH_S,
  hitFlash,
  LIVING,
} from '../src/sim/anim';
import { strideTime } from '../src/scene/frame';

describe('envelope', () => {
  it('rises over the fade-in, holds, and falls over the fade-out', () => {
    expect(envelope(0, 1, 0.1, 0.2)).toBe(0);
    expect(envelope(0.05, 1, 0.1, 0.2)).toBeCloseTo(0.5);
    expect(envelope(0.5, 1, 0.1, 0.2)).toBe(1);
    expect(envelope(0.9, 1, 0.1, 0.2)).toBeCloseTo(0.5);
    expect(envelope(1, 1, 0.1, 0.2)).toBe(0);
    expect(envelope(-0.01, 1, 0.1, 0.2)).toBe(0);
  });

  it('a play shorter than its fades never reaches full weight', () => {
    expect(envelope(0.05, 0.1, 0.1, 0.1)).toBeCloseTo(0.5);
    expect(envelope(0, 0.5, 0, 0)).toBe(1);
  });
});

describe('deathPhase', () => {
  const fallEnd = DEATH_COLLAPSE_S;

  it('is the living pose before the death', () => {
    expect(deathPhase(-0.1)).toEqual(LIVING);
    expect(deathPhase(NaN)).toEqual(LIVING);
  });

  it('starts to fall at the kill and lies flat within half a second', () => {
    const start = deathPhase(0);
    expect(start.topple).toBe(0);
    expect(start.opacity).toBe(1);
    expect(deathPhase(0.1).flinch).toBeGreaterThan(0.9);
    // Nothing waits: 0.1 s in, the knees are half gone and the body is already tipping.
    expect(deathPhase(0.1).buckle).toBeGreaterThanOrEqual(0.5);
    expect(deathPhase(0.1).topple).toBeGreaterThan(0.05);
    expect(DEATH_COLLAPSE_S).toBeLessThanOrEqual(0.5);
    // The hit's push, then gravity (0.3u + 0.7u²): half way through, a third of the angle.
    expect(deathPhase(DEATH_COLLAPSE_S / 2).topple).toBeCloseTo(0.325);
    expect(deathPhase(fallEnd).topple).toBeCloseTo(1);
    expect(deathPhase(fallEnd + 0.1).topple).toBeLessThan(1);
    expect(deathPhase(fallEnd + 0.1).topple).toBeGreaterThan(0.95);
    expect(deathPhase(fallEnd + 1).topple).toBe(1);
    expect(deathPhase(fallEnd + 1).lift).toBeCloseTo(DEATH_LIFT_M);
  });

  it('lies for 6 s, fades over 1.5 s, then is hidden', () => {
    expect(deathPhase(fallEnd + 5.9).opacity).toBe(1);
    expect(deathPhase(fallEnd + 6.75).opacity).toBeCloseTo(0.5);
    expect(deathPhase(DEATH_TOTAL_S - 1e-6).hidden).toBe(false);
    expect(deathPhase(DEATH_TOTAL_S)).toMatchObject({
      hidden: true,
      opacity: 0,
    });
    expect(DEATH_TOTAL_S).toBeCloseTo(fallEnd + 7.5);
  });

  it('snaps the head back only for a headshot', () => {
    expect(deathPhase(0.05, true).headSnap).toBeCloseTo(0.5);
    expect(deathPhase(0.5, true).headSnap).toBe(1);
    expect(deathPhase(0.5, false).headSnap).toBe(0);
  });
});

describe('hitFlash', () => {
  it('is full at the hit, eases out, and is gone HIT_FLASH_S later', () => {
    expect(hitFlash(0)).toBe(1);
    expect(hitFlash(HIT_FLASH_S / 2)).toBeCloseTo(0.25);
    expect(hitFlash(HIT_FLASH_S)).toBe(0);
    expect(hitFlash(-0.01)).toBe(0);
    expect(hitFlash(NaN)).toBe(0);
  });
});

describe('strideTime', () => {
  it('times strides by the distance walked, everything else by the clock', () => {
    expect(strideTime('run_n_rifle', 195)).toBeCloseTo(1);
    expect(strideTime('walk_sw_rifle', 220)).toBeCloseTo(2);
    expect(strideTime('crouch_e_rifle', 85)).toBeCloseTo(1);
    expect(strideTime('idle_rifle', 999)).toBeNull();
    expect(strideTime('idle_crouch_rifle', 999)).toBeNull();
    expect(strideTime('inair_stand_rifle', 999)).toBeNull();
  });
});
