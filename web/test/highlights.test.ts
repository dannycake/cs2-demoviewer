import { describe, expect, it } from 'vitest';
import type { Pack, PackEvent } from '../src/pack/types';
import {
  HIGHLIGHT,
  highlightLabel,
  highlightsOf,
  type Highlight,
  type HighlightKind,
} from '../src/sim/highlights';
import { timelineFor } from '../src/sim/timeline';
import { playbackPack, type PlaybackRound } from './helpers/playback-pack';
import { cpuTimed } from './helpers/cpu-time';
import { MATCHES } from './helpers/match-packs';
import { event } from './helpers/track-pack';

// 64 tick: the lead is 192 ticks, the tail 96, the clutch lead 128 and the defuse lead 640.
const ROUND: PlaybackRound = {
  start: 1000,
  freeze: 2000,
  end: 10000,
  post: 10500,
};

function death(
  tick: number,
  victim: number,
  attacker: number | null,
  o: {
    weapon?: string;
    headshot?: boolean;
    noscope?: boolean;
    penetrated?: number;
  } = {}
): PackEvent {
  return event('player_death', tick, {
    user_idx: victim,
    attacker_idx: attacker,
    assister_idx: null,
    weapon: o.weapon ?? 'ak47',
    headshot: o.headshot ?? false,
    noscope: o.noscope ?? false,
    penetrated: o.penetrated ?? 0,
  });
}

/** One round (ROUND unless given) of ten players, 0–4 T and 5–9 CT unless `teams` says. */
function pack(
  events: PackEvent[],
  o: {
    teams?: number[];
    winner?: number;
    reason?: string;
    rounds?: PlaybackRound[];
  } = {}
): Pack {
  return playbackPack({
    rounds: o.rounds ?? [{ ...ROUND, winner: o.winner, reason: o.reason }],
    events,
    teams: o.teams,
  });
}

const withKind = (p: Pack, kind: HighlightKind) =>
  highlightsOf(p).filter((h) => h.kinds.includes(kind));

const victims = (p: Pack, h: Highlight) =>
  h.kills.map((i) => timelineFor(p).kills(h.round)[i].victim);

describe('highlightsOf', () => {
  it('gives 3k, 4k and ace for 3, 4 and 5 enemy kills by one player in a round', () => {
    for (const [n, kind] of [
      [3, '3k'],
      [4, '4k'],
      [5, 'ace'],
    ] as const) {
      const p = pack(
        Array.from({ length: n }, (_, i) => death(3000 + 500 * i, 5 + i, 0))
      );
      const multi = highlightsOf(p).filter((h) =>
        h.kinds.some((k) => k === '3k' || k === '4k' || k === 'ace')
      );
      expect(multi).toHaveLength(1);
      const last = 3000 + 500 * (n - 1);
      expect(multi[0]).toMatchObject({
        round: 0,
        player: 0,
        kinds: [kind],
        tick: last,
        from: 3000 - 192,
        to: last + 96,
        vs: null,
        reel: true,
      });
      expect(victims(p, multi[0])).toEqual(
        Array.from({ length: n }, (_, i) => 5 + i)
      );
    }
  });

  it('gives no multi-kill for three kills of which one is a team kill or a suicide', () => {
    const teamKill = pack([
      death(3000, 5, 0),
      death(3500, 6, 0),
      death(4000, 1, 0),
    ]);
    const suicide = pack([
      death(3000, 5, 0),
      death(3500, 6, 0),
      death(4000, 0, 0, { weapon: 'hegrenade' }),
    ]);
    for (const p of [teamKill, suicide])
      for (const kind of ['3k', '4k', 'ace'] as const)
        expect(withKind(p, kind)).toEqual([]);
  });

  // Players 0 and 1 are T, 2–4 CT: two CTs fall, and the last one kills both Ts.
  const oneVsTwo = [
    death(3000, 2, 0),
    death(3500, 3, 1),
    death(4000, 0, 4),
    death(4500, 1, 4),
  ];
  const fiveTeams = [2, 2, 3, 3, 3];

  it('gives a won 1v2 a clutch from 2 s before the second CT death to the round end', () => {
    const p = pack(oneVsTwo, { teams: fiveTeams, winner: 3 });
    const clutches = withKind(p, 'clutch');
    expect(clutches).toHaveLength(1);
    expect(clutches[0]).toMatchObject({
      round: 0,
      player: 4,
      kinds: ['clutch'],
      vs: 2,
      tick: 10000,
      from: 3500 - 128,
      to: 10000 + 96,
      reel: true,
    });
    expect(victims(p, clutches[0])).toEqual([0, 1]);
  });

  it('gives no clutch when the Ts win the round', () => {
    // The last T, alone against the CT from 4000, died at 4500 before the Ts won (the bomb):
    // a clutcher must be alive at the round's end.
    const p = pack(oneVsTwo, {
      teams: fiveTeams,
      winner: 2,
      reason: 'target_bombed',
    });
    expect(withKind(p, 'clutch')).toEqual([]);
  });

  it('gives the last T a clutch when they survive and the Ts win', () => {
    // T 0 falls at 3000, leaving T 1 against three CTs; T 1 kills one and the bomb wins it.
    const p = pack([death(3000, 0, 4), death(3500, 2, 1)], {
      teams: fiveTeams,
      winner: 2,
      reason: 'target_bombed',
    });
    const clutches = withKind(p, 'clutch');
    expect(clutches).toHaveLength(1);
    expect(clutches[0]).toMatchObject({
      player: 1,
      kinds: ['clutch'],
      vs: 3,
      tick: 10000,
      from: 3000 - 128,
      to: 10000 + 96,
      reel: true,
    });
    expect(victims(p, clutches[0])).toEqual([2]);
  });

  // CT 6 kills Ts 0–3; T 4 is still alive when CT 5 defuses at 6000.
  const tsFall = [0, 1, 2, 3].map((t, i) => death(3000 + 300 * i, t, 6));
  const defused = event('bomb_defused', 6000, { user_idx: 5, site: 1 });

  it('gives a defuse with a T alive a ninja from 10 s before the defuse', () => {
    const p = pack([...tsFall, defused], {
      winner: 3,
      reason: 'bomb_defused',
    });
    const ninjas = withKind(p, 'ninja');
    expect(ninjas).toHaveLength(1);
    expect(ninjas[0]).toMatchObject({
      round: 0,
      player: 5,
      kinds: ['ninja'],
      tick: 6000,
      from: 6000 - 640,
      to: 6000 + 96,
      vs: null,
      kills: [],
      reel: true,
    });
  });

  it("starts a ninja at the defuser's last bomb_begindefuse when the pack has one", () => {
    const begins = [
      event('bomb_begindefuse', 5200, { user_idx: 5 }),
      event('bomb_begindefuse', 5700, { user_idx: 5 }),
      event('bomb_begindefuse', 5800, { user_idx: 7 }),
    ];
    const p = pack([...tsFall, ...begins, defused], {
      winner: 3,
      reason: 'bomb_defused',
    });
    expect(withKind(p, 'ninja')).toMatchObject([{ from: 5700, to: 6096 }]);
  });

  it('gives no ninja when no T is alive at the defuse', () => {
    const p = pack([...tsFall, death(5000, 4, 6), defused], {
      winner: 3,
      reason: 'bomb_defused',
    });
    expect(withKind(p, 'ninja')).toEqual([]);
  });

  // Player 1 takes the opening, so the moment at 3000 is player 0's alone.
  const opening = death(2500, 9, 1);

  it('gives two headshot kills at one tick with one gun a collateral', () => {
    const p = pack([
      opening,
      death(3000, 5, 0, { headshot: true }),
      death(3000, 6, 0, { headshot: true }),
    ]);
    const at = highlightsOf(p).filter((h) => h.tick === 3000);
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({
      player: 0,
      kinds: ['collateral'],
      from: 3000 - 192,
      to: 3000 + 96,
      vs: null,
      reel: true,
    });
    expect(victims(p, at[0])).toEqual([5, 6]);
  });

  it('gives no collateral when one kill is not a headshot, or with a grenade', () => {
    const body = pack([
      opening,
      death(3000, 5, 0, { headshot: true }),
      death(3000, 6, 0),
    ]);
    const he = pack([
      opening,
      death(3000, 5, 0, { headshot: true, weapon: 'hegrenade' }),
      death(3000, 6, 0, { headshot: true, weapon: 'hegrenade' }),
    ]);
    for (const p of [body, he]) expect(withKind(p, 'collateral')).toEqual([]);
  });

  it('gives a no-scope wallbang one highlight with both kinds', () => {
    const p = pack([
      opening,
      death(3000, 5, 0, { weapon: 'awp', noscope: true, penetrated: 1 }),
    ]);
    const at = highlightsOf(p).filter((h) => h.tick === 3000);
    expect(at).toHaveLength(1);
    expect(at[0]).toMatchObject({
      player: 0,
      kinds: ['noscope', 'wallbang'],
      reel: true,
    });
  });

  it("gives the round's first enemy kill the opening, listed but not in the reel", () => {
    const p = pack([
      death(2500, 2, null, { weapon: 'world' }),
      death(2700, 4, 3),
      death(3000, 5, 0),
    ]);
    expect(withKind(p, 'opening')).toEqual([
      expect.objectContaining({
        round: 0,
        player: 0,
        kinds: ['opening'],
        tick: 3000,
        from: 3000 - 192,
        to: 3000 + 96,
        vs: null,
        reel: false,
      }),
    ]);
    expect(victims(p, withKind(p, 'opening')[0])).toEqual([5]);
  });

  it('clamps every window to the freeze end and the after-round end', () => {
    const early = pack([death(2064, 5, 0)]);
    expect(withKind(early, 'opening')).toMatchObject([
      { from: 2000, to: 2064 + 96 },
    ]);
    const after = pack([death(10450, 5, 0)]);
    expect(withKind(after, 'opening')).toMatchObject([
      { from: 10450 - 192, to: 10500 },
    ]);
    // A round without post_end_tick (the reader gives it end_tick) ends at end_tick.
    const short = pack([death(9950, 5, 0)], {
      rounds: [{ start: 1000, freeze: 2000, end: 10000 }],
    });
    expect(withKind(short, 'opening')).toMatchObject([
      { from: 9950 - 192, to: 10000 },
    ]);
  });

  it('keeps the list per pack, sorted by round, then tick', () => {
    const p = pack(
      [
        death(13000, 5, 0),
        death(4000, 6, 1, { noscope: true }),
        death(3000, 5, 0),
      ],
      {
        rounds: [
          ROUND,
          { start: 11000, freeze: 12000, end: 20000, post: 20500 },
        ],
      }
    );
    const hs = highlightsOf(p);
    expect(highlightsOf(p)).toBe(hs);
    expect(hs.map((h) => [h.round, h.tick, h.kinds])).toEqual([
      [0, 3000, ['opening']],
      [0, 4000, ['noscope']],
      [1, 13000, ['opening']],
    ]);
  });

  it('times its windows from HIGHLIGHT', () => {
    expect(HIGHLIGHT).toEqual({
      leadS: 3,
      tailS: 1.5,
      clutchLeadS: 2,
      defuseLeadS: 10,
      mergeGapS: 1,
    });
    expect(Object.isFrozen(HIGHLIGHT)).toBe(true);
  });
});

describe('highlightLabel', () => {
  const h = (kinds: HighlightKind[], vs: number | null = null): Highlight => ({
    round: 0,
    player: 0,
    kinds,
    tick: 0,
    from: 0,
    to: 0,
    vs,
    kills: [],
    reel: true,
  });

  it('names each kind, joining a kill’s kinds with a dot', () => {
    expect(highlightLabel(h(['ace']))).toBe('Ace');
    expect(highlightLabel(h(['4k']))).toBe('4k');
    expect(highlightLabel(h(['3k']))).toBe('3k');
    expect(highlightLabel(h(['clutch'], 3))).toBe('1v3 clutch');
    expect(highlightLabel(h(['ninja']))).toBe('Ninja defuse');
    expect(highlightLabel(h(['collateral']))).toBe('Collateral');
    expect(highlightLabel(h(['noscope', 'wallbang']))).toBe(
      'No-scope · Wallbang'
    );
    expect(highlightLabel(h(['opening']))).toBe('Opening kill');
  });
});

for (const m of MATCHES)
  describe.skipIf(m.skip)(`Highlights on ${m.name}`, () => {
    it('builds in under 20 ms of CPU, every window inside its round', async () => {
      const pk = await m.load();
      // The rounds' timelines are the scene's and the HUD's, shared and built once per pack
      // (timeline.test.ts times its queries the same way): what is timed here is the
      // highlights' own pass over them.
      const tl = timelineFor(pk);
      const built = cpuTimed(() => {
        for (let r = 0; r < pk.header.rounds.length; r++) {
          tl.kills(r);
          tl.bombAt(r, pk.header.rounds[r].post_end_tick);
        }
      }).ms;
      const { value: hs, ms } = cpuTimed(() => highlightsOf(pk));
      const by = new Map<string, number>();
      for (const h of hs)
        for (const k of h.kinds) by.set(k, (by.get(k) ?? 0) + 1);
      console.log(
        `${m.real ? 'real' : 'synthetic'} highlights: ${hs.length} (${[...by].map(([k, n]) => `${n} ${k}`).join(', ')}), ${hs.filter((h) => h.reel).length} in the reel; ${ms.toFixed(1)} ms of CPU over timelines built in ${built.toFixed(1)} ms`
      );
      expect(ms).toBeLessThan(20);
      expect(hs.length).toBeGreaterThan(0);
      for (const h of hs) {
        const info = pk.header.rounds[h.round];
        expect(h.from).toBeGreaterThanOrEqual(info.freeze_end_tick);
        expect(h.from).toBeLessThanOrEqual(h.tick);
        expect(h.tick).toBeLessThanOrEqual(h.to);
        expect(h.to).toBeLessThanOrEqual(info.post_end_tick);
      }
      // Every round has kills, so every round has one opening kill.
      for (let r = 0; r < pk.header.rounds.length; r++)
        expect(
          hs.filter((h) => h.round === r && h.kinds.includes('opening'))
        ).toHaveLength(1);
    });
  });
