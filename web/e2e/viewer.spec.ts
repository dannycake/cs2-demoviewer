import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { DemoStatus } from '../src/api/demos';
import { eyePoint } from '../src/geo/coords';
import { matchDate, matchTitle } from '../src/match-title';
import { SOURCE_URL } from '../src/links';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { pageTitle } from '../src/router';
import { newPlayerState, playerStateAt } from '../src/sim/sample';
import { SETTINGS_KEY } from '../src/state/settings';
import { animationFrames } from './wait';
import { trackErrors } from './errors';

// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the
// assets, and the id of an uploaded Mirage demo in DEMOVIEWER_E2E_DEMO.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const SHOT = fileURLToPath(new URL('./out/mirage-r1.jpg', import.meta.url));
const FREE_SHOT = fileURLToPath(
  new URL('./out/mirage-r1-free.jpg', import.meta.url)
);

interface CameraPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mode: string;
}

interface DebugHandle {
  stats: { fps: number; tris: number };
  store: {
    getState(): { tick: number; follow: number | null; playing: boolean };
  };
  camera(): CameraPose;
}

/** The camera pose, read in the page. */
const cameraPose = () =>
  (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.camera();

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

test('plays the Mirage demo from a URL position', async ({ page, request }) => {
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const start = pack.header.rounds[0].freeze_end_tick + 640;

  const errors = trackErrors(page);

  await page.goto(`/d/${demoId}?r=1&t=${start}`);
  const viewport = page.getByTestId('viewport');
  await expect(viewport).toHaveAttribute('data-ready', 'true', {
    timeout: 90_000,
  });
  await expect(page.getByTestId('player-row')).toHaveCount(10);

  const clock = page.getByTestId('clock');
  await expect(clock).toHaveAttribute('data-tick', String(start));

  // The tab names the match from the server's summary.
  const { summary } = (await (
    await request.get(`/api/demos/${demoId}`)
  ).json()) as DemoStatus;
  expect(summary).not.toBeNull();
  await expect(page).toHaveTitle(/ — Mirage \d+–\d+ — \d{4}-\d{2}-\d{2}$/);
  await expect(page).toHaveTitle(
    pageTitle(matchTitle(summary!), matchDate(summary!))
  );

  // Held Tab, the scoreboard links every player's Steam profile, in a new tab.
  await page.keyboard.down('Tab');
  const profiles = page
    .getByRole('dialog', { name: 'Scoreboard' })
    .getByRole('link');
  await expect(profiles).toHaveCount(10);
  for (const link of await profiles.all()) {
    await expect(link).toHaveAttribute(
      'href',
      /^https:\/\/steamcommunity\.com\/profiles\/\d{17}$/
    );
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await page.keyboard.up('Tab');
  await expect(page.getByRole('dialog', { name: 'Scoreboard' })).toHaveCount(0);

  await page.keyboard.press('Space');
  await expect
    .poll(async () => Number(await clock.getAttribute('data-tick')))
    .toBeGreaterThan(start);

  // POV is the default camera. Let the fps window fill with its frames while playing: a
  // measurement, so a span of wall time (`stats.fps` is counted over each 500 ms of drawing).
  await page.waitForTimeout(1500);
  mkdirSync(fileURLToPath(new URL('./out/', import.meta.url)), {
    recursive: true,
  });
  await page.screenshot({ path: SHOT, type: 'jpeg', quality: 85 });

  const stats = await page.evaluate(
    () =>
      (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.stats
  );

  // Paused, the POV camera sits at player 1's eye: drawn at the tick the clock stopped on.
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __demoviewer: DebugHandle }
          ).__demoviewer.store.getState().playing
      )
    )
    .toBe(false);
  await animationFrames(page);
  const { tick, follow, pose } = await page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: DebugHandle }).__demoviewer;
    const s = d.store.getState();
    return { tick: s.tick, follow: s.follow, pose: d.camera() };
  });
  expect(pose.mode).toBe('pov');
  expect(follow).toBe(0);
  const state = playerStateAt(
    pack.rounds[0].players[0],
    pack.header.rounds[0],
    tick,
    pack.header,
    newPlayerState()
  );
  if (state.present) {
    const eye = eyePoint(state, { x: 0, y: 0, z: 0 });
    const away = Math.hypot(pose.x - eye.x, pose.y - eye.y, pose.z - eye.z);
    console.log(`pov: camera ${away.toFixed(4)} m from player 1's eye`);
    expect(away).toBeLessThan(0.01);
  }

  // Free starts where POV was and flies forward with W.
  await page.keyboard.press('KeyC');
  await expect
    .poll(async () => (await page.evaluate(cameraPose)).mode)
    .toBe('free');
  const free0 = await page.evaluate(cameraPose);
  expect(
    Math.hypot(free0.x - pose.x, free0.y - pose.y, free0.z - pose.z)
  ).toBeLessThan(0.05);
  // W held until the camera has flown a metre and more: however long a loaded machine takes.
  const flownFrom0 = async () => {
    const c = await page.evaluate(cameraPose);
    return Math.hypot(c.x - free0.x, c.y - free0.y, c.z - free0.z);
  };
  const held = Date.now();
  await page.keyboard.down('KeyW');
  await expect.poll(flownFrom0).toBeGreaterThan(1);
  await page.keyboard.up('KeyW');
  const moved = await flownFrom0();
  console.log(
    `free: flew ${moved.toFixed(2)} m in ${((Date.now() - held) / 1000).toFixed(1)} s with W`
  );
  expect(moved).toBeGreaterThan(1);
  await page.screenshot({ path: FREE_SHOT, type: 'jpeg', quality: 85 });
  console.log(
    `viewer: ${stats.fps.toFixed(1)} fps, ${stats.tris} tris at 2560x1440`
  );
  test.info().annotations.push({
    type: 'fps',
    description: stats.fps.toFixed(1),
  });
  expect(stats.fps).toBeGreaterThanOrEqual(60);
  expect(errors).toEqual([]);
});

// The settings link to the project's source, in a new tab. Its click gives focus back to the
// page: Space plays after it, with the settings still open.
test('the settings link to the source and leave Space to playback', async ({
  page,
  context,
}) => {
  // Muted: the clicks would start the sound otherwise.
  await page.addInitScript(
    (key) => localStorage.setItem(key, JSON.stringify({ muted: true })),
    SETTINGS_KEY
  );
  // The tab the link opens is answered here, not by GitHub.
  await context.route(`${SOURCE_URL}*`, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>source</title>' })
  );
  const errors = trackErrors(page);
  await page.goto(`/d/${demoId}?r=1`);
  await expect(page.getByTestId('player-row')).toHaveCount(10);
  const playing = () =>
    page.evaluate(
      () =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.store.getState().playing
    );
  expect(await playing()).toBe(false);

  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  const link = settings.getByRole('link', { name: 'Source on GitHub' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', SOURCE_URL);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');

  const opened = page.waitForEvent('popup');
  await link.click();
  const tab = await opened;
  await expect(tab).toHaveURL(SOURCE_URL);
  await tab.close();

  await page.bringToFront();
  expect(
    await page.evaluate(() => document.activeElement === document.body)
  ).toBe(true);
  await expect(settings).toBeVisible();
  await page.keyboard.press('Space');
  await expect.poll(playing).toBe(true);
  expect(errors).toEqual([]);
});

// A scene draws one map: going from one demo to another of another map in the same page (the
// app's history moving, as Back does) makes the 3D view of the next demo a scene of its own,
// which loads that map; the one before is not asked for it. Needs the Nuke demo too
// (DEMOVIEWER_E2E_NUKE, as baked.spec.ts does).
const nukeId = process.env.DEMOVIEWER_E2E_NUKE;
test('draws the next demo’s map when the page moves to a demo of another map', async ({
  page,
}) => {
  test.skip(
    !demoId || !nukeId,
    'set DEMOVIEWER_E2E_DEMO and DEMOVIEWER_E2E_NUKE'
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const worlds: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/^\/maps\/[^/]+\/world[^/]*\.glb$/.test(path)) worlds.push(path);
  });
  const view = page.getByTestId('viewport');
  await page.goto(`/d/${demoId}?debug=1`);
  await expect(view).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  const first = await page.evaluate(() => {
    (window as unknown as { firstStats: unknown }).firstStats = (
      window as unknown as { __demoviewer: { stats: unknown } }
    ).__demoviewer.stats;
    return (
      window as unknown as {
        __demoviewer: { store: { getState(): { map: string } } };
      }
    ).__demoviewer.store.getState().map;
  });
  expect(first).toBe('de_mirage');

  await page.evaluate((id) => {
    history.pushState(null, '', `/d/${id}?debug=1`);
    dispatchEvent(new PopStateEvent('popstate'));
  }, nukeId!);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __demoviewer?: { store: { getState(): { map: string | null } } };
            }
          ).__demoviewer?.store.getState().map
      )
    )
    .toBe('de_nuke');
  await expect(view).toHaveAttribute('data-ready', 'true', { timeout: 90_000 });
  // A scene of its own (its own stats), the world of its map drawn, and no failure shown.
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { firstStats: unknown }).firstStats !==
        (window as unknown as { __demoviewer: { stats: unknown } }).__demoviewer
          .stats
    )
  ).toBe(true);
  expect(worlds).toContain('/maps/de_nuke/world.glb');
  await expect(view.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]);
});
