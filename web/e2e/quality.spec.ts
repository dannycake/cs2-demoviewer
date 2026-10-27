import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { frames, settled, trackLoads } from './wait';
import { trackErrors } from './errors';

// The quality presets on the Mirage demo (Task 4): with nothing saved, the first second picks
// a preset; `Q` cycles low → medium → high, and ten cycles leave the renderer's textures,
// geometries and programs where the second left them, and `high` drawing the same paused
// frame with exactly the triangles and draw calls it had before (no stale world, shadow or
// post draws). A change to or from `low` swaps the world and the players for their phone tier
// (`world_lo.glb`, `ct_lo.glb`, `t_lo.glb`) and back, so each change waits until the viewport
// is ready again (`data-ready`: both in, the replaced ones freed) before anything is read.
// The paused frame's rate (timed by `Scene.probeFps`, which waits for the GPU) is only a
// coarse guard: on a shared machine two timings 30 s apart drift by 10 % or more with no
// switching at all. Writes e2e/out/quality-{low,medium,high}.jpg (the opening view) and
// -pov.jpg (player 1's POV, picked), and quality-high-pov3.jpg (the POV of player 3 at high).
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) and DEMOVIEWER_E2E_DEMO, as viewer.spec.ts
// does.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const OUT = new URL('./out/', import.meta.url);
const shot = (name: string) => fileURLToPath(new URL(`${name}.jpg`, OUT));

type Quality = 'low' | 'medium' | 'high';
interface Handle {
  stats: { fps: number; tris: number; probe: number };
  store: {
    getState(): {
      quality: Quality;
      qualityFrom: string;
      seekTick(t: number): void;
      setQuality(q: Quality): void;
      setCamera(mode: 'pov' | 'free'): void;
    };
  };
  memory(): {
    textures: number;
    geometries: number;
    programs: number;
    calls: number;
  };
  probe(ms?: number): Promise<number>;
}

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

/** Round 1's freeze end plus `after` ticks. */
async function startTick(
  request: import('@playwright/test').APIRequestContext,
  after = 640
): Promise<number> {
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  return pack.header.rounds[0].freeze_end_tick + after;
}

/** The viewport's centre pixel as drawn, from a 1×1 PNG screenshot. */
async function centrePixel(page: Page): Promise<[number, number, number]> {
  const box = await page.getByTestId('viewport').boundingBox();
  expect(box).not.toBeNull();
  const png = await page.screenshot({
    type: 'png',
    clip: {
      x: Math.floor(box!.x + box!.width / 2),
      y: Math.floor(box!.y + box!.height / 2),
      width: 1,
      height: 1,
    },
  });
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT')
      idat.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  // A row filter byte, then the pixel: no PNG filter changes a row's first pixel.
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1], raw[2], raw[3]];
}

async function open(page: Page, tick: number, saved: Quality | null) {
  await trackLoads(page);
  if (saved)
    await page.addInitScript(
      (q) => localStorage.setItem('demoviewer.quality', q),
      saved
    );
  await page.goto(`/d/${demoId}?r=1&t=${tick}&debug=1`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
}

const read = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
    const s = d.store.getState();
    return {
      quality: s.quality,
      from: s.qualityFrom,
      fps: d.stats.fps,
      probe: d.stats.probe,
      ...d.memory(),
    };
  });

test('picks a preset from the first second at medium', async ({
  page,
  request,
}) => {
  const errors = trackErrors(page);
  await open(page, await startTick(request), null);
  await expect
    .poll(async () => (await read(page)).from, { timeout: 10_000 })
    .toBe('detected');
  const r = await read(page);
  const expected =
    r.probe >= 100 ? 'high' : r.probe < 40 ? 'low' : ('medium' as Quality);
  console.log(`auto: ${r.probe.toFixed(1)} fps at medium → ${r.quality}`);
  test.info().annotations.push({
    type: 'probe',
    description: `${r.probe.toFixed(1)} → ${r.quality}`,
  });
  expect(r.quality).toBe(expected);
  await expect(page.getByTestId('hud-quality')).toHaveAttribute(
    'data-quality',
    expected
  );
  // Detection is not a choice: nothing is saved.
  expect(
    await page.evaluate(() => localStorage.getItem('demoviewer.quality'))
  ).toBeNull();
  expect(errors).toEqual([]);
});

test('cycles presets with Q without leaking GPU memory', async ({
  page,
  request,
}) => {
  const errors = trackErrors(page);
  const tick = await startTick(request);
  // A saved choice: no detection in the middle of the cycles.
  await open(page, tick, 'medium');
  mkdirSync(fileURLToPath(OUT), { recursive: true });
  const hud = page.getByTestId('hud-quality');
  const view = page.getByTestId('viewport');

  /**
   * Presses Q and waits for the next preset to be drawn: its world and players in (the render
   * that shows the preset is the one that turns `data-ready` false when they change), then,
   * paused, everything it loads drawn (`settled`), or, playing, a few frames drawn at it.
   */
  const next = async (q: Quality, playing = false) => {
    const since = await frames(page);
    await page.keyboard.press('KeyQ');
    await expect(hud).toHaveAttribute('data-quality', q);
    await expect(view).toHaveAttribute('data-ready', 'true', {
      timeout: 90_000,
    });
    if (playing)
      await expect.poll(() => frames(page)).toBeGreaterThan(since + 10);
    else await settled(page, { since });
  };
  /**
   * The paused frame at `tick`, at the current preset: its triangles and draw calls, and its
   * draw rate as the best of five one-second probes, so a busy machine's other work does not
   * decide the comparison.
   */
  const probe = async () => {
    await page.evaluate(
      (t) =>
        (window as unknown as { __demoviewer: Handle }).__demoviewer.store
          .getState()
          .seekTick(t),
      tick
    );
    await settled(page);
    let fps = 0;
    for (let i = 0; i < 5; i++)
      fps = Math.max(
        fps,
        await page.evaluate(() =>
          (window as unknown as { __demoviewer: Handle }).__demoviewer.probe(
            1000
          )
        )
      );
    // Paused, the probe's last draw is the frame at `tick`.
    const frame = await page.evaluate(() => {
      const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
      return { tris: d.stats.tris, calls: d.memory().calls };
    });
    return { fps, ...frame };
  };

  await next('high');
  const before = await probe();

  // Each preset while playing: its frame rate and a picture of the opening overview.
  await page.keyboard.press('Space');
  const fps: Partial<Record<Quality, number>> = {};
  for (const q of ['high', 'low', 'medium'] as const) {
    if (q !== 'high') await next(q, true);
    // A measurement, so a span of wall time: the fps windows (500 ms each) of playing at `q`.
    await page.waitForTimeout(2000);
    fps[q] = (await read(page)).fps;
    await page.screenshot({
      path: shot(`quality-${q}`),
      type: 'jpeg',
      quality: 85,
    });
  }
  await page.keyboard.press('Space');
  console.log(
    `fps playing: low ${fps.low?.toFixed(1)}, medium ${fps.medium?.toFixed(1)}, high ${fps.high?.toFixed(1)}`
  );

  // Ten cycles, paused (a switch still draws), counting at medium after each.
  const counts: Awaited<ReturnType<typeof read>>[] = [];
  for (let i = 0; i < 10; i++) {
    for (const q of ['high', 'low', 'medium'] as const) await next(q);
    counts.push(await read(page));
  }
  console.log(
    'after each cycle (textures/geometries/programs): ' +
      counts.map((c) => `${c.textures}/${c.geometries}/${c.programs}`).join(' ')
  );
  for (const c of counts.slice(2)) {
    expect(c.quality).toBe('medium');
    expect(c.textures).toBeLessThanOrEqual(counts[1].textures);
    expect(c.geometries).toBeLessThanOrEqual(counts[1].geometries);
    expect(c.programs).toBeLessThanOrEqual(counts[1].programs);
  }

  // `high` again: the same frame drawn with the same triangles and calls as before the
  // cycles, not much slower, and playing at 60 or more.
  await next('high');
  const after = await probe();
  await page.keyboard.press('Space');
  // A measurement, as above.
  await page.waitForTimeout(2000);
  const playing = (await read(page)).fps;
  await page.keyboard.press('Space');
  console.log(
    `high, paused frame: ${before.fps.toFixed(1)} fps, ${before.tris} tris, ${before.calls} calls before the cycles; ` +
      `${after.fps.toFixed(1)} fps, ${after.tris} tris, ${after.calls} calls after; ` +
      `playing ${fps.high?.toFixed(1)} before, ${playing.toFixed(1)} after`
  );
  test.info().annotations.push({
    type: 'fps',
    description: `playing low ${fps.low?.toFixed(1)}, medium ${fps.medium?.toFixed(1)}, high ${fps.high?.toFixed(1)} → ${playing.toFixed(1)}; frame at high ${before.fps.toFixed(1)} → ${after.fps.toFixed(1)}, ${before.calls} → ${after.calls} calls`,
  });
  expect(fps.high).toBeGreaterThanOrEqual(60);
  expect(playing).toBeGreaterThanOrEqual(60);
  expect(before.calls).toBeGreaterThan(0);
  expect(after.tris).toBe(before.tris);
  expect(after.calls).toBe(before.calls);
  expect(after.fps).toBeGreaterThanOrEqual(0.7 * before.fps);

  // Player 1's POV at each preset, for the look.
  await page.keyboard.press('Digit1');
  for (const q of ['low', 'medium', 'high'] as const) {
    await next(q);
    await page.screenshot({
      path: shot(`quality-${q}-pov`),
      type: 'jpeg',
      quality: 85,
    });
  }
  expect(errors).toEqual([]);
});

// Zero-length normals (faces that cancel at a shared vertex) turn into NaN in the lit shader;
// at high, bloom spread one such pixel over most of this view and left it background-blank.
test('draws the POV of player 3 at high with no blank frame', async ({
  page,
  request,
}) => {
  const errors = trackErrors(page);
  await open(page, await startTick(request, 1500), 'high');
  await page.keyboard.press('Digit3');
  await page.evaluate(() =>
    (window as unknown as { __demoviewer: Handle }).__demoviewer.store
      .getState()
      .setCamera('pov')
  );
  await settled(page);
  mkdirSync(fileURLToPath(OUT), { recursive: true });
  await page.screenshot({
    path: shot('quality-high-pov3'),
    type: 'jpeg',
    quality: 85,
  });
  const [r, g, b] = await centrePixel(page);
  console.log(`high, POV of player 3: centre ${r}/${g}/${b}`);
  const background = [0x0b, 0x0d, 0x10];
  expect(
    Math.max(...[r, g, b].map((v, i) => Math.abs(v - background[i])))
  ).toBeGreaterThan(4);
  expect(errors).toEqual([]);
});

// A change to or from `low` swaps the world and the players for the other tier; the ones it
// replaces are not dressed in the new preset's look on the way out: their textures' decoded
// images were released after upload (images.ts), so a new anisotropy would fetch their GLBs
// again and decode and upload every texture, only for the swap to free them. Each change
// fetches the incoming tier's world and players once, and none of the outgoing ones; it
// counts the images uploaded (WebGL calls given an ImageBitmap or an <img>) on the way.
test('swaps to the phone tier and back without reloading what it replaces', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const counts = { images: 0 };
    (window as unknown as { __uploads: typeof counts }).__uploads = counts;
    const gl = WebGL2RenderingContext.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const name of [
      'texImage2D',
      'texSubImage2D',
      'texImage3D',
      'texSubImage3D',
    ]) {
      const call = gl[name];
      gl[name] = function (this: unknown, ...args: unknown[]) {
        if (
          args.some(
            (a) => a instanceof ImageBitmap || a instanceof HTMLImageElement
          )
        )
          counts.images++;
        return call.apply(this, args);
      };
    }
  });
  const glbs: string[] = [];
  let inFlight = 0;
  let lastGlb = Date.now();
  const isGlb = (url: string) => /\.glb$/.test(new URL(url).pathname);
  page.on('request', (r) => {
    if (!isGlb(r.url())) return;
    glbs.push(new URL(r.url()).pathname);
    inFlight++;
    lastGlb = Date.now();
  });
  const done = (r: { url(): string }) => {
    if (!isGlb(r.url())) return;
    inFlight--;
    lastGlb = Date.now();
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  const uploads = () =>
    page.evaluate(
      () =>
        (window as unknown as { __uploads: { images: number } }).__uploads
          .images
    );
  /** Waits until no GLB has been asked for or answered for 2 s, and no image uploaded for 1 s. */
  const settle = async () => {
    await expect
      .poll(() => inFlight === 0 && Date.now() - lastGlb > 2000, {
        timeout: 60_000,
      })
      .toBe(true);
    let was = -1;
    await expect
      .poll(
        async () => {
          const n = await uploads();
          const still = n === was;
          was = n;
          return still;
        },
        { timeout: 30_000, intervals: [1000] }
      )
      .toBe(true);
  };
  const hud = page.getByTestId('hud-quality');
  const view = page.getByTestId('viewport');
  /** Switches to `q` and returns the GLBs fetched and the images uploaded until all settles. */
  const change = async (q: Quality) => {
    await settle();
    const from = glbs.length;
    const before = await uploads();
    await page.evaluate(
      (q) =>
        (window as unknown as { __demoviewer: Handle }).__demoviewer.store
          .getState()
          .setQuality(q),
      q
    );
    await expect(hud).toHaveAttribute('data-quality', q);
    await expect(view).toHaveAttribute('data-ready', 'true', {
      timeout: 90_000,
    });
    await settle();
    return {
      glbs: glbs.slice(from).sort(),
      images: (await uploads()) - before,
      textures: (await read(page)).textures,
    };
  };

  const tick = await startTick(request);
  await open(page, tick, 'medium');
  const map = await page.evaluate(
    () =>
      (
        window as unknown as {
          __demoviewer: { store: { getState(): { map: string } } };
        }
      ).__demoviewer.store.getState().map
  );
  const lo = await change('low');
  const full = await change('medium');
  console.log(
    `to low: ${lo.images} images uploaded, ${lo.textures} textures, GLBs ${lo.glbs.join(' ')}; ` +
      `to medium: ${full.images} images uploaded, ${full.textures} textures, GLBs ${full.glbs.join(' ')}`
  );
  test.info().annotations.push({
    type: 'swap',
    description: `to low ${lo.images} images, ${lo.glbs.length} GLBs; to medium ${full.images} images, ${full.glbs.length} GLBs`,
  });
  const world = `/maps/${map}/world.glb`;
  const worldLo = `/maps/${map}/world_lo.glb`;
  const players = ['/players/ct.glb', '/players/t.glb'];
  const playersLo = ['/players/ct_lo.glb', '/players/t_lo.glb'];
  // The incoming tier once each; nothing of the outgoing one.
  expect(lo.glbs.filter((u) => u === worldLo)).toEqual([worldLo]);
  expect(lo.glbs.filter((u) => playersLo.includes(u))).toEqual(playersLo);
  expect(lo.glbs).not.toContain(world);
  for (const p of players) expect(lo.glbs).not.toContain(p);
  expect(full.glbs.filter((u) => u === world)).toEqual([world]);
  expect(full.glbs.filter((u) => players.includes(u))).toEqual(players);
  expect(full.glbs).not.toContain(worldLo);
  for (const p of playersLo) expect(full.glbs).not.toContain(p);
  expect(errors).toEqual([]);
});

// A desktop that draws `medium` under 40 fps is measured to `low` after its world and players
// loaded (at `medium`, to measure them). The phone tier is for a phone's memory: a measured
// `low` keeps the files it measured with and only changes their look, where it once downloaded
// the world and the players a second time as their phone tier. Each is asked for at most twice:
// the new look's anisotropy reads their GLBs again to upload their textures again (images.ts),
// from the HTTP cache where it holds them (Chromium's in-memory cache, a Playwright context's,
// does not keep Mirage's 10.3 MB world.glb). The probe's GPU wait (`readPixels`) is slowed to
// 30 ms a draw here, which measures about 33 fps.
test('keeps the loaded world and players when the first second measures low', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(100_000);
    const gl = WebGL2RenderingContext.prototype;
    const read = gl.readPixels as (...args: unknown[]) => void;
    (gl as unknown as { readPixels: typeof read }).readPixels = function (
      this: WebGL2RenderingContext,
      ...args: unknown[]
    ) {
      const until = performance.now() + 30;
      while (performance.now() < until);
      read.apply(this, args);
    };
  });
  const glbs: string[] = [];
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (/\/(world[^/]*|ct[^/]*|t[^/]*)\.glb$/.test(path)) glbs.push(path);
  });
  await open(page, await startTick(request), null);
  await expect
    .poll(async () => (await read(page)).from, { timeout: 10_000 })
    .toBe('detected');
  const r = await read(page);
  console.log(`measured ${r.probe.toFixed(1)} fps at medium → ${r.quality}`);
  expect(r.quality).toBe('low');
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  await page.waitForTimeout(3000);
  const map = await page.evaluate(
    () =>
      (
        window as unknown as {
          __demoviewer: { store: { getState(): { map: string } } };
        }
      ).__demoviewer.store.getState().map
  );
  // Downloaded: a resource the HTTP cache answered transfers nothing.
  const downloaded = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => ({
        path: new URL(e.name).pathname,
        bytes: (e as PerformanceResourceTiming).transferSize,
      }))
      .filter((e) => e.bytes > 0)
      .map((e) => e.path)
  );
  console.log(
    `world and player GLBs asked for: ${glbs.join(' ')}; downloaded: ` +
      downloaded.filter((p) => glbs.includes(p)).join(' ')
  );
  expect(glbs).not.toContain(`/maps/${map}/world_lo.glb`);
  expect(glbs).not.toContain('/players/ct_lo.glb');
  expect(glbs).not.toContain('/players/t_lo.glb');
  for (const p of [
    `/maps/${map}/world.glb`,
    '/players/ct.glb',
    '/players/t.glb',
  ])
    expect(glbs.filter((u) => u === p).length).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});
