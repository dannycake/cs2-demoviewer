import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { FLAG } from '../src/pack/types';
import type { RigInput } from '../src/scene/frame';
import type { RigTemplate } from '../src/scene/loaders';
import { PlayerRig } from '../src/scene/PlayerRig';
import { WeaponCache } from '../src/scene/weapons';
import { newPlayerState } from '../src/sim/sample';
import { familyOf } from '../src/sim/weapons';

const HEADER = { tick_rate: 64 };
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A body with the bones a rig holds weapons on: `wpn` (in hand) and `spine_3` (the back). */
function template(): RigTemplate {
  const root = new THREE.Group();
  const bone = (name: string) => Object.assign(new THREE.Bone(), { name });
  const pelvis = bone('pelvis');
  const spine = bone('spine_3');
  const wpn = bone('wpn');
  root.add(pelvis);
  pelvis.add(spine, wpn);
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
  const body = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
  root.add(body);
  root.updateMatrixWorld(true);
  body.bind(new THREE.Skeleton([pelvis, spine, wpn]));
  const idle = new THREE.AnimationClip('idle_rifle', 1, []);
  return {
    scene: root,
    clips: new Map([[idle.name, idle]]),
    variants: new Map(),
  };
}

/** A cache whose every model is a white box, loaded at once. */
async function loadedCache(names: string[]) {
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const cache = new WeaponCache(async () => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geometry, material));
    return g;
  });
  for (const n of names) cache.get(n);
  await flush();
  return { cache, geometry, material };
}

function input(
  weapon: string,
  o: Partial<RigInput> & { bomb?: boolean } = {}
): RigInput {
  const flags = FLAG.alive | (o.bomb ? FLAG.bomb : 0);
  return {
    state: { ...newPlayerState(), present: true, flags, health: 100 },
    team: 2,
    tick: 1000,
    clipTime: 0,
    deathTicks: null,
    death: null,
    actions: [],
    weapon,
    family: familyOf(weapon),
    locomotion: [{ clip: 'idle_rifle', weight: 1, time: null }],
    ...o,
  };
}

const shown = (bone: THREE.Object3D) =>
  bone.children
    .filter((c) => c.name.startsWith('weapon:') && c.visible)
    .map((c) => c.name);

describe('PlayerRig weapons', () => {
  it("holds the weapon's model on wpn from the frame it arrives, one at a time", async () => {
    const calls = vi.fn();
    const cache = new WeaponCache(async (url) => {
      calls(url);
      return new THREE.Group();
    });
    const rig = new PlayerRig(template(), 2, undefined, cache);
    const wpn = rig.bone('wpn')!;
    rig.apply(input('ak47'), HEADER);
    expect(shown(wpn)).toEqual([]);
    await flush();
    rig.apply(input('ak47'), HEADER);
    expect(shown(wpn)).toEqual(['weapon:ak47']);
    rig.apply(input('deagle'), HEADER);
    await flush();
    rig.apply(input('deagle'), HEADER);
    expect(shown(wpn)).toEqual(['weapon:deagle']);
    rig.apply(input('ak47'), HEADER);
    expect(shown(wpn)).toEqual(['weapon:ak47']);
    // The clone is kept: switching back does not load or clone again.
    expect(calls).toHaveBeenCalledTimes(2);
    expect(wpn.children.filter((c) => c.name === 'weapon:ak47')).toHaveLength(
      1
    );
  });

  // The game puts a model's `weapon` bone on the hand's `wpn`; the export keeps that bone's
  // rest pose as `userData.attach` (the M4A4's here: 56 cm from the model's origin).
  it("hangs the model from wpn by its weapon bone's rest pose", async () => {
    const attach = {
      translation: [-0.005, 0.315, 0.463],
      rotation: [-0.5, -0.5, -0.5, 0.5],
    };
    const cache = new WeaponCache(async (url) =>
      Object.assign(new THREE.Group(), {
        userData: url.includes('m4a4') ? { attach } : {},
      })
    );
    const rig = new PlayerRig(template(), 3, undefined, cache);
    const wpn = rig.bone('wpn')!;
    rig.apply(input('m4a4', { team: 3 }), HEADER);
    rig.apply(input('glock', { team: 3 }), HEADER);
    await flush();
    rig.apply(input('m4a4', { team: 3 }), HEADER);
    const m4 = wpn.children.find((c) => c.name === 'weapon:m4a4')!;
    m4.updateMatrix();
    const bone = new THREE.Matrix4().compose(
      new THREE.Vector3(...attach.translation),
      new THREE.Quaternion(...attach.rotation),
      new THREE.Vector3(1, 1, 1)
    );
    // Held × bone is the identity: the model's weapon bone sits exactly on wpn.
    const held = m4.matrix.clone().multiply(bone);
    held.elements.forEach((v, k) =>
      expect(v).toBeCloseTo(new THREE.Matrix4().elements[k], 6)
    );
    // A model without the pose (an asset set from before it) is only turned into the game's axes.
    rig.apply(input('glock', { team: 3 }), HEADER);
    const glock = wpn.children.find((c) => c.name === 'weapon:glock')!;
    expect(glock.position.toArray()).toEqual([0, 0, 0]);
    expect(
      glock.quaternion.angleTo(new THREE.Quaternion(0.5, 0.5, 0.5, 0.5))
    ).toBeLessThan(1e-6);
  });

  it('gives a T the T knife and holds nothing for no weapon', async () => {
    const { cache } = await loadedCache(['knife_t']);
    const rig = new PlayerRig(template(), 2, undefined, cache);
    const wpn = rig.bone('wpn')!;
    rig.apply(input('knife'), HEADER);
    expect(shown(wpn)).toEqual(['weapon:knife_t']);
    rig.apply(input('none'), HEADER);
    expect(shown(wpn)).toEqual([]);
  });

  it('wears the c4 on the back while the carrier holds something else', async () => {
    const { cache } = await loadedCache(['ak47', 'c4']);
    const rig = new PlayerRig(template(), 2, undefined, cache);
    const back = rig.bone('spine_3')!;
    const wpn = rig.bone('wpn')!;
    rig.apply(input('ak47', { bomb: true }), HEADER);
    expect(shown(back)).toEqual(['weapon:c4']);
    rig.apply(input('c4', { bomb: true }), HEADER);
    expect(shown(back)).toEqual([]);
    expect(shown(wpn)).toEqual(['weapon:c4']);
    rig.apply(input('ak47'), HEADER);
    expect(shown(back)).toEqual([]);
  });

  it('drops the weapon and the c4 while dying', async () => {
    const { cache } = await loadedCache(['ak47', 'c4']);
    const rig = new PlayerRig(template(), 2, undefined, cache);
    rig.apply(input('ak47', { bomb: true, deathTicks: 10 }), HEADER);
    expect(shown(rig.bone('wpn')!)).toEqual([]);
    expect(shown(rig.bone('spine_3')!)).toEqual([]);
  });

  it('says where its shots leave the gun in its hand (its muzzle in the scene), none before the model is in or while dying', async () => {
    const { cache } = await loadedCache(['ak47', 'deagle']);
    const rig = new PlayerRig(template(), 2, undefined, cache);
    const out = new THREE.Vector3();
    expect(rig.muzzle(out)).toBe(false);
    rig.apply(input('ak47'), HEADER);
    expect(rig.muzzle(out)).toBe(true);
    // The cache's models are unit boxes: the front end's middle is (0, 0, 0.5) in the model.
    const gun = rig
      .bone('wpn')!
      .children.find((c) => c.name === 'weapon:ak47')!;
    gun.updateWorldMatrix(true, false);
    const want = new THREE.Vector3(0, 0, 0.5).applyMatrix4(gun.matrixWorld);
    expect(out.distanceTo(want)).toBeLessThan(1e-6);
    rig.apply(input('m4a4'), HEADER);
    expect(rig.muzzle(out)).toBe(false);
    rig.apply(input('ak47', { deathTicks: 10 }), HEADER);
    expect(rig.muzzle(out)).toBe(false);
  });

  it("fires the Dual Berettas from the right-hand pistol's muzzle", async () => {
    const cache = new WeaponCache(async () => {
      const g = new THREE.Group();
      g.userData = {
        attach: { translation: [0, 0, 0], rotation: [-0.5, -0.5, -0.5, 0.5] },
      };
      // The right hand's pistol on the bone, the left's 0.508 m to its left (the model's +X).
      for (const x of [0, 0.508]) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.1, 0.3));
        m.position.set(x, 0, 0);
        g.add(m);
      }
      return g;
    });
    cache.get('elite');
    await flush();
    const rig = new PlayerRig(template(), 2, undefined, cache);
    rig.apply(input('elite'), HEADER);
    const out = new THREE.Vector3();
    expect(rig.muzzle(out)).toBe(true);
    const gun = rig
      .bone('wpn')!
      .children.find((c) => c.name === 'weapon:elite')!;
    gun.updateWorldMatrix(true, false);
    const right = new THREE.Vector3(0, 0, 0.15).applyMatrix4(gun.matrixWorld);
    const left = new THREE.Vector3(0.508, 0, 0.15).applyMatrix4(
      gun.matrixWorld
    );
    expect(out.distanceTo(right)).toBeLessThan(1e-6);
    expect(out.distanceTo(left)).toBeGreaterThan(0.5);
  });

  it("dresses the weapon in the rig's own untinted materials and frees only those", async () => {
    const { cache, geometry, material } = await loadedCache(['ak47']);
    const rig = new PlayerRig(template(), 2, undefined, cache);
    rig.apply(input('ak47'), HEADER);
    const held = rig
      .bone('wpn')!
      .children.find((c) => c.name === 'weapon:ak47')!;
    const mesh = held.children[0] as THREE.Mesh;
    const own = mesh.material as THREE.MeshBasicMaterial;
    expect(own).not.toBe(material);
    expect(mesh.geometry).toBe(geometry);
    // The body is tinted by team; the weapon keeps its colour.
    expect(own.color.getHex()).toBe(0xffffff);
    const freedMaterial = vi.fn();
    const freedGeometry = vi.fn();
    own.addEventListener('dispose', freedMaterial);
    geometry.addEventListener('dispose', freedGeometry);
    rig.dispose();
    expect(freedMaterial).toHaveBeenCalledTimes(1);
    expect(freedGeometry).not.toHaveBeenCalled();
  });
});
