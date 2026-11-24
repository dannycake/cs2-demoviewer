// How the site writes numbers, dates and facts (site/format). A tournament's name is held, with
// the server's (pages.rs `event_name`), to server/crates/server/tests/fixtures/events.json.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchRow, SteamFacts } from '../src/api/players';
import {
  banFacts,
  countryName,
  eventName,
  formatDay,
  formatHours,
  formatPct,
  formatRating,
  modeLabel,
  premierParts,
  premierTier,
  RAINBOW,
  statsTitle,
} from '../src/site/format';

describe('format', () => {
  it.each([
    [0, 1],
    [4999, 1],
    [5000, 2],
    [9999, 2],
    [10000, 3],
    [14999, 3],
    [15000, 4],
    [20000, 5],
    [25000, 6],
    [29999, 6],
    [30000, 7],
  ])('tier of %i is %i', (r, t) => expect(premierTier(r)).toBe(t));

  it('splits a rating at the thousands', () => {
    expect(premierParts(8058)).toEqual(['8', ',058']);
    expect(premierParts(950)).toEqual(['950', '']);
    expect(premierParts(25000)).toEqual(['25', ',000']);
  });

  it('writes ratings and percentages, a dash for none', () => {
    expect(formatRating(1.1234)).toBe('1.12');
    expect(formatRating(null)).toBe('—');
    expect(formatPct(57.6)).toBe('58%');
    expect(formatPct(null)).toBe('—');
  });

  it('writes hours to a tenth under ten, else whole', () => {
    expect(formatHours(0)).toBe('0');
    expect(formatHours(5_400)).toBe('1.5');
    expect(formatHours(3_600)).toBe('1');
    expect(formatHours(35_800)).toBe('9.9');
    expect(formatHours(35_900)).toBe('10');
    expect(formatHours(61_200)).toBe('17');
  });

  it('writes days, with the year only when it is not this one', () => {
    const now = new Date(Date.UTC(2026, 9, 27));
    expect(formatDay(Date.UTC(2026, 9, 14) / 1000, now)).toBe('Oct 14');
    expect(formatDay(Date.UTC(2025, 9, 14) / 1000, now)).toBe('Oct 14 2025');
    expect(formatDay(null, now)).toBe('');
  });

  it('says bans plainly, each its own fact', () => {
    const says = (steam: Partial<SteamFacts>) =>
      banFacts({
        vacBans: 0,
        gameBans: 0,
        communityBanned: false,
        tradeBan: null,
        ...steam,
      }).map(({ n, words }) => (n === null ? words : `${n} ${words}`));
    expect(says({})).toEqual(['No bans']);
    expect(says({ vacBans: 1 })).toEqual(['1 VAC ban']);
    expect(says({ gameBans: 2 })).toEqual(['2 game bans']);
    expect(says({ vacBans: 1, gameBans: 2 })).toEqual([
      '1 VAC ban',
      '2 game bans',
    ]);
    expect(says({ communityBanned: true })).toEqual(['Community ban']);
    expect(says({ tradeBan: 'banned' })).toEqual(['Trade ban']);
    expect(says({ vacBans: 2, tradeBan: 'probation' })).toEqual([
      '2 VAC bans',
      'Trade probation',
    ]);
    // Kept before community and trade bans were asked for.
    expect(says({ communityBanned: null })).toEqual(['No bans']);
    expect(says({ vacBans: null, gameBans: null })).toEqual(['—']);
  });

  it('names countries', () => {
    expect(countryName('CA')).toBe('Canada');
    expect(countryName(null)).toBe('—');
  });

  it('names the modes', () => {
    const row = (mode: MatchRow['mode'], event: string | null = null) =>
      ({ mode, event }) as MatchRow;
    expect(modeLabel(row('premier'))).toBe('Premier');
    expect(modeLabel(row('competitive'))).toBe('Competitive');
    expect(modeLabel(row('wingman'))).toBe('Wingman');
    expect(modeLabel(row('other', 'iem_cologne_major_2026'))).toBe(
      'IEM Cologne Major 2026'
    );
    expect(modeLabel(row('other'))).toBe('Match');
    // Unknown: nothing, so the row shows only the day.
    expect(modeLabel(row(null))).toBe('');
  });

  it('names a tournament as the server does, on every shared case', () => {
    const cases: { slug: string; name: string }[] = JSON.parse(
      readFileSync(
        new URL(
          '../../server/crates/server/tests/fixtures/events.json',
          import.meta.url
        ),
        'utf8'
      )
    );
    expect(cases.length).toBeGreaterThanOrEqual(20);
    for (const c of cases) expect(eventName(c.slug), c.slug).toBe(c.name);
  });

  it('names a tournament from its slug', () => {
    expect(eventName('iem_cologne_major_2026')).toBe('IEM Cologne Major 2026');
    expect(eventName('blast-premier-spring-final-2026')).toBe(
      'BLAST Premier Spring Final 2026'
    );
    expect(eventName('esl_pro_league_s21')).toBe('ESL Pro League S21');
    expect(eventName('pgl_cct_faceit_esea_epl_cs2')).toBe(
      'PGL CCT FACEIT ESEA EPL CS2'
    );
    expect(eventName('dreamhack_open')).toBe('DreamHack Open');
    expect(eventName('cac2026')).toBe('CS Asia Championships 2026');
    // A name already written as words is left as it is.
    expect(eventName('IEM Cologne 2026')).toBe('IEM Cologne 2026');
    expect(eventName('  perfect__world  ')).toBe('Perfect World');
  });

  it('keeps the strip in rainbow order', () => {
    expect(RAINBOW).toEqual([
      '#ff4d5e',
      '#ff9a3c',
      '#ffd84d',
      '#4be08a',
      '#4cc3ff',
      '#b98cff',
    ]);
  });
});

describe('statsTitle', () => {
  it.each([
    ['skunk', "skunk's CS2 stats"],
    ['Mats', "Mats' CS2 stats"],
    ['BOSS', "BOSS' CS2 stats"],
    ['гость', "гость's CS2 stats"],
  ])(
    "titles %s's profile as their CS2 stats, as pages.rs does",
    (name, title) => {
      expect(statsTitle(name)).toBe(title);
    }
  );
});
