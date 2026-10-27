import { describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import {
  ActionIndex,
  DEATH_S,
  flinchClip,
  PULLPIN_S,
  THROW_S,
} from '../src/sim/actions';
import { DEATH_TOTAL_S } from '../src/sim/anim';
import { event, grenadeTrack, trackPack } from './helpers/track-pack';

// 64 ticks/s, 2 ticks per sample, round starts at tick 1000 and holds 200 samples (to 1398).
const T = 1000;

function pack(o: Parameters<typeof trackPack>[0] = { players: [] }) {
  return trackPack({
    weapons: ['none', 'ak47', 'glock', 'c4'],
    ...o,
    players: o.players.length
      ? o.players
      : [() => ({ x: 0, y: 0, yaw: 0 }), () => ({ x: 100, y: 0, yaw: 180 })],
  });
}

const kinds = (list: { kind: string; clip: string }[]) =>
  list.map((a) => `${a.kind}:${a.clip}`);

describe('ActionIndex', () => {
  it("schedules a shot from weapon_fire at its tick, by the event's weapon name", () => {
    const p = pack({
      players: [],
      events: [
        event('weapon_fire', T + 100, { user_idx: 0, weapon: 'weapon_m4a1' }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(kinds(ix.at(0, 0, T + 100))).toEqual(['shoot:shoot_m4a4']);
    expect(ix.at(0, 0, T + 100)[0]).toMatchObject({
      startTick: T + 100,
      durationTicks: 13,
      upperBody: true,
      additive: false,
      data: { weapon: 'm4a4' },
    });
    expect(ix.at(0, 0, T + 99)).toEqual([]);
    expect(ix.at(0, 0, T + 112)).toHaveLength(1);
    expect(ix.at(0, 0, T + 113)).toEqual([]);
    expect(ix.at(0, 1, T + 100)).toEqual([]);
  });

  it('reloads with the weapon the track holds, draws on item_equip, skips weapons without clips', () => {
    const p = pack({
      players: [
        (k) => ({ x: 0, y: 0, yaw: 0, weapon: k < 50 ? 2 : k >= 160 ? 3 : 1 }),
      ],
      events: [
        event('weapon_reload', T + 20, { user_idx: 0 }),
        event('weapon_reload', T + 200, { user_idx: 0 }),
        event('item_equip', T + 300, { user_idx: 0, item: 'ak47' }),
        event('item_equip', T + 320, { user_idx: 0, item: 'c4' }),
        event('weapon_fire', T + 340, { user_idx: 0, weapon: 'weapon_c4' }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(kinds(ix.at(0, 0, T + 20))).toEqual(['reload:reload_glock']);
    expect(ix.at(0, 0, T + 20)[0].durationTicks).toBe(Math.round(2.3 * 64));
    expect(kinds(ix.at(0, 0, T + 200))).toEqual(['reload:reload_ak']);
    // The AK reload runs 2.4 s (154 ticks), so it is still playing under the draw.
    expect(kinds(ix.at(0, 0, T + 300))).toEqual([
      'draw:draw_ak',
      'reload:reload_ak',
    ]);
    expect(ix.at(0, 0, T + 300)[0].durationTicks).toBe(Math.round(0.6 * 64));
    // Equipping or "firing" the c4 schedules nothing (no draw or shoot clip for it).
    expect(ix.build(0)[0].filter((a) => a.data?.weapon === 'c4')).toEqual([]);
    expect(ix.build(0)[0].map((a) => a.kind)).toEqual([
      'reload',
      'reload',
      'draw',
    ]);
  });

  it("pulls the pin before a grenade's start tick and throws at it, under- or overhand by launch speed", () => {
    const fast = grenadeTrack({
      kind: 'smoke',
      thrower: 0,
      start_tick: T + 200,
      from: [0, 0, 64],
      to: [900, 0, 64],
    });
    const slow = grenadeTrack({
      kind: 'molotov',
      thrower: 1,
      start_tick: T + 300,
      from: [100, 0, 64],
      to: [130, 0, 64],
      entity_id: 2,
    });
    const outside = grenadeTrack({
      kind: 'he',
      thrower: 0,
      start_tick: T + 5000,
      from: [0, 0, 0],
      to: [0, 0, 0],
      entity_id: 3,
    });
    const ix = new ActionIndex(
      pack({ players: [], grenades: [fast, slow, outside] })
    );
    const pin = Math.round(PULLPIN_S * 64);
    expect(kinds(ix.at(0, 0, T + 200 - pin))).toEqual([
      'pullpin:pullpin_grenade',
    ]);
    expect(kinds(ix.at(0, 0, T + 200))).toEqual([
      'throw:throw_overhand_grenade',
    ]);
    expect(ix.at(0, 0, T + 200)[0].durationTicks).toBe(
      Math.round(THROW_S * 64)
    );
    expect(kinds(ix.at(0, 1, T + 300 - 5))).toEqual([
      'pullpin:pullpin_molotov',
    ]);
    expect(kinds(ix.at(0, 1, T + 305))).toEqual([
      'throw:throw_underhand_grenade',
    ]);
    expect(ix.build(0)[0].filter((a) => a.kind === 'throw')).toHaveLength(1);
  });

  it('plants from bomb_beginplant to bomb_planted, or until the planter moves', () => {
    const p = pack({
      players: [
        (k) => ({
          x: k >= 120 ? (k - 119) * 20 : 0,
          y: 0,
          yaw: 0,
          duck: k > 100 ? 200 : 0,
        }),
        () => ({ x: 500, y: 0 }),
      ],
      events: [
        event('bomb_beginplant', T + 20, { user_idx: 0 }),
        event('bomb_planted', T + 100, { user_idx: 0 }),
        event('bomb_beginplant', T + 210, { user_idx: 0 }),
      ],
    });
    const ix = new ActionIndex(p);
    const first = ix.at(0, 0, T + 50)[0];
    expect(first).toMatchObject({
      kind: 'plant',
      clip: 'planting',
      startTick: T + 20,
      durationTicks: 80,
      upperBody: false,
    });
    expect(ix.at(0, 0, T + 100)).toEqual([]);
    // Second attempt, crouched: no bomb_planted follows; the planter starts moving at sample 120
    // (tick 1240), which the 0.15 s speed window sees from sample 117 (tick 1234).
    const second = ix.at(0, 0, T + 215)[0];
    expect(second).toMatchObject({
      kind: 'plant',
      clip: 'planting_crouch',
      startTick: T + 210,
    });
    expect(second.startTick + second.durationTicks).toBe(T + 234);
  });

  it('defuses while the flag holds, crouched or not', () => {
    const p = pack({
      players: [
        () => ({ x: 500, y: 0 }),
        (k) => ({
          x: 0,
          y: 0,
          flags: k >= 30 && k < 60 ? FLAG.alive | FLAG.defusing : FLAG.alive,
          duck: k >= 30 ? 255 : 0,
        }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(ix.at(0, 1, T + 59)).toEqual([]);
    expect(ix.at(0, 1, T + 60)[0]).toMatchObject({
      kind: 'defuse',
      clip: 'defuse_crouch_loop_rifle',
      startTick: T + 60,
      durationTicks: 60,
    });
    expect(ix.at(0, 1, T + 119)).toHaveLength(1);
    expect(ix.at(0, 1, T + 120)).toEqual([]);
  });

  it('flinches by hit group and attacker bearing, burns for grenade damage, and never after death', () => {
    // Victim 0 at the origin facing +x; attacker 1 at (0, 100) is on the victim's left.
    const p = pack({
      players: [
        () => ({ x: 0, y: 0, yaw: 0 }),
        () => ({ x: 0, y: 100, yaw: -90 }),
        () => ({ x: -100, y: 0, yaw: 0 }),
      ],
      events: [
        event('player_hurt', T + 10, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'head',
          dmg_health: 30,
          weapon: 'ak47',
        }),
        event('player_hurt', T + 40, {
          user_idx: 0,
          attacker_idx: 2,
          hitgroup: 'chest',
          dmg_health: 30,
          weapon: 'ak47',
        }),
        event('player_hurt', T + 60, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'left_leg',
          dmg_health: 30,
          weapon: 'ak47',
        }),
        event('player_hurt', T + 80, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'generic',
          dmg_health: 10,
          weapon: 'hegrenade',
        }),
        event('player_hurt', T + 100, {
          user_idx: 0,
          attacker_idx: null,
          hitgroup: 'generic',
          dmg_health: 5,
          weapon: 'world',
        }),
        event('player_death', T + 120, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'head',
          headshot: true,
          weapon: 'ak47',
        }),
        event('player_hurt', T + 120, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'head',
          dmg_health: 100,
          weapon: 'ak47',
        }),
        event('player_hurt', T + 140, {
          user_idx: 0,
          attacker_idx: 1,
          hitgroup: 'head',
          dmg_health: 100,
          weapon: 'ak47',
        }),
        event('player_blind', T + 150, {
          user_idx: 0,
          attacker_idx: 1,
          blind_duration: 2,
        }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(kinds(ix.at(0, 0, T + 10))).toEqual(['flinch:flinch_head_left']);
    expect(ix.at(0, 0, T + 10)[0]).toMatchObject({
      additive: true,
      durationTicks: 19,
      data: { attacker: 1, hitgroup: 'head' },
    });
    expect(ix.at(0, 0, T + 10)[0].data!.bearing).toBeCloseTo(-90, 3);
    expect(kinds(ix.at(0, 0, T + 40))).toEqual(['flinch:flinch_chest_rear']);
    expect(kinds(ix.at(0, 0, T + 60))).toEqual(['flinch:flinch_leg_left']);
    expect(kinds(ix.at(0, 0, T + 80))).toEqual(['flinch:flinch_molotov']);
    expect(kinds(ix.at(0, 0, T + 100))).toEqual(['flinch:flinch_stomach']);
    expect(ix.at(0, 0, T + 100)[0].data!.bearing).toBeUndefined();
    const dead = ix.at(0, 0, T + 120);
    expect(kinds(dead)).toEqual(['death:flinch_head_left']);
    expect(dead[0]).toMatchObject({
      durationTicks: Math.round(DEATH_S * 64),
      data: { headshot: true, attacker: 1 },
    });
    // The death lasts as long as the body it plays on.
    expect(DEATH_S).toBe(DEATH_TOTAL_S);
    expect(kinds(ix.at(0, 0, T + 140))).toEqual(['death:flinch_head_left']);
    expect(kinds(ix.at(0, 0, T + 150))).toEqual(['death:flinch_head_left']);
  });

  it('holds the flashed pose for the blind duration, crouched when the player is', () => {
    const p = pack({
      players: [(k) => ({ x: 0, y: 0, duck: k >= 100 ? 255 : 0 })],
      events: [
        event('player_blind', T + 10, {
          user_idx: 0,
          attacker_idx: 1,
          blind_duration: 1.5,
        }),
        event('player_blind', T + 220, {
          user_idx: 0,
          attacker_idx: 1,
          blind_duration: 0.25,
        }),
        event('player_blind', T + 300, {
          user_idx: 0,
          attacker_idx: 1,
          blind_duration: 0,
        }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(ix.at(0, 0, T + 10)[0]).toMatchObject({
      kind: 'flashed',
      clip: 'flashed',
      durationTicks: 96,
      upperBody: false,
    });
    expect(ix.at(0, 0, T + 105)).toHaveLength(1);
    expect(ix.at(0, 0, T + 106)).toEqual([]);
    expect(ix.at(0, 0, T + 220)[0]).toMatchObject({
      clip: 'flashed_crouch',
      durationTicks: 16,
    });
    expect(ix.at(0, 0, T + 300)).toEqual([]);
  });

  it('lists overlapping actions newest first and ignores events outside the round or for unknown players', () => {
    const p = pack({
      players: [],
      events: [
        event('weapon_reload', T + 10, { user_idx: 0 }),
        event('weapon_fire', T + 30, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', T + 30, { user_idx: 7, weapon: 'weapon_ak47' }),
        event('weapon_fire', T + 30, { user_idx: null, weapon: 'weapon_ak47' }),
        event('weapon_fire', 10, { user_idx: 0, weapon: 'weapon_ak47' }),
      ],
    });
    const ix = new ActionIndex(p);
    expect(kinds(ix.at(0, 0, T + 32))).toEqual([
      'shoot:shoot_ak',
      'reload:reload_ak',
    ]);
    expect(ix.build(0).flat()).toHaveLength(2);
    expect(ix.at(5, 0, T)).toEqual([]);
  });
});

describe('ActionIndex.recent', () => {
  it('lists what started in the window, finished or not, newest first', () => {
    const p = pack({
      players: [],
      events: [
        event('weapon_fire', T + 10, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', T + 100, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', T + 300, { user_idx: 0, weapon: 'weapon_ak47' }),
      ],
    });
    const ix = new ActionIndex(p);
    const starts = (tick: number, s: number) =>
      ix.recent(0, 0, tick, s).map((a) => `${a.kind}@${a.startTick - T}`);
    // Both shots (0.2 s each) have ended; `at` no longer lists them.
    expect(ix.at(0, 0, T + 140)).toEqual([]);
    expect(starts(T + 140, 3)).toEqual(['shoot@100', 'shoot@10']);
    expect(starts(T + 140, 1)).toEqual(['shoot@100']);
    // Exactly `seconds` back (64 ticks) is out of the window; the tick itself is in.
    expect(starts(T + 73.5, 1)).toEqual(['shoot@10']);
    expect(starts(T + 74, 1)).toEqual([]);
    expect(starts(T + 100, 0.5)).toEqual(['shoot@100']);
    expect(starts(T + 99, 0.5)).toEqual([]);
    expect(ix.recent(0, 5, T + 140, 2)).toEqual([]);
  });
});

describe('flinchClip', () => {
  it('picks the part and the side', () => {
    expect(flinchClip('head', 'ak47', 0)).toBe('flinch_head');
    expect(flinchClip('head', 'ak47', 100)).toBe('flinch_head_right');
    expect(flinchClip('head', 'ak47', -100)).toBe('flinch_head_left');
    expect(flinchClip('head', 'ak47', 170)).toBe('flinch_head_rear');
    expect(flinchClip('stomach', 'ak47', 100)).toBe('flinch_stomach');
    expect(flinchClip('stomach', 'ak47', -170)).toBe('flinch_stomach_rear');
    expect(flinchClip('right_arm', 'ak47', 170)).toBe('flinch_arm_right');
    expect(flinchClip(undefined, 'ak47', undefined)).toBe('flinch_stomach');
    expect(flinchClip('head', 'inferno', 0)).toBe('flinch_molotov');
  });
});

describe('ActionIndex: the after-round', () => {
  it('schedules a shot after end_tick, before post_end_tick', () => {
    const p = pack({
      players: [],
      events: [
        event('weapon_fire', 1350, { user_idx: 0, weapon: 'weapon_ak47' }),
      ],
    });
    p.header.rounds[0].end_tick = 1300;
    expect(kinds(new ActionIndex(p).at(0, 0, 1350))).toEqual([
      'shoot:shoot_ak',
    ]);
  });
});
