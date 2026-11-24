import { expect, test } from '@playwright/test';
import { trackErrors } from './errors';

// The avatar on a profile is the whole picture, a square, on a desktop and on a phone: never
// cropped to the height of the name and Steam's facts beside it (on a phone the facts take two
// rows, and the avatar was cut to a strip). Steam's facts, a banned player's every ban among
// them, stay in their row at every width, which they fill, numbers in JetBrains Mono. The
// profiles and the avatar are these tests' own, so they need only the server on 8095 (or
// DEMOVIEWER_E2E_URL).
const ID = '76561198000000001';
const AVATAR = 'https://avatars.steamstatic.com/e2e_full.jpg';

const PROFILE = {
  steamid: ID,
  name: 'gabe',
  avatar: AVATAR,
  steam: {
    sinceYear: 2016,
    country: 'NZ',
    cs2Hours: 1234,
    cs2RecentMinutes: 725,
    level: 42,
    vacBans: 0,
    gameBans: 0,
    communityBanned: false,
    tradeBan: null,
    daysSinceLastBan: null,
  },
  tracking: 'on',
  premier: null,
  competitive: null,
  totals: {
    rating: 1.12,
    openingWon: 3,
    openingLost: 2,
    kd: 1.2,
    adr: 84,
    hsPct: 48,
    matches: 1,
    kills: 24,
    deaths: 20,
    assists: 5,
    rounds: 22,
    kastPct: 72.7,
    survivalPct: 9.1,
    multiKills: [4, 1, 0, 0],
    wins: 1,
    losses: 0,
    ties: 0,
    seconds: 2_400,
  },
  // A match from before the replays were read for more: no block of theirs.
  replay: {
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
  },
  maps: [],
  mates: [],
  matches: [],
  matchCount: 1,
};

const SIZES = [
  { width: 1200, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

// A square of one colour, as Steam's full-size avatars are 184 pixels square.
const SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="184" height="184">' +
  '<rect width="184" height="184" fill="#20c040"/></svg>';

test('the avatar shows whole, a square, on a desktop and a phone', async ({
  page,
}) => {
  const up = await page.request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  const errors = trackErrors(page);
  await page.route(new RegExp(`/api/players/${ID}$`), (r) =>
    r.fulfill({ json: PROFILE })
  );
  await page.route(AVATAR, (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: SQUARE })
  );
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto(`/profiles/${ID}`);
    // The avatar, not the Steam link's logo.
    const img = page.getByTestId('who').locator(`img[src="${AVATAR}"]`);
    await expect(img).toBeVisible();
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.complete))
      .toBe(true);
    const [shown, cell] = await img.evaluate((i) => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return [box(i), box(i.parentElement!)];
    });
    const at = `${size.width}px`;
    expect(Math.abs(shown.w - shown.h), `${at}: square`).toBeLessThanOrEqual(1);
    // Inside its cell, which clips: all of it shows.
    expect(shown.x, at).toBeGreaterThanOrEqual(cell.x - 0.5);
    expect(shown.y, at).toBeGreaterThanOrEqual(cell.y - 0.5);
    expect(shown.x + shown.w, at).toBeLessThanOrEqual(cell.x + cell.w + 0.5);
    expect(shown.y + shown.h, at).toBeLessThanOrEqual(cell.y + cell.h + 0.5);
  }
  expect(errors).toEqual([]);
});

test('Steam’s facts, a banned player’s too, fit their row at every width', async ({
  page,
}) => {
  const up = await page.request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  const errors = trackErrors(page);
  const banned = {
    ...PROFILE,
    steam: {
      ...PROFILE.steam,
      country: 'GB',
      vacBans: 2,
      gameBans: 1,
      communityBanned: true,
      tradeBan: 'probation',
      daysSinceLastBan: 1234,
    },
    tracking: 'stopped',
  };
  await page.route(new RegExp(`/api/players/${ID}$`), (r) =>
    r.fulfill({ json: banned })
  );
  await page.route(AVATAR, (r) =>
    r.fulfill({ contentType: 'image/svg+xml', body: SQUARE })
  );
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto(`/profiles/${ID}`);
    const who = page.getByTestId('who');
    await expect(who.getByText('Trade probation')).toBeVisible();
    const at = `${size.width}px`;
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      `${at}: no sideways scroll`
    ).toBe(true);
    const seen = await who.evaluate((w) => {
      const row = w.querySelector('[data-fact]')!.parentElement!;
      const box = row.getBoundingClientRect();
      const cells = [...row.children].filter(
        (c) => getComputedStyle(c).display !== 'none'
      );
      // Each line of cells ends at the row's right edge: no hairline grey after the last.
      const ends = new Map<number, number>();
      for (const c of cells) {
        const r = c.getBoundingClientRect();
        ends.set(
          Math.round(r.top),
          Math.max(ends.get(Math.round(r.top)) ?? 0, r.right)
        );
      }
      const notMono: string[] = [];
      for (const fact of w.querySelectorAll('[data-fact]')) {
        const walk = document.createTreeWalker(fact, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const text = n.textContent!.replace('CS2', '').trim();
          const font = getComputedStyle(n.parentElement!).fontFamily;
          if (/\d/.test(text) && !font.startsWith('"JetBrains Mono"'))
            notMono.push(`${text} (${font})`);
        }
      }
      return {
        facts: [...w.querySelectorAll('[data-fact]')].map((f) => f.textContent),
        spilt: cells
          .filter((c) => {
            const r = c.getBoundingClientRect();
            return (
              c.scrollWidth > c.clientWidth + 1 ||
              r.left < box.left - 0.5 ||
              r.right > box.right + 0.5
            );
          })
          .map((c) => c.textContent),
        short: [...ends.values()].filter((right) => right < box.right - 0.5),
        notMono,
      };
    });
    expect(seen.facts, at).toEqual([
      '2016 on Steam',
      'from United Kingdom',
      '42 Steam level',
      '1234 hours in CS2',
      '12 hours in 2 weeks',
      '2 VAC bans',
      '1 game ban',
      'Community ban',
      'Trade probation',
      'last ban 1234 days ago',
    ]);
    expect(seen.spilt, at).toEqual([]);
    expect(seen.short, at).toEqual([]);
    expect(seen.notMono, at).toEqual([]);
    // The avatar stays whole and square beside facts that take two rows.
    const img = who.locator(`img[src="${AVATAR}"]`);
    await expect
      .poll(() => img.evaluate((i: HTMLImageElement) => i.complete))
      .toBe(true);
    const [shown, cell] = await img.evaluate((i) => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      return [box(i), box(i.parentElement!)];
    });
    expect(Math.abs(shown.w - shown.h), `${at}: square`).toBeLessThanOrEqual(1);
    expect(shown.y, at).toBeGreaterThanOrEqual(cell.y - 0.5);
    expect(shown.y + shown.h, at).toBeLessThanOrEqual(cell.y + cell.h + 0.5);
  }
  expect(errors).toEqual([]);
});
