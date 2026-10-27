import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import {
  footfalls,
  LAND_MIN_AIR_S,
  STEP_S,
  STEP_SPEED,
} from '../src/sim/footsteps';
import { trackPack, type SampleSpec } from './helpers/track-pack';

// 64 ticks/s, 2 ticks per sample (32 Hz): the round starts at tick 1000.
const T = 1000;
const R = 64;
const HZ = 32;

/** The footfalls of a lone player whose sample k is `fn(k)`. */
function falls(fn: (k: number) => SampleSpec) {
  const p = trackPack({ players: [fn] });
  return footfalls(p.rounds[0].players[0], p.header.rounds[0], p.header);
}

/** Runs along x at `speed` u/s for the first `seconds`, then stands. */
const run =
  (
    speed: number,
    seconds: number,
    extra: (k: number) => SampleSpec = () => ({})
  ) =>
  (k: number): SampleSpec => ({
    x: (Math.min(k, seconds * HZ) * speed) / HZ,
    y: 0,
    ...extra(k),
  });

const steps = (list: ReturnType<typeof falls>) =>
  list.filter((f) => f.kind === 'step');
const lands = (list: ReturnType<typeof falls>) =>
  list.filter((f) => f.kind === 'land');

describe('footfalls', () => {
  it("are CS2's walk threshold, a step every 0.3 s and 0.2 s in the air", () => {
    expect(STEP_SPEED).toBeCloseTo(260 * 0.52, 6);
    expect(STEP_S).toBe(0.3);
    expect(LAND_MIN_AIR_S).toBe(0.2);
  });

  it('a player running at 250 u/s for 1 s steps at 0, 0.3, 0.6 and 0.9 s', () => {
    const s = steps(falls(run(250, 1)));
    expect(s).toHaveLength(4);
    [0, 0.3, 0.6, 0.9].forEach((at, i) => {
      // Within a sample of the beat.
      expect(Math.abs(s[i].tick - (T + at * R))).toBeLessThanOrEqual(2);
    });
    // Each step is where the player is at its sample.
    expect(s[0]).toEqual({ tick: T, kind: 'step', x: 0, y: 0, z: 0 });
    expect(s[1].x).toBeGreaterThan(70);
    expect(lands(falls(run(250, 1)))).toEqual([]);
  });

  it('walking, under the threshold or crouched, nobody steps', () => {
    const walking = () => ({ flags: FLAG.alive | FLAG.walking });
    expect(falls(run(250, 1, walking))).toEqual([]);
    expect(falls(run(130, 1))).toEqual([]);
    expect(falls(run(250, 1, () => ({ duck: 200 })))).toEqual([]);
    // Half crouched still steps.
    expect(steps(falls(run(250, 1, () => ({ duck: 127 }))))).toHaveLength(4);
  });

  it('a dead player and a player in the air do not step', () => {
    expect(falls(run(250, 1, () => ({ flags: 0 })))).toEqual([]);
    expect(
      falls(run(250, 1, () => ({ flags: FLAG.alive | FLAG.airborne })))
    ).toEqual([]);
  });

  it('a break restarts the phase: the first running sample after it steps', () => {
    // Walks (the flag) on samples 5..7, which spans no beat: the next step is sample 8, not
    // the beat at 0.3 s (sample 9.6).
    const s = steps(
      falls(
        run(250, 2, (k) => ({
          flags: k >= 5 && k <= 7 ? FLAG.alive | FLAG.walking : FLAG.alive,
        }))
      )
    );
    expect(s[0].tick).toBe(T);
    expect(s[1].tick).toBe(T + 8 * 2);
    expect(Math.abs(s[2].tick - (T + 16 + STEP_S * R))).toBeLessThanOrEqual(2);
  });

  it('lands on the first grounded sample after 0.5 s in the air; 0.1 s is not a landing', () => {
    const air = (from: number, n: number) => (k: number) => ({
      x: 10,
      y: 20,
      z: k >= from && k < from + n ? 40 : 0,
      flags:
        k >= from && k < from + n ? FLAG.alive | FLAG.airborne : FLAG.alive,
    });
    // 16 samples = 0.5 s airborne from sample 10: grounded again at sample 26.
    expect(falls(air(10, 16))).toEqual([
      { tick: T + 26 * 2, kind: 'land', x: 10, y: 20, z: 0 },
    ]);
    // 3 samples ≈ 0.1 s.
    expect(falls(air(10, 3))).toEqual([]);
  });

  it('a runner coming down at speed lands and steps on the same sample, the landing first', () => {
    // Running at 250 u/s throughout, airborne on samples 10..25 (0.5 s): sample 26 is both the
    // landing and, the beat restarted by the jump, a step.
    const list = falls(
      run(250, 2, (k) => ({
        flags: k >= 10 && k < 26 ? FLAG.alive | FLAG.airborne : FLAG.alive,
      }))
    );
    const at26 = list.filter((f) => f.tick === T + 26 * 2);
    expect(at26.map((f) => f.kind)).toEqual(['land', 'step']);
    expect(at26[0]).toEqual({ ...at26[1], kind: 'land' });
    // Nothing in the air.
    expect(
      list.filter((f) => f.tick > T + 9 * 2 && f.tick < T + 26 * 2)
    ).toEqual([]);
  });

  it('a death in the air is no landing', () => {
    const list = falls((k) => ({
      flags: k < 10 ? FLAG.alive : k < 30 ? FLAG.alive | FLAG.airborne : 0,
    }));
    expect(list).toEqual([]);
  });
});
