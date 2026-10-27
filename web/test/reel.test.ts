// Reels (`state/reel.ts`): entering a segment, stepping past its end, leaving, and the
// highlights reel's segments.

import { describe, expect, it } from 'vitest';
import type { Pack, PackEvent } from '../src/pack/types';
import { highlightsOf, type Highlight } from '../src/sim/highlights';
import { timelineFor } from '../src/sim/timeline';
import {
  backToFree,
  enterSegment,
  highlightSegment,
  highlightSegments,
  leaveReel,
  stepReel,
  type Reel,
  type ReelSegment,
  type Resume,
} from '../src/state/reel';
import { playbackPack } from './helpers/playback-pack';
import { event } from './helpers/track-pack';

const seg = (
  round: number,
  from: number,
  to: number,
  follow = 0
): ReelSegment => ({ round, from, to, follow, title: `s${round}` });

const RESUME: Resume = {
  round: 0,
  tick: 2500,
  camera: 'free',
  follow: 7,
  followPinned: true,
  director: true,
  playing: false,
  speed: 4,
};

function reel(
  segments: ReelSegment[],
  index = 0,
  atEnd: Reel['atEnd'] = 'continue'
): Reel {
  return { kind: 'highlights', segments, index, resume: RESUME, atEnd };
}

describe('enterSegment', () => {
  it("plays the segment's round from its start, in POV on its player, pinned, at 1×, without the director or the radar", () => {
    expect(enterSegment(seg(1, 3000, 3500, 4))).toEqual({
      round: 1,
      tick: 3000,
      camera: 'pov',
      follow: 4,
      followPinned: true,
      director: false,
      playing: true,
      speed: 1,
      radar: false,
    });
  });
});

describe('stepReel', () => {
  const two = [seg(0, 3000, 3500, 1), seg(1, 13000, 13500, 2)];

  it('is null without a reel and inside a segment', () => {
    expect(stepReel({ reel: null, round: 0, tick: 9999 })).toBeNull();
    expect(stepReel({ reel: reel(two), round: 0, tick: 3000 })).toBeNull();
    expect(stepReel({ reel: reel(two), round: 0, tick: 3499.5 })).toBeNull();
    expect(stepReel({ reel: reel(two, 1), round: 1, tick: 13200 })).toBeNull();
  });

  it('enters the next segment past the end of one', () => {
    expect(stepReel({ reel: reel(two), round: 0, tick: 3501 })).toEqual({
      ...enterSegment(two[1]),
      reel: reel(two, 1),
    });
    // Reaching the end counts: the clock stops on the last round's post_end_tick.
    expect(stepReel({ reel: reel(two), round: 0, tick: 3500 })).toMatchObject({
      round: 1,
      tick: 13000,
    });
  });

  it('treats a jump into another round as past the end', () => {
    expect(stepReel({ reel: reel(two), round: 1, tick: 3200 })).toEqual({
      ...enterSegment(two[1]),
      reel: reel(two, 1),
    });
  });

  it('leaves after the last segment: back to the start for a kill cam, playing on for highlights', () => {
    expect(
      stepReel({ reel: reel(two, 1, 'resume'), round: 1, tick: 13600 })
    ).toEqual(leaveReel(reel(two, 1, 'resume'), 'resume'));
    expect(
      stepReel({ reel: reel(two, 1, 'continue'), round: 1, tick: 13600 })
    ).toEqual(leaveReel(reel(two, 1, 'continue'), 'here'));
  });
});

describe('leaveReel', () => {
  it("'resume' goes back to where it started, in the camera it had", () => {
    expect(leaveReel(reel([seg(1, 0, 10)]), 'resume')).toEqual({
      reel: null,
      round: 0,
      tick: 2500,
      camera: 'free',
      follow: 7,
      followPinned: true,
      director: true,
      playing: false,
      speed: 4,
    });
  });

  it("'here' stays where it is, playing, with the camera, director and speed it had", () => {
    expect(leaveReel(reel([seg(1, 0, 10)]), 'here')).toEqual({
      reel: null,
      camera: 'free',
      follow: 7,
      followPinned: true,
      director: true,
      speed: 4,
    });
  });
});

describe('backToFree', () => {
  // RESUME is a reel started in Free.
  const inPov = {
    ...reel([seg(0, 3000, 3500)]),
    resume: { ...RESUME, camera: 'pov' as const },
  };

  it('is true as a reel started in Free leaves back in Free: at its end, Escape, a seek, or C', () => {
    const playing = reel([seg(0, 3000, 3500)]);
    expect(backToFree({ reel: null, camera: 'free' }, { reel: playing })).toBe(
      true
    );
  });

  it('is false while a reel plays on, after one that started elsewhere, and out of Free', () => {
    const playing = reel([seg(0, 3000, 3500)]);
    expect(backToFree({ reel: playing, camera: 'pov' }, { reel: null })).toBe(
      false
    );
    expect(
      backToFree(
        { reel: reel([seg(0, 3000, 3500)], 1), camera: 'pov' },
        { reel: playing }
      )
    ).toBe(false);
    // C during a reel started in POV: Free takes the view drawn last, as ever.
    expect(backToFree({ reel: null, camera: 'free' }, { reel: inPov })).toBe(
      false
    );
    // V during a reel started in Free.
    expect(backToFree({ reel: null, camera: 'pov' }, { reel: playing })).toBe(
      false
    );
    expect(backToFree({ reel: null, camera: 'free' }, { reel: null })).toBe(
      false
    );
  });
});

describe('highlightSegments', () => {
  // 64 tick: a kill's window is 192 ticks before it to 96 after; merging needs a gap < 64.
  const ROUND = { start: 1000, freeze: 2000, end: 10000, post: 10500 };

  function death(
    tick: number,
    victim: number,
    attacker: number,
    penetrated = 0
  ): PackEvent {
    return event('player_death', tick, {
      user_idx: victim,
      attacker_idx: attacker,
      assister_idx: null,
      weapon: 'ak47',
      headshot: false,
      noscope: false,
      penetrated,
    });
  }

  const pack = (events: PackEvent[] = [], rounds = 1): Pack =>
    playbackPack({
      rounds: Array.from({ length: rounds }, (_, r) => ({
        start: ROUND.start + 20000 * r,
        freeze: ROUND.freeze + 20000 * r,
        end: ROUND.end + 20000 * r,
        post: ROUND.post + 20000 * r,
      })),
      events,
    });

  const hl = (o: Partial<Highlight> & Pick<Highlight, 'from' | 'to'>) =>
    ({
      round: 0,
      player: 0,
      kinds: ['wallbang'],
      tick: o.to - 96,
      vs: null,
      kills: [],
      reel: true,
      ...o,
    }) satisfies Highlight;

  it("merges one player's windows that overlap or are less than a second apart, naming each once", () => {
    const p = pack();
    // Overlapping.
    expect(
      highlightSegments(
        p,
        [
          hl({ kinds: ['noscope'], from: 4808, to: 5096 }),
          hl({ kinds: ['wallbang'], from: 4840, to: 5128 }),
        ],
        0
      )
    ).toEqual([
      {
        round: 0,
        from: 4808,
        to: 5128,
        follow: 0,
        title: 'No-scope · Wallbang',
      },
    ]);
    // 0.5 s apart.
    expect(
      highlightSegments(
        p,
        [
          hl({ kinds: ['noscope'], from: 4808, to: 5096 }),
          hl({ kinds: ['noscope'], from: 5128, to: 5416 }),
        ],
        0
      )
    ).toEqual([
      {
        round: 0,
        from: 4808,
        to: 5416,
        follow: 0,
        title: 'No-scope',
      },
    ]);
    // 2 s apart: two segments.
    expect(
      highlightSegments(
        p,
        [
          hl({ kinds: ['noscope'], from: 4808, to: 5096 }),
          hl({ kinds: ['wallbang'], from: 5224, to: 5512 }),
        ],
        0
      ).map((s) => [s.from, s.to, s.title])
    ).toEqual([
      [4808, 5096, 'No-scope'],
      [5224, 5512, 'Wallbang'],
    ]);
  });

  it('keeps two players apart, in time order, each in POV on its player', () => {
    const p = pack();
    expect(
      highlightSegments(
        p,
        [
          hl({ player: 3, kinds: ['wallbang'], from: 4840, to: 5128 }),
          hl({ player: 6, kinds: ['noscope'], from: 4808, to: 5096 }),
        ],
        0
      )
    ).toEqual([
      {
        round: 0,
        from: 4808,
        to: 5096,
        follow: 6,
        title: 'No-scope',
      },
      {
        round: 0,
        from: 4840,
        to: 5128,
        follow: 3,
        title: 'Wallbang',
      },
    ]);
  });

  it('leaves out highlights not in the reel and rounds before fromRound', () => {
    const p = pack([], 5);
    const hs = [0, 1, 2, 3, 4].map((round) =>
      hl({ round, from: 4808 + 20000 * round, to: 5096 + 20000 * round })
    );
    const opening = hl({
      round: 4,
      player: 2,
      kinds: ['opening'],
      from: 82000,
      to: 82288,
      reel: false,
    });
    expect(
      highlightSegments(p, [...hs, opening], 3).map((s) => s.round)
    ).toEqual([3, 4]);
    expect(highlightSegments(p, [opening], 0)).toEqual([]);
    expect(highlightSegments(p, hs, 0)).toHaveLength(5);
  });

  it('plays a multi-kill as one window per kill, merging the close ones, clamped to the round', () => {
    // Player 0's 3k: at 2100 (its lead clamped to the freeze end), then 8000 and 8100.
    const p = pack([death(2100, 5, 0), death(8000, 6, 0), death(8100, 7, 0)]);
    const multi = highlightsOf(p).filter((h) => h.kinds[0] === '3k');
    expect(multi).toHaveLength(1);
    expect(multi[0]).toMatchObject({ from: 2000, to: 8196 });
    expect(highlightSegments(p, multi, 0)).toEqual([
      {
        round: 0,
        from: 2000,
        to: 2196,
        follow: 0,
        title: '3k',
      },
      {
        round: 0,
        from: 7808,
        to: 8196,
        follow: 0,
        title: '3k',
      },
    ]);
  });

  it("joins a multi-kill's window with the player's other highlights there", () => {
    // The 3k's second kill is a wallbang.
    const p = pack([
      death(3000, 5, 0),
      death(6000, 6, 0, 1),
      death(9000, 7, 0),
    ]);
    const segs = highlightSegments(p, highlightsOf(p), 0);
    expect(segs.map((s) => [s.from, s.to, s.title])).toEqual([
      [2808, 3096, '3k'],
      [5808, 6096, '3k · Wallbang'],
      [8808, 9096, '3k'],
    ]);
  });

  it("plays a kill made after the player's death in POV on its victim, apart from the player's own", () => {
    // Player 0's 3k: kills at 3000 and 6000, killed at 7000 by player 8, then their fire kills
    // player 7 at 9000.
    const p = pack([
      death(3000, 5, 0),
      death(6000, 6, 0),
      death(7000, 0, 8),
      {
        ...death(9000, 7, 0),
        data: { ...death(9000, 7, 0).data, weapon: 'inferno' },
      },
    ]);
    const multi = highlightsOf(p).filter((h) => h.kinds[0] === '3k');
    expect(multi).toHaveLength(1);
    expect(highlightSegments(p, multi, 0)).toEqual([
      { round: 0, from: 2808, to: 3096, follow: 0, title: '3k' },
      { round: 0, from: 5808, to: 6096, follow: 0, title: '3k' },
      {
        round: 0,
        from: 8808,
        to: 9096,
        follow: 7,
        player: 0,
        title: '3k',
      },
    ]);
    // A kill at the tick of the player's own death is not from a living player's eyes either,
    // and a window on the victim never merges with the player's own close by.
    const trade = pack([
      death(3000, 5, 0),
      death(3020, 6, 0),
      death(3040, 0, 8),
      death(3040, 7, 0),
    ]);
    expect(
      highlightSegments(
        trade,
        highlightsOf(trade).filter((h) => h.kinds[0] === '3k'),
        0
      )
    ).toEqual([
      { round: 0, from: 2808, to: 3116, follow: 0, title: '3k' },
      {
        round: 0,
        from: 2848,
        to: 3136,
        follow: 7,
        player: 0,
        title: '3k',
      },
    ]);
  });

  it("merges a window on a victim with that player's own window close by, so the overlap plays once", () => {
    // Player 5 (CT) wallbangs player 2 at 3000; player 0 (T), dead at 2500, kills player 5
    // with their fire at 3100: that window is on its victim, player 5, too. Both are POV on
    // player 5, so they play as one segment, named for the highlight it opens with.
    const fire = death(3100, 5, 0);
    const p = pack([
      death(2500, 0, 8),
      death(3000, 2, 5, 1),
      { ...fire, data: { ...fire.data, weapon: 'inferno' } },
    ]);
    const kills = timelineFor(p).kills(0);
    const at = (tick: number) => kills.findIndex((k) => k.tick === tick);
    const after = hl({ player: 0, from: 2908, to: 3196, kills: [at(3100)] });
    // Player 5's own window first: theirs, with no `player`.
    const own = hl({ player: 5, from: 2808, to: 3096, kills: [at(3000)] });
    expect(highlightSegments(p, [own, after], 0)).toEqual([
      { round: 0, from: 2808, to: 3196, follow: 5, title: 'Wallbang' },
    ]);
    // The window on the victim first: it keeps player 0 as the highlight's player.
    const late = hl({ player: 5, from: 2950, to: 3096, kills: [at(3000)] });
    expect(highlightSegments(p, [late, after], 0)).toEqual([
      {
        round: 0,
        from: 2908,
        to: 3196,
        follow: 5,
        player: 0,
        title: 'Wallbang',
      },
    ]);
  });

  it('plays a clutch and a ninja defuse whole', () => {
    const p = pack();
    const clutch = hl({
      player: 4,
      kinds: ['clutch'],
      vs: 2,
      from: 4000,
      to: 9096,
      kills: [],
    });
    const ninja = hl({
      player: 8,
      kinds: ['ninja'],
      from: 8000,
      to: 8736,
    });
    expect(highlightSegments(p, [clutch, ninja], 0)).toEqual([
      {
        round: 0,
        from: 4000,
        to: 9096,
        follow: 4,
        title: '1v2 clutch',
      },
      {
        round: 0,
        from: 8000,
        to: 8736,
        follow: 8,
        title: 'Ninja defuse',
      },
    ]);
  });
});

describe('highlightSegment', () => {
  const p = playbackPack({
    rounds: [
      { start: 1000, freeze: 2000, end: 10000, post: 10500 },
      { start: 21000, freeze: 22000, end: 30000, post: 30500 },
      { start: 41000, freeze: 42000, end: 50000, post: 50500 },
    ],
  });

  it("plays one highlight's whole window in POV on its player, titled with its kinds", () => {
    const h: Highlight = {
      round: 2,
      player: 3,
      kinds: ['4k'],
      tick: 9000,
      from: 3000,
      to: 9096,
      vs: null,
      kills: [0, 1, 2, 3],
      reel: true,
    };
    expect(highlightSegment(p, h)).toEqual([
      {
        round: 2,
        from: 3000,
        to: 9096,
        follow: 3,
        title: '4k',
      },
    ]);
    // An opening kill is not in the reel, but its row still plays it.
    expect(
      highlightSegment(p, {
        ...h,
        kinds: ['opening'],
        from: 2808,
        to: 3096,
        reel: false,
      })
    ).toMatchObject([{ from: 2808, to: 3096, title: 'Opening kill' }]);
  });

  it("plays a highlight with a kill made after its player's death as the reel does", () => {
    // Player 0's 3k: kills at 3000 and 6000, dead at 7000, their fire kills player 7 at 9000.
    const dead = playbackPack({
      rounds: [{ start: 1000, freeze: 2000, end: 10000, post: 10500 }],
      events: [
        [3000, 5],
        [6000, 6],
        [9000, 7],
      ]
        .map(([tick, victim]) =>
          event('player_death', tick, {
            user_idx: victim,
            attacker_idx: 0,
            weapon: tick === 9000 ? 'inferno' : 'ak47',
          })
        )
        .concat(
          event('player_death', 7000, {
            user_idx: 0,
            attacker_idx: 8,
            weapon: 'ak47',
          })
        ),
    });
    const h = highlightsOf(dead).find((x) => x.kinds[0] === '3k')!;
    expect(h).toMatchObject({ from: 2808, to: 9096 });
    expect(highlightSegment(dead, h)).toEqual(highlightSegments(dead, [h], 0));
    expect(highlightSegment(dead, h).map((s) => [s.follow, s.player])).toEqual([
      [0, undefined],
      [0, undefined],
      [7, 0],
    ]);
  });
});
