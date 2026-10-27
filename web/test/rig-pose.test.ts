// A rig's pose, placement and visibility are functions of its input alone (Review Focus 3):
// scrubbing back, jumping rounds and returning gives the same transforms. Runs on a four-bone
// stub skeleton (pelvis, spine_1 → neck_0 above it, leg_upper_L below) with a handful of 1 s
// clips, and a hand-built four-player pack.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { toScene, yawToRotationY } from '../src/geo/coords';
import {
  FLAG,
  type MatchHeader,
  type Pack,
  type PackEvent,
  type PlayerTrack,
} from '../src/pack/types';
import { FrameSolver, type RigInput } from '../src/scene/frame';
import type { RigTemplate } from '../src/scene/loaders';
import {
  DOMINANCE,
  PlayerRig,
  REFERENCE_POSE_CLIP,
  RigPool,
  holdPoseClip,
  makeUpperBodyClip,
} from '../src/scene/PlayerRig';
import type { Action } from '../src/sim/actions';
import {
  DEATH_COLLAPSE_S,
  DEATH_TOTAL_S,
  HIT_FLASH_S,
  STRIDE_SPEED,
} from '../src/sim/anim';
import type { ClipWeight } from '../src/sim/locomotion';
import { newPlayerState, type PlayerState } from '../src/sim/sample';
import { trackPack } from './helpers/track-pack';

// newPlayerState as it is, counted: a frame of the solver makes none.
vi.mock('../src/sim/sample', async (importOriginal) => {
  const sample = await importOriginal<typeof import('../src/sim/sample')>();
  return { ...sample, newPlayerState: vi.fn(sample.newPlayerState) };
});

const A = FLAG.alive;
const TICK_RATE = 64;
const HZ = 32;
const STEP = 2;

// ---------------------------------------------------------------- stub template

const deg = (d: number) => (d * Math.PI) / 180;
const quat = (axis: [number, number, number], d: number) =>
  new THREE.Quaternion()
    .setFromAxisAngle(new THREE.Vector3(...axis), deg(d))
    .toArray();

function stubTemplate(): RigTemplate {
  const root = new THREE.Group();
  const bone = (name: string) => {
    const b = new THREE.Bone();
    b.name = name;
    return b;
  };
  const pelvis = bone('pelvis');
  const spine = bone('spine_1');
  const neck = bone('neck_0');
  const leg = bone('leg_upper_L');
  spine.position.set(0, 0.5, 0);
  neck.position.set(0, 0.5, 0);
  leg.position.set(0.1, -0.1, 0);
  pelvis.position.set(0, 1, 0);
  root.add(pelvis);
  pelvis.add(spine, leg);
  spine.add(neck);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3)
  );
  geo.setAttribute(
    'skinIndex',
    new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4)
  );
  geo.setAttribute(
    'skinWeight',
    new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4)
  );
  const mesh = new THREE.SkinnedMesh(
    geo,
    new THREE.MeshStandardMaterial({ color: 0xff0000 })
  );
  mesh.name = 'body';
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton([pelvis, spine, neck, leg]));
  const rot = (
    b: string,
    axis: [number, number, number],
    from: number,
    to: number
  ) =>
    new THREE.QuaternionKeyframeTrack(
      `${b}.quaternion`,
      [0, 1],
      [...quat(axis, from), ...quat(axis, to)]
    );
  const clip = (name: string, tracks: THREE.KeyframeTrack[]) =>
    new THREE.AnimationClip(name, 1, tracks);
  const Y: [number, number, number] = [0, 1, 0];
  const Xa: [number, number, number] = [1, 0, 0];
  const Z: [number, number, number] = [0, 0, 1];
  const clips = [
    clip('idle_rifle', [rot('spine_1', Y, 0, 90)]),
    clip('run_n_rifle', [
      rot('spine_1', Y, 0, -120),
      new THREE.VectorKeyframeTrack(
        'pelvis.position',
        [0, 1],
        [0, 1, 0, 2, 1, 0]
      ),
    ]),
    clip('run_ne_rifle', [rot('spine_1', Y, 0, 30)]),
    clip('idle_crouch_rifle', [rot('leg_upper_L', Xa, 60, 60)]),
    clip('reload_ak', [
      rot('spine_1', Z, 45, 45),
      rot('leg_upper_L', Xa, 80, 80),
    ]),
    // A delta clip, like the game's gun shoots: it starts at the reference pose.
    clip('shoot_ak', [rot('spine_1', Z, 0, 20), rot('leg_upper_L', Xa, 0, 40)]),
    // The reference pose the game's delta clips are made against (its first frame).
    clip('breathing', [
      rot('spine_1', Xa, 10, 10),
      rot('leg_upper_L', Xa, 0, 0),
    ]),
    // A weapon's own idle: a delta of 15° about X from the reference, and a track the
    // reference lacks, which must be dropped rather than added as an absolute turn.
    clip('idle_ak', [rot('spine_1', Xa, 25, 25), rot('neck_0', Z, 30, 30)]),
    clip('flinch_head', [rot('neck_0', Xa, 0, 30)]),
  ];
  return {
    scene: root,
    clips: new Map(clips.map((c) => [c.name, c])),
    variants: new Map(),
  };
}

interface Snapshot {
  visible: boolean;
  opacity: number;
  world: number[];
  bones: number[];
}

function snapshot(rig: PlayerRig): Snapshot {
  rig.object.updateMatrixWorld(true);
  const bones: number[] = [];
  rig.object.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones.push(...o.matrixWorld.elements);
  });
  return {
    visible: rig.object.visible,
    opacity: rig.opacity,
    world: [...rig.object.matrixWorld.elements],
    bones,
  };
}

function state(p: Partial<PlayerState>): PlayerState {
  return { ...newPlayerState(), present: true, flags: A, health: 100, ...p };
}

/** A rig input around `s`: idle unless `locomotion` says otherwise. */
function input(s: PlayerState, o: Partial<RigInput> = {}): RigInput {
  const locomotion: ClipWeight[] = o.locomotion ?? [
    { clip: 'idle_rifle', weight: 1, time: null },
  ];
  return {
    state: s,
    team: 3,
    tick: 1000,
    clipTime: 0,
    deathTicks: null,
    death: null,
    actions: [],
    // A weapon whose own idle the stub lacks: no grip delta unless a test asks for one.
    weapon: 'm4a4',
    family: 'rifle',
    ...o,
    locomotion,
  };
}

function action(o: Partial<Action> & Pick<Action, 'kind' | 'clip'>): Action {
  return {
    startTick: 1000,
    durationTicks: 64,
    additive: false,
    upperBody: true,
    ...o,
  };
}

/** The angle in degrees between two rotations. */
function angleBetween(a: THREE.Quaternion, b: THREE.Quaternion): number {
  // Keyframes are Float32: normalise, or a rotation's angle to itself reads about 0.03°.
  return (a.clone().normalize().angleTo(b.clone().normalize()) * 180) / Math.PI;
}

const HEADER = { tick_rate: TICK_RATE };

// ---------------------------------------------------------------- PlayerRig

describe('PlayerRig', () => {
  const running = state({ x: 100, y: -50, z: 8, yaw: 135, speed: 250 });
  const run = (time: number): ClipWeight[] => [
    { clip: 'run_n_rifle', weight: 0.7, time },
    { clip: 'run_ne_rifle', weight: 0.3, time },
  ];

  it('gives the same transforms for the same inputs after other poses', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const a = input(running, {
      locomotion: run(0.37),
      actions: [action({ kind: 'shoot', clip: 'shoot_ak', startTick: 990 })],
    });
    rig.apply(a, HEADER);
    const first = snapshot(rig);
    rig.apply(
      input(state({ x: -40, yaw: -30, pitch: 30, duck: 255 }), {
        locomotion: [{ clip: 'idle_crouch_rifle', weight: 1, time: null }],
        deathTicks: 20,
      }),
      HEADER
    );
    const other = snapshot(rig);
    rig.apply(a, HEADER);
    expect(snapshot(rig)).toEqual(first);
    expect(other.bones).not.toEqual(first.bones);
    expect(other.world).not.toEqual(first.world);
  });

  it('places the rig at toScene(x, y, z) facing yawToRotationY(yaw)', () => {
    const rig = new PlayerRig(stubTemplate(), 2);
    rig.apply(input(running), HEADER);
    const p = toScene(100, -50, 8);
    expect(rig.object.position.toArray()).toEqual([p.x, p.y, p.z]);
    expect(rig.object.rotation.y).toBeCloseTo(yawToRotationY(135));
    expect(rig.object.rotation.x).toBe(0);
    expect(rig.object.rotation.z).toBe(0);
    expect(rig.object.visible).toBe(true);
  });

  it('loops a locomotion clip: its time is taken modulo the clip length', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    rig.apply(input(running, { locomotion: run(0.25) }), HEADER);
    const a = snapshot(rig);
    rig.apply(input(running, { locomotion: run(7.25) }), HEADER);
    const b = snapshot(rig);
    a.bones.forEach((v, i) => expect(b.bones[i]).toBeCloseTo(v, 9));
  });

  it('times a clip with no stride time by the round clock', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    rig.apply(input(running, { clipTime: 0.5 }), HEADER);
    // idle_rifle half way: 45° about Y.
    expect(angleBetween(spine.quaternion, new THREE.Quaternion())).toBeCloseTo(
      45,
      4
    );
  });

  it('blends locomotion clips by weight', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const pelvis = rig.bone('pelvis')!;
    rig.apply(
      input(running, {
        locomotion: [
          { clip: 'run_n_rifle', weight: 0.5, time: 0.5 },
          { clip: 'run_ne_rifle', weight: 0.5, time: 0.5 },
        ],
      }),
      HEADER
    );
    // run_n is at −60° and run_ne at +15° about Y: half and half is about −22.5°.
    const yaw = new THREE.Euler().setFromQuaternion(spine.quaternion, 'YXZ').y;
    expect((yaw * 180) / Math.PI).toBeCloseTo(-22.5, 0);
    // Only run_n moves the pelvis (1 m at half time): at weight 0.5, half of it.
    expect(pelvis.position.x).toBeCloseTo(0.5);
  });

  it('falls back to the family idle, then idle_rifle, for a clip the model lacks', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    rig.apply(input(running, { clipTime: 0.4 }), HEADER);
    const idle = snapshot(rig).bones;
    rig.apply(
      input(running, {
        clipTime: 0.4,
        locomotion: [{ clip: 'walk_n_rifle', weight: 1, time: 3 }],
      }),
      HEADER
    );
    expect(snapshot(rig).bones).toEqual(idle);
  });

  it('plays an upper-body action over the locomotion and leaves the legs to it', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const leg = rig.bone('leg_upper_L')!;
    const crouch = [{ clip: 'idle_crouch_rifle', weight: 1, time: null }];
    rig.apply(input(running, { locomotion: crouch, weapon: 'm4a4' }), HEADER);
    const legCrouched = leg.quaternion.clone();
    rig.apply(
      input(running, {
        locomotion: crouch,
        weapon: 'm4a4',
        tick: 1000 + 6,
        actions: [
          action({
            kind: 'reload',
            clip: 'reload_ak',
            startTick: 1000,
            durationTicks: 13,
          }),
        ],
      }),
      HEADER
    );
    // reload_ak turns spine_1 45° about Z; at 24 : 1 it owns 96% of it.
    const roll = new THREE.Euler().setFromQuaternion(spine.quaternion, 'ZXY').z;
    expect((roll * 180) / Math.PI).toBeGreaterThan(40);
    // reload_ak's 80° leg track is not in its upper-body variant: the leg stays crouched.
    expect(angleBetween(leg.quaternion, legCrouched)).toBeCloseTo(0, 4);
  });

  it("adds a gun's shoot clip on top of the held pose as recoil, from its own first frame", () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const leg = rig.bone('leg_upper_L')!;
    // idle_rifle half a second in: spine_1 turned 45° about Y, away from the reference.
    const at = (tick: number, actions: Action[]) =>
      input(running, { weapon: 'm4a4', clipTime: 0.5, tick, actions });
    rig.apply(at(1000 + 16, []), HEADER);
    const spineHeld = spine.quaternion.clone();
    const legHeld = leg.quaternion.clone();
    const shot = action({
      kind: 'shoot',
      clip: 'shoot_ak',
      startTick: 1000,
      durationTicks: 640,
    });
    rig.apply(at(1000, [shot]), HEADER);
    // Its first frame is the reference: nothing moves, the arms do not snap to it.
    expect(angleBetween(spine.quaternion, spineHeld)).toBeCloseTo(0, 3);
    rig.apply(at(1000 + 16, [shot]), HEADER);
    // shoot_ak runs 0 → 20° about Z over 1 s: 0.25 s in, +5° on top of the held pose.
    expect(angleBetween(spine.quaternion, spineHeld)).toBeCloseTo(5, 1);
    // Upper body only: the legs keep the locomotion.
    expect(angleBetween(leg.quaternion, legHeld)).toBeCloseTo(0, 4);
  });

  it('keeps the recoil while a flinch plays at the same time', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const neck = rig.bone('neck_0')!;
    const base = input(running, { weapon: 'm4a4', tick: 1000 + 16 });
    rig.apply(base, HEADER);
    const spineHeld = spine.quaternion.clone();
    const neckHeld = neck.quaternion.clone();
    rig.apply(
      {
        ...base,
        actions: [
          action({
            kind: 'shoot',
            clip: 'shoot_ak',
            startTick: 1000,
            durationTicks: 640,
          }),
          action({
            kind: 'flinch',
            clip: 'flinch_head',
            startTick: 1000,
            durationTicks: 64,
            additive: true,
            upperBody: false,
          }),
        ],
      },
      HEADER
    );
    expect(angleBetween(spine.quaternion, spineHeld)).toBeCloseTo(5, 1);
    expect(angleBetween(neck.quaternion, neckHeld)).toBeCloseTo(7.5, 1);
  });

  it("holds a weapon's own idle as a delta from the reference pose, upper body only", () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const neck = rig.bone('neck_0')!;
    const crouch = [{ clip: 'idle_crouch_rifle', weight: 1, time: null }];
    rig.apply(input(running, { locomotion: crouch, weapon: 'm4a4' }), HEADER);
    const spinePlain = spine.quaternion.clone();
    const neckPlain = neck.quaternion.clone();
    rig.apply(input(running, { locomotion: crouch, weapon: 'ak47' }), HEADER);
    // idle_ak is 25° about X against the reference's 10°: 15° on top of the locomotion.
    expect(angleBetween(spine.quaternion, spinePlain)).toBeCloseTo(15, 1);
    // breathing has no neck track, so idle_ak's 30° neck track is dropped, not added whole.
    expect(angleBetween(neck.quaternion, neckPlain)).toBeCloseTo(0, 4);
  });

  it('lets an upper-body action replace the held idle while it plays', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const reload = (weapon: string) =>
      input(running, {
        weapon,
        tick: 1000 + 32,
        actions: [
          action({
            kind: 'reload',
            clip: 'reload_ak',
            startTick: 1000,
            durationTicks: 128,
          }),
        ],
      });
    rig.apply(reload('m4a4'), HEADER);
    const plain = spine.quaternion.clone();
    rig.apply(reload('ak47'), HEADER);
    expect(angleBetween(spine.quaternion, plain)).toBeCloseTo(0, 2);
  });

  it('holds each weapon by its own idle clip, the grenades and the c4 by theirs, the knife by none', () => {
    expect(REFERENCE_POSE_CLIP).toBe('breathing');
    expect(holdPoseClip('rifle', 'ak47')).toBe('idle_ak');
    expect(holdPoseClip('pistol', 'hkp2000')).toBe('idle_hkp');
    expect(holdPoseClip('pistol', 'elite')).toBe('idle_elite');
    expect(holdPoseClip('c4', 'c4')).toBe('idle_c4');
    expect(holdPoseClip('grenade', 'hegrenade')).toBe('idle_grenade');
    expect(holdPoseClip('grenade', 'incendiary')).toBe('idle_molotov');
    expect(holdPoseClip('knife', 'knife')).toBeNull();
    expect(holdPoseClip('rifle', 'none')).toBeNull();
  });

  it('makes upper-body clips from the upper-body bones only', () => {
    const tmpl = stubTemplate();
    const upper = makeUpperBodyClip(tmpl.clips.get('reload_ak')!);
    expect(upper.tracks.map((t) => t.name)).toEqual(['spine_1.quaternion']);
    expect(upper.duration).toBe(1);
    expect(DOMINANCE).toBeGreaterThanOrEqual(20);
  });

  it('adds a flinch on top of the pose', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const neck = rig.bone('neck_0')!;
    rig.apply(input(running), HEADER);
    const before = neck.quaternion.clone();
    rig.apply(
      input(running, {
        tick: 1000 + 16,
        actions: [
          action({
            kind: 'flinch',
            clip: 'flinch_head',
            startTick: 1000,
            durationTicks: 64,
            additive: true,
            upperBody: false,
          }),
        ],
      }),
      HEADER
    );
    // flinch_head runs 0 → 30° over 1 s: 0.25 s in, +7.5° on top of the neck's own pose.
    expect(angleBetween(neck.quaternion, before)).toBeCloseTo(7.5, 1);
  });

  it('bends the spine with the pitch, down for positive pitch, clamped at 60°', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const spine = rig.bone('spine_1')!;
    const neck = rig.bone('neck_0')!;
    const world = (o: THREE.Object3D) =>
      o.getWorldQuaternion(new THREE.Quaternion());
    rig.apply(input(state({ yaw: 0, pitch: 0 })), HEADER);
    const s0 = world(spine);
    const n0 = world(neck);
    const forward0 = new THREE.Vector3(0, 0, 1).applyQuaternion(n0);
    rig.apply(input(state({ yaw: 0, pitch: 40 })), HEADER);
    expect(angleBetween(world(spine), s0)).toBeCloseTo(16, 3);
    // The stub has no spine_2 or spine_3: the neck gets spine_1's 40% and its own 10%.
    expect(angleBetween(world(neck), n0)).toBeCloseTo(20, 3);
    // Looking down tips the neck's forward towards −Y.
    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(world(neck));
    expect(forward.y).toBeLessThan(forward0.y);
    rig.apply(input(state({ yaw: 0, pitch: 89 })), HEADER);
    expect(angleBetween(world(spine), s0)).toBeCloseTo(24, 3);
  });

  it('aims without copying a rotation or a vector, and walks its world matrices once', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const aimed = input(state({ yaw: 30, pitch: 40 }), {
      locomotion: [{ clip: 'idle_rifle', weight: 1, time: null }],
    });
    rig.apply(aimed, HEADER);
    const posed = snapshot(rig);
    let nodes = 0;
    rig.object.traverse(() => nodes++);
    const quaternions = vi.spyOn(THREE.Quaternion.prototype, 'clone');
    const vectors = vi.spyOn(THREE.Vector3.prototype, 'clone');
    const walks = vi.spyOn(THREE.Object3D.prototype, 'updateMatrixWorld');
    try {
      rig.apply(aimed, HEADER);
      expect(quaternions).not.toHaveBeenCalled();
      expect(vectors).not.toHaveBeenCalled();
      // Once over the rig after the spine's turns, not again under each turned bone.
      expect(walks.mock.calls.length).toBeLessThanOrEqual(nodes);
    } finally {
      quaternions.mockRestore();
      vectors.mockRestore();
      walks.mockRestore();
    }
    expect(snapshot(rig)).toEqual(posed);
  });

  it('hides a player who is not present', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    rig.apply(input(running), HEADER);
    expect(rig.object.visible).toBe(true);
    rig.apply(input({ ...running, present: false }), HEADER);
    expect(rig.object.visible).toBe(false);
  });

  it('drops a dead body away from the shot, lays it, fades it and hides it', () => {
    const rig = new PlayerRig(stubTemplate(), 2);
    const body = state({ x: 0, y: 0, z: 0, yaw: 0, flags: 0, speed: 0 });
    const up = () =>
      new THREE.Vector3(0, 1, 0).applyQuaternion(rig.object.quaternion);
    const facing = new THREE.Vector3(0, 0, 1).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yawToRotationY(0)
    );
    const dying = (seconds: number, bearing?: number) =>
      input(body, {
        deathTicks: seconds * TICK_RATE,
        death: action({
          kind: 'death',
          clip: 'flinch_head',
          upperBody: false,
          data: bearing === undefined ? {} : { bearing },
        }),
      });
    // 0.1 s after the kill it is already going over, though still mostly upright.
    rig.apply(dying(0.1), HEADER);
    expect(up().y).toBeLessThan(0.999);
    expect(up().y).toBeGreaterThan(0.95);
    // Mid-fall it leans back (no attacker known: away from where it faced).
    rig.apply(dying(0.25), HEADER);
    expect(up().y).toBeLessThan(0.99);
    expect(up().dot(facing)).toBeLessThan(0);
    // Down, it lies flat, still opaque.
    rig.apply(dying(2), HEADER);
    expect(up().y).toBeCloseTo(0, 5);
    expect(up().dot(facing)).toBeCloseTo(-1, 5);
    expect(rig.opacity).toBe(1);
    // Shot from its right, it falls to its left (the model's +X).
    rig.apply(dying(2, 90), HEADER);
    const left = new THREE.Vector3(1, 0, 0).applyAxisAngle(
      new THREE.Vector3(0, 1, 0),
      yawToRotationY(0)
    );
    expect(up().dot(left)).toBeCloseTo(1, 5);
    rig.apply(dying(DEATH_COLLAPSE_S + 6.75), HEADER);
    expect(rig.opacity).toBeCloseTo(0.5);
    for (const m of rig.materials) {
      expect(m.transparent).toBe(true);
      expect(m.opacity).toBeCloseTo(0.5);
    }
    rig.apply(dying(DEATH_TOTAL_S), HEADER);
    expect(rig.object.visible).toBe(false);
    // Scrubbing back before the death restores the living, opaque, upright rig.
    rig.apply(input(running), HEADER);
    expect(rig.object.visible).toBe(true);
    expect(rig.object.rotation.x).toBe(0);
    expect(rig.object.rotation.z).toBe(0);
    expect(rig.opacity).toBe(1);
    for (const m of rig.materials) expect(m.transparent).toBe(false);
  });

  it('flashes red for HIT_FLASH_S when hit, and when killed', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    const m = rig.materials[0];
    rig.apply(input(running), HEADER);
    const base = m.color.clone();
    const flinch = action({
      kind: 'flinch',
      clip: 'flinch_head',
      startTick: 1000,
      durationTicks: 19,
      additive: true,
      upperBody: false,
    });
    rig.apply(input(running, { tick: 1000, actions: [flinch] }), HEADER);
    // Red stays, green and blue drop: the whole model reads as hit.
    expect(m.color.r).toBeCloseTo(base.r, 2);
    expect(m.color.g).toBeLessThan(base.g * 0.5);
    expect(m.color.b).toBeLessThan(base.b * 0.5);
    const later = 1000 + Math.ceil(HIT_FLASH_S * TICK_RATE);
    rig.apply(input(running, { tick: later, actions: [flinch] }), HEADER);
    expect(m.color.getHex()).toBe(base.getHex());
    // The killing hit flashes the falling body the same way.
    rig.apply(
      input(running, {
        deathTicks: 0,
        death: action({ kind: 'death', clip: 'flinch_head', upperBody: false }),
      }),
      HEADER
    );
    expect(m.color.g).toBeLessThan(base.g * 0.5);
    // A team change under the flash keeps the new team's tint once it has passed.
    rig.setTeam(2);
    rig.apply(input(running), HEADER);
    const t = new THREE.Color(0xf2a33a).lerp(new THREE.Color(0xffffff), 0.55);
    expect(m.color.getHex()).toBe(t.getHex());
    rig.dispose();
  });

  it('tints unlit materials by team', () => {
    const rig = new PlayerRig(stubTemplate(), 3);
    expect(rig.materials.length).toBeGreaterThan(0);
    for (const m of rig.materials)
      expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
    const ct = rig.materials[0].color.getHex();
    rig.setTeam(2);
    const t = rig.materials[0].color.getHex();
    expect(t).not.toBe(ct);
    expect(rig.team).toBe(2);
    const expected = new THREE.Color(0xf2a33a).lerp(
      new THREE.Color(0xffffff),
      0.55
    );
    expect(t).toBe(expected.getHex());
    rig.dispose();
  });
  it('is lit in the lit look, tinted the same, sharing nothing with the template', () => {
    const tmpl = stubTemplate();
    const body = tmpl.scene.getObjectByName('body') as THREE.SkinnedMesh;
    body.geometry.computeVertexNormals();
    const normals = body.geometry.getAttribute('normal');
    const look = { lit: true, smoothNormals: false, maxAnisotropy: 8 };
    const ct = new PlayerRig(tmpl, 3, look);
    const t = new PlayerRig(tmpl, 2, look);
    expect(ct.materials.length).toBeGreaterThan(0);
    for (const m of ct.materials) {
      expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
      // The model's own normals shade it, whatever the world does.
      expect((m as THREE.MeshLambertMaterial).flatShading).toBe(false);
      expect(t.materials).not.toContain(m);
    }
    expect(body.geometry.getAttribute('normal')).toBe(normals);
    expect(body.material).toBeInstanceOf(THREE.MeshStandardMaterial);
    expect(ct.materials[0].color.getHex()).toBe(
      new THREE.Color(0x4da3ff).lerp(new THREE.Color(0xffffff), 0.55).getHex()
    );
    expect(t.materials[0].color.getHex()).toBe(
      new THREE.Color(0xf2a33a).lerp(new THREE.Color(0xffffff), 0.55).getHex()
    );
    ct.dispose();
    t.dispose();
  });

  it("casts and receives the sun's shadow", () => {
    const rig = new PlayerRig(stubTemplate(), 2);
    let meshes = 0;
    rig.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      meshes++;
      expect(mesh.castShadow).toBe(true);
      expect(mesh.receiveShadow).toBe(true);
    });
    expect(meshes).toBeGreaterThan(0);
    rig.dispose();
  });
});

// ---------------------------------------------------------------- synthetic pack

const R0 = { start: 1000, samples: 200 };
const R1 = { start: 2000, samples: 100 };
/** Runner: runs +x at 250 u/s for samples 0..99, then stands still. */
const RUN_UNTIL = 99;
/** Victim: alive for samples 0..100, dies one tick after sample 100. */
const VICTIM_LAST_ALIVE = 100;
const DEATH_TICK = R0.start + VICTIM_LAST_ALIVE * STEP + 1;

function track(
  samples: number,
  at: (k: number) => {
    x: number;
    y: number;
    z: number;
    yaw: number;
    flags: number;
  }
): PlayerTrack {
  const t: PlayerTrack = {
    x: new Int16Array(samples),
    y: new Int16Array(samples),
    z: new Int16Array(samples),
    yaw: new Int16Array(samples),
    pitch: new Int16Array(samples),
    health: new Uint8Array(samples),
    armor: new Uint8Array(samples),
    flags: new Uint8Array(samples),
    duck: new Uint8Array(samples),
    weapon: new Uint8Array(samples),
    money: new Uint16Array(samples),
    ammo: new Uint8Array(samples).fill(255),
    gear: new Uint8Array(samples),
  };
  for (let k = 0; k < samples; k++) {
    const s = at(k);
    t.x[k] = s.x;
    t.y[k] = s.y;
    t.z[k] = s.z;
    t.yaw[k] = s.yaw * 100;
    t.flags[k] = s.flags;
    t.health[k] = s.flags & A ? 100 : 0;
  }
  return t;
}

const runner = (samples: number) =>
  track(samples, (k) => ({
    x: Math.round((Math.min(k, RUN_UNTIL) * 250) / HZ),
    y: 0,
    z: 0,
    yaw: 0,
    flags: A,
  }));

function makePack(): Pack {
  const header: MatchHeader = {
    version: 1,
    map: 'de_test',
    server_name: '',
    game_build: '',
    tick_rate: TICK_RATE,
    sample_hz: HZ,
    tick_step: STEP,
    players: [
      { steamid: '1', name: 'runner', team_by_round: [3, 2], crosshair: null },
      { steamid: '2', name: 'victim', team_by_round: [2, 3], crosshair: null },
      { steamid: '3', name: 'bench', team_by_round: [0, 0], crosshair: null },
      { steamid: '4', name: 'ghost', team_by_round: [3, 2], crosshair: null },
    ],
    rounds: [R0, R1].map((r, i) => ({
      number: i + 1,
      start_tick: r.start,
      freeze_end_tick: r.start,
      end_tick: r.start + (r.samples - 1) * STEP,
      post_end_tick: r.start + (r.samples - 1) * STEP,
      winner: 3,
      reason: 't_killed',
      score_t: 0,
      score_ct: i + 1,
      samples: r.samples,
    })),
    weapons: ['none'],
  };
  const standing = (samples: number, aliveUntil: number) =>
    track(samples, (k) =>
      k <= aliveUntil
        ? { x: 500, y: 300, z: 10, yaw: 90, flags: A }
        : // A dead sample's position is not where the body fell.
          { x: 0, y: 0, z: 0, yaw: 0, flags: 0 }
    );
  const never = (samples: number) =>
    track(samples, () => ({ x: 0, y: 0, z: 0, yaw: 0, flags: 0 }));
  const events: PackEvent[] = [
    { tick: DEATH_TICK, kind: 'player_death', data: { user_idx: 1 } },
    // Not this round: must not leak into round 0.
    { tick: R1.start + 10, kind: 'player_death', data: { user_idx: 0 } },
    { tick: DEATH_TICK, kind: 'player_hurt', data: { user_idx: 0 } },
  ];
  return {
    header,
    rounds: [
      {
        players: [
          runner(R0.samples),
          standing(R0.samples, VICTIM_LAST_ALIVE),
          standing(R0.samples, R0.samples), // alive throughout, but team 0
          never(R0.samples),
        ],
      },
      {
        players: [
          runner(R1.samples),
          standing(R1.samples, R1.samples),
          standing(R1.samples, R1.samples),
          never(R1.samples),
        ],
      },
    ],
    events,
    grenades: [],
    inventory: [],
    entities: [],
    entityChanges: [],
    ground: [],
  };
}

// ---------------------------------------------------------------- FrameSolver

describe('FrameSolver', () => {
  it('lays a player who died where they died, not at the origin', () => {
    const pack = makePack();
    const solver = new FrameSolver(pack);
    const tick = DEATH_TICK + 0.5 * TICK_RATE;
    const v = solver.solve(0, tick)[1];
    expect(v.deathTicks).toBeCloseTo(0.5 * TICK_RATE);
    expect(v.state.present).toBe(true);
    expect(v.state.flags & A).toBe(0);
    expect([v.state.x, v.state.y, v.state.z]).toEqual([500, 300, 10]);
    expect(v.state.yaw).toBeCloseTo(90);
    expect(v.locomotion).toEqual([
      { clip: 'idle_rifle', weight: 1, time: null },
    ]);
    expect(v.death?.kind).toBe('death');
    expect(v.actions).toEqual([]);
  });

  it("refills each input's locomotion with the weights it had, so a frame makes none, and a new output with its own", () => {
    const solver = new FrameSolver(makePack());
    const out: RigInput[] = [];
    solver.solve(0, R0.start + 40 * STEP, out);
    const kept = [...out[0].locomotion];
    expect(kept.length).toBeGreaterThan(0);
    solver.solve(0, R0.start + 41.5 * STEP, out);
    const now = out[0].locomotion;
    expect(now.length).toBe(kept.length);
    now.forEach((c, i) => expect(c).toBe(kept[i]));
    // Filled for this tick: the same as a fresh solve gives.
    const fresh = solver.solve(0, R0.start + 41.5 * STEP)[0].locomotion;
    expect(now).toEqual(fresh);
    expect(fresh[0]).not.toBe(now[0]);
  });

  it('times the death from the event, starting while the last live sample still shows', () => {
    const solver = new FrameSolver(makePack());
    expect(solver.solve(0, DEATH_TICK - 0.5)[1].deathTicks).toBeNull();
    const at = solver.solve(0, DEATH_TICK + 0.5)[1];
    expect(at.deathTicks).toBeCloseTo(0.5);
    expect(at.state.present).toBe(true);
    expect(at.state.flags & A).toBe(A);
  });

  it('only counts deaths of the round being shown', () => {
    const solver = new FrameSolver(makePack());
    // The runner dies in round 1, not round 0.
    expect(solver.solve(0, R0.start + 150 * STEP)[0].deathTicks).toBeNull();
    expect(solver.solve(1, R1.start + 50 * STEP)[0].deathTicks).toBe(
      50 * STEP - 10
    );
  });

  it('marks players not in the round as absent', () => {
    const solver = new FrameSolver(makePack());
    const inputs = solver.solve(0, R0.start + 50 * STEP);
    expect(inputs).toHaveLength(4);
    expect(inputs[2].team).toBe(0);
    expect(inputs[2].state.present).toBe(false);
    expect(inputs[3].team).toBe(3);
    expect(inputs[3].state.present).toBe(false);
  });

  it('resets the state of a player not in the round in place, making none per frame', () => {
    const solver = new FrameSolver(makePack());
    const out = solver.solve(0, R0.start + 50 * STEP);
    const bench = out[2].state;
    const ghost = out[3].state;
    // As a frame where they played would have left them.
    for (const s of [bench, ghost]) Object.assign(s, { x: 5, present: true });
    vi.mocked(newPlayerState).mockClear();
    solver.solve(0, R0.start + 51 * STEP, out);
    expect(newPlayerState).not.toHaveBeenCalled();
    expect(out[2].state).toBe(bench);
    expect(out[3].state).toBe(ghost);
    expect(bench).toEqual(newPlayerState());
    expect(ghost).toEqual(newPlayerState());
  });

  it('runs on strides timed by the distance walked, and blends into idle over 0.15 s', () => {
    const pack = makePack();
    const solver = new FrameSolver(pack);
    const mid = solver.solve(0, R0.start + 50 * STEP)[0];
    expect(mid.locomotion).toHaveLength(1);
    expect(mid.locomotion[0].clip).toBe('run_n_rifle');
    expect(mid.locomotion[0].weight).toBeCloseTo(1);
    // 50 samples at 250/32 units each, at the run's STRIDE_SPEED units per clip-second.
    // The distance is walked along the drawn path, which meets (x[k−1] + 4·x[k] + x[k+1]) / 6
    // at a sample.
    const x = (k: number) => Math.round((k * 250) / HZ);
    expect(mid.locomotion[0].time).toBeCloseTo(
      (x(49) + 4 * x(50) + x(51)) / 6 / STRIDE_SPEED.run,
      6
    );
    expect(solver.solve(0, R0.start + 150 * STEP)[0].locomotion).toEqual([
      { clip: 'idle_rifle', weight: 1, time: null },
    ]);
    // Somewhere just after the stop, idle and a stride are both in the blend.
    let mixed: number | null = null;
    for (let k = RUN_UNTIL; k < RUN_UNTIL + 20 && mixed === null; k++) {
      const l = solver.solve(0, R0.start + k * STEP)[0].locomotion;
      if (l.length > 1 && l.some((c) => c.clip === 'idle_rifle')) mixed = k;
    }
    expect(mixed).not.toBeNull();
    const tick = R0.start + mixed! * STEP;
    const blend = solver.solve(0, tick)[0].locomotion.map((c) => ({ ...c }));
    expect(blend.reduce((n, c) => n + c.weight, 0)).toBeCloseTo(1, 9);
    // The blend is a function of the tick, whatever was solved before.
    solver.solve(0, R0.start);
    solver.solve(1, R1.start + 30);
    expect(solver.solve(0, tick)[0].locomotion).toEqual(blend);
    expect(new FrameSolver(pack).solve(0, tick)[0].locomotion).toEqual(blend);
  });

  it('changes the locomotion blend continuously, not in a step at each sample', () => {
    const solver = new FrameSolver(makePack());
    const weightsAt = (tick: number) =>
      new Map(
        solver.solve(0, tick)[0].locomotion.map((c) => [c.clip, c.weight])
      );
    let prev = weightsAt(R0.start + (RUN_UNTIL - 4) * STEP);
    let most = 0;
    for (
      let tick = R0.start + (RUN_UNTIL - 4) * STEP + 0.1;
      tick < R0.start + (RUN_UNTIL + 12) * STEP;
      tick += 0.1
    ) {
      const now = weightsAt(tick);
      let l1 = 0;
      for (const clip of new Set([...prev.keys(), ...now.keys()]))
        l1 += Math.abs((now.get(clip) ?? 0) - (prev.get(clip) ?? 0));
      most = Math.max(most, l1);
      prev = now;
    }
    // Run to idle over CROSS_FADE_S (10 ticks): 2 of L1 at about 0.02 a tenth of a tick.
    // Steps at each sample would move up to 5/15 of the blend (2/3 of L1) at once.
    expect(most).toBeLessThan(0.05);
  });

  it('cross-fades the locomotion set when the weapon changes', () => {
    const SWITCH = 50;
    const pack = trackPack({
      players: [(k) => ({ x: 8 * k, flags: A, weapon: k < SWITCH ? 1 : 2 })],
      weapons: ['none', 'ak47', 'knife'],
    });
    const solver = new FrameSolver(pack);
    const start = pack.header.rounds[0].start_tick;
    const at = (tick: number) =>
      Object.fromEntries(
        solver.solve(0, tick)[0].locomotion.map((c) => [c.clip, c.weight])
      );
    const before = at(start + (SWITCH - 1) * STEP);
    expect(before).toEqual({ run_n_rifle: expect.closeTo(1, 9) });
    const during = at(start + (SWITCH + 1) * STEP);
    expect(during.run_n_rifle).toBeGreaterThan(0.2);
    expect(during.run_n_knife).toBeGreaterThan(0.2);
    expect(at(start + (SWITCH + 8) * STEP)).toEqual({
      run_n_knife: expect.closeTo(1, 9),
    });
  });

  it('gives the clip time as seconds since the round start', () => {
    const solver = new FrameSolver(makePack());
    expect(solver.solve(1, R1.start + 96)[0].clipTime).toBeCloseTo(1.5);
  });
});

// ---------------------------------------------------------------- RigPool

describe('RigPool', () => {
  function setup() {
    const pack = makePack();
    const solver = new FrameSolver(pack);
    const pool = new RigPool(
      { 2: stubTemplate(), 3: stubTemplate() },
      pack.header.players.length
    );
    const frame = (round: number, tick: number): RigInput[] => {
      const inputs = solver.solve(round, tick);
      pool.drive(inputs, pack.header);
      return inputs;
    };
    const snap = () =>
      Array.from({ length: pool.size }, (_, i) => {
        const rig = pool.active(i);
        return rig ? snapshot(rig) : null;
      });
    return { pack, pool, frame, snap };
  }

  it('is sized from the header and never touches a missing player', () => {
    const { pool, frame } = setup();
    expect(pool.size).toBe(4);
    frame(0, R0.start + 10);
    expect(pool.active(4)).toBeNull();
    expect(pool.active(-1)).toBeNull();
  });

  it('keeps players who are not in the round hidden', () => {
    const { pool, frame } = setup();
    for (const tick of [R0.start, R0.start + 77, R0.start + 150]) {
      frame(0, tick);
      expect(pool.active(2)).toBeNull();
      const ghost = pool.active(3);
      expect(ghost === null || !ghost.object.visible).toBe(true);
      let shown = 0;
      pool.root.traverse((o) => {
        if (o.parent === pool.root && o.visible) shown++;
      });
      expect(shown).toBe(2);
    }
  });

  it('gives identical transforms at a tick after scrubbing back and jumping rounds', () => {
    const { frame, snap } = setup();
    // Mid-fall for the victim (the fall takes DEATH_COLLAPSE_S); the runner has just stopped.
    const a = DEATH_TICK + (DEATH_COLLAPSE_S / 2) * TICK_RATE;

    const inputs = frame(0, a);
    expect(inputs[1].deathTicks).not.toBeNull();
    const first = snap();
    expect(first[0]?.visible).toBe(true);
    expect(first[1]?.visible).toBe(true);

    frame(0, a - 37); // scrub back
    const before = snap();
    frame(1, R1.start + 50); // jump to the next round (teams swap sides)
    frame(0, a + 150); // the victim's body lies there
    expect(snap()[1]?.visible).toBe(true);
    expect(snap()[1]?.world).not.toEqual(first[1]?.world);
    frame(0, a);
    expect(snap()).toEqual(first);

    // Playing forward into the same tick gives the same result too.
    frame(0, a - 37);
    expect(snap()).toEqual(before);
    for (let t = a - 37; t < a; t += 7.3) frame(0, t);
    frame(0, a);
    expect(snap()).toEqual(first);
  });

  it('swaps a player to their other side model when teams change', () => {
    const { pool, frame } = setup();
    frame(0, R0.start + 10);
    const ct = pool.active(0)!;
    expect(ct.team).toBe(3);
    frame(1, R1.start + 10);
    const t = pool.active(0)!;
    expect(t.team).toBe(2);
    expect(t).not.toBe(ct);
    expect(ct.object.visible).toBe(false);
    expect(t.object.visible).toBe(true);
    pool.dispose();
  });

  it('remakes its rigs in a new look, in the same pose, and frees the old ones', () => {
    const { pool, frame, snap } = setup();
    const a = R0.start + 40;
    frame(0, a);
    const before = snap();
    const old = Array.from({ length: pool.size }, (_, i) =>
      pool.active(i)
    ).filter((r): r is PlayerRig => r !== null);
    expect(old.length).toBeGreaterThan(0);
    let freed = 0;
    let made = 0;
    for (const r of old)
      for (const m of r.materials) {
        expect(m).toBeInstanceOf(THREE.MeshBasicMaterial);
        m.addEventListener('dispose', () => freed++);
        made++;
      }

    pool.setLook({ lit: true, smoothNormals: true, maxAnisotropy: 8 });
    frame(0, a);
    expect(snap()).toEqual(before);
    for (let i = 0; i < pool.size; i++) {
      const rig = pool.active(i);
      if (!rig) continue;
      expect(old).not.toContain(rig);
      for (const m of rig.materials)
        expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    }
    expect(freed).toBe(made);
    for (const r of old) expect(r.object.parent).toBeNull();

    // A look that changes nothing the players are drawn with keeps the rigs.
    const kept = pool.active(0);
    expect(kept).not.toBeNull();
    pool.setLook({
      lit: true,
      smoothNormals: false,
      maxAnisotropy: 8,
      detail: new THREE.Texture(),
    });
    expect(pool.active(0)).toBe(kept);
    pool.dispose();
  });
});
