import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { highlightRows } from '../src/components/hud/models';
import { eyePoint } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import type { Pack } from '../src/pack/types';
import { highlightsOf } from '../src/sim/highlights';
import { newPlayerState, playerStateAt } from '../src/sim/sample';
import { roundSummary } from '../src/sim/summary';
import { timelineFor, type Kill } from '../src/sim/timeline';
import { SETTINGS_KEY } from '../src/state/settings';
import { QUALITY_KEY } from '../src/state/store';
import { frames, settled, trackLoads } from './wait';
import { trackErrors } from './errors';

// The spectator tools of milestone 4 on the Mirage demo, round 1, at 2560×1440:
// - X-ray: a moment the pack puts players ahead of player 1 and far off, where the map's hull
//   hides one of them from player 1's eyes (POV); with `X` on, at least twice as many pixels are
//   within ±12 of a team colour as with it off (at `medium`, whose outlines are not
//   tone-mapped), with the names over heads off: their health bars are in the team colours.
// - Highlights: `H` lists them; the first row plays it in POV on its player under the reel's
//   banner, and Escape goes back to the round and tick from before.
// - Kill cam: 2 s after player 1's first death, `K` replays it from the killer's eyes and then
//   comes back to that tick.
// - Share: in POV on player 3, paused, Share copies a link that opens at the same round, tick
//   (rounded), camera and player.
// - Round summary: at round 1's end + 1 s, the panel names the winner and the MVP.
// - Outlines' cost: the frame rate playing with `X` on and off at `high` (printed; on ≥ 60 fps).
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) and DEMOVIEWER_E2E_DEMO, as viewer.spec.ts
// does.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const out = (name: string) =>
  fileURLToPath(new URL(`./out/${name}`, import.meta.url));

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

let packOnce: Promise<Pack> | null = null;
/** The demo's pack, read through the API once per worker. */
function loadPack(request: APIRequestContext): Promise<Pack> {
  packOnce ??= (async () => {
    const res = await request.get(`/api/demos/${demoId}/pack`);
    expect(res.ok()).toBe(true);
    return parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  })();
  return packOnce;
}

/** Opens `query` on the demo and waits for the 3D view; collects page errors. */
async function open(page: Page, query: string): Promise<string[]> {
  const errors = trackErrors(page);
  await trackLoads(page);
  await page.goto(`/d/${demoId}?${query}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  return errors;
}

interface Moment {
  round: number;
  tick: number;
  playing: boolean;
  camera: string;
  follow: number | null;
  reel: { kind: string; follow: number; camera: string; round: number } | null;
}

/** The store's position, camera and reel. */
const moment = (page: Page): Promise<Moment> =>
  page.evaluate(() => {
    const s = window.__demoviewer!.store.getState();
    const seg = s.reel?.segments[s.reel.index];
    return {
      round: s.round,
      tick: s.tick,
      playing: s.playing,
      camera: s.camera,
      follow: s.follow,
      reel:
        s.reel && seg
          ? {
              kind: s.reel.kind,
              follow: seg.follow,
              camera: s.camera,
              round: seg.round,
            }
          : null,
    };
  });

/**
 * The camera drawn last against `player`'s eye at the store's tick, from the pack: its mode
 * and the metres between them.
 */
async function eyeGap(
  page: Page,
  pack: Pack,
  player: number
): Promise<{ mode: string; gap: number }> {
  const { round, tick, cam } = await page.evaluate(() => {
    const d = window.__demoviewer!;
    const s = d.store.getState();
    return { round: s.round, tick: s.tick, cam: d.camera() };
  });
  const state = playerStateAt(
    pack.rounds[round].players[player],
    pack.header.rounds[round],
    tick,
    pack.header,
    newPlayerState()
  );
  const eye = eyePoint(state, { x: 0, y: 0, z: 0 });
  return {
    mode: cam.mode,
    gap: Math.hypot(cam.x - eye.x, cam.y - eye.y, cam.z - eye.z),
  };
}

/**
 * Ticks of round `r`, a second apart from 3 s after its freeze, where `me` is alive and the
 * most of their living enemies are ahead of them (within 40° of their yaw) and 10–60 m off,
 * most first: where POV on `me` likely looks at enemies behind walls.
 */
function xrayTicks(pack: Pack, r: number, me: number): number[] {
  const { header } = pack;
  const info = header.rounds[r];
  const tracks = pack.rounds[r].players;
  const team = (i: number) => header.players[i].team_by_round[r];
  const scored: { tick: number; n: number }[] = [];
  for (
    let tick = info.freeze_end_tick + 3 * header.tick_rate;
    tick < info.end_tick - header.tick_rate;
    tick += header.tick_rate
  ) {
    const at = (i: number) =>
      playerStateAt(tracks[i], info, tick, header, newPlayerState());
    const self = at(me);
    if (!self.present) continue;
    let n = 0;
    for (let i = 0; i < tracks.length; i++) {
      if (i === me || team(i) === team(me)) continue;
      const p = at(i);
      if (!p.present) continue;
      const metres = Math.hypot(p.x - self.x, p.y - self.y) * 0.0254;
      const bearing = (Math.atan2(p.y - self.y, p.x - self.x) * 180) / Math.PI;
      const off = Math.abs(((bearing - self.yaw + 540) % 360) - 180);
      if (off <= 40 && metres >= 10 && metres <= 60) n++;
    }
    if (n > 0) scored.push({ tick, n });
  }
  return scored.sort((a, b) => b.n - a.n || a.tick - b.tick).map((s) => s.tick);
}

/**
 * The players on screen whose chest the map's hull hides from the camera drawn last: each
 * living rig's chest projected into the canvas, and a sphere traced from the camera towards it
 * by the hull's distance (`hullDistance`), which hits a wall before it gets there. Null until
 * the hull is in.
 */
const behindWalls = (page: Page) =>
  page.evaluate(() => {
    const d = window.__demoviewer!;
    const cam = d.camera();
    if (d.hullDistance(cam.x, cam.y, cam.z) === null) return null;
    const canvas = document.querySelector<HTMLCanvasElement>(
      '[data-testid="viewport"] canvas'
    )!;
    const { width: W, height: H } = canvas.getBoundingClientRect();
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
    const hidden: number[] = [];
    const n = d.store.getState().pack!.header.players.length;
    for (let i = 0; i < n; i++) {
      const rig = d.rig(i);
      if (!rig) continue;
      const chest = [rig.x, rig.y + 1.1, rig.z];
      const v = [chest[0] - cam.x, chest[1] - cam.y, chest[2] - cam.z];
      const z = dot(v, fwd);
      if (z <= 0) continue;
      const sx = (dot(v, right) / (z * t * (W / H)) + 1) / 2;
      const sy = (1 - dot(v, up) / (z * t)) / 2;
      if (sx < 0.05 || sx > 0.95 || sy < 0.05 || sy > 0.95) continue;
      // Sphere tracing: the hull is at least `gap` away, so the next `gap` metres are clear.
      const len = Math.hypot(v[0], v[1], v[2]);
      let along = 0;
      for (let k = 0; k < 5000 && along < len - 0.5; k++) {
        const f = along / len;
        const gap = d.hullDistance(
          cam.x + v[0] * f,
          cam.y + v[1] * f,
          cam.z + v[2] * f
        )!;
        if (gap < 0.02) {
          hidden.push(i);
          break;
        }
        along += gap;
      }
    }
    return hidden;
  });

/** Pixels of a PNG within ±12 of T's `#f2a33a` or CT's `#4da3ff` on each channel. */
const teamPixels = (page: Page, png: Buffer) =>
  page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const img = await createImageBitmap(
      new Blob([bytes], { type: 'image/png' })
    );
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const near = (o: number, r: number, gg: number, b: number) =>
      Math.abs(data[o] - r) <= 12 &&
      Math.abs(data[o + 1] - gg) <= 12 &&
      Math.abs(data[o + 2] - b) <= 12;
    let n = 0;
    for (let o = 0; o < data.length; o += 4)
      if (near(o, 0xf2, 0xa3, 0x3a) || near(o, 0x4d, 0xa3, 0xff)) n++;
    return n;
  }, png.toString('base64'));

test('X shows the players behind walls in their team colours', async ({
  page,
  request,
}) => {
  const pack = await loadPack(request);
  const ticks = xrayTicks(pack, 0, 0).slice(0, 8);
  expect(ticks.length).toBeGreaterThan(0);
  // The names over heads off: their health bars' fills would count as team colours, through
  // walls with X on and behind them with it off.
  await page.addInitScript(
    ([quality, settings]) => {
      localStorage.setItem(quality, 'medium');
      localStorage.setItem(settings, JSON.stringify({ nameTags: false }));
    },
    [QUALITY_KEY, SETTINGS_KEY]
  );
  // The 3D view alone: the HUD's team colours are the same either way.
  const errors = await open(page, `r=1&t=${ticks[0]}&cam=pov&p=1&hud=0`);
  await expect.poll(() => behindWalls(page)).not.toBeNull();

  let found: { tick: number; hidden: number[] } | null = null;
  for (const tick of ticks) {
    const since = await frames(page);
    await page.evaluate(
      (t) => window.__demoviewer!.store.getState().seekTick(t),
      tick
    );
    await settled(page, { since });
    const hidden = (await behindWalls(page)) ?? [];
    if (hidden.length > 0) {
      found = { tick, hidden };
      break;
    }
  }
  expect(found, 'a moment with a player behind a wall').not.toBeNull();

  mkdirSync(out(''), { recursive: true });
  const xray = () =>
    page.evaluate(
      () =>
        (
          JSON.parse(localStorage.getItem('demoviewer.settings') ?? '{}') as {
            xray?: boolean;
          }
        ).xray ?? true
    );
  expect(await xray()).toBe(true);
  const on = await teamPixels(page, await page.screenshot({ type: 'png' }));
  await page.screenshot({
    path: out('xray-on.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  const since = await frames(page);
  await page.keyboard.press('KeyX');
  expect(await xray()).toBe(false);
  await settled(page, { since });
  const off = await teamPixels(page, await page.screenshot({ type: 'png' }));
  await page.screenshot({
    path: out('xray-off.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  console.log(
    `x-ray: tick ${found!.tick}, players ${found!.hidden.map((i) => i + 1).join(', ')} ` +
      `behind walls; team-colour pixels ${on} with X on, ${off} off`
  );
  expect(on).toBeGreaterThan(500);
  expect(on).toBeGreaterThanOrEqual(2 * off);
  expect(errors).toEqual([]);
});

test('H lists the highlights; a row plays one in POV and Escape comes back', async ({
  page,
  request,
}) => {
  const pack = await loadPack(request);
  const start =
    pack.header.rounds[0].freeze_end_tick + 10 * pack.header.tick_rate;
  const errors = await open(page, `r=1&t=${start}`);
  const before = await moment(page);

  await page.keyboard.press('KeyH');
  const panel = page.getByRole('dialog', { name: 'Highlights' });
  await expect(panel).toBeVisible();
  const rows = panel.getByRole('listitem').getByRole('button');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);

  // The panel's first row, from the pack.
  const first = highlightRows(pack, false)[0].rows[0];
  const h = highlightsOf(pack)[first.index];
  await expect(rows.first()).toContainText(first.player.name);
  await rows.first().click();
  await expect(panel).toHaveCount(0);
  const playing = await moment(page);
  expect(playing.reel).toEqual({
    kind: 'highlights',
    follow: h.player,
    camera: 'pov',
    round: h.round,
  });
  const banner = page.getByRole('group', { name: 'Highlights' });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(first.player.name);
  await expect
    .poll(async () => (await eyeGap(page, pack, h.player)).mode)
    .toBe('pov');
  const pov = await eyeGap(page, pack, h.player);
  console.log(
    `highlights: ${first.player.name} · ${first.label}, POV ${pov.gap.toFixed(3)} m from their eye`
  );
  expect(pov.gap).toBeLessThan(0.25);

  await page.keyboard.press('Escape');
  await expect(banner).toHaveCount(0);
  const after = await moment(page);
  expect(after.reel).toBeNull();
  expect(after.round).toBe(before.round);
  expect(Math.abs(after.tick - before.tick)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('K replays player 1’s death from the killer’s eyes, then comes back', async ({
  page,
  request,
}) => {
  const pack = await loadPack(request);
  const { header } = pack;
  const timeline = timelineFor(pack);
  // Player 1's first death, from the pack.
  let round = -1;
  let death: Kill | null = null;
  for (let r = 0; r < header.rounds.length && !death; r++) {
    death = timeline.kills(r).find((k) => k.victim === 0) ?? null;
    round = r;
  }
  expect(death).not.toBeNull();
  const attacker = death!.attacker!;
  expect(attacker).not.toBeNull();
  expect(attacker).not.toBe(0);
  // The killer lives through the kill, so the kill cam is from their eyes.
  expect(
    timeline
      .kills(round)
      .some((k) => k.victim === attacker && k.tick <= death!.tick)
  ).toBe(false);
  const info = header.rounds[round];
  const at = Math.min(
    death!.tick + 2 * header.tick_rate,
    info.post_end_tick ?? info.end_tick
  );

  const errors = await open(page, `r=${round + 1}&t=${at}&cam=pov&p=1`);
  const before = await moment(page);
  expect(before).toMatchObject({ round, tick: at, follow: 0, reel: null });

  await page.keyboard.press('KeyK');
  const playing = await moment(page);
  expect(playing.reel).toEqual({
    kind: 'killcam',
    follow: attacker,
    camera: 'pov',
    round,
  });
  await expect(page.getByRole('group', { name: 'Kill cam' })).toBeVisible();
  await expect
    .poll(async () => (await eyeGap(page, pack, attacker)).mode)
    .toBe('pov');
  const pov = await eyeGap(page, pack, attacker);
  console.log(
    `kill cam: ${header.players[attacker].name} killed ${header.players[0].name} at tick ` +
      `${death!.tick}; POV ${pov.gap.toFixed(3)} m from the killer's eye`
  );
  expect(pov.gap).toBeLessThan(0.25);

  // 5 s before the death to 1 s after, at 1×.
  await expect
    .poll(async () => (await moment(page)).reel, { timeout: 20_000 })
    .toBeNull();
  const after = await moment(page);
  expect(after).toMatchObject({
    round,
    camera: 'pov',
    follow: 0,
    playing: false,
  });
  expect(Math.abs(after.tick - at)).toBeLessThanOrEqual(1);
  expect(errors).toEqual([]);
});

test('Share copies a link that opens at the same moment', async ({
  page,
  context,
  request,
}) => {
  const pack = await loadPack(request);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const start =
    pack.header.rounds[0].freeze_end_tick + 20 * pack.header.tick_rate;
  const errors = await open(page, `r=1&t=${start}`);

  // POV on player 3, played a little (a quarter second of the match) and paused, so the tick
  // is between samples.
  await page.keyboard.press('Digit3');
  await page.keyboard.press('KeyV');
  await page.keyboard.press('Space');
  await expect
    .poll(async () => (await moment(page)).tick)
    .toBeGreaterThan(start + pack.header.tick_rate / 4);
  await page.keyboard.press('Space');
  const here = await moment(page);
  expect(here).toMatchObject({
    round: 0,
    camera: 'pov',
    follow: 2,
    playing: false,
  });

  await page.getByTitle('Share a link to this moment').click();
  await expect(
    page.getByTitle('Share a link to this moment').getByText('Copied')
  ).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  console.log(`share: tick ${here.tick.toFixed(2)} → ${link}`);
  expect(new URL(link).pathname).toBe(`/d/${demoId}`);

  const other = await context.newPage();
  const otherErrors = trackErrors(other);
  await other.goto(link);
  await expect(other.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  const there = await moment(other);
  expect(there).toMatchObject({
    round: here.round,
    tick: Math.round(here.tick),
    camera: 'pov',
    follow: 2,
  });
  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});

test('the round summary names the winner and the MVP', async ({
  page,
  request,
}) => {
  const pack = await loadPack(request);
  const info = pack.header.rounds[0];
  const summary = roundSummary(pack, 0);
  expect(summary.winner).not.toBe(0);
  expect(summary.mvp).not.toBeNull();
  const mvp = pack.header.players[summary.mvp!.index].name;
  const errors = await open(
    page,
    `r=1&t=${info.end_tick + pack.header.tick_rate}`
  );

  const panel = page.getByTestId('round-summary');
  await expect(panel).toBeVisible();
  // Exact: 'T win' is inside 'CT win' too.
  await expect(
    panel.getByText(`${summary.winner === 2 ? 'T' : 'CT'} win`, { exact: true })
  ).toBeVisible();
  await expect(panel.locator('p', { hasText: 'MVP' })).toContainText(mvp);
  mkdirSync(out(''), { recursive: true });
  await page.screenshot({
    path: out('round-summary.jpg'),
    type: 'jpeg',
    quality: 85,
  });
  console.log(
    `round summary: ${summary.winner === 2 ? 'T' : 'CT'} win (${summary.reason}), MVP ${mvp} (${summary.mvp!.why})`
  );
  expect(errors).toEqual([]);
});

test('the outlines’ frame rate, with X on and off', async ({
  page,
  request,
}) => {
  const pack = await loadPack(request);
  const start =
    pack.header.rounds[0].freeze_end_tick + 5 * pack.header.tick_rate;
  await page.addInitScript(() =>
    localStorage.setItem('demoviewer.quality', 'high')
  );
  const errors = await open(page, `r=1&t=${start}&cam=pov&p=1`);

  /** Plays 5 s from `start` after a second's warm-up: the mean of the scene's fps. */
  const run = async () => {
    await page.evaluate((t) => {
      const s = window.__demoviewer!.store.getState();
      s.seekTick(t);
      s.play();
    }, start);
    // Measurements, so spans of wall time: a second fills the fps window with playing frames,
    // then a sample each 500 ms window (`stats.fps`).
    await page.waitForTimeout(1000);
    const fps: number[] = [];
    for (let k = 0; k < 10; k++) {
      await page.waitForTimeout(500);
      fps.push(await page.evaluate(() => window.__demoviewer!.stats.fps));
    }
    await page.evaluate(() => window.__demoviewer!.store.getState().pause());
    return fps.reduce((a, b) => a + b, 0) / fps.length;
  };
  const on = await run();
  await page.keyboard.press('KeyX');
  const off = await run();
  console.log(
    `outlines: ${on.toFixed(1)} fps with X on, ${off.toFixed(1)} off at high, 2560×1440 ` +
      `(${(1000 / on - 1000 / off).toFixed(2)} ms a frame)`
  );
  test
    .info()
    .annotations.push(
      { type: 'fps X on', description: on.toFixed(1) },
      { type: 'fps X off', description: off.toFixed(1) }
    );
  expect(on).toBeGreaterThanOrEqual(60);
  expect(errors).toEqual([]);
});
