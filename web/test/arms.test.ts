// The first-person arms (scene/arms.ts): where the rig sits from the eye, how it plays a
// weapon's clips (set, never advanced), the guns in its hands, and the cache that fetches the
// arms and clip files. The last block runs on the real files (`assets/viewmodels/`, gated on
// ASSETS_DIR) and checks the rig against the spike's measurements.

import * as THREE from 'three';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ARMS_OFFSET,
  ArmsCache,
  ArmsRig,
  armsSide,
  clipSetFrom,
  keepWhere,
  placeRig,
  rigPosition,
  type ClipSet,
  type LoadedGltf,
} from '../src/scene/arms';
import { makeGltfLoader } from '../src/scene/loaders';
import { UNLIT_LOOK } from '../src/scene/look';
import { fileUrl, installBrowserShims } from './helpers/node-gltf';
import { needs } from './helpers/gates';

const ASSETS = process.env.ASSETS_DIR;
/** root_motion's rest rotation: the export's axis swap, game (X ahead, Y left, Z up) to glTF. */
const SWAP = new THREE.Quaternion(-0.5, -0.5, -0.5, 0.5);

function node(name: string, parent: THREE.Object3D): THREE.Object3D {
  const n = new THREE.Object3D();
  n.name = name;
  parent.add(n);
  return n;
}

/**
 * A viewmodel skeleton like the files': `viewmodel` → `root_motion` (the eye) → `wpn` and a
 * hand, plus a mesh to dress.
 */
function skeleton(extra: string[] = []): THREE.Group {
  const scene = new THREE.Group();
  const rm = node('root_motion', node('viewmodel', scene));
  rm.quaternion.copy(SWAP);
  const wpn = node('wpn', rm);
  wpn.position.set(0.4318, 0, 0);
  node('hand_R', rm).position.set(0.3, -0.13, -0.1);
  for (const n of extra) node(n, wpn).position.set(0, 0.508, 0);
  scene.add(
    new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
  );
  return scene;
}

const track = (
  bone: string,
  prop: string,
  times: number[],
  values: number[]
) =>
  prop === 'quaternion'
    ? new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, values)
    : new THREE.VectorKeyframeTrack(`${bone}.${prop}`, times, values);

/** An AK-like clip file: a single-pose idle and a shot that pushes `wpn` back and turns the hand. */
function akFile(): LoadedGltf {
  return {
    scene: skeleton(),
    animations: [
      new THREE.AnimationClip('idle', -1, [
        track('wpn', 'position', [0], [0.375, -0.132, -0.063]),
      ]),
      new THREE.AnimationClip('shoot', -1, [
        track(
          'wpn',
          'position',
          [0, 0.5],
          [0.375, -0.132, -0.063, 0.325, -0.132, -0.063]
        ),
        track(
          'hand_R',
          'quaternion',
          [0, 0.5],
          [0, 0, 0, 1, 0, 0, 0.7071068, 0.7071068]
        ),
      ]),
    ],
  };
}

function worldOf(o: THREE.Object3D): number[] {
  o.updateWorldMatrix(true, false);
  return o
    .getWorldPosition(new THREE.Vector3())
    .toArray()
    .map((v) => +v.toFixed(4));
}

describe('rig placement', () => {
  it("is CS2's viewmodel_offset (inches right, ahead, up) in the camera's frame", () => {
    expect(ARMS_OFFSET).toEqual({ x: 2, y: 2, z: -2 });
    expect(rigPosition().map((v) => +v.toFixed(4))).toEqual([
      0.0508, -0.0508, -0.0508,
    ]);
    expect(rigPosition({ x: 0, y: 0, z: 0 })).toEqual([0, 0, -0]);
    expect(rigPosition({ x: 1, y: 0, z: 0 })[0]).toBeCloseTo(0.0254, 9);
  });

  it('turns the skeleton (looking down +Z, +X left) to the camera (−Z ahead, +X right)', () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    const set = clipSetFrom(akFile());
    placeRig(rig.root, { x: 0, y: 0, z: 0 }, 0);
    rig.pose(set, [{ clip: 'idle', time: 0, weight: 1 }]);
    // wpn 0.375 ahead, 0.132 right and 0.063 below the eye (game axes) is (0.132, −0.063, −0.375).
    expect(worldOf(rig.bone('wpn')!)).toEqual([0.132, -0.063, -0.375]);
    placeRig(rig.root, ARMS_OFFSET, 0.006);
    expect(worldOf(rig.bone('wpn')!)).toEqual([0.1828, -0.1078, -0.4258]);
  });
});

describe('ArmsRig', () => {
  it('dresses the arms in the look', () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    const meshes: THREE.Mesh[] = [];
    rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes).toHaveLength(1);
    expect(meshes[0].material).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(meshes[0].frustumCulled).toBe(false);
  });

  it('sets each clip to the time and weight it is given, and nothing carries over', () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    const set = clipSetFrom(akFile());
    placeRig(rig.root, { x: 0, y: 0, z: 0 }, 0);
    const hand = rig.bone('hand_R')!;
    rig.pose(set, [{ clip: 'shoot', time: 0.5, weight: 1 }]);
    expect(worldOf(rig.bone('wpn')!)[2]).toBeCloseTo(-0.325, 4);
    expect(hand.quaternion.z).toBeCloseTo(0.7071068, 5);
    // Half and half: halfway between the poses.
    rig.pose(set, [
      { clip: 'idle', time: 0, weight: 0.5 },
      { clip: 'shoot', time: 0.5, weight: 0.5 },
    ]);
    expect(worldOf(rig.bone('wpn')!)[2]).toBeCloseTo(-0.35, 4);
    // Back to the idle: the hand, which only the shot moves, is at rest again.
    rig.pose(set, [{ clip: 'idle', time: 0, weight: 1 }]);
    expect(worldOf(rig.bone('wpn')!)[2]).toBeCloseTo(-0.375, 4);
    expect(hand.quaternion.toArray()).toEqual([0, 0, 0, 1]);
    // And a pose is the same whatever came before it.
    rig.pose(set, [{ clip: 'shoot', time: 0.25, weight: 1 }]);
    const a = worldOf(rig.bone('wpn')!);
    const fresh = new ArmsRig(skeleton(), UNLIT_LOOK);
    placeRig(fresh.root, { x: 0, y: 0, z: 0 }, 0);
    fresh.pose(set, [{ clip: 'shoot', time: 0.25, weight: 1 }]);
    expect(worldOf(fresh.bone('wpn')!)).toEqual(a);
  });

  it("takes the bones a clip file has and the arms lack (the Dual Berettas' hands)", () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    expect(rig.bone('weapon_hand_l')).toBeUndefined();
    const set: ClipSet = clipSetFrom({
      scene: skeleton(['weapon_hand_l']),
      animations: [
        new THREE.AnimationClip('idle', -1, [
          track('weapon_hand_l', 'position', [0], [0.3, 0.1, 0]),
        ]),
      ],
    });
    rig.pose(set, [{ clip: 'idle', time: 0, weight: 1 }]);
    const left = rig.bone('weapon_hand_l')!;
    expect(left.parent?.name).toBe('wpn');
    expect(left.position.toArray().map((v) => +v.toFixed(6))).toEqual([
      0.3, 0.1, 0,
    ]);
  });

  it('holds the gun on wpn by its weapon bone, one at a time, made once', () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    rig.pose(clipSetFrom(akFile()), [{ clip: 'idle', time: 0, weight: 1 }]);
    const attach = {
      translation: [0, 0.076, 0.075],
      rotation: [-0.5, -0.5, -0.5, 0.5],
    };
    const model = (n: number) =>
      Object.assign(new THREE.Group(), { userData: { attach } }).add(
        new THREE.Mesh(
          new THREE.BoxGeometry(n, n, n),
          new THREE.MeshStandardMaterial()
        )
      );
    const ak = model(1);
    const glock = model(0.5);
    rig.hold('ak47', ak, 'rifle');
    const wpn = rig.bone('wpn')!;
    const held = () => wpn.children.filter((c) => c.visible).map((c) => c.name);
    expect(held()).toEqual(['weapon:ak47']);
    const gun = wpn.children[0];
    // The model's weapon bone sits on wpn.
    gun.updateMatrixWorld(true);
    const bone = new THREE.Vector3(0, 0.076, 0.075).applyMatrix4(gun.matrix);
    bone.toArray().forEach((v) => expect(v).toBeCloseTo(0, 6));
    rig.hold('glock', glock, 'pistol');
    expect(held()).toEqual(['weapon:glock']);
    rig.hold('ak47', ak, 'rifle');
    expect(held()).toEqual(['weapon:ak47']);
    expect(wpn.children).toHaveLength(2);
    rig.hold(null, null, 'rifle');
    expect(held()).toEqual([]);
  });

  it('frees its materials and cut geometry, not the shared models', () => {
    const rig = new ArmsRig(skeleton(), UNLIT_LOOK);
    const mesh = rig.root.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const freed = vi.fn();
    (mesh.material as THREE.Material).addEventListener('dispose', freed);
    rig.dispose();
    expect(freed).toHaveBeenCalledTimes(1);
  });
});

describe('keepWhere', () => {
  it('keeps the triangles whose corners pass and hides a mesh with none', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0.5, 0, 0, 0.6, 0, 0, 0.5, 0.1, 0],
        3
      )
    );
    g.setIndex([0, 1, 2, 3, 4, 5]);
    const o = new THREE.Group();
    const near = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    const far = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
    far.position.set(2, 0, 0);
    o.add(near, far);
    const owned: THREE.BufferGeometry[] = [];
    // Within 0.25 m of the origin, in the group's frame.
    keepWhere(o, (p) => p.length() < 0.25, owned);
    expect(Array.from(near.geometry.index!.array)).toEqual([0, 1, 2]);
    expect(near.geometry).not.toBe(g);
    expect(owned).toEqual([near.geometry]);
    expect(far.visible).toBe(false);
    // The source geometry is untouched.
    expect(g.index!.count).toBe(6);
  });
});

describe('ArmsCache', () => {
  function cache(fail: (url: string) => boolean = () => false) {
    const urls: string[] = [];
    const c = new ArmsCache(async (url) => {
      urls.push(url);
      if (fail(url)) throw new Error('404');
      return akFile();
    });
    return { c, urls };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const MANIFEST = {
    arms: { ct: { sha256: 'aaaaaaaa11' }, t: { sha256: 'bbbbbbbb22' } },
    weapons: { ak47: { sha256: 'cccccccc33', clips: ['idle', 'shoot'] } },
  };

  it('asks for nothing until the manifest is in, then each file once, versioned', async () => {
    const { c, urls } = cache();
    const loaded = vi.fn();
    c.onLoad = loaded;
    expect(c.armsFor(3)).toBeNull();
    expect(urls).toEqual([]);
    c.setManifest(MANIFEST);
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(c.armsFor(3)).toBeNull();
    expect(c.armsFor(3)).toBeNull();
    expect(c.clips('ak47')).toBeNull();
    expect(urls).toEqual([
      '/viewmodels/arms_ct.glb?v=aaaaaaaa',
      '/viewmodels/ak47.glb?v=cccccccc',
    ]);
    await settle();
    expect(loaded).toHaveBeenCalledTimes(3);
    expect(c.armsFor(3)).toBeInstanceOf(THREE.Group);
    const set = c.clips('ak47')!;
    expect([...set.clips.keys()]).toEqual(['idle', 'shoot']);
    expect(set.lengths).toEqual({ idle: 0, shoot: 0.5 });
    expect(urls).toHaveLength(2);
  });

  it('a file the manifest lacks, a failed load and no manifest at all give null, asked for once at most', async () => {
    const { c, urls } = cache((u) => u.includes('arms_t'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    c.setManifest(MANIFEST);
    expect(c.clips('m4a4')).toBeNull();
    expect(c.armsFor(2)).toBeNull();
    expect(c.armsFor(0)).toBeNull();
    await settle();
    expect(c.armsFor(2)).toBeNull();
    expect(c.clips('m4a4')).toBeNull();
    expect(urls).toEqual(['/viewmodels/arms_t.glb?v=bbbbbbbb']);
    const none = cache();
    none.c.setManifest(null);
    expect(none.c.armsFor(3)).toBeNull();
    expect(none.c.clips('ak47')).toBeNull();
    expect(none.urls).toEqual([]);
  });

  it('maps teams to the arms files', () => {
    expect([armsSide(2), armsSide(3), armsSide(0), armsSide(1)]).toEqual([
      't',
      'ct',
      null,
      null,
    ]);
  });
});

const GATE = needs('the rig on the real files', 'ASSETS_DIR');
describe.skipIf(!ASSETS)(GATE, () => {
  const files = new Map<string, LoadedGltf>();
  beforeAll(async () => {
    installBrowserShims();
    const gl = makeGltfLoader();
    for (const f of [
      'viewmodels/arms_ct.glb',
      'viewmodels/arms_t.glb',
      'viewmodels/ak47.glb',
      'viewmodels/elite.glb',
      'viewmodels/molotov.glb',
      'weapons/ak47.glb',
      'weapons/elite.glb',
      'weapons/molotov.glb',
    ])
      files.set(f, await gl.loadAsync(await fileUrl(`${ASSETS}/${f}`)));
  }, 60_000);

  function rigFor(side: string, weapon: string, clip: string, time = 0) {
    const rig = new ArmsRig(
      files.get(`viewmodels/arms_${side}.glb`)!.scene,
      UNLIT_LOOK
    );
    placeRig(rig.root, { x: 0, y: 0, z: 0 }, 0);
    rig.pose(clipSetFrom(files.get(`viewmodels/${weapon}.glb`)!), [
      { clip: clip as 'idle', time, weight: 1 },
    ]);
    rig.hold(
      weapon,
      files.get(`weapons/${weapon}.glb`)!.scene,
      weapon === 'elite' ? 'pistol' : weapon === 'molotov' ? 'grenade' : 'rifle'
    );
    rig.root.updateMatrixWorld(true);
    return rig;
  }

  it.each(['ct', 't'])(
    "%s: the AK's idle puts wpn where the spike measured it, the hands on the gun",
    (side) => {
      const rig = rigFor(side, 'ak47', 'idle');
      const wpn = rig.bone('wpn')!.getWorldPosition(new THREE.Vector3());
      // 0.132 m right, 0.063 m down, 0.375 m ahead of the eye with no offset.
      expect(wpn.x).toBeCloseTo(0.132, 2);
      expect(wpn.y).toBeCloseTo(-0.063, 2);
      expect(wpn.z).toBeCloseTo(-0.375, 2);
      for (const h of ['hand_R', 'hand_L']) {
        const p = rig.bone(h)!.getWorldPosition(new THREE.Vector3());
        expect(p.distanceTo(wpn)).toBeLessThan(0.3);
        expect(p.z).toBeLessThan(-0.1);
      }
    }
  );

  it('a shot kicks the gun away from where the idle holds it', () => {
    const idle = rigFor('ct', 'ak47', 'idle')
      .bone('wpn')!
      .getWorldPosition(new THREE.Vector3());
    const kick = rigFor('ct', 'ak47', 'shoot', 0.05)
      .bone('wpn')!
      .getWorldPosition(new THREE.Vector3());
    expect(kick.distanceTo(idle)).toBeGreaterThan(0.005);
  });

  it('the Dual Berettas: a pistol in each hand, both pointing ahead and upright', () => {
    const rig = rigFor('t', 'elite', 'idle');
    const guns: THREE.Object3D[] = [];
    rig.root.traverse((o) => {
      if (/^weapon:elite(:left)?$/.test(o.name)) guns.push(o);
    });
    expect(guns).toHaveLength(2);
    for (const g of guns) {
      const q = g.getWorldQuaternion(new THREE.Quaternion());
      // The models face +Z with +Y up.
      expect(new THREE.Vector3(0, 0, 1).applyQuaternion(q).z).toBeLessThan(
        -0.8
      );
      expect(new THREE.Vector3(0, 1, 0).applyQuaternion(q).y).toBeGreaterThan(
        0.8
      );
    }
    const right = rig.bone('hand_R')!.getWorldPosition(new THREE.Vector3());
    const left = rig.bone('hand_L')!.getWorldPosition(new THREE.Vector3());
    expect(right.x).toBeGreaterThan(0.05);
    expect(left.x).toBeLessThan(-0.05);
  });

  it('the molotov: the bottle in the right hand, the lighter in the left, none at the eye', () => {
    const rig = rigFor('t', 'molotov', 'idle');
    const at = (name: string) => {
      let o: THREE.Object3D | undefined;
      rig.root.traverse((c) => {
        if (c.name === name) o = c;
      });
      return o!;
    };
    const centre = (o: THREE.Object3D) => {
      // The drawn triangles' corners only: the cut keeps every vertex.
      const b = new THREE.Box3();
      const v = new THREE.Vector3();
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (!m.isMesh || !m.visible || !m.geometry.index) return;
        const pos = m.geometry.getAttribute('position');
        const ix = m.geometry.index;
        for (let i = 0; i < ix.count; i++)
          b.expandByPoint(
            v.fromBufferAttribute(pos, ix.getX(i)).applyMatrix4(m.matrixWorld)
          );
      });
      return b.getCenter(new THREE.Vector3());
    };
    const hand = (n: string) =>
      rig.bone(n)!.getWorldPosition(new THREE.Vector3());
    const bottle = centre(at('weapon:molotov'));
    const lighter = centre(at('weapon:molotov:left'));
    expect(bottle.distanceTo(hand('hand_R'))).toBeLessThan(0.15);
    expect(lighter.distanceTo(hand('hand_L'))).toBeLessThan(0.15);
    expect(bottle.length()).toBeGreaterThan(0.2);
  });
});
