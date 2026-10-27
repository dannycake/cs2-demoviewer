import { describe, expect, it } from 'vitest';
import type { Grenade } from '../src/pack/types';
import { BOUNCE, grenadeBounces } from '../src/sim/bounces';
import { trackPack } from './helpers/track-pack';

// 64 ticks/s, 2 ticks per sample (32 Hz).
const header = trackPack({ players: [] }).header;
const HZ = 32;
const START = 1000;

/** A grenade whose sample k is `fn(k / HZ)`, sampled every tick step. */
function grenade(
  samples: number,
  fn: (t: number) => [number, number, number],
  detonate_tick: number | null = null
): Grenade {
  const g: Grenade = {
    entity_id: 7,
    kind: 'he',
    thrower: 0,
    start_tick: START,
    detonate_tick,
    expire_tick: null,
    samples,
    x: new Int16Array(samples),
    y: new Int16Array(samples),
    z: new Int16Array(samples),
  };
  for (let k = 0; k < samples; k++) {
    const [x, y, z] = fn(k / HZ);
    g.x[k] = Math.round(x);
    g.y[k] = Math.round(y);
    g.z[k] = Math.round(z);
  }
  return g;
}

/**
 * Dropped from 200 units moving at 300 u/s along x: it hits the floor (and stays on it, rolling
 * with 200 u/s² of friction), rolls into a wall at x = 300, comes back at 0.45 of its speed and
 * rolls to rest. Integrated at 640 Hz; positions in whole units, as the pack keeps them.
 */
function floorThenWall(): (t: number) => [number, number, number] {
  const dt = 1 / 640;
  const path: [number, number, number][] = [];
  let x = 0;
  let z = 200;
  let vx = 300;
  let vz = 0;
  for (let i = 0; i <= 640 * 4; i++) {
    path.push([x, 0, z]);
    if (z > 0) {
      vz -= 800 * dt;
      z += vz * dt;
      if (z <= 0) {
        z = 0;
        vz = 0;
      }
    } else if (vx !== 0) {
      const slow = 200 * dt * Math.sign(vx);
      vx = Math.abs(vx) <= Math.abs(slow) ? 0 : vx - slow;
    }
    x += vx * dt;
    if (x >= 300) {
      x = 300;
      vx = -0.45 * vx;
    }
  }
  return (t) => path[Math.min(path.length - 1, Math.round(t * 640))];
}

describe('grenadeBounces', () => {
  it('are a change of 150 u/s at over 50 u/s, 0.15 s apart', () => {
    expect(BOUNCE).toEqual({ dv: 150, minSpeed: 50, gapS: 0.15 });
  });

  it('a grenade bouncing off the floor and off a wall bounces twice; rolling to rest adds none', () => {
    const g = grenade(4 * HZ, floorThenWall());
    const b = grenadeBounces(g, header);
    expect(b).toHaveLength(2);
    // The floor: 0.707 s after the drop, where it lands (within a sample's fall, 18 units).
    expect(
      Math.abs(b[0].tick - (START + Math.sqrt(0.5) * 64))
    ).toBeLessThanOrEqual(3);
    expect(b[0].z).toBeLessThanOrEqual(18);
    expect(Math.abs(b[0].x - 212)).toBeLessThanOrEqual(10);
    // The wall.
    expect(Math.abs(b[1].x - 300)).toBeLessThanOrEqual(10);
    expect(b[1].tick).toBeGreaterThan(b[0].tick + BOUNCE.gapS * 64);
  });

  it('a straight flight has none', () => {
    expect(
      grenadeBounces(
        grenade(40, (t) => [500 * t, 0, 100]),
        header
      )
    ).toEqual([]);
  });

  it('none from the detonation sample on', () => {
    const path = floorThenWall();
    const all = grenadeBounces(grenade(4 * HZ, path), header);
    // Detonated between the two: only the floor's.
    const mid = Math.round((all[0].tick + all[1].tick) / 2);
    expect(grenadeBounces(grenade(4 * HZ, path, mid), header)).toEqual([
      all[0],
    ]);
    // Detonated on the floor's sample: none.
    expect(grenadeBounces(grenade(4 * HZ, path, all[0].tick), header)).toEqual(
      []
    );
  });

  it('a change under 50 u/s of speed is no bounce (a grenade at rest jittering)', () => {
    // At rest, then pushed to 100 u/s: the speed before the change is 0.
    const g = grenade(40, (t) => [t < 0.5 ? 0 : 160 * (t - 0.5), 0, 0]);
    expect(grenadeBounces(g, header)).toEqual([]);
  });
});
