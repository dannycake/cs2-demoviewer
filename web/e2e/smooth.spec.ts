import { expect, test, type Page } from '@playwright/test';
import { trackErrors } from './errors';

// Players move smoothly in the real page. The scenes are found in the demo's own pack: the
// 4 s run with the most turning, the first crouch on the ground and the first duck in the air.
// Each measure is a soft check, so a failing run still logs them all.
//
// - Paused and seeking, the drawn rig of the runner turns no corner at a sample: measured a
//   32nd of a tick either side of each sample over 1.5 s, its velocity changes there by
//   0.1 u/tick (6.4 u/s) at most on average, and its turn rate by 0.1°/tick (along straight
//   lines between samples, about half a unit's second difference a tick, ~0.5 u/tick).
// - In POV, swept a quarter tick at a time through each crouch, the eye's height above the
//   feet moves at most 2.5 units a quarter tick: a whole 18-unit duck spread over its sample
//   is 2.25 (it used to step at each sample, all 18 units at once for a duck in the air).
// - Played at 1× in POV through the run, the locomotion blend moves at most 0.6 of L1 a
//   tick (it stepped up to 2/3 at a sample, and 2 at a weapon switch), and the camera never
//   moves more than 0.3 m about the player in a frame: the eye rides the rig, never jumping
//   off it.
//
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the
// assets, and the id of an uploaded Mirage demo in DEMOVIEWER_E2E_DEMO.
const demoId = process.env.DEMOVIEWER_E2E_DEMO;

const UNIT = 0.0254;

interface Rig {
  x: number;
  y: number;
  z: number;
  yaw: number;
  duck: number;
  speed: number;
  clips: { clip: string; weight: number }[];
}

interface Cam {
  x: number;
  y: number;
  z: number;
  mode: string;
}

interface Track {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  yaw: ArrayLike<number>;
  flags: ArrayLike<number>;
  duck: ArrayLike<number>;
}

interface DebugHandle {
  store: {
    getState(): {
      pack: {
        header: {
          tick_step: number;
          rounds: {
            start_tick: number;
            freeze_end_tick: number;
            samples: number;
          }[];
        };
        rounds: { players: Track[] }[];
      } | null;
      tick: number;
      round: number;
      qualityFrom: string;
      setSpeed(speed: number): void;
      seekRound(r: number): void;
      seekTick(t: number): void;
      setFollow(i: number): void;
      setCamera(mode: string): void;
      play(): void;
      pause(): void;
    };
  };
  camera(): Cam;
  rig(i: number): Rig | null;
}

/** A player at a tick of a round (round and player are indices). */
interface Scene {
  round: number;
  player: number;
  tick: number;
}

/** The scenes, found in the page's pack. */
function findScenes(): { run: Scene; crouch: Scene; airDuck: Scene } | null {
  const d = (window as unknown as { __demoviewer: DebugHandle }).__demoviewer;
  const pack = d.store.getState().pack!;
  const { header } = pack;
  const ALIVE = 1;
  const AIRBORNE = 32;
  const W = 128;
  let run: Scene | null = null;
  let most = 0;
  let crouch: Scene | null = null;
  let airDuck: Scene | null = null;
  header.rounds.forEach((info, r) => {
    const from = Math.ceil((info.freeze_end_tick - info.start_tick) / 2);
    pack.rounds[r].players.forEach((t, p) => {
      const tickOf = (k: number) => info.start_tick + k * header.tick_step;
      const live = (k: number) => (t.flags[k] & ALIVE) !== 0;
      for (let k = from; k + W < info.samples; k += 16) {
        let turn = 0;
        let ok = true;
        for (let j = k + 1; j <= k + W && ok; j++) {
          ok =
            live(j - 1) &&
            live(j) &&
            Math.hypot(t.x[j] - t.x[j - 1], t.y[j] - t.y[j - 1]) >= 5;
          const dy = (t.yaw[j] - t.yaw[j - 1]) / 100;
          turn += Math.abs(dy - 360 * Math.round(dy / 360));
        }
        if (ok && turn > most) {
          most = turn;
          run = { round: r, player: p, tick: tickOf(k) };
        }
      }
      for (let k = from + 1; k + 10 < info.samples; k++) {
        if (!live(k) || !live(k - 1) || t.duck[k - 1] !== 0) continue;
        const air = (t.flags[k] & AIRBORNE) !== 0;
        if (!airDuck && air && t.duck[k] === 255)
          airDuck = { round: r, player: p, tick: tickOf(k) };
        if (!crouch && !air && t.duck[k] > 0 && t.duck[k] < 100)
          crouch = { round: r, player: p, tick: tickOf(k) };
      }
    });
  });
  return run && crouch && airDuck ? { run, crouch, airDuck } : null;
}

/** Paused, `s.player` followed in `camera`, the rig and camera at each tick of `ticks`. */
function sweep(
  page: Page,
  s: Scene,
  camera: string,
  ticks: number[]
): Promise<{ tick: number; rig: Rig | null; cam: Cam }[]> {
  return page.evaluate(
    async ({ s, camera, ticks }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const st = d.store.getState();
      st.pause();
      st.seekRound(s.round);
      st.setFollow(s.player);
      st.setCamera(camera);
      const frame = () =>
        new Promise((r) => requestAnimationFrame(() => r(null)));
      const out = [];
      for (const t of ticks) {
        d.store.getState().seekTick(t);
        // The store change draws on the next frame; read after it.
        await frame();
        await frame();
        out.push({ tick: t, rig: d.rig(s.player), cam: d.camera() });
      }
      return out;
    },
    { s, camera, ticks }
  );
}

/** Ticks from `from` over `count` quarter ticks. */
const quarters = (from: number, count: number) =>
  Array.from({ length: count + 1 }, (_, i) => from + i / 4);

const turnDeg = (a: number, b: number) => ((((b - a) % 360) + 540) % 360) - 180;

/** Locomotion weights moved between two frames, as L1. */
function blendMoved(a: Rig, b: Rig): number {
  const names = new Set([...a.clips, ...b.clips].map((c) => c.clip));
  let l1 = 0;
  for (const n of names)
    l1 += Math.abs(
      (b.clips.find((c) => c.clip === n)?.weight ?? 0) -
        (a.clips.find((c) => c.clip === n)?.weight ?? 0)
    );
  return l1;
}

test.skip(
  !demoId,
  'set DEMOVIEWER_E2E_DEMO=<demo id of the Mirage pack> with the server running'
);

test('players move with no corner at a sample, crouch without steps, and the POV camera never jumps', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  await page.goto(`/d/${demoId}?r=1`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  await page.waitForFunction(
    () =>
      (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState().qualityFrom !== 'default',
    undefined,
    { timeout: 30_000 }
  );
  const scenes = await page.evaluate(findScenes);
  expect(scenes).not.toBeNull();
  const { run, crouch, airDuck } = scenes!;
  console.log(
    `scenes: run ${JSON.stringify(run)}, crouch ${JSON.stringify(crouch)}, duck in the air ${JSON.stringify(airDuck)}`
  );

  // The runner from 1 s into the run, for 1.5 s: each sample, and a 32nd of a tick either side.
  const EPS = 1 / 32;
  const sampleTicks = Array.from(
    { length: 48 },
    (_, k) => run.tick + 64 + 2 * k
  );
  const swept = await sweep(
    page,
    run,
    'pov',
    sampleTicks.flatMap((t) => [t - EPS, t, t + EPS])
  );
  expect(swept.every((f) => f.rig !== null)).toBe(true);
  let kink = 0;
  let turnKink = 0;
  let speed = 0;
  for (let k = 0; k < sampleTicks.length; k++) {
    const [a, b, c] = swept.slice(3 * k, 3 * k + 3).map((f) => f.rig!);
    const v0 = [(b.x - a.x) / EPS, (b.z - a.z) / EPS];
    const v1 = [(c.x - b.x) / EPS, (c.z - b.z) / EPS];
    kink += Math.hypot(v1[0] - v0[0], v1[1] - v0[1]) / UNIT;
    speed += Math.hypot(v1[0], v1[1]) / UNIT;
    turnKink += Math.abs(turnDeg(b.yaw, c.yaw) - turnDeg(a.yaw, b.yaw)) / EPS;
  }
  const n = sampleTicks.length;
  console.log(
    `run at its samples: velocity changes by ${(kink / n).toFixed(3)} u/tick on average ` +
      `(moving ${(speed / n).toFixed(2)} u/tick), turn rate by ${(turnKink / n).toFixed(3)} deg/tick`
  );
  expect(speed / n).toBeGreaterThan(2);
  expect.soft(kink / n).toBeLessThan(0.1);
  expect.soft(turnKink / n).toBeLessThan(0.1);

  // POV through each crouch: half a second either side.
  for (const [what, s] of [
    ['crouch on the ground', crouch],
    ['duck in the air', airDuck],
  ] as const) {
    const pov = await sweep(page, s, 'pov', quarters(s.tick - 32, 256));
    let step = 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < pov.length; i++) {
      const f = pov[i];
      if (!f.rig || f.cam.mode !== 'pov') continue;
      const h = (f.cam.y - f.rig.y) / UNIT;
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
      const p = pov[i - 1];
      if (i > 0 && p.rig)
        step = Math.max(step, Math.abs(h - (p.cam.y - p.rig.y) / UNIT));
    }
    console.log(
      `POV ${what}: eye ${lo.toFixed(1)}..${hi.toFixed(1)} u over the feet, at most ${step.toFixed(2)} u a quarter tick`
    );
    // It did crouch...
    expect(hi - lo).toBeGreaterThan(15);
    // ...without a step.
    expect.soft(step).toBeLessThan(2.5);
  }

  // Played at 1× in POV through the run.
  const frames = await page.evaluate(
    (s) =>
      new Promise<{ tick: number; rig: Rig | null; cam: Cam }[]>((resolve) => {
        const d = (window as unknown as { __demoviewer: DebugHandle })
          .__demoviewer;
        const st = d.store.getState();
        st.pause();
        st.seekRound(s.round);
        st.setFollow(s.player);
        st.setCamera('pov');
        st.setSpeed(1);
        st.seekTick(s.tick);
        const out: { tick: number; rig: Rig | null; cam: Cam }[] = [];
        const end = s.tick + 4 * 64;
        // A second after the seek, then four of play.
        setTimeout(() => {
          d.store.getState().play();
          const step = () => {
            const now = d.store.getState();
            if (now.tick >= end || now.round !== s.round) {
              now.pause();
              resolve(out);
              return;
            }
            out.push({ tick: now.tick, rig: d.rig(s.player), cam: d.camera() });
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }, 1000);
      }),
    run
  );
  let most = 0;
  let mostAt = 0;
  let blend = 0;
  for (let i = 1; i < frames.length; i++) {
    const [a, b] = [frames[i - 1], frames[i]];
    // A frame longer than a 30 fps one (a stall) carries more game time: not counted.
    const ticks = b.tick - a.tick;
    if (!a.rig || !b.rig || ticks <= 0 || ticks > 64 / 30) continue;
    const m = Math.hypot(
      b.cam.x - b.rig.x - (a.cam.x - a.rig.x),
      b.cam.y - b.rig.y - (a.cam.y - a.rig.y),
      b.cam.z - b.rig.z - (a.cam.z - a.rig.z)
    );
    if (m > most) {
      most = m;
      mostAt = b.tick;
    }
    blend = Math.max(blend, blendMoved(a.rig, b.rig) / ticks);
  }
  console.log(
    `pov at 1×: ${frames.length} frames; the camera moved at most ${most.toFixed(3)} m about ` +
      `the player in a frame (tick ${mostAt.toFixed(1)}); the blend at most ${blend.toFixed(3)} of L1 a tick`
  );
  expect(frames.length).toBeGreaterThan(100);
  expect.soft(most).toBeLessThan(0.3);
  expect.soft(blend).toBeLessThan(0.6);
  expect(errors).toEqual([]);
});
