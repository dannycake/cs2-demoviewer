import { expect, test, type Page } from '@playwright/test';
import { statSync } from 'node:fs';
import { trackErrors } from './errors';

// The skunk.club homepage, on a desktop and a phone: the band with the headline and the one
// input above the fold, no sideways scroll, the input's live tag, and one demo uploaded that
// opens its replay. Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app
// and the assets; the upload needs DEMOVIEWER_E2E_DEM.
const dem = process.env.DEMOVIEWER_E2E_DEM;

async function serverUp(page: Page): Promise<boolean> {
  const up = await page.request.get('/').catch(() => null);
  return !!up?.ok();
}

for (const [name, size] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`the homepage on a ${name}: the band above the fold, no sideways scroll`, async ({
    page,
  }) => {
    test.skip(!(await serverUp(page)), 'the server is not running');
    const errors = trackErrors(page);
    await page.setViewportSize(size);
    await page.goto('/');
    const headline = page.getByRole('heading', {
      name: 'Watch CS2 demos in 3D, right in your browser.',
    });
    await expect(headline).toBeVisible();
    const input = page.getByRole('textbox', { name: 'A player or a match' });
    await expect(input).toBeVisible();
    for (const el of [headline, input]) {
      const box = await el.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(size.height);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true);

    await input.fill('CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK');
    await expect(page.getByText('match', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Watch replay' })
    ).toBeEnabled();
    await input.fill('hello world');
    await expect(page.getByText('unknown', { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('one demo uploaded from the homepage opens its replay', async ({
  page,
}) => {
  test.skip(!(await serverUp(page)), 'the server is not running');
  test.skip(
    !dem,
    'set DEMOVIEWER_E2E_DEM=<path to a .dem> with the server running'
  );
  test.setTimeout(Math.max(120_000, (statSync(dem!).size / 1e6) * 1500));
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(dem!);
  await expect(page).toHaveURL(/\/d\/[A-Za-z0-9]{21,22}$/, {
    timeout: 120_000,
  });
});

/** Whether `inner`'s box lies inside `outer`'s (to the pixel). */
function inside(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

for (const [name, size] of [
  ['desktop', { width: 1440, height: 900 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`ten players of a name keep the headline and the input in the band on a ${name}`, async ({
    page,
  }) => {
    test.skip(!(await serverUp(page)), 'the server is not running');
    await page.setViewportSize(size);
    await page.route('**/api/lookup?**', (r) =>
      r.fulfill({
        json: {
          kind: 'players',
          players: Array.from({ length: 10 }, (_, i) => ({
            steamid: String(76561198000000010n + BigInt(i)),
            name: `skunk ${i}`,
            matches: 3,
          })),
        },
      })
    );
    await page.goto('/');
    const input = page.getByRole('textbox', { name: 'A player or a match' });
    await input.fill('skunk');
    await input.press('Enter');
    const hits = page.getByRole('list', { name: 'Players of that name' });
    await expect(hits.getByRole('listitem')).toHaveCount(10);
    const hero = (await page.locator('main').boundingBox())!;
    const headline = page.getByRole('heading', {
      name: 'Watch CS2 demos in 3D, right in your browser.',
    });
    for (const el of [headline, input, hits.getByRole('listitem').last()]) {
      expect(inside((await el.boundingBox())!, hero)).toBe(true);
    }
  });
}

test('a demo with CS2’s own long file name stays on a phone’s screen', async ({
  page,
}) => {
  test.skip(!(await serverUp(page)), 'the server is not running');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/uploads', (r) =>
    r.fulfill({ status: 503, json: { error: 'the server is busy' } })
  );
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles({
    name: 'match730_003741287012345678_1234567890_129.dem',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(4096, 1),
  });
  const card = page.getByTestId('upload-error');
  await expect(card).toBeVisible();
  const screen = { x: 0, y: 0, width: 390, height: Number.MAX_SAFE_INTEGER };
  const input = page.getByRole('textbox', { name: 'A player or a match' });
  for (const el of [card, input]) {
    expect(inside((await el.boundingBox())!, screen)).toBe(true);
  }
});

// Signed out, no site page logs an error: `/api/me` answers who is signed in (nobody) rather
// than a 401, which every page asks for.
test('signed out, no site page logs an error to the console', async ({
  page,
}) => {
  test.skip(!(await serverUp(page)), 'the server is not running');
  const logged: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') logged.push(`${page.url()}: ${m.text()}`);
  });
  const errors = trackErrors(page);
  for (const path of ['/', '/track', '/legal', '/profiles/76561198000000001']) {
    const me = page.waitForResponse((r) => r.url().endsWith('/api/me'));
    await page.goto(path);
    expect((await me).status(), path).toBe(200);
    await page.waitForLoadState('networkidle');
  }
  expect(logged).toEqual([]);
  expect(errors).toEqual([]);
});

test('the "unknown" tag keeps to one line on a phone, clear of its cell\'s edges, and leaves the input its room', async ({
  page,
}) => {
  test.skip(!(await serverUp(page)), 'the server is not running');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page
    .getByRole('textbox', { name: 'A player or a match' })
    .fill('hello world');
  const tag = page.getByText('unknown', { exact: true });
  await expect(tag).toBeVisible();
  const fits = await tag.evaluate(
    (el) =>
      el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth
  );
  expect(fits).toBe(true);
  expect((await tag.boundingBox())!.height).toBeLessThanOrEqual(31);
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const room = await tag.evaluate((el) => {
      const cell = el.parentElement!.getBoundingClientRect();
      const chip = el.getBoundingClientRect();
      const input = document
        .querySelector('main input')!
        .getBoundingClientRect();
      return {
        left: chip.left - cell.left,
        right: cell.right - chip.right,
        input: input.width,
      };
    });
    expect(room.left, `${width}`).toBeGreaterThanOrEqual(8);
    expect(room.right, `${width}`).toBeGreaterThanOrEqual(8);
    // Room for "hello world" (some 90 px) whole, at 320 too.
    expect(room.input, `${width}`).toBeGreaterThanOrEqual(130);
  }
});

// A phone's visible screen in its browser (under Safari's or Chrome's bars), smallest first.
for (const size of [
  { width: 320, height: 568 },
  { width: 360, height: 640 },
  { width: 375, height: 667 },
  { width: 390, height: 664 },
] as const) {
  test(`the homepage fits a ${size.width}×${size.height} phone screen without scrolling`, async ({
    page,
  }) => {
    test.skip(!(await serverUp(page)), 'the server is not running');
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(
      page.locator('main video, main img[data-poster]')
    ).toBeVisible();
    const fit = await page.evaluate(() => ({
      page: document.documentElement.scrollHeight,
      screen: window.innerHeight,
    }));
    expect(fit.page).toBeLessThanOrEqual(fit.screen);
  });
}

test('the homepage is dark: the loop and its still behind the band are dimmed', async ({
  page,
}) => {
  test.skip(!(await serverUp(page)), 'the server is not running');
  await page.goto('/');
  const video = page.locator('main video');
  await expect(video).toBeVisible();
  const loopFilter = await video.evaluate((v) => getComputedStyle(v).filter);
  // The still (what a visitor who asked for less motion sees) is measured as drawn.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const still = page.locator('img[data-poster]');
  await expect(still).toBeVisible();
  // The still as drawn (with its CSS filter), averaged: 0 is black, 1 is white.
  const brightness = await still.evaluate(async (img: HTMLImageElement) => {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = 160;
    c.height = 90;
    const ctx = c.getContext('2d')!;
    ctx.filter = getComputedStyle(img).filter;
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4)
      sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
    return sum / (px.length / 4) / 255;
  });
  expect(brightness).toBeLessThan(0.25);
  // The loop is dimmed the same way.
  expect(loopFilter).toBe(
    await still.evaluate((img) => getComputedStyle(img).filter)
  );
});
