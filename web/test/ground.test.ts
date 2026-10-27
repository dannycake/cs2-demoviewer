// GroundIndex: the weapons, grenades and kits lying in the world at (round, tick), from the
// pack's ground keys alone (GND1), so a seek shows what playing shows.

import { describe, expect, it } from 'vitest';
import type { GroundItem, Pack } from '../src/pack/types';
import { GroundIndex, type GroundPose } from '../src/sim/ground';
import { normaliseWeapon } from '../src/sim/weapons';
import { playbackPack } from './helpers/playback-pack';

const WEAPONS = ['none', 'AK-47', 'Flashbang', 'defuser', 'Glock-18'];

const key = (
  round: number,
  id: number,
  weapon: number,
  tick: number,
  at: [number, number, number],
  angles: [number, number, number] = [0, 0, 0],
  gone = false
): GroundItem => ({
  round,
  id,
  weapon,
  tick,
  x: at[0],
  y: at[1],
  z: at[2],
  pitch: angles[0] * 100,
  yaw: angles[1] * 100,
  roll: angles[2] * 100,
  gone,
});

/** Two rounds, round 0 from 60000 to 64000 and round 1 from 64100 to 68000. */
function pack(ground: GroundItem[]): Pack {
  const p = playbackPack({
    rounds: [
      { start: 60000, end: 64000 },
      { start: 64100, end: 68000 },
    ],
  });
  p.header.weapons = [...WEAPONS];
  p.ground = ground;
  return p;
}

// Item 255, an AK: falls from A to B, lies there, is picked up at 63000.
const A: [number, number, number] = [100, 200, 40];
const B: [number, number, number] = [120, 180, 0];
const AK = [
  key(0, 255, 1, 62142, A, [10, 170, 0]),
  key(0, 255, 1, 62152, B, [0, -170, 90]),
  key(0, 255, 1, 63000, B, [0, -170, 90], true),
];
// Item 7, a flashbang, in round 1 only.
const FLASH = [key(1, 7, 2, 64500, [5, 6, 7])];

const pose = (): GroundPose => ({
  id: -1,
  weapon: '',
  x: NaN,
  y: NaN,
  z: NaN,
  pitch: NaN,
  yaw: NaN,
  roll: NaN,
});

/** The items at (round, tick), copied out of a fresh array. */
function itemsAt(index: GroundIndex, round: number, tick: number) {
  const out: GroundPose[] = [];
  const n = index.at(round, tick, out);
  return out.slice(0, n).map((p) => ({ ...p }));
}

describe('GroundIndex.at', () => {
  const index = new GroundIndex(pack([...AK, ...FLASH]));

  it('interpolates between pose keys, holds the last, and drops an item at its gone key', () => {
    expect(itemsAt(index, 0, 62141)).toEqual([]);
    expect(itemsAt(index, 0, 62147)).toEqual([
      {
        id: 255,
        weapon: 'ak47',
        x: 110,
        y: 190,
        z: 20,
        pitch: 5,
        // 170° to -170° turns the short way, through 180°.
        yaw: 180,
        roll: 45,
      },
    ]);
    expect(itemsAt(index, 0, 62500)).toEqual([
      {
        id: 255,
        weapon: 'ak47',
        x: 120,
        y: 180,
        z: 0,
        pitch: 0,
        yaw: 190,
        roll: 90,
      },
    ]);
    expect(itemsAt(index, 0, 62999.5)).toHaveLength(1);
    expect(itemsAt(index, 0, 63000)).toEqual([]);
    expect(itemsAt(index, 0, 63999)).toEqual([]);
  });

  it('shows an item only in its own round', () => {
    expect(itemsAt(index, 0, 64500).map((p) => p.id)).toEqual([]);
    expect(itemsAt(index, 1, 64500)).toEqual([
      {
        id: 7,
        weapon: 'flashbang',
        x: 5,
        y: 6,
        z: 7,
        pitch: 0,
        yaw: 0,
        roll: 0,
      },
    ]);
    // Held to the end of the round, and gone with it.
    expect(itemsAt(index, 1, 68000)).toHaveLength(1);
    expect(itemsAt(index, 0, 62500).map((p) => p.id)).toEqual([255]);
    expect(itemsAt(index, 2, 64500)).toEqual([]);
    expect(itemsAt(index, -1, 64500)).toEqual([]);
  });

  it('shows a weapon dropped again under its id from its next pose key, and not between', () => {
    const again = new GroundIndex(
      pack([...AK, key(0, 255, 1, 63500, [300, 300, 0])])
    );
    expect(itemsAt(again, 0, 63200)).toEqual([]);
    expect(itemsAt(again, 0, 63500)).toMatchObject([
      { id: 255, x: 300, y: 300, z: 0 },
    ]);
    // Between the pickup and the drop it does not slide from B to its new spot.
    expect(itemsAt(again, 0, 62500)).toMatchObject([{ x: 120, y: 180 }]);
  });

  it('ends an item when its id comes back as another weapon without a gone key', () => {
    const swapped = new GroundIndex(
      pack([key(0, 40, 1, 61000, [0, 0, 0]), key(0, 40, 4, 61500, [50, 0, 0])])
    );
    expect(itemsAt(swapped, 0, 61200)).toMatchObject([
      { id: 40, weapon: 'ak47', x: 0 },
    ]);
    expect(itemsAt(swapped, 0, 61600)).toMatchObject([
      { id: 40, weapon: 'glock', x: 50 },
    ]);
  });

  it('lists the newest item first, and stops at the limit', () => {
    const many = new GroundIndex(
      pack([
        key(0, 3, 1, 61000, [3, 0, 0]),
        key(0, 5, 3, 60500, [5, 0, 0]),
        key(0, 9, 2, 61500, [9, 0, 0]),
      ])
    );
    expect(itemsAt(many, 0, 62000).map((p) => p.id)).toEqual([9, 3, 5]);
    expect(itemsAt(many, 0, 62000).map((p) => p.weapon)).toEqual([
      'flashbang',
      'ak47',
      'defuser',
    ]);
    const out: GroundPose[] = [];
    expect(many.at(0, 62000, out, 2)).toBe(2);
    expect(out.map((p) => p.id)).toEqual([9, 3]);
  });

  it('reuses the objects of `out`, fills it in place, and leaves what lies past the count', () => {
    const out = [pose(), pose(), pose()];
    const objects = [...out];
    for (let i = 0; i < 20; i++) {
      const n = index.at(0, 62142 + i * 50, out);
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(out).toHaveLength(3);
    out.forEach((p, i) => expect(p).toBe(objects[i]));
    expect(out[1].id).toBe(-1);
  });

  it('gives the same answer seeking backwards as playing forwards', () => {
    const forwards = [62100, 62147, 62500, 63000, 64500].map((t) =>
      itemsAt(index, 0, t)
    );
    const out: GroundPose[] = [];
    index.at(0, 63999, out);
    const backwards = [64500, 63000, 62500, 62147, 62100]
      .map((t) => {
        const n = index.at(0, t, out);
        return out.slice(0, n).map((p) => ({ ...p }));
      })
      .reverse();
    expect(backwards).toEqual(forwards);
  });

  it('has nothing on the ground for a pack without ground keys', () => {
    const empty = new GroundIndex(pack([]));
    expect(itemsAt(empty, 0, 62000)).toEqual([]);
    expect(empty.weaponsIn(0)).toEqual([]);
  });
});

describe('GroundIndex.weaponsIn', () => {
  it("is the round's items' models, normalised, sorted and once each", () => {
    const index = new GroundIndex(
      pack([
        ...AK,
        key(0, 256, 1, 62000, [0, 0, 0]),
        key(0, 257, 3, 62000, [0, 0, 0]),
        ...FLASH,
      ])
    );
    expect(index.weaponsIn(0)).toEqual(['ak47', 'defuser']);
    expect(index.weaponsIn(1)).toEqual(['flashbang']);
    expect(index.weaponsIn(2)).toEqual([]);
    expect(new GroundIndex(pack(AK)).weaponsIn(0)).toEqual(['ak47']);
  });

  it('names the kit as its model is named', () => {
    expect(normaliseWeapon('defuser')).toBe('defuser');
  });
});
