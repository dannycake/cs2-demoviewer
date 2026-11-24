// @vitest-environment jsdom
// The match rows open in place: each row's toggle, a cell of its own before the Replay and named
// by the game's map and day, opens that game's strip, the figures under it and what its replay
// adds directly under the row, one game at a time; a game that is not in the totals says so. A tab
// change or more rows shuts it.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchRow, ReplayTotals } from '../src/api/players';
import { getMatches } from '../src/api/players';
import { formatDay } from '../src/site/format';
import MatchRows from '../src/site/profile/MatchRows';
import { totalsOfRow } from '../src/site/profile/row-totals';

vi.mock('../src/api/players', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/players')>()),
  getMatches: vi.fn(async () => []),
}));

const ID = '76561198000000001';

/** What one game's replay tells. */
const replay: ReplayTotals = {
  matches: 1,
  kills: 20,
  weapons: [
    { weapon: 'ak47', kills: 14 },
    { weapon: 'deagle', kills: 6 },
  ],
  clutches: [1, 0, 0, 0, 0],
  clutchesWon: [1, 0, 0, 0, 0],
  tradeKills: 3,
  tradedDeaths: 2,
  flashAssists: 2,
  enemiesFlashed: 9,
  blindPerRound: 1.2,
  utilityAdr: 6.4,
  plants: 2,
  defuses: 0,
  t: { rounds: 11, kills: 9, deaths: 7, kd: 9 / 7, adr: 80 },
  ct: { rounds: 11, kills: 11, deaths: 7, kd: 11 / 7, adr: 94.6 },
  wallbangs: 1,
  throughSmoke: 0,
  noScopes: 0,
  blindKills: 0,
};

const row = (over: Partial<MatchRow>): MatchRow => ({
  demoId: 'Jnv7rxggBidutAQ2kv4DRv',
  map: 'de_mirage',
  mode: 'competitive',
  event: null,
  playedUnix: 1_790_000_000,
  result: 'w',
  score: [13, 9],
  kills: 20,
  deaths: 14,
  assists: 5,
  adr: 87.3,
  hsPct: 50,
  kastPct: 75,
  rating: 1.24,
  rank: null,
  counted: true,
  openingWon: 2,
  openingLost: 1,
  multiKills: [3, 1, 0, 0],
  rounds: 22,
  kastRounds: 16,
  replay,
  ...over,
});

const ROWS: MatchRow[] = [
  row({ demoId: 'a', mode: 'premier', rating: 1.24 }),
  row({
    demoId: 'b',
    mode: 'competitive',
    rating: 0.87,
    replay: null,
    playedUnix: 1_789_900_000,
  }),
  row({
    demoId: 'c',
    playedUnix: 1_789_800_000,
    mode: 'wingman',
    counted: false,
    rating: 1.55,
    score: [9, 5],
  }),
];

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(getMatches).mockReset();
});

const show = (rows = ROWS, count = rows.length) =>
  render(<MatchRows steamid={ID} first={rows} count={count} />);
/** The row whose Replay links to `demoId`. */
const rowOf = (demoId: string) =>
  screen
    .getByTestId('match-rows')
    .querySelector<HTMLElement>(`a[href="/d/${demoId}"]`)!
    .closest<HTMLElement>('[data-match]')!;
const toggleOf = (demoId: string) =>
  within(rowOf(demoId)).getByRole('button', { name: /^(Show|Hide) .* stats$/ });
/** What a fixture row's toggle and figures are called: its map and day. */
const nameOf = (demoId: string) =>
  `Mirage, ${formatDay(ROWS.find((r) => r.demoId === demoId)!.playedUnix, new Date())}`;
const regions = () => screen.queryAllByRole('region');
const open = (demoId: string) => {
  fireEvent.click(toggleOf(demoId));
  return regions()[0];
};

describe('MatchRows', () => {
  it('heads the tabs with Matches, which also names them', () => {
    show();
    expect(screen.getByRole('heading', { name: 'Matches' })).toBeTruthy();
    expect(screen.getByRole('tablist', { name: 'Matches' })).toBeTruthy();
  });

  it('gives every row a toggle of its own just before the Replay, closed', () => {
    show();
    for (const id of ['a', 'b', 'c']) {
      const r = rowOf(id);
      const t = toggleOf(id);
      expect(t.getAttribute('type')).toBe('button');
      expect(t.getAttribute('aria-expanded')).toBe('false');
      expect(t.getAttribute('aria-label')).toBe(`Show ${nameOf(id)} stats`);
      // A cell of the row, next to the Replay's and not inside it.
      expect(t.parentElement).toBe(r);
      expect(t.nextElementSibling?.getAttribute('href')).toBe(`/d/${id}`);
      expect(t.closest('a')).toBeNull();
      expect(r.tagName).toBe('DIV');
      expect(r.getAttribute('role')).toBeNull();
    }
    expect(regions()).toHaveLength(0);
  });

  it("opens that game's strip, the figures under it and what its replay adds, under its row", () => {
    show();
    const t = toggleOf('a');
    const x = open('a');
    expect(t.getAttribute('aria-expanded')).toBe('true');
    expect(t.getAttribute('aria-label')).toBe(`Hide ${nameOf('a')} stats`);
    expect(x.id).toBe(t.getAttribute('aria-controls'));
    expect(x.getAttribute('aria-label')).toBe(`${nameOf('a')} stats`);
    expect(rowOf('a').nextElementSibling).toBe(x);
    const strip = within(x).getByTestId('stat-strip');
    // Each cell's figure: rating, opening (2 of 3), K/D (20 of 14), ADR, HS% and the one match.
    const figures = [...strip.children].map(
      (c) => c.querySelector('.n')!.textContent
    );
    expect(figures).toEqual(['1.24', '67%', '1.43', '87', '50', '1']);
    expect(within(strip).getByText('2–1')).toBeTruthy();
    const grid = within(x).getByTestId('stat-grid');
    const cell = (label: string) =>
      within(grid)
        .getByText(label, { selector: '[data-label]' })
        .parentElement!.querySelector('.n')!.textContent;
    expect(cell('KAST')).toBe('75%');
    expect(cell('assists')).toBe('5');
    expect(cell('2K')).toBe('3');
    expect(cell('3K')).toBe('1');
    expect(cell('rounds')).toBe('22');
    expect(cell('kills')).toBe('20');
    expect(cell('deaths')).toBe('14');
    expect(cell('record')).toBe('1–0–0');
    // Survived: 8 of 22 rounds.
    expect(cell('survived')).toBe('36%');
    // A row says nothing of how long the game was.
    expect(cell('hours in game')).toBe('—');
    // What its replay adds.
    const weapons = within(x).getByTestId('weapons');
    expect(weapons.textContent).toContain('AK-47');
    expect(within(x).getByTestId('clutches')).toBeTruthy();
    expect(within(x).getByTestId('sides')).toBeTruthy();
    // Counted: no line saying otherwise.
    expect(within(x).queryByText('Not in the totals')).toBeNull();
    fireEvent.click(t);
    expect(regions()).toHaveLength(0);
  });

  it('a game that is not in the totals says so at the top, its figures under it', () => {
    show();
    const x = open('c');
    const note = within(x).getByText('Not in the totals');
    expect(x.firstElementChild).toBe(note);
    expect(within(x).getByTestId('stat-strip').textContent).toContain('1.55');
  });

  it('a game without replay figures leaves their blocks out, as the profile does, its own figures in', () => {
    show();
    const x = open('b');
    expect(within(x).getByTestId('stat-strip').textContent).toContain('0.87');
    expect(within(x).getByTestId('stat-grid')).toBeTruthy();
    for (const id of ['weapons', 'clutches', 'utility', 'sides', 'bomb'])
      expect(within(x).queryByTestId(id)).toBeNull();
  });

  it('a game from before rounds were counted opens to dashes, nothing hidden', () => {
    show([
      row({
        demoId: 'old',
        rating: null,
        adr: null,
        hsPct: null,
        kastPct: null,
        kills: 0,
        deaths: 0,
        assists: 0,
        openingWon: 0,
        openingLost: 0,
        multiKills: [0, 0, 0, 0],
        rounds: 0,
        kastRounds: 0,
        score: null,
        result: null,
        replay: null,
      }),
    ]);
    const x = open('old');
    const strip = within(x).getByTestId('stat-strip');
    expect(
      [...strip.children].map((c) => c.querySelector('.n')!.textContent)
    ).toEqual(['—', '—', '—', '—', '—', '1']);
    const grid = within(x).getByTestId('stat-grid');
    expect(grid.children).toHaveLength(12);
  });

  it("names each toggle by its game's map and day, so a list of them tells the games apart", () => {
    show();
    const names = ['a', 'b', 'c'].map((id) =>
      toggleOf(id).getAttribute('aria-label')
    );
    expect(new Set(names).size).toBe(3);
    expect(names[0]).toMatch(/^Show Mirage, [A-Z][a-z]{2} \d+( \d{4})? stats$/);
    cleanup();
    // A game of unknown day is called by its map alone.
    show([row({ demoId: 'n', playedUnix: null })]);
    expect(toggleOf('n').getAttribute('aria-label')).toBe('Show Mirage stats');
    expect(open('n').getAttribute('aria-label')).toBe('Mirage stats');
  });

  it('keeps one game open: opening another closes the first', () => {
    show();
    open('a');
    fireEvent.click(toggleOf('c'));
    expect(toggleOf('a').getAttribute('aria-expanded')).toBe('false');
    expect(toggleOf('c').getAttribute('aria-expanded')).toBe('true');
    expect(regions()).toHaveLength(1);
    expect(rowOf('c').nextElementSibling).toBe(regions()[0]);
  });

  it('switching tabs closes the open game', () => {
    show();
    open('a');
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    expect(regions()).toHaveLength(0);
    expect(toggleOf('a').getAttribute('aria-expanded')).toBe('false');
    // So does a tab reached by the arrow keys.
    open('a');
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Premier' }), {
      key: 'ArrowLeft',
    });
    expect(regions()).toHaveLength(0);
  });

  it('has a FACEIT tab of the FACEIT matches, and says so when it has none', () => {
    show([
      row({ demoId: 'a' }),
      row({ demoId: 'f', mode: 'faceit', event: null }),
    ]);
    fireEvent.click(screen.getByRole('tab', { name: 'FACEIT' }));
    expect(rowOf('f')).toBeTruthy();
    expect(screen.queryByText('No FACEIT matches here')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Competitive' }));
    expect(screen.queryByText('No FACEIT matches here')).toBeNull();
    cleanup();
    show([row({ demoId: 'a' })]);
    fireEvent.click(screen.getByRole('tab', { name: 'FACEIT' }));
    expect(screen.getByText('No FACEIT matches here')).toBeTruthy();
  });

  it('loading more rows closes the open game', async () => {
    const many = Array.from({ length: 12 }, (_, i) => row({ demoId: `m${i}` }));
    vi.mocked(getMatches).mockImplementation(async () => [
      row({ demoId: 'older' }),
    ]);
    show(many, 13);
    open('m0');
    fireEvent.click(screen.getByRole('button', { name: 'All 13 matches' }));
    expect(regions()).toHaveLength(0);
    await waitFor(() => expect(rowOf('older')).toBeTruthy());
    expect(regions()).toHaveLength(0);
  });

  it("the Replay link of an open game's row keeps its address", () => {
    show();
    const x = open('a');
    const link = within(rowOf('a')).getByRole('link', {
      name: 'Replay Mirage',
    });
    expect(link.getAttribute('href')).toBe('/d/a');
    expect(link.querySelector('svg.play')).not.toBeNull();
    // Nothing in the open figures is a second way into the replay.
    expect(within(x).queryAllByRole('link')).toHaveLength(0);
  });
});

describe('totalsOfRow', () => {
  it('takes K/D as the profile does: kills over deaths, kills alone with no death, none without either', () => {
    expect(totalsOfRow(row({ kills: 20, deaths: 14 })).kd).toBeCloseTo(20 / 14);
    expect(totalsOfRow(row({ kills: 7, deaths: 0 })).kd).toBe(7);
    expect(totalsOfRow(row({ kills: 0, deaths: 3 })).kd).toBe(0);
    expect(totalsOfRow(row({ kills: 0, deaths: 0 })).kd).toBeNull();
  });

  it('is one match: its result as the record, its counts as they are', () => {
    const t = totalsOfRow(row({ result: 'l' }));
    expect([t.matches, t.wins, t.losses, t.ties]).toEqual([1, 0, 1, 0]);
    expect([t.kills, t.deaths, t.assists, t.rounds]).toEqual([20, 14, 5, 22]);
    expect([t.openingWon, t.openingLost]).toEqual([2, 1]);
    expect(t.multiKills).toEqual([3, 1, 0, 0]);
    expect([t.rating, t.adr, t.hsPct, t.kastPct]).toEqual([1.24, 87.3, 50, 75]);
    expect(totalsOfRow(row({ result: 't' })).ties).toBe(1);
    expect(totalsOfRow(row({ result: null })).wins).toBe(0);
  });

  it("counts a summary's rounds from the score when it never counted the player's own, as the profile does", () => {
    const t = totalsOfRow(row({ rounds: 0, deaths: 3, score: [13, 11] }));
    expect(t.rounds).toBe(24);
    // Survival needs the player's own rounds.
    expect(t.survivalPct).toBeNull();
    expect(totalsOfRow(row({ rounds: 0, score: null })).rounds).toBe(0);
  });
});
