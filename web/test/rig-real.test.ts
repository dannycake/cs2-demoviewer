// The rig on the real player models (`assets/players/{t,ct}.glb`, gated on ASSETS_DIR):
// every weapon is held in the right hand, the c4 between both, and a shot's recoil leaves the
// hands on the gun. The game's per-weapon idles, `idle_c4`, `idle_grenade` and the gun shoot
// clips are deltas from a reference pose; played whole, they throw the arms out to the bind
// pose, a metre or more from the weapon.

import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { FLAG } from '../src/pack/types';
import type { RigInput } from '../src/scene/frame';
import {
  loadRigTemplate,
  makeGltfLoader,
  type RigTemplate,
} from '../src/scene/loaders';
import { PlayerRig, type Team } from '../src/scene/PlayerRig';
import { WeaponCache, weaponModelName } from '../src/scene/weapons';
import type { Action } from '../src/sim/actions';
import { STRIDE_SPEED } from '../src/sim/anim';
import { newPlayerState } from '../src/sim/sample';
import {
  WEAPON_CLIP_SUFFIX,
  familyOf,
  weaponClip,
  type Family,
} from '../src/sim/weapons';
import { fileUrl, installBrowserShims } from './helpers/node-gltf';
import { needs } from './helpers/gates';

const ASSETS = process.env.ASSETS_DIR;
const HEADER = { tick_rate: 64 };
const LOG = process.env.DEMOVIEWER_RIG_LOG === '1';

const HELD = [
  ...Object.keys(WEAPON_CLIP_SUFFIX),
  'knife',
  'c4',
  'hegrenade',
  'flashbang',
  'smokegrenade',
  'molotov',
];

function idleOf(family: Family): string {
  return `idle_${family === 'rifle' || family === 'knife' ? family : 'pistol'}`;
}

function input(
  weapon: string,
  team: Team,
  actions: Action[] = [],
  tick = 1000
): RigInput {
  const family = familyOf(weapon);
  return {
    state: {
      ...newPlayerState(),
      present: true,
      flags: FLAG.alive,
      health: 100,
    },
    team,
    tick,
    clipTime: 0,
    deathTicks: null,
    death: null,
    actions,
    weapon,
    family,
    locomotion: [{ clip: idleOf(family), weight: 1, time: null }],
  };
}

function where(rig: PlayerRig, bone: string): THREE.Vector3 {
  rig.object.updateMatrixWorld(true);
  return rig.bone(bone)!.getWorldPosition(new THREE.Vector3());
}

/** The model shown on `wpn`: the one visible child the rig hangs there. */
function heldModel(rig: PlayerRig): THREE.Object3D | null {
  return rig.bone('wpn')!.children.find((c) => c.visible) ?? null;
}

/** The degrees between two directions. */
function angle(a: THREE.Vector3, b: THREE.Vector3): number {
  return THREE.MathUtils.radToDeg(a.angleTo(b));
}

function hands(rig: PlayerRig) {
  const wpn = where(rig, 'wpn');
  const r = where(rig, 'hand_R');
  const l = where(rig, 'hand_L');
  return { wpn, r, l, toR: r.distanceTo(wpn), toL: l.distanceTo(wpn) };
}

const GATE = needs('PlayerRig on the real models', 'ASSETS_DIR');
describe.skipIf(!ASSETS)(GATE, () => {
  const templates = new Map<Team, RigTemplate>();
  const gltf = makeGltfLoader();
  const loads: Promise<unknown>[] = [];
  /** The real weapon models, read from `assets/weapons/` (the URL's file name). */
  const weapons = new WeaponCache((url) => {
    const name = /\/weapons\/([^/?]+)\.glb/.exec(url)![1];
    const load = fileUrl(`${ASSETS}/weapons/${decodeURIComponent(name)}.glb`)
      .then((u) => gltf.loadAsync(u))
      .then((g) => g.scene);
    loads.push(load.catch(() => null));
    return load;
  });
  /** Each model's box in its own frame, from the cache's copy. */
  const boxes = new Map<string, THREE.Box3>();

  beforeAll(async () => {
    installBrowserShims();
    for (const [team, file] of [
      [2, 't'],
      [3, 'ct'],
    ] as const) {
      const url = await fileUrl(`${ASSETS}/players/${file}.glb`);
      const t0 = performance.now();
      templates.set(team, await loadRigTemplate(url));
      if (LOG)
        console.log(
          `${file}.glb parsed in ${(performance.now() - t0).toFixed(0)} ms`
        );
    }
    for (const team of [2, 3] as Team[])
      for (const weapon of HELD) {
        const name = weaponModelName(weapon, team);
        if (name) weapons.get(name);
      }
    await Promise.all(loads);
    for (const team of [2, 3] as Team[])
      for (const weapon of HELD) {
        const name = weaponModelName(weapon, team);
        const model = name ? weapons.get(name) : null;
        if (!name || !model || boxes.has(name)) continue;
        model.updateMatrixWorld(true);
        boxes.set(name, new THREE.Box3().setFromObject(model));
      }
  }, 60_000);

  it.each(HELD)('holds %s in the right hand', (weapon) => {
    for (const team of [2, 3] as Team[]) {
      if (team === 3 && weapon === 'c4') continue;
      const rig = new PlayerRig(templates.get(team)!, team);
      rig.apply(input(weapon, team), HEADER);
      const h = hands(rig);
      if (LOG)
        console.log(
          team,
          weapon.padEnd(13),
          'R',
          h.toR.toFixed(2),
          'L',
          h.toL.toFixed(2),
          'wpn y',
          h.wpn.y.toFixed(2)
        );
      expect(h.toR).toBeLessThan(0.3);
      if (weapon === 'c4') expect(h.toL).toBeLessThan(0.35);
    }
  });

  // The models are Y up with the barrel along +Z (the glTF export); `wpn` is the game's frame,
  // X forward and Z up. Held as they are, every gun stood on end with its muzzle in the air.
  it.each(Object.keys(WEAPON_CLIP_SUFFIX))(
    'points %s where the player faces, in the hands',
    (weapon) => {
      for (const team of [2, 3] as Team[]) {
        const name = weaponModelName(weapon, team)!;
        const box = boxes.get(name);
        expect(box, `${name}.glb`).toBeDefined();
        const rig = new PlayerRig(
          templates.get(team)!,
          team,
          undefined,
          weapons
        );
        rig.apply(input(weapon, team), HEADER);
        rig.object.updateMatrixWorld(true);
        const held = heldModel(rig)!;
        expect(held).not.toBeNull();
        const barrel = new THREE.Vector3(0, 0, 1).transformDirection(
          held.matrixWorld
        );
        const facing = new THREE.Vector3(0, 0, 1).transformDirection(
          rig.object.matrixWorld
        );
        const up = new THREE.Vector3(0, 1, 0).transformDirection(
          held.matrixWorld
        );
        // The wrists in the model's own frame, against its box.
        const toModel = held.matrixWorld.clone().invert();
        const gap = (bone: string) =>
          box!.distanceToPoint(where(rig, bone).applyMatrix4(toModel));
        if (LOG)
          console.log(
            team,
            weapon.padEnd(13),
            'barrel',
            angle(barrel, facing).toFixed(0),
            'up',
            angle(up, new THREE.Vector3(0, 1, 0)).toFixed(0),
            'R',
            gap('hand_R').toFixed(3),
            'L',
            gap('hand_L').toFixed(3)
          );
        expect(angle(barrel, facing)).toBeLessThan(10);
        // The machine guns' idles carry them tilted up a little (M249 14°, Negev 9°).
        expect(angle(up, new THREE.Vector3(0, 1, 0))).toBeLessThan(20);
        // A wrist is a few centimetres short of a pistol's small grip; the Dual Berettas'
        // model is the right-hand pistol with the left one beside it.
        expect(gap('hand_R')).toBeLessThan(weapon === 'elite' ? 0.13 : 0.07);
        if (familyOf(weapon) === 'rifle')
          expect(gap('hand_L')).toBeLessThan(0.06);
      }
    }
  );

  it.each(['knife', 'c4', ...HELD.filter((w) => familyOf(w) === 'grenade')])(
    'holds %s in the hand',
    (weapon) => {
      for (const team of [2, 3] as Team[]) {
        if (team === 3 && weapon === 'c4') continue;
        const name = weaponModelName(weapon, team)!;
        const box = boxes.get(name)!;
        const rig = new PlayerRig(
          templates.get(team)!,
          team,
          undefined,
          weapons
        );
        rig.apply(input(weapon, team), HEADER);
        rig.object.updateMatrixWorld(true);
        const held = heldModel(rig)!;
        const toModel = held.matrixWorld.clone().invert();
        const gap = (bone: string) =>
          box.distanceToPoint(where(rig, bone).applyMatrix4(toModel));
        if (LOG)
          console.log(
            team,
            weapon.padEnd(13),
            'R',
            gap('hand_R').toFixed(3),
            'L',
            gap('hand_L').toFixed(3)
          );
        // A grenade sits in the palm, a hand's breadth from the wrist.
        expect(gap('hand_R')).toBeLessThan(
          weapon === 'knife' || weapon === 'c4' ? 0.06 : 0.1
        );
        if (weapon === 'c4') expect(gap('hand_L')).toBeLessThan(0.1);
      }
    }
  );

  it.each(Object.keys(WEAPON_CLIP_SUFFIX))(
    'keeps the hands on %s through a shot',
    (weapon) => {
      const rig = new PlayerRig(templates.get(2)!, 2);
      const clip = weaponClip('shoot', weapon)!;
      rig.apply(input(weapon, 2), HEADER);
      const still = hands(rig);
      let worst = 0;
      for (const dt of [2, 4, 6, 8, 12]) {
        const shot: Action = {
          kind: 'shoot',
          clip,
          startTick: 1000,
          durationTicks: 13,
          additive: false,
          upperBody: true,
        };
        rig.apply(input(weapon, 2, [shot], 1000 + dt), HEADER);
        const h = hands(rig);
        expect(h.toR).toBeLessThan(0.3);
        worst = Math.max(worst, h.r.distanceTo(still.r));
      }
      if (LOG)
        console.log(
          weapon.padEnd(13),
          clip.padEnd(20),
          'right hand moves at most',
          worst.toFixed(3)
        );
      expect(worst).toBeLessThan(0.15);
    }
  );

  it('plants with the c4 in the hands and throws a grenade from the right hand', () => {
    const rig = new PlayerRig(templates.get(2)!, 2);
    const plant: Action = {
      kind: 'plant',
      clip: 'planting',
      startTick: 1000,
      durationTicks: 192,
      additive: false,
      upperBody: false,
    };
    rig.apply(input('c4', 2, [plant], 1000 + 64), HEADER);
    const p = hands(rig);
    const throwIt: Action = {
      kind: 'throw',
      clip: 'throw_overhand_grenade',
      startTick: 1000,
      durationTicks: 40,
      additive: false,
      upperBody: true,
    };
    rig.apply(input('hegrenade', 2, [throwIt], 1000 + 8), HEADER);
    const t = hands(rig);
    if (LOG)
      console.log(
        'plant R',
        p.toR.toFixed(2),
        'L',
        p.toL.toFixed(2),
        '| throw R',
        t.toR.toFixed(2)
      );
    expect(p.toR).toBeLessThan(0.3);
    expect(t.toR).toBeLessThan(0.3);
  });

  it('plays each stride at the speed its planted foot moves, so the feet do not slide', () => {
    const rig = new PlayerRig(templates.get(3)!, 3);
    const clips = [...templates.get(3)!.clips.keys()].filter((c) =>
      /^(run|walk|crouch)_[ns]_rifle$/.test(c)
    );
    expect(clips).toHaveLength(6);
    for (const clip of clips) {
      const d = templates.get(3)!.clips.get(clip)!.duration;
      // Each ankle over one loop, in the rig's frame (it faces +z).
      const N = 240;
      const path = new Map<string, THREE.Vector3[]>();
      for (let i = 0; i < N; i++) {
        const inp = input('ak47', 3);
        inp.locomotion = [{ clip, weight: 1, time: (i / N) * d }];
        rig.apply(inp, HEADER);
        for (const b of ['ankle_L', 'ankle_R']) {
          const list = path.get(b) ?? [];
          list.push(where(rig, b));
          path.set(b, list);
        }
      }
      // The planted foot: within 1.5 cm of the ankle's lowest point. It moves back along z
      // at the clip's own ground speed; the median over those frames, in units per second.
      const speeds: number[] = [];
      for (const list of path.values()) {
        const low = Math.min(...list.map((p) => p.y));
        for (let i = 0; i < N; i++) {
          const a = list[i];
          const b = list[(i + 1) % N];
          if (a.y < low + 0.015 && b.y < low + 0.015)
            speeds.push(Math.abs(b.z - a.z) / (d / N) / 0.0254);
        }
      }
      speeds.sort((a, b) => a - b);
      const ground = speeds[speeds.length >> 1];
      const gait = clip.split('_')[0] as keyof typeof STRIDE_SPEED;
      if (LOG)
        console.log(
          `${clip}: planted foot ${ground.toFixed(0)} u/s, STRIDE_SPEED ${STRIDE_SPEED[gait]}`
        );
      // Played at distance / STRIDE_SPEED, the planted foot slides by the difference.
      expect(Math.abs(ground / STRIDE_SPEED[gait] - 1)).toBeLessThan(0.06);
    }
  });
});
