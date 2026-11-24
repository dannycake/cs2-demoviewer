// The two camera modes. POV sits at the eye of the player it shows: the followed player, or
// after their death and its hold, whoever the camera cuts to (the killer, else the nearest
// living teammate; a player the user picked is held on to the end of the round). While the
// player it shows is dead it holds their death view: the eye where they died, looking where
// they looked, as CS2's death cam does. Free starts from the view drawn last (from a player's
// eyes, stepped back and up out of their head) and nothing but its keys move it.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  EYE_CROUCHED,
  EYE_STANDING,
  toScene,
  viewDir,
} from '../src/geo/coords';
import { FLAG, GEAR, type Pack } from '../src/pack/types';
import { verticalFov } from '../src/sim/scope';
import {
  Cameras,
  FLY_START_S,
  FREE_FROM_POV,
  POV_FOV,
  type CameraContext,
} from '../src/scene/cameras';
import { DEATH_VIEW_S } from '../src/sim/deathview';
import { CAMERA_MODES, isCameraMode, killersOf } from '../src/sim/follow';
import {
  newPlayerState,
  playerStateAt,
  type PlayerState,
} from '../src/sim/sample';
import { event, trackPack, type SampleSpec } from './helpers/track-pack';

const BOUNDS = new THREE.Box3(
  new THREE.Vector3(-20, -5, -30),
  new THREE.Vector3(40, 15, 50)
);
/** `metres` in whole Source units, as the pack stores positions. */
const m = (metres: number) => Math.round(metres / 0.0254);
/** trackPack's defaults: 64 ticks/s, a sample every 2 ticks, starting at tick 1000. */
const tickOf = (k: number) => 1000 + 2 * k;

function v3(p: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(p.x, p.y, p.z);
}

function player(p: Partial<PlayerState>): PlayerState {
  return { ...newPlayerState(), present: true, flags: FLAG.alive, ...p };
}

function make(): Cameras {
  // As the scene does: sized first, then fitted to the map once it loads.
  const c = new Cameras(null, null, new THREE.Box3());
  c.resize(1600, 900);
  c.setBounds(BOUNDS);
  return c;
}

function statesAt(pack: Pack, tick: number): PlayerState[] {
  const info = pack.header.rounds[0];
  return pack.rounds[0].players.map((t) =>
    playerStateAt(t, info, tick, pack.header, newPlayerState())
  );
}

function ctx(
  pack: Pack | null,
  tick: number,
  killerOf: CameraContext['killerOf'] = () => null
): CameraContext {
  return { round: 0, tick, pack, killerOf };
}

function step(
  c: Cameras,
  pack: Pack,
  tick: number,
  dt = 1 / 60,
  killerOf?: CameraContext['killerOf']
): THREE.Camera {
  return c.update(statesAt(pack, tick), dt, ctx(pack, tick, killerOf));
}

/** The eye of a player standing at Source (x, y, 0). */
function eye(x: number, y: number): THREE.Vector3 {
  return v3(toScene(x, y, EYE_STANDING));
}

/** The camera's view direction. */
const look = (cam: THREE.Camera) => cam.getWorldDirection(new THREE.Vector3());

const still =
  (x: number, y: number, yaw = 90, more: SampleSpec = {}) =>
  (): SampleSpec => ({ x, y, yaw, ...more });

describe('camera modes', () => {
  it('are POV and Free, and a camera starts in POV', () => {
    expect(CAMERA_MODES).toEqual(['pov', 'free']);
    expect(isCameraMode('pov')).toBe(true);
    expect(isCameraMode('free')).toBe(true);
    expect(isCameraMode('follow')).toBe(false);
    expect(make().mode).toBe('pov');
  });
});

describe('Cameras: POV', () => {
  it('puts the POV camera at the eye, looking along viewDir', () => {
    const c = make();
    c.mode = 'pov';
    c.follow = 1;
    const s = player({ x: 120, y: -340, z: 16, yaw: 30, pitch: 10 });
    const cam = c.update([player({}), s], 0.016, ctx(null, 0));
    const e = v3(toScene(120, -340, 16 + EYE_STANDING));
    expect(cam.position.distanceTo(e)).toBeLessThan(1e-9);
    const dir = cam.getWorldDirection(new THREE.Vector3());
    expect(dir.distanceTo(v3(viewDir(30, 10)))).toBeLessThan(1e-6);
    // Positive Source pitch looks down.
    expect(dir.y).toBeLessThan(0);

    const crouched = c.update(
      [player({}), { ...s, duck: 255 }],
      0.016,
      ctx(null, 0)
    );
    expect(crouched.position.y).toBeCloseTo((16 + EYE_CROUCHED) * 0.0254, 9);
  });

  it('narrows to the scope at each zoom level of a scoped weapon, and back', () => {
    const pack = trackPack({
      weapons: ['none', 'AWP', 'AK-47'],
      players: [still(0, 0)],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const at = (p: Partial<PlayerState>) =>
      (c.update([player(p)], 0.016, ctx(pack, 0)) as THREE.PerspectiveCamera)
        .fov;
    expect(at({ weapon: 2 })).toBeCloseTo(POV_FOV, 9);
    expect(at({ weapon: 1, gear: 1 << GEAR.zoomShift })).toBeCloseTo(
      verticalFov(40),
      9
    );
    expect(at({ weapon: 1, gear: 2 << GEAR.zoomShift })).toBeCloseTo(
      verticalFov(10),
      9
    );
    // The scoped flag alone is the first zoom level.
    expect(at({ weapon: 1, flags: FLAG.alive | FLAG.scoped })).toBeCloseTo(
      verticalFov(40),
      9
    );
    // A rifle without a scope stays at the normal view, scoped or not.
    expect(at({ weapon: 2, flags: FLAG.alive | FLAG.scoped })).toBeCloseTo(
      POV_FOV,
      9
    );
    expect(at({ weapon: 1 })).toBeCloseTo(POV_FOV, 9);
    expect(POV_FOV).toBeCloseTo(verticalFov(90), 2);
  });

  it('starts from the view drawn last while the player is absent', () => {
    const pack = trackPack({ players: [still(100, 200)] });
    const c = make();
    c.mode = 'free';
    c.follow = 0;
    step(c, pack, tickOf(10));
    c.fly.keys.add('KeyW');
    step(c, pack, tickOf(10), 0.5);
    c.fly.keys.delete('KeyW');
    const free = step(c, pack, tickOf(10)).clone();
    c.mode = 'pov';
    const pov = c.update([player({ present: false })], 0.016, ctx(null, 0));
    expect(pov).toBe(c.pov);
    expect(pov.position.toArray()).toEqual(free.position.toArray());
    expect(pov.quaternion.toArray()).toEqual(free.quaternion.toArray());
  });

  it('starts from the overview of the map, not the origin, when nobody can be followed', () => {
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const cam = c.update([], 0.016, ctx(null, 0));
    expect(cam.position.length()).toBeGreaterThan(1);
    const centre = BOUNDS.getCenter(new THREE.Vector3());
    expect(
      look(cam).distanceTo(centre.sub(cam.position).normalize())
    ).toBeLessThan(1e-6);
  });
});

describe('Cameras: POV, a death', () => {
  // Player 0 (T) stands at the origin looking yaw 80, 12° down, and dies on sample 50 (tick
  // 1100), killed by player 1 (CT), 5 m away; the pack holds the dead samples somewhere else,
  // looking elsewhere.
  const dies = (k: number): SampleSpec =>
    k < 50
      ? { x: 0, y: 0, yaw: 80, pitch: 12 }
      : { x: -999, y: 999, yaw: -170, pitch: -40, flags: 0 };
  const pack = trackPack({
    players: [dies, still(0, m(5), -90)],
    teams: [2, 3],
    events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
  });
  const killerOf = killersOf(pack, 0);
  const HOLD = DEATH_VIEW_S * 64;
  const deathEye = eye(0, 0);
  const deathLook = v3(viewDir(80, 12));

  /** Whether `cam` shows player 0's death view. */
  const deathView = (cam: THREE.Camera) => {
    expect(cam.position.distanceTo(deathEye)).toBeLessThan(1e-6);
    expect(look(cam).distanceTo(deathLook)).toBeLessThan(1e-6);
    expect((cam as THREE.PerspectiveCamera).fov).toBe(POV_FOV);
  };

  it("holds the death view for 2 s: the eye where they died, looking where they looked; then the killer's eyes", () => {
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    for (const t of [1100, 1150, 1100 + HOLD - 1]) {
      deathView(step(c, pack, t, 1 / 60, killerOf));
      expect(c.shown).toBe(0);
      // Their model (the body) is left out of the draw: the view is from inside it.
      expect(c.hiddenPlayer()).toBe(0);
    }
    const cam = step(c, pack, 1100 + HOLD, 1 / 60, killerOf);
    expect(c.shown).toBe(1);
    expect(c.hiddenPlayer()).toBe(1);
    expect(cam.position.distanceTo(eye(0, m(5)))).toBeLessThan(1e-6);
    expect(look(cam).distanceTo(v3(viewDir(-90, 0)))).toBeLessThan(1e-6);
    // The same from a cold start and after scrubbing back: a function of the tick.
    const d = make();
    d.mode = 'pov';
    d.follow = 0;
    step(d, pack, 1300, 1 / 60, killerOf);
    expect(d.shown).toBe(1);
    deathView(step(d, pack, 1150, 1 / 60, killerOf));
    expect(d.shown).toBe(0);
  });

  it('takes the death view without the scope a player died scoped in', () => {
    const scoped = trackPack({
      weapons: ['none', 'AWP'],
      players: [
        (k) => ({
          ...dies(k),
          weapon: 1,
          flags: k < 50 ? FLAG.alive | FLAG.scoped : 0,
        }),
        still(0, m(5), -90),
      ],
      teams: [2, 3],
      events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const of = killersOf(scoped, 0);
    const alive = step(c, scoped, tickOf(40), 1 / 60, of);
    expect((alive as THREE.PerspectiveCamera).fov).toBeCloseTo(
      verticalFov(40),
      9
    );
    deathView(step(c, scoped, 1150, 1 / 60, of));
  });

  it('stays on the death view until the round ends when the user picked the player', () => {
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    c.pinned = true;
    for (const t of [1100 + HOLD, 1300, tickOf(199)]) {
      deathView(step(c, pack, t, 1 / 60, killerOf));
      expect(c.shown).toBe(0);
    }
  });

  it('cuts to the nearest living teammate when the killer is dead too', () => {
    const p = trackPack({
      players: [
        dies,
        still(0, m(30)), // teammate, far
        (k) => ({ x: 0, y: m(5), flags: k < 60 ? FLAG.alive : 0 }), // killer
        still(m(3), 0), // teammate, near
      ],
      teams: [2, 2, 3, 2],
      events: [
        event('player_death', 1100, { user_idx: 0, attacker_idx: 2 }),
        event('player_death', 1120, { user_idx: 2, attacker_idx: 1 }),
      ],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    deathView(step(c, p, 1100 + HOLD - 1, 1 / 60, killersOf(p, 0)));
    const cam = step(c, p, 1100 + HOLD, 1 / 60, killersOf(p, 0));
    expect(c.shown).toBe(3);
    expect(cam.position.distanceTo(eye(m(3), 0))).toBeLessThan(1e-6);
  });

  it('takes a disconnect (alive goes off with no death event) as a death: its death view, then the nearest living teammate', () => {
    const p = trackPack({
      players: [dies, still(0, m(30)), still(m(3), 0), still(0, m(5), -90)],
      teams: [2, 2, 2, 3],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const killerOf = killersOf(p, 0);
    expect(killerOf(0)).toBeNull();
    for (const t of [1100, 1100 + HOLD - 1]) {
      deathView(step(c, p, t, 1 / 60, killerOf));
      expect(c.shown).toBe(0);
    }
    const cam = step(c, p, 1100 + HOLD, 1 / 60, killerOf);
    expect(c.shown).toBe(2);
    expect(cam.position.distanceTo(eye(m(3), 0))).toBeLessThan(1e-6);
  });

  it("holds the death view to the round's end for a death on its last sample", () => {
    // 200 samples: alive to sample 198, dead on 199, the last; no time left to cut away.
    const p = trackPack({
      players: [
        (k) =>
          k < 199
            ? { x: 0, y: 0, yaw: 80, pitch: 12 }
            : { x: -999, y: 999, yaw: -170, pitch: -40, flags: 0 },
        still(0, m(5), -90),
      ],
      teams: [2, 3],
      events: [
        event('player_death', tickOf(199), { user_idx: 0, attacker_idx: 1 }),
      ],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const killerOf = killersOf(p, 0);
    for (const t of [tickOf(199), tickOf(199) + HOLD]) {
      deathView(step(c, p, t, 1 / 60, killerOf));
      expect(c.shown).toBe(0);
    }
  });

  it('starts on the first living teammate when the player is dead all round', () => {
    const p = trackPack({
      players: [
        () => ({ x: 0, y: 0, flags: 0 }),
        still(0, m(10)),
        still(0, m(20)),
      ],
      teams: [2, 3, 2],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const cam = step(c, p, tickOf(20), 1 / 60, killersOf(p, 0));
    expect(c.shown).toBe(2);
    expect(cam.position.distanceTo(eye(0, m(20)))).toBeLessThan(1e-6);
  });
});

/** Where Free starts from POV's `pov`: behind and above the eye, facing as it did. */
function overShoulder(pov: THREE.Camera): THREE.Vector3 {
  const back = new THREE.Vector3(0, 0, 1).applyQuaternion(pov.quaternion);
  return pov.position
    .clone()
    .addScaledVector(back, FREE_FROM_POV.back)
    .add(new THREE.Vector3(0, FREE_FROM_POV.up, 0));
}

describe('Cameras: Free', () => {
  it('starts behind and above the eyes POV showed, looking where they looked; frames and follow changes do not move it', () => {
    const pack = trackPack({
      players: [(k) => ({ x: 0, y: 8 * k, yaw: 90 }), still(0, 300)],
    });
    const c = make();
    c.mode = 'pov';
    c.follow = 0;
    const pov = step(c, pack, tickOf(10)).clone();
    c.mode = 'free';
    const free = step(c, pack, tickOf(10));
    const start = overShoulder(pov);
    expect(free.position.distanceTo(start)).toBeLessThan(1e-9);
    expect(free.position.y - pov.position.y).toBeCloseTo(FREE_FROM_POV.up, 9);
    expect(free.quaternion.toArray()).toEqual(pov.quaternion.toArray());
    // Playing on and switching who is followed leave it where it is.
    c.follow = 1;
    for (let k = 11; k < 150; k += 7) step(c, pack, tickOf(k), 0.1);
    expect(c.camera.position.distanceTo(start)).toBeLessThan(1e-9);
    // Its keys move it: one frame's worth as the move starts, then as long as they are held.
    c.fly.keys.add('KeyW');
    step(c, pack, tickOf(150), 0.5);
    expect(c.camera.position.distanceTo(start)).toBeCloseTo(
      FLY_START_S * c.fly.speed,
      6
    );
    expect(c.settling).toBe(true);
    step(c, pack, tickOf(150), 0.5);
    expect(c.camera.position.distanceTo(start)).toBeCloseTo(
      (FLY_START_S + 0.5) * c.fly.speed,
      6
    );
  });

  it('flies one frame, not the time since the last draw, when a key goes down while paused', () => {
    const pack = trackPack({ players: [still(0, 300)] });
    const c = make();
    c.mode = 'free';
    c.follow = 0;
    step(c, pack, tickOf(10));
    const at = c.camera.position.clone();
    // Paused: nothing drawn for a while, then W goes down and the next draw sees a 0.1 s gap.
    step(c, pack, tickOf(10), 0.1);
    c.fly.keys.add('KeyW');
    step(c, pack, tickOf(10), 0.1);
    expect(c.camera.position.distanceTo(at)).toBeLessThanOrEqual(
      c.fly.speed / 60 + 1e-9
    );
    // Let go, and press again: it starts afresh.
    c.fly.keys.delete('KeyW');
    step(c, pack, tickOf(10), 0.1);
    const mid = c.camera.position.clone();
    c.fly.keys.add('KeyW');
    step(c, pack, tickOf(10), 0.1);
    expect(c.camera.position.distanceTo(mid)).toBeLessThanOrEqual(
      c.fly.speed / 60 + 1e-9
    );
    // Entering Free with W already held starts afresh too.
    c.mode = 'pov';
    step(c, pack, tickOf(10), 0.1);
    c.mode = 'free';
    const entry = c.update(
      statesAt(pack, tickOf(10)),
      0.1,
      ctx(pack, tickOf(10))
    );
    expect(entry.position.distanceTo(overShoulder(c.pov))).toBeLessThanOrEqual(
      c.fly.speed / 60 + 1e-9
    );
  });
});

describe('Cameras: Free after a reel', () => {
  it('goes back to its own pose, field of view and all, once, when told to keep it', () => {
    const pack = trackPack({
      players: [(k) => ({ x: 0, y: 8 * k, yaw: 90 }), still(0, 300)],
    });
    const c = make();
    c.mode = 'free';
    c.follow = 0;
    step(c, pack, tickOf(10));
    c.fly.keys.add('KeyW');
    step(c, pack, tickOf(10), 0.5);
    c.fly.keys.delete('KeyW');
    const at = c.free.position.clone();
    const facing = c.free.quaternion.clone();
    const fov = c.free.fov;
    // A kill cam from Free: POV on player 1 for a while.
    c.mode = 'pov';
    for (let k = 10; k < 60; k += 5) step(c, pack, tickOf(k));
    expect(c.drawn.position.distanceTo(at)).toBeGreaterThan(1);
    expect(c.drawn.fov).not.toBe(fov);
    // Back to Free from the reel.
    c.keepFree();
    c.mode = 'free';
    const back = step(c, pack, tickOf(60)) as THREE.PerspectiveCamera;
    expect(back.position.toArray()).toEqual(at.toArray());
    expect(back.quaternion.toArray()).toEqual(facing.toArray());
    expect(back.fov).toBe(fov);
    // Once: entering Free again takes the view drawn last (over the shoulder of POV's).
    c.mode = 'pov';
    const pov = step(c, pack, tickOf(62)).clone();
    c.mode = 'free';
    expect(
      step(c, pack, tickOf(62)).position.distanceTo(overShoulder(pov))
    ).toBeLessThan(1e-9);
  });
});

describe('killersOf', () => {
  it("reads each victim's first death in the round", () => {
    const pack = trackPack({
      players: [still(0, 0), still(0, 1), still(0, 2)],
      events: [
        event('player_death', 900, { user_idx: 2, attacker_idx: 0 }), // before the round
        event('player_death', 1100, { user_idx: 0, attacker_idx: 1 }),
        event('player_death', 1110, { user_idx: 1, attacker_idx: 1 }),
        event('player_death', 1120, { user_idx: 2, attacker_idx: 7 }), // not a player
      ],
    });
    const k = killersOf(pack, 0);
    expect([k(0), k(1), k(2), k(5)]).toEqual([1, 1, null, null]);
  });
});
