import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../src/api/demos';
import { matchDate, matchTitle } from '../src/match-title';

/** A summary as `GET /api/demos/{id}` gives it: CT won 13–9 on Mirage. */
function summary(over: Partial<MatchSummary> = {}): MatchSummary {
  return {
    map: 'de_mirage',
    rounds: 22,
    scoreT: 9,
    scoreCt: 13,
    durationS: 2357,
    serverName: 'Valve Counter-Strike 2 us_east Server',
    gameBuild: '10560',
    players: [
      {
        steamid: '76561198000000000',
        name: 'alpha',
        team: 3,
        kills: 21,
        deaths: 14,
      },
    ],
    createdUnix: 1792627200,
    playedUnix: null,
    matchId: null,
    ...over,
  };
}

describe('matchTitle', () => {
  it('names the map as players say it, then the higher score first', () => {
    expect(matchTitle(summary())).toBe('Mirage 13–9');
    expect(matchTitle(summary({ scoreT: 13, scoreCt: 9 }))).toBe('Mirage 13–9');
    expect(matchTitle(summary({ scoreT: 12, scoreCt: 12 }))).toBe(
      'Mirage 12–12'
    );
    expect(
      matchTitle(summary({ map: 'de_dust2', scoreT: 0, scoreCt: 0 }))
    ).toBe('Dust II 0–0');
  });

  it('keeps the raw name of an unknown map, as the server does', () => {
    expect(matchTitle(summary({ map: 'Cache2' }))).toBe('Cache2 13–9');
    expect(matchTitle(summary({ map: 'de_some_map' }))).toBe('Some map 13–9');
  });
});

describe('matchDate', () => {
  it('is the UTC day the match was played', () => {
    expect(matchDate(summary({ playedUnix: 1792627199 }))).toBe('2026-10-21');
  });

  it('falls back to when the demo was stored', () => {
    expect(matchDate(summary())).toBe('2026-10-22');
    expect(matchDate(summary({ createdUnix: 1767220200 }))).toBe('2025-12-31');
  });

  it('is empty for a time no date can show', () => {
    expect(matchDate(summary({ createdUnix: 1e20 }))).toBe('');
  });
});
