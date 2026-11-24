import { describe, expect, it } from 'vitest';
import type { Pack, PackEvent, RoundInfo } from '../src/pack/types';
import { rating, type RatingLine } from '../src/sim/rating';
import {
  clearStatsCache,
  roundRecord,
  STATS,
  statsThrough,
  type PlayerRound,
} from '../src/sim/stats';
import { cpuTimed } from './helpers/cpu-time';
import { MATCHES } from './helpers/match-packs';
import { event, trackPack } from './helpers/track-pack';

// Two rounds of 200 samples: round 0 is 1000..1398, round 1 is 2000..2398. Players 0 and 3 are
// T, 1 and 2 are CT, in both rounds.
function twoRounds(events: PackEvent[]): Pack {
  const p = trackPack({
    players: [() => ({}), () => ({}), () => ({}), () => ({})],
    teams: [2, 3, 3, 2],
    events,
  });
  const r0 = p.header.rounds[0];
  p.header.rounds.push({
    ...r0,
    number: 2,
    start_tick: 2000,
    freeze_end_tick: 2000,
    end_tick: 2398,
    post_end_tick: 2398,
  });
  p.rounds.push({ players: p.rounds[0].players });
  for (const pl of p.header.players) pl.team_by_round.push(pl.team_by_round[0]);
  return p;
}

const hurt = (
  tick: number,
  victim: number,
  attacker: number | null,
  dmg: number,
  health: number,
  weapon = 'ak47'
) =>
  event('player_hurt', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    dmg_health: dmg,
    health,
    hitgroup: 'chest',
    weapon,
  });
const death = (
  tick: number,
  victim: number,
  attacker: number | null,
  extra: Record<string, unknown> = {}
) =>
  event('player_death', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    weapon: 'ak47',
    headshot: false,
    ...extra,
  });

describe('statsThrough', () => {
  const p = twoRounds([
    hurt(1100, 1, 0, 30, 70),
    hurt(1150, 0, 2, 40, 60),
    hurt(1200, 1, 0, 119, 0), // overkill: only the 70 left counts
    death(1200, 1, 0, { headshot: true, assister_idx: 3 }),
    hurt(1250, 2, 1, 50, 50), // team damage: not counted, but it lowers 2's health
    hurt(1300, 2, 3, 90, 0), // 50 left
    death(1300, 2, 3, { assister_idx: 0 }),
    hurt(2100, 0, 1, 100, 0),
    death(2100, 0, 1),
    death(2200, 3, 3, { weapon: 'hegrenade' }), // suicide
    death(2300, 1, 2), // team kill
  ]);

  it('counts kills, deaths, assists and capped damage over the match', () => {
    const s = statsThrough(p, 1, 2398);
    expect(s[0]).toMatchObject({
      kills: 1,
      deaths: 1,
      assists: 1,
      damage: 100,
      headshots: 1,
      hsPct: 100,
      adr: 50,
    });
    expect(s[1]).toMatchObject({
      kills: 1,
      deaths: 2,
      assists: 0,
      damage: 100,
      adr: 50,
    });
    expect(s[2]).toMatchObject({
      kills: 0,
      deaths: 1,
      assists: 0,
      damage: 40,
      adr: 20,
    });
    expect(s[3]).toMatchObject({
      kills: 1,
      deaths: 1,
      assists: 1,
      damage: 50,
      hsPct: 0,
      adr: 25,
    });
  });

  it('stops at the tick within the round, and counts that round as played', () => {
    const s = statsThrough(p, 0, 1150);
    expect(s[0]).toMatchObject({ kills: 0, damage: 30, adr: 30 });
    expect(s[2]).toMatchObject({ damage: 40 });
    expect(s[1].deaths).toBe(0);
    const r1 = statsThrough(p, 1, 2000);
    expect(r1[0]).toMatchObject({ kills: 1, damage: 100, adr: 50 });
  });

  it('keeps each whole round once, so a second call returns the same record', () => {
    expect(roundRecord(p, 0)).toBe(roundRecord(p, 0));
    expect(roundRecord(p, 0, 1150)).not.toBe(roundRecord(p, 0, 1150));
    expect(roundRecord(p, 0).players.map((x) => x.played)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  it('freezes a kept round, so a reader cannot change it for the next', () => {
    const rec = roundRecord(p, 0);
    expect(Object.isFrozen(rec)).toBe(true);
    expect(Object.isFrozen(rec.players)).toBe(true);
    expect(rec.players.every((x) => Object.isFrozen(x))).toBe(true);
  });

  it('counts KAST over the decided rounds the player was on a side for', () => {
    // Player 0: a kill in round 1; in round 2 killed by 1 at 2100, untraded, nothing else.
    const end = statsThrough(p, 1, 2398)[0];
    expect(end).toMatchObject({ rounds: 2, kast: 50 });
    expect(roundRecord(p, 0).players[0]).toMatchObject({
      survived: true,
      traded: false,
      kast: true,
    });
    expect(roundRecord(p, 1).players[0]).toMatchObject({
      survived: false,
      traded: false,
      kast: false,
    });
    // Inside round 2, before its end_tick: only round 1 is decided.
    expect(statsThrough(p, 1, 2200)[0]).toMatchObject({ rounds: 1, kast: 100 });
    // Inside round 1, nothing is decided.
    expect(statsThrough(p, 0, 1150)[0]).toMatchObject({
      rounds: 0,
      kast: 0,
      rating: 0,
    });
  });

  it('rates the decided rounds only, as profiles do', () => {
    // Player 0 over both: 1 kill, 1 assist, 1 death, 100 damage, KAST in 1 round, the opening
    // duel won in round 1 and lost in round 2.
    const line: RatingLine = {
      rounds: 2,
      kills: 1,
      deaths: 1,
      assists: 1,
      damage: 100,
      kastRounds: 1,
      multiKills: [0, 0, 0, 0],
      openingWins: 1,
      openingLosses: 1,
    };
    expect(statsThrough(p, 1, 2398)[0].rating).toBeCloseTo(rating(line)!, 10);
    // Inside round 2, its death and its lost duel are not rated yet.
    expect(statsThrough(p, 1, 2200)[0].rating).toBeCloseTo(
      rating({
        ...line,
        rounds: 1,
        deaths: 0,
        kastRounds: 1,
        openingLosses: 0,
      })!,
      10
    );
  });

  it('marks the opening duel of each round', () => {
    // Round 1: 0 kills 1 first. Round 2: 1 kills 0 first; the suicide and the team kill after
    // are not duels.
    const flags = (r: number) =>
      roundRecord(p, r).players.map((x) => [x.openingWin, x.openingLoss]);
    expect(flags(0)).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(flags(1)).toEqual([
      [false, true],
      [true, false],
      [false, false],
      [false, false],
    ]);
  });

  it('counts a round of two or more kills towards multi-kills', () => {
    // Player 0 (T) kills both CTs in round 1: one 2k, rated as the server rates it.
    const q = twoRounds([death(1100, 1, 0), death(1200, 2, 0)]);
    const s = statsThrough(q, 0, 1398)[0];
    expect(s.rating).toBeCloseTo(
      rating({
        rounds: 1,
        kills: 2,
        deaths: 0,
        assists: 0,
        damage: 0,
        kastRounds: 1,
        multiKills: [1, 0, 0, 0],
        openingWins: 1,
        openingLosses: 0,
      })!,
      10
    );
  });
  it('is, at every 8th tick, the sum of the whole rounds before and the current one so far', () => {
    const fields = [
      'kills',
      'deaths',
      'assists',
      'damage',
      'headshots',
      'utilityDamage',
      'flashAssists',
    ] as const satisfies readonly (keyof PlayerRound)[];
    for (const [r, info] of p.header.rounds.entries())
      for (let t = info.start_tick; t <= info.post_end_tick; t += 8) {
        const parts = [
          ...Array.from({ length: r }, (_, q) => roundRecord(p, q)),
          roundRecord(p, r, t),
        ];
        const stats = statsThrough(p, r, t);
        for (const [i, s] of stats.entries())
          for (const f of fields)
            expect(s[f], `round ${r} tick ${t} player ${i} ${f}`).toBe(
              parts.reduce((n, rec) => n + rec.players[i][f], 0)
            );
      }
  });

  it('ignores players the header does not know', () => {
    const q = twoRounds([
      death(1100, 9, 0),
      hurt(1100, 1, 7, 50, 50),
      death(1200, 1, null),
    ]);
    const s = statsThrough(q, 1, 2398);
    expect(s.map((x) => x.kills)).toEqual([0, 0, 0, 0]);
    expect(s[1].deaths).toBe(1);
    expect(s.map((x) => x.damage)).toEqual([0, 0, 0, 0]);
  });
});

for (const m of MATCHES)
  describe.skipIf(m.skip)(`statsThrough on ${m.name}`, () => {
    let loaded: Promise<Pack> | null = null;
    const match = () => (loaded ??= m.load());

    it('gives plausible end-of-match numbers', async () => {
      const pk = await match();
      const last = pk.header.rounds.length - 1;
      const s = statsThrough(pk, last, pk.header.rounds[last].end_tick);
      const kills = s.reduce((n, x) => n + x.kills, 0);
      const deaths = s.reduce((n, x) => n + x.deaths, 0);
      for (const x of s) {
        expect(x.adr).toBeGreaterThanOrEqual(0);
        expect(x.adr).toBeLessThan(250);
        expect(x.hsPct).toBeLessThanOrEqual(100);
      }
      expect(kills).toBeLessThanOrEqual(deaths);
      expect(kills).toBeGreaterThan(deaths * 0.8);
      for (const x of s) {
        expect(x.rounds).toBe(pk.header.rounds.length);
        expect(x.rating).toBeGreaterThanOrEqual(0);
        expect(x.rating).toBeLessThanOrEqual(3);
        expect(x.kast).toBeGreaterThanOrEqual(0);
        expect(x.kast).toBeLessThanOrEqual(100);
        expect(x.utilityDamage).toBeLessThanOrEqual(x.damage);
        expect(x.flashAssists).toBeLessThanOrEqual(x.assists);
      }
      console.log(
        `${m.real ? 'real' : 'synthetic'} scoreboard:\n` +
          pk.header.players
            .map(
              (pl, i) =>
                `${pl.name} | ${s[i].kills}/${s[i].assists}/${s[i].deaths} | ADR ${s[i].adr.toFixed(0)} | KAST ${s[i].kast.toFixed(0)}% | HS ${s[i].hsPct.toFixed(0)}% | UD ${s[i].utilityDamage} | FA ${s[i].flashAssists} | rating ${s[i].rating.toFixed(2)}`
            )
            .join('\n')
      );
    });

    it('gives the same numbers from a cold cache, under 0.1 ms of CPU a call, at every 64th tick of the first, middle and last rounds', async () => {
      const pk = await match();
      const last = pk.header.rounds.length - 1;
      const at: [number, number][] = [];
      for (const r of [0, Math.floor(last / 2), last]) {
        const info = pk.header.rounds[r];
        for (let t = info.start_tick; t <= info.post_end_tick; t += 64)
          at.push([r, t]);
      }
      const warm = at.map(([r, t]) => statsThrough(pk, r, t));
      const ms =
        cpuTimed(() => {
          for (const [r, t] of at) statsThrough(pk, r, t);
        }).ms / at.length;
      console.log(
        `statsThrough: ${(ms * 1000).toFixed(1)} µs a call over ${at.length} calls`
      );
      for (const [i, [r, t]] of at.entries()) {
        clearStatsCache(pk);
        expect(statsThrough(pk, r, t), `round ${r} tick ${t}`).toEqual(warm[i]);
      }
      expect(ms).toBeLessThan(0.1);
    });
  });

describe('utility damage', () => {
  it('counts grenade and fire damage to enemies, capped as damage is', () => {
    const p = twoRounds([
      hurt(1100, 1, 0, 40, 60, 'hegrenade'),
      hurt(1150, 1, 0, 60, 0, 'ak47'),
      hurt(1200, 2, 0, 30, 70, 'molotov'),
      hurt(1210, 2, 0, 90, 0, 'inferno'), // 70 left
      hurt(1250, 3, 0, 25, 75, 'inferno'), // a teammate
    ]);
    const s = statsThrough(p, 0, 1398)[0];
    expect(s.damage).toBe(200);
    expect(s.utilityDamage).toBe(140);
    expect(STATS.utilityWeapons).toEqual([
      'hegrenade',
      'inferno',
      'molotov',
      'incendiary',
    ]);
  });

  it('gives 40 of an HE for 40 then a rifle for 60, and nothing for fire on a teammate', () => {
    const he = twoRounds([
      hurt(1100, 1, 0, 40, 60, 'hegrenade'),
      hurt(1150, 1, 0, 60, 0, 'ak47'),
    ]);
    expect(statsThrough(he, 0, 1398)[0]).toMatchObject({
      damage: 100,
      utilityDamage: 40,
    });
    const fire = twoRounds([hurt(1100, 3, 0, 20, 80, 'inferno')]);
    expect(statsThrough(fire, 0, 1398)[0]).toMatchObject({
      damage: 0,
      utilityDamage: 0,
    });
  });
});

describe('flash assists', () => {
  it('gives the assister of a flash-assisted kill a flash assist and an assist', () => {
    const p = twoRounds([
      death(1200, 1, 0, { assister_idx: 3, assistedflash: true }),
      death(1300, 2, 0, { assister_idx: 3, assistedflash: false }),
    ]);
    expect(statsThrough(p, 0, 1398)[3]).toMatchObject({
      assists: 2,
      flashAssists: 1,
    });
    expect(statsThrough(p, 0, 1398)[0].flashAssists).toBe(0);
  });
});

describe('trades', () => {
  // One round, 1000..4998 at 64 ticks a second. T: 0 (A) and 3; CT: 1 (B) and 2.
  const R = 64;
  const tradeAfter = (s: number) =>
    trackPack({
      samples: 2000,
      players: [() => ({}), () => ({}), () => ({}), () => ({})],
      teams: [2, 3, 3, 2],
      events: [death(3000, 0, 1), death(3000 + s * R, 1, 3)],
    });

  it(`trades a death when a teammate kills the killer within ${STATS.tradeS} s`, () => {
    const four = roundRecord(tradeAfter(4), 0).players[0];
    expect(four).toMatchObject({ survived: false, traded: true, kast: true });
    const six = roundRecord(tradeAfter(6), 0).players[0];
    expect(six).toMatchObject({ survived: false, traded: false, kast: false });
  });

  it('is not a trade before the teammate kills the killer', () => {
    expect(roundRecord(tradeAfter(4), 0, 3100).players[0].traded).toBe(false);
  });
});

describe('a pack without post_end_tick', () => {
  it('gives the same numbers through end_tick', () => {
    const events = [
      hurt(1100, 1, 0, 40, 60, 'hegrenade'),
      hurt(1200, 1, 0, 60, 0),
      death(1200, 1, 0, { assister_idx: 3, assistedflash: true }),
      hurt(2100, 0, 1, 100, 0),
      death(2100, 0, 1),
      death(2150, 1, 3),
    ];
    const withIt = twoRounds(events);
    const without = twoRounds(events);
    for (const r of without.header.rounds)
      delete (r as Partial<RoundInfo>).post_end_tick;
    for (const [r, info] of withIt.header.rounds.entries())
      for (const t of [info.start_tick, 1250, 2120, info.end_tick])
        if (t >= info.start_tick && t <= info.end_tick)
          expect(statsThrough(without, r, t), `round ${r} tick ${t}`).toEqual(
            statsThrough(withIt, r, t)
          );
    expect(statsThrough(without, 1, 2398)[0]).toMatchObject({
      kills: 1,
      utilityDamage: 40,
      rounds: 2,
      kast: 100,
    });
  });
});

describe('the after-round', () => {
  it('counts a kill after the round was decided, before the next one starts', () => {
    const p = twoRounds([
      event('player_death', 1350, {
        user_idx: 1,
        attacker_idx: 0,
        weapon: 'ak47',
      }),
    ]);
    p.header.rounds[0].end_tick = 1300;
    expect(statsThrough(p, 0, 1398)[0].kills).toBe(1);
    expect(statsThrough(p, 0, 1340)[0].kills).toBe(0);
  });
});
