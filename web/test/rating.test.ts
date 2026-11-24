// The viewer's rating is the server's (rating.rs): both are held to
// server/crates/server/tests/fixtures/rating-cases.json, and the viewer carries the server's norms.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  rating,
  RATING_NORMS,
  type RatingLine,
  type RatingNorms,
} from '../src/sim/rating';

const server = (path: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`../../server/crates/server/${path}`, import.meta.url),
      'utf8'
    )
  );

interface Case {
  norms: RatingNorms;
  line: {
    rounds: number;
    kills: number;
    deaths: number;
    assists: number;
    damage: number;
    kast_rounds: number;
    multi_kills: [number, number, number, number];
    opening_wins: number;
    opening_losses: number;
  };
  rating: number | null;
}

const cases = server('tests/fixtures/rating-cases.json') as Case[];

const line = (l: Case['line']): RatingLine => ({
  rounds: l.rounds,
  kills: l.kills,
  deaths: l.deaths,
  assists: l.assists,
  damage: l.damage,
  kastRounds: l.kast_rounds,
  multiKills: l.multi_kills,
  openingWins: l.opening_wins,
  openingLosses: l.opening_losses,
});

describe('rating', () => {
  it("rates the server's cases", () => {
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      const r = rating(line(c.line), c.norms);
      if (c.rating === null) expect(r).toBeNull();
      else expect(r).toBeCloseTo(c.rating, 3);
    }
  });

  it("uses the server's norms", () => {
    expect(RATING_NORMS).toEqual(server('src/rating-norms.json'));
  });

  it('has no rating without rounds, and never goes below 0', () => {
    const none = {
      rounds: 0,
      kills: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      kastRounds: 0,
      multiKills: [0, 0, 0, 0] as [number, number, number, number],
      openingWins: 0,
      openingLosses: 0,
    };
    expect(rating(none)).toBeNull();
    expect(rating({ ...none, rounds: 24, deaths: 24 })).toBe(0);
  });
});
