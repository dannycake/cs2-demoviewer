import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { faceOn, firstDoorSwing, lookDownAt, type FaceOn } from './spots';
import { frames, settled, trackLoads } from './wait';

// CS2's baked light (Tasks 5 and 6 of M2a) on the two maps built with it, in the real page on
// the GPU: each map loads light.json, lightmap.webp and probes.bin once and compiles every
// material, the players' lit by the light grid included, without a shader error at every
// preset; with light.json gone the map draws as it did before, with one warning; `high`
// draws at least about as fast with the bake as without (the world draws into the sun's shadow
// map once for the map, not every frame); and the frames of Nuke's first door swing at `high`,
// on each of which that map is drawn again, are timed against a still second (logged). Writes,
// with the HUD hidden:
//   assets/spike/m2a-baked-<map>-<preset>.jpg   the opening view at each preset (a link without a
//                                               camera: POV on player 1 in their spawn, their arms
//                                               lit by the light grid)
//   assets/spike/m2a-baked-mirage-fallback.jpg  Mirage at medium without its bake
//   assets/spike/m2a-t5-<view>-<preset>.jpg     fixed views at medium and high; mirage-a and
//                                               nuke-canal stand about where CS2 took
//                                               assets/maps/<map>/hero.png
//   assets/spike/m2a-merge-door-<when>.jpg      Nuke's first door swing at high, lit by the bake
//                                               (before, mid-swing, after): the world's shadow is
//                                               drawn again while it swings, not while it stands
//   assets/spike/m2a-pm-ground-<preset>.jpg     an item lying in the shade on Nuke's floor at low
//                                               and high, lit by the light grid as the players are
//   assets/spike/m2a-pm-glass-<spot>.jpg        CS2's glass (csgo_glass.vfx) at high, see-through:
//                                               Mirage's window before it breaks, Nuke's windows,
//                                               doors and frosted panes, Vertigo's insulation wrap,
//                                               Overpass's tinted panes; -opaque.jpg: drawn opaque,
//                                               as before the fix, where a pane is measured
//   assets/spike/m2a-pov-<alive|death>-<preset>.jpg  POV on Mirage's first victim of round 1 at
//                                               each preset, 1 s before their death (their arms
//                                               drawn under the bake) and 1 s after (their death
//                                               view, without them)
//   assets/spike/m2a-ff-<effect>[-off].jpg      Mirage's first molotov (2 s after it catches), flash
//                                               (at its peak) and HE (0.05 s in) at high, 8 m off,
//                                               with the effects' own bloom (post.ts
//                                               EffectsBloomPass) and without it (-off)
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the web app and assets built with
// the bake (tools/build-assets.sh de_mirage de_nuke), and the ids of an uploaded Mirage demo
// (DEMOVIEWER_E2E_DEMO) and Nuke demo (DEMOVIEWER_E2E_NUKE).
const DEMOS = {
  mirage: process.env.DEMOVIEWER_E2E_DEMO,
  nuke: process.env.DEMOVIEWER_E2E_NUKE,
};
type MapKey = keyof typeof DEMOS;
type Quality = 'low' | 'medium' | 'high';

const SPIKE = new URL('../../assets/spike/', import.meta.url);
const shot = (name: string) => fileURLToPath(new URL(`${name}.jpg`, SPIKE));

/** A tick in round 1's freeze time: the players are in their spawns, out of these views. */
const TICK = 1300;

/** Free-camera poses (`x,y,z,yaw,pitch,fov`, scene metres and degrees). */
const VIEWS: Record<string, { map: MapKey; at: string }> = {
  // A site at eye level, about where CS2's screenshot of Mirage stands.
  'mirage-a': { map: 'mirage', at: '-49.04,-3.2,-7.64,-118,-8,59' },
  'mirage-palace': { map: 'mirage', at: '-37,-1.2,28,24,7.5,59' },
  'nuke-outside': { map: 'nuke', at: '-45,2,22,44.1,19.2,59' },
  'nuke-lobby': { map: 'nuke', at: '-25,-7.4,-6,21.8,6.4,59' },
  // Across the canal, towards CS2's screenshot of Nuke.
  'nuke-canal': { map: 'nuke', at: '-102,1,-5,68,2,59' },
};

interface Handle {
  probe(ms?: number): Promise<number>;
  memory(): { calls: number };
  stats: { worldShadows: number };
  store: {
    getState(): {
      tick: number;
      seekTick(t: number): void;
      seekRound(r: number): void;
      setSpeed(speed: number): void;
      play(): void;
      pause(): void;
      pack: {
        header: {
          tick_rate: number;
          weapons: string[];
          rounds: { start_tick: number; end_tick: number }[];
        };
        ground: {
          round: number;
          id: number;
          weapon: number;
          tick: number;
          x: number;
          y: number;
          z: number;
          gone: boolean;
        }[];
      } | null;
    };
  };
  ground(): {
    round: number;
    tick: number;
    waiting: number;
    items: {
      id: number;
      weapon: string;
      sun: number | null;
      screen: [number, number, number, number] | null;
    }[];
  };
}

/** The pack's doors and windows and their keys, for finding a moment none of them moves. */
interface QuietHandle {
  store: {
    getState(): {
      pack: {
        header: { tick_rate: number; rounds: { end_tick: number }[] };
        entities: unknown[];
        entityChanges: {
          round: number;
          entity: number;
          tick: number;
          pitch: number;
          yaw: number;
          roll: number;
          gone: boolean;
        }[];
      } | null;
    };
  };
}

const handle = (page: Page) =>
  page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
    return { shadows: d.stats.worldShadows, tick: d.store.getState().tick };
  });

test.skip(
  !DEMOS.mirage || !DEMOS.nuke,
  'set DEMOVIEWER_E2E_DEMO and DEMOVIEWER_E2E_NUKE to the ids of a Mirage and a Nuke demo, with the server running'
);

/** The part of the store `open` swaps the map in. */
interface SwapHandle {
  store: {
    getState(): { map: string | null };
    setState(patch: { map: string }): void;
    subscribe(f: (s: { map: string | null }) => void): void;
  };
}

/** What a page asked for and said while it loaded. */
interface Seen {
  lightJson: number;
  lightmap: number;
  probes: number;
  entities: number;
  bakeWarnings: string[];
  errors: string[];
}

/**
 * Opens `map`'s demo at `quality` (at the free pose `at`, in POV pinned on player `pov`, a
 * 0-based index, or else as a link without a camera opens: POV on player 1) at `tick` of round
 * `round` (1-based; round 1's freeze time by default), with light.json answered 404 when
 * `noBake`, waits for the scene, and hides the HUD. With `drawMap` (a map no demo here is of:
 * Vertigo) the scene draws that map in place of the demo's: the store's map is swapped as the
 * pack names it, before the scene loads one, and the players stay where the demo has them.
 */
async function open(
  page: Page,
  map: MapKey,
  quality: Quality,
  {
    at,
    pov,
    noBake = false,
    round = 1,
    tick = TICK,
    drawMap,
  }: {
    at?: string;
    pov?: number;
    noBake?: boolean;
    round?: number;
    tick?: number;
    drawMap?: string;
  } = {}
): Promise<Seen> {
  const seen: Seen = {
    lightJson: 0,
    lightmap: 0,
    probes: 0,
    entities: 0,
    bakeWarnings: [],
    errors: [],
  };
  page.on('request', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.endsWith('/light.json')) seen.lightJson++;
    if (path.endsWith('/lightmap.webp')) seen.lightmap++;
    if (path.endsWith('/probes.bin')) seen.probes++;
    if (path.endsWith('/entities.glb')) seen.entities++;
  });
  page.on('console', (m) => {
    if (m.type() === 'warning' && m.text().includes('no baked light'))
      seen.bakeWarnings.push(m.text());
    // WebGL reports a shadow map bound while it is drawn into, and other GL errors, as
    // warnings: any of them fails the page.
    if (m.type() === 'warning' && /Feedback loop|GL_INVALID/.test(m.text()))
      seen.errors.push(m.text());
    // The light.json the test refuses is the only request allowed to fail.
    if (
      m.type() === 'error' &&
      !(noBake && m.text().includes('Failed to load resource'))
    )
      seen.errors.push(m.text());
  });
  page.on('pageerror', (e) => seen.errors.push(e.message));
  if (noBake)
    await page.route('**/light.json*', (r) =>
      r.fulfill({ status: 404, body: '' })
    );
  await trackLoads(page);
  await page.addInitScript(
    (q) => localStorage.setItem('demoviewer.quality', q),
    quality
  );
  if (drawMap)
    await page.addInitScript(() => {
      // Read before the page rewrites its URL; a later page without it is left alone.
      const want = new URL(location.href).searchParams.get('e2e-map');
      if (!want) return;
      const wait = setInterval(() => {
        const d = (window as unknown as { __demoviewer?: SwapHandle })
          .__demoviewer;
        if (!d) return;
        clearInterval(wait);
        const swap = (s: { map: string | null }) => {
          if (s.map && s.map !== want) d.store.setState({ map: want });
        };
        swap(d.store.getState());
        d.store.subscribe(swap);
      }, 1);
    });
  const pose = at
    ? `&cam=free&at=${at}`
    : pov !== undefined
      ? `&cam=pov&p=${pov + 1}`
      : '';
  const swap = drawMap ? `&e2e-map=${drawMap}` : '';
  await page.goto(`/d/${DEMOS[map]}?r=${round}&t=${tick}${pose}${swap}`);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
  await page.addStyleTag({
    content:
      'body * { visibility: hidden !important } [data-testid=viewport] > canvas { visibility: visible !important }',
  });
  // The sky and the world's textures arrive after the scene says it is ready.
  await settled(page);
  return seen;
}

/** Seeks the paused replay to `tick` of the round shown and lets the view settle. */
async function seek(page: Page, tick: number): Promise<void> {
  const since = await frames(page);
  await page.evaluate(
    (t) =>
      (window as unknown as { __demoviewer: Handle }).__demoviewer.store
        .getState()
        .seekTick(t),
    tick
  );
  await settled(page, { since });
  expect((await handle(page)).tick).toBe(tick);
}

/**
 * The first second from tick `from` of round `round` (0-based) in which no door or window of
 * the loaded pack moves, as its first and last tick, or null when the round has none.
 */
const quietSecond = (page: Page, round: number, from: number) =>
  page.evaluate(
    ({ round, from }) => {
      const d = (window as unknown as { __demoviewer: QuietHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const rate = pack.header.tick_rate;
      const keys = pack.entityChanges.filter((c) => c.round === round);
      const same = (
        a: (typeof keys)[number] | undefined,
        b: (typeof keys)[number] | undefined
      ) =>
        !a ||
        !b ||
        (a.pitch === b.pitch &&
          a.yaw === b.yaw &&
          a.roll === b.roll &&
          a.gone === b.gone);
      const still = (t1: number, t2: number) =>
        pack.entities.every((_, e) => {
          const mine = keys.filter((c) => c.entity === e);
          if (mine.some((c) => c.tick > t1 && c.tick < t2)) return false;
          const before = mine.filter((c) => c.tick <= t1).at(-1);
          const after = mine.find((c) => c.tick >= t2);
          return same(before, after);
        });
      const end = pack.header.rounds[round].end_tick;
      for (let t = from; t + rate <= end; t += rate / 2)
        if (still(t, t + rate)) return { from: t, to: t + rate };
      return null;
    },
    { round, from }
  );

/** The 3D view alone, as PNG bytes. */
const canvasShot = (page: Page) =>
  page.getByTestId('viewport').locator('canvas').first().screenshot({
    type: 'png',
  });

async function save(page: Page, name: string): Promise<void> {
  const clip = await page.getByTestId('viewport').boundingBox();
  expect(clip).not.toBeNull();
  await page.screenshot({
    path: shot(name),
    type: 'jpeg',
    quality: 88,
    clip: clip!,
  });
}

/** The best of five one-second probes of the paused frame, in frames per second. */
async function bestFps(page: Page): Promise<number> {
  let fps = 0;
  for (let i = 0; i < 5; i++)
    fps = Math.max(
      fps,
      await page.evaluate(() =>
        (window as unknown as { __demoviewer: Handle }).__demoviewer.probe(1000)
      )
    );
  return fps;
}

test.beforeAll(() => {
  mkdirSync(fileURLToPath(SPIKE), { recursive: true });
});

for (const map of ['mirage', 'nuke'] as const)
  test(`${map} loads its bake once and draws it at every preset`, async ({
    page,
  }) => {
    for (const q of ['low', 'medium', 'high'] as const) {
      const seen = await open(page, map, q);
      expect(seen.lightJson).toBe(1);
      expect(seen.lightmap).toBe(1);
      expect(seen.probes).toBe(1);
      expect(seen.bakeWarnings).toEqual([]);
      expect(seen.errors).toEqual([]);
      await save(page, `m2a-baked-${map}-${q}`);
      page.removeAllListeners();
    }
  });

test('fixed views at medium and high', async ({ page }) => {
  for (const [name, { map, at }] of Object.entries(VIEWS))
    for (const q of ['medium', 'high'] as const) {
      const seen = await open(page, map, q, { at });
      expect(seen.errors).toEqual([]);
      expect(seen.bakeWarnings).toEqual([]);
      await save(page, `m2a-t5-${name}-${q}`);
      page.removeAllListeners();
    }
});

/**
 * CS2's glass (`csgo_glass.vfx`) to look at: Mirage's window square on from where there is room
 * (its middle in Source units and its horizontal normal), elsewhere free-camera poses 2.5 to 4 m
 * off panes along their normals (from the glass primitives' triangles). `pane` is a rectangle
 * of the view inside the glass (fractions of its width and height) where it must draw at least
 * `PANE_CHANGE` times brighter or darker than the same glass drawn opaque, as before the fix;
 * without one only the shot is taken (Nuke's control-room window looks onto a white room, its
 * frosted glass is meant to be milky).
 */
const GLASS: Record<
  string,
  {
    map: MapKey;
    face?: FaceOn;
    at?: string;
    drawMap?: string;
    pane?: [number, number, number, number];
  }
> = {
  // The window that breaks in round 3, whole in round 1 (entities.glb).
  'mirage-window': {
    map: 'mirage',
    face: { x: -863, y: -2508, z: -89, nx: 0, ny: 1, side: 1 },
    pane: [0.45, 0.32, 0.57, 0.62],
  },
  // A window into the control rooms, a pair of doors' windows, and frosted glass beside a door.
  'nuke-window': { map: 'nuke', at: '-14.21,-14.22,22.4,0,0' },
  'nuke-doors': {
    map: 'nuke',
    at: '-48.77,-14.27,45.15,180,0',
    pane: [0.56, 0.32, 0.74, 0.7],
  },
  'nuke-frosted': { map: 'nuke', at: '-40.78,-14.92,21.71,-90,0' },
  // Vertigo's insulation bundles, wrapped in csgo_glass (no Vertigo demo: Mirage's, redrawn).
  vertigo: {
    map: 'mirage',
    at: '7.6,301.0,-2.86,-90,18',
    drawMap: 'de_vertigo',
    pane: [0.36, 0.45, 0.6, 0.85],
  },
  // Overpass's office windows and a window of the hut by the tracks, tinted near-black by their
  // base colour (0.079, 0.007): tinted glass, not black panes (Mirage's demo, redrawn).
  'overpass-office': {
    map: 'mirage',
    at: '30.08,18.64,-70.77,63.25,-0.12',
    drawMap: 'de_overpass',
    pane: [0.3, 0.25, 0.7, 0.75],
  },
  'overpass-hut': {
    map: 'mirage',
    at: '23.04,15.55,-50.95,-26.51,0.22',
    drawMap: 'de_overpass',
    pane: [0.39, 0.49, 0.61, 0.75],
  },
};

/**
 * How much the glass inside a `pane` must change from opaque: measured on these assets, from
 * 1.9 (Mirage's window, white over a plain room) to 10.6 (Overpass's office, black).
 */
const PANE_CHANGE = 1.5;

/** The map files whose glass `opaqueGlass` renames. */
const MAP_GLBS = /\/maps\/[^/]+\/(world|entities)\.glb/;

/**
 * From now on the page gets the maps' GLBs with CS2's glass shader renamed in their JSON (to a
 * name of the same length, so no offset moves): the look then draws the glass as it did before
 * the fix, opaque, on these very assets. Routing turns off the browser's cache, so nothing
 * patched is kept for the pages after `page.unroute(MAP_GLBS)`.
 */
async function opaqueGlass(page: Page): Promise<void> {
  await page.route(MAP_GLBS, async (route) => {
    const res = await route.fetch();
    let body = await res.body();
    if (body[0] === 0x1f && body[1] === 0x8b) body = gunzipSync(body);
    const len = body.readUInt32LE(12);
    const json = body.toString('latin1', 20, 20 + len);
    const out = Buffer.from(body);
    out.write(
      json.replaceAll('csgo_glass.vfx', 'csgo_glasz.vfx'),
      20,
      'latin1'
    );
    await route.fulfill({
      status: 200,
      contentType: 'model/gltf-binary',
      body: out,
    });
  });
}

test("draws CS2's glass see-through at high, not as it drew opaque: Mirage's window before it breaks, Nuke's windows, doors and frosted panes, Vertigo's insulation wrap, Overpass's tinted panes", async ({
  page,
}) => {
  test.setTimeout(360_000);
  for (const [name, { map, face, at, drawMap, pane }] of Object.entries(
    GLASS
  )) {
    let pose = at;
    if (!pose) {
      await open(page, map, 'high');
      pose = await faceOn(page, face!);
      page.removeAllListeners();
    }
    const seen = await open(page, map, 'high', { at: pose, drawMap });
    await save(page, `m2a-pm-glass-${name}`);
    expect(seen.bakeWarnings).toEqual([]);
    expect(seen.errors).toEqual([]);
    page.removeAllListeners();
    if (!pane) continue;
    const rect = (png: Buffer): [number, number, number, number] => {
      const w = png.readUInt32BE(16);
      const h = png.readUInt32BE(20);
      return [pane[0] * w, pane[1] * h, pane[2] * w, pane[3] * h];
    };
    const shot = await canvasShot(page);
    const see = await luminanceIn(page, shot, rect(shot));
    // The same view with the glass drawn opaque, as before the fix.
    await opaqueGlass(page);
    const before = await open(page, map, 'high', { at: pose, drawMap });
    await save(page, `m2a-pm-glass-${name}-opaque`);
    const opaqueShot = await canvasShot(page);
    const opaque = await luminanceIn(page, opaqueShot, rect(opaqueShot));
    await page.unroute(MAP_GLBS);
    expect(before.errors).toEqual([]);
    page.removeAllListeners();
    const change = Math.max(see.mean / opaque.mean, opaque.mean / see.mean);
    console.log(
      `${name}: the pane at mean ${see.mean.toFixed(4)} linear, ${opaque.mean.toFixed(4)} drawn opaque (×${change.toFixed(2)})`
    );
    expect(change, name).toBeGreaterThan(PANE_CHANGE);
  }
});

/**
 * How much brighter the middle of the view around an effect must be with the effects' own bloom
 * than without it (mean linear luminance; ×1.18 the molotov, ×1.07 the flash, ×1.11 the HE on
 * 2026-10-25, after milestone 2b), and the most any corner may change (0 then).
 */
const EFFECT_GLOW = 1.02;
const FAR_CHANGE = 0.002;

/** An effect in the Mirage demo to look at: where (scene metres, its centre) and when. */
interface EffectSpot {
  name: string;
  round: number;
  tick: number;
  at: [number, number, number];
}

test('blooms the molotov, the flash and the HE by their own light at high on a baked world, and nothing far from them', async ({
  page,
}) => {
  test.setTimeout(300_000);
  await open(page, 'mirage', 'high');
  const spots = await page.evaluate(() => {
    const d = (
      window as unknown as {
        __demoviewer: {
          store: {
            getState(): {
              pack: {
                header: {
                  tick_rate: number;
                  rounds: { start_tick: number; end_tick: number }[];
                };
                events: {
                  tick: number;
                  kind: string;
                  data: Record<string, number | string>;
                }[];
              };
            };
          };
        };
      }
    ).__demoviewer;
    const p = d.store.getState().pack;
    const rate = p.header.tick_rate;
    const U = 0.0254;
    const roundOf = (t: number) =>
      p.header.rounds.findIndex((r) => t >= r.start_tick && t <= r.end_tick) +
      1;
    const ends = p.events.filter(
      (e) => e.kind === 'inferno_expire' || e.kind === 'inferno_extinguish'
    );
    // A molotov burns past 6.5 s (an incendiary is out after 5.5).
    const fire = p.events
      .filter((e) => e.kind === 'inferno_startburn')
      .find((b) => {
        const end = ends.find(
          (e) => e.data.entityid === b.data.entityid && e.tick > b.tick
        );
        return !!end && (end.tick - b.tick) / rate >= 6.5;
      })!;
    const first = (kind: string) => p.events.find((e) => e.kind === kind)!;
    const spot = (
      name: string,
      e: (typeof p.events)[number],
      after: number,
      lift: number
    ) => ({
      name,
      round: roundOf(e.tick),
      tick: e.tick + Math.round(after * rate),
      at: [
        Number(e.data.y) * U,
        Number(e.data.z) * U + lift,
        Number(e.data.x) * U,
      ] as [number, number, number],
    });
    return [
      spot('molotov', fire, 2, 0.6),
      spot('flash', first('flashbang_detonate'), 0.04, 0),
      spot('he', first('hegrenade_detonate'), 0.05, 0.3),
    ];
  });
  page.removeAllListeners();
  type Debug = {
    hullDistance(x: number, y: number, z: number): number | null;
    effectsBloom(on: boolean): void;
  };
  for (const e of spots as EffectSpot[]) {
    // A spot 8, 6 or 4 m off at eye height whose line to the effect keeps clear of the hull,
    // facing it.
    await open(page, 'mirage', 'high', { round: e.round, tick: e.tick });
    const pose = await page.evaluate((c) => {
      const d = (window as unknown as { __demoviewer: Debug }).__demoviewer;
      for (const m of [8, 6, 4])
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const p = [
            c[0] + m * Math.sin(a),
            c[1] + 1.5,
            c[2] + m * Math.cos(a),
          ];
          let clear = (d.hullDistance(p[0], p[1], p[2]) ?? 10) >= 1;
          for (let i = 1; i < 10 && clear; i++) {
            const t = i / 10;
            clear =
              (d.hullDistance(
                p[0] + (c[0] - p[0]) * t,
                p[1] + (c[1] - p[1]) * t,
                p[2] + (c[2] - p[2]) * t
              ) ?? 10) >= 0.25;
          }
          if (!clear) continue;
          const [dx, dy, dz] = [c[0] - p[0], c[1] - p[1], c[2] - p[2]];
          const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
          const pitch =
            (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
          return `${p.join(',')},${yaw},${pitch},60`;
        }
      return null;
    }, e.at);
    expect(pose, `a clear spot by the ${e.name}`).not.toBeNull();
    page.removeAllListeners();
    const seen = await open(page, 'mirage', 'high', {
      at: pose!,
      round: e.round,
      tick: e.tick,
    });
    const on = await canvasShot(page);
    await save(page, `m2a-ff-${e.name}`);
    const since = await frames(page);
    await page.evaluate(() =>
      (window as unknown as { __demoviewer: Debug }).__demoviewer.effectsBloom(
        false
      )
    );
    await settled(page, { since });
    const off = await canvasShot(page);
    await save(page, `m2a-ff-${e.name}-off`);
    const w = on.readUInt32BE(16);
    const h = on.readUInt32BE(20);
    // The effect, at the middle of the view; and the four corners, far from it.
    const middle: [number, number, number, number] = [
      0.35 * w,
      0.3 * h,
      0.65 * w,
      0.7 * h,
    ];
    const corners: [number, number, number, number][] = [
      [0, 0, 0.15 * w, 0.15 * h],
      [0.85 * w, 0, w, 0.15 * h],
      [0, 0.85 * h, 0.15 * w, h],
      [0.85 * w, 0.85 * h, w, h],
    ];
    const glow = await luminanceIn(page, on, middle);
    const without = await luminanceIn(page, off, middle);
    let far = 0;
    for (const r of corners)
      far = Math.max(
        far,
        Math.abs(
          (await luminanceIn(page, on, r)).mean -
            (await luminanceIn(page, off, r)).mean
        )
      );
    console.log(
      `${e.name} at high (round ${e.round}, tick ${e.tick}): the middle at ${glow.mean.toFixed(4)} linear with the effects' bloom, ${without.mean.toFixed(4)} without (×${(glow.mean / without.mean).toFixed(3)}); the corners change by ${far.toFixed(5)} at most`
    );
    expect(glow.mean, e.name).toBeGreaterThan(without.mean * EFFECT_GLOW);
    expect(far, e.name).toBeLessThan(FAR_CHANGE);
    expect(seen.bakeWarnings).toEqual([]);
    expect(seen.errors).toEqual([]);
    page.removeAllListeners();
  }
});

test('draws Mirage as before, with one warning, when its light.json is missing', async ({
  page,
}) => {
  const seen = await open(page, 'mirage', 'medium', { noBake: true });
  expect(seen.lightJson).toBe(1);
  expect(seen.lightmap).toBe(0);
  expect(seen.probes).toBe(0);
  expect(seen.bakeWarnings).toHaveLength(1);
  expect(seen.errors).toEqual([]);
  await save(page, 'm2a-baked-mirage-fallback');
});

test('draws high on Nuke at least about as fast with the bake as without', async ({
  page,
}) => {
  const at = VIEWS['nuke-lobby'].at;
  await open(page, 'nuke', 'high', { at, noBake: true });
  const before = await bestFps(page);
  const callsBefore = await page.evaluate(
    () =>
      (window as unknown as { __demoviewer: Handle }).__demoviewer.memory()
        .calls
  );
  page.removeAllListeners();
  await page.unrouteAll();
  await open(page, 'nuke', 'high', { at });
  const worldShadows = () =>
    page.evaluate(
      () =>
        (window as unknown as { __demoviewer: Handle }).__demoviewer.stats
          .worldShadows
    );
  const drawnBefore = await worldShadows();
  const after = await bestFps(page);
  const callsAfter = await page.evaluate(
    () =>
      (window as unknown as { __demoviewer: Handle }).__demoviewer.memory()
        .calls
  );
  console.log(
    `nuke lobby at high: ${before.toFixed(1)} fps (${callsBefore} calls) without the bake, ` +
      `${after.toFixed(1)} fps (${callsAfter} calls) with it`
  );
  // The world draws into the sun's shadow map once for the map (the players need it to stand
  // in the shade), not every frame: a frame's draws hold only the players' shadow map.
  expect(drawnBefore).toBeGreaterThanOrEqual(1);
  expect(await worldShadows()).toBe(drawnBefore);
  expect(callsAfter).toBeLessThan(callsBefore);
  // A shared machine's timings drift by 10 % or more (quality.spec.ts): a coarse guard.
  expect(after).toBeGreaterThan(before * 0.9);
});

test("swings Nuke's first door under the bake at high, its shadow drawn again only while it moves", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await open(page, 'nuke', 'high');
  const swing = await firstDoorSwing(page);
  const at = await faceOn(page, swing.at);
  page.removeAllListeners();
  const before = swing.tick - Math.round(0.2 * swing.rate);
  const seen = await open(page, 'nuke', 'high', {
    at,
    round: swing.round + 1,
    tick: before,
  });
  expect(seen.lightJson).toBe(1);
  expect(seen.entities).toBe(1);
  await seek(page, before);
  const still = await handle(page);
  await save(page, 'm2a-merge-door-before');
  const closed = await canvasShot(page);
  await seek(page, swing.mid);
  const turning = await handle(page);
  await save(page, 'm2a-merge-door-mid');
  const mid = await canvasShot(page);
  const after = swing.end + swing.rate;
  await seek(page, after);
  const open_ = await handle(page);
  await save(page, 'm2a-merge-door-after');
  const opened = await canvasShot(page);
  // A second in which no door or window of the round moves, from a tick in it to its end: the
  // shadow is not drawn again.
  const quiet = await quietSecond(page, swing.round, after);
  expect(quiet).not.toBeNull();
  await seek(page, quiet!.from);
  const resting = await handle(page);
  await seek(page, quiet!.to);
  const standing = await handle(page);
  console.log(
    `door swing round ${swing.round + 1} ticks ${swing.tick}–${swing.end}: world shadow drawn ${still.shadows} → ${turning.shadows} (mid) → ${open_.shadows} (after) → ${resting.shadows} → ${standing.shadows} (a still second, ticks ${quiet!.from}–${quiet!.to})`
  );
  // The door turned between the shots, and the sun's shadow of the world (with the door in it)
  // was drawn again for each turn, and not for a frame in which it stood still.
  expect(turning.shadows).toBeGreaterThan(still.shadows);
  expect(open_.shadows).toBeGreaterThan(turning.shadows);
  expect(standing.shadows).toBe(resting.shadows);
  expect(Buffer.compare(closed, mid), 'before and mid-swing').not.toBe(0);
  expect(Buffer.compare(mid, opened), 'mid-swing and after').not.toBe(0);
  expect(seen.bakeWarnings).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("times the frames of Nuke's first door swing at high against a still second", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await open(page, 'nuke', 'high');
  const swing = await firstDoorSwing(page);
  const at = await faceOn(page, swing.at);
  page.removeAllListeners();
  const seen = await open(page, 'nuke', 'high', {
    at,
    round: swing.round + 1,
    tick: swing.tick,
  });
  const quiet = await quietSecond(page, swing.round, swing.end + swing.rate);
  expect(quiet).not.toBeNull();
  // Played at a quarter of the speed from `from` while `probe` times a second of frames (each
  // waits for the GPU): from the swing's first key, 16 of its ticks, every frame turning the
  // door; from the still second, none.
  const timed = (from: number) =>
    page.evaluate(async (from) => {
      const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
      const s = d.store.getState();
      s.pause();
      s.seekTick(from);
      s.setSpeed(0.25);
      await new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r))
      );
      const drawn = d.stats.worldShadows;
      s.play();
      const fps = await d.probe(1000);
      s.pause();
      s.setSpeed(1);
      return { ms: 1000 / fps, redraws: d.stats.worldShadows - drawn };
    }, from);
  const swinging: { ms: number; redraws: number }[] = [];
  const still: { ms: number; redraws: number }[] = [];
  for (let i = 0; i < 3; i++) {
    swinging.push(await timed(swing.tick));
    still.push(await timed(quiet!.from));
  }
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[1];
  const fmt = (r: { ms: number; redraws: number }[]) =>
    `${median(r.map((x) => x.ms)).toFixed(2)} ms (runs ${r.map((x) => x.ms.toFixed(2)).join(', ')}; world shadow drawn ${r.map((x) => x.redraws).join(', ')} times)`;
  console.log(
    `door swing round ${swing.round + 1} ticks ${swing.tick}–${swing.end} at high: a frame while it swings ${fmt(swinging)}; a frame in a still second (ticks ${quiet!.from}–${quiet!.to}) ${fmt(still)}`
  );
  // Drawn again on the frames the door turns, and on none while it stands.
  for (const r of swinging) expect(r.redraws).toBeGreaterThan(10);
  for (const r of still) expect(r.redraws).toBe(0);
  expect(seen.bakeWarnings).toEqual([]);
  expect(seen.errors).toEqual([]);
});

test("draws an item lying in the shade of a baked map shaded, at low (the grid's sun) and at high (the shadow maps)", async ({
  page,
}) => {
  test.setTimeout(300_000);
  await open(page, 'nuke', 'high');
  // Items that lie still for 3 s or more from a key, after a round's first 10 s.
  const candidates = await page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
    const pack = d.store.getState().pack!;
    const h = pack.header;
    const keys = pack.ground;
    const out: {
      round: number;
      tick: number;
      id: number;
      weapon: string;
      at: { x: number; y: number; z: number };
    }[] = [];
    for (let i = 0; i < keys.length; i++) {
      const g = keys[i];
      const next = keys[i + 1];
      const r = h.rounds[g.round];
      if (g.gone || g.tick < r.start_tick + 10 * h.tick_rate) continue;
      const until =
        next && next.id === g.id && next.round === g.round
          ? next.tick
          : r.end_tick;
      if (until - g.tick < 3 * h.tick_rate) continue;
      out.push({
        round: g.round,
        tick: g.tick + 2 * h.tick_rate,
        id: g.id,
        weapon: h.weapons[g.weapon],
        at: { x: g.x, y: g.y, z: g.z },
      });
    }
    return out;
  });
  // The first of them the grid has in the shade.
  let item: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    const sun = await page.evaluate(async (c) => {
      const d = (window as unknown as { __demoviewer: Handle }).__demoviewer;
      const s = d.store.getState();
      s.seekRound(c.round);
      d.store.getState().seekTick(c.tick);
      for (let i = 0; i < 100; i++) {
        await new Promise((r) => requestAnimationFrame(r));
        const g = d.ground();
        if (g.round === c.round && g.tick === c.tick && g.waiting === 0)
          return g.items.find((x) => x.id === c.id)?.sun ?? null;
      }
      return null;
    }, c);
    if (sun !== null && sun <= 0.1) {
      item = c;
      break;
    }
  }
  expect(item, 'an item lying in the shade').not.toBeNull();
  const it_ = item!;
  const at = await lookDownAt(page, it_.at);
  page.removeAllListeners();
  const lum: Record<string, { mean: number; p90: number }> = {};
  for (const q of ['low', 'high'] as const) {
    const seen = await open(page, 'nuke', q, {
      at,
      round: it_.round + 1,
      tick: it_.tick,
    });
    await seek(page, it_.tick);
    const drawn = await page.evaluate(() =>
      (window as unknown as { __demoviewer: Handle }).__demoviewer.ground()
    );
    expect(drawn.waiting).toBe(0);
    const shown = drawn.items.find((g) => g.id === it_.id);
    expect(shown).toBeDefined();
    // Lit by the grid where it lies, in its shade: at low that is all the sun it gets.
    expect(shown!.sun).not.toBeNull();
    expect(shown!.sun!).toBeLessThanOrEqual(0.1);
    await save(page, `m2a-pm-ground-${q}`);
    // The rectangle is in CSS pixels, the shot in device pixels.
    const png = await canvasShot(page);
    const box = await page
      .getByTestId('viewport')
      .locator('canvas')
      .first()
      .boundingBox();
    const dpr = png.readUInt32BE(16) / box!.width;
    lum[q] = await luminanceIn(
      page,
      png,
      shown!.screen!.map((v) => v * dpr) as [number, number, number, number]
    );
    console.log(
      `${q}: ${it_.weapon} (item ${it_.id}) in the shade at round ${it_.round + 1} tick ${it_.tick}, grid sun ${shown!.sun!.toFixed(3)}, ${drawn.items.length} item(s) drawn; on screen at ${shown!.screen!.map((v) => Math.round(v)).join(',')}: mean ${lum[q].mean.toFixed(4)}, brightest tenth ${lum[q].p90.toFixed(4)} (linear)`
    );
    expect(seen.bakeWarnings).toEqual([]);
    expect(seen.errors).toEqual([]);
    page.removeAllListeners();
  }
  // Shaded alike at both: the grid's sun at low, the shadow maps at high, within 30 % (measured:
  // 1.05 for the mean, 1.08 for the brightest tenth). Lit by the sun at either, its brightest
  // parts read far brighter there: the build before the grid lit the items read low/high 1.73
  // for the mean and 2.39 for the brightest tenth on this item.
  for (const k of ['mean', 'p90'] as const) {
    expect(lum.low[k] / lum.high[k], k).toBeGreaterThan(1 / 1.3);
    expect(lum.low[k] / lum.high[k], k).toBeLessThan(1.3);
  }
});

/** The camera drawn last (`Scene.cameraDebug`) and the pack's events, for the POV test. */
interface PovHandle {
  camera(): {
    x: number;
    y: number;
    z: number;
    mode: string;
    shown: number | null;
  };
  store: {
    getState(): {
      pack: {
        header: {
          tick_rate: number;
          rounds: { freeze_end_tick: number; end_tick: number }[];
        };
        events: { kind: string; tick: number; data: Record<string, unknown> }[];
      } | null;
    };
  };
}

const cameraOf = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __demoviewer: PovHandle }).__demoviewer.camera()
  );

test('POV under the bake at every preset: the arms drawn while the player lives, then their death view without them, with no GL error', async ({
  page,
}) => {
  test.setTimeout(240_000);
  // Round 1's first death after its freeze time, on Mirage.
  await open(page, 'mirage', 'low');
  const death = await page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: PovHandle }).__demoviewer;
    const pack = d.store.getState().pack!;
    const info = pack.header.rounds[0];
    const e = pack.events.find(
      (e) =>
        e.kind === 'player_death' &&
        e.tick > info.freeze_end_tick &&
        e.tick <= info.end_tick &&
        typeof e.data.user_idx === 'number'
    )!;
    return {
      victim: e.data.user_idx as number,
      tick: e.tick,
      rate: pack.header.tick_rate,
    };
  });
  page.removeAllListeners();
  for (const q of ['low', 'medium', 'high'] as const) {
    // Pinned on the victim (a link's `p`), 1 s before their death: their eyes and arms.
    const seen = await open(page, 'mirage', q, {
      pov: death.victim,
      tick: death.tick - death.rate,
    });
    expect(await cameraOf(page)).toMatchObject({
      mode: 'pov',
      shown: death.victim,
    });
    await save(page, `m2a-pov-alive-${q}`);
    // 1 s and 3 s after it: their death view, held still where they died (pinned, past the
    // 2 s too); the arms are hidden and take no light (scene-map.test.ts).
    await seek(page, death.tick + death.rate);
    const held = await cameraOf(page);
    await save(page, `m2a-pov-death-${q}`);
    await seek(page, death.tick + 3 * death.rate);
    const later = await cameraOf(page);
    for (const c of [held, later])
      expect(c).toMatchObject({ mode: 'pov', shown: death.victim });
    expect(
      Math.hypot(later.x - held.x, later.y - held.y, later.z - held.z)
    ).toBeLessThan(0.01);
    console.log(
      `${q}: player ${death.victim + 1} dies at tick ${death.tick}; death view at ` +
        `${[held.x, held.y, held.z].map((v) => v.toFixed(2)).join(', ')}`
    );
    expect(seen.bakeWarnings).toEqual([]);
    expect(seen.errors).toEqual([]);
    page.removeAllListeners();
  }
});

/**
 * The linear luminance of a PNG of the view within `rect` (`[left, top, right, bottom]` in
 * pixels): its mean, and the least of its brightest tenth. Decoded in the page.
 */
const luminanceIn = (
  page: Page,
  png: Buffer,
  rect: [number, number, number, number]
) =>
  page.evaluate(
    async ({ b64, rect }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      const x0 = Math.max(0, Math.floor(rect[0]));
      const y0 = Math.max(0, Math.floor(rect[1]));
      const x1 = Math.min(img.width, Math.ceil(rect[2]));
      const y1 = Math.min(img.height, Math.ceil(rect[3]));
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
      const lin = (v: number) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const l: number[] = [];
      for (let i = 0; i < d.length; i += 4)
        l.push(
          0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2])
        );
      l.sort((a, b) => a - b);
      return {
        mean: l.reduce((a, b) => a + b, 0) / l.length,
        p90: l[Math.floor(l.length * 0.9)],
      };
    },
    { b64: png.toString('base64'), rect }
  );
