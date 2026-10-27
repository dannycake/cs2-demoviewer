import { describe, expect, it } from 'vitest';
import { FLAG, type Pack, type PlayerTrack } from '../src/pack/types';
import {
  followKey,
  playerRows,
  sortRows,
  weaponLabel,
} from '../src/components/player-rows';

/** A track whose u8 columns are given per sample; positions are zero. */
function track(
  samples: { health: number; armor: number; flags: number; weapon: number }[]
): PlayerTrack {
  const n = samples.length;
  const u8 = (f: (s: (typeof samples)[number]) => number) =>
    Uint8Array.from(samples.map(f));
  return {
    x: new Int16Array(n),
    y: new Int16Array(n),
    z: new Int16Array(n),
    yaw: new Int16Array(n),
    pitch: new Int16Array(n),
    health: u8((s) => s.health),
    armor: u8((s) => s.armor),
    flags: u8((s) => s.flags),
    duck: new Uint8Array(n),
    weapon: u8((s) => s.weapon),
    money: new Uint16Array(n),
    ammo: new Uint8Array(n).fill(255),
    gear: new Uint8Array(n),
  };
}

const A = FLAG.alive;

// Three players (a pack with fewer than ten): one round of 3 samples at ticks 100, 108, 116.
function pack(): Pack {
  return {
    header: {
      version: 1,
      map: 'de_test',
      server_name: '',
      game_build: '',
      tick_rate: 64,
      sample_hz: 8,
      tick_step: 8,
      weapons: ['none', 'AK-47', 'knife_t'],
      players: [
        { steamid: '1', name: 'alpha', team_by_round: [2], crosshair: null },
        { steamid: '2', name: 'bravo', team_by_round: [3], crosshair: null },
        { steamid: '3', name: 'bench', team_by_round: [0], crosshair: null },
      ],
      rounds: [
        {
          number: 1,
          start_tick: 100,
          freeze_end_tick: 100,
          end_tick: 116,
          post_end_tick: 116,
          winner: 2,
          reason: 't_killed',
          score_t: 1,
          score_ct: 0,
          samples: 3,
        },
      ],
    },
    rounds: [
      {
        players: [
          track([
            { health: 100, armor: 100, flags: A | FLAG.bomb, weapon: 1 },
            { health: 73, armor: 90, flags: A | FLAG.flashed, weapon: 2 },
            { health: 0, armor: 0, flags: 0, weapon: 0 },
          ]),
          track([
            { health: 100, armor: 0, flags: A, weapon: 1 },
            { health: 100, armor: 0, flags: A | FLAG.defusing, weapon: 1 },
            { health: 100, armor: 0, flags: A, weapon: 1 },
          ]),
          track([
            { health: 0, armor: 0, flags: 0, weapon: 0 },
            { health: 0, armor: 0, flags: 0, weapon: 0 },
            { health: 0, armor: 0, flags: 0, weapon: 0 },
          ]),
        ],
      },
    ],
    events: [],
    grenades: [],
    inventory: [],
    entities: [],
    entityChanges: [],
    ground: [],
  };
}

describe('playerRows', () => {
  it('makes one row per player in the header, not ten', () => {
    const rows = playerRows(pack(), 0, 100);
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'bravo', 'bench']);
    expect(rows.map((r) => r.key)).toEqual(['1', '2', '3']);
  });

  it('reads the sample at or before the tick', () => {
    const [alpha] = playerRows(pack(), 0, 107.5);
    expect(alpha).toMatchObject({
      team: 2,
      inRound: true,
      alive: true,
      health: 100,
      armor: 100,
      weapon: 'AK-47',
      icon: 'ak47',
      bomb: true,
      flashed: false,
    });
    const [later] = playerRows(pack(), 0, 108);
    expect(later).toMatchObject({
      health: 73,
      armor: 90,
      weapon: 'Knife',
      // A T's knife is drawn as the T knife.
      icon: 'knife_t',
      flashed: true,
      bomb: false,
    });
  });

  it('marks the dead with no health, armor or weapon', () => {
    const [alpha] = playerRows(pack(), 0, 116);
    expect(alpha).toMatchObject({
      alive: false,
      health: 0,
      armor: 0,
      weapon: '',
      flashed: false,
      bomb: false,
    });
  });

  it('keeps a player who is not in the round out of it', () => {
    const bench = playerRows(pack(), 0, 108)[2];
    expect(bench).toMatchObject({ team: 0, inRound: false, alive: false });
  });

  it('reads the defusing flag', () => {
    expect(playerRows(pack(), 0, 108)[1].defusing).toBe(true);
  });

  it('gives empty rows for a round index the pack does not have', () => {
    const rows = playerRows(pack(), 5, 100);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.alive && !r.inRound)).toBe(true);
  });
});

describe('sortRows', () => {
  it('lists CT, then T, then players not in the round, each in header order', () => {
    const rows = playerRows(pack(), 0, 100);
    expect(sortRows(rows).map((r) => r.name)).toEqual([
      'bravo',
      'alpha',
      'bench',
    ]);
  });
});

describe('followKey', () => {
  it('maps players 1..10 to the keys 1..9, 0 and nothing past ten', () => {
    expect(followKey(0)).toBe('1');
    expect(followKey(8)).toBe('9');
    expect(followKey(9)).toBe('0');
    expect(followKey(10)).toBe('');
  });
});

describe('weaponLabel', () => {
  it('names knives Knife and keeps other names', () => {
    expect(weaponLabel('knife')).toBe('Knife');
    expect(weaponLabel('knife_t')).toBe('Knife');
    expect(weaponLabel('M4A1-S')).toBe('M4A1-S');
    expect(weaponLabel('none')).toBe('');
    expect(weaponLabel(undefined)).toBe('');
  });
});
