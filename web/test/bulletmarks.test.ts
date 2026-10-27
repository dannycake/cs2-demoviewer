// Bullet marks: a miss marks the wall its tracer ends at (a puff in the surface's dust, a hole,
// sparks off metal, chips off glass), a wallbang each face it went through, a hit the wall
// behind the victim with blood; the newest of each kept to its pool, every ray cast once per
// round, nothing made while scrubbing, lit by the grid on a baked map.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { EffectsManifest } from '../src/api/assets';
import { UNIT } from '../src/geo/coords';
import type { PackEvent } from '../src/pack/types';
import {
  BLOOD_DECAL_GAIN,
  BLOOD_SEQUENCE,
  BulletMarks,
  CHIPS,
  DECAL_LIFT,
  DECAL_SEQUENCE,
  DUST_COLOR,
  DUST_FRAME_GAIN,
  HOLE_CORE,
  LIGHT_LIFT,
  MARKS,
  SPARKS,
  type MarkOptions,
} from '../src/scene/bulletmarks';
import { lightAt, litCache, wallLight } from '../src/scene/gridlight';
import type { Hull } from '../src/scene/hull';
import type { SmokeSphere } from '../src/scene/smokecover';
import { SMOKE } from '../src/scene/utility';
import { EFFECTS_LAYER } from '../src/scene/post';
import { Timeline } from '../src/sim/timeline';
import { countCalls } from './helpers/count-calls';
import { lightGrid } from './helpers/light-grid';
import { noAtlases, stubAtlases } from './helpers/stub-atlases';
import { event, trackPack, withSecondRound } from './helpers/track-pack';
import { fenceMetalWood, wall, wallsHull } from './helpers/walls';

// The grid sampler, spied through: each mark's light is sampled once, when the round is found.
vi.mock('../src/scene/probes', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/scene/probes')>();
  return { ...m, sampleLightGrid: vi.fn(m.sampleLightGrid) };
});
import { sampleLightGrid } from '../src/scene/probes';

const R = 64;
const T = 1000;
/** Metres → Source units. */
const units = (m: number) => m / UNIT;

/** The atlases the marks draw from, as the effects manifest lists them (CS2 build 2000935). */
const ATLASES: EffectsManifest = {
  atlases: {
    decals: {
      file: 'decals.webp',
      width: 1024,
      height: 128,
      cell: [64, 64],
      cols: 16,
      frames: 19,
      sequences: [
        [0, 4],
        [4, 3],
        [7, 3],
        [10, 3],
        [13, 6],
      ],
    },
    dust: {
      file: 'dust.webp',
      width: 1024,
      height: 176,
      cell: [64, 88],
      cols: 16,
      frames: 32,
      sequences: [[0, 32]],
    },
    sparks: {
      file: 'sparks.webp',
      width: 1024,
      height: 64,
      cell: [32, 64],
      cols: 32,
      frames: 10,
      sequences: [
        [0, 9],
        [9, 1],
      ],
    },
    debris: {
      file: 'debris.webp',
      width: 1024,
      height: 32,
      cell: [32, 32],
      cols: 32,
      frames: 16,
      sequences: [[0, 16]],
    },
  },
};
const FILES = ['decals.webp', 'dust.webp', 'sparks.webp', 'debris.webp'];

/** Marks whose four atlases are in. */
async function loaded() {
  const s = stubAtlases(ATLASES);
  for (const k of ['decals', 'dust', 'sparks', 'debris'] as const)
    s.atlases.get(k);
  for (const f of FILES) await s.release(f);
  return { marks: new BulletMarks(s.atlases), s };
}

interface Fire {
  /** Source degrees. */
  yaw?: number;
  pitch?: number;
  /** The eye, Source units; the origin by default. */
  from?: [number, number, number];
  /** A hit: the bullet's direction (Source) and the metres it flew to the victim. */
  hit?: {
    dir?: [number, number, number];
    metres: number;
    penetrations?: number;
  };
  player?: number;
}

/** A shot of player 0's (or `player`'s) at `tick`: its weapon_fire, fire_bullets and hit. */
function fire(tick: number, f: Fire = {}): PackEvent[] {
  const [x, y, z] = f.from ?? [0, 0, 0];
  const user_idx = f.player ?? 0;
  const out = [
    event('weapon_fire', tick, { user_idx, weapon: 'weapon_ak47' }),
    event('fire_bullets', tick, {
      user_idx,
      angles_x: f.pitch ?? 0,
      angles_y: f.yaw ?? 0,
      origin_x: x,
      origin_y: y,
      origin_z: z,
    }),
  ];
  if (f.hit) {
    const [dx, dy, dz] = f.hit.dir ?? [1, 0, 0];
    out.push(
      event('bullet_damage', tick, {
        attacker_idx: user_idx,
        victim_idx: 1,
        damage_dir_x: dx,
        damage_dir_y: dy,
        damage_dir_z: dz,
        distance: units(f.hit.metres),
        ...(f.hit.penetrations !== undefined
          ? { num_penetrations: f.hit.penetrations }
          : {}),
      })
    );
  }
  return out;
}

/** One round, 50 s long from tick 1000, with `events`. */
const timeline = (events: PackEvent[]) =>
  new Timeline(
    trackPack({
      samples: 1600,
      players: [() => ({}), () => ({ x: 400 })],
      events,
    })
  );

const opts = (o: Partial<MarkOptions> = {}): MarkOptions => ({
  exposure: 1,
  tickRate: R,
  ...o,
});

/** The tick `s` seconds after the shot at T. */
const after = (s: number) => T + s * R;

const batch = (m: BulletMarks, name: string) =>
  m.root.getObjectByName(name) as THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;

/** The sprites a batch draws now. */
function instances(m: BulletMarks, name: string) {
  const b = batch(m, name);
  const g = b.geometry;
  const n = b.visible ? g.instanceCount : 0;
  const a = (k: string) => g.getAttribute(k) as THREE.BufferAttribute;
  return Array.from({ length: n }, (_, i) => ({
    at: new THREE.Vector3().fromBufferAttribute(a('aCentre'), i),
    normal: new THREE.Vector3().fromBufferAttribute(a('aNormal'), i),
    w: a('aSize').getX(i),
    h: a('aSize').getY(i),
    rotation: a('aSize').getZ(i),
    frame: a('aSize').getW(i),
    color: new THREE.Color(
      a('aColor').getX(i),
      a('aColor').getY(i),
      a('aColor').getZ(i)
    ),
    alpha: a('aColor').getW(i),
  }));
}

const inSequence = (frame: number, seq: [number, number]) =>
  frame >= seq[0] && frame < seq[0] + seq[1];
const sequence = (i: number) =>
  ATLASES.atlases!.decals!.sequences[i] as [number, number];

function near(a: THREE.Color, b: THREE.Color, digits = 5) {
  expect(a.r).toBeCloseTo(b.r, digits);
  expect(a.g).toBeCloseTo(b.g, digits);
  expect(a.b).toBeCloseTo(b.b, digits);
}

/** The arrays every batch draws from, to hold them to `===` across frames. */
const arraysOf = (m: BulletMarks) =>
  m.root.children.flatMap((c) =>
    Object.values((c as THREE.Mesh).geometry.attributes).map((a) => a.array)
  );

describe('BulletMarks', () => {
  it('marks a miss where its tracer ends: a hole 1 cm off the metal, a puff in its dust and sparks; the hole fades out by 12 s', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // Straight ahead (scene +z): through the chainlink to the metal at 5 m.
    const tl = timeline(fire(T));
    marks.set(0, after(0.1), tl, hull, opts());
    const holes = instances(marks, 'bullet-holes');
    expect(holes).toHaveLength(1);
    expect(holes[0].at.z).toBeCloseTo(5 - DECAL_LIFT, 5);
    expect(holes[0].at.x).toBeCloseTo(0, 5);
    expect(holes[0].normal.z).toBeCloseTo(-1, 5);
    expect(holes[0].w).toBeCloseTo(MARKS.decalSize, 6);
    expect(inSequence(holes[0].frame, sequence(DECAL_SEQUENCE.metal))).toBe(
      true
    );
    expect(holes[0].alpha).toBe(1);
    const dust = instances(marks, 'impact-dust');
    expect(dust).toHaveLength(1);
    // Out from the wall, towards the shooter.
    expect(dust[0].at.z).toBeLessThan(5);
    near(
      dust[0].color,
      new THREE.Color(DUST_COLOR.metal).multiplyScalar(DUST_FRAME_GAIN)
    );
    expect(instances(marks, 'impact-sparks')).toHaveLength(SPARKS.count);
    expect(instances(marks, 'impact-chips')).toHaveLength(0);
    // The sparks are out by 0.15 s, the puff by 0.5 s; the hole stays.
    marks.set(0, after(0.2), tl, hull, opts());
    expect(instances(marks, 'impact-sparks')).toHaveLength(0);
    expect(instances(marks, 'impact-dust')).toHaveLength(1);
    marks.set(0, after(0.6), tl, hull, opts());
    expect(instances(marks, 'impact-dust')).toHaveLength(0);
    expect(instances(marks, 'bullet-holes')).toHaveLength(1);
    // Fading over the last 2 s of its 12.
    marks.set(0, after(11), tl, hull, opts());
    expect(instances(marks, 'bullet-holes')[0].alpha).toBeCloseTo(0.5, 6);
    marks.set(0, after(13), tl, hull, opts());
    expect(instances(marks, 'bullet-holes')).toHaveLength(0);
    expect(batch(marks, 'bullet-holes').visible).toBe(false);
    // Nothing before the shot.
    marks.set(0, T - 1, tl, hull, opts());
    expect(instances(marks, 'bullet-holes')).toHaveLength(0);
    expect(instances(marks, 'impact-dust')).toHaveLength(0);
  });

  it('marks each face a wallbang went through, on the side the bullet met it, and no face of a hit that went through none', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // To a victim 10 m ahead through the metal (entered) and the wood (left by).
    const tl = timeline([
      ...fire(T, { hit: { metres: 10, penetrations: 1 } }),
      ...fire(T + 2000, { hit: { metres: 10 } }),
    ]);
    marks.set(0, after(0.1), tl, hull, opts());
    const holes = instances(marks, 'bullet-holes');
    expect(holes).toHaveLength(2);
    const wood = holes.find((h) =>
      inSequence(h.frame, sequence(DECAL_SEQUENCE.wood))
    )!;
    expect(wood).toBeTruthy();
    expect(wood.at.z).toBeCloseTo(8 + DECAL_LIFT, 5);
    expect(wood.normal.z).toBeCloseTo(1, 5);
    const metal = holes.find((h) =>
      inSequence(h.frame, sequence(DECAL_SEQUENCE.metal))
    )!;
    expect(metal.at.z).toBeCloseTo(5 - DECAL_LIFT, 5);
    expect(instances(marks, 'impact-dust')).toHaveLength(2);
    // Logged without penetrations: no mark on the walls it would cross.
    marks.set(0, T + 2000 + 6, tl, hull, opts());
    expect(instances(marks, 'bullet-holes')).toHaveLength(0);
  });

  it('puts blood on a wall 1 m behind the victim, none 2 m behind, for 30 s', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    const tl = timeline([
      // The victim 4 m ahead, the metal 1 m behind them.
      ...fire(T, { hit: { metres: 4 } }),
      // 3 m ahead: the metal is 2 m behind.
      ...fire(T + 3000, { hit: { metres: 3 } }),
    ]);
    marks.set(0, after(0.1), tl, hull, opts());
    const blood = instances(marks, 'blood-decals');
    expect(blood).toHaveLength(1);
    expect(blood[0].at.z).toBeCloseTo(5 - DECAL_LIFT, 5);
    expect(blood[0].normal.z).toBeCloseTo(-1, 5);
    expect(blood[0].w).toBeCloseTo(MARKS.bloodSize, 6);
    expect(inSequence(blood[0].frame, sequence(BLOOD_SEQUENCE))).toBe(true);
    // CS2's near-black red, brought up.
    near(
      blood[0].color,
      new THREE.Color(1, 1, 1).multiplyScalar(BLOOD_DECAL_GAIN)
    );
    // A hit marks no hole of its own.
    expect(instances(marks, 'bullet-holes')).toHaveLength(0);
    marks.set(0, after(29), tl, hull, opts());
    expect(instances(marks, 'blood-decals')).toHaveLength(1);
    marks.set(0, after(30), tl, hull, opts());
    expect(instances(marks, 'blood-decals')).toHaveLength(0);
    marks.set(0, T + 3000 + 6, tl, hull, opts());
    expect(instances(marks, 'blood-decals')).toHaveLength(0);
  });

  it('puts a puff in stone dust and no hole or blood on a wall CS2 never marks', async () => {
    const { marks } = await loaded();
    const hull = wallsHull(wall('physics_group_no_decal', 5));
    const tl = timeline([...fire(T), ...fire(T + 100, { hit: { metres: 4 } })]);
    marks.set(0, after(0.1), tl, hull, opts());
    expect(instances(marks, 'bullet-holes')).toHaveLength(0);
    const dust = instances(marks, 'impact-dust');
    expect(dust).toHaveLength(1);
    near(
      dust[0].color,
      new THREE.Color(DUST_COLOR.stone).multiplyScalar(DUST_FRAME_GAIN)
    );
    expect(DUST_COLOR.nodecal).toBe(DUST_COLOR.stone);
    marks.set(0, T + 106, tl, hull, opts());
    expect(instances(marks, 'blood-decals')).toHaveLength(0);
  });

  it('throws chips off glass, no sparks, and marks it with a glass hole', async () => {
    const { marks } = await loaded();
    const hull = wallsHull(wall('physics_group_glass', 5));
    const tl = timeline(fire(T));
    marks.set(0, after(0.1), tl, hull, opts());
    const chips = instances(marks, 'impact-chips');
    expect(chips).toHaveLength(CHIPS.count);
    // CS2's glass shards (the debris atlas's first frames), flying out towards the shooter.
    for (const c of chips) {
      expect(c.frame).toBeLessThan(3);
      expect(c.at.z).toBeLessThan(5);
    }
    expect(instances(marks, 'impact-sparks')).toHaveLength(0);
    expect(
      inSequence(
        instances(marks, 'bullet-holes')[0].frame,
        sequence(DECAL_SEQUENCE.glass)
      )
    ).toBe(true);
    near(
      instances(marks, 'impact-dust')[0].color,
      new THREE.Color(DUST_COLOR.glass).multiplyScalar(DUST_FRAME_GAIN)
    );
  });

  it('fades the dust, sparks and chips behind a smoke by the smoke between them and the eye, none in front of it or beside it; the holes lie under it', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    const tl = timeline(fire(T));
    // The eye 3 m behind the shooter; the miss marks the metal 5 m ahead of them.
    const eye = new THREE.Vector3(0, 0, -3);
    const at = (smokes: SmokeSphere[]) => {
      marks.set(0, after(0.05), tl, hull, opts({ eye, smokes }));
      return {
        dust: instances(marks, 'impact-dust'),
        sparks: instances(marks, 'impact-sparks'),
        holes: instances(marks, 'bullet-holes'),
      };
    };
    const smoke = (x: number, z: number): SmokeSphere => ({
      centre: new THREE.Vector3(x, 0, z),
      radius: 1.2,
      opacity: SMOKE.opacity,
    });
    const clear = at([]);
    expect(clear.dust).toHaveLength(1);
    expect(clear.sparks).toHaveLength(SPARKS.count);
    const behind = at([smoke(0, 1.5)]);
    expect(behind.dust[0].alpha).toBeCloseTo(
      clear.dust[0].alpha * (1 - SMOKE.opacity),
      6
    );
    behind.sparks.forEach((p, i) =>
      expect(p.alpha).toBeCloseTo(
        clear.sparks[i].alpha * (1 - SMOKE.opacity),
        6
      )
    );
    // The holes are drawn before the smoke, which covers them as it covers the wall.
    expect(behind.holes).toEqual(clear.holes);
    // A smoke past the wall, and one off to the side.
    for (const smokes of [[smoke(0, 8)], [smoke(4, 1.5)]])
      expect(at(smokes)).toEqual(clear);
    // Glass's chips the same.
    const glass = wallsHull(wall('physics_group_glass', 5));
    marks.set(0, after(0.1), tl, glass, opts({ eye }));
    const chips = instances(marks, 'impact-chips');
    expect(chips).toHaveLength(CHIPS.count);
    marks.set(0, after(0.1), tl, glass, opts({ eye, smokes: [smoke(0, 1.5)] }));
    instances(marks, 'impact-chips').forEach((c, i) =>
      expect(c.alpha).toBeCloseTo(chips[i].alpha * (1 - SMOKE.opacity), 6)
    );
  });

  it("turns each of a tick's shots (a shotgun's pellets) its own way: the shot's place in its tick is in its seed", async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // Player 1 fires at the same tick, between player 0's shots.
    const tl = timeline([
      ...fire(T, { yaw: -3 }),
      ...fire(T, { yaw: 2, from: [0, -100, 0], player: 1 }),
      ...fire(T, { yaw: 3 }),
      ...fire(T, { yaw: 0, pitch: 3 }),
    ]);
    marks.set(0, T + 1, tl, hull, opts());
    const holes = instances(marks, 'bullet-holes');
    expect(holes).toHaveLength(4);
    const turns = new Set(holes.map((h) => h.rotation.toFixed(4)));
    expect(turns.size).toBe(4);
  });

  it('keeps the newest 96 holes of 200 misses in a round, and the newest of each pool', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // One a tick, swept across the metal: shot i lands at x = 5·tan(yaw).
    const yaw = (i: number) => (i - 100) * 0.2;
    const tl = timeline(
      Array.from({ length: 200 }, (_, i) => fire(T + i, { yaw: yaw(i) })).flat()
    );
    const now = T + 199.5;
    marks.set(0, now, tl, hull, opts());
    const holes = instances(marks, 'bullet-holes');
    expect(holes).toHaveLength(MARKS.pools.decals);
    const xs = holes.map((h) => h.at.x).sort((a, b) => a - b);
    // Yaw turns from Source +x towards +y, scene +z towards +x.
    const newest = Array.from({ length: 96 }, (_, k) => 104 + k)
      .map((i) => 5 * Math.tan((yaw(i) * Math.PI) / 180))
      .sort((a, b) => a - b);
    xs.forEach((x, k) => expect(x).toBeCloseTo(newest[k], 4));
    expect(instances(marks, 'impact-dust')).toHaveLength(MARKS.pools.puffs);
    // 10 impacts in the last 0.15 s, 6 sparks each: the pool's 48.
    expect(instances(marks, 'impact-sparks')).toHaveLength(MARKS.pools.sparks);
  });

  it("casts the round's rays once: 50 more frames of it cast none, sample no light, make nothing and keep every batch's arrays", async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    const tl = timeline([
      ...Array.from({ length: 40 }, (_, i) =>
        fire(T + i * 20, { yaw: (i % 7) - 3 })
      ).flat(),
      ...fire(T + 900, { hit: { metres: 10, penetrations: 1 } }),
      ...fire(T + 950, { hit: { metres: 4 } }),
    ]);
    const raycast = vi.spyOn(hull, 'raycast');
    const raycastAll = vi.spyOn(hull, 'raycastAll');
    const grid = lightGrid();
    const sun = new THREE.Color(0.5, 0.5, 0.5);
    marks.set(0, T + 10, tl, hull, opts({ grid, sunLight: sun }));
    expect(raycast).toHaveBeenCalled();
    expect(raycastAll).toHaveBeenCalledTimes(1);
    raycast.mockClear();
    raycastAll.mockClear();
    vi.mocked(sampleLightGrid).mockClear();
    const arrays = arraysOf(marks);
    const ticks = Array.from({ length: 50 }, (_, k) => T + ((k * 37) % 1100));
    const o = opts({ grid, sunLight: sun });
    const counts = countCalls(() => {
      for (let k = 0; k < ticks.length; k++)
        marks.set(0, ticks[k], tl, hull, o);
    });
    expect(raycast).not.toHaveBeenCalled();
    expect(raycastAll).not.toHaveBeenCalled();
    expect(sampleLightGrid).not.toHaveBeenCalled();
    expect(counts).toEqual({ iterator: 0, forEach: 0, map: 0, range: 0 });
    const again = arraysOf(marks);
    expect(again).toHaveLength(arrays.length);
    again.forEach((a, i) => expect(a).toBe(arrays[i]));
    // Another round, or another hull, finds its marks again.
    const other = fenceMetalWood();
    const otherCast = vi.spyOn(other, 'raycast');
    marks.set(0, T + 10, tl, other, opts());
    expect(otherCast).toHaveBeenCalled();
  });

  it('draws the very frame playing drew when seeked back to', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    const tl = timeline([
      ...Array.from({ length: 30 }, (_, i) =>
        fire(T + i * 3, { yaw: i - 15, pitch: (i % 5) - 2 })
      ).flat(),
      ...fire(T + 40, { hit: { metres: 4.5 } }),
    ]);
    const snap = () =>
      [
        'bullet-holes',
        'blood-decals',
        'impact-dust',
        'impact-sparks',
        'impact-chips',
      ].map((n) => instances(marks, n));
    for (let t = T; t <= T + 100; t += 0.5) marks.set(0, t, tl, hull, opts());
    const played = snap();
    marks.set(0, T + 5, tl, hull, opts());
    marks.set(0, T + 2000, tl, hull, opts());
    marks.set(0, T + 100, tl, hull, opts());
    expect(snap()).toEqual(played);
    expect(played[0].length).toBe(30);
    expect(played[1].length).toBe(1);
  });

  it("draws only a round's own marks: seeking into the next round's start drops them, and seeking back draws them again", async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // A miss and a hit in round 0 3 s before it ends; round 1 starts the tick after.
    const one = trackPack({
      samples: 1600,
      players: [() => ({}), () => ({ x: 400 })],
      events: [
        ...fire(T + 3000, { yaw: 5 }),
        ...fire(T + 3010, { hit: { metres: 4.5 } }),
      ],
    });
    const tl = new Timeline(withSecondRound(one, 1));
    const [, next] = tl.pack.header.rounds;
    const snap = () => ({
      holes: instances(marks, 'bullet-holes'),
      blood: instances(marks, 'blood-decals'),
    });
    marks.set(0, T + 3100, tl, hull, opts());
    const before = snap();
    expect(before.holes).toHaveLength(1);
    expect(before.blood).toHaveLength(1);
    // Round 1 opens with none of them, though within 10 s of the shots by tick.
    marks.set(1, next.start_tick, tl, hull, opts());
    expect(snap()).toEqual({ holes: [], blood: [] });
    expect(marks.debug().marks).toBe(0);
    // Into round 0 again: the very marks it drew.
    marks.set(0, T + 3100, tl, hull, opts());
    expect(snap()).toEqual(before);
  });

  it("lights each mark once by the grid on a baked map: a hole and blood by their wall's normal, the sun only where it faces it; a puff by the air in front; again when the grid or the sun changes; plain colours without one", async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    // 1.25 m up, half way into the grid's bright cell; the blood 1 m to the side of the hole.
    const up = units(1.25);
    const tl = timeline([
      ...fire(T, { from: [0, 0, up] }),
      ...fire(T + 2, { from: [0, units(1), up], hit: { metres: 4 } }),
    ]);
    const grid = lightGrid();
    const sun = new THREE.Color(0.4, 0.35, 0.3);
    // The sun is up in front of the metal, which faces it (normal −z).
    const toSun = new THREE.Vector3(0, 0.6, -0.8);
    const at = new THREE.Vector3(0, 1.25, 5 - LIGHT_LIFT);
    const facing = new THREE.Vector3(0, 0, -1);
    const wall = wallLight(grid, at, facing, sun, toSun, new THREE.Color());
    const c = litCache();
    lightAt(c, at, 1, 1, grid, sun);
    const air = c.lit!.clone();
    // Lit, and the sun in it: the test means something.
    expect(wall.r).toBeGreaterThan(0.1);
    expect(wall.r).not.toBeCloseTo(air.r, 3);
    vi.mocked(sampleLightGrid).mockClear();
    const o = opts({ grid, sunLight: sun, toSun });
    marks.set(0, T + 6, tl, hull, o);
    // The miss's wall and air, the blood's wall: three samples.
    expect(sampleLightGrid).toHaveBeenCalledTimes(3);
    near(instances(marks, 'bullet-holes')[0].color, wall);
    near(
      instances(marks, 'impact-dust')[0].color,
      new THREE.Color(DUST_COLOR.metal)
        .multiplyScalar(DUST_FRAME_GAIN)
        .multiply(air)
    );
    // The grid is the same across x.
    near(
      instances(marks, 'blood-decals')[0].color,
      wall.clone().multiplyScalar(BLOOD_DECAL_GAIN)
    );
    // The sparks are a light, not lit.
    const spark = instances(marks, 'impact-sparks')[0].color;
    near(spark, new THREE.Color(SPARKS.color).multiplyScalar(SPARKS.gain));
    // Frames on: nothing sampled.
    for (let t = T + 7; t < T + 30; t++) marks.set(0, t, tl, hull, o);
    expect(sampleLightGrid).toHaveBeenCalledTimes(3);
    // Another grid, the sun's light or its direction changed: sampled again.
    marks.set(0, T + 6, tl, hull, { ...o, grid: lightGrid() });
    expect(sampleLightGrid).toHaveBeenCalledTimes(6);
    marks.set(0, T + 6, tl, hull, {
      ...o,
      sunLight: sun.clone().multiplyScalar(2),
    });
    expect(sampleLightGrid).toHaveBeenCalledTimes(9);
    // From behind the metal, the sun lights none of the hole.
    marks.set(0, T + 6, tl, hull, {
      ...o,
      toSun: new THREE.Vector3(0, 0.6, 0.8),
    });
    expect(sampleLightGrid).toHaveBeenCalledTimes(12);
    near(
      instances(marks, 'bullet-holes')[0].color,
      wallLight(grid, at, facing, null, null, new THREE.Color())
    );
    // Without a grid: the planned colours.
    marks.set(0, T + 6, tl, hull, opts());
    near(instances(marks, 'bullet-holes')[0].color, new THREE.Color(1, 1, 1));
    near(
      instances(marks, 'impact-dust')[0].color,
      new THREE.Color(DUST_COLOR.metal).multiplyScalar(DUST_FRAME_GAIN)
    );
  });

  it('puts the sparks on the effects layer beside the default one, for the bloom; not the holes, blood, dust or chips', async () => {
    const { marks } = await loaded();
    const effect = (name: string) => {
      const o = batch(marks, name);
      return o.layers.isEnabled(EFFECTS_LAYER) && o.layers.isEnabled(0);
    };
    expect(effect('impact-sparks')).toBe(true);
    const sparks = batch(marks, 'impact-sparks').material;
    expect(sparks.blending).toBe(THREE.CustomBlending);
    expect(sparks.blendDst).toBe(THREE.OneFactor);
    expect(sparks.defines.EMISSIVE).toBeDefined();
    for (const n of [
      'bullet-holes',
      'blood-decals',
      'impact-dust',
      'impact-chips',
    ]) {
      expect(effect(n), n).toBe(false);
      expect(batch(marks, n).layers.isEnabled(0), n).toBe(true);
      expect(batch(marks, n).material.defines.EMISSIVE, n).toBeUndefined();
    }
    // The decals lie on their walls, facing out of them; a hole has a dark core, blood none.
    expect(batch(marks, 'bullet-holes').material.defines.FACING).toBe(2);
    expect(batch(marks, 'blood-decals').material.defines.FACING).toBe(2);
    const holes = batch(marks, 'bullet-holes').material;
    expect(holes.defines.CORE).toBeDefined();
    expect((holes.uniforms.uCore.value as THREE.Vector2).toArray()).toEqual([
      HOLE_CORE.radius,
      HOLE_CORE.shade,
    ]);
    expect(batch(marks, 'blood-decals').material.defines.CORE).toBeUndefined();
  });

  it('throws the sparks off a face the bullet left by on along its way, out of the wall, and those off the face it entered by back out the way it came', async () => {
    const { marks } = await loaded();
    // A metal wall at 5 m facing away from the shooter: a bullet through it to a victim at
    // 10 m leaves it by that face; the same wall facing them, entered by it.
    for (const away of [true, false]) {
      const hull = wallsHull(wall('physics_group_metal', 5, away));
      const tl = timeline(fire(T, { hit: { metres: 10, penetrations: 1 } }));
      marks.set(0, after(0.05), tl, hull, opts());
      const sparks = instances(marks, 'impact-sparks');
      expect(sparks).toHaveLength(SPARKS.count);
      // Out of the wall on the side the bullet met it, and on the whole along (or against) the
      // bullet's way, not off along the wall.
      const side = away ? 1 : -1;
      const from = new THREE.Vector3(0, 0, 5 + side * DECAL_LIFT * 2);
      let along = 0;
      for (const p of sparks) {
        expect(side * (p.at.z - 5)).toBeGreaterThan(0);
        const flight = p.at.clone().sub(from);
        along += (side * flight.z) / flight.length();
      }
      expect(along / sparks.length).toBeGreaterThan(0.6);
    }
  });

  it('turns each spark to its flight on screen', async () => {
    const { marks } = await loaded();
    const hull = fenceMetalWood();
    const tl = timeline(fire(T));
    const screen = {
      right: new THREE.Vector3(-1, 0, 0),
      up: new THREE.Vector3(0, 1, 0),
    };
    marks.set(0, after(0.05), tl, hull, opts({ screen }));
    const a = instances(marks, 'impact-sparks');
    marks.set(0, after(0.05) + 0.1, tl, hull, opts({ screen }));
    const b = instances(marks, 'impact-sparks');
    a.forEach((s, j) => {
      const move = b[j].at.clone().sub(s.at);
      const x = move.dot(screen.right);
      const y = move.dot(screen.up);
      // The streak's long side, turned by its rotation: (−sin θ, cos θ) on screen.
      const along = -Math.sin(s.rotation) * x + Math.cos(s.rotation) * y;
      expect(along / Math.hypot(x, y)).toBeGreaterThan(0.98);
    });
  });

  it('asks for no atlas before a mark draws, and draws generated sprites without them', () => {
    const s = stubAtlases(ATLASES);
    const marks = new BulletMarks(s.atlases);
    const hull = fenceMetalWood();
    const tl = timeline([...fire(T), ...fire(T + 5, { hit: { metres: 4 } })]);
    marks.set(0, T - 10, tl, hull, opts());
    expect(s.fetches).toBe(0);
    const plain = new BulletMarks(noAtlases());
    plain.set(0, after(0.1), tl, hull, opts());
    expect(instances(plain, 'bullet-holes')).toHaveLength(1);
    expect(instances(plain, 'impact-dust')).toHaveLength(1);
    expect(instances(plain, 'impact-sparks')).toHaveLength(SPARKS.count);
    expect(instances(plain, 'blood-decals')).toHaveLength(1);
    // The generated textures: one cell, no frames.
    const map = batch(plain, 'bullet-holes').material.uniforms.uMap.value;
    expect(map).toBeInstanceOf(THREE.DataTexture);
  });

  it('lets go of a hull at once when it is forgotten (freed with its map) or the marks are disposed', () => {
    const marks = new BulletMarks(noAtlases());
    const hull = fenceMetalWood();
    const tl = timeline(fire(T));
    const held = () => (marks as unknown as { hull: Hull | null }).hull;
    marks.set(0, after(0.1), tl, hull, opts());
    expect(held()).toBe(hull);
    expect(marks.debug().marks).toBe(1);
    // Another hull's going changes nothing.
    marks.forget(fenceMetalWood());
    expect(held()).toBe(hull);
    marks.forget(hull);
    expect(held()).toBeNull();
    expect(marks.debug().marks).toBe(0);
    // A new hull finds the round's marks again.
    const next = fenceMetalWood();
    const cast = vi.spyOn(next, 'raycast');
    marks.set(0, after(0.1), tl, next, opts());
    expect(cast).toHaveBeenCalled();
    expect(instances(marks, 'bullet-holes')).toHaveLength(1);
    marks.dispose();
    expect(held()).toBeNull();
    expect(marks.debug().marks).toBe(0);
  });

  it('draws nothing without a hull or shots, and frees its batches', () => {
    const marks = new BulletMarks(noAtlases());
    const tl = timeline(fire(T));
    marks.set(0, after(0.1), tl, null as Hull | null, opts());
    expect(marks.root.children.every((c) => !c.visible)).toBe(true);
    marks.set(3, T, tl, fenceMetalWood(), opts());
    expect(marks.root.children.every((c) => !c.visible)).toBe(true);
    const parent = new THREE.Group();
    parent.add(marks.root);
    marks.dispose();
    expect(marks.root.parent).toBeNull();
  });
});
