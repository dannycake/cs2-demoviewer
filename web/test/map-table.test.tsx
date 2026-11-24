// @vitest-environment jsdom
// The Maps table's rows open in place: each row's last cell is a toggle, a button of its own, that
// opens the map's strip, the figures under it and what the replays add directly under the row,
// one map at a time.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapLine, ReplayTotals, Totals } from '../src/api/players';
import MapTable from '../src/site/profile/MapTable';

const totals = (over: Partial<Totals>): Totals => ({
  rating: 1.0,
  openingWon: 4,
  openingLost: 4,
  kd: 1.0,
  adr: 80,
  hsPct: 40,
  matches: 3,
  kills: 60,
  deaths: 60,
  assists: 12,
  rounds: 66,
  kastPct: 70,
  survivalPct: 30,
  multiKills: [5, 1, 0, 0],
  wins: 2,
  losses: 1,
  ties: 0,
  seconds: 7_200,
  ...over,
});
const replay = (over: Partial<ReplayTotals>): ReplayTotals => ({
  matches: 0,
  kills: 0,
  weapons: [],
  clutches: [0, 0, 0, 0, 0],
  clutchesWon: [0, 0, 0, 0, 0],
  tradeKills: 0,
  tradedDeaths: 0,
  flashAssists: 0,
  enemiesFlashed: 0,
  blindPerRound: null,
  utilityAdr: null,
  plants: 0,
  defuses: 0,
  t: { rounds: 0, kills: 0, deaths: 0, kd: null, adr: null },
  ct: { rounds: 0, kills: 0, deaths: 0, kd: null, adr: null },
  wallbangs: null,
  throughSmoke: null,
  noScopes: null,
  blindKills: null,
  ...over,
});

const MAPS: MapLine[] = [
  {
    map: 'de_mirage',
    matches: 7,
    winPct: 57.1,
    rating: 1.31,
    rank: null,
    totals: totals({ rating: 1.31, matches: 7, kd: 1.27, adr: 91.4 }),
    replay: replay({
      matches: 7,
      kills: 140,
      weapons: [{ weapon: 'ak47', kills: 90 }],
      flashAssists: 6,
    }),
  },
  {
    map: 'de_nuke',
    matches: 3,
    winPct: 33.3,
    rating: 0.94,
    rank: null,
    // From summaries before the replays were read: none of its matches has their figures.
    totals: totals({ rating: 0.94, matches: 3 }),
    replay: replay({}),
  },
];

beforeEach(() => {
  // The site manifest: none, so the rows are plain.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const toggle = (name: RegExp | string) => screen.getByRole('button', { name });
const regions = () => screen.queryAllByRole('region');

/** A key as a browser has it on a focused button: Enter (or Space) clicks it unless the page's
 * own key handler stops it. */
function press(el: HTMLElement, key: string) {
  if (fireEvent.keyDown(el, { key }) && el.tagName === 'BUTTON')
    fireEvent.click(el);
}

describe('MapTable', () => {
  it('ends every row with a toggle that is a button of its own, closed', () => {
    render(<MapTable maps={MAPS} />);
    const rows = [
      ...screen.getByTestId('map-table').querySelectorAll('[data-map]'),
    ];
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      const last = r.lastElementChild as HTMLElement;
      expect(last.tagName).toBe('BUTTON');
      expect(last.getAttribute('type')).toBe('button');
      expect(last.getAttribute('aria-expanded')).toBe('false');
      // The row itself is not a button.
      expect(r.tagName).toBe('DIV');
      expect(r.getAttribute('role')).toBeNull();
    }
    expect(toggle('Show Mirage stats')).toBeTruthy();
    expect(toggle('Show Nuke stats')).toBeTruthy();
    expect(regions()).toHaveLength(0);
  });

  it("opens a map's strip, the figures under it and what the replays add, under its row", () => {
    render(<MapTable maps={MAPS} />);
    const mirage = toggle('Show Mirage stats');
    fireEvent.click(mirage);
    expect(mirage.getAttribute('aria-expanded')).toBe('true');
    expect(mirage.getAttribute('aria-label')).toBe('Hide Mirage stats');
    const [open] = regions();
    expect(open.id).toBe(mirage.getAttribute('aria-controls'));
    // Directly after its row, not inside it.
    expect(mirage.closest('[data-map]')!.nextElementSibling).toBe(open);
    const strip = within(open).getByTestId('stat-strip');
    expect(within(strip).getByText('1.31')).toBeTruthy();
    expect(within(strip).getByText('1.27')).toBeTruthy();
    expect(within(strip).getByText('91')).toBeTruthy();
    expect(within(open).getByTestId('stat-grid')).toBeTruthy();
    expect(within(open).getByTestId('weapons')).toBeTruthy();
    expect(within(open).getByTestId('utility')).toBeTruthy();
    // Shut again by the same toggle.
    fireEvent.click(mirage);
    expect(mirage.getAttribute('aria-expanded')).toBe('false');
    expect(mirage.getAttribute('aria-label')).toBe('Show Mirage stats');
    expect(regions()).toHaveLength(0);
  });

  it('keeps one map open: opening another closes the first', () => {
    render(<MapTable maps={MAPS} />);
    const mirage = toggle('Show Mirage stats');
    const nuke = toggle('Show Nuke stats');
    fireEvent.click(mirage);
    fireEvent.click(nuke);
    expect(mirage.getAttribute('aria-expanded')).toBe('false');
    expect(nuke.getAttribute('aria-expanded')).toBe('true');
    expect(regions()).toHaveLength(1);
    expect(
      within(regions()[0]).getByTestId('stat-strip').textContent
    ).toContain('0.94');
  });

  it('opens on Enter at the focused toggle', () => {
    render(<MapTable maps={MAPS} />);
    const mirage = toggle('Show Mirage stats');
    mirage.focus();
    expect(document.activeElement).toBe(mirage);
    press(mirage, 'Enter');
    expect(mirage.getAttribute('aria-expanded')).toBe('true');
    expect(regions()).toHaveLength(1);
    // Focus stays on the toggle, so Enter again shuts it.
    expect(document.activeElement).toBe(mirage);
    press(mirage, 'Enter');
    expect(regions()).toHaveLength(0);
  });

  it('a map none of whose matches the replays have read leaves their blocks out, as the profile does', () => {
    render(<MapTable maps={MAPS} />);
    fireEvent.click(toggle('Show Nuke stats'));
    const [open] = regions();
    expect(within(open).getByTestId('stat-strip')).toBeTruthy();
    expect(within(open).getByTestId('stat-grid')).toBeTruthy();
    for (const id of ['weapons', 'clutches', 'utility', 'sides', 'bomb'])
      expect(within(open).queryByTestId(id)).toBeNull();
  });

  it('an empty table has no toggle', () => {
    render(<MapTable maps={[]} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
