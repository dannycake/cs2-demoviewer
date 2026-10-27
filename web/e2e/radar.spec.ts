import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { animationFrames } from './wait';
import { trackErrors } from './errors';

// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the assets,
// and the id of an uploaded Mirage demo in DEMOVIEWER_E2E_DEMO. The 3D frame rate with the
// minimap up (it is on by default) is viewer.spec.ts's check.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const out = (name: string) =>
  fileURLToPath(new URL(`./out/${name}`, import.meta.url));

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

/** The share of a canvas's pixels that are drawn (not transparent). */
const drawn = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel);
    if (!c || c.width === 0) return 0;
    const g = c.getContext('2d')!;
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) n++;
    return n / (c.width * c.height);
  }, selector);

test('shows the minimap, and the full radar on R', async ({
  page,
  request,
}) => {
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const start = pack.header.rounds[0].freeze_end_tick + 30 * 64;

  const errors = trackErrors(page);
  await page.goto(`/d/${demoId}?r=1&t=${start}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );

  const mini = page.getByRole('button', { name: /^Radar of mirage/ });
  await expect(mini).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(() => drawn(page, 'button[aria-label^="Radar of"] canvas'))
    .toBeGreaterThan(0.3);
  mkdirSync(out(''), { recursive: true });
  await page.screenshot({
    path: out('radar-mini.jpg'),
    type: 'jpeg',
    quality: 85,
  });

  await page.keyboard.press('r');
  const full = page.getByRole('img', { name: /^Radar of mirage/ });
  await expect(full).toBeVisible();
  await expect(mini).toHaveCount(0);
  // The map's square fills about half of a wide window, and the image is clear around the map.
  await expect
    .poll(() => drawn(page, 'canvas[role="img"]'))
    .toBeGreaterThan(0.1);
  // Under the radar the 3D view draws nothing: its frame counter stands still.
  const frames = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __demoviewer: { stats: { frames: number } };
          }
        ).__demoviewer.stats.frames
    );
  const tick = () =>
    page.evaluate(
      () =>
        (
          window as unknown as {
            __demoviewer: { store: { getState(): { tick: number } } };
          }
        ).__demoviewer.store.getState().tick
    );
  const before = await frames();
  const from = await tick();
  // Played for 30 of the page's frames, each of which would have drawn the 3D view.
  await page.keyboard.press('Space');
  await expect.poll(tick).toBeGreaterThan(from);
  await animationFrames(page, 30);
  await page.keyboard.press('Space');
  expect(await frames()).toBe(before);
  await page.screenshot({
    path: out('radar-full.jpg'),
    type: 'jpeg',
    quality: 85,
  });

  // A camera mode brings the 3D view back.
  await page.keyboard.press('v');
  await expect(full).toHaveCount(0);
  await expect(mini).toBeVisible();
  expect(errors).toEqual([]);
});
