// One match row as the profile's totals (`Totals`), so a game's expansion (./Expansion) draws the
// same strip and figures as the profile's top over all its matches: its own counts, its ADR, HS%
// and KAST as the row has them, and K/D, rounds and survival by the rules `totals()` in
// server/crates/server/src/profile.rs has for many. A row says nothing of how long the game was,
// so its time played is none (0, which the figures show as a dash).

import type { MatchRow, Totals } from '../../api/players';

export function totalsOfRow(row: MatchRow): Totals {
  const { kills, deaths } = row;
  // The match's rounds where a summary from before them never counted the player's own.
  const rounds = row.rounds || (row.score ? row.score[0] + row.score[1] : 0);
  return {
    rating: row.rating,
    openingWon: row.openingWon,
    openingLost: row.openingLost,
    kd: kills > 0 || deaths > 0 ? kills / Math.max(deaths, 1) : null,
    adr: row.adr,
    hsPct: row.hsPct,
    matches: 1,
    kills,
    deaths,
    assists: row.assists,
    rounds,
    kastPct: row.kastPct,
    // Over the player's own rounds only, as KAST is.
    survivalPct:
      row.rounds > 0
        ? (Math.max(row.rounds - deaths, 0) * 100) / row.rounds
        : null,
    multiKills: row.multiKills,
    wins: row.result === 'w' ? 1 : 0,
    losses: row.result === 'l' ? 1 : 0,
    ties: row.result === 't' ? 1 : 0,
    seconds: 0,
  };
}
