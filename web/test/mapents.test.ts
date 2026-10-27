// MapEntityIndex: a door's or a breakable's pose at (round, tick), from the pack's change list
// alone (ENT1), so a seek shows what playing shows.

import { describe, expect, it } from 'vitest';
import type { MapEntityChange, Pack } from '../src/pack/types';
import { MapEntityIndex, type EntityPose } from '../src/sim/mapents';
import { playbackPack } from './helpers/playback-pack';

const key = (
  round: number,
  entity: number,
  tick: number,
  yaw: number,
  gone = false
): MapEntityChange => ({
  round,
  entity,
  tick,
  pitch: 0,
  yaw,
  roll: 0,
  gone,
});

/** Two rounds; entity 0 a door, 1 a door turning through ±180°, 2 a breakable. */
function pack(changes: MapEntityChange[]): Pack {
  const p = playbackPack({
    rounds: [
      { start: 0, end: 4000 },
      { start: 4100, end: 8000 },
    ],
  });
  p.entities = [
    { kind: 'door', x: 1047, y: -920, z: -768 },
    { kind: 'door', x: 257, y: -1310, z: -416 },
    { kind: 'breakable', x: 1415, y: -391, z: -341 },
  ];
  p.entityChanges = changes;
  return p;
}

const PACK = pack([
  key(0, 0, 1000, 0),
  key(0, 0, 1029, -9000),
  key(0, 1, 1000, 17000),
  key(0, 1, 1040, -17000),
  key(0, 2, 3000, 0, true),
]);

const pose = (): EntityPose => ({
  visible: false,
  spawn: false,
  pitch: NaN,
  yaw: NaN,
  roll: NaN,
});

describe('MapEntityIndex.poseAt', () => {
  const index = new MapEntityIndex(PACK);

  it('interpolates a swing between its keys and holds the last', () => {
    const p = index.poseAt(0, 0, 1014.5, pose());
    expect(p.spawn).toBe(false);
    expect(p.visible).toBe(true);
    expect(p.yaw).toBeCloseTo(-45, 9);
    expect(p.pitch).toBe(0);
    expect(p.roll).toBe(0);
    expect(index.poseAt(0, 0, 1029, pose()).yaw).toBeCloseTo(-90, 9);
    expect(index.poseAt(0, 0, 2000, pose()).yaw).toBeCloseTo(-90, 9);
  });

  it('is at spawn before its first key in a round, and in a round without keys', () => {
    const before = index.poseAt(0, 0, 999, pose());
    expect(before.spawn).toBe(true);
    expect(before.visible).toBe(true);
    const next = index.poseAt(0, 1, 500, pose());
    expect(next.spawn).toBe(true);
    expect(next.visible).toBe(true);
  });

  it('turns the shorter way through ±180°, not back through 0', () => {
    const mid = index.poseAt(1, 0, 1020, pose());
    expect(Math.abs(mid.yaw)).toBeCloseTo(180, 9);
    const quarter = index.poseAt(1, 0, 1010, pose());
    // 170° → 180°: a quarter of the way is 175°, not 85°.
    expect(((quarter.yaw % 360) + 360) % 360).toBeCloseTo(175, 9);
  });

  it('hides a breakable from its break to the end of the round', () => {
    expect(index.poseAt(2, 0, 2999, pose()).visible).toBe(true);
    const broken = index.poseAt(2, 0, 3000, pose());
    expect(broken.visible).toBe(false);
    expect(broken.spawn).toBe(false);
    expect(index.poseAt(2, 0, 3999, pose()).visible).toBe(false);
    const next = index.poseAt(2, 1, 4200, pose());
    expect(next.visible).toBe(true);
    expect(next.spawn).toBe(true);
  });

  it('gives the same pose at a tick reached forwards and backwards', () => {
    const ticks: number[] = [];
    for (let t = 900; t <= 3100; t += 7.25) ticks.push(t);
    const forwards = ticks.map((t) =>
      [0, 1, 2].map((e) => ({ ...index.poseAt(e, 0, t, pose()) }))
    );
    const out = pose();
    for (let i = ticks.length - 1; i >= 0; i--)
      for (let e = 0; e < 3; e++)
        expect(index.poseAt(e, 0, ticks[i], out)).toEqual(forwards[i][e]);
  });

  it('answers spawn for an entity or a round it does not know', () => {
    expect(index.poseAt(9, 0, 1000, pose()).spawn).toBe(true);
    expect(index.poseAt(0, 9, 1000, pose()).spawn).toBe(true);
  });

  it('is at spawn everywhere in a pack without ENT1', () => {
    const i = new MapEntityIndex(
      playbackPack({ rounds: [{ start: 0, end: 10 }] })
    );
    expect(i.poseAt(0, 0, 5, pose()).spawn).toBe(true);
  });
});

describe('MapEntityIndex.breaksAt', () => {
  const index = new MapEntityIndex(PACK);

  it('lists the entities broken within the window before a tick', () => {
    const out: number[] = [];
    expect(index.breaksAt(0, 2999, 38, out)).toBe(0);
    expect(index.breaksAt(0, 3000, 38, out)).toBe(1);
    expect(out[0]).toBe(2);
    expect(index.breaksAt(0, 3037, 38, out)).toBe(1);
    expect(index.breaksAt(0, 3038, 38, out)).toBe(0);
    expect(index.breaksAt(1, 3000, 38, out)).toBe(0);
    // The array is written in place, never shrunk: its storage is reused frame after frame.
    expect(out).toEqual([2]);
  });

  it('knows the tick of a break', () => {
    expect(index.breakTick(2, 0)).toBe(3000);
    expect(index.breakTick(2, 1)).toBeNull();
    expect(index.breakTick(0, 0)).toBeNull();
  });
});
