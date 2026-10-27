import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  BOB,
  DRAW_DROP,
  KICK,
  RELOAD,
  VIEWMODEL_FOV,
  VIEWMODEL_OFFSETS,
  Viewmodel,
  viewmodelPose,
  viewmodelToScene,
  type ViewmodelFrame,
  type ViewmodelInput,
} from '../src/scene/viewmodel';
import { ARMS_OFFSET, ArmsCache, rigPosition } from '../src/scene/arms';
import { UNLIT_LOOK } from '../src/scene/look';
import { makeProbeSample } from '../src/scene/probes';
import { WeaponCache } from '../src/scene/weapons';
import type { Action } from '../src/sim/actions';
import { verticalFov } from '../src/sim/scope';

const RATE = 64;
const DEG = Math.PI / 180;

function at(o: Partial<ViewmodelInput> = {}): ViewmodelInput {
  return {
    family: 'rifle',
    actions: [],
    tick: 1000,
    tickRate: RATE,
    stride: 0,
    scoped: false,
    alive: true,
    ...o,
  };
}

const act = (
  kind: Action['kind'],
  startTick: number,
  seconds: number
): Action => ({
  kind,
  clip: kind,
  startTick,
  durationTicks: seconds * RATE,
  additive: false,
  upperBody: true,
});

describe('viewmodelPose', () => {
  it("holds each family's weapon right of, below and ahead of the eye", () => {
    for (const family of [
      'rifle',
      'pistol',
      'knife',
      'grenade',
      'c4',
    ] as const) {
      const o = VIEWMODEL_OFFSETS[family];
      const p = viewmodelPose(at({ family }));
      expect(p.visible).toBe(true);
      expect(p.position).toEqual([o.right, -o.down, -o.forward]);
      expect(p.rotation).toEqual(o.turn.map((d) => (d * Math.PI) / 180));
    }
    // To the weapon bone: the AK's sits 7.6 cm above and 7.5 cm ahead of its model's origin.
    expect(VIEWMODEL_OFFSETS.rifle).toEqual({
      right: 0.141,
      down: 0.072,
      forward: 0.432,
      turn: [2, -5, 0],
    });
  });

  it('kicks back and up over 0.05 s on a shot and settles over the next 0.15 s', () => {
    const shot = [act('shoot', 1000, 0.2)];
    const idle = viewmodelPose(at());
    const peak = viewmodelPose(
      at({ actions: shot, tick: 1000 + KICK.riseS * RATE })
    );
    expect(peak.position[2] - idle.position[2]).toBeCloseTo(KICK.back, 6);
    expect(peak.rotation[0] - idle.rotation[0]).toBeCloseTo(
      KICK.upDeg * DEG,
      6
    );
    const half = viewmodelPose(
      at({ actions: shot, tick: 1000 + (KICK.riseS + KICK.settleS / 2) * RATE })
    );
    expect(half.position[2] - idle.position[2]).toBeCloseTo(KICK.back / 2, 6);
    const done = viewmodelPose(
      at({ actions: shot, tick: 1000 + (KICK.riseS + KICK.settleS) * RATE })
    );
    done.position.forEach((v, k) => expect(v).toBeCloseTo(idle.position[k], 9));
    expect(KICK).toEqual({
      back: 0.03,
      upDeg: 2.5,
      riseS: 0.05,
      settleS: 0.15,
    });
  });

  it('rises from below over a draw', () => {
    const idle = viewmodelPose(at());
    const draw = [act('draw', 1000, 0.6)];
    const start = viewmodelPose(at({ actions: draw, tick: 1000 }));
    expect(idle.position[1] - start.position[1]).toBeCloseTo(DRAW_DROP, 6);
    const mid = viewmodelPose(at({ actions: draw, tick: 1000 + 0.3 * RATE }));
    expect(mid.position[1]).toBeGreaterThan(start.position[1]);
    expect(mid.position[1]).toBeLessThan(idle.position[1]);
    expect(
      viewmodelPose(at({ actions: draw, tick: 1000 + 0.6 * RATE })).position
    ).toEqual(idle.position);
    expect(DRAW_DROP).toBe(0.25);
  });

  it('dips and tilts over a reload, deepest halfway', () => {
    const idle = viewmodelPose(at());
    const reload = [act('reload', 1000, 2.4)];
    const mid = viewmodelPose(at({ actions: reload, tick: 1000 + 1.2 * RATE }));
    expect(idle.position[1] - mid.position[1]).toBeCloseTo(RELOAD.dip, 6);
    expect(mid.rotation[2] - idle.rotation[2]).toBeCloseTo(
      RELOAD.tiltDeg * DEG,
      6
    );
    expect(RELOAD).toEqual({ dip: 0.08, tiltDeg: 20 });
  });

  it('bobs with the stride', () => {
    const idle = viewmodelPose(at());
    expect(
      viewmodelPose(at({ stride: 0.25 })).position[1] - idle.position[1]
    ).toBeCloseTo(BOB, 6);
    expect(BOB).toBe(0.006);
  });

  it('shows nothing while scoped or dead', () => {
    expect(viewmodelPose(at({ scoped: true })).visible).toBe(false);
    expect(viewmodelPose(at({ alive: false })).visible).toBe(false);
  });
});

/** A cache whose models are boxes, loaded at once; `taser` fails. */
async function cache() {
  const c = new WeaponCache(async (url) => {
    if (url.includes('taser')) throw new Error('404');
    const g = new THREE.Group();
    g.add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    );
    return g;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const n of ['ak47', 'knife_t', 'taser']) c.get(n);
  await new Promise((r) => setTimeout(r, 0));
  return c;
}

function fakeRenderer() {
  return {
    autoClear: true,
    clearDepth: vi.fn(),
    render: vi.fn(),
  } as unknown as THREE.WebGLRenderer & {
    clearDepth: ReturnType<typeof vi.fn>;
    render: ReturnType<typeof vi.fn>;
  };
}

describe('Viewmodel', () => {
  it('draws the held weapon at its pose over a cleared depth buffer, at 68° (4:3)', async () => {
    const vm = new Viewmodel(await cache(), UNLIT_LOOK);
    const pose = viewmodelPose(at());
    vm.set('ak47', 3, pose);
    const shown = vm.scene.children.filter(
      (c) => c.name.startsWith('weapon:') && c.visible
    );
    expect(shown.map((c) => c.name)).toEqual(['weapon:ak47']);
    expect(shown[0].position.toArray()).toEqual(pose.position);
    const r = fakeRenderer();
    vm.render(r, 16 / 9);
    expect(r.clearDepth).toHaveBeenCalledTimes(1);
    expect(r.render).toHaveBeenCalledWith(vm.scene, vm.camera);
    expect(r.autoClear).toBe(true);
    expect(vm.camera.fov).toBeCloseTo(verticalFov(VIEWMODEL_FOV), 6);
    expect(vm.camera.aspect).toBeCloseTo(16 / 9, 6);
  });

  // The pose is where the game holds the gun: its `weapon` bone (`userData.attach`), which sits
  // 56 cm from the M4A4 model's origin and 11 cm from the AK's.
  it("puts the model's weapon bone at the pose", async () => {
    const attach = {
      translation: [-0.005, 0.315, 0.463] as const,
      rotation: [-0.5, -0.5, -0.5, 0.5],
    };
    const c = new WeaponCache(async () =>
      Object.assign(new THREE.Group(), { userData: { attach } })
    );
    c.get('m4a4');
    await new Promise((r) => setTimeout(r, 0));
    const vm = new Viewmodel(c, UNLIT_LOOK);
    const pose = viewmodelPose(at());
    vm.set('m4a4', 3, pose);
    const m4 = vm.scene.children.find((o) => o.name === 'weapon:m4a4')!;
    m4.updateMatrixWorld(true);
    const bone = new THREE.Vector3(...attach.translation).applyMatrix4(
      m4.matrixWorld
    );
    bone
      .toArray()
      .forEach((v, k) => expect(v).toBeCloseTo(pose.position[k], 9));
  });

  it('gives a T the T knife, and draws nothing for no weapon, a failed model or a hidden pose', async () => {
    const vm = new Viewmodel(await cache(), UNLIT_LOOK);
    const visible = () =>
      vm.scene.children
        .filter((c) => c.name.startsWith('weapon:') && c.visible)
        .map((c) => c.name);
    vm.set('knife', 2, viewmodelPose(at({ family: 'knife' })));
    expect(visible()).toEqual(['weapon:knife_t']);
    for (const [weapon, pose] of [
      ['none', viewmodelPose(at())],
      ['taser', viewmodelPose(at({ family: 'pistol' }))],
      ['ak47', viewmodelPose(at({ scoped: true }))],
    ] as const) {
      vm.set(weapon, 2, pose);
      expect(visible()).toEqual([]);
      const r = fakeRenderer();
      vm.render(r, 1);
      expect(r.render).not.toHaveBeenCalled();
    }
  });

  it('lights the weapon like the world, from where the view looks', () => {
    const vm = new Viewmodel(
      new WeaponCache(async () => new THREE.Group()),
      UNLIT_LOOK
    );
    const hemi = new THREE.HemisphereLight(0x112233, 0x445566, 0.7);
    const sun = new THREE.DirectionalLight(0xffeedd, 1.9);
    sun.position.set(10, 0, 0); // shining from +X
    sun.target.position.set(0, 0, 0);
    const view = new THREE.PerspectiveCamera();
    view.lookAt(1, 0, 0); // looking towards the sun
    view.updateMatrixWorld(true);
    vm.matchLights(hemi, sun, view);
    expect(vm.hemi.color.getHex()).toBe(0x112233);
    expect(vm.hemi.groundColor.getHex()).toBe(0x445566);
    expect(vm.hemi.intensity).toBe(0.7);
    expect(vm.sun.color.getHex()).toBe(0xffeedd);
    expect(vm.sun.intensity).toBe(1.9);
    // In the view's frame the sun is straight ahead: −Z.
    const dir = vm.sun.position.clone().sub(vm.sun.target.position).normalize();
    expect(dir.x).toBeCloseTo(0, 6);
    expect(dir.y).toBeCloseTo(0, 6);
    expect(dir.z).toBeCloseTo(-1, 6);
  });

  it("lights the gun from the shown player's grid sample, with the world's up turned into the view's frame", async () => {
    const vm = new Viewmodel(await cache(), {
      lit: true,
      smoothNormals: true,
      maxAnisotropy: 1,
    });
    vm.set('ak47', 3, viewmodelPose(at()));
    const gun = vm.scene.children.find((c) => c.name === 'weapon:ak47')!;
    const material = () =>
      (gun.children[0] as THREE.Mesh).material as THREE.MeshLambertMaterial;
    const s = makeProbeSample();
    vm.setProbe(s);
    vm.render(fakeRenderer(), 1);
    expect(material().customProgramCacheKey()).toBe('demoviewer-probe');
    // Looking straight down, the world's up points back out of the screen: +Z.
    const view = new THREE.PerspectiveCamera();
    view.rotation.x = -Math.PI / 2;
    view.updateMatrixWorld(true);
    vm.matchLights(
      new THREE.HemisphereLight(),
      new THREE.DirectionalLight(),
      view
    );
    expect(vm.zenith.x).toBeCloseTo(0, 6);
    expect(vm.zenith.y).toBeCloseTo(0, 6);
    expect(vm.zenith.z).toBeCloseTo(1, 6);
    const src = THREE.ShaderLib.lambert;
    const shader = {
      uniforms: THREE.UniformsUtils.clone(src.uniforms),
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    material().onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
    expect(shader.uniforms.probeZenith.value).toBe(vm.zenith);
    expect(shader.uniforms.probeUp.value).toBe(s.up);
    expect(shader.uniforms.probeSide.value).toBe(s.side);
    // Without a grid, the sky light as today.
    vm.setProbe(null);
    vm.render(fakeRenderer(), 1);
    expect(material().customProgramCacheKey()).toBe(
      new THREE.MeshLambertMaterial().customProgramCacheKey()
    );
  });

  it("finds the muzzle of the gun drawn, the middle of its model's front end (the models face +Z), in the viewmodel camera's frame; none while scoped or dead", async () => {
    // A body, a barrel ahead of it, and a hidden part (a holstered silencer) further still.
    const c = new WeaponCache(async () => {
      const g = new THREE.Group();
      const part = (w: number, h: number, d: number, y: number, z: number) => {
        const m = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, d),
          new THREE.MeshStandardMaterial()
        );
        m.position.set(0, y, z);
        g.add(m);
        return m;
      };
      part(0.1, 0.2, 0.4, 0, 0);
      part(0.02, 0.02, 0.3, 0.05, 0.35);
      part(0.04, 0.04, 0.2, 0.05, 0.7).visible = false;
      return g;
    });
    c.get('ak47');
    await new Promise((r) => setTimeout(r, 0));
    const vm = new Viewmodel(c, UNLIT_LOOK);
    const out = new THREE.Vector3();
    expect(vm.muzzle(out)).toBe(false);
    const pose = viewmodelPose(at());
    vm.set('ak47', 3, pose);
    expect(vm.muzzle(out)).toBe(true);
    const gun = vm.scene.children.find((o) => o.name === 'weapon:ak47')!;
    gun.updateMatrixWorld(true);
    const want = new THREE.Vector3(0, 0.05, 0.5).applyMatrix4(gun.matrixWorld);
    expect(out.distanceTo(want)).toBeLessThan(1e-6);
    // Ahead of the eye (down −Z), right of and below it.
    expect(out.z).toBeLessThan(-0.6);
    expect(out.x).toBeGreaterThan(0);
    // It moves with the gun: a kick throws it back and up.
    vm.set('ak47', 3, viewmodelPose(at({ actions: [act('shoot', 997, 0.1)] })));
    const kicked = new THREE.Vector3();
    expect(vm.muzzle(kicked)).toBe(true);
    expect(kicked.z).toBeGreaterThan(out.z);
    expect(kicked.y).toBeGreaterThan(out.y);
    for (const hidden of [{ scoped: true }, { alive: false }]) {
      vm.set('ak47', 3, viewmodelPose(at(hidden)));
      expect(vm.muzzle(out)).toBe(false);
    }
  });

  it('frees its materials but not the shared geometry', async () => {
    const c = await cache();
    const vm = new Viewmodel(c, UNLIT_LOOK);
    vm.set('ak47', 3, viewmodelPose(at()));
    const mesh = vm.scene.getObjectByName('weapon:ak47')!
      .children[0] as THREE.Mesh;
    const freedMaterial = vi.fn();
    const freedGeometry = vi.fn();
    (mesh.material as THREE.Material).addEventListener(
      'dispose',
      freedMaterial
    );
    mesh.geometry.addEventListener('dispose', freedGeometry);
    vm.dispose();
    expect(freedMaterial).toHaveBeenCalledTimes(1);
    expect(freedGeometry).not.toHaveBeenCalled();
  });
});

/** A viewmodel skeleton with an idle and a shot that pushes `wpn` back. */
function clipFile() {
  const scene = new THREE.Group();
  const vm = new THREE.Object3D();
  vm.name = 'viewmodel';
  const rm = new THREE.Object3D();
  rm.name = 'root_motion';
  rm.quaternion.set(-0.5, -0.5, -0.5, 0.5);
  const wpn = new THREE.Object3D();
  wpn.name = 'wpn';
  scene.add(vm);
  vm.add(rm);
  rm.add(wpn);
  const pos = (v: number[]) =>
    new THREE.VectorKeyframeTrack(
      'wpn.position',
      [0, 0.5].slice(0, v.length / 3),
      v
    );
  return {
    scene,
    animations: [
      new THREE.AnimationClip('idle', -1, [pos([0.375, -0.132, -0.063])]),
      new THREE.AnimationClip('draw', -1, [
        pos([0.2, -0.132, -0.3, 0.375, -0.132, -0.063]),
      ]),
      new THREE.AnimationClip('shoot', -1, [
        pos([0.325, -0.132, -0.063, 0.375, -0.132, -0.063]),
      ]),
    ],
  };
}

describe('Viewmodel with arms', () => {
  async function setup(
    manifest = { arms: { ct: {}, t: {} }, weapons: { ak47: {}, knife_t: {} } }
  ) {
    const weapons = await cache();
    const arms = new ArmsCache(async () => clipFile(), manifest);
    const vm = new Viewmodel(weapons, UNLIT_LOOK, arms);
    return { vm, arms };
  }
  const frame = (o: Partial<ViewmodelFrame> = {}): ViewmodelFrame => ({
    ...at(),
    weapon: 'ak47',
    team: 3,
    recent: [],
    clock: 3,
    ...o,
  });
  const settle = () => new Promise((r) => setTimeout(r, 0));
  const shownGuns = (vm: Viewmodel) => {
    const out: string[] = [];
    vm.scene.traverseVisible((o) => {
      if (o.name.startsWith('weapon:')) out.push(`${o.parent?.name}/${o.name}`);
    });
    return out;
  };

  it('draws the gun alone until the arms and the clips are in, then the arms holding it', async () => {
    const { vm } = await setup();
    vm.show(frame());
    expect(vm.rig).toBeNull();
    expect(shownGuns(vm)).toEqual(['/weapon:ak47']);
    await settle();
    vm.show(frame());
    expect(vm.rig).not.toBeNull();
    expect(shownGuns(vm)).toEqual(['wpn/weapon:ak47']);
    const r = fakeRenderer();
    vm.render(r, 16 / 9);
    expect(r.render).toHaveBeenCalledWith(vm.scene, vm.camera);
  });

  it("places the rig at the game's viewmodel offset, bobbing with the stride", async () => {
    const { vm } = await setup();
    vm.show(frame());
    await settle();
    vm.show(frame({ stride: 0.25 }));
    const p = vm.rig!.root.position.toArray();
    const want = rigPosition(ARMS_OFFSET);
    expect(p[0]).toBeCloseTo(want[0], 9);
    expect(p[1]).toBeCloseTo(want[1] + BOB, 9);
    expect(p[2]).toBeCloseTo(want[2], 9);
    expect(vm.rig!.root.rotation.y).toBeCloseTo(Math.PI, 9);
  });

  it('plays the shot clip at the time since the shot', async () => {
    const { vm } = await setup();
    vm.show(frame());
    await settle();
    const shot: Action = {
      ...act('shoot', 1000, 0.2),
      data: { weapon: 'ak47' },
    };
    const wpnZ = (tick: number) => {
      vm.show(frame({ recent: [shot], tick }));
      const w = vm.rig!.bone('wpn')!;
      w.updateWorldMatrix(true, false);
      return w.getWorldPosition(new THREE.Vector3()).z;
    };
    const idle = wpnZ(999);
    // 0.25 s in: halfway back from 0.325 to 0.375 ahead of the rig.
    expect(wpnZ(1016) - idle).toBeCloseTo(0.025, 4);
    // Scrubbing back to before the shot gives the idle again.
    expect(wpnZ(999)).toBeCloseTo(idle, 9);
  });

  it('gives a T the T arms and knife; the gun alone for a weapon without clips; nothing while scoped', async () => {
    const { vm } = await setup();
    vm.show(frame({ weapon: 'knife', team: 2, family: 'knife' }));
    await settle();
    vm.show(frame({ weapon: 'knife', team: 2, family: 'knife' }));
    expect(shownGuns(vm)).toEqual(['wpn/weapon:knife_t']);
    // No clip file for the taser in the manifest (and its model fails): nothing at all.
    vm.show(frame({ weapon: 'taser', family: 'pistol' }));
    expect(vm.rig).toBeNull();
    expect(shownGuns(vm)).toEqual([]);
    vm.show(frame({ scoped: true }));
    expect(shownGuns(vm)).toEqual([]);
    const r = fakeRenderer();
    vm.render(r, 1);
    expect(r.render).not.toHaveBeenCalled();
  });

  it('says whether it draws anything: the arms or the gun alone, nothing while scoped or dead', async () => {
    const { vm } = await setup();
    expect(vm.visible).toBe(false);
    vm.show(frame());
    expect(vm.visible).toBe(true);
    await settle();
    vm.show(frame());
    expect(vm.rig).not.toBeNull();
    expect(vm.visible).toBe(true);
    for (const hidden of [{ alive: false }, { scoped: true }]) {
      vm.show(frame(hidden));
      expect(vm.visible).toBe(false);
    }
    // The gun alone, dead: nothing either.
    vm.set('ak47', 3, viewmodelPose(at({ alive: false })));
    expect(vm.visible).toBe(false);
    vm.show(frame());
    expect(vm.visible).toBe(true);
  });

  it('finds the muzzle of the gun in the hands, and none while scoped', async () => {
    const { vm } = await setup();
    vm.show(frame());
    await settle();
    vm.show(frame());
    expect(vm.rig).not.toBeNull();
    const out = new THREE.Vector3();
    expect(vm.muzzle(out)).toBe(true);
    let gun: THREE.Object3D | null = null;
    vm.scene.traverseVisible((o) => {
      if (o.name === 'weapon:ak47' && o.parent?.name === 'wpn') gun = o;
    });
    const held = gun as unknown as THREE.Object3D;
    held.updateWorldMatrix(true, false);
    // The cache's guns are unit boxes: the front end's middle is (0, 0, 0.5).
    const want = new THREE.Vector3(0, 0, 0.5).applyMatrix4(held.matrixWorld);
    expect(out.distanceTo(want)).toBeLessThan(1e-6);
    vm.show(frame({ scoped: true }));
    expect(vm.muzzle(out)).toBe(false);
  });

  it('without viewmodels on the server, the gun is drawn alone', async () => {
    const weapons = await cache();
    const arms = new ArmsCache(async () => clipFile(), null);
    const vm = new Viewmodel(weapons, UNLIT_LOOK, arms);
    vm.show(frame());
    await settle();
    vm.show(frame());
    expect(vm.rig).toBeNull();
    expect(shownGuns(vm)).toEqual(['/weapon:ak47']);
  });

  it('remakes the rig in a new look and frees the old one', async () => {
    const { vm } = await setup();
    vm.show(frame());
    await settle();
    vm.show(frame());
    const before = vm.rig;
    vm.setLook({ ...UNLIT_LOOK, lit: true });
    expect(vm.rig).toBeNull();
    vm.show(frame());
    expect(vm.rig).not.toBeNull();
    expect(vm.rig).not.toBe(before);
    expect(before!.root.parent).toBeNull();
  });
});

describe('viewmodelToScene', () => {
  // The main camera somewhere in the map, turned; both cameras share the canvas's aspect.
  const ASPECT = 16 / 9;
  function camera(fov: number) {
    const c = new THREE.PerspectiveCamera(fov, ASPECT, 0.05, 100);
    c.position.set(3, 1.6, -2);
    c.rotation.set(-0.2, 0.9, 0, 'YXZ');
    c.updateMatrixWorld(true);
    return c;
  }
  const p = new THREE.Vector3(0.14, -0.09, -0.7);

  it('with the same field of view places the point as the camera does, at scale 1', () => {
    const cam = camera(60);
    const out = new THREE.Vector3();
    expect(viewmodelToScene(p, 60, 60, cam.matrixWorld, out)).toBeCloseTo(
      1,
      12
    );
    expect(
      out.distanceTo(p.clone().applyMatrix4(cam.matrixWorld))
    ).toBeLessThan(1e-9);
  });

  it("from the viewmodel's narrower field of view spreads the point from the view's middle, onto the pixel the viewmodel draws it on, at the same depth", () => {
    const vmFov = verticalFov(VIEWMODEL_FOV);
    const fov = 73.74;
    const cam = camera(fov);
    const out = new THREE.Vector3();
    const k = viewmodelToScene(p, vmFov, fov, cam.matrixWorld, out);
    const want =
      Math.tan((fov * Math.PI) / 360) / Math.tan((vmFov * Math.PI) / 360);
    expect(vmFov).toBeLessThan(fov);
    expect(k).toBeCloseTo(want, 12);
    expect(k).toBeGreaterThan(1);
    // In the camera's frame: x and y out by k, the depth kept.
    const local = out.clone().applyMatrix4(cam.matrixWorld.clone().invert());
    expect(local.x).toBeCloseTo(p.x * k, 9);
    expect(local.y).toBeCloseTo(p.y * k, 9);
    expect(local.z).toBeCloseTo(p.z, 9);
    // The same pixel: the viewmodel camera (at the origin) shows p where the camera shows out.
    const vm = new THREE.PerspectiveCamera(vmFov, ASPECT, 0.01, 10);
    vm.updateMatrixWorld(true);
    const a = p.clone().project(vm);
    const b = out.clone().project(cam);
    expect(b.x).toBeCloseTo(a.x, 9);
    expect(b.y).toBeCloseTo(a.y, 9);
  });
});
