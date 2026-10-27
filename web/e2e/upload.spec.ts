import { expect, test } from '@playwright/test';
import { statSync } from 'node:fs';
import { SOURCE_URL } from '../src/links';
import { trackErrors } from './errors';

// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the
// assets. The uploads need a demo in DEMOVIEWER_E2E_DEM; mirage_old.dem (60 MB) parses
// quickly. Each run of them starts two of the ten ingests a client may start per hour.
const dem = process.env.DEMOVIEWER_E2E_DEM;
const NO_DEM =
  'set DEMOVIEWER_E2E_DEM=<path to a .dem> with the server running';

test('the upload page links to the source and loads no viewer chunk', async ({
  page,
  request,
}) => {
  const up = await request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  // The scripts the page names: the entry, which holds the upload page.
  const named = [
    ...(await up!.text()).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
  ].map((m) => m[1]);
  expect(named.length).toBeGreaterThan(0);
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(new URL(r.url()).pathname));
  const errors = trackErrors(page);

  await page.goto('/');
  const link = page.getByRole('link', { name: 'Source on GitHub' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', SOURCE_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await page.waitForLoadState('networkidle');

  // The viewer (DemoView, and three.js with it) is a chunk of its own with its own stylesheet,
  // loaded when a demo opens: the page fetched only the scripts it names.
  expect(fetched.filter((p) => p.endsWith('.js'))).toEqual(named);
  expect(fetched.filter((p) => p.includes('/DemoView-'))).toEqual([]);

  // At a phone's width the link is on screen and the page does not scroll sideways.
  await page.setViewportSize({ width: 375, height: 667 });
  await link.scrollIntoViewIfNeeded();
  const box = await link.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(
    await page.evaluate(() =>
      [document.documentElement, document.querySelector('main')!].some(
        (el) => el.scrollWidth > el.clientWidth
      )
    )
  ).toBe(false);
  expect(errors).toEqual([]);
});

test('uploads a dropped demo and opens it in the viewer', async ({
  page,
  request,
}) => {
  test.skip(!dem, NO_DEM);
  test.setTimeout(300_000);
  const up = await request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');

  const errors = trackErrors(page);

  await page.goto('/');
  const started = performance.now();
  await page.getByTestId('drop-zone').drop({ files: dem! });

  // Straight to the viewer when the server already has the demo, else after the upload.
  await expect(page).toHaveURL(/\/d\/[A-Za-z0-9_-]+$/, { timeout: 180_000 });
  const uploaded = performance.now();
  await expect(page.getByTestId('player-row').first()).toBeVisible({
    timeout: 180_000,
  });
  const listed = performance.now();

  const mb = statSync(dem!).size / 1048576;
  const upload = (uploaded - started) / 1000;
  const total = (listed - started) / 1000;
  console.log(
    `upload: ${mb.toFixed(1)} MB in ${upload.toFixed(1)} s, player list after ${total.toFixed(1)} s`
  );
  test.info().annotations.push({
    type: 'upload',
    description: `${upload.toFixed(1)} s / ${total.toFixed(1)} s`,
  });
  expect(errors).toEqual([]);
});

test('shows the server error for a failed chunk and retries from that chunk', async ({
  page,
  request,
}) => {
  test.skip(!dem, NO_DEM);
  test.setTimeout(300_000);
  const up = await request.get('/').catch(() => null);
  test.skip(!up?.ok(), 'the server is not running');
  test.skip(
    statSync(dem!).size <= 32 * 1048576,
    'needs a demo of more than one chunk'
  );

  // Chunk 1 is refused once with a 413; every PUT is counted per chunk.
  const puts = new Map<number, number>();
  let refused = false;
  await page.route(/\/api\/uploads\/[^/]+\/\d+$/, async (route) => {
    const n = Number(route.request().url().split('/').pop());
    puts.set(n, (puts.get(n) ?? 0) + 1);
    if (n === 1 && !refused) {
      refused = true;
      return route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'test: chunk 1 refused' }),
      });
    }
    return route.continue();
  });

  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(dem!);

  const failed = page.getByTestId('upload-error');
  await expect(failed).toContainText('test: chunk 1 refused', {
    timeout: 120_000,
  });
  await expect(failed).toContainText('Chunk 2 of');
  expect(puts.get(1)).toBe(1);

  await failed.getByRole('button', { name: 'Retry from chunk 2' }).click();
  await expect(page).toHaveURL(/\/d\/[A-Za-z0-9_-]+$/, { timeout: 180_000 });
  // Chunk 0 went up once: the retry carried on, it did not start over.
  expect(puts.get(0)).toBe(1);
  expect(puts.get(1)).toBe(2);
});
