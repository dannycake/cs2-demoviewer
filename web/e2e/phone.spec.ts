import { devices, expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { animationFrames, settled, trackLoads } from './wait';
import { trackErrors } from './errors';

// The viewer on a phone (Playwright's Pixel 7: 412×839 CSS px, touch, a mobile user agent), on
// the demo at round 1 + 0:30 (Mirage's; or another map's, as de_cache's for its live sun at
// `low`, with DEMOVIEWER_E2E_PHONE_AT and _P below), with a link that names no camera:
// - It opens on the full radar at the `low` preset, and fetches no world, hull or player model
//   (`/maps/<map>/world*.glb`, `hull.glb`, anything under `/players/`), nor the 3D view's own
//   chunk (three.js and the scene: `/assets/Viewport-*.js`), until the 3D view is first shown;
//   the radar's own files are expected.
// - Taps: with Settings open, a tap on an enemy's radar disc only closes Settings; the same
//   tap again follows a player of that side; a tap on play plays; a touch drag on the scrubber
//   moves the tick.
// - The POV button fetches the 3D view's chunk, the world and the players and draws the 3D
//   view: their phone tier, as the manifests list it (`world_lo.glb`, and `ct_lo.glb` and
//   `t_lo.glb` under `/players/`), and none of the desktop's models (`world.glb`, `ct.glb`,
//   `t.glb`). There a tap on empty space plays or pauses, and with Settings open only closes
//   it. The bytes over the wire from the tap until it first draws and once it has settled and
//   played (with the first-person arms and clips, `/viewmodels/`), and its frame rate playing
//   at `low`, are printed.
// - The page never scrolls sideways.
// Writes e2e/out/phone-radar.jpg and phone-3d.jpg. Needs the server on 8095 (or
// DEMOVIEWER_E2E_URL) and DEMOVIEWER_E2E_DEMO, as viewer.spec.ts does.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
/** Seconds into round 1 the link opens at: 30, or DEMOVIEWER_E2E_PHONE_AT. */
const AT_S = Number(process.env.DEMOVIEWER_E2E_PHONE_AT ?? 30);
/**
 * `&p=` for the link (1-based), from DEMOVIEWER_E2E_PHONE_P: a player whose enemies' discs are
 * clear of the Settings panel, where the demo's first player's are not (de_cache's: a T, 2).
 */
const PLAYER_Q = process.env.DEMOVIEWER_E2E_PHONE_P
  ? `&p=${Number(process.env.DEMOVIEWER_E2E_PHONE_P)}`
  : '';
const out = (name: string) =>
  fileURLToPath(new URL(`./out/${name}`, import.meta.url));

test.use({ ...devices['Pixel 7'] });

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

/** What the 3D view of `map` must not fetch before it is first shown. */
const worldOf = (map: string) =>
  new RegExp(`/maps/${map}/(world[^/?]*|hull)\\.glb(\\?|$)`);
const PLAYERS = /\/players\//;
/** The 3D view's chunk, as built or as the dev server serves it. */
const VIEW_CHUNK =
  /\/(assets\/Viewport-[^/]+\.js|src\/components\/Viewport\.tsx)$/;

/** The store's play state and who is followed. */
const state = (page: Page) =>
  page.evaluate(() => {
    const s = window.__demoviewer!.store.getState();
    return {
      playing: s.playing,
      follow: s.follow,
      radar: s.radar,
      camera: s.camera,
      tick: s.tick,
    };
  });

/** Whether the page scrolls sideways. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

/** Whether the element at CSS point (x, y) is `selector`'s. */
const under = (page: Page, x: number, y: number, selector: string) =>
  page.evaluate(
    ([x, y, sel]) =>
      document.elementFromPoint(x, y) === document.querySelector(sel),
    [x, y, selector] as const
  );

const RADAR = 'canvas[role="img"]';
const VIEW = '[data-testid="viewport"] canvas';

/**
 * The full radar's player discs, read off its canvas: clusters of pixels in a team's solid
 * colour (T `#f2a33a`, CT `#4da3ff`), their centres in CSS pixels of the page.
 */
const discs = (page: Page) =>
  page.evaluate((sel) => {
    const c = document.querySelector<HTMLCanvasElement>(sel)!;
    const r = c.getBoundingClientRect();
    const k = c.width / r.width;
    const { data, width, height } = c
      .getContext('2d')!
      .getImageData(0, 0, c.width, c.height);
    const colors: Record<number, number[]> = {
      2: [0xf2, 0xa3, 0x3a],
      3: [0x4d, 0xa3, 0xff],
    };
    const found: { team: number; sx: number; sy: number; n: number }[] = [];
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        if (data[o + 3] < 250) continue;
        const team = [2, 3].find((t) =>
          colors[t].every((v, j) => Math.abs(data[o + j] - v) <= 8)
        );
        if (team === undefined) continue;
        let d = found.find(
          (q) =>
            q.team === team && Math.hypot(q.sx / q.n - x, q.sy / q.n - y) < 24
        );
        if (!d) found.push((d = { team, sx: 0, sy: 0, n: 0 }));
        d.sx += x;
        d.sy += y;
        d.n++;
      }
    return found
      .filter((d) => d.n >= 60)
      .map((d) => ({
        team: d.team,
        x: r.left + d.sx / d.n / k,
        y: r.top + d.sy / d.n / k,
      }));
  }, RADAR);

/**
 * A point of the 3D view clear of every player (80 px from each living chest the camera drawn
 * last sees), on the canvas itself rather than the HUD over it; null if there is none.
 */
const emptySpot = (page: Page) =>
  page.evaluate((sel) => {
    const d = window.__demoviewer!;
    const cam = d.camera();
    const canvas = document.querySelector<HTMLCanvasElement>(sel)!;
    const r = canvas.getBoundingClientRect();
    const DEG = Math.PI / 180;
    const yaw = cam.yaw * DEG;
    const pitch = cam.pitch * DEG;
    const fwd = [
      Math.cos(pitch) * Math.sin(yaw),
      -Math.sin(pitch),
      Math.cos(pitch) * Math.cos(yaw),
    ];
    const rl = Math.hypot(fwd[2], fwd[0]);
    const right = [-fwd[2] / rl, 0, fwd[0] / rl];
    const up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    const t = Math.tan((cam.fov * DEG) / 2);
    const dot = (a: number[], b: number[]) =>
      a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const chests: [number, number][] = [];
    const n = d.store.getState().pack!.header.players.length;
    for (let i = 0; i < n; i++) {
      const rig = d.rig(i);
      if (!rig) continue;
      const v = [rig.x - cam.x, rig.y + 1.1 - cam.y, rig.z - cam.z];
      const z = dot(v, fwd);
      if (z <= 0) continue;
      chests.push([
        r.left +
          ((dot(v, right) / (z * t * (r.width / r.height)) + 1) / 2) * r.width,
        r.top + ((1 - dot(v, up) / (z * t)) / 2) * r.height,
      ]);
    }
    for (let gy = 0.35; gy <= 0.7; gy += 0.05)
      for (let gx = 0.15; gx <= 0.85; gx += 0.05) {
        const x = r.left + gx * r.width;
        const y = r.top + gy * r.height;
        if (document.elementFromPoint(x, y) !== canvas) continue;
        if (chests.every(([cx, cy]) => Math.hypot(cx - x, cy - y) > 80))
          return { x, y };
      }
    return null;
  }, VIEW);

test('a phone opens on the radar, loads the 3D view when asked and takes taps', async ({
  page,
  request,
  context,
}) => {
  test.setTimeout(180_000);
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const start =
    pack.header.rounds[0].freeze_end_tick + AT_S * pack.header.tick_rate;
  const teamOf = (i: number | null) =>
    i === null ? null : pack.header.players[i].team_by_round[0];
  const map = pack.header.map;
  const WORLD = worldOf(map);

  const errors = trackErrors(page);
  const urls: string[] = [];
  page.on('request', (r) => urls.push(new URL(r.url()).pathname));
  await trackLoads(page);
  await page.goto(`/d/${demoId}?r=1&t=${start}${PLAYER_Q}&debug=1`);

  // The full radar, at `low`, with nothing of the 3D view fetched.
  const radar = page.getByRole('img', {
    name: new RegExp(`^Radar of ${map.replace(/^de_/, '')}`),
  });
  await expect(radar).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await discs(page)).length).toBeGreaterThan(5);
  expect((await state(page)).radar).toBe(true);
  await expect(page.getByTestId('hud-quality')).toHaveAttribute(
    'data-quality',
    'low'
  );
  expect(await sideways(page)).toBe(false);
  mkdirSync(out(''), { recursive: true });
  await page.screenshot({
    path: out('phone-radar.jpg'),
    type: 'jpeg',
    quality: 85,
  });

  // A tap with Settings open only closes it; the same tap again follows the disc's player, an
  // enemy of the player followed now.
  const before = await state(page);
  const enemy = teamOf(before.follow) === 2 ? 3 : 2;
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await page.getByRole('button', { name: 'Settings' }).tap();
  await expect(settings).toBeVisible();
  let disc: { x: number; y: number } | null = null;
  for (const d of await discs(page))
    if (d.team === enemy && (await under(page, d.x, d.y, RADAR))) disc = d;
  expect(disc, 'an enemy disc clear of the Settings panel').not.toBeNull();
  await page.touchscreen.tap(disc!.x, disc!.y);
  await expect(settings).toHaveCount(0);
  expect((await state(page)).follow).toBe(before.follow);
  await page.touchscreen.tap(disc!.x, disc!.y);
  await expect.poll(async () => teamOf((await state(page)).follow)).toBe(enemy);
  expect((await state(page)).radar).toBe(true);

  // Play, then pause, by tapping the transport.
  await page.getByRole('button', { name: 'Play (Space)' }).tap();
  await expect.poll(async () => (await state(page)).playing).toBe(true);
  await page.getByRole('button', { name: 'Pause (Space)' }).tap();
  await expect.poll(async () => (await state(page)).playing).toBe(false);

  // A touch drag along the scrubber moves the tick, and the page stays put.
  const cdp = await context.newCDPSession(page);
  const touch = (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: [number, number][]
  ) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map(([x, y], id) => ({ x, y, id })),
    });
  const box = (await page
    .getByRole('slider', { name: 'Position in the round' })
    .boundingBox())!;
  const t0 = (await state(page)).tick;
  const y = box.y + box.height / 2;
  await touch('touchStart', [[box.x + box.width * 0.3, y]]);
  for (let k = 1; k <= 10; k++) {
    await touch('touchMove', [[box.x + box.width * (0.3 + 0.04 * k), y]]);
    // A finger's pace: one move a frame.
    await animationFrames(page, 1);
  }
  await touch('touchEnd', []);
  await expect.poll(async () => (await state(page)).tick).not.toBe(t0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Still nothing of the 3D view, its code included.
  expect(
    urls.filter((u) => WORLD.test(u) || PLAYERS.test(u) || VIEW_CHUNK.test(u))
  ).toEqual([]);
  expect(urls.some((u) => u.startsWith(`/maps/${map}/`))).toBe(true);

  // What the 3D view costs a phone: the bytes over the wire from the tap until it first draws,
  // and once it has settled and played a few seconds (the first-person arms and clips come when
  // POV first shows them).
  await cdp.send('Network.enable');
  const paths = new Map<string, string>();
  const fetched: { path: string; bytes: number }[] = [];
  cdp.on('Network.responseReceived', (e) =>
    paths.set(e.requestId, new URL(e.response.url).pathname)
  );
  cdp.on('Network.loadingFinished', (e) =>
    fetched.push({
      path: paths.get(e.requestId) ?? '?',
      bytes: e.encodedDataLength,
    })
  );
  const sum = (f: (p: string) => boolean = () => true) =>
    fetched.filter((x) => f(x.path)).reduce((a, x) => a + x.bytes, 0);

  // POV: the world and the players load, and the 3D view draws.
  await page
    .getByRole('group', { name: 'Camera' })
    .getByRole('button', { name: /^POV/ })
    .tap();
  await expect(radar).toHaveCount(0);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  const worldGlb = new RegExp(`/maps/${map}/world[^/]*\\.glb$`);
  expect(urls.some((u) => VIEW_CHUNK.test(u))).toBe(true);
  expect(urls.some((u) => worldGlb.test(u))).toBe(true);
  expect(urls.some((u) => PLAYERS.test(u))).toBe(true);
  // The phone tier, which the manifests list where tools/phone-tier.mjs made it.
  const mapManifest = (await (
    await request.get(`/maps/${map}/manifest.json`)
  ).json()) as { files: Record<string, unknown> };
  const playersManifest = (await (
    await request.get('/players/manifest.json')
  ).json()) as Record<'ct' | 't', { lo?: { file: string } }>;
  expect(
    mapManifest.files['world_lo.glb'],
    `${map}'s manifest lists world_lo.glb (tools/phone-tier.mjs ${map})`
  ).toBeDefined();
  const phoneTier = [`/maps/${map}/world_lo.glb`];
  for (const side of ['ct', 't'] as const) {
    const lo = playersManifest[side].lo;
    expect(
      lo,
      `the players manifest lists ${side}.lo (tools/phone-tier.mjs players)`
    ).toBeDefined();
    phoneTier.push(`/players/${lo!.file}`);
  }
  for (const path of phoneTier) expect(urls).toContain(path);
  for (const path of [
    `/maps/${map}/world.glb`,
    '/players/ct.glb',
    '/players/t.glb',
  ])
    expect(urls).not.toContain(path);
  const frames = () => page.evaluate(() => window.__demoviewer!.stats.frames);
  await expect.poll(frames).toBeGreaterThan(0);
  const firstDraw = sum();
  await settled(page);
  await page.screenshot({
    path: out('phone-3d.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  // Played for 4 s at `low`: the scene's frame rate, sampled every 500 ms after the first, the
  // triangles of the last frame (shadow maps included) and the draws of the world's own shadow
  // map over those 4 s (none on a map whose world casts every frame, or once its map is drawn).
  await page.evaluate(() => window.__demoviewer!.store.getState().play());
  // Measurements, so spans of wall time: a second fills the fps window with playing frames,
  // then a sample each 500 ms window (`stats.fps`).
  await page.waitForTimeout(1000);
  const worldShadows = () =>
    page.evaluate(() => window.__demoviewer!.stats.worldShadows);
  const shadowsBefore = await worldShadows();
  const fps: number[] = [];
  for (let k = 0; k < 6; k++) {
    await page.waitForTimeout(500);
    fps.push(await page.evaluate(() => window.__demoviewer!.stats.fps));
  }
  const tris = await page.evaluate(() => window.__demoviewer!.stats.tris);
  const shadowDraws = (await worldShadows()) - shadowsBefore;
  await page.evaluate(() => window.__demoviewer!.store.getState().pause());
  const mb = (b: number) => (b / 1e6).toFixed(2);
  const viewmodels = sum((p) => p.startsWith('/viewmodels/'));
  const meanFps = fps.reduce((a, b) => a + b, 0) / fps.length;
  console.log(
    `phone 3D view (POV, low): ${mb(firstDraw)} MB until it first drew, ` +
      `${mb(sum())} MB settled and played, ${(viewmodels / 1e3).toFixed(0)} kB of it /viewmodels/ ` +
      `(${fetched.filter((x) => x.path.startsWith('/viewmodels/')).length} files); ` +
      `${meanFps.toFixed(1)} fps playing, ${(tris / 1e6).toFixed(2)} M triangles a frame, ` +
      `the world's shadow map drawn ${shadowDraws} times in those 3 s (${map})`
  );
  test
    .info()
    .annotations.push(
      { type: 'phone 3D MB', description: `${mb(firstDraw)} / ${mb(sum())}` },
      { type: 'phone fps', description: meanFps.toFixed(1) }
    );
  expect(await sideways(page)).toBe(false);

  // A tap on empty space plays, and another pauses.
  for (const playing of [true, false]) {
    const spot = await emptySpot(page);
    expect(spot, 'empty space in the 3D view').not.toBeNull();
    const was = await state(page);
    await page.touchscreen.tap(spot!.x, spot!.y);
    await expect.poll(async () => (await state(page)).playing).toBe(playing);
    expect((await state(page)).follow).toBe(was.follow);
  }

  // With Settings open, a tap on empty space only closes it.
  await page.getByRole('button', { name: 'Settings' }).tap();
  await expect(settings).toBeVisible();
  const spot = await emptySpot(page);
  expect(spot, 'empty space beside the Settings panel').not.toBeNull();
  const was = await state(page);
  await page.touchscreen.tap(spot!.x, spot!.y);
  await expect(settings).toHaveCount(0);
  // The 3D view takes a tap as its pointerup arrives (Viewport); give a toggle two frames to
  // show before reading that there was none.
  await animationFrames(page);
  const now = await state(page);
  expect(now.playing).toBe(was.playing);
  expect(now.follow).toBe(was.follow);
  expect(await sideways(page)).toBe(false);
  console.log(
    `phone: radar first (no 3D fetch before POV), then ${
      urls.filter((u) => WORLD.test(u) || PLAYERS.test(u)).length
    } world, hull and player requests, the phone tier's ${phoneTier
      .map((p) => p.split('/').pop())
      .join(', ')}; followed player ${now.follow! + 1}`
  );
  expect(errors).toEqual([]);
});
