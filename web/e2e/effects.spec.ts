import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { QUALITY_KEY } from '../src/state/store';
import { faceOn, firstDoorSwing, lookDownAt } from './spots';
import type { MarkDebug } from '../src/scene/bulletmarks';
import { frames, settled, trackLoads } from './wait';
import { trackErrors } from './errors';

// Effects drawn from CS2's own textures (the `/effects/` atlases), looked at in the real page.
//
// "molotov": in each of a Nuke and a Mirage pack, the first fire that burns at least 6.5 s (a
// molotov; an incendiary is out after 5.5 s), else the first fire. The thrower is followed, then
// the free camera takes over and flies, by right-drag and W as a viewer would, to a spot 2 m up
// and up to 8 m off the fire with nothing of the map's hull between, looking at it; at 0.3 s (the burst as the flames catch), 2 s and 6 s after it
// catches the page is shot to e2e/out/molotov-<map>-<s>.jpg, to be looked at beside CS2 footage
// of a molotov (flames from CS2's frames, catching outwards, the smoke column). The fire's two
// atlases must have been fetched, so the flames are CS2's and not the noise fallback; and the
// page, opened on the first round at its freeze end (before any shot, hit or grenade of it),
// must have fetched nothing under /effects/ by then: no atlas loads before an effect needs it.
//
// "utility": the first smoke, HE and flash of the Nuke pack. The free camera stands off each
// as off the molotov (8, 6 or 4 m away, 2 m up, a clear line to it), looking at a point 1 m over
// it, and the page is shot at its detonation + 0.1 s, + 0.5 s and + 3 s
// (e2e/out/<smoke|he|flash>-<s>.jpg), to be looked at beside CS2: the smoke's puffs are CS2's
// frames, grey-white on Nuke (not the sky's blue); the HE is CS2's fireball over its ring, then
// its smoke rising; the flash CS2's flare. Each one's atlases must have been fetched (smoke,
// explosion, flare).
//
// "shots": muzzle flashes by the gun's class and blood from CS2's frames, on Mirage. For the
// first rifle (AK-47 or M4A4), AWP and unsuppressed pistol shot of the match that starts a burst
// (no shot of the player's in the 0.5 s before), the free camera stands 3 m off the shooter's
// side, a little ahead, at eye height, with a clear line to the gun, looking at it through 45°,
// and the page is shot at the shot's tick (e2e/out/shot-<rifle|awp|pistol>.jpg); for the first
// headshot with a spot 3 or 4 m off the victim's head, the same 3 ticks after the hit
// (shot-headshot.jpg); and the rifle shot again in POV on its shooter (shot-pov-rifle.jpg), its
// flash at the first-person gun's muzzle, small enough to see past. To be looked at beside CS2:
// a flame_omni frame at the muzzle, as big as the gun's class, and the headshot's blood.
// muzzle.webp (for the shots) and blood.webp (for the headshot) must have been fetched.
//
// "impacts": what the bullets leave, on Mirage. Of the match's sprays (6 or more rifle misses of
// one player, each within 0.25 s of the last), the first on wood (a door) and the first on stone
// (a sandstone wall) of which 5 holes of that surface land together on a wall (within 1.5 m of
// one, their normal level) within 20 m of the shooter, each hole on one of the spray's own shot lines; for each (<kind> wood or
// stone): in POV on the shooter 0.1 s after its last shot (e2e/out/impacts-spray-<kind>-pov.jpg);
// then the free camera 2.5 m back from the holes along the bullets' way (clear: they flew there),
// looking at them, 0.1 s after (the dust and the holes, impacts-spray-<kind>.jpg) and 3 s after
// (the holes alone, impacts-spray-<kind>-3s.jpg), and from a metre ahead of the shooter's eye 3 s
// after (impacts-spray-<kind>-far-3s.jpg); 13 s after, none of them is drawn. The first wallbang kill
// (`penetrated`, its hit's `num_penetrations`) whose bullet's line meets a hole: in POV on the
// killer 0.1 s after (impacts-wallbang-pov.jpg), and the free camera on the bullet's line looking
// at the first hole from the killer's side (its way in, impacts-wallbang-in.jpg) and at the last
// from the victim's (its way out, impacts-wallbang-out.jpg). To be looked at beside CS2: dust in
// the wall's colour and CS2's bullet holes on it, small and dark. decals.webp and dust.webp must
// have been fetched.
//
// "smoke cover": smokes hide what is behind them, on Mirage. The match's longest burst of rifle
// misses fired into a smoke (each shot's line within 1.5 m of the smoke's middle 5–15 m out, the
// smoke full and not fading), shot as its last shot leaves: in POV on the shooter
// (e2e/out/smoke-cover-pov.jpg: their own flash at the gun, never hidden; the puffs on the wall
// behind the smoke hidden), from 2.5 m behind them and to one side looking at the smoke
// (smoke-cover-behind.jpg, and 0.1 s on, smoke-cover-behind-0.1s.jpg: the flash in front of the
// smoke, the puffs of the misses behind it), and from across the smoke looking back at them through it (smoke-cover-across.jpg: their
// flash hidden). To be looked at beside the same shots of the build before (each sprite behind a
// smoke drawn over it there).
//
// "doors": the doors and windows of the match (ENT1 + entities.glb). On Nuke, the free camera
// stands off the door of the match's first swing, looking at it, and the page is shot 0.2 s
// before its first key, mid-swing and 1 s after (e2e/out/door-*.jpg); seeking back to mid-swing
// must draw the very frame it drew before. On Mirage, POV on the player nearest the window that
// breaks in round 3 (index 2) is shot 1 s before the break and 1 s after (window-pov-*.jpg);
// then the free camera, square on to the window, 1 s before the break, 0.15 s after (the chips
// and dust) and 1 s after (window-*.jpg). Every pack entity must find its node
// (no `entities:` warning), and the burst's atlases load only once a window has broken (before
// it no bullet's puff is drawn either, which would load the dust).
//
// "ground": weapons, grenades and kits lying where they fell (GND1). On Nuke, the first round
// whose first death drops a defuse kit: 1 s after that death, in POV on the killer, the page is
// shot (e2e/out/ground-death.jpg) and a kit lies by the dead CT. Then the free camera, still,
// looks at where the victim fell, 1 s after the death (ground-lying.jpg) and 0.5 s after the
// first pickup of what they dropped (ground-picked.jpg): the gun lies there, then is gone, and
// seeking back draws the very frame drawn before. At a few moments of both matches every item
// drawn is one the keys say lies there, and none is missing (e2e/out/ground-counts.json).
//
// "frame rate": on Mirage at 2560×1440 and `high` (saved, so no detection), two views
// (`busiestMoments`): "busiest", in the round with the most smokes and fires burning at once (each
// from its start event to its end event, as the timeline draws them), the moment and the player
// with the most of them in view; and "in-view", the same over the whole match. A player blind
// then or in the next 3 s is passed over. Each is played from 1 s before its moment in POV on
// its player, whose view it was picked for, the scene's fps sampled every 500 ms over 2 s once a
// second of play has filled its window (viewer.spec.ts's figure), each at 60 fps or more
// (e2e/out/fps-<view>-pov.jpg). Then 20 seeks, paused, across the busiest moment of each of
// the five busiest rounds: after the first pass over them (each moment's models and atlases
// loaded), the renderer's textures, geometries and programs never exceed what that pass reached.
//
// Needs the server on 8095 (or DEMOVIEWER_E2E_URL) serving the built web app and the assets with
// the effect atlases and entities.glb, and the ids of an uploaded Mirage and Nuke demo, parsed
// with ENT1, in DEMOVIEWER_E2E_DEMO and DEMOVIEWER_E2E_NUKE.
const demos = {
  mirage: process.env.DEMOVIEWER_E2E_DEMO,
  nuke: process.env.DEMOVIEWER_E2E_NUKE,
};
const OUT = fileURLToPath(new URL('./out/', import.meta.url));

/** Metres per Source unit, and the free camera's speed (m/s) and turn (degrees per pixel). */
const UNIT = 0.0254;
const FLY_SPEED = 8;
const LOOK_DEG_PER_PX = 0.2;
/** Where the camera stands off the fire: metres back and up. */
const BACK_M = 8;
const UP_M = 2;
const SHOTS_S = [0.3, 2, 6];

interface Fire {
  round: number;
  tick: number;
  thrower: number;
  /** Scene metres. */
  x: number;
  y: number;
  z: number;
}

interface Camera {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
}

interface DebugHandle {
  stats: { fps: number; frames: number };
  /** The renderer's GPU memory counts (`Scene.memory`). */
  memory(): { textures: number; geometries: number; programs: number };
  store: {
    getState(): {
      pack: {
        header: {
          tick_rate: number;
          tick_step: number;
          rounds: {
            start_tick: number;
            end_tick: number;
            freeze_end_tick: number;
          }[];
          weapons: string[];
          players: { team_by_round: number[] }[];
        };
        events: {
          tick: number;
          kind: string;
          data: Record<string, number | string>;
        }[];
        rounds: {
          players: {
            x: Int16Array;
            y: Int16Array;
            z: Int16Array;
            yaw: Int16Array;
            health: Uint8Array;
          }[];
        }[];
        entities: { kind: string; x: number; y: number; z: number }[];
        entityChanges: {
          round: number;
          entity: number;
          tick: number;
          yaw: number;
          gone: boolean;
        }[];
        ground: GroundKey[];
      } | null;
      round: number;
      tick: number;
      quality: string;
      play(): void;
      pause(): void;
      seekRound(r: number): void;
      seekTick(t: number): void;
      setFollow(i: number | null): void;
      setCamera(mode: string): void;
    };
  };
  camera(): Camera & { mode: string };
  hullDistance(x: number, y: number, z: number): number | null;
  /** The bullet marks the last frame drew (`BulletMarks.debug`). */
  marks(): {
    round: number;
    tick: number;
    holes: MarkDebug[];
    blood: MarkDebug[];
    puffs: number;
  };
  /** What the last frame drawn posed on the ground (`GroundItems.debug`). */
  ground(): {
    round: number;
    tick: number;
    /** Items hidden for want of a model. */
    waiting: number;
    items: { id: number; weapon: string; x: number; y: number; z: number }[];
  };
}

/** A key of `Pack.ground`. */
interface GroundKey {
  round: number;
  id: number;
  weapon: number;
  tick: number;
  x: number;
  y: number;
  z: number;
  gone: boolean;
}

/** The fire to look at, from the pack's events. */
async function pickFire(page: Page): Promise<Fire> {
  return page.evaluate(
    ({ unit }) => {
      // Runs in the page: nothing from this file is in scope there.
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const rate = pack.header.tick_rate;
      const ends = pack.events.filter(
        (e) => e.kind === 'inferno_expire' || e.kind === 'inferno_extinguish'
      );
      const burns = pack.events.filter((e) => e.kind === 'inferno_startburn');
      // Entity ids come round again: a fire ends at the first end of its id after it starts.
      const long = burns.find((b) => {
        const end = ends.find(
          (e) => e.data.entityid === b.data.entityid && e.tick > b.tick
        );
        return end !== undefined && (end.tick - b.tick) / rate >= 6.5;
      });
      const b = long ?? burns[0];
      const round = pack.header.rounds.findIndex(
        (r) => b.tick >= r.start_tick && b.tick <= r.end_tick
      );
      const [sx, sy, sz] = [b.data.x, b.data.y, b.data.z].map(Number);
      return {
        round,
        tick: b.tick,
        thrower: Number(b.data.user_idx),
        x: sy * unit,
        y: sz * unit,
        z: sx * unit,
      };
    },
    { unit: UNIT }
  );
}

/**
 * Where the camera stands to see `fire`: of 16 bearings and three distances (8, 6 and 4 m), the
 * first spot at least 1 m from the map's hull whose line to the fire keeps 0.25 m clear of it;
 * else the spot with the most room along its line.
 */
async function placeFor(
  page: Page,
  fire: Fire
): Promise<{ x: number; y: number; z: number }> {
  return page.evaluate(
    ({ f, back, up }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const room = (x: number, y: number, z: number) =>
        d.hullDistance(x, y, z) ?? 10;
      let best = { x: f.x, y: f.y + up, z: f.z, clear: -1 };
      for (const m of [back, 6, 4])
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * Math.PI * 2;
          const p = {
            x: f.x + Math.sin(a) * m,
            y: f.y + up,
            z: f.z + Math.cos(a) * m,
          };
          let clear = room(p.x, p.y, p.z) >= 1 ? Infinity : 0;
          for (let i = 1; i < 10 && clear > 0; i++) {
            const t = i / 10;
            clear = Math.min(
              clear,
              room(
                p.x + (f.x - p.x) * t,
                p.y + (f.y + 1 - p.y) * t,
                p.z + (f.z - p.z) * t
              )
            );
          }
          if (clear >= 0.25) return p;
          if (clear > best.clear) best = { ...p, clear };
        }
      return best;
    },
    { f: fire, back: BACK_M, up: UP_M }
  );
}

const camera = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.camera()
  );

/** Turns the free camera to look at (x, y, z) with one right-drag. */
async function face(page: Page, x: number, y: number, z: number) {
  const c = await camera(page);
  const dx = x - c.x;
  const dy = y - c.y;
  const dz = z - c.z;
  const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
  const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
  const dyaw = ((((yaw - c.yaw) % 360) + 540) % 360) - 180;
  const box = (await page.locator('canvas').first().boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(
    cx - dyaw / LOOK_DEG_PER_PX,
    cy + (pitch - c.pitch) / LOOK_DEG_PER_PX
  );
  await page.mouse.up({ button: 'right' });
}

/** Flies the free camera to (x, y, z): faces it and holds W, a few times over. */
async function flyTo(page: Page, x: number, y: number, z: number) {
  for (let i = 0; i < 8; i++) {
    const c = await camera(page);
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    if (d < 0.4) return;
    await face(page, x, y, z);
    // An input, not a wait: W held for 90 % of the flight at FLY_SPEED, short of the spot; the
    // loop reads where the camera got and flies the rest.
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(Math.max(20, (d / FLY_SPEED) * 900));
    await page.keyboard.up('KeyW');
  }
}

for (const [map, demoId] of Object.entries(demos)) {
  test(`molotov: ${map}`, async ({ page }) => {
    test.skip(
      !demos.mirage || !demos.nuke,
      'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> and DEMOVIEWER_E2E_NUKE=<Nuke demo id> with the server running'
    );
    test.setTimeout(180_000);
    const errors = trackErrors(page);
    // The first round, at its freeze end, before any effect of it: nothing under /effects/ is
    // fetched before an effect needs it.
    await openViewer(page, `/d/${demoId}?r=1`);
    await settled(page);
    const opened = await page.evaluate(() => {
      const s = (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState();
      const r = s.pack!.header.rounds[s.round];
      // What draws an effect: a shot, a hit, a grenade going off, a fire.
      const drawing =
        /^(weapon_fire|player_hurt|bullet_damage|\w+_detonate|decoy_started|inferno_startburn)$/;
      return {
        round: s.round,
        tick: s.tick,
        effects: s
          .pack!.events.filter(
            (e) =>
              drawing.test(e.kind) && e.tick >= r.start_tick && e.tick <= s.tick
          )
          .map((e) => `${e.kind}@${e.tick}`),
        fetched: performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.includes('/effects/')),
      };
    });
    expect(opened.round).toBe(0);
    expect(opened.effects).toEqual([]);
    expect(opened.fetched).toEqual([]);
    const fire = await pickFire(page);
    const rate = await page.evaluate(
      () =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.store.getState().pack!.header.tick_rate
    );
    let since = await frames(page);
    await page.evaluate((f) => {
      const s = (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState();
      s.pause();
      s.seekRound(f.round);
    }, fire);
    await settled(page, { since });
    since = await frames(page);
    await page.evaluate((f) => {
      const s = (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState();
      s.setFollow(f.thrower);
      s.seekTick(f.tick + 2);
      s.setCamera('free');
    }, fire);
    await settled(page, { since });
    const at = await placeFor(page, fire);
    await flyTo(page, at.x, at.y, at.z);
    await face(page, fire.x, fire.y + 0.6, fire.z);

    mkdirSync(OUT, { recursive: true });
    for (const s of SHOTS_S) {
      const since = await frames(page);
      await page.evaluate(
        (t) =>
          (
            window as unknown as { __demoviewer: DebugHandle }
          ).__demoviewer.store
            .getState()
            .seekTick(t),
        fire.tick + Math.round(s * rate)
      );
      await settled(page, { since });
      await page.screenshot({
        path: `${OUT}molotov-${map}-${s}.jpg`,
        quality: 85,
      });
    }
    const fetched = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((e) => e.name)
        .filter((n) => n.includes('/effects/'))
    );
    expect(fetched.some((n) => n.includes('/effects/manifest.json'))).toBe(
      true
    );
    expect(fetched.some((n) => n.includes('/effects/fire.webp'))).toBe(true);
    expect(fetched.some((n) => n.includes('/effects/fireburst.webp'))).toBe(
      true
    );
    expect(errors).toEqual([]);
  });
}

/** The first event of `kind` in the pack: its round, tick and where it was (scene metres). */
async function firstEvent(page: Page, kind: string): Promise<Fire> {
  return page.evaluate(
    ({ kind, unit }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const e = pack.events.find((e) => e.kind === kind)!;
      const round = pack.header.rounds.findIndex(
        (r) => e.tick >= r.start_tick && e.tick <= r.end_tick
      );
      const [sx, sy, sz] = [e.data.x, e.data.y, e.data.z].map(Number);
      return {
        round,
        tick: e.tick,
        thrower: Number(e.data.user_idx),
        x: sy * unit,
        y: sz * unit,
        z: sx * unit,
      };
    },
    { kind, unit: UNIT }
  );
}

const UTILITY = {
  smoke: { event: 'smokegrenade_detonate', atlases: ['smoke'] },
  he: { event: 'hegrenade_detonate', atlases: ['explosion', 'smoke'] },
  flash: { event: 'flashbang_detonate', atlases: ['flare'] },
};
const UTILITY_S = [0.1, 0.5, 3];

test('utility', async ({ page }) => {
  test.skip(
    !demos.nuke,
    'set DEMOVIEWER_E2E_NUKE=<Nuke demo id> with the server running'
  );
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });
  await openViewer(page, `/d/${demos.nuke}`);
  const rate = await page.evaluate(
    () =>
      (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState().pack!.header.tick_rate
  );
  for (const [name, u] of Object.entries(UTILITY)) {
    const e = await firstEvent(page, u.event);
    const at = await placeFor(page, e);
    const [dx, dy, dz] = [e.x - at.x, e.y + 1 - at.y, e.z - at.z];
    const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
    const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
    const pose = [at.x, at.y, at.z, yaw, pitch].map((v) => v.toFixed(2));
    await openViewer(
      page,
      `/d/${demos.nuke}?r=${e.round + 1}&t=${e.tick}&cam=free&at=${pose.join(',')}`
    );
    for (const s of UTILITY_S)
      await shoot(page, e.tick + Math.round(s * rate), `${name}-${s}`);
    const fetched = await page.evaluate(() =>
      performance
        .getEntriesByType('resource')
        .map((r) => r.name)
        .filter((n) => n.includes('/effects/'))
    );
    for (const key of u.atlases)
      expect(
        fetched.some((n) => n.includes(`/effects/${key}.webp`)),
        `${name}: ${key}.webp`
      ).toBe(true);
  }
  expect(errors).toEqual([]);
});

const state = (page: Page) =>
  page.evaluate(() => {
    const s = (
      window as unknown as { __demoviewer: DebugHandle }
    ).__demoviewer.store.getState();
    return { tick: s.tick };
  });

/** Opens `url` and waits for the map and the players. */
async function openViewer(page: Page, url: string) {
  await trackLoads(page);
  await page.goto(url);
  await expect(page.getByTestId('viewport')).toHaveAttribute(
    'data-ready',
    'true',
    { timeout: 90_000 }
  );
}

/**
 * Seeks to `tick` of the round shown, waits for the view to settle (what it draws there loaded
 * and drawn: the arms and their clips in POV, an atlas, a weapon) and shoots the page to `name`.
 */
async function shoot(page: Page, tick: number, name: string) {
  const since = await frames(page);
  await page.evaluate(
    (t) =>
      (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.store
        .getState()
        .seekTick(t),
    tick
  );
  await settled(page, { since });
  expect((await state(page)).tick).toBe(tick);
  await page.screenshot({ path: `${OUT}${name}.jpg`, quality: 85 });
}

/** The 3D view alone, as PNG bytes. */
const canvasShot = (page: Page) =>
  page.locator('canvas').first().screenshot({ type: 'png' });

const effectsFetched = (page: Page) =>
  page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => /\/effects\/(debris|dust)\.webp/.test(n))
  );

/** A shot or a hit to look at: the round, the tick and the player seen. */
interface ShotView {
  round: number;
  tick: number;
  player: number;
  /** Where the free camera stands (scene metres) and looks (degrees). */
  at: string;
}

/**
 * The shots and the headshot of "shots", each with a spot for the free camera: 3 m off the
 * player's side and 1 m ahead of them (or 4 m; for a shot, 2 m; either side), at least 0.5 m
 * from the map's hull with 0.2 m clear along its line to the gun (or the head), looking at it.
 * Runs in the page.
 */
const shotMoments = (page: Page) =>
  page.evaluate(
    ({ unit }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const h = pack.header;
      const rate = h.tick_rate;
      const fires = pack.events.filter((e) => e.kind === 'weapon_fire');
      const roundOf = (tick: number) =>
        h.rounds.findIndex(
          (r) => tick >= r.freeze_end_tick && tick <= r.end_tick
        );
      /** Player `p`'s feet at `tick` (scene metres), or null when dead. */
      const feet = (round: number, p: number, tick: number) => {
        const r = h.rounds[round];
        const k = Math.round((tick - r.start_tick) / h.tick_step);
        const t = pack.rounds[round].players[p];
        if (!t || !(t.health[k] > 0)) return null;
        return { x: t.y[k] * unit, y: t.z[k] * unit, z: t.x[k] * unit };
      };
      const room = (x: number, y: number, z: number) =>
        d.hullDistance(x, y, z) ?? 10;
      /** A clear spot `dist` off `target` across `yaw` (degrees, Source), looking at it. */
      const spot = (
        target: { x: number; y: number; z: number },
        yaw: number,
        near = true
      ) => {
        const a = (yaw * Math.PI) / 180;
        const fwd = { x: Math.sin(a), z: Math.cos(a) };
        const tries = [
          [3, 1],
          [4, 1.5],
          [2, 0.5],
        ];
        for (const [dist, ahead] of near ? tries : tries.slice(0, 2))
          for (const side of [1, -1]) {
            const p = {
              x: target.x + fwd.z * side * dist + fwd.x * ahead,
              y: target.y + 0.1,
              z: target.z - fwd.x * side * dist + fwd.z * ahead,
            };
            if (room(p.x, p.y, p.z) < 0.5) continue;
            let clear = Infinity;
            for (let i = 1; i < 10; i++) {
              const t = i / 10;
              clear = Math.min(
                clear,
                room(
                  p.x + (target.x - p.x) * t,
                  p.y + (target.y - p.y) * t,
                  p.z + (target.z - p.z) * t
                )
              );
            }
            if (clear < 0.2) continue;
            const [dx, dy, dz] = [
              target.x - p.x,
              target.y - p.y,
              target.z - p.z,
            ];
            const lookYaw = (Math.atan2(dx, dz) * 180) / Math.PI;
            const pitch =
              (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
            return [p.x, p.y, p.z, lookYaw, pitch, 45]
              .map((v) => v.toFixed(2))
              .join(',');
          }
        return null;
      };
      const aimOf = (tick: number, p: number) =>
        pack.events.find(
          (e) =>
            e.kind === 'fire_bullets' &&
            e.tick === tick &&
            Number(e.data.user_idx) === p
        );
      const shot = (weapon: RegExp): ShotView | null => {
        for (const e of fires) {
          if (!weapon.test(String(e.data.weapon))) continue;
          const p = Number(e.data.user_idx);
          const round = roundOf(e.tick);
          if (round < 0) continue;
          if (
            fires.some(
              (f) =>
                Number(f.data.user_idx) === p &&
                f.tick < e.tick &&
                f.tick >= e.tick - rate / 2
            )
          )
            continue;
          const at = feet(round, p, e.tick);
          const aim = aimOf(e.tick, p);
          if (!at || !aim) continue;
          // The gun, 0.6 m ahead of the chest.
          const yaw = Number(aim.data.angles_y);
          const a = (yaw * Math.PI) / 180;
          const gun = {
            x: at.x + Math.sin(a) * 0.6,
            y: at.y + 1.4,
            z: at.z + Math.cos(a) * 0.6,
          };
          const view = spot(gun, yaw);
          if (view) return { round, tick: e.tick, player: p, at: view };
        }
        return null;
      };
      const headshot = (): ShotView | null => {
        for (const e of pack.events) {
          if (e.kind !== 'player_hurt' || e.data.hitgroup !== 'head') continue;
          const v = Number(e.data.user_idx);
          const a = Number(e.data.attacker_idx);
          const round = roundOf(e.tick);
          if (round < 0) continue;
          const at = feet(round, v, e.tick - 1);
          const from = feet(round, a, e.tick);
          if (!at || !from) continue;
          // Across the line from the attacker: the blood shows towards them.
          const yaw =
            (Math.atan2(from.x - at.x, from.z - at.z) * 180) / Math.PI;
          const view = spot({ x: at.x, y: at.y + 1.65, z: at.z }, yaw, false);
          if (view) return { round, tick: e.tick + 3, player: v, at: view };
        }
        return null;
      };
      return {
        rifle: shot(/^weapon_(ak47|m4a1)$/),
        awp: shot(/^weapon_awp$/),
        pistol: shot(/^weapon_(glock|deagle|p250|fiveseven|tec9|hkp2000)$/),
        headshot: headshot(),
      };
    },
    { unit: UNIT }
  );

test('shots', async ({ page }) => {
  test.skip(
    !demos.mirage,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> with the server running'
  );
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });
  await openViewer(page, `/d/${demos.mirage}`);
  const moments = await shotMoments(page);
  /** What each page load fetched under /effects/ (a load starts the list again). */
  const fetched: string[] = [];
  const effectsSoFar = async () =>
    fetched.push(
      ...(await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.includes('/effects/'))
      ))
    );
  for (const [name, m] of Object.entries(moments)) {
    expect(m, name).toBeTruthy();
    console.log(
      `shots: ${name}: round ${m!.round + 1} tick ${m!.tick} player ${m!.player + 1} at ${m!.at}`
    );
    await openViewer(
      page,
      `/d/${demos.mirage}?r=${m!.round + 1}&t=${m!.tick}&cam=free&at=${m!.at}`
    );
    await shoot(page, m!.tick, `shot-${name}`);
    await effectsSoFar();
  }
  // The rifle shot in POV: the flash at the first-person gun's muzzle.
  const r = moments.rifle!;
  await openViewer(
    page,
    `/d/${demos.mirage}?r=${r.round + 1}&t=${r.tick}&cam=pov&p=${r.player + 1}`
  );
  // The arms and their clips come after the map: the shot waits for them.
  await shoot(page, r.tick, 'shot-pov-rifle');
  await effectsSoFar();
  expect(fetched.some((n) => n.includes('/effects/muzzle.webp'))).toBe(true);
  expect(fetched.some((n) => n.includes('/effects/blood.webp'))).toBe(true);
  expect(errors).toEqual([]);
});

type Vec = [number, number, number];

/** A spray: a player's rifle misses, each within 0.25 s of the last, and each shot's ray. */
interface Spray {
  round: number;
  first: number;
  last: number;
  player: number;
  /** Each shot's eye and aim (scene). */
  shots: { from: Vec; dir: Vec }[];
}

/** A wallbang kill: the shot's eye and the bullet's direction (scene), metres to the victim. */
interface Wallbang {
  round: number;
  tick: number;
  attacker: number;
  victim: number;
  from: Vec;
  dir: Vec;
  metres: number;
}

/**
 * The match's first 40 sprays of 6 or more rifle misses (a `weapon_fire` with its `fire_bullets`
 * and no `bullet_damage`), and its wallbang kills (a `player_death` with `penetrated`, whose
 * shot's `bullet_damage` went through walls). Runs in the page.
 */
const impactMoments = (page: Page) =>
  page.evaluate(
    ({ unit }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const h = pack.header;
      const rate = h.tick_rate;
      const roundOf = (tick: number) =>
        h.rounds.findIndex(
          (r) => tick >= r.freeze_end_tick && tick <= r.end_tick
        );
      type Ev = (typeof pack.events)[number];
      type V = [number, number, number];
      const eyeOf = (f: Ev): V => [
        Number(f.data.origin_y) * unit,
        Number(f.data.origin_z) * unit,
        Number(f.data.origin_x) * unit,
      ];
      const aims = new Map<string, Ev>();
      const struck = new Map<string, Ev>();
      for (const e of pack.events) {
        if (e.kind === 'fire_bullets')
          aims.set(`${e.tick}:${e.data.user_idx}`, e);
        else if (e.kind === 'bullet_damage')
          struck.set(`${e.tick}:${e.data.attacker_idx}`, e);
      }
      const rifle =
        /^weapon_(ak47|m4a1|m4a1_silencer|galilar|famas|sg556|aug)$/;
      const sprays: Spray[] = [];
      const open = new Map<number, Spray>();
      for (const e of pack.events) {
        const k = `${e.tick}:${e.data.user_idx}`;
        if (e.kind !== 'weapon_fire' || !rifle.test(String(e.data.weapon)))
          continue;
        if (!aims.has(k) || struck.has(k)) continue;
        const p = Number(e.data.user_idx);
        const round = roundOf(e.tick);
        const f = aims.get(k)!;
        // The aim (degrees, recoil in it) as the scene's direction (`viewDir`).
        const yaw = (Number(f.data.angles_y) * Math.PI) / 180;
        const pitch = (-Number(f.data.angles_x) * Math.PI) / 180;
        const shot = {
          from: eyeOf(f),
          dir: [
            Math.cos(pitch) * Math.sin(yaw),
            Math.sin(pitch),
            Math.cos(pitch) * Math.cos(yaw),
          ] as V,
        };
        const s = open.get(p);
        if (s && s.round === round && e.tick - s.last <= rate * 0.25) {
          s.last = e.tick;
          s.shots.push(shot);
        } else {
          const n = {
            round,
            first: e.tick,
            last: e.tick,
            player: p,
            shots: [shot],
          };
          open.set(p, n);
          sprays.push(n);
        }
      }
      const wallbangs: Wallbang[] = [];
      for (const e of pack.events) {
        if (e.kind !== 'player_death' || !(Number(e.data.penetrated) > 0))
          continue;
        const a = Number(e.data.attacker_idx);
        const b = struck.get(`${e.tick}:${a}`);
        const f = aims.get(`${e.tick}:${a}`);
        const round = roundOf(e.tick);
        if (!b || !f || round < 0 || !(Number(b.data.num_penetrations) > 0))
          continue;
        const n = (k: string) => Number(b.data[k]);
        const dir: V = [
          n('damage_dir_y'),
          n('damage_dir_z'),
          n('damage_dir_x'),
        ];
        const len = Math.hypot(...dir);
        wallbangs.push({
          round,
          tick: e.tick,
          attacker: a,
          victim: Number(e.data.user_idx),
          from: eyeOf(f),
          dir: dir.map((c) => c / len) as V,
          metres: n('distance') * unit,
        });
      }
      return {
        sprays: sprays
          .filter((s) => s.round >= 0 && s.shots.length >= 6)
          .slice(0, 40),
        wallbangs,
      };
    },
    { unit: UNIT }
  );

const marksDrawn = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.marks()
  );

/**
 * Where along the ray `from` + `dir`·t (scene, `dir` unit) the point `p` lies, and how far off
 * the ray it is.
 */
function alongRay(p: { x: number; y: number; z: number }, from: Vec, dir: Vec) {
  const v = [p.x - from[0], p.y - from[1], p.z - from[2]];
  const t = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
  const off = Math.hypot(
    v[0] - dir[0] * t,
    v[1] - dir[1] * t,
    v[2] - dir[2] * t
  );
  return { t, off };
}

/** The free camera's `at` standing at `eye` (scene) looking at `p`. */
function looking(eye: Vec, p: { x: number; y: number; z: number }): string {
  const [dx, dy, dz] = [p.x - eye[0], p.y - eye[1], p.z - eye[2]];
  const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
  const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
  return [...eye, yaw, pitch].map((v) => v.toFixed(2)).join(',');
}

/** `p` moved `k` metres along unit `dir`. */
const moved = (p: { x: number; y: number; z: number }, dir: Vec, k: number) =>
  [p.x + dir[0] * k, p.y + dir[1] * k, p.z + dir[2] * k] as Vec;

test('impacts', async ({ page }) => {
  test.skip(
    !demos.mirage,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> with the server running'
  );
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });
  await openViewer(page, `/d/${demos.mirage}`);
  const { sprays, wallbangs } = await impactMoments(page);
  expect(sprays.length).toBeGreaterThan(0);
  expect(wallbangs.length).toBeGreaterThan(0);
  /** What each page load fetched under /effects/ (a load starts the list again). */
  const fetched: string[] = [];
  const effectsSoFar = async () =>
    fetched.push(
      ...(await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((e) => e.name)
          .filter((n) => n.includes('/effects/'))
      ))
    );

  // Which surface a hole is, by its frame of the decals atlas (`DECAL_SEQUENCE`).
  const sequences = await page.evaluate(async () => {
    const m = await (await fetch('/effects/manifest.json')).json();
    return m.atlases.decals.sequences as [number, number][];
  });
  const surfaceOf = (frame: number) =>
    ['stone', 'metal', 'wood', 'glass', 'blood'][
      sequences.findIndex(([first, n]) => frame >= first && frame < first + n)
    ] ?? 'none';

  // A spray on wood (Mirage's doors) and one on stone (its sandstone walls): the first of each
  // whose own holes (on its shots' lines) land together within 20 m.
  const found = new Map<string, { spray: Spray; holes: MarkDebug[] }>();
  for (const s of sprays) {
    if (found.size === 2) break;
    await seekTo(page, s.round, s.last + 6);
    const m = await marksDrawn(page);
    const own = m.holes.filter((h) =>
      s.shots.some((shot) => {
        const r = alongRay(h, shot.from, shot.dir);
        return r.off < 0.05 && r.t > 0 && r.t < 20;
      })
    );
    let taken = '';
    for (const c of own) {
      const kind = surfaceOf(c.frame);
      if ((kind !== 'wood' && kind !== 'stone') || found.has(kind)) continue;
      // On a wall (its normal level), not the floor.
      const near = own.filter(
        (o) =>
          surfaceOf(o.frame) === kind &&
          Math.abs(o.ny) < 0.5 &&
          Math.hypot(o.x - c.x, o.y - c.y, o.z - c.z) < 1.5
      );
      if (near.length >= 5) {
        found.set(kind, { spray: s, holes: near });
        taken = kind;
        break;
      }
    }
    console.log(
      `impacts: spray of player ${s.player + 1} round ${s.round + 1} ticks ${s.first}–${s.last} (${s.shots.length} shots): ${m.holes.length} holes drawn, ${own.length} of its own within 20 m (${[...new Set(own.map((o) => surfaceOf(o.frame)))].join(', ')})${taken ? `, taken for ${taken}` : ''}`
    );
  }
  expect([...found.keys()].sort()).toEqual(['stone', 'wood']);
  for (const [kind, { spray: sp, holes }] of found) {
    await openViewer(
      page,
      `/d/${demos.mirage}?r=${sp.round + 1}&t=${sp.last + 6}&cam=pov&p=${sp.player + 1}`
    );
    await shoot(page, sp.last + 6, `impacts-spray-${kind}-pov`);
    // 2.5 m back from the middle of the holes towards the shooter's eye.
    const mid = { x: 0, y: 0, z: 0 };
    for (const h of holes) {
      mid.x += h.x / holes.length;
      mid.y += h.y / holes.length;
      mid.z += h.z / holes.length;
    }
    const eye = sp.shots[sp.shots.length - 1].from;
    const back = [eye[0] - mid.x, eye[1] - mid.y, eye[2] - mid.z];
    const room = Math.hypot(...back);
    const at = looking(
      moved(mid, back.map((c) => c / room) as Vec, Math.min(2.5, room * 0.8)),
      mid
    );
    console.log(
      `impacts: ${kind}: ${holes.length} holes ${room.toFixed(1)} m from the shooter, seen from ${at}`
    );
    await openViewer(
      page,
      `/d/${demos.mirage}?r=${sp.round + 1}&t=${sp.last + 6}&cam=free&at=${at}`
    );
    await shoot(page, sp.last + 6, `impacts-spray-${kind}`);
    await effectsSoFar();
    const isSprayHole = (o: MarkDebug) =>
      holes.some((h) => Math.hypot(o.x - h.x, o.y - h.y, o.z - h.z) < 1e-3);
    const shown = await marksDrawn(page);
    expect(shown.holes.filter(isSprayHole).length).toBe(holes.length);
    expect(shown.puffs).toBeGreaterThan(0);
    await shoot(page, sp.last + 3 * 64, `impacts-spray-${kind}-3s`);
    expect((await marksDrawn(page)).holes.filter(isSprayHole).length).toBe(
      holes.length
    );
    const end = await page.evaluate(
      (r) =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.store.getState().pack!.header.rounds[r].end_tick,
      sp.round
    );
    // And from where the shooter stood (a metre on, out of their model), as far off: the holes
    // stay on the wall, with no fighting with it at that distance.
    const ahead = moved(
      { x: eye[0], y: eye[1], z: eye[2] },
      back.map((c) => -c / room) as Vec,
      1
    );
    await openViewer(
      page,
      `/d/${demos.mirage}?r=${sp.round + 1}&t=${sp.last + 3 * 64}&cam=free&at=${looking(ahead, mid)}`
    );
    await shoot(page, sp.last + 3 * 64, `impacts-spray-${kind}-far-3s`);
    if (sp.last + 13 * 64 <= end) {
      await seekTo(page, sp.round, sp.last + 13 * 64);
      expect((await marksDrawn(page)).holes.filter(isSprayHole)).toEqual([]);
    }
  }
  expect(fetched.some((n) => n.includes('/effects/decals.webp'))).toBe(true);
  expect(fetched.some((n) => n.includes('/effects/dust.webp'))).toBe(true);

  // The wallbang kill: the first whose bullet's line meets a hole.
  let bang: Wallbang | null = null;
  let through: { o: MarkDebug; t: number }[] = [];
  for (const w of wallbangs) {
    await seekTo(page, w.round, w.tick + 6);
    const m = await marksDrawn(page);
    // Along the bullet, short of the victim, within 5 cm of its line.
    const on = m.holes
      .map((o) => ({ o, ...alongRay(o, w.from, w.dir) }))
      .filter((c) => c.off < 0.05 && c.t > 0 && c.t < w.metres)
      .sort((a, b) => a.t - b.t);
    console.log(
      `impacts: wallbang of player ${w.victim + 1} by ${w.attacker + 1}, round ${w.round + 1} tick ${w.tick}, ${w.metres.toFixed(1)} m: ${on.length} hole(s) on its line at ${on.map((c) => c.t.toFixed(2)).join(', ')} m`
    );
    if (on.length > 0) {
      bang = w;
      through = on;
      break;
    }
  }
  expect(bang, 'a wallbang kill whose line meets a hole').toBeTruthy();
  const wb = bang!;
  await openViewer(
    page,
    `/d/${demos.mirage}?r=${wb.round + 1}&t=${wb.tick + 6}&cam=pov&p=${wb.attacker + 1}`
  );
  await shoot(page, wb.tick + 6, 'impacts-wallbang-pov');
  // On the bullet's line: back from the way in towards the killer, on from the way out towards
  // the victim (short of them), each looking at its hole.
  const first = through[0];
  const last = through[through.length - 1];
  const towardsKiller: Vec = [-wb.dir[0], -wb.dir[1], -wb.dir[2]];
  const views = [
    [
      'in',
      looking(
        moved(first.o, towardsKiller, Math.min(2.5, first.t * 0.8)),
        first.o
      ),
    ],
    [
      'out',
      looking(
        moved(
          last.o,
          wb.dir,
          Math.max(0.5, Math.min(2.5, wb.metres - last.t - 0.4))
        ),
        last.o
      ),
    ],
  ] as const;
  for (const [name, spot] of views) {
    console.log(`impacts: wallbang ${name} seen from ${spot}`);
    await openViewer(
      page,
      `/d/${demos.mirage}?r=${wb.round + 1}&t=${wb.tick + 6}&cam=free&at=${spot}`
    );
    await shoot(page, wb.tick + 6, `impacts-wallbang-${name}`);
  }
  expect(errors).toEqual([]);
});

/** Shots of one player into a smoke: each a miss whose line meets the smoke's middle. */
interface SmokedBurst {
  round: number;
  player: number;
  ticks: number[];
  /** The last shot's eye and aim (scene). */
  from: Vec;
  dir: Vec;
  /** The smoke's middle (scene, `SMOKE.lift` over its grenade) and its radius. */
  smoke: Vec;
  radius: number;
}

/**
 * The match's first burst of rifle misses (each within 0.25 s of the last) fired into a smoke
 * grown full and not yet fading (0.7 s after it goes off, 2 s before it ends): each shot's line
 * passes within 1.5 m of the smoke's middle 5–15 m out, so the wall it marks is behind the
 * smoke and the shooter outside it. The longest of the first 20 found. Runs in the page.
 */
const smokedBurst = (page: Page) =>
  page.evaluate(
    ({ unit }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const h = pack.header;
      const rate = h.tick_rate;
      // SMOKE.radius and SMOKE.lift (utility.ts).
      const radius = 3.66;
      const lift = 1.2;
      type V = [number, number, number];
      const roundOf = (tick: number) =>
        h.rounds.findIndex(
          (r) => tick >= r.freeze_end_tick && tick <= r.end_tick
        );
      const smokes: { start: number; end: number; c: V }[] = [];
      for (const e of pack.events) {
        if (e.kind !== 'smokegrenade_detonate') continue;
        const end = pack.events.find(
          (x) =>
            x.kind === 'smokegrenade_expired' &&
            x.data.entityid === e.data.entityid &&
            x.tick > e.tick
        );
        if (!end) continue;
        smokes.push({
          start: e.tick,
          end: end.tick,
          c: [
            Number(e.data.y) * unit,
            Number(e.data.z) * unit + lift,
            Number(e.data.x) * unit,
          ],
        });
      }
      const aims = new Map<string, (typeof pack.events)[number]>();
      const struck = new Set<string>();
      for (const e of pack.events) {
        if (e.kind === 'fire_bullets')
          aims.set(`${e.tick}:${e.data.user_idx}`, e);
        else if (e.kind === 'bullet_damage')
          struck.add(`${e.tick}:${e.data.attacker_idx}`);
      }
      const rifle =
        /^weapon_(ak47|m4a1|m4a1_silencer|galilar|famas|sg556|aug)$/;
      const bursts: SmokedBurst[] = [];
      let open: SmokedBurst | null = null;
      for (const e of pack.events) {
        const k = `${e.tick}:${e.data.user_idx}`;
        if (e.kind !== 'weapon_fire' || !rifle.test(String(e.data.weapon)))
          continue;
        const f = aims.get(k);
        if (!f || struck.has(k)) continue;
        const from: V = [
          Number(f.data.origin_y) * unit,
          Number(f.data.origin_z) * unit,
          Number(f.data.origin_x) * unit,
        ];
        const yaw = (Number(f.data.angles_y) * Math.PI) / 180;
        const pitch = (-Number(f.data.angles_x) * Math.PI) / 180;
        const dir: V = [
          Math.cos(pitch) * Math.sin(yaw),
          Math.sin(pitch),
          Math.cos(pitch) * Math.cos(yaw),
        ];
        const smoke = smokes.find((m) => {
          if (e.tick < m.start + 0.7 * rate || e.tick > m.end - 2 * rate)
            return false;
          const v = m.c.map((c, i) => c - from[i]);
          const t = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
          const off = Math.hypot(...v.map((c, i) => c - dir[i] * t));
          return t >= 5 && t <= 15 && off < 1.5;
        });
        if (!smoke) continue;
        const p = Number(e.data.user_idx);
        const round = roundOf(e.tick);
        if (round < 0) continue;
        if (
          open &&
          open.player === p &&
          open.round === round &&
          open.smoke === smoke.c &&
          e.tick - open.ticks[open.ticks.length - 1] <= 0.25 * rate
        ) {
          open.ticks.push(e.tick);
          open.from = from;
          open.dir = dir;
        } else {
          open = {
            round,
            player: p,
            ticks: [e.tick],
            from,
            dir,
            smoke: smoke.c,
            radius,
          };
          bursts.push(open);
          if (bursts.length > 20) break;
        }
      }
      return bursts.sort((a, b) => b.ticks.length - a.ticks.length)[0] ?? null;
    },
    { unit: UNIT }
  );

test('smoke cover', async ({ page }) => {
  test.skip(
    !demos.mirage,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> with the server running'
  );
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });
  await openViewer(page, `/d/${demos.mirage}`);
  const b = await smokedBurst(page);
  expect(b, 'a burst of misses fired into a smoke').toBeTruthy();
  const last = b!.ticks[b!.ticks.length - 1];
  const url = (tick: number, cam: string) =>
    `/d/${demos.mirage}?r=${b!.round + 1}&t=${tick}&${cam}`;
  console.log(
    `smoke cover: player ${b!.player + 1}, round ${b!.round + 1}, ${b!.ticks.length} misses into the smoke at (${b!.smoke.map((c) => c.toFixed(1)).join(', ')}), ticks ${b!.ticks[0]}–${last}`
  );
  // In POV on the shooter as their last shot leaves: their own flash at the gun, in front of
  // the smoke; the puffs of the shots before it on the wall behind the smoke.
  await openViewer(page, url(last + 1, `cam=pov&p=${b!.player + 1}`));
  await shoot(page, last + 1, 'smoke-cover-pov');
  // 2.5 m back from the shooter, a little up, looking at the smoke: the flash in front of it,
  // the marks behind it.
  const flat = Math.hypot(b!.dir[0], b!.dir[2]);
  const back: Vec = [-b!.dir[0] / flat, 0, -b!.dir[2] / flat];
  const room = async (p: Vec) =>
    page.evaluate(
      ([x, y, z]) =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.hullDistance(x, y, z) ?? 10,
      p
    );
  // Back and a little to one side, so the shooter does not stand in the way: of 2.5 and 1.5 m
  // back, 1.2 m to either side, the first with room.
  const side: Vec = [-back[2], 0, back[0]];
  let behind: Vec = moved(
    { x: b!.from[0], y: b!.from[1] + 0.3, z: b!.from[2] },
    back,
    1.5
  );
  search: for (const k of [2.5, 1.5])
    for (const s of [1.2, -1.2]) {
      const p = moved(
        { x: b!.from[0], y: b!.from[1] + 0.3, z: b!.from[2] },
        [back[0] * k + side[0] * s, 0, back[2] * k + side[2] * s],
        1
      );
      if ((await room(p)) >= 0.3) {
        behind = p;
        break search;
      }
    }
  const smokeAt = { x: b!.smoke[0], y: b!.smoke[1], z: b!.smoke[2] };
  await openViewer(
    page,
    url(last + 1, `cam=free&at=${looking(behind, smokeAt)}`)
  );
  await shoot(page, last + 1, 'smoke-cover-behind');
  await shoot(page, last + 6, 'smoke-cover-behind-0.1s');
  // Across the smoke, looking back at the shooter through it: their flash behind the smoke.
  // Of bearings within 40° of the shot's way, 2–4 m past the smoke's edge at its middle's
  // height, the first with room and a clear line to the shooter but for the smoke.
  const across = await page.evaluate(
    ({ c, r, from, back }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const free = (x: number, y: number, z: number) =>
        d.hullDistance(x, y, z) ?? 10;
      const base = Math.atan2(-back[0], -back[2]);
      for (const m of [2.5, 3.5, 2])
        for (const deg of [0, 10, -10, 20, -20, 30, -30, 40, -40]) {
          const a = base + (deg * Math.PI) / 180;
          const p = [
            c[0] + Math.sin(a) * (r + m),
            c[1] + 0.4,
            c[2] + Math.cos(a) * (r + m),
          ];
          if (free(p[0], p[1], p[2]) < 0.5) continue;
          let clear = true;
          for (let i = 1; i < 20 && clear; i++) {
            const t = i / 20;
            clear =
              free(
                p[0] + (from[0] - p[0]) * t,
                p[1] + (from[1] - p[1]) * t,
                p[2] + (from[2] - p[2]) * t
              ) >= 0.1;
          }
          if (clear) return p as [number, number, number];
        }
      return null;
    },
    { c: b!.smoke, r: b!.radius, from: b!.from, back }
  );
  console.log(
    `smoke cover: behind at ${behind.map((c) => c.toFixed(2)).join(', ')}; across ${across ? across.map((c) => c.toFixed(2)).join(', ') : 'none with a clear line'}`
  );
  if (across) {
    await openViewer(
      page,
      url(
        last + 1,
        `cam=free&at=${looking(across, { x: b!.from[0], y: b!.from[1], z: b!.from[2] })}`
      )
    );
    await shoot(page, last + 1, 'smoke-cover-across');
  }
  expect(errors).toEqual([]);
});

test('doors', async ({ page }) => {
  test.skip(
    !demos.mirage || !demos.nuke,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> and DEMOVIEWER_E2E_NUKE=<Nuke demo id> with the server running'
  );
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning') warnings.push(m.text());
  });
  mkdirSync(OUT, { recursive: true });

  // Nuke: the first swing of the match that does not start with a round.
  await openViewer(page, `/d/${demos.nuke}`);
  const swing = await firstDoorSwing(page);
  const doorAt = await faceOn(page, swing.at);
  // The 3D view alone (`hud=0`): the shots compare the scene's pixels, and the HUD over it can
  // be rastered otherwise on coming back to the same paused tick (see 'ground').
  await openViewer(
    page,
    `/d/${demos.nuke}?r=${swing.round + 1}&t=${swing.tick}&cam=free&at=${doorAt}&hud=0`
  );
  await shoot(page, swing.tick - Math.round(0.2 * swing.rate), 'door-before');
  const before = await canvasShot(page);
  await shoot(page, swing.mid, 'door-mid');
  const mid = await canvasShot(page);
  await shoot(page, swing.tick + swing.rate, 'door-after');
  const after = await canvasShot(page);
  // The door moves: closed, half open and open are three different frames.
  expect(Buffer.compare(before, mid), 'before and mid-swing').not.toBe(0);
  expect(Buffer.compare(mid, after), 'mid-swing and after').not.toBe(0);
  expect(Buffer.compare(before, after), 'before and after').not.toBe(0);
  // Back to mid-swing from after it: the very frame playing forwards drew.
  await shoot(page, swing.mid, 'door-mid-again');
  expect(Buffer.compare(await canvasShot(page), mid)).toBe(0);
  const nukeFiles = await page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => e.name)
  );
  expect(nukeFiles.some((n) => n.includes('/maps/de_nuke/entities.glb'))).toBe(
    true
  );

  // Mirage: the window that breaks in round 3 (index 2), first from the player nearest it.
  await openViewer(page, `/d/${demos.mirage}`);
  test.skip(
    await page.evaluate(
      () =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.store.getState().pack!.entityChanges.length === 0
    ),
    'the Mirage demo was parsed without ENT1 (a pack from before the doors): upload it again to a server that writes ENT1'
  );
  const since = await frames(page);
  const brk = await page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: DebugHandle }).__demoviewer;
    const s = d.store.getState();
    const pack = s.pack!;
    const c = pack.entityChanges.find((c) => c.round === 2 && c.gone)!;
    const e = pack.entities[c.entity];
    const r = pack.header.rounds[c.round];
    const k = Math.round((c.tick - r.start_tick) / pack.header.tick_step);
    let nearest = 0;
    let best = Infinity;
    pack.rounds[c.round].players.forEach((t, i) => {
      if (!(t.health[k] > 0)) return;
      const dist = Math.hypot(t.x[k] - e.x, t.y[k] - e.y, t.z[k] - e.z);
      if (dist < best) {
        best = dist;
        nearest = i;
      }
    });
    s.pause();
    s.seekRound(c.round);
    // The pane lies along the window's yaw (its angles ride on the break's key).
    const yaw = (c.yaw / 100) * (Math.PI / 180);
    return {
      round: c.round,
      tick: c.tick,
      player: nearest,
      rate: pack.header.tick_rate,
      at: {
        x: e.x,
        y: e.y,
        z: e.z,
        nx: -Math.sin(yaw),
        ny: Math.cos(yaw),
        side: 1,
      },
    };
  });
  expect(brk.tick).toBe(12933);
  await settled(page, { since });
  await page.evaluate((p) => {
    const s = (
      window as unknown as { __demoviewer: DebugHandle }
    ).__demoviewer.store.getState();
    s.setFollow(p);
    s.setCamera('pov');
  }, brk.player);
  await shoot(page, brk.tick - brk.rate, 'window-pov-before');
  // No bullet's puff (its dust, `bulletmarks.ts`) drawn then either, so the dust is the window's.
  expect((await marksDrawn(page)).puffs).toBe(0);
  expect(await effectsFetched(page)).toEqual([]);
  await shoot(page, brk.tick + brk.rate, 'window-pov-after');

  // Then square on to the window, where the chips and dust show.
  const windowAt = await faceOn(page, brk.at);
  await openViewer(
    page,
    `/d/${demos.mirage}?r=${brk.round + 1}&t=${brk.tick - brk.rate}&cam=free&at=${windowAt}`
  );
  await shoot(page, brk.tick - brk.rate, 'window-before');
  expect((await marksDrawn(page)).puffs).toBe(0);
  expect(await effectsFetched(page)).toEqual([]);
  await shoot(page, brk.tick + Math.round(0.15 * brk.rate), 'window-burst');
  await shoot(page, brk.tick + brk.rate, 'window-after');
  const fetched = await effectsFetched(page);
  expect(fetched.some((n) => n.includes('/effects/debris.webp'))).toBe(true);
  expect(fetched.some((n) => n.includes('/effects/dust.webp'))).toBe(true);

  expect(warnings.filter((w) => w.startsWith('entities:'))).toEqual([]);
  expect(errors).toEqual([]);
});

/**
 * The ids of the items the keys of round `round` lay on the ground at `tick`: an item's latest
 * key at or before `tick` is a pose, not a pickup. Runs in the page.
 */
const lyingIds = (page: Page, round: number, tick: number) =>
  page.evaluate(
    ({ round, tick }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const latest = new Map<number, GroundKey>();
      for (const g of d.store.getState().pack!.ground)
        if (g.round === round && g.tick <= tick) latest.set(g.id, g);
      return [...latest.values()]
        .filter((g) => !g.gone)
        .map((g) => g.id)
        .sort((a, b) => a - b);
    },
    { round, tick }
  );

const drawnGround = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.ground()
        .items
  );

/**
 * Seeks to `tick` of round `round` and waits for a drawn frame of it: the ground the last
 * frame posed is at that round and tick, with no item still waiting for its model (one whose
 * model failed, such as a missing defuser.glb, waits for nothing and is simply not drawn). Fails
 * after 30 s naming the frame asked for and the one last posed.
 */
async function seekTo(page: Page, round: number, tick: number) {
  await page.evaluate(
    ({ round, tick }) => {
      const s = (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.store.getState();
      s.seekRound(round);
      s.seekTick(tick);
    },
    { round, tick }
  );
  try {
    await page.waitForFunction(
      ({ round, tick }) => {
        const g = (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.ground();
        return g.round === round && g.tick === tick && g.waiting === 0;
      },
      { round, tick },
      { timeout: 30_000 }
    );
  } catch (e) {
    const g = await page.evaluate(() => {
      const { round, tick, waiting } = (
        window as unknown as { __demoviewer: DebugHandle }
      ).__demoviewer.ground();
      return { round, tick, waiting };
    });
    throw new Error(
      `no frame of round ${round} tick ${tick} drawn in 30 s: the ground last posed round ${g.round} tick ${g.tick}, ${g.waiting} item(s) waiting for a model (${e instanceof Error ? e.message.split('\n')[0] : String(e)})`
    );
  }
}

/**
 * At 1 s after each round's first death and at its end, for every fourth round: how many items
 * lie on the ground by the keys, and the ids drawn, which must be the same (the pool holds 48).
 */
async function groundCounts(page: Page) {
  const rounds = await page.evaluate(() => {
    const pack = (
      window as unknown as { __demoviewer: DebugHandle }
    ).__demoviewer.store.getState().pack!;
    const rate = pack.header.tick_rate;
    return pack.header.rounds.map((r) => {
      const death = pack.events.find(
        (e) =>
          e.kind === 'player_death' &&
          e.tick >= r.start_tick &&
          e.tick <= r.end_tick
      );
      return [death ? death.tick + rate : r.freeze_end_tick, r.end_tick];
    });
  });
  const counts: {
    round: number;
    tick: number;
    lying: number;
    drawn: number;
  }[] = [];
  for (let r = 0; r < rounds.length; r += 4)
    for (const tick of rounds[r]) {
      await seekTo(page, r, tick);
      const lying = await lyingIds(page, r, tick);
      const drawn = (await drawnGround(page))
        .map((g) => g.id)
        .sort((a, b) => a - b);
      expect(lying.length).toBeLessThanOrEqual(48);
      expect(drawn, `round ${r} tick ${tick}`).toEqual(lying);
      counts.push({ round: r, tick, lying: lying.length, drawn: drawn.length });
    }
  return counts;
}

test('ground', async ({ page }) => {
  test.skip(
    !demos.mirage || !demos.nuke,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> and DEMOVIEWER_E2E_NUKE=<Nuke demo id> with the server running'
  );
  test.setTimeout(300_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });

  // Nuke: the first round whose first death drops a kit.
  await openViewer(page, `/d/${demos.nuke}`);
  const since = await frames(page);
  const fall = await page.evaluate(() => {
    const d = (window as unknown as { __demoviewer: DebugHandle }).__demoviewer;
    const s = d.store.getState();
    const pack = s.pack!;
    const h = pack.header;
    for (let r = 0; r < h.rounds.length; r++) {
      const round = h.rounds[r];
      const death = pack.events.find(
        (e) =>
          e.kind === 'player_death' &&
          e.tick >= round.start_tick &&
          e.tick <= round.end_tick
      );
      if (!death) continue;
      const victim = Number(death.data.user_idx);
      const k = Math.round((death.tick - round.start_tick) / h.tick_step);
      const t = pack.rounds[r].players[victim];
      const at = { x: t.x[k], y: t.y[k], z: t.z[k] };
      // What the victim dropped: items first put down within 1 s and 128 units of the death.
      const dropped = pack.ground.filter(
        (g, i) =>
          g.round === r &&
          !g.gone &&
          (i === 0 ||
            pack.ground[i - 1].id !== g.id ||
            pack.ground[i - 1].round !== r) &&
          g.tick >= death.tick &&
          g.tick <= death.tick + h.tick_rate &&
          Math.hypot(g.x - at.x, g.y - at.y) < 128
      );
      const kit = dropped.find((g) => h.weapons[g.weapon] === 'defuser');
      if (!kit) continue;
      const pickup = pack.ground.find(
        (g) =>
          g.round === r &&
          g.gone &&
          g.tick > death.tick + h.tick_rate &&
          dropped.some((x) => x.id === g.id && x !== kit)
      );
      s.pause();
      s.seekRound(r);
      return {
        round: r,
        tick: death.tick,
        rate: h.tick_rate,
        killer: Number(death.data.attacker_idx),
        victimTeam: h.players[victim].team_by_round[r],
        victimHealth: t.health[k + Math.round(h.tick_rate / h.tick_step)],
        at,
        kit: { id: kit.id, x: kit.x, y: kit.y, z: kit.z },
        pickup: pickup
          ? {
              id: pickup.id,
              tick: pickup.tick,
              weapon: h.weapons[pickup.weapon],
            }
          : null,
      };
    }
    return null;
  });
  expect(fall).not.toBeNull();
  const f = fall!;
  expect(f.victimTeam).toBe(3);
  expect(f.victimHealth).toBe(0);
  expect(f.pickup).not.toBeNull();
  const pickup = f.pickup!;
  await settled(page, { since });
  await page.evaluate((killer) => {
    const s = (
      window as unknown as { __demoviewer: DebugHandle }
    ).__demoviewer.store.getState();
    s.setFollow(killer);
    s.setCamera('pov');
  }, f.killer);
  await shoot(page, f.tick + f.rate, 'ground-death');
  const kits = (await drawnGround(page)).filter(
    (g) => g.weapon === 'defuser' && g.id === f.kit.id
  );
  expect(kits).toHaveLength(1);
  expect(Math.hypot(kits[0].x - f.at.x, kits[0].y - f.at.y)).toBeLessThan(128);

  // The free camera, still, on where the victim fell, with the 3D view alone (`hud=0`): the
  // shots below compare the scene's pixels, and the HUD over it is not the same pixels at the
  // same tick. Its killfeed row slides in as the page opens (a composited animation), and that
  // can leave a few of the HUD's anti-aliased edges rastered otherwise than the same HUD drawn
  // at rest: Chromium chooses MSAA or not for each raster from what the HUD's layer holds then,
  // and keeps a raster until that part of the page changes. Coming back to the tick draws them
  // at rest, so with the HUD the same paused frame differed in 35 edge pixels by up to 9 levels
  // (19 of 64 runs alone, 6 of 10 on an idle machine; none of 20 with the slide-in off or with
  // MSAA raster off).
  const spot = await lookDownAt(page, f.at);
  await openViewer(
    page,
    `/d/${demos.nuke}?r=${f.round + 1}&t=${f.tick + f.rate}&cam=free&at=${spot}&hud=0`
  );
  await shoot(page, f.tick + f.rate, 'ground-lying');
  const lying = await canvasShot(page);
  const before = await drawnGround(page);
  expect(before.map((g) => g.id)).toContain(pickup.id);
  expect(before.map((g) => g.id)).toContain(f.kit.id);
  await shoot(page, pickup.tick + Math.round(f.rate / 2), 'ground-picked');
  const after = await drawnGround(page);
  expect(after.map((g) => g.id)).not.toContain(pickup.id);
  expect(after.map((g) => g.id)).toContain(f.kit.id);
  // Back to before the pickup: the very frame drawn then.
  await shoot(page, f.tick + f.rate, 'ground-lying-again');
  expect(await drawnGround(page)).toEqual(before);
  expect(Buffer.compare(await canvasShot(page), lying)).toBe(0);

  const counts: Record<string, unknown> = {
    nuke: { fall: f, counts: await groundCounts(page) },
  };
  await openViewer(page, `/d/${demos.mirage}`);
  counts.mirage = { counts: await groundCounts(page) };
  writeFileSync(`${OUT}ground-counts.json`, JSON.stringify(counts, null, 2));
  expect(errors).toEqual([]);
});

/** A round's busiest moment: its tick, and the smokes and fires burning then. */
interface Moment {
  round: number;
  tick: number;
  smokes: number;
  fires: number;
}

/** Where the frame rate is measured: a moment, whom to follow, and what they have in view. */
interface View {
  round: number;
  tick: number;
  player: number;
  burning: number;
  seen: number;
}

/**
 * The busiest moment of each round (the most smokes and fires burning at once, the earliest of
 * equals), the `n` busiest rounds first; and two views to measure, in the busiest round
 * (`busiest`) and in the whole match (`in-view`): of the ticks at each smoke's or fire's start and
 * 1, 2 and 3 s after, and of the players alive and not blind from then to 3 s after, the pair with
 * the most of what burns in view (within 45° of the player's yaw and 30 m, with nothing of the
 * map's hull between their eye and a point 1 m above it), then the most burning. A smoke burns
 * from its detonation to its expiry, a fire from its start to its expiry or extinguishing, each
 * within its round (without an end event, 18 s and 7 s, the timeline's defaults). Runs in the
 * page.
 */
const busiestMoments = (page: Page, n: number) =>
  page.evaluate(
    ({ n, unit }) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const pack = d.store.getState().pack!;
      const h = pack.header;
      const rounds = h.rounds.map((r, round) => {
        const inRound = pack.events.filter(
          (e) => e.tick >= r.start_tick && e.tick <= r.end_tick
        );
        const endOf = (kinds: string[], id: unknown, from: number) =>
          inRound.find(
            (e) =>
              kinds.includes(e.kind) && e.tick >= from && e.data.entityid === id
          )?.tick;
        const spans = inRound.flatMap((e) => {
          const smoke = e.kind === 'smokegrenade_detonate';
          if (!smoke && e.kind !== 'inferno_startburn') return [];
          const end =
            endOf(
              smoke
                ? ['smokegrenade_expired']
                : ['inferno_expire', 'inferno_extinguish'],
              e.data.entityid,
              e.tick
            ) ?? e.tick + (smoke ? 18 : 7) * h.tick_rate;
          return [
            {
              smoke,
              start: e.tick,
              end: Math.min(end, r.end_tick),
              x: Number(e.data.x),
              y: Number(e.data.y),
              z: Number(e.data.z),
            },
          ];
        });
        const burning = (tick: number) =>
          spans.filter((o) => o.start <= tick && tick < o.end);
        let best: Moment | null = null;
        // The count only rises at a start, so the busiest tick is one of them.
        for (const s of spans) {
          const at = burning(s.start);
          const smokes = at.filter((o) => o.smoke).length;
          if (!best || at.length > best.smokes + best.fires)
            best = {
              round,
              tick: s.start,
              smokes,
              fires: at.length - smokes,
            };
        }
        return { best, inRound, spans, burning };
      });
      const moments = rounds
        .flatMap((r) => (r.best ? [r.best] : []))
        .sort(
          (a, b) =>
            b.smokes + b.fires - (a.smokes + a.fires) || a.round - b.round
        )
        .slice(0, n);
      if (moments.length === 0) return { moments, views: null };

      // Whether the line from a to b, its first 0.5 m and last 1.5 m aside (an eye by a wall, a
      // fire against one), keeps 5 cm off the hull at every 10 cm, so it crosses no wall (a
      // crossing is within 5 cm of a sample). Scene metres: Source (x, y, z) is (y, z, x).
      const clear = (
        a: [number, number, number],
        b: [number, number, number]
      ) => {
        const m = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * unit;
        for (let at = 0.5; at < m - 1.5; at += 0.1) {
          const f = at / m;
          const room = d.hullDistance(
            (a[1] + (b[1] - a[1]) * f) * unit,
            (a[2] + (b[2] - a[2]) * f) * unit,
            (a[0] + (b[0] - a[0]) * f) * unit
          );
          if (room !== null && room < 0.05) return false;
        }
        return true;
      };
      // The best view in the given rounds. A player blind at the tick or within the 3 s after
      // it is passed over (the whiteout would hide the scene being measured).
      const bestView = (only: number[]) => {
        let view: View | null = null;
        for (const round of only) {
          const { inRound, spans, burning } = rounds[round];
          const r = h.rounds[round];
          for (const s of spans)
            for (let j = 0; j < 4; j++) {
              const tick = s.start + j * h.tick_rate;
              const at = burning(tick);
              if (tick > r.end_tick || at.length === 0) continue;
              const k = Math.round((tick - r.start_tick) / h.tick_step);
              const blind = new Set(
                inRound
                  .filter(
                    (e) =>
                      e.kind === 'player_blind' &&
                      e.tick <= tick + 3 * h.tick_rate &&
                      tick <
                        e.tick + Number(e.data.blind_duration) * h.tick_rate
                  )
                  .map((e) => Number(e.data.user_idx))
              );
              pack.rounds[round].players.forEach((t, i) => {
                if (!(t.health[k] > 0) || blind.has(i)) return;
                const eye: [number, number, number] = [
                  t.x[k],
                  t.y[k],
                  t.z[k] + 64,
                ];
                let seen = 0;
                for (const o of at) {
                  const dx = o.x - eye[0];
                  const dy = o.y - eye[1];
                  const bearing = (Math.atan2(dy, dx) * 180) / Math.PI;
                  const off = Math.abs(
                    ((((t.yaw[k] / 100 - bearing) % 360) + 540) % 360) - 180
                  );
                  if (off > 45 || Math.hypot(dx, dy) > 30 / unit) continue;
                  if (clear(eye, [o.x, o.y, o.z + 40])) seen++;
                }
                if (
                  !view ||
                  seen > view.seen ||
                  (seen === view.seen && at.length > view.burning)
                )
                  view = { round, tick, player: i, burning: at.length, seen };
              });
            }
        }
        return view as View | null;
      };
      return {
        moments,
        views: {
          busiest: bestView([moments[0].round]),
          'in-view': bestView(rounds.map((_, i) => i)),
        },
      };
    },
    { n, unit: UNIT }
  );

test('frame rate', async ({ page }) => {
  test.skip(
    !demos.mirage,
    'set DEMOVIEWER_E2E_DEMO=<Mirage demo id> with the server running'
  );
  test.setTimeout(240_000);
  const errors = trackErrors(page);
  mkdirSync(OUT, { recursive: true });
  await page.addInitScript(
    (key) => localStorage.setItem(key, 'high'),
    QUALITY_KEY
  );
  await openViewer(page, `/d/${demos.mirage}`);
  expect(
    await page.evaluate(
      () =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.store.getState().quality
    )
  ).toBe('high');
  const t0 = Date.now();
  const { moments, views } = await busiestMoments(page, 5);
  const searchS = (Date.now() - t0) / 1000;
  expect(moments.length).toBeGreaterThan(0);
  expect(views?.busiest).toBeTruthy();
  expect(views?.['in-view']).toBeTruthy();
  const top = moments[0];
  console.log(
    `frame rate: busiest round ${top.round + 1}, ${top.smokes} smokes and ${top.fires} fires ` +
      `at tick ${top.tick} (views found in ${searchS.toFixed(1)} s)`
  );

  // Each view in POV on its player, whose view it was picked for.
  const fps: Record<string, number> = {};
  for (const [name, v] of Object.entries(views!) as [string, View][]) {
    console.log(
      `frame rate: ${name}: round ${v.round + 1} tick ${v.tick}, player ${v.player + 1}, ` +
        `${v.seen} of the ${v.burning} burning in view`
    );
    await page.evaluate((v) => {
      const d = (window as unknown as { __demoviewer: DebugHandle })
        .__demoviewer;
      const s = d.store.getState();
      s.pause();
      s.seekRound(v.round);
      s.seekTick(v.tick - d.store.getState().pack!.header.tick_rate);
      s.setFollow(v.player);
      s.setCamera('pov');
      s.play();
    }, v);
    // A second of play fills the scene's fps window with playing frames; then 2 s of samples.
    // Measurements, so spans of wall time (`stats.fps` is counted over each 500 ms).
    await page.waitForTimeout(1000);
    const samples: number[] = [];
    for (let i = 0; i < 4; i++) {
      await page.waitForTimeout(500);
      samples.push(
        await page.evaluate(
          () =>
            (window as unknown as { __demoviewer: DebugHandle }).__demoviewer
              .stats.fps
        )
      );
    }
    await page.screenshot({
      path: `${OUT}fps-${name}-pov.jpg`,
      type: 'jpeg',
      quality: 85,
    });
    await page.evaluate(() =>
      (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.store
        .getState()
        .pause()
    );
    fps[`${name} pov`] = samples.reduce((a, b) => a + b, 0) / samples.length;
  }
  const summary = Object.entries(fps)
    .map(([k, f]) => `${k} ${f.toFixed(1)}`)
    .join(', ');
  console.log(`frame rate at high, 2560x1440: ${summary} fps`);
  test.info().annotations.push({ type: 'fps', description: summary });

  // 20 seeks, paused, over the busiest moments: the first pass loads what they draw.
  const counts: { textures: number; geometries: number; programs: number }[] =
    [];
  for (let i = 0; i < 20; i++) {
    const m = moments[i % moments.length];
    const frames = await page.evaluate(
      ({ m }) => {
        const d = (window as unknown as { __demoviewer: DebugHandle })
          .__demoviewer;
        const s = d.store.getState();
        s.seekRound(m.round);
        s.seekTick(m.tick);
        return d.stats.frames;
      },
      { m }
    );
    await page.waitForFunction(
      (f) =>
        (window as unknown as { __demoviewer: DebugHandle }).__demoviewer.stats
          .frames > f,
      frames
    );
    // What the moment draws loaded and drawn: on the first pass its models and atlases.
    await settled(page);
    counts.push(
      await page.evaluate(() =>
        (
          window as unknown as { __demoviewer: DebugHandle }
        ).__demoviewer.memory()
      )
    );
  }
  console.log(
    'frame rate: after each seek (textures/geometries/programs): ' +
      counts.map((c) => `${c.textures}/${c.geometries}/${c.programs}`).join(' ')
  );
  const first = counts.slice(0, moments.length);
  const most = (k: 'textures' | 'geometries' | 'programs') =>
    Math.max(...first.map((c) => c[k]));
  for (const c of counts.slice(moments.length)) {
    expect(c.textures).toBeLessThanOrEqual(most('textures'));
    expect(c.geometries).toBeLessThanOrEqual(most('geometries'));
    expect(c.programs).toBeLessThanOrEqual(most('programs'));
  }
  for (const f of Object.values(fps)) expect(f).toBeGreaterThanOrEqual(60);
  expect(errors).toEqual([]);
});
