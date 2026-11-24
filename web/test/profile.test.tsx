// @vitest-environment jsdom
// The profile page (site/profile): the same blocks for every player, "—" where a value is unknown,
// the rainbow stat strip and the white figures under it, who they played with, the Premier and
// Competitive tabs, and the hidden and not-found pages.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MatchRow,
  Profile,
  ReplayTotals,
  Totals,
} from '../src/api/players';
import { getMatches, HiddenProfileError } from '../src/api/players';
import { ApiError } from '../src/api/demos';
import { siteAssets } from '../src/api/site-assets';
import { DASH, RAINBOW } from '../src/site/format';
import ProfileView from '../src/site/profile/ProfileView';
import { dropPre, preShown, putPre } from './helpers/pre';

const api = vi.hoisted(() => ({
  profile: null as unknown,
  /** Answers given one per call before `profile` (a promise is waited on). */
  queue: [] as unknown[],
  lookup: null as unknown,
}));
vi.mock('../src/api/players', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api/players')>()),
  getProfile: vi.fn(async () => {
    const next = api.queue.length ? await api.queue.shift() : api.profile;
    if (next instanceof Error) throw next;
    return next;
  }),
  getMatches: vi.fn(async () => []),
  lookup: vi.fn(async () => {
    if (api.lookup instanceof Error) throw api.lookup;
    return api.lookup;
  }),
}));

const ID = '76561198000000001';
/** A rank a row's player had: Premier (11) or Competitive (12). */
const held = (kind: number, value: number): MatchRow['rank'] => ({
  kind,
  value,
  wins: 0,
  if_win: 0,
  if_loss: 0,
  if_tie: 0,
});
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
  multiKills: [1, 0, 0, 0],
  rounds: 22,
  kastRounds: 16,
  replay: null,
  ...over,
});
/** What the replays tell, over all 31 counted matches. */
const replay: ReplayTotals = {
  matches: 31,
  kills: 412,
  weapons: [
    { weapon: 'ak47', kills: 160 },
    { weapon: 'm4a1_silencer', kills: 80 },
    { weapon: 'awp', kills: 40 },
    { weapon: 'glock', kills: 20 },
    { weapon: 'knife', kills: 3 },
    { weapon: 'hegrenade', kills: 2 },
    { weapon: 'inferno', kills: 2 },
    { weapon: 'planted_c4', kills: 1 },
  ],
  clutches: [10, 6, 3, 1, 0],
  clutchesWon: [6, 2, 1, 0, 0],
  tradeKills: 31,
  tradedDeaths: 24,
  flashAssists: 12,
  enemiesFlashed: 140,
  blindPerRound: 0.84,
  utilityAdr: 7.6,
  plants: 17,
  defuses: 1,
  t: { rounds: 320, kills: 200, deaths: 150, kd: 200 / 150, adr: 84.2 },
  ct: { rounds: 320, kills: 212, deaths: 148, kd: 212 / 148, adr: 90.1 },
  wallbangs: 9,
  throughSmoke: 4,
  noScopes: 2,
  blindKills: null,
};
/** A profile none of whose summaries has the replay's stats. */
const noReplay: ReplayTotals = {
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
};
/** The blocks the replays add, in order. */
const REPLAY_BLOCKS = [
  'weapons',
  'clutches',
  'utility',
  'sides',
  'bomb',
  'trades',
  'kill-kinds',
];
const fullTotals: Totals = {
  rating: 1.12,
  openingWon: 21,
  openingLost: 15,
  kd: 1.4,
  adr: 87.2,
  hsPct: 48.4,
  matches: 31,
  kills: 412,
  deaths: 298,
  assists: 87,
  rounds: 640,
  kastPct: 72.4,
  survivalPct: 41.2,
  multiKills: [41, 9, 2, 1],
  wins: 18,
  losses: 11,
  ties: 2,
  seconds: 61_200,
};

const full: Profile = {
  steamid: ID,
  name: 'skunk',
  avatar: null,
  steam: {
    sinceYear: 2004,
    country: 'CA',
    cs2Hours: 184,
    cs2RecentMinutes: 725,
    level: 42,
    vacBans: 0,
    gameBans: 0,
    communityBanned: false,
    tradeBan: null,
    daysSinceLastBan: null,
  },
  tracking: 'off',
  premier: { rating: 18650, wins: 31, demoId: 'x' },
  competitive: { map: 'de_dust2', rank: 9 },
  totals: fullTotals,

  replay,
  maps: [
    {
      map: 'de_dust2',
      matches: 12,
      winPct: 58.3,
      rating: 1.18,
      rank: 9,
      totals: fullTotals,
      replay,
    },
  ],
  mates: [
    { steamid: '76561198000000002', name: 'mate one', matches: 12, wins: 8 },
    { steamid: '76561198000000003', name: 'mate two', matches: 3, wins: 1 },
  ],
  matches: [
    row({ demoId: 'a', mode: 'premier' }),
    row({ demoId: 'b', mode: 'competitive' }),
    row({ demoId: 'c', mode: 'wingman' }),
    row({ demoId: 'd', mode: 'other', event: 'cac2026' }),
  ],
  matchCount: 4,
};
const empty: Profile = {
  steamid: ID,
  name: 'private',
  avatar: null,
  steam: {
    sinceYear: null,
    country: null,
    cs2Hours: null,
    cs2RecentMinutes: null,
    level: null,
    vacBans: 0,
    gameBans: 0,
    communityBanned: false,
    tradeBan: null,
    daysSinceLastBan: null,
  },
  tracking: 'off',
  premier: null,
  competitive: null,
  totals: {
    rating: null,
    openingWon: 0,
    openingLost: 0,
    kd: null,
    adr: null,
    hsPct: null,
    matches: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    rounds: 0,
    kastPct: null,
    survivalPct: null,
    multiKills: [0, 0, 0, 0],
    wins: 0,
    losses: 0,
    ties: 0,
    seconds: 0,
  },
  replay: noReplay,
  maps: [],
  mates: [],
  matches: [],
  matchCount: 0,
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 404 }))
  );
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dropPre();
});

const show = async (
  profile: unknown,
  ref = { kind: 'steamid' as const, id: ID }
) => {
  api.profile = profile;
  render(<ProfileView profile={ref} />);
};

describe('ProfileView while it loads', () => {
  afterEach(() => {
    api.queue = [];
    vi.useRealTimers();
  });

  it('shows a loading bar until the profile is in', async () => {
    let answer!: (p: Profile) => void;
    api.queue = [new Promise<Profile>((r) => (answer = r))];
    render(<ProfileView profile={{ kind: 'steamid', id: ID }} />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    // Steam's facts are dashed while they are asked for; whose they are is not known yet.
    expect(screen.getByTestId('who').textContent).toContain('— on Steam');
    expect(screen.queryByRole('link', { name: 'Steam profile' })).toBeNull();
    answer(full);
    expect(await screen.findByText('2004')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('link', { name: 'Steam profile' })).toBeTruthy();
  });

  it('shows what the server holds at once, then asks again until Steam has filled in', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.queue = [
      {
        ...full,
        name: 'from a match',
        steam: empty.steam,
        steamPending: true,
      },
    ];
    api.profile = { ...full, steamPending: false };
    render(<ProfileView profile={{ kind: 'steamid', id: ID }} />);
    expect(await screen.findByText('Asking Steam…')).toBeTruthy();
    expect(screen.getByText('from a match')).toBeTruthy();
    const who = screen.getByTestId('who');
    expect(who.textContent).toContain('— on Steam');
    expect(who.textContent).toContain('from —');
    expect(who.textContent).toContain('— hours in CS2');
    expect(screen.getByText('1.12')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    await vi.advanceTimersByTimeAsync(2100);
    expect(await screen.findByText('2004')).toBeTruthy();
    expect(screen.getByText('skunk')).toBeTruthy();
    expect(screen.queryByText('Asking Steam…')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });
});

describe('ProfileView', () => {
  it('renders the strip in rainbow order', async () => {
    await show(full);
    const strip = await screen.findByTestId('stat-strip');
    await waitFor(() => expect(within(strip).getByText('1.12')).toBeTruthy());
    const stats = [...strip.children] as HTMLElement[];
    expect(
      stats.map((s) => s.querySelector('[data-label]')?.textContent)
    ).toEqual(['rating', 'opening', 'K/D', 'ADR', 'HS%', 'matches']);
    expect(stats.map((s) => s.querySelector('.n')?.textContent)).toEqual([
      '1.12',
      '58%',
      '1.40',
      '87',
      '48',
      '31',
    ]);
    stats.forEach((s, i) =>
      expect((s.querySelector('.n') as HTMLElement).style.color).toBe(
        hexToRgb(RAINBOW[i])
      )
    );
    expect(screen.getByText('2004')).toBeTruthy();
    expect(screen.getByText('Canada')).toBeTruthy();
    expect(screen.getByText('18')).toBeTruthy(); // the Premier badge: 18 ,650
  });

  it('says “1 match”, not “1 matches”', async () => {
    await show({ ...full, totals: { ...full.totals, matches: 1 } });
    const strip = await screen.findByTestId('stat-strip');
    await waitFor(() => expect(within(strip).getByText('1.12')).toBeTruthy());
    expect(strip.lastElementChild?.textContent).toBe('1match');
  });

  it('says nothing under the strip about how the rating is made', async () => {
    await show(full);
    await screen.findByText('1.12');
    expect(screen.queryByText(/rating weighs/)).toBeNull();
  });

  it('a private profile keeps every block with dashes', async () => {
    await show(empty);
    await screen.findByText('private');
    const who = screen.getByTestId('who');
    // Steam has answered: what it does not give is left out, not dashed.
    expect(
      [...who.querySelectorAll('[data-fact]')].map((f) => f.textContent)
    ).toEqual(['No bans']);
    expect(who.textContent).not.toContain('—');
    const strip = screen.getByTestId('stat-strip');
    expect([...strip.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(
      ['—', '—', '—', '—', '—', '0']
    );
    expect(screen.getByTestId('map-table')).toBeTruthy();
    expect(screen.getByTestId('ranks')).toBeTruthy();
    expect(screen.getByText('No matches here')).toBeTruthy();
    const figures = screen.getByTestId('stat-grid');
    expect(
      [...figures.children].map((c) => c.querySelector('.n')?.textContent)
    ).toEqual(['—', '—', '0', '0–0–0', '0', '0', '0', '0', '0', '0', '0', '0']);
    expect(figures.textContent).not.toContain('won');
    expect(screen.queryByTestId('mates')).toBeNull();
  });

  it('shows Steam’s level and the last two weeks beside the other facts, numbers in figures', async () => {
    await show(full);
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('42 Steam level'));
    const facts = [...who.querySelectorAll('[data-fact]')].map(
      (f) => f.textContent
    );
    expect(facts).toEqual([
      '2004 on Steam',
      'from Canada',
      '42 Steam level',
      '184 hours in CS2',
      '12 hours in 2 weeks',
      'No bans',
    ]);
    expect([...who.querySelectorAll('.n')].map((n) => n.textContent)).toEqual([
      '2004',
      '42',
      '184',
      '12',
    ]);
  });

  it('spells out a banned player’s bans, and how long ago the last was', async () => {
    await show({
      ...full,
      steam: {
        ...full.steam,
        vacBans: 1,
        gameBans: 2,
        communityBanned: true,
        tradeBan: 'probation',
        daysSinceLastBan: 400,
      },
    });
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('VAC'));
    const facts = [...who.querySelectorAll('[data-fact]')].map(
      (f) => f.textContent
    );
    expect(facts.slice(5)).toEqual([
      '1 VAC ban',
      '2 game bans',
      'Community ban',
      'Trade probation',
      'last ban 400 days ago',
    ]);
    expect(who.textContent).not.toContain('No bans');
    expect([...who.querySelectorAll('.n')].map((n) => n.textContent)).toEqual([
      '2004',
      '42',
      '184',
      '12',
      '1',
      '2',
      '400',
    ]);
  });

  it('writes a trade ban, and a ban today', async () => {
    await show({
      ...full,
      steam: {
        ...full.steam,
        vacBans: 1,
        tradeBan: 'banned',
        daysSinceLastBan: 0,
      },
    });
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('VAC'));
    expect(who.textContent).toContain('Trade ban');
    expect(who.textContent).toContain('last ban today');
  });

  it('writes under ten hours in two weeks to a tenth', async () => {
    await show({ ...full, steam: { ...full.steam, cs2RecentMinutes: 45 } });
    const who = await screen.findByTestId('who');
    await waitFor(() =>
      expect(who.textContent).toContain('0.8 hours in 2 weeks')
    );
  });

  it('leaves out bans Steam did not say, once it has answered', async () => {
    await show({
      ...full,
      steam: { ...empty.steam, vacBans: null, gameBans: null },
    });
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('Not tracked'));
    expect(who.querySelectorAll('[data-fact]')).toHaveLength(0);
    expect(who.textContent).not.toContain('—');
  });

  it('links the player’s Steam profile in a new tab, and no FACEIT profile without one', async () => {
    await show({ ...full, faceit: null });
    const who = await screen.findByTestId('who');
    const steam = within(who).getByRole('link', { name: 'Steam profile' });
    expect(steam.getAttribute('href')).toBe(
      `https://steamcommunity.com/profiles/${ID}`
    );
    expect(steam.getAttribute('target')).toBe('_blank');
    expect(steam.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(who).getAllByRole('link')).toHaveLength(1);
    expect(who.textContent).not.toContain('FACEIT');
  });

  it('links the Steam profile of a player Steam has said nothing of, as of a server from before FACEIT', async () => {
    // `empty` has no `faceit`, as a server from before FACEIT sends.
    await show({ ...empty, name: 'from a match' });
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('from a match'));
    expect(
      within(who)
        .getByRole('link', { name: 'Steam profile' })
        .getAttribute('href')
    ).toBe(`https://steamcommunity.com/profiles/${ID}`);
    expect(who.textContent).not.toContain('FACEIT');
  });

  it('links their FACEIT profile in a new tab, its mark, level and Elo beside it in figures', async () => {
    await show({
      ...full,
      faceit: {
        nickname: 'kebab/ ok',
        level: 10,
        elo: 3609,
        playerId: null,
        winsPct: null,
        matches: null,
      },
    });
    const who = await screen.findByTestId('who');
    const faceit = within(who).getByRole('link', { name: /FACEIT/ });
    expect(faceit.getAttribute('href')).toBe(
      'https://www.faceit.com/en/players/kebab%2F%20ok'
    );
    expect(faceit.getAttribute('target')).toBe('_blank');
    expect(faceit.getAttribute('rel')).toBe('noopener noreferrer');
    expect(faceit.getAttribute('data-link')).toBe('faceit');
    // A button as Steam's is: the same cell, its mark first.
    const steam = within(who).getByRole('link', { name: 'Steam profile' });
    expect(faceit.className).toBe(steam.className);
    const mark = faceit.querySelector('img');
    expect(mark?.getAttribute('src')).toBe('/faceit.svg');
    expect(mark?.getAttribute('alt')).toBe('');
    expect([mark?.getAttribute('width'), mark?.getAttribute('height')]).toEqual(
      ['16', '16']
    );
    expect(faceit.firstElementChild).toBe(mark);
    expect(faceit.textContent).toBe('FACEIT · Level 10 · 3,609 Elo');
    expect(
      [...faceit.querySelectorAll('.n')].map((n) => n.textContent)
    ).toEqual(['10', '3,609']);
    // Not one of Steam's facts; no stats without FACEIT's win rate and match count.
    expect(faceit.closest('[data-fact]')).toBeNull();
    expect(faceit.hasAttribute('data-fact')).toBe(false);
    expect(who.querySelector('[data-faceit-stats]')).toBeNull();
    expect(who.textContent).not.toContain('wins');
  });

  it('a FACEIT account without a CS2 level or Elo says only what it has', async () => {
    const quiet = {
      nickname: 'quiet',
      playerId: null,
      winsPct: null,
      matches: null,
    };
    for (const [level, elo, words] of [
      [4, null, 'FACEIT · Level 4'],
      [null, 1540, 'FACEIT · 1,540 Elo'],
      [null, null, 'FACEIT profile'],
    ] as const) {
      cleanup();
      await show({ ...full, faceit: { ...quiet, level, elo } });
      const who = await screen.findByTestId('who');
      await waitFor(() =>
        expect(
          within(who).getByRole('link', { name: /FACEIT/ }).textContent
        ).toBe(words)
      );
      expect(who.textContent).not.toContain('—');
      expect(
        within(who)
          .getByRole('link', { name: /FACEIT/ })
          .querySelector('img[src="/faceit.svg"]')
      ).not.toBeNull();
    }
  });

  it('beside the FACEIT button, their lifetime win rate and match count when FACEIT gives both', async () => {
    const account = {
      nickname: 'alpha',
      level: 10,
      elo: 3609,
      playerId: 'a1b2c3d4-0000-4000-8000-000000000001',
    };
    await show({
      ...full,
      faceit: { ...account, winsPct: 61, matches: 1204 },
    });
    const who = await screen.findByTestId('who');
    const faceit = within(who).getByRole('link', { name: /FACEIT/ });
    const stats = who.querySelector('[data-faceit-stats]');
    expect(stats?.textContent).toBe('61% wins · 1,204 matches');
    expect([...stats!.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(
      ['61%', '1,204']
    );
    // Its own cell, right after the button, and not one of Steam's facts.
    expect(faceit.nextElementSibling).toBe(stats);
    expect(stats?.hasAttribute('data-fact')).toBe(false);
    // Only with both: one alone is no cell, and never a dash.
    for (const [winsPct, matches] of [
      [61, null],
      [null, 1204],
      [null, null],
    ] as const) {
      cleanup();
      await show({ ...full, faceit: { ...account, winsPct, matches } });
      const again = await screen.findByTestId('who');
      await waitFor(() =>
        expect(within(again).getByRole('link', { name: /FACEIT/ })).toBeTruthy()
      );
      expect(again.querySelector('[data-faceit-stats]')).toBeNull();
      expect(again.textContent).not.toContain('wins');
      expect(again.textContent).not.toContain('—');
    }
  });

  it('a profile kept before Steam’s level and every kind of ban leaves those out', async () => {
    await show({
      ...full,
      steam: {
        ...full.steam,
        cs2RecentMinutes: null,
        level: null,
        communityBanned: null,
        tradeBan: null,
        daysSinceLastBan: null,
      },
    });
    const who = await screen.findByTestId('who');
    await waitFor(() => expect(who.textContent).toContain('2004'));
    expect(
      [...who.querySelectorAll('[data-fact]')].map((f) => f.textContent)
    ).toEqual(['2004 on Steam', 'from Canada', '184 hours in CS2', 'No bans']);
  });

  it('shows the figures under the strip, in white', async () => {
    await show(full);
    const figures = await screen.findByTestId('stat-grid');
    await waitFor(() => expect(within(figures).getByText('412')).toBeTruthy());
    const cells = [...figures.children] as HTMLElement[];
    expect(
      cells.map((c) => c.querySelector('[data-label]')?.textContent)
    ).toEqual([
      'KAST',
      'survived',
      'assists',
      'record',
      '2K',
      '3K',
      '4K',
      'ace',
      'rounds',
      'kills',
      'deaths',
      'hours in game',
    ]);
    expect(cells.map((c) => c.querySelector('.n')?.textContent)).toEqual([
      '72%',
      '41%',
      '87',
      '18–11–2',
      '41',
      '9',
      '2',
      '1',
      '640',
      '412',
      '298',
      '17',
    ]);
    // The win share under the record: 18 of 31.
    expect(cells[3].textContent).toContain('58% won');
    // White: no colour of their own, so not the strip's rainbow.
    for (const n of figures.querySelectorAll<HTMLElement>('.n'))
      expect(n.style.color).toBe('');
    expect(cells[0].querySelector('.pct')?.textContent).toBe('%');
  });

  it('lists the weapons the player kills most with, by the game’s names, with their share of kills', async () => {
    await show(full);
    const block = await screen.findByTestId('weapons');
    expect(within(block).getByText('Weapons')).toBeTruthy();
    const rows = [...block.querySelectorAll<HTMLElement>('[data-weapon]')];
    expect(
      rows.map((r) => r.querySelector('[data-name]')?.textContent)
    ).toEqual([
      'AK-47',
      'M4A1-S',
      'AWP',
      'Glock-18',
      'Knife',
      'HE grenade',
      'Fire',
      'Bomb',
    ]);
    expect(
      [...rows[0].querySelectorAll('.n')].map((n) => n.textContent)
    ).toEqual(['160', '39%']);
    expect(rows[0].textContent).toContain('kills');
    expect(rows[0].textContent).toContain('of kills');
    // Red fills each share's cell as far as the share goes (`.share`), so the largest shows.
    expect(
      rows
        .slice(0, 2)
        .map((r) =>
          r
            .querySelector<HTMLElement>('[data-share]')
            ?.style.getPropertyValue('--share')
        )
    ).toEqual([`${(100 * 160) / 412}%`, `${(100 * 80) / 412}%`]);
    expect(within(rows[7]).getByText('kill')).toBeTruthy();
    // Each with its silhouette, as the kill feed draws it (beside its name, so not read out
    // again); fire and the bomb have none, and are not named twice for it.
    expect(rows.map((r) => r.querySelector('[data-icon]') !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
    expect(
      rows[0].querySelector('[data-icon]')?.getAttribute('aria-hidden')
    ).toBe('true');
    expect(rows[6].textContent!.match(/Fire/g)).toHaveLength(1);
    // After the figures under the strip, before the maps; then the rest in order.
    const order = ['stat-grid', ...REPLAY_BLOCKS, 'map-table'].map((id) =>
      screen.getByTestId(id)
    );
    for (let i = 1; i < order.length; i++)
      expect(
        order[i - 1].compareDocumentPosition(order[i]) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
  });

  it('shows clutches won of played, in all and 1v1 to 1v5', async () => {
    await show(full);
    const block = await screen.findByTestId('clutches');
    expect(within(block).getByText('Clutches')).toBeTruthy();
    const cells = [...block.querySelectorAll<HTMLElement>('[data-cell]')];
    expect(cells.map((c) => c.querySelector('.n')?.textContent)).toEqual([
      '9/20',
      '6/10',
      '2/6',
      '1/3',
      '0/1',
      '0/0',
    ]);
    expect(
      cells.map((c) => c.querySelector('[data-label]')?.textContent)
    ).toEqual(['won', '1v1', '1v2', '1v3', '1v4', '1v5']);
    // The clutches won stand out; how many were played is set back.
    expect(cells.map((c) => c.querySelector('[data-of]')?.textContent)).toEqual(
      ['/20', '/10', '/6', '/3', '/1', '/0']
    );
  });

  it('shows the utility: flash assists, enemies flashed, blindness and damage a round', async () => {
    await show(full);
    const block = await screen.findByTestId('utility');
    expect(within(block).getByText('Utility')).toBeTruthy();
    const cells = [...block.querySelectorAll<HTMLElement>('[data-cell]')];
    expect(cells.map((c) => c.querySelector('.n')?.textContent)).toEqual([
      '12',
      '140',
      '0.8',
      '8',
    ]);
    expect(
      cells.map((c) => c.querySelector('[data-label]')?.textContent)
    ).toEqual([
      'flash assists',
      'enemies flashed',
      's blind per round',
      'utility ADR',
    ]);
  });

  it('shows each side’s K/D, ADR and rounds, under a heading', async () => {
    await show(full);
    const block = await screen.findByTestId('sides');
    expect(block.querySelector('h2')?.textContent).toBe('Sides');
    const rows = [...block.querySelectorAll<HTMLElement>('[data-side]')];
    expect(rows.map((r) => r.firstElementChild?.textContent)).toEqual([
      'T side',
      'CT side',
    ]);
    expect(
      [...rows[0].querySelectorAll('.n')].map((n) => n.textContent)
    ).toEqual(['1.33', '84', '320']);
    expect(
      [...rows[1].querySelectorAll('.n')].map((n) => n.textContent)
    ).toEqual(['1.43', '90', '320']);
    expect(rows[0].textContent).toContain('K/D');
    expect(rows[0].textContent).toContain('ADR');
    expect(rows[0].textContent).toContain('rounds');
  });

  it('shows the bomb, the trades and the kinds of kill the replays say', async () => {
    await show(full);
    const figures = (id: string) =>
      [
        ...screen.getByTestId(id).querySelectorAll<HTMLElement>('[data-cell]'),
      ].map((c) => c.textContent);
    await screen.findByTestId('bomb');
    expect(figures('bomb')).toEqual(['17plants', '1defuse']);
    expect(figures('trades')).toEqual(['31trade kills', '24deaths traded']);
    // Kills while blind are unknown: left out, not dashed.
    expect(figures('kill-kinds')).toEqual([
      '9wallbangs',
      '4through smoke',
      '2no-scopes',
    ]);
    expect(
      within(screen.getByTestId('kill-kinds')).getByText('Kills')
    ).toBeTruthy();
  });

  it('sets the replays’ figures in white', async () => {
    await show(full);
    await screen.findByTestId('weapons');
    for (const id of REPLAY_BLOCKS)
      for (const n of screen
        .getByTestId(id)
        .querySelectorAll<HTMLElement>('.n'))
        expect(n.style.color, id).toBe('');
  });

  it('leaves out every block the replays add when no match has them', async () => {
    await show({ ...full, replay: noReplay });
    await screen.findByTestId('stat-grid');
    for (const id of REPLAY_BLOCKS)
      expect(screen.queryByTestId(id), id).toBeNull();
  });

  it('leaves out a block with nothing to show', async () => {
    await show({
      ...full,
      replay: {
        ...replay,
        weapons: [],
        clutches: [0, 0, 0, 0, 0],
        clutchesWon: [0, 0, 0, 0, 0],
        wallbangs: null,
        throughSmoke: null,
        noScopes: null,
      },
    });
    await screen.findByTestId('utility');
    for (const id of ['weapons', 'clutches', 'kill-kinds'])
      expect(screen.queryByTestId(id), id).toBeNull();
    for (const id of ['sides', 'bomb', 'trades'])
      expect(screen.getByTestId(id), id).toBeTruthy();
  });

  it('says over how many matches the replays’ figures are when not all', async () => {
    await show({ ...full, replay: { ...replay, matches: 20 } });
    const block = await screen.findByTestId('weapons');
    expect(block.querySelector('h2')?.textContent).toBe(
      'Weapons20 of 31 matches'
    );
    cleanup();
    await show(full);
    const all = await screen.findByTestId('weapons');
    expect(all.querySelector('h2')?.textContent).toBe('Weapons');
  });

  it('draws no share behind a weapon when the kills are unknown', async () => {
    await show({ ...full, replay: { ...replay, kills: 0 } });
    const block = await screen.findByTestId('weapons');
    const share = block.querySelector<HTMLElement>('[data-share]');
    expect(share?.style.getPropertyValue('--share')).toBe('');
    expect(share?.textContent).toContain(DASH);
  });

  it('writes under ten hours in game to a tenth', async () => {
    await show({ ...full, totals: { ...full.totals, seconds: 5_400 } });
    const figures = await screen.findByTestId('stat-grid');
    await waitFor(() => expect(within(figures).getByText('1.5')).toBeTruthy());
  });

  it("a map left open shuts when another player's profile takes the page", async () => {
    // The app keeps one ProfileView across /profiles/ links (a teammate's, say).
    const other = '76561198000000009';
    api.profile = full;
    const { rerender } = render(
      <ProfileView profile={{ kind: 'steamid', id: ID }} />
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Show Dust II stats' })
    );
    expect(screen.getAllByRole('region')).toHaveLength(1);
    api.profile = { ...full, steamid: other, name: 'someone else' };
    rerender(<ProfileView profile={{ kind: 'steamid', id: other }} />);
    await screen.findByText('someone else');
    expect(
      screen
        .getByRole('button', { name: 'Show Dust II stats' })
        .getAttribute('aria-expanded')
    ).toBe('false');
    expect(screen.queryAllByRole('region')).toHaveLength(0);
  });

  it('heads the maps, as every other table', async () => {
    await show(full);
    const maps = await screen.findByTestId('map-table');
    expect(maps.querySelector('h2')?.textContent).toBe('Maps');
    cleanup();
    await show(empty);
    const none = await screen.findByTestId('map-table');
    expect(none.querySelector('h2')?.textContent).toBe('Maps');
  });

  it('lists who they played with after the maps, each linking to their profile', async () => {
    await show(full);
    const mates = await screen.findByTestId('mates');
    expect(within(mates).getByText('Played with')).toBeTruthy();
    const links = within(mates).getAllByRole('link');
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['mate one', '/profiles/76561198000000002'],
      ['mate two', '/profiles/76561198000000003'],
    ]);
    const first = links[0].closest<HTMLElement>('[data-mate]')!;
    expect([...first.querySelectorAll('.n')].map((n) => n.textContent)).toEqual(
      ['12', '8', '67%']
    );
    expect(first.textContent).toContain('matches');
    const second = links[1].closest<HTMLElement>('[data-mate]')!;
    expect(within(second).getByText('win')).toBeTruthy();
    expect(within(second).queryByText('wins')).toBeNull();
    // After the map table, before the matches.
    const map = screen.getByTestId('map-table');
    expect(
      map.compareDocumentPosition(mates) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      mates.compareDocumentPosition(screen.getByTestId('match-rows')) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('shows a tracked player’s FACEIT history under the match list, and none without one', async () => {
    await show({
      ...full,
      tracking: 'on',
      faceitHistory: [
        {
          matchId: '1-a',
          finishedUnix: 1_790_000_000,
          map: 'de_nuke',
          score: [13, 9],
          won: true,
          competition: 'CS2 5v5',
          replay: 'Jnv7rxggBidutAQ2kv4DRv',
          roomUrl: 'https://www.faceit.com/en/cs2/room/1-a',
        },
      ],
    });
    const block = await screen.findByTestId('faceit-history');
    const link = within(block).getByRole('link', { name: 'Replay' });
    expect(link.getAttribute('href')).toBe('/d/Jnv7rxggBidutAQ2kv4DRv');
    expect(link.querySelector('svg.play')).not.toBeNull();
    expect(
      screen.getByTestId('match-rows').compareDocumentPosition(block) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    cleanup();
    await show(full);
    await screen.findByText('skunk');
    expect(screen.queryByTestId('faceit-history')).toBeNull();
  });

  it('a match row shows ADR, HS% and KAST where the score shows, not on a phone', async () => {
    await show({ ...full, matches: [row({ demoId: 'a' })] });
    await screen.findByText('skunk');
    const rows = screen.getByTestId('match-rows');
    const cell = (label: string) =>
      within(rows).getByText(label, { selector: 'span' }).parentElement!;
    expect(cell('ADR').querySelector('.n')?.textContent).toBe('87');
    expect(cell('HS%').querySelector('.n')?.textContent).toBe('50');
    expect(cell('KAST').querySelector('.n')?.textContent).toBe('75%');
    // Shown as the score is: on a desktop only.
    const wide = cell('score').className;
    for (const label of ['ADR', 'HS%', 'KAST'])
      expect(cell(label).className).toContain(wide);
  });

  it('a match row without a known ADR, HS% or KAST dashes them', async () => {
    await show({
      ...full,
      matches: [row({ demoId: 'a', adr: null, hsPct: null, kastPct: null })],
    });
    await screen.findByText('skunk');
    const rows = screen.getByTestId('match-rows');
    const cell = (label: string) =>
      within(rows).getByText(label, { selector: 'span' }).parentElement!;
    for (const label of ['ADR', 'HS%', 'KAST'])
      expect(cell(label).querySelector('.n')?.textContent).toBe('—');
  });

  it('a match of unknown mode shows only its day, with no dash', async () => {
    await show({
      ...full,
      matches: [row({ demoId: 'n', mode: null, playedUnix: 1_792_000_000 })],
    });
    await screen.findByText('skunk');
    const rows = screen.getByTestId('match-rows');
    expect(rows.querySelector('small')?.textContent).toMatch(
      /^[A-Z][a-z]{2} \d/
    );
    expect(rows.querySelector('small')?.textContent).not.toContain('—');
  });

  it('a tournament match names its event in words, its day in a part of its own', async () => {
    await show({
      ...full,
      matches: [
        row({
          demoId: 'e',
          mode: 'other',
          event: 'iem_cologne_major_2026',
          playedUnix: 1_792_000_000,
        }),
      ],
    });
    await screen.findByText('skunk');
    const small = screen.getByTestId('match-rows').querySelector('small')!;
    expect(small.textContent).toMatch(
      /^IEM Cologne Major 2026, [A-Z][a-z]{2} \d/
    );
    // The event gives way in a narrow row; the day never does.
    expect(small.querySelector('[data-mode]')?.textContent).toBe(
      'IEM Cologne Major 2026,'
    );
    expect(small.querySelector('[data-day]')?.textContent).toMatch(
      /^[A-Z][a-z]{2} \d/
    );
  });

  // WAI-ARIA's tabs: one stop for Tab (the tab shown), the arrow keys (and Home and End) between
  // them, each shown as it is reached; the panel named by the tab that shows it.
  it('the match tabs are one tab stop, the arrow keys moving between them', async () => {
    await show(full);
    await screen.findByText('skunk');
    const tabs = screen.getAllByRole('tab');
    const shown = () =>
      tabs.map((t) => [
        t.textContent,
        t.getAttribute('aria-selected'),
        t.tabIndex,
      ]);
    expect(shown()).toEqual([
      ['All', 'true', 0],
      ['Premier', 'false', -1],
      ['Competitive', 'false', -1],
      ['FACEIT', 'false', -1],
    ]);
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[0].id);
    expect(
      tabs.every((t) => t.getAttribute('aria-controls') === panel.id)
    ).toBe(true);
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[1]);
    expect(shown().map((t) => t[2])).toEqual([-1, 0, -1, -1]);
    expect(tabs[1].getAttribute('aria-selected')).toBe('true');
    expect(panel.getAttribute('aria-labelledby')).toBe(tabs[1].id);
    fireEvent.keyDown(tabs[1], { key: 'End' });
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs[0]);
    fireEvent.keyDown(tabs[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tabs[3]);
    fireEvent.keyDown(tabs[3], { key: 'Home' });
    expect(document.activeElement).toBe(tabs[0]);
    expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    // Any other key is the page's.
    fireEvent.keyDown(tabs[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('a tab with no matches says so in a quiet line, not a button', async () => {
    await show({
      ...full,
      matches: [row({ demoId: 'b', mode: 'competitive' })],
      matchCount: 1,
    });
    await screen.findByText('skunk');
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    const line = screen.getByText('No Premier matches here');
    expect(line.tagName).toBe('P');
    expect(line.closest('button')).toBeNull();
    expect(screen.queryByRole('button', { name: /matches/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Competitive' }));
    expect(screen.queryByText(/^No .*matches here$/)).toBeNull();
  });

  it('a tab whose matches may be past those loaded offers them, not that there are none', async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      row({ demoId: `c${i}`, mode: 'competitive' })
    );
    await show({ ...full, matches: first, matchCount: 150 });
    await screen.findByText('skunk');
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    expect(screen.queryByText('No Premier matches here')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'All Premier matches' })
    ).toBeTruthy();
  });

  it('“All ‹n› matches” keeps its words in one piece, so its spaces show', async () => {
    const many = Array.from({ length: 34 }, (_, i) => row({ demoId: `m${i}` }));
    await show({ ...full, matches: many, matchCount: 34 });
    await screen.findByText('skunk');
    const more = screen.getByRole('button', { name: 'All 34 matches' });
    // One child holding the words: a flex button trims the spaces at the edges of each of its
    // own children ("All34matches").
    expect(more.childNodes).toHaveLength(1);
    expect(more.firstElementChild?.textContent).toBe('All 34 matches');
  });

  it('a mode’s tab leaves the mode out of its rows, which say only the day', async () => {
    await show(full);
    await screen.findByText('skunk');
    const smalls = () =>
      [...screen.getByTestId('match-rows').querySelectorAll('small')].map(
        (x) => x.textContent
      );
    expect(smalls()[0]).toMatch(/^Premier, /);
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    expect(smalls()).toHaveLength(1);
    expect(smalls()[0]).toMatch(/^[A-Z][a-z]{2} \d/);
  });

  it('sets a percentage’s sign smaller than its figure', async () => {
    await show(full);
    const strip = await screen.findByTestId('stat-strip');
    await waitFor(() => expect(within(strip).getByText('1.12')).toBeTruthy());
    const opening = strip.children[1].querySelector('.n')!;
    expect(opening.textContent).toBe('58%');
    expect(opening.querySelector('.pct')?.textContent).toBe('%');
    const wins = screen.getByTestId('map-table').querySelector('.pct');
    expect(wins?.textContent).toBe('%');
  });

  it('says whether matches are tracked without a mark before it', async () => {
    await show({ ...full, tracking: 'on' });
    await screen.findByText('Tracking on');
    // jsdom's import.meta.url is not a file's: the path is from web/, where the tests run.
    const css = readFileSync('src/site/profile/profile.module.css', 'utf8');
    expect(css).not.toMatch(/\.track(Off)?::before/);
  });

  it('a mode tab can load matches older than the first hundred', async () => {
    const first = Array.from({ length: 100 }, (_, i) =>
      row({ demoId: `c${i}`, mode: i < 5 ? 'premier' : 'competitive' })
    );
    const older = Array.from({ length: 50 }, (_, i) =>
      row({ demoId: `p${i}`, mode: 'premier', playedUnix: 1_700_000_000 })
    );
    vi.mocked(getMatches).mockImplementation(async (_id, offset) =>
      offset === 100 ? older : []
    );
    await show({ ...full, matches: first, matchCount: 150 });
    await screen.findByText('skunk');
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    const more = screen.getByRole('button', { name: /^All .*matches$/ });
    fireEvent.click(more);
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: /Replay/ })).toHaveLength(55)
    );
    expect(getMatches).toHaveBeenCalledWith(ID, 100);
  });

  it('says Premier is unrated, or that none is held, without a dash', async () => {
    // The rank icons are images, a placeholder until the site's assets are in (never, here).
    const words = () =>
      [...screen.getByTestId('ranks').children].map((r) =>
        r.textContent!.replace(/^—/, '')
      );
    await show({ ...full, premier: { rating: 0, wins: 4, demoId: 'x' } });
    await screen.findByText('skunk');
    expect(words()[0]).toBe('UnratedPremier4 of 10 wins');
    cleanup();
    await show({ ...full, premier: null, competitive: null });
    await screen.findByText('skunk');
    expect(words()).toEqual([
      'UnratedPremierNo Premier matches here',
      'UnrankedCompetitiveNo Competitive matches here',
    ]);
  });

  it('draws no rank one way: a word in an outline above, a plain dash in the tables', async () => {
    await show({
      ...full,
      premier: null,
      competitive: { map: 'de_dust2', rank: 0 },
      maps: [
        { map: 'de_dust2', matches: 2, winPct: 50, rating: 1.1, rank: 0 },
        { map: 'de_nuke', matches: 1, winPct: 0, rating: 0.9, rank: null },
      ],
      matches: [
        row({ demoId: 'a', mode: 'premier', rank: held(11, 0) }),
        row({ demoId: 'b', mode: 'competitive', rank: held(12, 0) }),
        row({ demoId: 'c', mode: 'competitive', rank: null }),
      ],
      matchCount: 3,
    });
    await screen.findByText('skunk');
    const boxes = [...screen.getByTestId('ranks').children].map(
      (r) => r.firstElementChild as HTMLElement
    );
    expect(boxes.map((b) => b.textContent)).toEqual(['Unrated', 'Unranked']);
    expect(boxes[1].className).toBe(boxes[0].className);
    const cells = [
      ...[
        ...screen.getByTestId('map-table').querySelectorAll('[data-map]'),
      ].map((r) => r.children[4]),
      ...[
        ...screen.getByTestId('match-rows').querySelectorAll('[data-match]'),
      ].map((r) => r.children[8]),
    ];
    expect(cells).toHaveLength(5);
    for (const c of cells) {
      expect(c.textContent).toBe('—');
      expect(c.querySelector('img')).toBeNull();
      expect(c.firstElementChild!.className).not.toMatch(/badge|icon/);
    }
  });

  it("an unrated Premier player shows wins of ten, the figures in the numbers' face", async () => {
    await show({ ...full, premier: { rating: 0, wins: 4, demoId: 'x' } });
    await screen.findByText('skunk');
    const sub = [...screen.getByTestId('ranks').querySelectorAll('div')].find(
      (d) => d.textContent === '4 of 10 wins'
    )!;
    expect(sub).toBeTruthy();
    expect(sub.querySelector('.n')!.textContent).toBe('4');
    expect(sub.querySelectorAll('span')).toHaveLength(2);
  });

  it('the Premier tab never lists wingman or other matches', async () => {
    await show(full);
    await screen.findByText('skunk');
    const replays = () =>
      screen
        .getAllByRole('link', { name: /Replay/ })
        .map((a) => a.getAttribute('href'));
    expect(replays()).toEqual(['/d/a', '/d/b', '/d/c', '/d/d']);
    fireEvent.click(screen.getByRole('tab', { name: 'Premier' }));
    expect(replays()).toEqual(['/d/a']);
    fireEvent.click(screen.getByRole('tab', { name: 'Competitive' }));
    expect(replays()).toEqual(['/d/b']);
  });

  it("names the page as the player's CS2 stats once they are in, as the server does", async () => {
    await show(full);
    await screen.findByText('skunk');
    await waitFor(() =>
      expect(document.title).toBe("skunk's CS2 stats and demos · skunk.club")
    );
  });

  it('a hidden profile says only that, with a way home', async () => {
    await show(new HiddenProfileError('This profile is hidden.', 410));
    const notice = await screen.findByTestId('notice');
    expect(
      within(notice).getByRole('heading', { name: 'This profile is hidden' })
    ).toBeTruthy();
    expect(notice.querySelector('p')?.textContent).toBe(
      'Its owner asked for it to be taken off skunk.club.'
    );
    expect(
      within(notice).getByRole('link', { name: 'Go to the home page' })
    ).toHaveProperty('pathname', '/');
    expect(screen.queryByTestId('stat-strip')).toBeNull();
    expect(screen.queryByTestId('ranks')).toBeNull();
    expect(document.title).toBe('Hidden profile · skunk.club');
  });

  it('an unknown vanity says no Steam account goes by it, with a way home', async () => {
    api.lookup = new ApiError(
      'No Steam account or player called “nobodyhere”',
      404
    );
    render(<ProfileView profile={{ kind: 'vanity', name: 'nobodyhere' }} />);
    const notice = await screen.findByTestId('notice');
    expect(
      within(notice).getByRole('heading', { name: 'Player not found' })
    ).toBeTruthy();
    expect(notice.querySelector('p')?.textContent).toBe(
      'No Steam account goes by “nobodyhere”.'
    );
    expect(
      within(notice).getByRole('link', { name: 'Go to the home page' })
    ).toBeTruthy();
    expect(screen.queryByTestId('stat-strip')).toBeNull();
    expect(document.title).toBe('Player not found · skunk.club');
  });

  it("over the server's body, shows only the bar and a loading bar until the profile is in, then removes the body", async () => {
    putPre();
    let answer!: (p: Profile) => void;
    api.queue = [new Promise<Profile>((r) => (answer = r))];
    render(<ProfileView profile={{ kind: 'steamid', id: ID }} />);
    expect(screen.getByRole('progressbar', { name: 'Loading' })).toBeTruthy();
    // No profile of dashes over the server's profile, and no foot between them.
    expect(screen.queryByTestId('who')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(preShown()).toBe(true);
    answer(full);
    await screen.findByText('skunk');
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("over the server's body, a profile that did not load is one slim line, the body kept, and Try again loads it", async () => {
    putPre();
    api.queue = [
      new ApiError('the server could not read its match index', 500),
    ];
    await show(full);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Live stats did not load.'
    );
    // Not the full card: the server's body is the page under the line.
    expect(screen.queryByTestId('notice')).toBeNull();
    expect(screen.queryByTestId('who')).toBeNull();
    expect(screen.queryByRole('contentinfo')).toBeNull();
    expect(preShown()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('skunk')).toBeTruthy();
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it("a hidden profile is a definite answer: its notice shows and the server's body goes", async () => {
    putPre();
    await show(new HiddenProfileError('This profile is hidden.', 410));
    await screen.findByTestId('notice');
    await waitFor(() => expect(preShown()).toBe(false));
  });

  it('a profile that failed to load says so, with no figures, and can be asked for again', async () => {
    api.queue = [
      new ApiError('the server could not read its match index', 500),
    ];
    await show(full);
    const notice = await screen.findByTestId('notice');
    expect(
      within(notice).getByRole('heading', { name: 'This profile did not load' })
    ).toBeTruthy();
    expect(notice.querySelector('p')?.textContent).toBe(
      'The server could not read its match index.'
    );
    // Not a profile of zeros: nothing of one.
    for (const id of ['who', 'ranks', 'stat-strip', 'stat-grid', 'match-rows'])
      expect(screen.queryByTestId(id), id).toBeNull();
    expect(screen.queryByText(/0 matches|0–0–0/)).toBeNull();
    fireEvent.click(within(notice).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('skunk')).toBeTruthy();
    expect(screen.queryByTestId('notice')).toBeNull();
    expect(screen.getByTestId('stat-strip')).toBeTruthy();
  });
});

describe('the map strips behind the rows', () => {
  const entry = (file: string, hex: string) => ({
    file,
    sha256: hex.repeat(32),
    bytes: 9000,
  });
  /** The site manifest the server answers, read before the page renders. */
  const served = async (manifest: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) =>
        String(url) === '/site/manifest.json' && manifest
          ? new Response(JSON.stringify(manifest), {
              headers: { 'content-type': 'application/json' },
            })
          : new Response('', { status: 404 })
      )
    );
    await siteAssets({ fresh: true });
  };
  const withMaps = {
    ...full,
    maps: [
      { map: 'de_nuke', matches: 3, winPct: 66.7, rating: 1.3, rank: null },
      { map: 'de_mirage', matches: 1, winPct: 0, rating: 0.9, rank: null },
    ],
    matches: [
      row({ demoId: 'a', map: 'de_nuke' }),
      row({ demoId: 'b', map: 'de_mirage' }),
    ],
    matchCount: 2,
  };
  /** Each map cell's strip, `url("…")`, or '' without one: the table's, then the rows'. */
  const strips = () => [
    ...[...screen.getByTestId('map-table').querySelectorAll('[data-map]')].map(
      (r) =>
        (r.firstElementChild as HTMLElement).style.getPropertyValue('--strip')
    ),
    ...[
      ...screen.getByTestId('match-rows').querySelectorAll('[data-match]'),
    ].map((r) =>
      (r.children[1] as HTMLElement).style.getPropertyValue('--strip')
    ),
  ];

  afterEach(async () => {
    await served(null);
  });

  it('sets the strip of a map the site has one of behind its name, asked for with its version', async () => {
    await served({
      ranks: {},
      steamLogo: entry('steam-logo.svg', 'cd'),
      maps: { de_nuke: entry('maps/de_nuke.webp', 'ab') },
      home: null,
    });
    await show(withMaps);
    await screen.findByText('skunk');
    const nuke = 'url("/site/maps/de_nuke.webp?v=abababab")';
    await waitFor(() => expect(strips()).toEqual([nuke, '', nuke, '']));
    // The name stays the cell's first words, where it was.
    const cell = screen.getByTestId('match-rows').querySelector('[data-match]')!
      .children[1] as HTMLElement;
    expect(cell.firstChild?.textContent).toBe('Nuke');
    expect(cell.className).not.toBe(
      (
        screen.getByTestId('match-rows').querySelectorAll('[data-match]')[1]
          .children[1] as HTMLElement
      ).className
    );
  });

  it('leaves every row plain with a manifest from before the strips, or none', async () => {
    await served({
      ranks: {},
      steamLogo: entry('steam-logo.svg', 'cd'),
      home: null,
    });
    await show(withMaps);
    await screen.findByText('skunk');
    expect(strips()).toEqual(['', '', '', '']);
    cleanup();
    await served(null);
    await show(withMaps);
    await screen.findByText('skunk');
    expect(strips()).toEqual(['', '', '', '']);
  });

  it('takes no file into a style that is not a plain path', async () => {
    await served({
      ranks: {},
      steamLogo: entry('steam-logo.svg', 'cd'),
      maps: { de_nuke: entry('maps/x.webp") ;background:red;("', 'ab') },
      home: null,
    });
    await show(withMaps);
    await screen.findByText('skunk');
    expect(strips()).toEqual(['', '', '', '']);
  });
});

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
