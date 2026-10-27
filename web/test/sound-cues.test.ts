import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLAG, GEAR, type Grenade, type PackEvent } from '../src/pack/types';
import { blinkOn } from '../src/sim/timeline';
import {
  bombBeepTicks,
  crossed,
  DECOY,
  DECOY_MAX_SHOTS,
  decoyShotTicks,
  loopsAt,
  RELOAD_PARTS,
  roundCues,
  type Cue,
} from '../src/sim/sounds';
import {
  event,
  grenadeTrack,
  trackPack,
  type SampleSpec,
} from './helpers/track-pack';
import { cpuTimed } from './helpers/cpu-time';
import { needs } from './helpers/gates';
import { MATCHES } from './helpers/match-packs';

// 64 ticks/s, 2 ticks per sample; the round starts at tick 1000 and holds 2000 samples.
const T = 1000;
const R = 64;
const DEFAULT = () => 'default';

/** p0 a T at the origin, p1 a CT at (100, 50, 0), standing; `players` replaces them. */
function pack(o: Partial<Parameters<typeof trackPack>[0]> = {}) {
  return trackPack({
    samples: 2000,
    weapons: ['none', 'ak47'],
    teams: [2, 3],
    players: [() => ({ x: 0, y: 0 }), () => ({ x: 100, y: 50 })],
    ...o,
  });
}

const withKey = (cues: Cue[], prefix: string) =>
  cues.filter((c) => c.key.startsWith(prefix));
const keysAt = (cues: Cue[], tick: number) =>
  cues.filter((c) => c.tick === tick).map((c) => c.key);
const P0 = { x: 0, y: 0, z: 0 };
const P1 = { x: 100, y: 50, z: 0 };

/** Runs along x at 250 u/s from sample `from` for a second, from `x0`. */
const runner =
  (x0: number, from = 0) =>
  (k: number): SampleSpec => ({
    x: x0 + (Math.min(Math.max(k - from, 0), 32) * 250) / 32,
    y: 0,
  });

describe('roundCues: shots and throws', () => {
  it('a silenced USP shot is shot:usp:silenced at the shooter; other guns by their name', () => {
    const fire = (
      tick: number,
      user: number,
      weapon: string,
      silenced = false
    ) => event('weapon_fire', tick, { user_idx: user, weapon, silenced });
    const cues = roundCues(
      pack({
        events: [
          fire(T + 100, 1, 'weapon_usp_silencer', true),
          fire(T + 110, 0, 'weapon_ak47'),
          fire(T + 120, 1, 'weapon_m4a1_silencer', true),
          fire(T + 130, 1, 'weapon_m4a1'),
          fire(T + 140, 0, 'weapon_knife_t'),
          // The MP5-SD's own shot is its suppressed one: CS2 has no other.
          fire(T + 150, 1, 'weapon_mp5sd'),
        ],
      }),
      0,
      DEFAULT
    );
    expect(withKey(cues, 'shot:')).toEqual([
      {
        tick: T + 100,
        key: 'shot:usp:silenced',
        at: P1,
        seed: expect.any(Number),
      },
      { tick: T + 110, key: 'shot:ak47', at: P0, seed: expect.any(Number) },
      {
        tick: T + 120,
        key: 'shot:m4a1s:silenced',
        at: P1,
        seed: expect.any(Number),
      },
      { tick: T + 130, key: 'shot:m4a4', at: P1, seed: expect.any(Number) },
      { tick: T + 140, key: 'shot:knife', at: P0, seed: expect.any(Number) },
      { tick: T + 150, key: 'shot:mp5sd', at: P1, seed: expect.any(Number) },
    ]);
  });

  it("a grenade's shot is its throw, at the thrower", () => {
    const names = [
      'weapon_hegrenade',
      'weapon_flashbang',
      'weapon_smokegrenade',
      'weapon_molotov',
      'weapon_incgrenade',
      'weapon_decoy',
    ];
    const cues = roundCues(
      pack({
        events: names.map((w, i) =>
          event('weapon_fire', T + 100 + i, { user_idx: 0, weapon: w })
        ),
      }),
      0,
      DEFAULT
    );
    expect(cues.map((c) => [c.key, c.at])).toEqual(
      ['he', 'flash', 'smoke', 'molotov', 'incendiary', 'decoy'].map((k) => [
        `throw:${k}`,
        P0,
      ])
    );
  });
});

describe('roundCues: reloads', () => {
  it('a reload sounds its clip out, in and bolt at their share of the reload', () => {
    expect(RELOAD_PARTS).toEqual({ out: 0.2, in: 0.55, bolt: 0.8 });
    const cues = roundCues(
      pack({ events: [event('weapon_reload', T + 100, { user_idx: 0 })] }),
      0,
      DEFAULT
    );
    // An AK reload runs 2.4 s, 154 ticks.
    expect(cues.map((c) => [c.tick, c.key, c.at])).toEqual([
      [T + 100 + 31, 'reload:ak47:out', P0],
      [T + 100 + 85, 'reload:ak47:in', P0],
      [T + 100 + 123, 'reload:ak47:bolt', P0],
    ]);
  });

  it('a reload stops at a death and at a switch to another weapon', () => {
    const cues = roundCues(
      pack({
        weapons: ['none', 'ak47', 'knife'],
        players: [
          // Dead from sample 75 (tick 1150), between the clip out and in.
          (k) => ({ flags: k < 75 ? FLAG.alive : 0 }),
          // Switches to the knife at sample 100 (tick 1200).
          (k) => ({ x: 100, y: 50, weapon: k < 100 ? 1 : 2 }),
        ],
        events: [
          event('weapon_reload', T + 100, { user_idx: 0 }),
          event('weapon_reload', T + 100, { user_idx: 1 }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues.map((c) => [c.key, c.at])).toEqual([
      ['reload:ak47:out', P0],
      ['reload:ak47:out', P1],
      ['reload:ak47:in', P1],
    ]);
  });
});

describe('roundCues: footsteps', () => {
  it('steps take the set under the feet and the team; a landing the set', () => {
    const at: [number, number, number][] = [];
    const cues = roundCues(
      pack({
        players: [
          runner(0),
          runner(1000),
          // In the air for half a second from sample 40, then down.
          (k) => ({
            x: -500,
            y: 0,
            z: k >= 40 && k < 56 ? 50 : 0,
            flags: k >= 40 && k < 56 ? FLAG.alive | FLAG.airborne : FLAG.alive,
          }),
        ],
        teams: [2, 3, 3],
      }),
      0,
      (x, y, z) => {
        at.push([x, y, z]);
        return 'wood';
      }
    );
    const t = withKey(cues, 'step:wood:t');
    const ct = withKey(cues, 'step:wood:ct');
    expect(t).toHaveLength(4);
    expect(ct).toHaveLength(4);
    expect(t[0]).toMatchObject({ tick: T, at: { x: 0, y: 0, z: 0 } });
    expect(ct[0]).toMatchObject({ tick: T, at: { x: 1000, y: 0, z: 0 } });
    expect(withKey(cues, 'land:')).toEqual([
      {
        tick: T + 56 * 2,
        key: 'land:wood',
        at: { x: -500, y: 0, z: 0 },
        seed: expect.any(Number),
      },
    ]);
    expect(
      cues.every((c) => /^(step:wood:(t|ct)|land:wood)$/.test(c.key))
    ).toBe(true);
    // Asked once per footfall, where it falls.
    expect(at).toHaveLength(9);
    expect(at).toContainEqual([1000, 0, 0]);
  });

  it('a player not in the round gives nothing', () => {
    const cues = roundCues(
      pack({
        teams: [0],
        players: [runner(0)],
        events: [
          event('weapon_fire', T + 10, { user_idx: 0, weapon: 'weapon_ak47' }),
          event('weapon_reload', T + 20, { user_idx: 0 }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues).toEqual([]);
  });
});

describe('roundCues: hits and deaths', () => {
  it('a hit from a gun or knife by where it struck and what the victim wore a sample before', () => {
    const cues = roundCues(
      pack({
        players: [
          // A helmet and armour.
          () => ({ x: 0, y: 0, armor: 100, gear: GEAR.helmet }),
          () => ({ x: 100, y: 50 }),
          // Armour until the hit's own sample (100, tick 1200), none after: the hit took it.
          (k) => ({ x: 300, y: 0, armor: k < 100 ? 50 : 0 }),
        ],
        teams: [2, 3, 2],
        events: [
          event('player_hurt', T + 200, {
            user_idx: 2,
            attacker_idx: 1,
            weapon: 'm4a1',
            hitgroup: 'chest',
            health: 40,
          }),
          event('player_hurt', T + 300, {
            user_idx: 1,
            attacker_idx: 0,
            weapon: 'knife',
            hitgroup: 'stomach',
            health: 50,
          }),
          event('player_hurt', T + 310, {
            user_idx: 1,
            attacker_idx: 0,
            weapon: 'ak47',
            hitgroup: 'head',
            health: 10,
          }),
          // Grenades, fire and the world make no hit sound.
          event('player_hurt', T + 320, {
            user_idx: 1,
            attacker_idx: 0,
            weapon: 'hegrenade',
            hitgroup: 'generic',
            health: 5,
          }),
          event('player_hurt', T + 330, {
            user_idx: 1,
            weapon: 'inferno',
            hitgroup: 'generic',
            health: 4,
          }),
          event('player_hurt', T + 400, {
            user_idx: 0,
            attacker_idx: 1,
            weapon: 'usp_silencer',
            hitgroup: 'head',
            health: 0,
          }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues.map((c) => [c.tick, c.key, c.at])).toEqual([
      [T + 200, 'hit:armor', { x: 300, y: 0, z: 0 }],
      [T + 300, 'hit:body', P1],
      [T + 310, 'hit:head', P1],
      [T + 400, 'death:helmet', P0],
    ]);
  });
});

describe('roundCues: grenades', () => {
  it("an HE's detonation explodes where it went off; a flash bangs, a smoke emits", () => {
    const at = { x: 10.5, y: -20, z: 30 };
    const cues = roundCues(
      pack({
        events: [
          event('hegrenade_detonate', T + 300, {
            entityid: 5,
            user_idx: 0,
            ...at,
          }),
          event('flashbang_detonate', T + 310, {
            entityid: 6,
            user_idx: 0,
            ...at,
          }),
          event('smokegrenade_detonate', T + 320, {
            entityid: 7,
            user_idx: 0,
            ...at,
          }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues.map((c) => [c.tick, c.key, c.at])).toEqual([
      [T + 300, 'explode:he', at],
      [T + 310, 'explode:flash', at],
      [T + 320, 'smoke:emit', at],
    ]);
  });

  it('an inferno starts by its grenade, loops until it expires and dies out', () => {
    const at = { x: 1, y: 2, z: 3 };
    // The CT's incendiary bursts at T + 200; the inferno is an entity of its own (id 99).
    const inc: Grenade = {
      ...grenadeTrack({
        kind: 'incendiary',
        thrower: 1,
        start_tick: T + 100,
        from: [100, 50, 60],
        to: [1, 2, 3],
        samples: 51,
        entity_id: 12,
      }),
      detonate_tick: T + 200,
    };
    const cues = roundCues(
      pack({
        grenades: [inc],
        events: [
          event('inferno_startburn', T + 200, {
            entityid: 99,
            user_idx: 1,
            ...at,
          }),
          event('inferno_expire', T + 600, {
            entityid: 99,
            user_idx: 1,
            ...at,
          }),
          // A fire with no grenade of its own: a molotov.
          event('inferno_startburn', T + 900, {
            entityid: 98,
            user_idx: 0,
            ...at,
          }),
        ],
      }),
      0,
      DEFAULT
    );
    const loops = cues.filter((c) => c.until !== undefined);
    expect(loops).toEqual([
      {
        tick: T + 200,
        key: 'fire:loop',
        at,
        seed: expect.any(Number),
        until: T + 600,
      },
      // Without an expire, the timeline's 7 s.
      {
        tick: T + 900,
        key: 'fire:loop',
        at,
        seed: expect.any(Number),
        until: T + 900 + 7 * R,
      },
    ]);
    expect(keysAt(cues, T + 200)).toEqual([
      'fire:start:incendiary',
      'fire:loop',
    ]);
    expect(keysAt(cues, T + 600)).toEqual(['fire:out']);
    expect(keysAt(cues, T + 900)).toEqual(['fire:start:molotov', 'fire:loop']);
    expect(keysAt(cues, T + 900 + 7 * R)).toEqual(['fire:out']);
  });

  it('a grenade bounces where its track turns', () => {
    // A flash falling at 384 u/s that comes back up at 192 u/s from sample 10.
    const n = 20;
    const g: Grenade = {
      entity_id: 3,
      kind: 'flash',
      thrower: 0,
      start_tick: T + 100,
      detonate_tick: null,
      expire_tick: null,
      samples: n,
      x: new Int16Array(n).fill(40),
      y: new Int16Array(n).fill(-40),
      z: Int16Array.from({ length: n }, (_, k) =>
        k <= 10 ? 120 - 12 * k : 6 * (k - 10)
      ),
    };
    const cues = roundCues(pack({ grenades: [g] }), 0, DEFAULT);
    expect(cues.map((c) => [c.tick, c.key, c.at])).toEqual([
      [T + 120, 'bounce:flash', { x: 40, y: -40, z: 0 }],
    ]);
  });

  it("a decoy fires the thrower's last gun in bursts until it ends", () => {
    const at = { x: 7, y: 8, z: 9 };
    const end = T + 300 + 15 * R;
    const cues = roundCues(
      pack({
        events: [
          event('weapon_fire', T + 50, { user_idx: 0, weapon: 'weapon_ak47' }),
          event('weapon_fire', T + 80, {
            user_idx: 0,
            weapon: 'weapon_knife_t',
          }),
          event('weapon_fire', T + 100, {
            user_idx: 0,
            weapon: 'weapon_decoy',
          }),
          // Fired after the throw: not the decoy's gun.
          event('weapon_fire', T + 200, {
            user_idx: 0,
            weapon: 'weapon_glock',
          }),
          event('decoy_started', T + 300, { entityid: 42, user_idx: 0, ...at }),
          event('decoy_detonate', end, { entityid: 42, user_idx: 0, ...at }),
          // A CT's decoy with no gun fired before: the CT pistol.
          event('weapon_fire', T + 400, {
            user_idx: 1,
            weapon: 'weapon_decoy',
          }),
          event('decoy_started', T + 500, { entityid: 43, user_idx: 1, ...at }),
        ],
      }),
      0,
      DEFAULT
    );
    const decoy = cues.filter(
      (c) => c.at && c.at.x === 7 && c.key === 'shot:ak47'
    );
    expect(decoy[0].tick).toBe(T + 300);
    expect(decoy[decoy.length - 1].tick).toBeLessThan(end);
    // Bursts of 1–4 shots 0.12 s apart, 1.5–3 s between them.
    let burst = 1;
    let within = 0;
    let between = 0;
    for (let i = 1; i < decoy.length; i++) {
      const gap = decoy[i].tick - decoy[i - 1].tick;
      if (Math.abs(gap - DECOY.shotS * R) <= 1) {
        within++;
        burst++;
        expect(burst).toBeLessThanOrEqual(DECOY.shots[1]);
      } else {
        between++;
        expect(gap).toBeGreaterThanOrEqual(DECOY.gapS[0] * R - 1);
        expect(gap).toBeLessThanOrEqual(DECOY.gapS[1] * R + 1);
        burst = 1;
      }
    }
    // This seed's pattern has both: bursts of more than one shot, and gaps between bursts.
    expect(within).toBeGreaterThan(0);
    expect(between).toBeGreaterThan(0);
    // 15 s of bursts every 1.5–3 s (and a bit).
    expect(decoy.length).toBeGreaterThanOrEqual(5);
    const ct = cues.filter(
      (c) => c.at && c.at.x === 7 && c.tick >= T + 500 && c.key !== 'shot:ak47'
    );
    expect(ct.length).toBeGreaterThan(0);
    expect(new Set(ct.map((c) => c.key))).toEqual(new Set(['shot:hkp2000']));
  });

  it("a decoy's shots stop with the round", () => {
    const p = pack({
      events: [
        // 2 s before the round's end, and no decoy_detonate: 15 s by the timeline.
        event('decoy_started', T + 3998 - 2 * R, { entityid: 42, user_idx: 0 }),
      ],
    });
    const post = p.header.rounds[0].post_end_tick;
    const shots = withKey(roundCues(p, 0, DEFAULT), 'shot:');
    expect(shots.length).toBeGreaterThan(0);
    expect(shots.every((c) => c.tick <= post)).toBe(true);
  });

  it('a decoy that ends at a huge tick, or a rate that stops time, fires a bounded number of shots', () => {
    // A round running to tick 4e9 (a hostile header), the decoy ending just before it.
    const p = pack({
      events: [
        event('decoy_started', T + 300, { entityid: 42, user_idx: 0 }),
        event('decoy_detonate', 4e9 - 1, { entityid: 42, user_idx: 0 }),
      ],
    });
    p.header.rounds[0].post_end_tick = 4e9;
    const shots = withKey(roundCues(p, 0, DEFAULT), 'shot:');
    expect(shots).toHaveLength(DECOY_MAX_SHOTS);
    // No rate: time does not move, and the decoy fires nothing.
    const still = pack({
      tick_rate: 0,
      events: [
        event('decoy_started', T + 300, { entityid: 42, user_idx: 0 }),
        event('decoy_detonate', T + 900, { entityid: 42, user_idx: 0 }),
      ],
    });
    expect(withKey(roundCues(still, 0, DEFAULT), 'shot:')).toEqual([]);
  });

  it('of two bursts as near a fire’s start, the later grenade in the round lit it', () => {
    // The CT's molotov bursts 10 ticks before the fire, the incendiary 10 after.
    const burst = (kind: Grenade['kind'], at: number): Grenade => ({
      ...grenadeTrack({
        kind,
        thrower: 1,
        start_tick: T + 100,
        from: [0, 0, 0],
        to: [0, 0, 0],
      }),
      detonate_tick: at,
    });
    const fire = [
      event('inferno_startburn', T + 200, { entityid: 99, user_idx: 1 }),
    ];
    const kindOf = (grenades: Grenade[]) =>
      withKey(
        roundCues(pack({ grenades, events: fire }), 0, DEFAULT),
        'fire:start:'
      )[0].key;
    const molotov = burst('molotov', T + 190);
    const incendiary = burst('incendiary', T + 210);
    expect(kindOf([molotov, incendiary])).toBe('fire:start:incendiary');
    expect(kindOf([incendiary, molotov])).toBe('fire:start:molotov');
    // Nearer wins whatever the order; past 0.5 s, none does.
    expect(kindOf([burst('molotov', T + 199), incendiary])).toBe(
      'fire:start:molotov'
    );
    expect(kindOf([burst('incendiary', T + 200 - 33)])).toBe(
      'fire:start:molotov'
    );
  });

  it('a round of 20,000 decoys and 20,000 fires builds in well under a second', () => {
    // Each decoy follows a gunshot and a throw, each fire its own grenade's burst, and each has
    // its own end: a build that went through the round's shots, grenades or events for each
    // would take seconds. Timed from a fresh pack, the timeline built inside it.
    const n = 20_000;
    const events: PackEvent[] = [];
    const grenades: Grenade[] = [];
    for (let i = 0; i < n; i++) {
      const t = T + 4 * i;
      const fire = { entityid: n + i, x: 0, y: 0, z: 0 };
      events.push(
        event('weapon_fire', t, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', t + 1, { user_idx: 0, weapon: 'weapon_decoy' }),
        event('decoy_started', t + 2, { entityid: i, user_idx: 0 }),
        event('decoy_detonate', t + 3, { entityid: i }),
        event('inferno_startburn', t + 2, { ...fire, user_idx: 1 }),
        event('inferno_expire', t + 3, fire)
      );
      grenades.push({
        ...grenadeTrack({
          kind: i % 2 ? 'incendiary' : 'molotov',
          thrower: 1,
          start_tick: t,
          from: [0, 0, 0],
          to: [0, 0, 0],
          samples: 2,
          entity_id: i,
        }),
        detonate_tick: t + 2,
      });
    }
    const p = pack({ samples: 2 * n + 10, events, grenades });
    // CPU time, not the wall clock: a loaded machine once stretched this past 1 s.
    const { value: cues, ms } = cpuTimed(() => roundCues(p, 0, DEFAULT));
    expect(ms).toBeLessThan(1000);
    // Each decoy fired the AK its thrower shot before the throw, once before it ended; each
    // fire started as its own grenade.
    expect(cues.filter((c) => c.key === 'shot:ak47')).toHaveLength(2 * n);
    expect(withKey(cues, 'fire:start:incendiary')).toHaveLength(n / 2);
    expect(withKey(cues, 'fire:start:molotov')).toHaveLength(n / 2);
  });
});

describe('decoyShotTicks', () => {
  it('bursts from the start, all before the end, the same for a seed', () => {
    const ticks = decoyShotTicks(T, T + 15 * R, R, 1234);
    expect(ticks[0]).toBe(T);
    expect(ticks.every((t) => t >= T && t < T + 15 * R)).toBe(true);
    expect(decoyShotTicks(T, T + 15 * R, R, 1234)).toEqual(ticks);
    expect(decoyShotTicks(T, T + 15 * R, R, 4321)).not.toEqual(ticks);
    expect(decoyShotTicks(T, T, R, 1234)).toEqual([]);
  });

  it('none at a rate of 0, below or NaN; at most DECOY_MAX_SHOTS up to any end', () => {
    for (const rate of [0, -64, NaN])
      expect(decoyShotTicks(T, T + 1000, rate, 1)).toEqual([]);
    expect(DECOY_MAX_SHOTS).toBe(200);
    expect(decoyShotTicks(T, 1e12, R, 1)).toHaveLength(DECOY_MAX_SHOTS);
    expect(decoyShotTicks(T, Infinity, R, 1)).toHaveLength(DECOY_MAX_SHOTS);
  });
});

describe('roundCues: the bomb and the round', () => {
  it('a plant: the planter initiates, the bomb plants, beeps and blows', () => {
    const planted = T + 300;
    const blast = planted + 40 * R;
    const cues = roundCues(
      pack({
        players: [
          () => ({ x: 0, y: 0 }),
          () => ({ x: 100, y: 50 }),
          () => ({ x: 500, y: 600, z: 10 }),
        ],
        teams: [2, 3, 2],
        events: [
          event('bomb_beginplant', T + 100, { user_idx: 0, site: 1 }),
          event('bomb_planted', planted, { user_idx: 2, site: 1 }),
          event('bomb_exploded', blast, { user_idx: 2, site: 1 }),
        ],
      }),
      0,
      DEFAULT
    );
    const bomb = { x: 500, y: 600, z: 10 };
    expect(cues[0]).toMatchObject({
      tick: T + 100,
      key: 'bomb:initiate',
      at: P0,
    });
    expect(keysAt(cues, planted)).toEqual(['bomb:plant', 'round:planted']);
    expect(cues.find((c) => c.key === 'bomb:plant')?.at).toEqual(bomb);
    expect(cues.find((c) => c.key === 'round:planted')?.at).toBeNull();
    const beeps = withKey(cues, 'bomb:beep');
    expect(beeps.map((c) => c.tick)).toEqual(bombBeepTicks(planted, blast, R));
    expect(beeps.every((c) => c.at !== null && c.at.x === 500)).toBe(true);
    expect(cues[cues.length - 1]).toMatchObject({
      tick: blast,
      key: 'bomb:explode',
      at: bomb,
    });
  });

  it('a second bomb_planted in a round is ignored: one plant, one series of beeps', () => {
    const planted = T + 300;
    const cues = roundCues(
      pack({
        players: [() => ({ x: 0, y: 0 }), () => ({ x: 100, y: 50 })],
        teams: [2, 2],
        events: [
          event('bomb_planted', planted, { user_idx: 0, site: 1 }),
          event('bomb_planted', planted + 10 * R, { user_idx: 1, site: 2 }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(withKey(cues, 'bomb:plant')).toHaveLength(1);
    expect(withKey(cues, 'round:planted')).toHaveLength(1);
    const beeps = withKey(cues, 'bomb:beep');
    expect(beeps.map((c) => c.tick)).toEqual(
      bombBeepTicks(planted, planted + 40 * R, R)
    );
    expect(beeps.every((c) => c.at !== null && c.at.x === 0)).toBe(true);
  });

  it('a defuse: the defuse starts with the flag, the beeps stop at the defuse', () => {
    const planted = T + 300;
    const defused = T + 1000;
    const cues = roundCues(
      pack({
        players: [
          () => ({ x: 0, y: 0 }),
          (k) => ({
            x: 100,
            y: 50,
            flags:
              k >= 300 && k < 500 ? FLAG.alive | FLAG.defusing : FLAG.alive,
          }),
        ],
        events: [
          event('bomb_planted', planted, { user_idx: 0, site: 1 }),
          event('bomb_defused', defused, { user_idx: 1, site: 1 }),
          event('round_end', defused, { winner: 3, reason: 'bomb_defused' }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues.find((c) => c.key === 'bomb:defuse')).toMatchObject({
      tick: T + 600,
      at: P0,
    });
    expect(keysAt(cues, defused)).toEqual([
      'bomb:defused',
      'round:defused',
      'round:ct',
    ]);
    const beeps = withKey(cues, 'bomb:beep');
    expect(beeps.map((c) => c.tick)).toEqual(
      bombBeepTicks(planted, defused, R)
    );
    expect(beeps[beeps.length - 1].tick).toBeLessThan(defused);
    expect(cues.some((c) => c.key === 'bomb:explode')).toBe(false);
  });

  it('bomb_begindefuse, when the pack has it, starts the defuse in place of the flag', () => {
    const cues = roundCues(
      pack({
        players: [
          () => ({ x: 0, y: 0 }),
          (k) => ({
            x: 100,
            y: 50,
            flags: k >= 300 ? FLAG.alive | FLAG.defusing : FLAG.alive,
          }),
        ],
        events: [
          event('bomb_planted', T + 300, { user_idx: 0, site: 1 }),
          event('bomb_begindefuse', T + 590, { user_idx: 1 }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(withKey(cues, 'bomb:defuse').map((c) => c.tick)).toEqual([T + 590]);
  });

  it('round_end winner 3 is round:ct, heard everywhere; the countdown beeps and goes', () => {
    const cues = roundCues(
      pack({
        events: [
          event('cs_round_start_beep', T + 10, {}),
          event('cs_round_start_beep', T + 74, {}),
          event('cs_round_start_beep', T + 138, {}),
          event('cs_round_final_beep', T + 202, {}),
          event('round_end', T + 900, { winner: 3, reason: 't_killed' }),
        ],
      }),
      0,
      DEFAULT
    );
    expect(cues.map((c) => [c.tick, c.key, c.at])).toEqual([
      [T + 10, 'round:beep', null],
      [T + 74, 'round:beep', null],
      [T + 138, 'round:beep', null],
      [T + 202, 'round:go', null],
      [T + 900, 'round:ct', null],
    ]);
    const t = roundCues(
      pack({ events: [event('round_end', T + 900, { winner: 2 })] }),
      0,
      DEFAULT
    );
    expect(t.map((c) => c.key)).toEqual(['round:t']);
    const draw = roundCues(
      pack({ events: [event('round_end', T + 900, { winner: 1 })] }),
      0,
      DEFAULT
    );
    expect(draw.map((c) => c.key)).toEqual(['round:draw']);
  });
});

describe('roundCues: order and seeds', () => {
  const busy = () =>
    pack({
      players: [runner(0), runner(1000)],
      events: [
        event('weapon_fire', T + 21, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', T + 20, { user_idx: 1, weapon: 'weapon_ak47' }),
        event('weapon_reload', T + 30, { user_idx: 1 }),
        event('hegrenade_detonate', T + 20, { entityid: 5, x: 1, y: 1, z: 1 }),
        event('round_end', T + 900, { winner: 2 }),
      ],
    });

  it('sorted by tick; two calls give equal arrays', () => {
    const a = roundCues(busy(), 0, DEFAULT);
    const b = roundCues(busy(), 0, DEFAULT);
    expect(a.length).toBeGreaterThan(10);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++)
      expect(a[i].tick).toBeGreaterThanOrEqual(a[i - 1].tick);
    expect(a.every((c) => Number.isInteger(c.seed) && c.seed >= 0)).toBe(true);
  });

  it('a seed is fixed by the tick, the source and the key: two players stepping together differ', () => {
    const a = roundCues(busy(), 0, DEFAULT);
    // The T and the CT step in step, on the same ticks, with sets of their own.
    const t = a.filter((c) => c.key === 'step:default:t');
    const ct = a.filter((c) => c.key === 'step:default:ct');
    expect(t.map((c) => c.tick)).toEqual(ct.map((c) => c.tick));
    // Two Ts stepping together (the same tick and key) differ by their source.
    const twoTs = roundCues(
      pack({ players: [runner(0), runner(1000)], teams: [2, 2] }),
      0,
      DEFAULT
    );
    const first = twoTs.filter((c) => c.tick === T);
    expect(first.map((c) => c.key)).toEqual([
      'step:default:t',
      'step:default:t',
    ]);
    expect(first[0].seed).not.toBe(first[1].seed);
    expect(new Set(a.map((c) => c.seed)).size).toBe(a.length);
  });

  it('a round not in the pack has no cues', () => {
    expect(roundCues(busy(), 5, DEFAULT)).toEqual([]);
  });
});

describe('bombBeepTicks', () => {
  const plant = 1000;
  const fuse = plant + 40 * R;

  it("beeps on each of blinkOn's rising edges over the fuse, ever closer together", () => {
    const ticks = bombBeepTicks(plant, fuse, R);
    // The rising edges, counted at an eighth of a tick.
    let edges = 0;
    let was = blinkOn(0);
    for (let t = plant + 1 / 8; t < fuse; t += 1 / 8) {
      const on = blinkOn((t - plant) / R);
      if (on && !was) edges++;
      was = on;
    }
    expect(ticks).toHaveLength(edges);
    expect(edges).toBeGreaterThan(150);
    for (const t of ticks) {
      expect(t).toBeGreaterThan(plant);
      expect(t).toBeLessThan(fuse);
      expect(blinkOn((t - plant) / R)).toBe(true);
      expect(blinkOn((t - 1 - plant) / R)).toBe(false);
    }
    const gaps = ticks.slice(1).map((t, i) => t - ticks[i]);
    for (let i = 1; i < gaps.length; i++)
      expect(gaps[i]).toBeLessThanOrEqual(gaps[i - 1] + 1);
    expect(gaps[gaps.length - 1]).toBeLessThan(gaps[0] / 5);
  });

  it('a defuse halfway cuts it there', () => {
    const half = plant + 20 * R;
    const full = bombBeepTicks(plant, fuse, R);
    expect(bombBeepTicks(plant, half, R)).toEqual(full.filter((t) => t < half));
    expect(bombBeepTicks(plant, plant, R)).toEqual([]);
  });
});

describe('crossed and loopsAt', () => {
  const cue = (tick: number, key: string, until?: number): Cue =>
    until === undefined
      ? { tick, key, at: null, seed: 0 }
      : { tick, key, at: null, seed: 0, until };
  const cues = [
    cue(50, 'a'),
    cue(100, 'b'),
    cue(100, 'fire', 300),
    cue(150, 'c'),
    cue(200, 'd'),
    cue(200, 'e'),
    cue(250, 'f'),
  ];

  it('crossed: the one-shots after `from`, up to and with `to`', () => {
    expect(crossed(cues, 100, 200).map((c) => c.key)).toEqual(['c', 'd', 'e']);
    expect(crossed(cues, 99, 100).map((c) => c.key)).toEqual(['b']);
    expect(crossed(cues, 0, 1000).map((c) => c.key)).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
    ]);
    expect(crossed(cues, 200, 200)).toEqual([]);
    expect(crossed([], 0, 10)).toEqual([]);
    const out: Cue[] = [cue(1, 'stale')];
    expect(crossed(cues, 240, 260, out)).toBe(out);
    expect(out.map((c) => c.key)).toEqual(['f']);
  });

  it('loopsAt: the loops started by the tick and not over', () => {
    expect(loopsAt(cues, 99)).toEqual([]);
    expect(loopsAt(cues, 100).map((c) => c.key)).toEqual(['fire']);
    expect(loopsAt(cues, 299).map((c) => c.key)).toEqual(['fire']);
    expect(loopsAt(cues, 300)).toEqual([]);
    const out: Cue[] = [cue(1, 'stale')];
    expect(loopsAt(cues, 200, out)).toBe(out);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe('fire');
  });
});

/** The built sounds manifest: under `ASSETS_DIR`, else the repo's `assets/`. */
const MANIFEST = join(
  process.env.ASSETS_DIR ??
    fileURLToPath(new URL('../../assets', import.meta.url)),
  'sounds/manifest.json'
);
for (const m of MATCHES)
  describe.skipIf(m.skip)(`Sound cues on ${m.name}`, () => {
    it('steps, landings, bounces and the countdown in range; every round built in under 1 s of CPU', async () => {
      const pk = await m.load();
      const rounds = pk.header.rounds;
      // Timed from a fresh pack: the timeline and the actions are built inside it.
      const { value: all, ms } = cpuTimed(() =>
        rounds.map((_, r) => roundCues(pk, r, DEFAULT))
      );
      const count = (re: RegExp) =>
        all.reduce(
          (n, cues) => n + cues.filter((c) => re.test(c.key)).length,
          0
        );
      const steps = count(/^step:/);
      const lands = count(/^land:/);
      const bounces = count(/^bounce:/);
      const gos = count(/^round:go$/);
      const grenades = pk.grenades.filter((g) =>
        rounds.some(
          (r) => g.start_tick >= r.start_tick && g.start_tick <= r.post_end_tick
        )
      ).length;
      const cues = all.reduce((n, c) => n + c.length, 0);
      console.log(
        `${m.real ? 'real' : 'synthetic'} cues: ${cues} in ${ms.toFixed(0)} ms of CPU; ${steps} steps, ${lands} landings, ${bounces} bounces over ${grenades} grenades (${(bounces / grenades).toFixed(2)} each), ${gos} round:go`
      );
      // A real match's ranges; the synthetic one's players each run to a site, jumping once a
      // round, and its grenades each bounce once.
      const [stepsIn, landsIn, bouncesIn] = m.real
        ? [
            [10_000, 25_000],
            [500, 2_500],
            [0.5, 4],
          ]
        : [
            [50 * rounds.length, 400 * rounds.length],
            [10 * rounds.length, 10 * rounds.length],
            [1, 1],
          ];
      expect(steps).toBeGreaterThanOrEqual(stepsIn[0]);
      expect(steps).toBeLessThanOrEqual(stepsIn[1]);
      expect(lands).toBeGreaterThanOrEqual(landsIn[0]);
      expect(lands).toBeLessThanOrEqual(landsIn[1]);
      expect(bounces / grenades).toBeGreaterThanOrEqual(bouncesIn[0]);
      expect(bounces / grenades).toBeLessThanOrEqual(bouncesIn[1]);
      expect(gos).toBe(rounds.length);
      expect(ms).toBeLessThan(1000);
      for (const cues of all)
        for (let i = 1; i < cues.length; i++)
          expect(cues[i].tick).toBeGreaterThanOrEqual(cues[i - 1].tick);
    });

    // The synthetic match's keys are only what it was made of; a real one's are what the
    // manifest must cover.
    if (m.real)
      it.skipIf(!existsSync(MANIFEST))(
        needs(
          'every key but the reload parts is a sound of the real manifest',
          'DEMOVIEWER_PACK',
          'ASSETS_DIR'
        ),
        async () => {
          const pk = await m.load();
          const { sounds } = JSON.parse(readFileSync(MANIFEST, 'utf8')) as {
            sounds: Record<string, unknown>;
          };
          const keys = new Set<string>();
          pk.header.rounds.forEach((_, r) => {
            for (const c of roundCues(pk, r, DEFAULT)) keys.add(c.key);
          });
          // Some guns lack a reload part in CS2's data (the M249's clip, the Nova's out): the
          // player skips a key the manifest has not.
          const missing = [...keys].filter(
            (k) => !k.startsWith('reload:') && !Object.hasOwn(sounds, k)
          );
          expect(missing).toEqual([]);
          expect(keys.size).toBeGreaterThan(50);
        }
      );
  });
