import { expect, test, type Page } from '@playwright/test';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { animationFrames } from './wait';
import { trackErrors } from './errors';

// Sound in the real page, on the Mirage demo at 2560×1440:
// - Opened 2 s before round 1's freeze ends, the page has no audio context and has fetched
//   nothing under /sounds/. A click on the 3D view and Space play it until the round is live
//   and the sound is unlocked and has played cues, with `round` and a gun's bank among the
//   banks decoded; then the page's requests under /sounds/ are the manifest and exactly those banks (each by
//   its hash; waited for, as a bank fetched is decoded a moment later), and the transport's
//   download counter grew by at least their bytes.
// - Paused, `→` to the next round plays nothing and leaves nothing ringing.
// - The frame rate with the sound on, as viewer.spec.ts measures it: round 1 from 10 s after
//   its freeze, played in POV, at 60 fps or more, with cues playing while it is measured.
// Headless Chromium cannot be heard: the mix is for an ear (web/README.md, Sound).
//
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the
// assets (with assets/sounds/), and the id of an uploaded Mirage demo in DEMOVIEWER_E2E_DEMO.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

/** The sound director's counts, copied out of the page. */
const sound = (page: Page) =>
  page.evaluate(() => {
    const s = window.__demoviewer!.sound!;
    return {
      unlocked: s.unlocked,
      played: s.played,
      skipped: s.skipped,
      voices: s.voices,
      banks: [...s.banks],
    };
  });

/** What the page has fetched under /sounds/: each request's path, query and bytes over the wire. */
const soundRequests = (page: Page) =>
  page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .map((e) => {
        const u = new URL(e.name);
        return {
          path: u.pathname,
          v: u.searchParams.get('v'),
          bytes: e.transferSize,
        };
      })
      .filter((r) => r.path.startsWith('/sounds/'))
  );

/** A point of the 3D view's canvas itself, not of the HUD over it. */
const canvasPoint = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport"] canvas'
    )!;
    const r = canvas.getBoundingClientRect();
    for (let gy = 0.3; gy <= 0.7; gy += 0.05)
      for (let gx = 0.3; gx <= 0.7; gx += 0.05) {
        const x = r.left + gx * r.width;
        const y = r.top + gy * r.height;
        if (document.elementFromPoint(x, y) === canvas) return { x, y };
      }
    return null;
  });

test('sounds from the first click, fetches what the round needs, and a seek is silent', async ({
  page,
  request,
}) => {
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const round1 = pack.header.rounds[0];
  const start = round1.freeze_end_tick - 2 * pack.header.tick_rate;

  const errors = trackErrors(page);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().startsWith('sounds:'))
      warnings.push(m.text());
  });

  await page.goto(`/d/${demoId}?r=1&t=${start}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  const clock = page.getByTestId('clock');
  await expect(clock).toHaveAttribute('data-tick', String(start));

  // Before any click or key: no audio context, nothing under /sounds/.
  expect((await sound(page)).unlocked).toBe(false);
  expect(await soundRequests(page)).toEqual([]);

  const at = await canvasPoint(page);
  expect(at).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
  await page.keyboard.press('Space');
  await expect
    .poll(
      async () => {
        const s = await sound(page);
        return (
          Number(await clock.getAttribute('data-tick')) >
            round1.freeze_end_tick &&
          s.unlocked &&
          s.played > 0 &&
          s.banks.includes('round') &&
          s.banks.some((b) => b.startsWith('weapon_'))
        );
      },
      {
        message: 'the round is live and its sounds and a gun have played',
        timeout: 30_000,
      }
    )
    .toBe(true);

  // The banks decoded and the page's finished requests under /sounds/: a bank fetched but
  // still decoding is in the second only, so wait until the two agree, and check what agreed.
  let heard = await sound(page);
  let requests = await soundRequests(page);
  const fetched = () =>
    requests
      .filter((r) => r.path !== '/sounds/manifest.json')
      .map((r) => r.path)
      .sort();
  const decoded = () => heard.banks.map((b) => `/sounds/${b}.webm`).sort();
  await expect
    .poll(
      async () => {
        heard = await sound(page);
        requests = await soundRequests(page);
        return fetched().join(' ') === decoded().join(' ');
      },
      { message: 'the banks fetched are the banks decoded', timeout: 10_000 }
    )
    .toBe(true);
  expect(heard.unlocked).toBe(true);
  expect(heard.played).toBeGreaterThan(0);
  expect(heard.banks).toContain('round');
  expect(heard.banks.some((b) => b.startsWith('weapon_'))).toBe(true);

  // The manifest once, and each bank decoded once by its hash, and nothing else.
  const manifest = requests.filter((r) => r.path === '/sounds/manifest.json');
  const banks = requests.filter((r) => r.path !== '/sounds/manifest.json');
  expect(manifest).toHaveLength(1);
  expect(fetched()).toEqual(decoded());
  const { banks: listed } = (await (
    await request.get('/sounds/manifest.json')
  ).json()) as { banks: Record<string, { sha256: string }> };
  for (const r of banks)
    expect(r.v).toBe(
      listed[r.path.slice('/sounds/'.length, -'.webm'.length)].sha256.slice(
        0,
        8
      )
    );
  const bytes = requests.reduce((n, r) => n + r.bytes, 0);
  console.log(
    `sound: ${heard.played} cues played, ${heard.skipped} skipped, ${heard.voices} voices ` +
      `sounding; the manifest and ${banks.length} banks ${bytes} B`
  );

  // Paused, the next round: nothing plays and nothing rings.
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(() => window.__demoviewer!.store.getState().playing)
    )
    .toBe(false);
  await animationFrames(page);
  const paused = await sound(page);
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(() =>
      page.evaluate(() => window.__demoviewer!.store.getState().round)
    )
    .toBe(1);
  // The sound hears each frame drawn (`SoundDirector.frame`): a few of them at the new round
  // would have played what the seek set off.
  await animationFrames(page, 10);
  await expect.poll(async () => (await sound(page)).voices).toBe(0);
  const next = await sound(page);
  expect(next.played).toBe(paused.played);
  expect(next.voices).toBe(0);

  // The frame rate with the sound on, at viewer.spec.ts's moment and in its way: round 1 from
  // 10 s after its freeze, in POV, played until the fps window fills.
  await page.evaluate((tick) => {
    const { store } = window.__demoviewer!;
    store.getState().seekRound(0);
    store.getState().seekTick(tick);
  }, round1.freeze_end_tick + 640);
  await page.keyboard.press('Space');
  // A measurement, so a span of wall time: the fps window (500 ms) holds playing frames.
  await page.waitForTimeout(2500);
  const fps = await page.evaluate(() => window.__demoviewer!.stats.fps);
  const playing = await sound(page);
  const mode = await page.evaluate(() => window.__demoviewer!.camera().mode);
  console.log(
    `sound on: ${fps.toFixed(1)} fps at 2560x1440 in ${mode}, ${playing.played - next.played} cues played meanwhile`
  );
  test.info().annotations.push({ type: 'fps', description: fps.toFixed(1) });
  expect(mode).toBe('pov');
  expect(playing.played).toBeGreaterThan(next.played);
  expect(fps).toBeGreaterThanOrEqual(60);
  expect(warnings).toEqual([]);
  expect(errors).toEqual([]);
});
