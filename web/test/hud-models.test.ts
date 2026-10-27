import { describe, expect, it } from 'vitest';
import {
  brandModel,
  highlightRows,
  killfeedRows,
  markers,
  playerCardModel,
  reelBanner,
  roundBarModel,
  roundFeedRows,
  roundStripModel,
  SCORE_COLUMNS,
  scoreColumns,
  scoreCell,
  scoreboardRows,
  steamProfileUrl,
  WHITEOUT_MAX,
  whiteoutAlpha,
} from '../src/components/hud/models';
import { playerRows } from '../src/components/player-rows';
import {
  FLAG,
  GEAR,
  type Pack,
  type PackEvent,
  type RoundInfo,
} from '../src/pack/types';
import { highlightsOf } from '../src/sim/highlights';
import { statsThrough } from '../src/sim/stats';
import { Timeline, timelineFor } from '../src/sim/timeline';
import { sameModel } from '../src/state/derive';
import type { Reel, ReelSegment } from '../src/state/reel';
import { playbackPack } from './helpers/playback-pack';
import {
  event,
  grenadeTrack,
  trackPack,
  withSecondRound,
} from './helpers/track-pack';

const R = 64;
const START = 1000;
const FREEZE = START + 10 * R;

/** Four players, two a side (T: 0, 1; CT: 2, 3); player 3 dies at sample 1000. */
function pack(events = [] as ReturnType<typeof event>[]): Pack {
  return trackPack({
    samples: 3000,
    freeze: 10 * R,
    teams: [2, 2, 3, 3],
    players: [
      () => ({ x: 0, y: 0 }),
      () => ({ x: 100, y: 0 }),
      () => ({ x: 500, y: 500 }),
      (k) => ({
        x: 600,
        y: 500,
        flags: k < 1000 ? FLAG.alive : 0,
        health: k < 1000 ? 100 : 0,
      }),
    ],
    events,
    grenades: [
      {
        ...grenadeTrack({
          kind: 'smoke',
          thrower: 0,
          start_tick: 2000,
          from: [0, 0, 0],
          to: [10, 0, 0],
        }),
        detonate_tick: 2050,
      },
      {
        ...grenadeTrack({
          kind: 'molotov',
          thrower: 1,
          start_tick: 2100,
          from: [0, 0, 0],
          to: [10, 0, 0],
          entity_id: 2,
        }),
        detonate_tick: 2140,
      },
    ],
  });
}

const death = (tick: number, victim: number, attacker: number, extra = {}) =>
  event('player_death', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    weapon: 'ak47',
    ...extra,
  });

describe('killfeedRows', () => {
  const kills = [
    death(3000, 3, 0, {
      headshot: true,
      penetrated: 1,
      thrusmoke: true,
      assister_idx: 1,
      assistedflash: true,
    }),
    ...[3100, 3200, 3300, 3400, 3500, 3600].map((t) => death(t, 2, 1)),
  ];
  const tl = new Timeline(pack(kills));

  it('shows a kill for 8 s while playing, with names, teams, weapon and badges', () => {
    const rows = killfeedRows(tl, 0, 3000 + 7 * R, true);
    const first = rows.find((r) => r.tick === 3000)!;
    expect(first).toMatchObject({
      attacker: { name: tl.pack.header.players[0].name, team: 2 },
      victim: { name: tl.pack.header.players[3].name, team: 3 },
      assister: { name: tl.pack.header.players[1].name, team: 2 },
      weapon: 'ak47',
    });
    expect(first.badges).toEqual(['wallbang', 'smoke', 'headshot', 'flash']);
    expect(
      killfeedRows(tl, 0, 3000 + 9 * R, true).some((r) => r.tick === 3000)
    ).toBe(false);
  });

  it('keeps the five newest, oldest first, and when paused ignores their age', () => {
    expect(killfeedRows(tl, 0, 3700, true).map((r) => r.tick)).toEqual([
      3200, 3300, 3400, 3500, 3600,
    ]);
    expect(killfeedRows(tl, 0, 3600 + 60 * R, true)).toEqual([]);
    expect(
      killfeedRows(tl, 0, 3600 + 60 * R, false).map((r) => r.tick)
    ).toEqual([3200, 3300, 3400, 3500, 3600]);
    expect(killfeedRows(tl, 0, 2999, false)).toEqual([]);
  });

  it('keeps as many as the layout has rows for', () => {
    expect(killfeedRows(tl, 0, 3700, true, 3).map((r) => r.tick)).toEqual([
      3400, 3500, 3600,
    ]);
  });

  it("keeps a row's key while the feed scrolls past it, so React does not remount it", () => {
    // A sixth kill pushes the oldest out: the four that stay keep their keys.
    const before = killfeedRows(tl, 0, 3550, true);
    const after = killfeedRows(tl, 0, 3650, true);
    expect(before.map((r) => r.tick)).toEqual([3100, 3200, 3300, 3400, 3500]);
    expect(after.map((r) => r.tick)).toEqual([3200, 3300, 3400, 3500, 3600]);
    const keyAt = (rows: typeof before, t: number) =>
      rows.find((r) => r.tick === t)!.key;
    for (const t of [3200, 3300, 3400, 3500])
      expect(keyAt(after, t)).toBe(keyAt(before, t));
    // The oldest ages out of the 8 s window while playing: the rest keep theirs.
    const aged = killfeedRows(tl, 0, 3000 + 8 * R + 50, true);
    expect(aged[0].tick).toBe(3100);
    expect(keyAt(aged, 3100)).toBe(
      keyAt(killfeedRows(tl, 0, 3150, true), 3100)
    );
    // Fewer rows (the narrow layout) give the same kill the same key.
    expect(keyAt(killfeedRows(tl, 0, 3650, true, 3), 3600)).toBe(
      keyAt(after, 3600)
    );
  });

  it('gives kills on one tick, and one victim in two rounds, different keys', () => {
    // Two kills on one tick by different killers; the next round, the same victim again.
    const two = withSecondRound(
      pack([death(3000, 2, 0), death(3000, 3, 1), death(9998, 2, 0)])
    );
    const t = new Timeline(two);
    const r0 = killfeedRows(t, 0, 3001, false);
    const r1 = killfeedRows(t, 1, 9999, false);
    expect(r0.map((r) => r.victimIndex)).toEqual([2, 3]);
    expect(r1.map((r) => r.victimIndex)).toEqual([2]);
    const keys = [...r0, ...r1].map((r) => r.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('shows the world as no attacker', () => {
    const t = new Timeline(
      pack([
        event('player_death', 3000, {
          user_idx: 3,
          attacker_idx: null,
          weapon: 'world',
        }),
      ])
    );
    expect(killfeedRows(t, 0, 3001, true)[0].attacker).toBeNull();
  });
});

describe('roundBarModel', () => {
  it('counts down the freeze, then the round, with each side alive', () => {
    const tl = new Timeline(pack());
    const freeze = roundBarModel(tl.pack, tl, 0, START + 2 * R);
    expect(freeze.timer).toEqual({ phase: 'freeze', text: '0:08' });
    const live = roundBarModel(tl.pack, tl, 0, FREEZE + 10 * R);
    expect(live.timer).toEqual({ phase: 'live', text: '1:45' });
    expect(live.t.alive).toEqual([true, true]);
    expect(live.ct.alive).toEqual([true, true]);
    const later = roundBarModel(tl.pack, tl, 0, START + 1000 * 2 + 4);
    expect(later.ct.alive).toEqual([true, false]);
    expect(live.round).toBe(1);
    expect(live.half).toBe('1st half');
  });

  it('shows the bomb timer after a plant', () => {
    const tl = new Timeline(
      pack([event('bomb_planted', 3000, { user_idx: 0, site: 1 })])
    );
    expect(roundBarModel(tl.pack, tl, 0, 3000 + 5 * R).timer).toEqual({
      phase: 'planted',
      text: '0:35',
    });
  });

  it("keeps each side's score with the team on it, across halftime", () => {
    const p = pack();
    const base = p.header.rounds[0];
    const rounds: RoundInfo[] = [];
    // CT wins the first 12, then the teams swap and the T side (the old CT) wins round 13.
    for (let i = 0; i < 13; i++)
      rounds.push({
        ...base,
        number: i + 1,
        winner: i < 12 ? 3 : 2,
        score_t: i < 12 ? 0 : 13,
        score_ct: i < 12 ? i + 1 : 0,
      });
    p.header.rounds = rounds;
    p.rounds = rounds.map(() => p.rounds[0]);
    for (const [i, pl] of p.header.players.entries())
      pl.team_by_round = rounds.map((_, r) =>
        r < 12 ? (i < 2 ? 2 : 3) : i < 2 ? 3 : 2
      );
    const tl = new Timeline(p);
    const before = roundBarModel(p, tl, 11, base.start_tick + 10);
    expect(before.ct.score).toBe(11);
    expect(before.t.score).toBe(0);
    const after = roundBarModel(p, tl, 12, base.start_tick + 10);
    expect(after.t.score).toBe(12);
    expect(after.ct.score).toBe(0);
    expect(after.half).toBe('2nd half');
    // Decided: the round's own score.
    expect(roundBarModel(p, tl, 12, base.end_tick).t.score).toBe(13);
  });
});

describe('roundStripModel', () => {
  it('has a cell per round with its winner, a reason glyph, the current one and the half', () => {
    const p = pack();
    const base = p.header.rounds[0];
    const reasons = [
      't_killed',
      'bomb_exploded',
      'bomb_defused',
      'time_ran_out',
      'ct_killed',
    ];
    p.header.rounds = Array.from({ length: 14 }, (_, i) => ({
      ...base,
      number: i + 1,
      winner: i % 2 ? 2 : 3,
      reason: reasons[i % 5],
    }));
    const cells = roundStripModel(p, 3);
    expect(cells).toHaveLength(14);
    expect(cells.map((c) => c.glyph).slice(0, 5)).toEqual([
      'elim',
      'bomb',
      'defuse',
      'time',
      'elim',
    ]);
    expect(cells[3].current).toBe(true);
    expect(cells.filter((c) => c.current)).toHaveLength(1);
    expect(cells[12].halfStart).toBe(true);
    expect(cells.filter((c) => c.halfStart)).toHaveLength(1);
    expect(cells[1].winner).toBe(2);
  });
});

describe('markers', () => {
  it('marks every kill in the killer’s colour, the followed player’s death, plants, defuses and grenades', () => {
    const tl = new Timeline(
      pack([
        death(3000, 3, 0),
        death(3100, 2, 1),
        event('bomb_planted', 3500, { user_idx: 0, site: 1 }),
        event('bomb_defused', 4000, { user_idx: 2, site: 1 }),
      ])
    );
    const m = markers(tl, 0, 3);
    expect(m.filter((x) => x.kind === 'kill')).toEqual([
      { kind: 'kill', tick: 3100, team: 2 },
    ]);
    expect(m.filter((x) => x.kind === 'death')).toEqual([
      { kind: 'death', tick: 3000, team: 2 },
    ]);
    expect(m.find((x) => x.kind === 'plant')?.tick).toBe(3500);
    expect(m.find((x) => x.kind === 'defuse')?.tick).toBe(4000);
    expect(m.find((x) => x.kind === 'smoke')?.tick).toBe(2050);
    expect(m.find((x) => x.kind === 'fire')?.tick).toBe(2140);
    expect(m.map((x) => x.tick)).toEqual(
      [...m.map((x) => x.tick)].sort((a, b) => a - b)
    );
  });
});

describe('scoreboard equipment', () => {
  it('shows each player their money, best gun and grenades from the inventory', () => {
    const p = trackPack({
      samples: 50,
      teams: [2, 3],
      weapons: ['none', 'Glock-18', 'AK-47', 'Flashbang', 'knife_t', 'USP-S'],
      players: [() => ({}), () => ({})],
    });
    p.rounds[0].players[0].money = new Uint16Array(50).fill(2350);
    p.rounds[0].players[1].money = new Uint16Array(50).fill(800);
    p.inventory = [
      { round: 0, player: 0, tick: 1000, items: [4, 1, 2, 3] },
      { round: 0, player: 1, tick: 1000, items: [5] },
    ];
    const tl = new Timeline(p);
    const [ct, t] = scoreboardRows([], p, tl, 0, 1010);
    expect(t.rows[0]).toMatchObject({
      money: 2350,
      gun: 'ak47',
      grenades: ['flashbang'],
    });
    expect(ct.rows[0]).toMatchObject({ money: 800, gun: 'usp', grenades: [] });
  });
});

describe('scoreboardRows', () => {
  it('lists each team, CT first, by kills, with the stats and the score', () => {
    const p = pack([death(3000, 3, 0, { headshot: true }), death(3100, 2, 0)]);
    const tl = new Timeline(p);
    const tick = 3200;
    const stats = statsThrough(p, 0, tick);
    const teams = scoreboardRows(stats, p, tl, 0, tick);
    expect(teams.map((t) => t.team)).toEqual([3, 2]);
    const t = teams[1];
    expect(t.rows[0]).toMatchObject({
      index: 0,
      kills: 2,
      deaths: 0,
      diff: 2,
      hsPct: 50,
    });
    expect(t.rows[0].adr).toBe(stats[0].adr);
    expect(teams[0].rows.map((r) => r.deaths)).toEqual([1, 1]);
  });

  it('carries KAST, utility damage, flash assists and the rating', () => {
    const p = pack([
      event('player_hurt', 2900, {
        user_idx: 3,
        attacker_idx: 1,
        dmg_health: 40,
        health: 60,
        weapon: 'hegrenade',
      }),
      death(3000, 3, 0, { assister_idx: 1, assistedflash: true }),
    ]);
    const tl = new Timeline(p);
    const end = p.header.rounds[0].end_tick;
    const stats = statsThrough(p, 0, end);
    const [, t] = scoreboardRows(stats, p, tl, 0, end);
    for (const row of t.rows) {
      const s = stats[row.index];
      expect(row).toMatchObject({
        kast: s.kast,
        utilityDamage: s.utilityDamage,
        flashAssists: s.flashAssists,
        rating: s.rating,
      });
    }
    expect(t.rows.find((r) => r.index === 1)).toMatchObject({
      kast: 100,
      utilityDamage: 40,
      flashAssists: 1,
    });
    expect(t.rows[0].rating).toBeGreaterThan(0);
  });

  it('reads – for KAST and Rating until a round is decided, then the values', () => {
    const p = pack([death(3000, 3, 0, { headshot: true })]);
    const tl = new Timeline(p);
    const end = p.header.rounds[0].end_tick;
    const row = (tick: number) =>
      scoreboardRows(statsThrough(p, 0, tick), p, tl, 0, tick)[1].rows.find(
        (r) => r.index === 0
      )!;
    const before = row(end - 2);
    expect(before).toMatchObject({ kills: 1, kast: null, rating: null });
    expect(scoreCell(before, 'KAST')).toBe('–');
    expect(scoreCell(before, 'Rating')).toBe('–');
    expect(scoreCell(before, 'K')).toBe('1');
    expect(scoreCell(before, 'HS%')).toBe('100%');
    const after = row(end);
    const stats = statsThrough(p, 0, end)[0];
    expect(after).toMatchObject({ kast: 100, rating: stats.rating });
    expect(stats.rating).toBeGreaterThan(0);
    expect(scoreCell(after, 'KAST')).toBe('100%');
    expect(scoreCell(after, 'Rating')).toBe(stats.rating.toFixed(2));
    // Without stats at all, the same.
    const bare = scoreboardRows([], p, tl, 0, end)[1].rows[0];
    expect(scoreCell(bare, 'KAST')).toBe('–');
    expect(scoreCell(bare, 'Rating')).toBe('–');
  });

  it('formats the other cells as the scoreboard always has', () => {
    const p = pack();
    const [, t] = scoreboardRows([], p, new Timeline(p), 0, 1010);
    const r = {
      ...t.rows[0],
      kills: 3,
      deaths: 5,
      diff: -2,
      adr: 71.6,
      hsPct: 33.4,
      utilityDamage: 42,
      flashAssists: 1,
    };
    expect(SCORE_COLUMNS.map((c) => scoreCell(r, c))).toEqual([
      '3',
      '0',
      '5',
      '−2',
      '72',
      '–',
      '33%',
      '42',
      '1',
      '–',
    ]);
    expect(scoreCell({ ...r, diff: 4 }, '+/−')).toBe('+4');
    expect(scoreCell({ ...r, diff: 0 }, '+/−')).toBe('0');
  });

  it('has its columns in one order', () => {
    expect(SCORE_COLUMNS).toEqual([
      'K',
      'A',
      'D',
      '+/−',
      'ADR',
      'KAST',
      'HS%',
      'UD',
      'FA',
      'Rating',
    ]);
  });

  it('narrows to kills, deaths, ADR and rating, in the same order', () => {
    expect(scoreColumns('compact')).toEqual(['K', 'D', 'ADR', 'Rating']);
    expect(scoreColumns('all')).toEqual(SCORE_COLUMNS);
  });

  it("links each player's Steam profile, but not a bot's", () => {
    const p = pack();
    p.header.players[1].steamid = '0';
    const [, t] = scoreboardRows([], p, new Timeline(p), 0, 1010);
    expect(t.rows.map((r) => [r.index, r.profile])).toEqual([
      [0, 'https://steamcommunity.com/profiles/76561198000000000'],
      [1, null],
    ]);
  });
});

describe('steamProfileUrl', () => {
  it('is the profile of a SteamID64 and nothing else', () => {
    // The first and last account numbers, and a newer account's 7656120… id.
    for (const id of [
      '76561197960265729',
      '76561200000000001',
      '76561202255233023',
    ])
      expect(steamProfileUrl(id), id).toBe(
        `https://steamcommunity.com/profiles/${id}`
      );
    for (const id of [
      '0',
      '',
      'BOT',
      '7656119800000000',
      '765611980000000000',
      '86561198000000000',
      '76561198000000000/../x',
      '76561197960265728',
      '76561202255233024',
    ])
      expect(steamProfileUrl(id), id).toBeNull();
  });
});

describe('playerCardModel', () => {
  it('reads the followed player at the tick: health, armour, weapon, magazine, money, grenades, tags', () => {
    const p = trackPack({
      samples: 100,
      teams: [2, 3],
      weapons: [
        'none',
        'AK-47',
        'Smoke Grenade',
        'High Explosive Grenade',
        'knife_t',
      ],
      players: [
        () => ({
          health: 76,
          armor: 98,
          weapon: 1,
          flags: FLAG.alive | FLAG.bomb | FLAG.flashed,
        }),
        () => ({}),
      ],
    });
    const track = p.rounds[0].players[0];
    track.money = new Uint16Array(100).fill(4750);
    track.ammo = new Uint8Array(100).fill(28);
    track.gear = new Uint8Array(100).fill(GEAR.helmet);
    p.rounds[0].players[1].money = new Uint16Array(100);
    p.inventory = [{ round: 0, player: 0, tick: 1000, items: [4, 1, 2, 3] }];
    const card = playerCardModel(p, 0, 1010, 0, statsThrough(p, 0, 1010))!;
    expect(card).toMatchObject({
      name: p.header.players[0].name,
      team: 2,
      health: 76,
      armor: 98,
      helmet: true,
      kit: false,
      weapon: { label: 'AK-47', icon: 'ak47' },
      ammo: 28,
      money: 4750,
      grenades: ['smokegrenade', 'hegrenade'],
      kills: 0,
      deaths: 0,
    });
    expect(card.tags).toEqual(['Bomb', 'Flashed']);
  });

  it('shows no magazine for a knife, which the game reports as 0', () => {
    const p = trackPack({
      samples: 50,
      teams: [2, 3],
      weapons: ['none', 'knife_t'],
      players: [() => ({ weapon: 1 }), () => ({})],
    });
    p.rounds[0].players[0].ammo = new Uint8Array(50);
    p.rounds[0].players[0].money = new Uint16Array(50).fill(800);
    expect(playerCardModel(p, 0, 1010, 0, [])!.ammo).toBeNull();
  });

  it('leaves money and the magazine out when the pack has none', () => {
    const p = trackPack({
      samples: 50,
      teams: [2, 3],
      players: [() => ({}), () => ({})],
    });
    const shared = new Uint16Array(50);
    p.rounds[0].players.forEach((t) => (t.money = shared));
    const card = playerCardModel(p, 0, 1010, 0, [])!;
    expect(card.money).toBeNull();
    expect(card.ammo).toBeNull();
    expect(playerCardModel(p, 0, 1010, 7, [])).toBeNull();
  });
});

describe('roundFeedRows', () => {
  it('lists the last four events, oldest first, within 12 s while playing', () => {
    const tl = new Timeline(
      pack(
        [1, 2, 3, 4, 5].map((i) =>
          death(2000 + i * 100, i % 2 ? 2 : 3, i % 2 ? 0 : 1)
        )
      )
    );
    const rows = roundFeedRows(tl, 0, 2600, true);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.tick)).toEqual(
      [...rows.map((r) => r.tick)].sort((a, b) => a - b)
    );
    expect(roundFeedRows(tl, 0, 2600 + 20 * R, true)).toEqual([]);
    expect(roundFeedRows(tl, 0, 2600 + 20 * R, false)).toHaveLength(4);
  });

  it("keeps a row's key while the feed scrolls past it, and keys every row apart", () => {
    // Two events on one tick (two kills), then more: the feed shifts by one each time.
    const tl = new Timeline(
      pack([
        death(2500, 2, 0),
        death(2500, 3, 1),
        ...[2600, 2700, 2800].map((t) => death(t, 0, 2)),
      ])
    );
    const before = roundFeedRows(tl, 0, 2750, true);
    const after = roundFeedRows(tl, 0, 2850, true);
    expect(before).toHaveLength(4);
    expect(after).toHaveLength(4);
    // The rows the two share are the same events, with the same keys.
    const shared = after.slice(0, 3);
    expect(shared.map((r) => r.key)).toEqual(before.slice(1).map((r) => r.key));
    // Five events between them (the two on one tick among them): five keys.
    const keys = [...before, ...after].map((r) => r.key);
    expect(new Set(keys).size).toBe(5);
  });
});

describe('brandModel', () => {
  it('names the map and where it was played', () => {
    expect(
      brandModel({
        map: 'de_mirage',
        server_name:
          'Valve Counter-Strike 2 eu_north Server (srcds7026-sto1.187.126)',
      })
    ).toEqual({
      map: 'Mirage',
      place: 'Valve matchmaking, eu_north',
    });
    expect(brandModel({ map: 'cs_office', server_name: 'My server' })).toEqual({
      map: 'Office',
      place: 'My server',
    });
  });
});

describe('whiteoutAlpha', () => {
  const tl = new Timeline(
    pack([
      event('player_blind', 2000, {
        user_idx: 1,
        attacker_idx: 2,
        blind_duration: 2,
      }),
    ])
  );
  it('whitens the view of the followed player while they are blind, in POV', () => {
    // Never fully white: the scene stays faintly visible through the flash.
    expect(WHITEOUT_MAX).toBeLessThan(1);
    expect(WHITEOUT_MAX).toBeGreaterThanOrEqual(0.8);
    expect(whiteoutAlpha(tl, 0, 2010, 1, 'pov')).toBe(WHITEOUT_MAX);
    expect(whiteoutAlpha(tl, 0, 2000 + 1.4 * R, 1, 'pov')).toBeCloseTo(
      0.5 * WHITEOUT_MAX,
      6
    );
    expect(whiteoutAlpha(tl, 0, 2000 + 2 * R, 1, 'pov')).toBe(0);
  });
  it('leaves the view alone for anyone else, nobody, or the free camera', () => {
    expect(whiteoutAlpha(tl, 0, 2010, 0, 'pov')).toBe(0);
    expect(whiteoutAlpha(tl, 0, 2010, null, 'pov')).toBe(0);
    expect(whiteoutAlpha(tl, 0, 2010, 1, 'free')).toBe(0);
  });
});

describe('no per-frame values', () => {
  // Player 3 dies at 3000 (sample 1000); the second after it has no event, while the kill is
  // still in the killfeed and the round feed. A frame's tick is fractional.
  const p = pack([death(3000, 3, 0)]);
  const tl = new Timeline(p);
  const ticks: number[] = [];
  for (let t = 3100; t < 3100 + R; t += 0.25) ticks.push(t);

  /** How many different models `model` gives over the second, by `sameModel`. */
  function distinct(model: (tick: number) => unknown): number {
    const seen: unknown[] = [];
    for (const t of ticks) {
      const m = model(t);
      if (!seen.some((x) => sameModel(x, m))) seen.push(m);
    }
    return seen.length;
  }

  it('the round bar changes at most once in a quiet second, with its clock', () => {
    expect(distinct((t) => roundBarModel(p, tl, 0, t))).toBeLessThanOrEqual(2);
  });

  it('the killfeed, the round feed, the player card and the player list do not change', () => {
    expect(killfeedRows(tl, 0, 3100, true)).toHaveLength(1);
    expect(roundFeedRows(tl, 0, 3100, true)).not.toEqual([]);
    expect(distinct((t) => killfeedRows(tl, 0, t, true))).toBe(1);
    expect(distinct((t) => roundFeedRows(tl, 0, t, true))).toBe(1);
    expect(
      distinct((t) => playerCardModel(p, 0, t, 0, statsThrough(p, 0, t)))
    ).toBe(1);
    expect(distinct((t) => playerRows(p, 0, t))).toBe(1);
  });
});

describe('highlightRows', () => {
  // Task 5's pack: rounds of ten players at 64 tick, 0–4 T and 5–9 CT. Round 1 has only an
  // opening kill; round 2 an opening kill and then a 3k by player index 1; round 3 an opening
  // wallbang by player index 9.
  const kill = (
    tick: number,
    victim: number,
    attacker: number,
    penetrated = 0
  ): PackEvent =>
    event('player_death', tick, {
      user_idx: victim,
      attacker_idx: attacker,
      assister_idx: null,
      weapon: 'ak47',
      headshot: false,
      noscope: false,
      penetrated,
    });
  const p = playbackPack({
    rounds: [0, 1, 2].map((r) => ({
      start: 1000 + 20000 * r,
      freeze: 2000 + 20000 * r,
      end: 10000 + 20000 * r,
      post: 10500 + 20000 * r,
    })),
    events: [
      kill(3000, 5, 0),
      kill(22000, 6, 1),
      kill(22500, 7, 1),
      kill(24000, 8, 1),
      kill(43000, 2, 9, 1),
    ],
  });
  const all = highlightsOf(p);

  it('hides the opening-only rows unless asked for them, leaving out rounds with none', () => {
    const groups = highlightRows(p, false);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[0].rows).toMatchObject([
      {
        label: '3k',
        player: { name: 'player2', team: 2 },
        reel: true,
      },
    ]);
    expect(groups[1].rows).toMatchObject([
      {
        label: 'Wallbang · Opening kill',
        player: { name: 'player10', team: 3 },
        reel: true,
      },
    ]);

    const withOpenings = highlightRows(p, true);
    expect(withOpenings.map((g) => g.round)).toEqual([0, 1, 2]);
    expect(withOpenings[0].rows).toMatchObject([
      { label: 'Opening kill', player: { name: 'player1' }, reel: false },
    ]);
    expect(withOpenings[1].rows.map((r) => r.label)).toEqual([
      'Opening kill',
      '3k',
    ]);
  });

  it("indexes each row into highlightsOf, with a unique key and the round bar's clock at its tick, before the round's end", () => {
    const rows = highlightRows(p, true).flatMap((g) => g.rows);
    expect(rows.map((r) => r.index)).toEqual(all.map((_, i) => i));
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    const tl = timelineFor(p);
    for (const r of rows) {
      const h = all[r.index];
      const at = Math.min(h.tick, p.header.rounds[h.round].end_tick - 1);
      expect(r.clock).toBe(roundBarModel(p, tl, h.round, at).timer.text);
    }
    // The 3k's last kill is 31.25 s into round 2's 1:55: 1:24 left, rounded up.
    expect(rows.find((r) => r.label === '3k')?.clock).toBe('1:24');
  });

  it("reads a highlight on the round's end tick at the round's last live tick, not 0:00", () => {
    // A 3k whose last kill wins the round on end_tick (6000), 62.5 s after the freeze end.
    const won = playbackPack({
      rounds: [{ start: 1000, freeze: 2000, end: 6000, post: 6500 }],
      events: [kill(3000, 5, 0), kill(3500, 6, 0), kill(6000, 7, 0)],
    });
    const h = highlightsOf(won).find((x) => x.kinds[0] === '3k');
    expect(h?.tick).toBe(6000);
    const tl = timelineFor(won);
    expect(roundBarModel(won, tl, 0, 6000).timer.text).toBe('0:00');
    const row = highlightRows(won, false)[0].rows.find((r) => r.label === '3k');
    // At 5999: 62.48 s of 1:55 gone, 52.52 s left, rounded up.
    expect(row?.clock).toBe('0:53');
    expect(row?.clock).toBe(roundBarModel(won, tl, 0, 5999).timer.text);
  });

  it('gives the groups in round order', () => {
    for (const on of [false, true]) {
      const rounds = highlightRows(p, on).map((g) => g.round);
      expect(rounds).toEqual([...rounds].sort((a, b) => a - b));
      expect(new Set(rounds).size).toBe(rounds.length);
    }
  });

  it('is empty for a match without highlights', () => {
    expect(
      highlightRows(playbackPack({ rounds: [{ start: 0, end: 100 }] }), true)
    ).toEqual([]);
  });
});

describe('reelBanner', () => {
  const p = playbackPack({ rounds: [{ start: 1000, end: 10000 }] });
  const seg = (follow: number, title: string): ReelSegment => ({
    round: 0,
    from: 2000,
    to: 3000,
    follow,
    title,
  });
  const reel = (
    kind: Reel['kind'],
    segments: ReelSegment[],
    index: number
  ): Reel => ({
    kind,
    segments,
    index,
    resume: {
      round: 0,
      tick: 5000,
      camera: 'pov',
      follow: 0,
      followPinned: false,
      director: false,
      playing: true,
      speed: 1,
    },
    atEnd: kind === 'killcam' ? 'resume' : 'continue',
  });
  const seven = Array.from({ length: 7 }, (_, i) => seg(i, '3k'));

  it('shows a kill cam by its title alone, with no position and no next', () => {
    expect(
      reelBanner(
        reel('killcam', [seg(0, 'Kill cam · player1 killed player6')], 0),
        p
      )
    ).toEqual({
      title: 'Kill cam · player1 killed player6',
      position: '',
      canNext: false,
    });
  });

  it("names a highlight's player before its kinds, with its place in the reel", () => {
    expect(reelBanner(reel('highlights', seven, 1), p)).toEqual({
      title: 'player2 · 3k',
      position: '2 / 7',
      canNext: true,
    });
  });

  it("names the highlight's player when the camera is on someone else", () => {
    // A kill made after the player's death plays in POV on its victim.
    const after: ReelSegment = { ...seg(6, '3k'), player: 1 };
    expect(reelBanner(reel('highlights', [after], 0), p).title).toBe(
      'player2 · 3k'
    );
  });

  it('has no next on the last segment', () => {
    expect(reelBanner(reel('highlights', seven, 6), p)).toEqual({
      title: 'player7 · 3k',
      position: '7 / 7',
      canNext: false,
    });
  });
});
