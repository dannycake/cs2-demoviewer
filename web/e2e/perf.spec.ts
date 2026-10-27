import { expect, test, type Page } from '@playwright/test';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { QUALITY_KEY } from '../src/state/store';
import { trackErrors } from './errors';

// What the HUD costs while playing (M4 Task 2). Round 1 from its freeze end + 5 s, POV on
// player 1, at 2560×1440 and the `high` preset (pinned, so the runs compare): 10 s at 1× with
// the viewport alone (`&hud=0`), then with the HUD, then with the HUD under a 4× CPU slowdown
// (CDP), as a stand-in for a mid laptop. A run's fps is the mean of `stats.fps` sampled every
// 500 ms, after a second of play fills the scene's fps window with playing frames.
// - The HUD run draws at 60 fps or more, and the HUD adds at most 2.5 ms a frame to the
//   viewport alone.
// - The HUD renders at most 150 times over its 10 s (every component every frame was about
//   ten components × the frame rate × 10 s): it renders when what it shows changes; and it
//   does render (the clock moves on), so the HUD run had a HUD.
// - The tick advances in both runs: they measured playing, not a paused view.
// - The slowed run's fps is printed, not checked.
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) and DEMOVIEWER_E2E_DEMO, as viewer.spec.ts
// does.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;

const RUN_MS = 10_000;
const SAMPLE_MS = 500;
const WARM_MS = 1_000;

interface Handle {
  stats: { fps: number };
  hudRenders(): Record<string, number>;
  store: { getState(): { tick: number } };
}

/** The renders so far, read in the page. */
const hudRenders = () =>
  (window as unknown as { __demoviewer: Handle }).__demoviewer.hudRenders();
/** The scene's frame rate, read in the page. */
const fpsNow = () =>
  (window as unknown as { __demoviewer: Handle }).__demoviewer.stats.fps;
/** The store's tick, read in the page. */
const tickNow = () =>
  (window as unknown as { __demoviewer: Handle }).__demoviewer.store.getState()
    .tick;

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

/** Opens round 1 at `start`, with the HUD or without, following player 1. */
async function open(page: Page, start: number, hud: boolean): Promise<void> {
  await page.goto(`/d/${demoId}?r=1&t=${start}${hud ? '' : '&hud=0'}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  await page.keyboard.press('Digit1');
}

/**
 * Plays 10 s at 1×: the mean fps, the HUD's renders by component over those 10 s, and the
 * ticks the clock advanced.
 */
async function run(
  page: Page
): Promise<{ fps: number; renders: Record<string, number>; ticks: number }> {
  await page.keyboard.press('Space');
  // Measurements, so spans of wall time: the warm-up fills the fps window with playing frames,
  // then a sample each 500 ms window (`stats.fps`) over the run.
  await page.waitForTimeout(WARM_MS);
  const before = await page.evaluate(hudRenders);
  const from = await page.evaluate(tickNow);
  const fps: number[] = [];
  for (let t = 0; t < RUN_MS; t += SAMPLE_MS) {
    await page.waitForTimeout(SAMPLE_MS);
    fps.push(await page.evaluate(fpsNow));
  }
  const after = await page.evaluate(hudRenders);
  const ticks = (await page.evaluate(tickNow)) - from;
  await page.keyboard.press('Space');
  const renders: Record<string, number> = {};
  for (const [name, n] of Object.entries(after))
    if (n > (before[name] ?? 0)) renders[name] = n - (before[name] ?? 0);
  return { fps: fps.reduce((a, b) => a + b, 0) / fps.length, renders, ticks };
}

const sum = (r: Record<string, number>) =>
  Object.values(r).reduce((a, b) => a + b, 0);

test('the HUD costs little while playing', async ({ page, request }) => {
  test.setTimeout(360_000);
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const start =
    pack.header.rounds[0].freeze_end_tick + 5 * pack.header.tick_rate;

  const errors = trackErrors(page);
  await page.addInitScript(
    (key) => localStorage.setItem(key, 'high'),
    QUALITY_KEY
  );

  await open(page, start, false);
  const bare = await run(page);
  expect(sum(bare.renders)).toBe(0);

  await open(page, start, true);
  const hud = await run(page);

  await open(page, start, true);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const slow = await run(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });

  const ratio = hud.fps / bare.fps;
  const addedMs = 1000 / hud.fps - 1000 / bare.fps;
  console.log(
    `perf: viewport alone ${bare.fps.toFixed(1)} fps, with the HUD ${hud.fps.toFixed(1)} fps ` +
      `(ratio ${ratio.toFixed(3)}, the HUD adds ${addedMs.toFixed(2)} ms a frame), ` +
      `with the HUD at 4× CPU slowdown ${slow.fps.toFixed(1)} fps; ticks played ` +
      `${bare.ticks.toFixed(0)}, ${hud.ticks.toFixed(0)}, ${slow.ticks.toFixed(0)}`
  );
  console.log(
    `perf: HUD renders over 10 s: ${sum(hud.renders)} ${JSON.stringify(hud.renders)}; ` +
      `at 4× slowdown ${sum(slow.renders)} ${JSON.stringify(slow.renders)}`
  );
  test
    .info()
    .annotations.push(
      { type: 'fps hud=0', description: bare.fps.toFixed(1) },
      { type: 'fps hud', description: hud.fps.toFixed(1) },
      { type: 'fps hud cpu×4', description: slow.fps.toFixed(1) },
      { type: 'hud/hud=0 ratio', description: ratio.toFixed(3) },
      { type: 'hud ms/frame added', description: addedMs.toFixed(2) },
      { type: 'hud renders', description: String(sum(hud.renders)) }
    );

  // Both runs played: 10 s at 1× is about 10 s of ticks.
  expect(bare.ticks).toBeGreaterThan(pack.header.tick_rate);
  expect(hud.ticks).toBeGreaterThan(pack.header.tick_rate);
  expect(hud.fps).toBeGreaterThanOrEqual(60);
  // Added ms, not a ratio: at ~200 fps, 0.95 leaves the HUD about 0.26 ms (noise, minimap,
  // compositing).
  expect(addedMs).toBeLessThanOrEqual(2.5);
  expect(sum(hud.renders)).toBeGreaterThan(0);
  expect(sum(hud.renders)).toBeLessThanOrEqual(150);
  expect(errors).toEqual([]);
});
