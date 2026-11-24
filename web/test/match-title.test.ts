import { describe, expect, it } from 'vitest';
import type { MatchSummary } from '../src/api/demos';
import {
  matchPageTitle,
  matchTabTitle,
  matchTitle,
} from '../src/match-title';

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

describe('matchPageTitle', () => {
  it('names the tournament, as the server does', () => {
    expect(matchPageTitle(summary({ event: 'iem_cologne_major_2026' }))).toMatch(
      / · IEM Cologne Major 2026$/
    );
  });

  it('says it is a CS2 replay without a tournament', () => {
    expect(matchPageTitle(summary())).toMatch(/ · CS2 replay$/);
  });

  it('leads with the teams when they are known', () => {
    expect(
      matchPageTitle(
        summary({ teams: ['Spirit', 'Falcons'], event: 'pgl_astana_2026' })
      )
    ).toMatch(/^Spirit vs Falcons · .* · PGL Astana 2026$/);
  });
});

describe('matchTabTitle', () => {
  it('names the teams as the server does, when there are any', () => {
    expect(matchTabTitle(summary({ teams: ['Spirit', 'Falcons'] }))).toBe(
      'Spirit vs Falcons · Mirage 13–9'
    );
    expect(matchTabTitle(summary())).toBe('Mirage 13–9');
  });
});
