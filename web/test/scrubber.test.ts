import { describe, expect, it } from 'vitest';
import type { RoundInfo } from '../src/pack/types';
import {
  fractionOf,
  roundClock,
  roundTitle,
  scrubberModel,
  stepTick,
} from '../src/components/scrubber-model';

function round(over: Partial<RoundInfo> = {}): RoundInfo {
  return {
    number: 1,
    start_tick: 65,
    freeze_end_tick: 1441,
    end_tick: 3488,
    post_end_tick: 3488,
    winner: 3,
    reason: 't_killed',
    score_t: 0,
    score_ct: 1,
    samples: 1712,
    ...over,
  };
}

describe('scrubberModel', () => {
  it('spans the round from start_tick to end_tick with the freeze end marked', () => {
    expect(scrubberModel(round(), 2)).toEqual({
      min: 65,
      max: 3488,
      freezeEnd: 1441,
      end: 3488,
      step: 2,
    });
  });

  it("runs on through the after-round, with the round's end marked", () => {
    const m = scrubberModel(round({ post_end_tick: 3700 }), 2);
    expect(m.max).toBe(3700);
    expect(m.end).toBe(3488);
  });

  it('clamps a freeze end outside the round into it', () => {
    expect(scrubberModel(round({ freeze_end_tick: 10 }), 2).freezeEnd).toBe(65);
    expect(scrubberModel(round({ freeze_end_tick: 9999 }), 2).freezeEnd).toBe(
      3488
    );
  });

  it('keeps max at least min for a round whose end is before its start', () => {
    const m = scrubberModel(
      round({ end_tick: 50, post_end_tick: 50, freeze_end_tick: 50 }),
      2
    );
    expect(m.min).toBe(65);
    expect(m.max).toBe(65);
    expect(m.freezeEnd).toBe(65);
  });

  it('falls back to a step of 1 for a missing or invalid tick step', () => {
    expect(scrubberModel(round(), 0).step).toBe(1);
    expect(scrubberModel(round(), Number.NaN).step).toBe(1);
  });
});

describe('fractionOf', () => {
  const m = scrubberModel(
    round({ start_tick: 0, end_tick: 1000, post_end_tick: 1000 }),
    2
  );

  it('places a tick along the scrubber as 0..1', () => {
    expect(fractionOf(m, 0)).toBe(0);
    expect(fractionOf(m, 250)).toBe(0.25);
    expect(fractionOf(m, 1000)).toBe(1);
  });

  it('clamps ticks outside the round and is 0 for an empty round', () => {
    expect(fractionOf(m, -5)).toBe(0);
    expect(fractionOf(m, 5000)).toBe(1);
    const empty = scrubberModel(round({ end_tick: 65, post_end_tick: 65 }), 2);
    expect(fractionOf(empty, 65)).toBe(0);
  });
});

describe('stepTick', () => {
  // A range input's value: the nearest step from min (a tie goes up), within the steps
  // between min and max.
  const m = scrubberModel(round(), 2); // 65..3488 by 2: the last step is 3487
  it('rounds a tick to the step the range input shows', () => {
    expect(stepTick(m, 65)).toBe(65);
    expect(stepTick(m, 999.4)).toBe(999);
    expect(stepTick(m, 1000)).toBe(1001); // a tie goes up
    expect(stepTick(m, 1001.9)).toBe(1001);
    expect(stepTick(m, 1002.1)).toBe(1003);
  });
  it('stays within the steps from min to max', () => {
    expect(stepTick(m, 10)).toBe(65);
    expect(stepTick(m, 3488)).toBe(3487);
    expect(stepTick(m, 9999)).toBe(3487);
  });
});

describe('roundClock', () => {
  const r = round(); // freeze end 1441 at 64 ticks/s

  it('counts m:ss from the freeze end', () => {
    expect(roundClock(r, 1441, 64)).toBe('0:00');
    expect(roundClock(r, 1441 + 640, 64)).toBe('0:10');
    expect(roundClock(r, 1441 + 64 * 75 + 30, 64)).toBe('1:15');
  });

  it('counts down the freeze time as a negative clock', () => {
    expect(roundClock(r, 1441 - 64 * 12, 64)).toBe('-0:12');
    expect(roundClock(r, 1441 - 10, 64)).toBe('-0:01');
  });
});

describe('roundTitle', () => {
  const rounds = [
    round({ number: 1, score_t: 0, score_ct: 1 }),
    round({ number: 2, winner: 2, score_t: 1, score_ct: 1 }),
    round({ number: 3, winner: 2, score_t: 2, score_ct: 1 }),
  ];

  it("shows the score going into the round, from the round's own result", () => {
    expect(roundTitle(rounds, 0)).toBe('Round 1 · T 0 : 0 CT');
    expect(roundTitle(rounds, 1)).toBe('Round 2 · T 0 : 1 CT');
    expect(roundTitle(rounds, 2)).toBe('Round 3 · T 1 : 1 CT');
  });

  it('keeps the sides of the round being watched across the halftime switch', () => {
    // Mirage: the team on CT wins round 12 for 9 : 3, then wins round 13 on T for 10 : 3.
    // Scores are per side, so the round before the switch has them the other way round.
    const half = [
      round({ number: 12, winner: 3, score_t: 3, score_ct: 9 }),
      round({ number: 13, winner: 2, score_t: 10, score_ct: 3 }),
    ];
    expect(roundTitle(half, 0)).toBe('Round 12 · T 3 : 8 CT');
    expect(roundTitle(half, 1)).toBe('Round 13 · T 9 : 3 CT');
  });

  it('shows the recorded score for a round with no known winner', () => {
    expect(
      roundTitle([round({ number: 4, winner: 0, score_t: 2, score_ct: 1 })], 0)
    ).toBe('Round 4 · T 2 : 1 CT');
  });

  it('is empty without the round', () => {
    expect(roundTitle([], 0)).toBe('');
    expect(roundTitle(rounds, 7)).toBe('');
  });
});
