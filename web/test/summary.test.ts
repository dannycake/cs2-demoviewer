import { describe, expect, it } from 'vitest';
import type { Pack, PackEvent } from '../src/pack/types';
import { parsePack } from '../src/pack/reader';
import { roundSummary, summaryShown } from '../src/sim/summary';
import { buildPack, extraValue } from './helpers/build-pack';
import { playbackPack, type PlaybackRound } from './helpers/playback-pack';
import { cpuTimed } from './helpers/cpu-time';
import { MATCHES } from './helpers/match-packs';
import { event } from './helpers/track-pack';

// Two rounds at 64 tick. Round 0 is decided at 5000 and its after-round ends at 5400; round 1
// starts at 6000 and its freeze ends at 7000, so without a `buytime_ended` its buy time ends
// 20 s later, at 8280.
const R0: PlaybackRound = {
  start: 1000,
  freeze: 2000,
  end: 5000,
  post: 5400,
  winner: 2,
  reason: 'ct_killed',
};
const R1: PlaybackRound = {
  start: 6000,
  freeze: 7000,
  end: 12000,
  post: 12400,
  winner: 3,
  reason: 't_killed',
};

/** Players 0 and 1 are T, 2 and 3 CT, unless `teams` says otherwise. */
function match(
  events: PackEvent[],
  o: { r0?: Partial<PlaybackRound>; teams?: number[] } = {}
): Pack {
  return playbackPack({
    rounds: [{ ...R0, ...o.r0 }, R1],
    teams: o.teams ?? [2, 2, 3, 3],
    events,
  });
}

const hurt = (
  tick: number,
  victim: number,
  attacker: number,
  dmg: number,
  health: number
) =>
  event('player_hurt', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    dmg_health: dmg,
    health,
    weapon: 'ak47',
  });
const death = (tick: number, victim: number, attacker: number) =>
  event('player_death', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    assister_idx: null,
    weapon: 'ak47',
    headshot: false,
  });

// The fixture's Steam ids, by player.
const STEAMID = match([]).header.players.map((p) => p.steamid);
const buy = (
  tick: number,
  p: number,
  item_name: string,
  was_sold = false,
  inventory_slot?: number
) =>
  event('item_purchase', tick, {
    steamid: STEAMID[p],
    item_name,
    was_sold,
    cost: 0,
    ...(inventory_slot === undefined ? {} : { inventory_slot }),
  });

// A tie on kills, 1 each, between T players 0 (60 damage) and 1 (140); CT 3 hurt player 0 for
// 30 and both CTs die.
const TIE = [
  hurt(2300, 0, 3, 30, 70),
  hurt(2400, 2, 1, 40, 60),
  hurt(2500, 2, 0, 60, 0),
  death(2500, 2, 0),
  hurt(2600, 3, 1, 100, 0),
  death(2600, 3, 1),
];

// A CT win by defuse: T 0 plants, CT 2 kills both Ts, CT 3 defuses without a kill.
const DEFUSE = [
  event('bomb_planted', 3000, { user_idx: 0, site: 1 }),
  death(3200, 0, 2),
  death(3300, 1, 2),
  event('bomb_defused', 4000, { user_idx: 3, site: 1 }),
];
const DEFUSED = { winner: 3, reason: 'bomb_defused' };

describe('roundSummary: MVP', () => {
  it('a T win by elimination: the T with the most kills', () => {
    // CT 0 kills T 2 and 3; T 4 kills both CTs. CT 0 ties T 4 on kills with a lower index.
    const pk = match(
      [
        death(2500, 2, 0),
        death(2600, 3, 0),
        death(2700, 0, 4),
        death(2800, 1, 4),
      ],
      { teams: [3, 3, 2, 2, 2] }
    );
    expect(roundSummary(pk, 0).mvp).toEqual({ index: 4, why: 'kills' });
  });

  it('a tie on kills goes to the one with more damage', () => {
    expect(roundSummary(match(TIE), 0).mvp).toEqual({ index: 1, why: 'kills' });
  });

  it('a CT win by defuse: the defuser, even with fewer kills', () => {
    const s = roundSummary(match(DEFUSE, { r0: DEFUSED }), 0);
    expect(s.mvp).toEqual({ index: 3, why: 'defuse' });
  });

  it('a T win by the bomb: the planter, even with fewer kills', () => {
    const pk = match(
      [
        event('bomb_planted', 3000, { user_idx: 1, site: 1 }),
        death(3200, 2, 0),
        event('bomb_exploded', 4000, { user_idx: 1, site: 1 }),
      ],
      { r0: { winner: 2, reason: 'target_bombed' } }
    );
    expect(roundSummary(pk, 0).mvp).toEqual({ index: 1, why: 'bomb' });
  });

  it('a bomb that explodes after a win by elimination leaves it to the kills', () => {
    const pk = match([
      event('bomb_planted', 3000, { user_idx: 1, site: 1 }),
      death(3200, 2, 0),
      death(3300, 3, 0),
      event('bomb_exploded', 5200, { user_idx: 1, site: 1 }),
    ]);
    expect(roundSummary(pk, 0).mvp).toEqual({ index: 0, why: 'kills' });
  });

  it('a round_mvp event beats every other rule', () => {
    const pk = match(
      [...DEFUSE, event('round_mvp', 4000, { user_idx: 2, reason: 1 })],
      { r0: DEFUSED }
    );
    expect(roundSummary(pk, 0).mvp).toEqual({ index: 2, why: 'event' });
  });

  it('winner 0 gives null', () => {
    const s = roundSummary(match(TIE, { r0: { winner: 0 } }), 0);
    expect(s.winner).toBe(0);
    expect(s.mvp).toBeNull();
  });
});

describe('roundSummary: players', () => {
  it('the winners come first, each side by damage; dead players have alive false', () => {
    const s = roundSummary(match(TIE), 0);
    expect(s).toMatchObject({ round: 0, winner: 2, reason: 'ct_killed' });
    expect(s.players).toEqual([
      {
        index: 1,
        name: 'player2',
        team: 2,
        kills: 1,
        damage: 140,
        alive: true,
      },
      { index: 0, name: 'player1', team: 2, kills: 1, damage: 60, alive: true },
      {
        index: 3,
        name: 'player4',
        team: 3,
        kills: 0,
        damage: 30,
        alive: false,
      },
      { index: 2, name: 'player3', team: 3, kills: 0, damage: 0, alive: false },
    ]);
    const ct = roundSummary(match(DEFUSE, { r0: DEFUSED }), 0);
    expect(ct.players.map((p) => p.team)).toEqual([3, 3, 2, 2]);
  });

  it('leaves out who is on no side, and is made once per pack and round', () => {
    const pk = match(TIE, { teams: [2, 2, 3, 3, 0] });
    expect(roundSummary(pk, 0).players.map((p) => p.index)).not.toContain(4);
    expect(roundSummary(pk, 0)).toBe(roundSummary(pk, 0));
  });
});

describe('roundSummary: the next round', () => {
  // Round 1's buys: player 0's rifle and helmet, player 1's pistol (and a rifle sold back),
  // player 2's vest and a kit at the last tick of the buy time, and player 3's vest after it.
  // Player 0's AWP was round 0's.
  const BUYS = [
    buy(1500, 0, 'AWP'),
    buy(6100, 0, 'AK-47'),
    buy(6200, 0, 'Kevlar + Helmet'),
    buy(6300, 1, 'Galil AR', true),
    buy(6400, 1, 'Desert Eagle'),
    buy(7000, 2, 'Kevlar Vest'),
    buy(8280, 2, 'Defuse Kit'),
    buy(8300, 3, 'Kevlar Vest'),
  ];

  it('money is the next round first sample’s', () => {
    const o = {
      players: 2,
      rounds: [
        { samples: 4, start_tick: 100 },
        { samples: 3, start_tick: 200 },
      ],
      tick_step: 2,
    };
    const withMoney = parsePack(
      buildPack({
        ...o,
        order: ['HDR1', 'TRK1', 'EVT1', 'GRN1', 'GRB1', 'TRK2'],
      })
    );
    expect(roundSummary(withMoney, 0).next).toEqual([
      { index: 0, money: extraValue(1, 0, 0, 0), buys: [] },
      { index: 1, money: extraValue(1, 1, 0, 0), buys: [] },
    ]);
    // Without TRK2, money is null, not 0.
    const without = parsePack(buildPack(o));
    expect(roundSummary(without, 0).next!.map((n) => n.money)).toEqual([
      null,
      null,
    ]);
  });

  it('a sold item is left out, and a buy after the buy end too', () => {
    expect(roundSummary(match(BUYS), 0).next).toEqual([
      {
        index: 0,
        money: null,
        buys: [
          { icon: 'ak47', label: 'AK-47' },
          { icon: '', label: 'Helmet' },
        ],
      },
      {
        index: 1,
        money: null,
        buys: [{ icon: 'deagle', label: 'Desert Eagle' }],
      },
      {
        index: 2,
        money: null,
        buys: [
          { icon: '', label: 'Armor' },
          { icon: '', label: 'Kit' },
        ],
      },
      { index: 3, money: null, buys: [] },
    ]);
  });

  it('the buy end is the round’s buytime_ended after its freeze, when it has one', () => {
    const pk = match([
      ...BUYS,
      // At the round's start, before its freeze ends (the pack's first round has one there).
      event('buytime_ended', 6000, {}),
      event('buytime_ended', 7500, {}),
    ]);
    const next = roundSummary(pk, 0).next!;
    expect(next[0].buys.map((b) => b.label)).toEqual(['AK-47', 'Helmet']);
    expect(next[2].buys).toEqual([{ icon: '', label: 'Armor' }]);
  });

  it('a T knife is the T knife, and the game’s Kevlar & Helmet is a helmet too', () => {
    const pk = match([
      buy(6100, 0, 'Kevlar & Helmet'),
      buy(6200, 1, 'Knife'),
      buy(6300, 2, 'Knife'),
    ]);
    const next = roundSummary(pk, 0).next!;
    expect(next[0].buys).toEqual([{ icon: '', label: 'Helmet' }]);
    expect(next[1].buys[0].icon).toBe('knife_t');
    expect(next[2].buys[0].icon).toBe('knife');
  });

  it('an item re-listed a slot lower, after an earlier one left the list, is not bought again', () => {
    // As the packs carry it: each purchase at the next slot of the player's list of the round
    // (what they could still sell back); when an item leaves it, the ones after it come again
    // at the same tick, each a slot lower. A slot freed at the end takes the next purchase.
    const pk = match([
      buy(6100, 0, 'Kevlar Vest', false, 0),
      buy(6200, 0, 'AK-47', false, 1),
      buy(6300, 0, 'Flashbang', false, 2),
      buy(6500, 0, 'AK-47', false, 0),
      buy(6500, 0, 'Flashbang', false, 1),
      buy(6600, 0, 'High Explosive Grenade', false, 2),
      buy(6700, 0, 'Flashbang', false, 3),
      buy(6100, 1, 'Desert Eagle', false, 0),
      buy(6200, 1, 'SSG 08', false, 1),
      buy(6300, 1, 'Galil AR', true, 1),
      buy(6400, 1, 'Smoke Grenade', false, 2),
      buy(6500, 1, 'Smoke Grenade', false, 1),
    ]);
    const next = roundSummary(pk, 0).next!;
    // Weapons, then armour, the kit and grenades, whatever the order bought.
    expect(next[0].buys.map((b) => b.label)).toEqual([
      'AK-47',
      'Armor',
      'Flashbang',
      'High Explosive Grenade',
      'Flashbang',
    ]);
    // The sniper rifle leaves the end of the list and a rifle takes its slot; that one, sold
    // back, leaves the list, and the smoke after it is re-listed, not bought again.
    expect(next[1].buys.map((b) => b.label)).toEqual([
      'Desert Eagle',
      'SSG 08',
      'Smoke Grenade',
    ]);
  });

  it('without item_purchase events, buys are empty; on the last round, next is null', () => {
    const pk = match(TIE);
    expect(roundSummary(pk, 0).next!.map((n) => n.buys)).toEqual([
      [],
      [],
      [],
      [],
    ]);
    expect(roundSummary(pk, 1).next).toBeNull();
  });
});

describe('summaryShown', () => {
  const pk = match([]);

  it('from end_tick through post_end_tick, with the setting on and no reel', () => {
    expect(summaryShown(pk, 0, 4999, false, true)).toBe(false);
    expect(summaryShown(pk, 0, 5000, false, true)).toBe(true);
    expect(summaryShown(pk, 0, 5400, false, true)).toBe(true);
    expect(summaryShown(pk, 0, 5000, true, true)).toBe(false);
    expect(summaryShown(pk, 0, 5000, false, false)).toBe(false);
    expect(summaryShown(pk, 7, 5000, false, true)).toBe(false);
  });
});

for (const m of MATCHES)
  describe.skipIf(m.skip)(`Round summaries on ${m.name}`, () => {
    it('names an MVP of the winners and the next round’s money and buys', async () => {
      const pk = await m.load();
      const { value: all, ms } = cpuTimed(() =>
        pk.header.rounds.map((_, r) => roundSummary(pk, r))
      );
      console.log(
        `round summaries: ${ms.toFixed(1)} ms of CPU for ${all.length} rounds`
      );
      // A pack written before TRK2 (mirage.dvpk.gz) reads no money anywhere, and one without
      // purchase events no buys: the summary then shows none (null money, no buys), not zeros.
      const money = pk.rounds.some((round) =>
        round.players.some((t) => t.money.some((v) => v > 0))
      );
      const purchases = pk.events.some((e) => e.kind === 'item_purchase');
      expect(money || m.real).toBe(true);
      expect(purchases || m.real).toBe(true);
      for (const [r, s] of all.entries()) {
        const mvp = s.players.find((p) => p.index === s.mvp?.index);
        expect(mvp?.team).toBe(s.winner);
        expect(s.players).toHaveLength(10);
        if (r === all.length - 1) {
          expect(s.next).toBeNull();
          continue;
        }
        expect(s.next).toHaveLength(10);
        for (const n of s.next!)
          expect(n.money).toEqual(money ? expect.any(Number) : null);
        const labels = s.next!.flatMap((n) => n.buys.map((b) => b.label));
        if (purchases) expect(labels.length).toBeGreaterThan(0);
        else expect(labels).toEqual([]);
        expect(labels.filter((l) => /kevlar/i.test(l))).toEqual([]);
      }
      // Round 7's buys of player 1 in the Mirage match, whose list is re-listed twice in the
      // buy time.
      if (m.real && purchases)
        expect(all[5].next![1].buys.map((b) => b.label)).toEqual([
          'Armor',
          'FAMAS',
          'Helmet',
          'High Explosive Grenade',
          'Flashbang',
          'Kit',
        ]);
    });
  });
