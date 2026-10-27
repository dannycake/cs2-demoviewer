import { describe, expect, it } from 'vitest';
import {
  newPlayerState,
  playerStateAt,
  sampleAt,
  sampleIndex,
  speedHalfWindow,
} from '../src/sim/sample';
import { SPEED_IDLE } from '../src/sim/locomotion';
import {
  FLAG,
  type MatchHeader,
  type PlayerTrack,
  type RoundInfo,
} from '../src/pack/types';

const A = FLAG.alive;

const ROUND: RoundInfo = {
  number: 1,
  start_tick: 100,
  freeze_end_tick: 100,
  end_tick: 104,
  post_end_tick: 104,
  winner: 2,
  reason: 't_killed',
  score_t: 1,
  score_ct: 0,
  samples: 3,
};

const HEADER: MatchHeader = {
  version: 1,
  map: 'de_test',
  server_name: 'test',
  game_build: '1',
  tick_rate: 64,
  sample_hz: 32,
  tick_step: 2,
  players: [{ steamid: '1', name: 'a', team_by_round: [2], crosshair: null }],
  rounds: [ROUND],
  weapons: ['none', 'ak47'],
};

interface TrackCols {
  x?: number[];
  y?: number[];
  z?: number[];
  yaw?: number[];
  pitch?: number[];
  health?: number[];
  armor?: number[];
  flags?: number[];
  duck?: number[];
  weapon?: number[];
}

/** A track of `n` samples; angles are given in degrees and stored x100 like the pack. */
function track(c: TrackCols, n = ROUND.samples): PlayerTrack {
  const i16 = (v: number[] | undefined, mul = 1) =>
    Int16Array.from(v ?? new Array(n).fill(0), (a) => Math.round(a * mul));
  const u8 = (v: number[] | undefined, fill = 0) =>
    Uint8Array.from(v ?? new Array(n).fill(fill));
  return {
    x: i16(c.x),
    y: i16(c.y),
    z: i16(c.z),
    yaw: i16(c.yaw, 100),
    pitch: i16(c.pitch, 100),
    health: u8(c.health, 100),
    armor: u8(c.armor),
    flags: u8(c.flags, A),
    duck: u8(c.duck),
    weapon: u8(c.weapon),
    money: new Uint16Array(n),
    ammo: new Uint8Array(n).fill(255),
    gear: new Uint8Array(n),
  };
}

function at(t: PlayerTrack, tick: number) {
  return playerStateAt(t, ROUND, tick, HEADER, newPlayerState());
}

describe('sampleIndex', () => {
  it('splits a tick into a sample and a fraction', () => {
    expect(sampleIndex(ROUND, 100, 2)).toEqual({ k: 0, f: 0 });
    expect(sampleIndex(ROUND, 101, 2)).toEqual({ k: 0, f: 0.5 });
    expect(sampleIndex(ROUND, 102.5, 2)).toEqual({ k: 1, f: 0.25 });
  });

  it('clamps to the round', () => {
    expect(sampleIndex(ROUND, 50, 2)).toEqual({ k: 0, f: 0 });
    expect(sampleIndex(ROUND, 104, 2)).toEqual({ k: 2, f: 0 });
    expect(sampleIndex(ROUND, 1e6, 2)).toEqual({ k: 2, f: 0 });
  });

  it('survives an empty round', () => {
    expect(sampleIndex({ ...ROUND, samples: 0 }, 101, 2)).toEqual({
      k: 0,
      f: 0,
    });
  });

  it('writes into the object it is given, for a caller that runs every frame', () => {
    const out = { k: 9, f: 9 };
    expect(sampleIndex(ROUND, 102.5, 2, out)).toBe(out);
    expect(out).toEqual({ k: 1, f: 0.25 });
    expect(sampleIndex(ROUND, 1e6, 2, out)).toBe(out);
    expect(out).toEqual({ k: 2, f: 0 });
  });
});

describe('sampleAt', () => {
  it('copies one sample as the pack stores it, leaving present and speed alone', () => {
    const t = track({
      x: [1, 2, 3],
      y: [4, 5, 6],
      z: [7, 8, 9],
      yaw: [10, 190, 30],
      pitch: [-5, 6, 7],
      health: [100, 42, 0],
      flags: [A, A, 0],
      duck: [0, 128, 255],
      weapon: [0, 1, 0],
    });
    const out = { ...newPlayerState(), present: true, speed: 123 };
    expect(sampleAt(t, 1, out)).toBe(out);
    expect(out).toMatchObject({
      x: 2,
      y: 5,
      z: 8,
      yaw: -170,
      pitch: 6,
      health: 42,
      flags: A,
      duck: 128,
      weapon: 1,
      present: true,
      speed: 123,
    });
  });
});

describe('playerStateAt', () => {
  it('interpolates position and reports the segment speed', () => {
    const t = track({ x: [0, 32, 64], y: [0, 0, 0], z: [10, 20, 30] });
    const s = at(t, 101);
    expect(s.x).toBe(16);
    expect(s.z).toBe(15);
    expect(s.speed).toBe(32 * HEADER.sample_hz);
    expect(s.present).toBe(true);
    expect(at(t, 103).x).toBe(48);
    // On the last sample the speed is the last segment's, not zero.
    expect(at(t, 104).x).toBe(64);
    expect(at(t, 104).speed).toBe(32 * HEADER.sample_hz);
  });

  it('measures speed in the horizontal plane only', () => {
    const t = track({ x: [0, 3, 6], y: [0, 4, 8], z: [0, 100, 200] });
    expect(at(t, 100).speed).toBe(5 * HEADER.sample_hz);
  });

  it('turns yaw the short way across +-180', () => {
    const t = track({ yaw: [170, -170, -170] });
    expect(at(t, 100).yaw).toBeCloseTo(170, 9);
    expect(at(t, 102).yaw).toBeCloseTo(-170, 9);
    // Through 180, never back through 0.
    for (let tick = 100; tick <= 102; tick += 0.125)
      expect(Math.abs(at(t, tick).yaw)).toBeGreaterThanOrEqual(170 - 1e-9);
    const back = track({ yaw: [-170, 170, 170] });
    for (let tick = 100; tick <= 102; tick += 0.125)
      expect(Math.abs(at(back, tick).yaw)).toBeGreaterThanOrEqual(170 - 1e-9);
    expect(at(back, 100.5).yaw).toBeLessThan(-170);
  });

  it('passes through every sample of yaw and pitch, in degrees', () => {
    const t = track({ yaw: [10, 20, 40], pitch: [-10, 30, 30] });
    expect(at(t, 102).yaw).toBeCloseTo(20, 9);
    expect(at(t, 102).pitch).toBeCloseTo(30, 9);
    expect(at(t, 104).yaw).toBeCloseTo(40, 9);
    expect(at(t, 101).pitch).toBeGreaterThan(-10);
    expect(at(t, 101).pitch).toBeLessThan(30);
  });

  it('takes u8 columns from the lower sample, but the duck amount moves between them', () => {
    const t = track({
      health: [100, 50, 50],
      armor: [80, 0, 0],
      flags: [A | FLAG.walking, A, A],
      duck: [0, 255, 255],
      weapon: [1, 0, 0],
    });
    const s = at(t, 101.9);
    expect([s.health, s.armor, s.flags, s.weapon]).toEqual([
      100,
      80,
      A | FLAG.walking,
      1,
    ]);
    expect(s.duck).toBeCloseTo(0.95 * 255, 9);
    expect(at(t, 101).duck).toBeCloseTo(127.5, 9);
    expect(at(t, 102).health).toBe(50);
  });

  it('is present only once a live sample is reached', () => {
    const t = track({ x: [500, 0, 32], flags: [0, A, A] });
    const before = at(t, 100);
    expect(sampleIndex(ROUND, 100, 2)).toEqual({ k: 0, f: 0 });
    expect(before.present).toBe(false);
    const s = at(t, 101);
    expect(s.present).toBe(true);
    // Spawning: no slide in from the dead sample's position, and the live sample's flags.
    expect(s.x).toBe(0);
    expect(s.flags & A).toBe(A);
    expect(s.speed).toBe(0);
  });

  it('holds the last live sample while dying, then is absent', () => {
    const t = track({ x: [0, 32, 900], flags: [A, A, 0] });
    const s = at(t, 103);
    expect(s.present).toBe(true);
    expect(s.x).toBe(32);
    expect(s.flags & A).toBe(A);
    expect(at(t, 104).present).toBe(false);
    expect(at(t, 104).flags & A).toBe(0);
  });

  it('is absent for a player with no live sample in the round', () => {
    const t = track({ flags: [0, 0, 0] });
    for (const tick of [100, 101, 103, 104])
      expect(at(t, tick).present).toBe(false);
  });

  it('is a pure function of the tick (scrubbing back and forth)', () => {
    const t = track({ x: [0, 32, 64], yaw: [170, -170, 10], flags: [A, A, 0] });
    const out = newPlayerState();
    const a1 = { ...playerStateAt(t, ROUND, 103, HEADER, out) };
    playerStateAt(t, ROUND, 100.5, HEADER, out);
    const a2 = { ...playerStateAt(t, ROUND, 103, HEADER, out) };
    expect(a2).toEqual(a1);
  });

  describe('speed over a window', () => {
    // 12 samples at 32 Hz (tick_step 2 at 64 tick): two extra samples on each side.
    const LONG: RoundInfo = { ...ROUND, samples: 12, end_tick: 122 };
    const long = (c: TrackCols) => track(c, LONG.samples);
    const atLong = (t: PlayerTrack, tick: number) =>
      playerStateAt(t, LONG, tick, HEADER, newPlayerState());
    const tickOf = (k: number) => LONG.start_tick + k * HEADER.tick_step;

    it('takes two samples each side at 32 Hz', () => {
      expect(speedHalfWindow(32)).toBe(2);
      expect(speedHalfWindow(16)).toBe(1);
      expect(speedHalfWindow(64)).toBe(4);
      expect(speedHalfWindow(4)).toBe(0);
    });

    it('reads a one-unit wobble as standing still', () => {
      const t = long({ x: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1] });
      for (let k = 0; k < LONG.samples; k++)
        expect(atLong(t, tickOf(k) + 1).speed).toBeLessThan(SPEED_IDLE);
    });

    it('keeps a steady speed exact', () => {
      const t = long({ x: Array.from({ length: 12 }, (_, k) => 8 * k) });
      for (let k = 0; k < LONG.samples; k++)
        expect(atLong(t, tickOf(k) + 1).speed).toBe(8 * HEADER.sample_hz);
    });

    it('does not reach across a death or a spawn', () => {
      const flags = [0, 0, A, A, A, A, A, A, A, A, 0, 0];
      const x = [5000, 5000, 0, 8, 16, 24, 32, 40, 48, 56, -5000, -5000];
      const t = long({ x, flags });
      for (let k = 2; k < 9; k++)
        expect(atLong(t, tickOf(k) + 1).speed).toBe(8 * HEADER.sample_hz);
    });

    it('moves between the intervals instead of stepping at a sample', () => {
      const x = [0, 8, 16, 24, 32, 40, 44, 48, 52, 56, 60, 64];
      const t = long({ x });
      for (let k = 1; k < LONG.samples - 1; k++) {
        const before = atLong(t, tickOf(k) - 1e-6).speed;
        const after = atLong(t, tickOf(k) + 1e-6).speed;
        expect(Math.abs(after - before)).toBeLessThan(1e-3);
      }
      // Mid-interval it is still the interval's window speed.
      expect(atLong(t, tickOf(1) + 1).speed).toBe(8 * HEADER.sample_hz);
    });
  });

  // Motion between samples, as seen frame by frame: velocities are measured over a hundredth
  // of a tick either side of a sample.
  describe('smooth motion', () => {
    const N = 16;
    const R: RoundInfo = { ...ROUND, samples: N, end_tick: 100 + 2 * (N - 1) };
    const mk = (c: TrackCols) => track(c, N);
    const atR = (t: PlayerTrack, tick: number) =>
      playerStateAt(t, R, tick, HEADER, newPlayerState());
    const tickOf = (k: number) => R.start_tick + k * HEADER.tick_step;
    const EPS = 0.01;
    /** Units (or degrees) per tick just before and just after `tick`. */
    const rates = (
      t: PlayerTrack,
      tick: number,
      get: (s: ReturnType<typeof atR>) => number
    ) => [
      (get(atR(t, tick)) - get(atR(t, tick - EPS))) / EPS,
      (get(atR(t, tick + EPS)) - get(atR(t, tick))) / EPS,
    ];

    // A run speeding up and turning, rounded to whole units as the pack stores it.
    const x = Array.from({ length: N }, (_, k) =>
      Math.round(0.4 * k * k + 3 * k)
    );
    const y = Array.from({ length: N }, (_, k) =>
      Math.round(20 * Math.sin(k / 3))
    );

    it('has no velocity kink at a sample', () => {
      const t = mk({ x, y });
      for (let k = 2; k < N - 2; k++) {
        const [vx0, vx1] = rates(t, tickOf(k), (s) => s.x);
        const [vy0, vy1] = rates(t, tickOf(k), (s) => s.y);
        // Linear interpolation changes velocity here by the whole second difference.
        expect(Math.abs(vx1 - vx0)).toBeLessThan(0.05);
        expect(Math.abs(vy1 - vy0)).toBeLessThan(0.05);
      }
    });

    it('keeps a steady run on its straight line, exactly', () => {
      const t = mk({ x: Array.from({ length: N }, (_, k) => 8 * k) });
      for (let tick = tickOf(0); tick <= tickOf(N - 1); tick += 0.25)
        expect(atR(t, tick).x).toBeCloseTo(4 * (tick - R.start_tick), 9);
    });

    it('smooths the whole-unit rounding of a steady run', () => {
      // 7.3 units a sample is 233.6 u/s; rounding makes the steps 7 and 8 (224 and 256 u/s).
      const t = mk({
        x: Array.from({ length: N }, (_, k) => Math.round(7.3 * k)),
      });
      let lo = Infinity;
      let hi = -Infinity;
      for (let tick = tickOf(2); tick < tickOf(N - 3); tick += 0.25) {
        const v = ((atR(t, tick + 0.25).x - atR(t, tick).x) / 0.25) * 32;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      expect(hi - lo).toBeLessThan(0.5 * 32);
    });

    it('stays within the samples when stopping dead (no overshoot)', () => {
      const t = mk({
        x: [0, 8, 16, 24, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32, 32],
      });
      let last = -Infinity;
      for (let tick = tickOf(0); tick <= tickOf(N - 1); tick += 0.125) {
        const v = atR(t, tick).x;
        expect(v).toBeLessThanOrEqual(32);
        expect(v).toBeGreaterThanOrEqual(last - 1e-9);
        last = v;
      }
    });

    it('does not smooth across a teleport', () => {
      const t = mk({
        x: [
          0, 8, 16, 24, 3000, 3008, 3016, 3024, 3032, 3040, 3048, 3056, 3064,
          3072, 3080, 3088,
        ],
      });
      for (let tick = tickOf(0); tick <= tickOf(3); tick += 0.25)
        expect(atR(t, tick).x).toBeCloseTo(4 * (tick - R.start_tick), 9);
      for (let tick = tickOf(4); tick <= tickOf(N - 1); tick += 0.25)
        expect(atR(t, tick).x).toBeCloseTo(3000 + 4 * (tick - tickOf(4)), 9);
    });

    it('reaches the last live sample before a death, so the body does not jump', () => {
      const flags = Array.from({ length: N }, (_, k) => (k <= 8 ? A : 0));
      const t = mk({ x, y, flags });
      const end = atR(t, tickOf(8) - EPS);
      const held = atR(t, tickOf(8) + 1);
      expect(held.x).toBe(x[8]);
      expect(Math.abs(end.x - held.x)).toBeLessThan(0.2);
      expect(Math.abs(end.y - held.y)).toBeLessThan(0.2);
    });

    it('turns with no rate kink at a sample, through every sample', () => {
      const yaw = [
        0, 2, 6, 12, 20, 30, 42, 56, 72, 90, 110, 132, 156, 178, -158, -132,
      ];
      const t = mk({ yaw, pitch: yaw.map((_, k) => 0.2 * k * k - 20) });
      for (let k = 2; k < N - 2; k++) {
        expect(atR(t, tickOf(k)).yaw).toBeCloseTo(yaw[k], 9);
        const [w0, w1] = rates(t, tickOf(k), (s) => s.yaw);
        expect(Math.abs(w1 - w0)).toBeLessThan(0.05);
        const [p0, p1] = rates(t, tickOf(k), (s) => s.pitch);
        expect(Math.abs(p1 - p0)).toBeLessThan(0.05);
      }
    });

    it('does not overshoot a flick that stops dead', () => {
      const t = mk({
        yaw: [0, 0, 0, 40, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80, 80],
      });
      for (let tick = tickOf(0); tick <= tickOf(N - 1); tick += 0.125) {
        const a = atR(t, tick).yaw;
        expect(a).toBeGreaterThanOrEqual(-1e-9);
        expect(a).toBeLessThanOrEqual(80 + 1e-9);
      }
      expect(atR(t, tickOf(4) + 1).yaw).toBeCloseTo(80, 9);
    });

    it('lowers the eye through a crouch without a step at each sample', () => {
      const duck = [
        0, 0, 0, 40, 80, 120, 160, 200, 240, 255, 255, 255, 255, 255, 255, 255,
      ];
      const t = mk({ duck });
      for (let k = 3; k < 9; k++) {
        const [d0, d1] = rates(t, tickOf(k) - 1, (s) => s.duck);
        expect(d0).toBeGreaterThan(0);
        expect(Math.abs(d1 - d0)).toBeLessThan(1e-6);
      }
    });
  });
});
