import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { eyePoint } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { FLAG, type Pack } from '../src/pack/types';
import { DEATH_VIEW_S, deathView } from '../src/sim/deathview';
import { directorPlan } from '../src/sim/director';
import {
  newPlayerState,
  playerStateAt,
  type PlayerState,
} from '../src/sim/sample';
import { settled, trackLoads } from './wait';
import { trackErrors } from './errors';

// POV, the default camera, on the Mirage demo in the real page at 2560×1440:
// - A match opened with no camera in its link is in POV on player 1, unpinned, with the
//   director off (e2e/out/pov-default.jpg); paused at moments through round 1 where player 1
//   lives, the camera is at their eye, looking where they look.
// - Round 1 played at 8× is POV on every frame (its frame rate is logged).
// - The death view: round 1's first victim, followed unpinned, played at 1× through their
//   death: the camera holds still where their eye was at their last live sample, looking where
//   they looked, for `DEATH_VIEW_S`, then cuts to someone else (pov-death-view.jpg). Pinned,
//   the death view holds to the round's end, and the next round is POV on the same player.
// - The director (`A`) keeps POV. At its first cut away from a dead pick, it shows that pick's
//   death view just before the cut and the next pick's eyes just after (pov-auto-before.jpg,
//   pov-auto-next.jpg); round 1 at 8× with it on changes who is shown at least once.
// - An old link with `cam=follow` opens in POV, pinned on its player.
//
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the
// assets, and the id of an uploaded Mirage demo in DEMOVIEWER_E2E_DEMO.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;
const OUT = new URL('./out/', import.meta.url);
const shot = (name: string) => fileURLToPath(new URL(`${name}.jpg`, OUT));

/** The camera at the eye: metres and degrees. */
const AT_EYE_M = 0.01;
const AT_VIEW_DEG = 0.1;

type Camera = ReturnType<NonNullable<Window['__demoviewer']>['camera']>;

/** One drawn frame, read in the page. */
interface Frame {
  round: number;
  tick: number;
  follow: number | null;
  cam: Camera;
}

/** Signed shortest turn from `a` to `b` in degrees. */
const turn = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** How far `cam` is from the eye and view of `s`: metres, and the larger angle in degrees. */
function offEye(cam: Camera, s: PlayerState): { m: number; deg: number } {
  const e = eyePoint(s, { x: 0, y: 0, z: 0 });
  return {
    m: Math.hypot(cam.x - e.x, cam.y - e.y, cam.z - e.z),
    deg: Math.max(
      Math.abs(turn(s.yaw, cam.yaw)),
      Math.abs(s.pitch - cam.pitch)
    ),
  };
}

function stateAt(pack: Pack, round: number, player: number, tick: number) {
  return playerStateAt(
    pack.rounds[round].players[player],
    pack.header.rounds[round],
    tick,
    pack.header,
    newPlayerState()
  );
}

/** Pauses at `tick` of `round` and reads the camera drawn for it. */
function seekTo(page: Page, round: number, tick: number): Promise<Frame> {
  return page.evaluate(
    async ({ round, tick }) => {
      const d = window.__demoviewer!;
      const s = d.store.getState();
      s.pause();
      if (s.round !== round) s.seekRound(round);
      d.store.getState().seekTick(tick);
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => r(null)));
      // The store change draws on the next frame; read after it.
      await frame();
      await frame();
      const now = d.store.getState();
      return {
        round: now.round,
        tick: now.tick,
        follow: now.follow,
        cam: d.camera(),
      };
    },
    { round, tick }
  );
}

/**
 * Plays from where the store is at `speed` and records every drawn frame until the clock
 * reaches `until` or leaves round `round`; the cap (wall ms) guards against a clock that
 * never gets there. Pauses at the end.
 */
function record(
  page: Page,
  round: number,
  until: number,
  speed: number,
  capMs: number
): Promise<Frame[]> {
  return page.evaluate(
    ({ round, until, speed, capMs }) =>
      new Promise<Frame[]>((resolve) => {
        const d = window.__demoviewer!;
        const out: Frame[] = [];
        const t0 = performance.now();
        d.store.getState().setSpeed(speed);
        d.store.getState().play();
        const step = () => {
          const s = d.store.getState();
          if (
            s.round !== round ||
            s.tick >= until ||
            performance.now() - t0 > capMs
          ) {
            s.pause();
            resolve(out);
            return;
          }
          out.push({
            round: s.round,
            tick: s.tick,
            follow: s.follow,
            cam: d.camera(),
          });
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    { round, until, speed, capMs }
  );
}

const fpsNow = (page: Page) =>
  page.evaluate(() => window.__demoviewer!.stats.fps);

async function open(page: Page, query: string): Promise<void> {
  await trackLoads(page);
  await page.goto(`/d/${demoId}?${query}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  // The first second after ready measures the scene and picks the preset: let it finish.
  await page.waitForFunction(
    () => window.__demoviewer!.store.getState().qualityFrom !== 'default',
    undefined,
    { timeout: 30_000 }
  );
}

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

test('opens in POV, holds a death view, and the director picks in POV', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  const res = await request.get(`/api/demos/${demoId}/pack`);
  expect(res.ok()).toBe(true);
  const pack = parsePack(await inflateIfGzip(new Uint8Array(await res.body())));
  const { header } = pack;
  const rate = header.tick_rate;
  const step = header.tick_step;
  const info = header.rounds[0];
  const errors = trackErrors(page);
  mkdirSync(fileURLToPath(OUT), { recursive: true });

  // A fresh match: POV on player 1, unpinned, the director off.
  await open(page, 'r=1');
  const opened = await page.evaluate(() => {
    const d = window.__demoviewer!;
    const s = d.store.getState();
    return {
      camera: s.camera,
      follow: s.follow,
      followPinned: s.followPinned,
      director: s.director,
      mode: d.camera().mode,
    };
  });
  expect(opened).toEqual({
    camera: 'pov',
    follow: 0,
    followPinned: false,
    director: false,
    mode: 'pov',
  });
  await settled(page);
  await page.screenshot({
    path: shot('pov-default'),
    type: 'jpeg',
    quality: 85,
  });

  // At player 1's eye, looking where they look, wherever they live in round 1.
  const alive = (round: number, p: number, tick: number) =>
    stateAt(pack, round, p, tick).present;
  let checked = 0;
  let worst = { m: 0, deg: 0 };
  for (
    let t = info.freeze_end_tick;
    t < info.end_tick && checked < 12;
    t += 5 * rate
  ) {
    if (!alive(0, 0, t)) continue;
    const f = await seekTo(page, 0, t);
    expect(f.cam.mode).toBe('pov');
    expect(f.cam.shown).toBe(0);
    const off = offEye(f.cam, stateAt(pack, 0, 0, f.tick));
    worst = { m: Math.max(worst.m, off.m), deg: Math.max(worst.deg, off.deg) };
    checked++;
  }
  console.log(
    `pov: ${checked} moments of player 1, at most ${worst.m.toFixed(4)} m and ` +
      `${worst.deg.toFixed(3)}° off their eye and view`
  );
  expect(checked).toBeGreaterThan(3);
  expect(worst.m).toBeLessThan(AT_EYE_M);
  expect(worst.deg).toBeLessThan(AT_VIEW_DEG);

  // Round 1 at 8×: POV on every frame.
  await seekTo(page, 0, info.freeze_end_tick);
  const fast = record(page, 0, info.end_tick, 8, 120_000);
  // The frame rate a quarter of the way into the round at 8×, once its window holds 8× play.
  await expect
    .poll(
      () => page.evaluate(() => window.__demoviewer!.store.getState().tick),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(
      info.freeze_end_tick + (info.end_tick - info.freeze_end_tick) / 4
    );
  const fps8 = await fpsNow(page);
  const played = await fast;
  console.log(
    `pov, round 1 at 8x: ${played.length} frames, ${fps8.toFixed(1)} fps at 2560x1440`
  );
  test.info().annotations.push({ type: 'fps', description: fps8.toFixed(1) });
  expect(played.length).toBeGreaterThan(100);
  expect(played.every((f) => f.cam.mode === 'pov')).toBe(true);
  expect(played[played.length - 1].tick).toBeGreaterThan(
    info.end_tick - 2 * 0.1 * 8 * rate
  );

  // The death view: round 1's first death, its victim followed unpinned, at 1×.
  const death = pack.events.find(
    (e) =>
      e.kind === 'player_death' &&
      e.tick > info.freeze_end_tick &&
      e.tick <= info.end_tick &&
      typeof e.data.user_idx === 'number'
  )!;
  expect(death).toBeDefined();
  const victim = death.data.user_idx as number;
  const flags = pack.rounds[0].players[victim].flags;
  const kd = Array.from(flags).findIndex(
    (v, k) =>
      k > 0 && (flags[k - 1] & FLAG.alive) !== 0 && (v & FLAG.alive) === 0
  );
  expect(kd).toBeGreaterThan(0);
  const dead = info.start_tick + kd * step;
  const cut = dead + DEATH_VIEW_S * rate;
  const view = deathView(
    pack.rounds[0].players[victim],
    info,
    dead,
    header,
    newPlayerState()
  )!;
  expect(view).not.toBeNull();
  await page.evaluate((v) => {
    window.__demoviewer!.store.getState().setFollow(v, false);
  }, victim);
  await seekTo(page, 0, death.tick - 3 * rate);
  const frames = await record(page, 0, cut + rate, 1, 30_000);
  const margin = 0.1 * rate;
  const before = frames.filter((f) => f.tick <= death.tick - 0.5 * rate);
  const held = frames.filter(
    (f) => f.tick >= dead + margin && f.tick <= cut - margin
  );
  const after = frames.filter((f) => f.tick >= cut + margin);
  const firstAway = frames.find((f) => f.cam.shown !== victim);
  console.log(
    `death view: ${header.players[victim].name} (player ${victim + 1}) dies at tick ` +
      `${death.tick}, first dead sample ${dead}; ${held.length} frames held, ` +
      `cut to player ${firstAway ? firstAway.cam.shown! + 1 : '-'} at tick ` +
      `${firstAway?.tick.toFixed(1)} (${(((firstAway?.tick ?? NaN) - dead) / rate).toFixed(2)} s after)`
  );
  expect(frames.every((f) => f.cam.mode === 'pov')).toBe(true);
  expect(before.length).toBeGreaterThan(10);
  expect(before.every((f) => f.cam.shown === victim)).toBe(true);
  expect(held.length).toBeGreaterThan(30);
  for (const f of held) {
    expect(f.cam.shown).toBe(victim);
    const off = offEye(f.cam, view);
    expect(off.m).toBeLessThan(AT_EYE_M);
    expect(off.deg).toBeLessThan(AT_VIEW_DEG);
  }
  expect(after.length).toBeGreaterThan(10);
  expect(after.every((f) => f.cam.shown !== victim)).toBe(true);
  // Whoever it cut to is alive, and it looks through their eyes.
  const last = after[after.length - 1];
  expect(alive(0, last.cam.shown!, last.tick)).toBe(true);

  // Pinned, the death view holds to the round's end; the next round is POV on them again.
  await page.evaluate((v) => {
    window.__demoviewer!.store.getState().setFollow(v);
  }, victim);
  const shown = await seekTo(page, 0, death.tick + rate);
  await page.screenshot({
    path: shot('pov-death-view'),
    type: 'jpeg',
    quality: 85,
  });
  for (const f of [
    shown,
    await seekTo(page, 0, cut + rate),
    await seekTo(page, 0, info.end_tick),
  ]) {
    expect(f.cam.shown).toBe(victim);
    expect(offEye(f.cam, view).m).toBeLessThan(AT_EYE_M);
  }
  // The first sample of round 2 from its freeze end where they are alive.
  const info2 = header.rounds[1];
  let liveTick = -1;
  for (
    let t = info2.freeze_end_tick;
    t <= info2.end_tick && liveTick < 0;
    t += step
  )
    if (alive(1, victim, t)) liveTick = t;
  expect(liveTick, `player ${victim + 1} alive in round 2`).toBeGreaterThan(0);
  const next = await seekTo(page, 1, liveTick);
  expect(next.follow).toBe(victim);
  expect(next.cam.shown).toBe(victim);
  expect(offEye(next.cam, stateAt(pack, 1, victim, next.tick)).m).toBeLessThan(
    AT_EYE_M
  );

  // The director keeps POV, and after a pick's death view moves to a living player.
  await page.keyboard.press('KeyA');
  const directed = await page.evaluate(() => {
    const s = window.__demoviewer!.store.getState();
    return { director: s.director, camera: s.camera };
  });
  expect(directed).toEqual({ director: true, camera: 'pov' });
  let away: { round: number; tick: number; from: number; to: number } | null =
    null;
  for (let r = 0; r < header.rounds.length && !away; r++) {
    const cuts = directorPlan(pack, r);
    const i = cuts.findIndex((c, j) => j > 0 && c.reason === 'death');
    if (i > 0)
      away = {
        round: r,
        tick: cuts[i].tick,
        from: cuts[i - 1].follow,
        to: cuts[i].follow,
      };
  }
  expect(away).not.toBeNull();
  const a = away!;
  const holding = await seekTo(page, a.round, a.tick - 0.5 * rate);
  await page.screenshot({
    path: shot('pov-auto-before'),
    type: 'jpeg',
    quality: 85,
  });
  const fromView = deathView(
    pack.rounds[a.round].players[a.from],
    header.rounds[a.round],
    holding.tick,
    header,
    newPlayerState()
  );
  expect(holding.follow).toBe(a.from);
  expect(holding.cam.shown).toBe(a.from);
  expect(fromView).not.toBeNull();
  expect(offEye(holding.cam, fromView!).m).toBeLessThan(AT_EYE_M);
  const moved = await seekTo(page, a.round, a.tick + 0.5 * rate);
  await page.screenshot({
    path: shot('pov-auto-next'),
    type: 'jpeg',
    quality: 85,
  });
  console.log(
    `director: round ${a.round + 1}, player ${a.from + 1}'s death view, then player ` +
      `${a.to + 1} at tick ${a.tick}`
  );
  expect(moved.follow).toBe(a.to);
  expect(moved.cam.shown).toBe(a.to);
  expect(alive(a.round, a.to, moved.tick)).toBe(true);
  expect(
    offEye(moved.cam, stateAt(pack, a.round, a.to, moved.tick)).m
  ).toBeLessThan(AT_EYE_M);

  // Round 1 at 8× with the director: POV throughout, and it changes who is shown.
  await seekTo(page, 0, info.freeze_end_tick);
  const auto = await record(page, 0, info.end_tick, 8, 120_000);
  const changes = (k: (f: Frame) => number | null) =>
    auto.filter((f, i) => i > 0 && k(f) !== k(auto[i - 1])).length;
  console.log(
    `director, round 1 at 8x: ${auto.length} frames, ${changes((f) => f.follow)} follow ` +
      `changes, ${changes((f) => f.cam.shown)} changes of the player shown`
  );
  expect(auto.every((f) => f.cam.mode === 'pov')).toBe(true);
  expect(changes((f) => f.follow)).toBeGreaterThanOrEqual(1);
  expect(changes((f) => f.cam.shown)).toBeGreaterThanOrEqual(1);

  // An old link's Follow camera opens in POV, pinned on its player.
  await open(page, 'r=1&cam=follow&p=2');
  expect(
    await page.evaluate(() => {
      const d = window.__demoviewer!;
      const s = d.store.getState();
      return {
        camera: s.camera,
        follow: s.follow,
        followPinned: s.followPinned,
        mode: d.camera().mode,
      };
    })
  ).toEqual({ camera: 'pov', follow: 1, followPinned: true, mode: 'pov' });
  expect(errors).toEqual([]);
});
