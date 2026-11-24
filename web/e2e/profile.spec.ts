import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { trackErrors } from './errors';

// A player's profile from a demo the server holds: uploads DEMOVIEWER_E2E_DEM, reads one of its
// players from the demo's summary (no ids written here), and opens their profile on a desktop and
// a phone: every block shows (what the replay adds, but for the blocks a player may have nothing
// in; not who they played with: one match together lists no one), nothing scrolls sideways, no figure
// runs out of its box, and the row's Replay opens the match. An unknown custom URL, as long as
// Steam allows, shows the not-found page, whole on a phone. Needs the server on 8095 (or
// DEMOVIEWER_E2E_URL).
const dem = process.env.DEMOVIEWER_E2E_DEM;

async function uploaded(
  page: Page
): Promise<{ demoId: string; steamid: string }> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(dem!);
  await expect(page).toHaveURL(/\/d\/[A-Za-z0-9]{21,22}$/, {
    timeout: 120_000,
  });
  const demoId = new URL(page.url()).pathname.split('/')[2];
  for (
    const t0 = Date.now();
    Date.now() - t0 < 120_000;
    await page.waitForTimeout(500)
  ) {
    const d = await (await page.request.get(`/api/demos/${demoId}`)).json();
    const player = d.summary?.players?.find((p: { steamid: string }) =>
      /^7656119\d{10}$/.test(p.steamid)
    );
    if (d.status === 'done' && player)
      return { demoId, steamid: player.steamid };
  }
  throw new Error('the demo was not parsed in time');
}

test('a player’s profile shows every block, and its replay opens', async ({
  page,
}) => {
  const up = await page.request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  test.skip(
    !dem,
    'set DEMOVIEWER_E2E_DEM=<path to a .dem> with the server running'
  );
  test.setTimeout(Math.max(240_000, (statSync(dem!).size / 1e6) * 3000));
  const { demoId, steamid } = await uploaded(page);
  const errors = trackErrors(page);
  for (const size of [
    { width: 1200, height: 900 },
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/profiles/${steamid}`);
    for (const id of [
      'who',
      'ranks',
      'stat-strip',
      'stat-grid',
      'utility',
      'sides',
      'bomb',
      'trades',
      'map-table',
    ])
      await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('mates')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'Premier' })).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);
    // Every number (stats, figures, what the replay adds, maps, who they played with, the rows'
    // scores, ratings and dates) is set in JetBrains Mono; a player's or a weapon's name is a
    // name, whatever it holds. The blocks a player may have nothing in are walked when shown.
    const notMono = await page.evaluate(() => {
      const out: string[] = [];
      for (const id of [
        'stat-strip',
        'stat-grid',
        'weapons',
        'clutches',
        'utility',
        'sides',
        'bomb',
        'trades',
        'kill-kinds',
        'map-table',
        'mates',
        'match-rows',
      ]) {
        const root = document.querySelector(`[data-testid="${id}"]`);
        if (!root) continue;
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) {
          const text = n.textContent!.trim();
          if (n.parentElement!.closest('a[href^="/profiles/"], [data-name]'))
            continue;
          const font = getComputedStyle(n.parentElement!).fontFamily;
          if (/\d/.test(text) && !font.startsWith('"JetBrains Mono"'))
            out.push(`${id}: ${text} (${font})`);
        }
      }
      return out;
    });
    expect(notMono).toEqual([]);
    // The new blocks' and the rows' cells hold what they show.
    const spilt = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid="stat-grid"] > *, [data-cell], [data-weapon] > :not(:first-child), [data-testid="sides"] > * > :not(:first-child), [data-mate] > :not(:first-child), [data-testid="match-rows"] > div > *'
        ),
      ]
        .filter((c) => c.offsetParent && c.scrollWidth > c.clientWidth + 1)
        .map((c) => `${c.textContent} (${c.scrollWidth} > ${c.clientWidth})`)
    );
    expect(spilt).toEqual([]);
  }
  await page
    .getByRole('link', { name: /^Replay/ })
    .first()
    .click();
  // The match's oldest demo id: an earlier upload of the same demo may own it.
  await expect(page).toHaveURL(/\/d\/[A-Za-z0-9]{21,22}$/);
  const opened = new URL(page.url()).pathname.split('/')[2];
  const d = await (await page.request.get(`/api/demos/${opened}`)).json();
  expect(
    d.summary.players.map((p: { steamid: string }) => p.steamid)
  ).toContain(steamid);
  void demoId;
  expect(errors).toEqual([]);
});

test('an unknown custom URL shows the not-found page', async ({ page }) => {
  const up = await page.request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  const name = Array.from(
    { length: 32 },
    () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]
  ).join('');
  for (const size of [
    { width: 1200, height: 900 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/id/${name}`);
    await expect(
      page.getByRole('heading', { name: 'Player not found' })
    ).toBeVisible();
    await expect(
      page.getByText(`No Steam account goes by “${name}”.`)
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Go to the home page' })
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      ),
      `${size.width}px: no sideways scroll`
    ).toBe(true);
  }
});
