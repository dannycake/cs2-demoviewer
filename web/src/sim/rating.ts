// The performance rating, as the server works it out for profiles (server/crates/server/src/
// rating.rs), so a match's replay and its profile row show the same number: six per-round rates
// (kills, survival, KAST, damage, multi-kill rounds weighted by the kills squared, opening duels
// won), each divided by its average over the matches the server holds (`rating-norms.json`, a
// copy of the server's), weighted 25/20/20/20/10/5 %. A line at every average rates 1.00.

import norms from './rating-norms.json' with { type: 'json' };

/** One player's numbers over some rounds, as the rating reads them (the server's `RatingLine`). */
export interface RatingLine {
  /** Rounds on a side; every rate is per one of them. */
  rounds: number;
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  kastRounds: number;
  /** Rounds with 2, 3, 4 and 5+ kills. */
  multiKills: readonly [number, number, number, number];
  openingWins: number;
  openingLosses: number;
}

/** The average of each per-round rate, which a rate is divided by. */
export interface RatingNorms {
  kills: number;
  survival: number;
  kast: number;
  damage: number;
  multi: number;
  opening: number;
  /** How many lines the averages are over. */
  lines: number;
}

export const RATING_NORMS: RatingNorms = Object.freeze({ ...norms });

/** The weights of kills, survival, KAST, damage, multi-kills and opening duels; they sum to 1. */
const WEIGHTS = [0.25, 0.2, 0.2, 0.2, 0.1, 0.05] as const;
/** A round with 2, 3, 4 and 5+ kills counts the kills squared towards the multi-kill rate. */
const MULTI_POINTS = [4, 9, 16, 25] as const;

/** The rating of `line` against `n`; null without rounds; never below 0. */
export function rating(
  line: RatingLine,
  n: RatingNorms = RATING_NORMS
): number | null {
  if (line.rounds <= 0) return null;
  const r = line.rounds;
  const multi = line.multiKills.reduce(
    (sum, k, i) => sum + k * MULTI_POINTS[i],
    0
  );
  const rates = [
    line.kills / r,
    Math.max(0, r - line.deaths) / r,
    line.kastRounds / r,
    line.damage / r,
    multi / r,
    line.openingWins / r,
  ];
  const means = [n.kills, n.survival, n.kast, n.damage, n.multi, n.opening];
  const sum = rates.reduce(
    (s, x, i) => s + WEIGHTS[i] * (means[i] > 0 ? x / means[i] : 1),
    0
  );
  return Math.max(0, sum);
}
