// Scene.loadMap: a scene draws one map (another needs a scene of its own); swapping its world
// (the phone tier) keeps the user's view, and a map without assets leaves the scene empty until
// they appear. The map's sky, fog and light colours come with it, and the fog counts from where
// the view is.
// WebGL does not exist in node, so the renderer, the GLB loader and the detail texture's
// loader are stubbed; the stub renderer has no float targets, so the post stack stays off,
// except where a test gives it them (`gpu.floatTargets`) to run `high`'s post path.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMapManifests } from '../src/api/assets';
import { DEFAULT_ATMOSPHERE, atmosphereFor } from '../src/scene/atmosphere';
import { BulletMarks } from '../src/scene/bulletmarks';
import { Cameras } from '../src/scene/cameras';
import { LIVE_SUN_LOW_SHADOWS } from '../src/scene/quality';
import {
  HEMI_INTENSITY,
  Lighting,
  SUN_OFFSET,
  WORLD_CASTER_LAYER,
} from '../src/scene/lighting';
import type { LookOptions } from '../src/scene/look';
import {
  BAKED_BLOOM_WHITE,
  BLOOM_THRESHOLD,
  behindNeutral,
  inSmokeFog,
  skyWhite,
  type PostStack,
} from '../src/scene/post';
import { makeProbeSample, type ProbeSample } from '../src/scene/probes';
import type { UtilityOptions } from '../src/scene/utility';
import type { Viewmodel } from '../src/scene/viewmodel';
import { DEATH_VIEW_S } from '../src/sim/deathview';
import { lightGridFile } from './helpers/light-grid';
import { MIRAGE_LIGHT } from './helpers/light-json';
import { shadowCasters } from './helpers/shadow-casters';
import { event, grenadeTrack, trackPack } from './helpers/track-pack';

/** Whether the next stub renderer has float render targets (so `high` runs the post stack). */
const gpu = vi.hoisted(() => ({ floatTargets: false }));
vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    readonly info = { render: { triangles: 0 }, autoReset: true, reset() {} };
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    private readonly floatTargets = gpu.floatTargets;
    readonly extensions = {
      has: (name: string) =>
        this.floatTargets &&
        (name === 'EXT_color_buffer_float' ||
          name === 'EXT_color_buffer_half_float'),
    };
    private target: unknown = null;
    getRenderTarget() {
      return this.target;
    }
    setRenderTarget(t: unknown) {
      this.target = t;
    }
    readonly shadowMap = { enabled: false, type: 0, render() {} };
    toneMapping = 0;
    toneMappingExposure = 1;
    /** POV draws the first-person arms over the frame (`Viewmodel.render`). */
    autoClear = true;
    clearDepth() {}
    private readonly size = new three.Vector2(1600, 900);
    setPixelRatio() {}
    getPixelRatio() {
      return 1;
    }
    getSize(out: THREE.Vector2) {
      return out.copy(this.size);
    }
    setSize(w: number, h: number) {
      this.size.set(w, h);
    }
    /** As three's: the scene's `onAfterRender` runs inside the render. */
    render(scene: THREE.Scene, camera: THREE.Camera) {
      (scene.onAfterRender as (...args: unknown[]) => void)(
        this,
        scene,
        camera
      );
    }
    /** What was let go, in order: `dispose`, `context`. */
    readonly gone: string[] = [];
    dispose() {
      this.gone.push('dispose');
    }
    forceContextLoss() {
      this.gone.push('context');
    }
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

/** Each map's world is a box off the origin, at its own centre, so a refit is visible. */
const CENTRES: Record<string, [number, number, number]> = {
  de_mirage: [100, 0, 100],
  de_dust2: [-200, 0, 50],
  de_vertigo: [0, 0, 0],
};
const loadWorld = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.Group>>(async (url) => {
    const { Group, Mesh, BoxGeometry, MeshBasicMaterial, BufferAttribute } =
      await import('three');
    const map = url.split('/')[2];
    if (url.includes('/entities.glb')) {
      // A door as entities.glb has it: a root at its spawn named by hammer id, its model
      // under it, lit by COLOR_0 (AO, or a baked map's probe light) and without a lightmap UV.
      const slab = new Mesh(
        new BoxGeometry(1.2, 2.2, 0.06),
        new MeshBasicMaterial()
      );
      const n = slab.geometry.getAttribute('position').count;
      slab.geometry.setAttribute(
        'color',
        new BufferAttribute(new Uint8Array(4 * n).fill(200), 4, true)
      );
      slab.position.set(0.6, 1.1, 0);
      const root = new Group();
      root.name = '2:61814:19238';
      root.userData = {
        classname: 'prop_door_rotating',
        origin: [0, 0, 0],
        angles: [0, 0, 0],
      };
      root.add(slab);
      const g = new Group();
      g.add(root);
      return g;
    }
    const box = new Mesh(new BoxGeometry(60, 10, 60), new MeshBasicMaterial());
    box.position.set(...CENTRES[map]);
    // The lightmap UV of a baked map's world, unused by every look without a bake.
    box.geometry.setAttribute('uv1', box.geometry.getAttribute('uv').clone());
    const g = new Group();
    g.add(box);
    return g;
  })
);
/** Each map's hull is a 10 m box at its centre, so the closest point tells which map's it is. */
const loadHull = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.BufferGeometry>>(async (url) => {
    const { BoxGeometry } = await import('three');
    const map = url.split('/')[2];
    return new BoxGeometry(10, 10, 10).translate(...CENTRES[map]);
  })
);
/** A map's sky.webp: a 2048×1024 texture named after its URL. */
const loadSky = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.Texture>>(async (url) => {
    const { Texture } = await import('three');
    const t = new Texture({ width: 2048, height: 1024 });
    t.name = url;
    return t;
  })
);
vi.mock('../src/scene/loaders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/loaders')>()),
  loadWorld,
  loadHull,
  loadSky,
}));
const detailTexture = vi.hoisted(() => ({ name: 'detail', dispose() {} }));
vi.mock('../src/scene/detail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/detail')>()),
  loadDetailTexture: async () => detailTexture,
}));
/** `applyLook` as it is, counted: a world must be dressed once, in its final look. */
const dressed = vi.hoisted(() => ({
  calls: [] as { root: unknown; look: LookOptions }[],
}));
vi.mock('../src/scene/look', async (importOriginal) => {
  const look = await importOriginal<typeof import('../src/scene/look')>();
  return {
    ...look,
    applyLook: (root: THREE.Object3D, o: LookOptions) => {
      dressed.calls.push({ root, look: o });
      return look.applyLook(root, o);
    },
  };
});

const { Scene, MissingAssetsError } = await import('../src/scene/Scene');

// Each test serves its own manifests: none is kept from the last one's.
beforeEach(forgetMapManifests);
const { mergeMeshes } = await import('../src/scene/loaders');

type Inside = {
  cameras: Cameras;
  scene: THREE.Scene;
  lighting: Lighting;
  renderer: THREE.WebGLRenderer;
  look: LookOptions;
  mapAssets: {
    world: THREE.Group | null;
    entities: {
      models: THREE.Group;
      root: THREE.Group;
      set(
        round: number,
        tick: number,
        index: unknown,
        tickRate: number,
        exposure?: number
      ): boolean;
    } | null;
  };
  players: { pool: unknown; lightSamples: ProbeSample[] };
  playerLook(): LookOptions;
  lightPlayers(): void;
  viewmodel: Viewmodel;
  lightViewmodel(shown: number, eye: THREE.Vector3): void;
  utility: {
    root: THREE.Object3D;
    set(round: number, tick: number, tl: unknown, opts: UtilityOptions): void;
  };
  impacts: { root: THREE.Object3D };
  ground: { root: THREE.Object3D };
  weapons: { get(name: string): THREE.Object3D | null };
  post: PostStack;
};
const inside = (s: InstanceType<typeof Scene>) => s as unknown as Inside;

/** The listeners a fake canvas was given, by event type. */
type Listeners = Record<string, (() => void) | undefined>;

function fakeCanvas(listeners: Listeners = {}): HTMLCanvasElement {
  const target = { addEventListener() {}, removeEventListener() {} };
  return {
    ...target,
    addEventListener: (type: string, fn: () => void) => {
      listeners[type] = fn;
    },
    clientWidth: 1600,
    clientHeight: 900,
    style: {},
    getRootNode: () => target,
    ownerDocument: target,
  } as unknown as HTMLCanvasElement;
}

/**
 * Answers with 200, a map's manifest listing the phone tier's world (`world_lo.glb`, so a load
 * with `phone` swaps the world), or with `status` for the maps in `missing`.
 */
function serve(missing: Record<string, number> = {}) {
  const fetch = vi.fn(async (url: string) => {
    const map = Object.keys(missing).find((m) => url.includes(`/${m}/`));
    const res = { ok: !map, status: map ? missing[map] : 200 };
    return url.startsWith('/maps/')
      ? { ...res, json: async () => ({ files: { 'world_lo.glb': {} } }) }
      : res;
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const v3 = ([x, y, z]: readonly number[]) => new THREE.Vector3(x, y, z);

/**
 * Answers every manifest with one that lists sky.webp (so the map has a sky to load) and the
 * phone tier's world, and the sky's horizon colour when `horizon` is given.
 */
function serveWithSky(horizon?: string) {
  const fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      files: {
        'sky.webp': { sha256: 'd'.repeat(64) },
        'world_lo.glb': {},
      },
      ...(horizon ? { sky: { horizon } } : {}),
    }),
  }));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function worlds(s: InstanceType<typeof Scene>): THREE.Object3D[] {
  return inside(s).scene.children.filter((c) => c.name === 'world');
}

describe('Scene.loadMap', () => {
  let scene: InstanceType<typeof Scene>;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    loadWorld.mockClear();
    loadHull.mockClear();
    loadSky.mockClear();
    scene = new Scene(fakeCanvas());
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
  });

  /** A scene of its own for another map (a scene draws one), the last one disposed. */
  const fresh = () => {
    scene.dispose();
    scene = new Scene(fakeCanvas());
  };

  it('keeps the free view when the map swaps to its phone tier, and draws no other map', async () => {
    serve();
    await scene.loadMap('de_mirage');
    const { cameras } = inside(scene);
    scene.setCamera('free', null);
    scene.render();
    cameras.free.position.set(3, 4, 5);

    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(loadWorld.mock.lastCall?.[0]).toBe('/maps/de_mirage/world_lo.glb');
    expect(worlds(scene)).toHaveLength(1);
    scene.render();
    const p = cameras.free.position;
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(6))).toEqual([3, 4, 5]);

    // A scene draws one map: another is refused, the world and the view kept.
    await expect(scene.loadMap('de_dust2')).rejects.toThrow(
      'this scene draws de_mirage; de_dust2 needs a scene of its own'
    );
    expect(loadWorld.mock.lastCall?.[0]).toBe('/maps/de_mirage/world_lo.glb');
    expect(worlds(scene)).toHaveLength(1);
    expect([p.x, p.y, p.z].map((v) => +v.toFixed(6))).toEqual([3, 4, 5]);

    // Another map's scene starts Free from its overview: looking at its centre.
    fresh();
    await scene.loadMap('de_dust2');
    scene.setCamera('free', null);
    scene.render();
    const free = inside(scene).cameras.free;
    const dir = free.getWorldDirection(new THREE.Vector3());
    const toCentre = v3(CENTRES.de_dust2).sub(free.position).normalize();
    expect(dir.distanceTo(toCentre)).toBeCloseTo(0, 6);
  });

  it('leaves the scene empty when the map has no assets, and draws it once they appear', async () => {
    serve({ de_dust2: 404 });
    await expect(scene.loadMap('de_dust2')).rejects.toBeInstanceOf(
      MissingAssetsError
    );
    expect(worlds(scene)).toHaveLength(0);
    expect(scene.hull).toBeNull();
    // The assets appear: the next call asks again (a 404 is not kept).
    serve();
    await scene.loadMap('de_dust2');
    expect(worlds(scene)).toHaveLength(1);
    expect(scene.hull).not.toBeNull();
  });

  it("reports a plain error when the map's manifest fails with a 5xx, and draws the map on a later call", async () => {
    serve({ de_dust2: 503 });
    const err = await scene.loadMap('de_dust2').catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MissingAssetsError);
    expect(err.message).toBe('manifest: HTTP 503');
    expect(worlds(scene)).toHaveLength(0);
    serve();
    await scene.loadMap('de_dust2');
    expect(worlds(scene)).toHaveLength(1);
  });

  it('resolves a superseded call whose world fails, without an effect, and rejects the last one', async () => {
    serve();
    await scene.loadMap('de_mirage');
    const mirage = worlds(scene)[0];

    // The phone tier's world fails after a change back kept the world drawn.
    let broken!: (e: Error) => void;
    loadWorld.mockImplementationOnce(
      () => new Promise((_, reject) => (broken = reject))
    );
    scene.setQuality('low');
    const superseded = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(broken).toBeDefined());
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    broken(new Error('world_lo.glb: HTTP 500'));
    await expect(superseded).resolves.toBeUndefined();
    expect(worlds(scene)).toEqual([mirage]);

    // The last call's failure is its caller's.
    loadWorld.mockRejectedValueOnce(new Error('world_lo.glb: HTTP 500'));
    scene.setQuality('low');
    await expect(scene.loadMap('de_mirage')).rejects.toThrow('HTTP 500');
    expect(worlds(scene)).toEqual([mirage]);
  });

  it('asks for the manifest once for calls made while it is on its way, a change of tier among them', async () => {
    let answer!: (r: unknown) => void;
    const fetch = vi.fn(
      (url: string) =>
        new Promise((r) => {
          if (url.endsWith('/manifest.json')) answer = r;
          else r({ ok: false, status: 404 });
        })
    );
    vi.stubGlobal('fetch', fetch);
    const first = scene.loadMap('de_mirage');
    scene.setQuality('low');
    expect(scene.loadMap('de_mirage')).toBe(first);
    answer({
      ok: true,
      status: 200,
      json: async () => ({ files: { 'world_lo.glb': {} } }),
    });
    await first;
    // The tier of the moment the manifest came in.
    expect(loadWorld.mock.calls.map((c) => c[0])).toEqual([
      '/maps/de_mirage/world_lo.glb',
    ]);
  });

  it("asks for the world and hull by the versioned URLs in the map's manifest", async () => {
    const hash = (c: string) => c.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          files: {
            'world.glb': { sha256: hash('a') },
            'world_lo.glb': { sha256: hash('b') },
            'hull.glb': { sha256: hash('c') },
          },
        }),
      }))
    );
    await scene.loadMap('de_mirage');
    expect(loadWorld.mock.lastCall?.[0]).toBe(
      '/maps/de_mirage/world.glb?v=aaaaaaaa'
    );
    expect(loadHull.mock.lastCall?.[0]).toBe(
      '/maps/de_mirage/hull.glb?v=cccccccc'
    );
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(loadWorld.mock.lastCall?.[0]).toBe(
      '/maps/de_mirage/world_lo.glb?v=bbbbbbbb'
    );
  });

  it("loads the map's hull beside its world, keeps it for the phone-tier swap and frees it with the scene", async () => {
    serve();
    expect(scene.hull).toBeNull();
    await scene.loadMap('de_mirage');
    expect(loadHull.mock.lastCall?.[0]).toBe('/maps/de_mirage/hull.glb');
    const mirage = scene.hull!;
    const out = new THREE.Vector3();
    expect(mirage.closestPoint(v3(CENTRES.de_mirage), out)).toBeCloseTo(5, 6);

    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(loadHull).toHaveBeenCalledTimes(1);
    expect(scene.hull).toBe(mirage);

    const forget = vi.spyOn(BulletMarks.prototype, 'forget');
    const freed = vi.spyOn(mirage, 'dispose');
    scene.dispose();
    expect(scene.hull).toBeNull();
    // The bullet marks let go of the hull freed with the scene.
    expect(forget).toHaveBeenCalledWith(mirage);
    expect(freed).toHaveBeenCalledTimes(1);
    forget.mockRestore();
  });

  it('counts each hull it takes or drops (hullVersion), the phone-tier swap keeping it', async () => {
    serve({ de_dust2: 404 });
    const start = scene.hullVersion;
    await scene.loadMap('de_mirage');
    expect(scene.hullVersion).toBe(start + 1);
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(scene.hullVersion).toBe(start + 1);
    scene.dispose();
    expect(scene.hullVersion).toBe(start + 2);
    // A map without assets has no hull: nothing changes.
    fresh();
    await expect(scene.loadMap('de_dust2')).rejects.toBeInstanceOf(
      MissingAssetsError
    );
    expect(scene.hullVersion).toBe(0);
  });

  it('listens from the camera drawn last, and not before the first draw or while hidden', async () => {
    serve();
    await scene.loadMap('de_mirage');
    const out = { x: 9, y: 9, z: 9, fx: 9, fy: 9, fz: 9, ux: 9, uy: 9, uz: 9 };
    const untouched = { ...out };
    expect(scene.listener(out)).toBe(false);
    expect(out).toEqual(untouched);
    scene.setCamera('free', null);
    scene.render();
    const cam = inside(scene).cameras.drawn;
    expect(scene.listener(out)).toBe(true);
    expect([out.x, out.y, out.z]).toEqual([
      cam.position.x,
      cam.position.y,
      cam.position.z,
    ]);
    const f = cam.getWorldDirection(new THREE.Vector3());
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    [f.x, f.y, f.z, up.x, up.y, up.z].forEach((v, i) =>
      expect([out.fx, out.fy, out.fz, out.ux, out.uy, out.uz][i]).toBeCloseTo(
        v,
        6
      )
    );
    expect(out.fx * out.ux + out.fy * out.uy + out.fz * out.uz).toBeCloseTo(
      0,
      6
    );
    // Under the full radar: nothing drawn to listen from.
    scene.setHidden(true);
    const before = { ...out };
    expect(scene.listener(out)).toBe(false);
    expect(out).toEqual(before);
  });

  it('names the surface under the feet at a Source point, from 8 units over them to 32 under', async () => {
    serve();
    expect(scene.surfaceBelow(0, 0, 0)).toBeNull();
    // A wood floor 40 units up, 20 m square around scene (30, ·, 0): Source y 1181.1, x 0.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20)
        .rotateX(-Math.PI / 2)
        .translate(30, 40 * 0.0254, 0)
    );
    floor.name = 'physics_group_wood_plank';
    loadHull.mockImplementationOnce(async () =>
      mergeMeshes(new THREE.Group().add(floor))
    );
    await scene.loadMap('de_mirage');
    expect(scene.surfaceBelow(0, 1181, 40)).toBe('wood_plank');
    expect(scene.surfaceBelow(100, 1300, 40 + 31)).toBe('wood_plank');
    expect(scene.surfaceBelow(0, 1181, 40 - 7)).toBe('wood_plank');
    // Too high over it, under it, or where Source x (scene z) is 1181.
    expect(scene.surfaceBelow(0, 1181, 40 + 33)).toBeNull();
    expect(scene.surfaceBelow(0, 1181, 40 - 9)).toBeNull();
    expect(scene.surfaceBelow(1181, 0, 40)).toBeNull();
    // A hull without surface names (Dust2's box) names nothing, on top of it either.
    fresh();
    await scene.loadMap('de_dust2');
    expect(
      scene.surfaceBelow(50 / 0.0254, -200 / 0.0254, 5 / 0.0254)
    ).toBeNull();
  });

  it("loads the map's doors (entities.glb) when its manifest lists them, keeps them for the phone-tier swap, dresses them in the look and frees them with the scene", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/de_nuke/')
          ? { ok: false, status: 404 }
          : {
              ok: true,
              status: 200,
              json: async () => ({
                files: url.includes('/de_vertigo/')
                  ? {
                      'world.glb': {},
                      'world_lo.glb': {},
                      'entities.glb': { sha256: 'e'.repeat(64) },
                    }
                  : { 'world.glb': {}, 'world_lo.glb': {} },
              }),
            }
      )
    );
    const loads = () =>
      loadWorld.mock.calls.filter(([url]) => url.includes('entities.glb'));
    const entities = () =>
      inside(scene).scene.children.filter((c) => c.name === 'entities');

    await scene.loadMap('de_vertigo');
    expect(loads().map(([url]) => url)).toEqual([
      '/maps/de_vertigo/entities.glb?v=eeeeeeee',
    ]);
    expect(entities()).toHaveLength(1);
    const doors = entities()[0];

    // A new preset dresses them as it dresses the world; the phone tier (low's) swaps the
    // world only.
    const mesh = doors.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const lit = mesh.material;
    scene.setQuality('low');
    expect(mesh.material).not.toBe(lit);
    expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    await scene.loadMap('de_vertigo');
    expect(loads()).toHaveLength(1);
    expect(entities()).toHaveLength(1);
    expect(entities()[0]).toBe(doors);

    const freed = vi.fn();
    (mesh.geometry as THREE.BufferGeometry).addEventListener('dispose', freed);
    scene.dispose();
    expect(entities()).toHaveLength(0);
    expect(freed).toHaveBeenCalledTimes(1);

    // A map without them, and a map without assets, have none.
    fresh();
    await scene.loadMap('de_mirage');
    expect(loads()).toHaveLength(1);
    expect(entities()).toHaveLength(0);
    fresh();
    await expect(scene.loadMap('de_nuke')).rejects.toBeInstanceOf(
      MissingAssetsError
    );
    expect(entities()).toHaveLength(0);
  });

  it('loads the world without a hull when the hull is missing or broken, and says so once', async () => {
    serve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadHull.mockRejectedValueOnce(
      new Error('fetch for "/maps/de_mirage/hull.glb" responded with 404')
    );
    await scene.loadMap('de_mirage');
    expect(worlds(scene)).toHaveLength(1);
    expect(scene.hull).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.lastCall?.[0])).toContain('de_mirage');

    // The phone-tier swap neither asks again nor logs again.
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(loadHull).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    loadHull.mockRejectedValueOnce(new SyntaxError('Unexpected token'));
    fresh();
    await scene.loadMap('de_dust2');
    expect(worlds(scene)).toHaveLength(1);
    expect(scene.hull).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('drops the hull of a superseded load', async () => {
    serve();
    let answer!: (g: THREE.BufferGeometry) => void;
    loadHull.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const stale = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(answer).toBeDefined());
    // A change of tier before it is in: the phone tier's load asks for the hull again.
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    const late = new THREE.BoxGeometry(10, 10, 10);
    const disposed = vi.fn();
    late.addEventListener('dispose', disposed);
    answer(late);
    await expect(stale).resolves.toBeUndefined();
    const out = new THREE.Vector3();
    expect(scene.hull!.closestPoint(v3(CENTRES.de_mirage), out)).toBeCloseTo(
      5,
      6
    );
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it('loads the world lit, with anisotropy from the device and the detail texture', async () => {
    serve();
    dressed.calls.length = 0;
    await scene.loadMap('de_mirage');
    const world = inside(scene).mapAssets.world;
    const looks = dressed.calls.filter((c) => c.root === world);
    expect(looks).toHaveLength(1);
    expect(looks[0].look).toEqual({
      lit: true,
      smoothNormals: true,
      maxAnisotropy: 16,
      detail: detailTexture,
      baked: undefined,
    });
  });

  it("dresses the scene in the map's sky, fog and light colours", async () => {
    serve({ de_nuke: 404 });
    const { scene: s3, lighting } = inside(scene);
    const { hemi, sun } = lighting;
    const dark = (s3.background as THREE.Color).getHex();
    await scene.loadMap('de_mirage');
    const mirage = atmosphereFor('de_mirage');
    const hex = (c: string) => new THREE.Color(c).getHex();
    expect((s3.background as THREE.Color).getHex()).toBe(hex(mirage.sky));
    const fog = s3.fog as THREE.Fog;
    expect(fog).toBeInstanceOf(THREE.Fog);
    expect(fog.color.getHex()).toBe(hex(mirage.sky));
    expect(sun.color.getHex()).toBe(hex(mirage.sunColor));
    expect(hemi.color.getHex()).toBe(hex(mirage.hemiSky));
    expect(hemi.groundColor.getHex()).toBe(hex(mirage.hemiGround));
    // Neutral tone mapping at the map's own exposure.
    const r = inside(scene).renderer;
    expect(r.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(r.toneMappingExposure).toBe(mirage.exposure);
    // The sun shines at the map's centre from above.
    const c = v3(CENTRES.de_mirage);
    expect(sun.target.position.distanceTo(c)).toBeCloseTo(0, 6);
    expect(sun.position.y).toBeGreaterThan(c.y + 50);

    fresh();
    await scene.loadMap('de_dust2');
    expect(
      inside(scene).lighting.sun.target.position.distanceTo(
        v3(CENTRES.de_dust2)
      )
    ).toBeCloseTo(0, 6);

    // No assets: the dark empty scene, its fog (always set: no recompile) out of reach.
    fresh();
    await expect(scene.loadMap('de_nuke')).rejects.toBeInstanceOf(
      MissingAssetsError
    );
    const empty = inside(scene).scene;
    expect((empty.background as THREE.Color).getHex()).toBe(dark);
    expect(empty.fog).toBeInstanceOf(THREE.Fog);
    scene.render();
    expect((empty.fog as THREE.Fog).near).toBeGreaterThan(1e6);
  });

  it("shadows the map with the sun's 2048² PCF shadow, fitted to the world without a hull", async () => {
    serve();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadHull.mockRejectedValueOnce(new Error('404'));
    const { lighting, renderer } = inside(scene);
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(renderer.shadowMap.type).toBe(THREE.PCFShadowMap);
    expect(lighting.sun.castShadow).toBe(true);
    expect(lighting.sun.shadow.mapSize.toArray()).toEqual([2048, 2048]);
    await scene.loadMap('de_mirage');
    const meshes: THREE.Mesh[] = [];
    worlds(scene)[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    expect(meshes.length).toBeGreaterThan(0);
    for (const m of meshes) {
      expect(m.castShadow).toBe(true);
      expect(m.receiveShadow).toBe(true);
    }
    // The world is a 60 × 10 × 60 box. Seen down the sun's (40, 80, 20) slant its corners
    // reach 30·(1 + 2)/√5 ≈ 40.25 m across, past 0.6 of its largest side (36 m), so the
    // shadow box grows to that reach and a metre.
    expect(lighting.sun.shadow.camera.right).toBeCloseTo(
      90 / Math.sqrt(5) + 1,
      6
    );
    warn.mockRestore();
  });

  it('fits the cameras and the shadow to the hull when the map has one', async () => {
    serve();
    await scene.loadMap('de_mirage');
    const { cameras, lighting } = inside(scene);
    // The hull is a 10 m box at the map's centre, inside the 60 × 10 × 60 world: the skybox
    // props around a map's edge (Ancient, Nuke) widen the world, not the hull.
    const hullBox = new THREE.Box3().setFromCenterAndSize(
      v3(CENTRES.de_mirage),
      v3([10, 10, 10])
    );
    const fitted = new Cameras(null, null, new THREE.Box3());
    fitted.resize(1600, 900);
    fitted.setBounds(hullBox);
    expect(cameras.free.far).toBeCloseTo(fitted.free.far, 6);
    scene.setCamera('free', null);
    scene.render();
    fitted.mode = 'free';
    fitted.update([], 0, {
      round: 0,
      tick: 0,
      pack: null,
      killerOf: () => null,
    });
    expect(cameras.free.position.distanceTo(fitted.free.position)).toBeCloseTo(
      0,
      6
    );
    // The shadow box: 0.6 of the hull's side, or its reach down the sun's slant and a metre.
    const reach = Lighting.reachOf(
      new THREE.Mesh(
        new THREE.BoxGeometry(10, 10, 10).translate(...CENTRES.de_mirage)
      ),
      hullBox
    );
    expect(reach).toBeGreaterThan(6);
    expect(lighting.sun.shadow.camera.right).toBeCloseTo(reach + 1, 6);
    expect(
      lighting.sun.target.position.distanceTo(v3(CENTRES.de_mirage))
    ).toBeCloseTo(0, 6);
  });

  it("draws the map's own sky (sky.webp) behind it once it loads, at the atmosphere's intensity", async () => {
    serveWithSky();
    const { scene: s3 } = inside(scene);
    await scene.loadMap('de_mirage');
    expect(loadSky).toHaveBeenCalledTimes(1);
    expect(loadSky.mock.lastCall?.[0]).toBe(
      '/maps/de_mirage/sky.webp?v=dddddddd'
    );
    await vi.waitFor(() => expect(s3.background).toBeInstanceOf(THREE.Texture));
    expect((s3.background as THREE.Texture).name).toBe(
      '/maps/de_mirage/sky.webp?v=dddddddd'
    );
    expect(s3.backgroundIntensity).toBe(
      atmosphereFor('de_mirage').skyIntensity
    );
    // The fog keeps the map's sky colour.
    const hex = (c: string) => new THREE.Color(c).getHex();
    expect((s3.fog as THREE.Fog).color.getHex()).toBe(
      hex(atmosphereFor('de_mirage').sky)
    );
    // The phone-tier swap (low's, which draws no sky: its upload is freed) and back keeps it;
    // the scene frees it with itself.
    const first = s3.background as THREE.Texture;
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    expect(loadSky).toHaveBeenCalledTimes(1);
    expect(s3.background).toBe(first);
    const freed = vi.fn();
    first.addEventListener('dispose', freed);
    scene.dispose();
    expect(freed).toHaveBeenCalledTimes(1);
  });

  it('asks for no sky at low, and for it once on the first preset that shows it', async () => {
    serveWithSky();
    scene.dispose();
    scene = new Scene(fakeCanvas(), 'low');
    const { scene: s3 } = inside(scene);
    await scene.loadMap('de_mirage');
    expect(loadSky).not.toHaveBeenCalled();
    expect(s3.background).toBeInstanceOf(THREE.Color);
    scene.setQuality('medium');
    expect(loadSky).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(s3.background).toBeInstanceOf(THREE.Texture));
    // Back at low the dark background shows, and the sky is kept for the next time.
    scene.setQuality('low');
    expect(s3.background).toBeInstanceOf(THREE.Color);
    scene.setQuality('medium');
    expect(s3.background).toBeInstanceOf(THREE.Texture);
    expect(loadSky).toHaveBeenCalledTimes(1);
  });

  it('keeps the colour sky, without an error, when sky.webp fails or the map has none', async () => {
    serveWithSky();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadSky.mockRejectedValueOnce(
      new Error('fetch for "/maps/de_mirage/sky.webp" responded with 404')
    );
    const { scene: s3 } = inside(scene);
    await expect(scene.loadMap('de_mirage')).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(String(warn.mock.lastCall?.[0])).toContain('de_mirage');
    expect(s3.background).toBeInstanceOf(THREE.Color);
    const hex = (c: string) => new THREE.Color(c).getHex();
    expect((s3.background as THREE.Color).getHex()).toBe(
      hex(atmosphereFor('de_mirage').sky)
    );
    // Not asked again at the next preset change.
    scene.setQuality('high');
    scene.setQuality('medium');
    expect(loadSky).toHaveBeenCalledTimes(1);
    // A manifest without sky.webp asks for nothing.
    serve();
    fresh();
    await scene.loadMap('de_dust2');
    expect(loadSky).toHaveBeenCalledTimes(1);
    expect(inside(scene).scene.background).toBeInstanceOf(THREE.Color);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('drops a sky that arrives after the scene was disposed', async () => {
    serveWithSky();
    let answer!: (t: THREE.Texture) => void;
    loadSky.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const { scene: s3 } = inside(scene);
    await scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(answer).toBeDefined());
    scene.dispose();
    const late = new THREE.Texture();
    const freed = vi.fn();
    late.addEventListener('dispose', freed);
    answer(late);
    await vi.waitFor(() => expect(freed).toHaveBeenCalledTimes(1));
    expect(s3.background).toBeInstanceOf(THREE.Color);
  });

  it("names the sky's URL when the load fails with an event rather than an Error", async () => {
    serveWithSky();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // TextureLoader rejects with the image's DOM error event.
    loadSky.mockRejectedValueOnce({ type: 'error', target: {} });
    await scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const said = String(warn.mock.lastCall?.[0]);
    expect(said).toContain('/maps/de_mirage/sky.webp?v=dddddddd');
    expect(said).not.toContain('[object');
    warn.mockRestore();
  });

  it("gives the fog, and the background until the sky draws, the sky's horizon colour", async () => {
    serveWithSky('#405060');
    let answer!: (t: THREE.Texture) => void;
    loadSky.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const { scene: s3 } = inside(scene);
    await scene.loadMap('de_mirage');
    const fog = s3.fog as THREE.Fog;
    expect(fog.color.getHex()).toBe(0x405060);
    expect((s3.background as THREE.Color).getHex()).toBe(0x405060);
    answer(new THREE.Texture({ width: 2048, height: 1024 }));
    await vi.waitFor(() => expect(s3.background).toBeInstanceOf(THREE.Texture));
    expect(fog.color.getHex()).toBe(0x405060);
    // A manifest without one keeps the atmosphere's sky colour; so does a malformed one.
    for (const [map, horizon] of [
      ['de_dust2', undefined],
      ['de_vertigo', 'blue'],
    ] as const) {
      serveWithSky(horizon);
      fresh();
      await scene.loadMap(map);
      expect((inside(scene).scene.fog as THREE.Fog).color.getHex()).toBe(
        new THREE.Color(atmosphereFor(map).sky).getHex()
      );
    }
  });

  it('counts the fog from the eye, the camera, in every mode', async () => {
    serve();
    await scene.loadMap('de_vertigo');
    const { scene: s3 } = inside(scene);
    const fog = s3.fog as THREE.Fog;
    const a = DEFAULT_ATMOSPHERE;
    expect(atmosphereFor('de_vertigo').fogNear).toBe(a.fogNear);

    for (const mode of ['free', 'pov'] as const) {
      scene.setCamera(mode, 0);
      scene.render();
      expect(fog.near).toBe(a.fogNear);
      expect(fog.far).toBe(a.fogFar);
    }
  });
});

// CS2's baked light (Task 5): light.json when the manifest lists it, then lightmap.webp beside
// the world; kept for the phone-tier swap; any failure is one warning and today's look.
describe('Scene.loadMap with a bake', () => {
  let scene: InstanceType<typeof Scene>;
  /** A scene of its own for another map (a scene draws one), the last one disposed. */
  const fresh = () => {
    scene.dispose();
    scene = new Scene(fakeCanvas());
  };

  /** Mirage's light.json, as tools/lib/light.mjs writes it (tools-parity.test.ts checks it). */
  const LIGHT = MIRAGE_LIGHT;
  const BAD_JSON = Symbol('bad json');
  const bitmaps: { close: () => void }[] = [];

  /**
   * Serves manifests that list the phone tier's world and the bake (or neither, with `listed`
   * false), `light` as light.json (`status` other than 200 fails it; BAD_JSON does not parse),
   * and lightmap.webp (404 when `lightmapStatus` says so); every decoded image is a fresh 1024²
   * bitmap.
   */
  function serveBake({
    light = LIGHT as unknown,
    status = 200,
    lightmapStatus = 200,
    probesStatus = 200,
    probes = lightGridFile(),
    listed = true,
    entities = false,
  } = {}) {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/manifest.json'))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            files: listed
              ? {
                  'world_lo.glb': {},
                  'light.json': { sha256: 'e'.repeat(64) },
                  'lightmap.webp': { sha256: 'f'.repeat(64) },
                  'probes.bin': { sha256: 'a'.repeat(64) },
                  'sky.webp': { sha256: 'd'.repeat(64) },
                  ...(entities
                    ? { 'entities.glb': { sha256: 'b'.repeat(64) } }
                    : {}),
                }
              : {},
            sky: { horizon: '#405060' },
          }),
        };
      if (url.includes('/light.json'))
        return {
          ok: status === 200,
          status,
          json: async () => {
            if (light === BAD_JSON) throw new SyntaxError('Unexpected token <');
            return light;
          },
        };
      if (url.includes('/lightmap.webp'))
        return {
          ok: lightmapStatus === 200,
          status: lightmapStatus,
          blob: async () => new Blob(['webp']),
        };
      if (url.includes('/probes.bin'))
        return {
          ok: probesStatus === 200,
          status: probesStatus,
          arrayBuffer: async () => probes,
        };
      return { ok: false, status: 404 };
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        const b = { width: 1024, height: 1024, close: vi.fn() };
        bitmaps.push(b);
        return b;
      })
    );
    return fetch;
  }

  const asked = (fetch: ReturnType<typeof serveBake>, name: string) =>
    fetch.mock.calls.filter(([u]) => String(u).includes(`/${name}`)).length;

  function worldMaterial():
    THREE.MeshLambertMaterial | THREE.MeshBasicMaterial {
    const world = inside(scene).scene.children.find((c) => c.name === 'world')!;
    return (world.children[0] as THREE.Mesh)
      .material as THREE.MeshLambertMaterial;
  }

  function worldMeshes(): THREE.Mesh[] {
    const out: THREE.Mesh[] = [];
    worlds(scene)[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh) out.push(o as THREE.Mesh);
    });
    return out;
  }

  /** The direction from the sun's target to the sun. */
  const sunDir = () => {
    const { sun } = inside(scene).lighting;
    return sun.position.clone().sub(sun.target.position).normalize();
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    loadWorld.mockClear();
    loadHull.mockClear();
    loadSky.mockClear();
    bitmaps.length = 0;
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
  });

  it('asks for no bake when the manifest lists none', async () => {
    scene = new Scene(fakeCanvas());
    const fetch = serveBake({ listed: false });
    await scene.loadMap('de_mirage');
    expect(asked(fetch, 'light.json')).toBe(0);
    expect(asked(fetch, 'lightmap.webp')).toBe(0);
    expect(inside(scene).look.baked).toBeUndefined();
    expect(worldMaterial().lightMap ?? null).toBeNull();
  });

  it('asks for light.json, lightmap.webp and probes.bin once for the map and its phone-tier swaps, by their versioned URLs', async () => {
    scene = new Scene(fakeCanvas());
    const fetch = serveBake();
    await scene.loadMap('de_mirage');
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    expect(asked(fetch, 'light.json')).toBe(1);
    expect(asked(fetch, 'lightmap.webp')).toBe(1);
    expect(asked(fetch, 'probes.bin')).toBe(1);
    expect(fetch).toHaveBeenCalledWith('/maps/de_mirage/light.json?v=eeeeeeee');
    expect(fetch).toHaveBeenCalledWith(
      '/maps/de_mirage/lightmap.webp?v=ffffffff'
    );
    expect(fetch).toHaveBeenCalledWith('/maps/de_mirage/probes.bin?v=aaaaaaaa');
    // The swapped world comes dressed in the same bake.
    const baked = inside(scene).look.baked!;
    expect(baked.lightGrid?.size).toEqual([1, 2, 1]);
    expect(worldMaterial().lightMap).toBe(baked.lightmap);
    // The scene frees its lightmap with itself.
    const freed = vi.fn();
    baked.lightmap!.addEventListener('dispose', freed);
    scene.dispose();
    expect(freed).toHaveBeenCalled();
    expect(bitmaps[0].close).toHaveBeenCalledTimes(1);
  });

  it("keeps the bake's lightmap through a phone-tier swap: the world freed borrowed it from the bake, which keeps it", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const baked = inside(scene).look.baked!;
    const full = inside(scene).mapAssets.world!;
    expect(worldMaterial().lightMap).toBe(baked.lightmap);
    const freed = vi.fn();
    baked.lightmap!.addEventListener('dispose', freed);
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(inside(scene).mapAssets.world).not.toBe(full);
    expect(full.parent).toBeNull();
    expect(inside(scene).look.baked).toBe(baked);
    expect(worldMaterial().lightMap).toBe(baked.lightmap);
    expect(freed).not.toHaveBeenCalled();
  });

  it("lights the world with the bake: tone-mapped at its exposure at every preset, the sun from light.json, the world's shadow drawn apart from the players'", async () => {
    scene = new Scene(fakeCanvas(), 'low');
    serveBake();
    const { renderer, lighting } = inside(scene);
    const bloomThreshold = vi.spyOn(inside(scene).post, 'setBloomThreshold');
    await scene.loadMap('de_mirage');
    const mirage = atmosphereFor('de_mirage');
    const m = worldMaterial() as THREE.MeshLambertMaterial;
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(m.lightMap).toBe(inside(scene).look.baked!.lightmap);
    // `low` is tone-mapped too, at the map's exposure for its bake (ruling 13).
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    expect(renderer.toneMappingExposure).toBe(mirage.bakedExposure);
    // The bloom takes what is three times the exposure's white: CS2's sunlit stone is past 0.9.
    expect(bloomThreshold.mock.lastCall?.[0]).toBeCloseTo(
      BAKED_BLOOM_WHITE / mirage.bakedExposure,
      12
    );
    expect(renderer.shadowMap.enabled).toBe(false);
    const want = v3(LIGHT.sun.dir).normalize();
    expect(sunDir().distanceTo(want)).toBeLessThan(1e-6);
    // The sun in the bake is the players' and the viewmodel's too: π times light.json's
    // brightness in its linear colour, as the bake lit the world's sunlit surfaces.
    expect(lighting.sun.intensity).toBeCloseTo(
      Math.PI * LIGHT.sun.intensity,
      12
    );
    expect(lighting.sun.color.toArray()).toEqual(LIGHT.sun.color);
    expect(lighting.hemi.intensity).toBe(HEMI_INTENSITY);
    // Lit at every preset where the map has a grid, `low` included.
    expect(inside(scene).playerLook().lit).toBe(true);
    for (const mesh of worldMeshes()) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
    }

    scene.setQuality('medium');
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);
    // The sky's horizon colour is still the fog's (Task 8).
    expect((inside(scene).scene.fog as THREE.Fog).color.getHex()).toBe(
      0x405060
    );
    expect(renderer.shadowMap.enabled).toBe(true);
    expect(lighting.sun.castShadow).toBe(true);
    // The sun's map holds the world, drawn when stale; the black light's the players'.
    expect(lighting.sun.shadow.autoUpdate).toBe(false);
    expect(lighting.playerShadow.castShadow).toBe(true);
    expect(lighting.playerShadow.visible).toBe(true);
    expect((worldMaterial() as THREE.MeshLambertMaterial).lightMap).toBe(
      inside(scene).look.baked!.lightmap
    );
    scene.setQuality('low');
    expect(renderer.toneMapping).toBe(THREE.NeutralToneMapping);

    // A map without a bake is today's: unlit and untouched at low, the default sun.
    serveBake({ listed: false });
    fresh();
    scene.setQuality('low');
    const plain = inside(scene);
    const plainBloom = vi.spyOn(plain.post, 'setBloomThreshold');
    await scene.loadMap('de_dust2');
    expect(plain.renderer.toneMapping).toBe(THREE.NoToneMapping);
    expect(worldMaterial()).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(sunDir().distanceTo(SUN_OFFSET.clone().normalize())).toBeLessThan(
      1e-6
    );
    // The players are unlit at `low`, as today.
    expect(inside(scene).playerLook().lit).toBe(false);
    scene.setQuality('medium');
    expect(plain.renderer.toneMappingExposure).toBe(
      atmosphereFor('de_dust2').exposure
    );
    expect(plainBloom.mock.lastCall?.[0]).toBe(BLOOM_THRESHOLD);
    expect(plain.lighting.sun.intensity).toBe(
      atmosphereFor('de_dust2').sunIntensity
    );
    expect(plain.lighting.hemi.intensity).toBe(HEMI_INTENSITY);
    for (const mesh of worldMeshes()) expect(mesh.castShadow).toBe(true);
    // One shadow map of everything, every frame, as today.
    expect(plain.lighting.sun.shadow.autoUpdate).toBe(true);
    expect(plain.lighting.playerShadow.visible).toBe(false);
    expect(bloomThreshold).toHaveBeenCalled();
  });

  it('keeps a 1024 shadow map at low for a sun outside the bake (de_cache), whose interiors it would light, and none at low for any other map', async () => {
    scene = new Scene(fakeCanvas(), 'low');
    const { renderer, lighting } = inside(scene);
    serveBake({ light: { ...LIGHT, sun: { ...LIGHT.sun, baked: false } } });
    await scene.loadMap('de_mirage');
    expect(lighting.sun.shadow.mapSize.x).toBe(LIVE_SUN_LOW_SHADOWS);
    expect(LIVE_SUN_LOW_SHADOWS).toBe(1024);
    expect(lighting.sun.castShadow).toBe(true);
    expect(renderer.shadowMap.enabled).toBe(true);
    // Split as at the other presets: the world casts only into the sun's own map, drawn once,
    // and the players into the black light's 1024² map, every frame.
    expect(lighting.sun.shadow.autoUpdate).toBe(false);
    expect(lighting.playerShadow.visible).toBe(true);
    expect(lighting.playerShadow.castShadow).toBe(true);
    expect(lighting.playerShadow.shadow.mapSize.x).toBe(LIVE_SUN_LOW_SHADOWS);
    for (const mesh of worldMeshes()) {
      expect(mesh.castShadow).toBe(false);
      expect(mesh.receiveShadow).toBe(true);
    }
    // At medium the preset's own.
    scene.setQuality('medium');
    expect(lighting.sun.shadow.mapSize.x).toBe(2048);
    expect(lighting.playerShadow.shadow.mapSize.x).toBe(2048);
    scene.setQuality('low');
    expect(lighting.sun.shadow.mapSize.x).toBe(1024);
    // A sun in the bake, or no bake: no shadow map at low, as before.
    serveBake();
    scene.dispose();
    scene = new Scene(fakeCanvas(), 'low');
    await scene.loadMap('de_vertigo');
    expect(inside(scene).renderer.shadowMap.enabled).toBe(false);
    expect(inside(scene).lighting.sun.castShadow).toBe(false);
    serveBake({ listed: false });
    scene.dispose();
    scene = new Scene(fakeCanvas(), 'low');
    await scene.loadMap('de_dust2');
    expect(inside(scene).renderer.shadowMap.enabled).toBe(false);
    expect(renderer.shadowMap.enabled).toBe(true);
  });

  it("keeps the runtime sun and its shadows for a sun outside the bake (de_cache), the world's map drawn apart from the players', and none at brightness 0 (Train)", async () => {
    scene = new Scene(fakeCanvas());
    const { renderer, lighting } = inside(scene);
    serveBake({ light: { ...LIGHT, sun: { ...LIGHT.sun, baked: false } } });
    await scene.loadMap('de_mirage');
    expect(lighting.sun.castShadow).toBe(true);
    for (const mesh of worldMeshes()) expect(mesh.castShadow).toBe(false);
    expect(worldMaterial().customProgramCacheKey()).toContain('live');

    // The sun lights the world and the players. Its map holds the world, drawn once (and again
    // only when something in it moves), the black light's the players, every frame; the world
    // takes the sun past both (baked.ts). It is light.json's sun as the bake would have lit the
    // world with it, π times its brightness in its linear colour, beside the irradiance-only
    // lightmap (not the atmosphere's).
    expect(lighting.sun.shadow.autoUpdate).toBe(false);
    expect(lighting.playerShadow.visible).toBe(true);
    expect(lighting.playerShadow.castShadow).toBe(true);
    const drawn = vi.fn();
    const draw = renderer.shadowMap.render;
    renderer.shadowMap.render = (...a) => {
      drawn();
      return draw.apply(renderer.shadowMap, a);
    };
    const world = worlds(scene)[0];
    expect(lighting.drawWorldShadow(renderer, world)).toBe(true);
    expect(lighting.drawWorldShadow(renderer, world)).toBe(false);
    lighting.invalidateWorldShadow();
    expect(lighting.drawWorldShadow(renderer, world)).toBe(true);
    expect(drawn).toHaveBeenCalledTimes(2);
    renderer.shadowMap.render = draw;
    expect(lighting.sun.intensity).toBeCloseTo(
      Math.PI * LIGHT.sun.intensity,
      12
    );
    expect(lighting.sun.color.toArray()).toEqual(LIGHT.sun.color);

    serveBake({ light: { ...LIGHT, sun: { ...LIGHT.sun, intensity: 0 } } });
    fresh();
    await scene.loadMap('de_dust2');
    const train = inside(scene);
    // No sun: no runtime shadow from it, nothing for the world to cast, and no sun on the
    // players or the viewmodel either.
    expect(train.lighting.sun.castShadow).toBe(false);
    expect(train.lighting.sun.intensity).toBe(0);
    expect(train.renderer.shadowMap.enabled).toBe(false);
    for (const mesh of worldMeshes()) expect(mesh.castShadow).toBe(false);
    expect(worldMaterial().customProgramCacheKey()).toContain('none');
    // The preset's shadow is the first scene's, with a map that has a sun.
    expect(lighting.sun.castShadow).toBe(true);
    expect(renderer.shadowMap.enabled).toBe(true);
  });

  it("draws today's look with one warning when light.json is missing, bad or not a bake, or the lightmap or the light grid fails", async () => {
    const bad = lightGridFile();
    new DataView(bad).setUint8(0, 0x58);
    const cases = [
      { status: 404 },
      { light: BAD_JSON },
      { light: { ...LIGHT, range: -1 } },
      { probesStatus: 404 },
      { lightmapStatus: 404, probesStatus: 404 },
      { probes: bad },
      { probes: new ArrayBuffer(20) },
      // Version 1's lightmap is RGBM: this viewer would misdecode it.
      { light: { ...LIGHT, version: 1 } },
      { light: { ...LIGHT, version: 3 } },
      { light: { ...LIGHT, probes: null } },
    ];
    for (const c of cases) {
      scene = new Scene(fakeCanvas());
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetch = serveBake(c);
      await scene.loadMap('de_mirage');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.lastCall?.[0])).toContain('de_mirage');
      expect(worlds(scene)).toHaveLength(1);
      expect(inside(scene).look.baked).toBeUndefined();
      expect(worldMaterial().lightMap ?? null).toBeNull();
      const { renderer } = inside(scene);
      expect(renderer.toneMappingExposure).toBe(
        atmosphereFor('de_mirage').exposure
      );
      expect(sunDir().distanceTo(SUN_OFFSET.clone().normalize())).toBeLessThan(
        1e-6
      );
      for (const mesh of worldMeshes()) expect(mesh.castShadow).toBe(true);
      // The lightmap a grid failure leaves decoded is freed.
      for (const b of bitmaps) expect(b.close).toHaveBeenCalledTimes(1);
      bitmaps.length = 0;
      // The phone-tier swap neither asks for anything again nor warns again.
      const before = fetch.mock.calls.length;
      scene.setQuality('low');
      await scene.loadMap('de_mirage');
      expect(asked(fetch, 'light.json')).toBe(1);
      expect(fetch.mock.calls.length - before).toBe(0); // the manifest is kept too
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
      scene.dispose();
    }
    scene = new Scene(fakeCanvas());
  });

  it('keeps the bake without its lightmap when only the lightmap fails, with one warning: the vertex-lit doors keep their light, the lightmapped world is drawn as without a bake', async () => {
    scene = new Scene(fakeCanvas());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    serveBake({ lightmapStatus: 404, entities: true });
    await scene.loadMap('de_mirage');
    expect(warn).toHaveBeenCalledTimes(1);
    const said = String(warn.mock.lastCall?.[0]);
    expect(said).toContain('de_mirage');
    expect(said).toContain(
      '/maps/de_mirage/lightmap.webp?v=ffffffff: HTTP 404'
    );
    const baked = inside(scene).look.baked!;
    expect(baked.lightmap).toBeNull();
    expect(baked.lightGrid.size).toEqual([1, 2, 1]);
    // The bake's exposure and sun stay; the players take the grid.
    expect(inside(scene).renderer.toneMappingExposure).toBe(
      atmosphereFor('de_mirage').bakedExposure
    );
    expect(inside(scene).playerLook().lit).toBe(true);
    // The world here is all lightmap UV and no COLOR_0: today's material, without the bake.
    expect(worldMaterial().lightMap ?? null).toBeNull();
    expect(worldMaterial().customProgramCacheKey?.() ?? '').not.toContain(
      'baked'
    );
    // The door's COLOR_0 is its probe light: still drawn as light.
    let door: THREE.Mesh | null = null;
    inside(scene).scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh && m.geometry.hasAttribute('color')) door = m;
    });
    expect(door).not.toBeNull();
    const doorMaterial = door!.material as THREE.MeshLambertMaterial;
    expect(doorMaterial.customProgramCacheKey()).toContain('baked-vertex');
    warn.mockRestore();
  });

  it('loads the bake once for a load, the change of tier that supersedes it and the swaps after', async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    let answer!: (g: THREE.Group) => void;
    loadWorld.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const stale = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(answer).toBeDefined());
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    answer(new THREE.Group());
    await expect(stale).resolves.toBeUndefined();
    const closed = () =>
      bitmaps.filter(
        (b) => (b.close as ReturnType<typeof vi.fn>).mock.calls.length
      );
    // One bake decoded, drawn, none closed.
    expect(bitmaps).toHaveLength(1);
    expect(closed()).toHaveLength(0);
    const mirage = inside(scene).look.baked!;
    expect(worldMaterial().lightMap).toBe(mirage.lightmap);

    // A phone-tier swap overtaken by a change back shares the one bake too.
    loadWorld.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    scene.setQuality('medium');
    const swap = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(loadWorld).toHaveBeenCalledTimes(3));
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    answer(new THREE.Group());
    await expect(swap).resolves.toBeUndefined();
    expect(bitmaps).toHaveLength(1);
    expect(inside(scene).look.baked).toBe(mirage);
    expect(closed()).toHaveLength(0);
  });

  it("dresses a new baked map's world once, in its bake", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    dressed.calls.length = 0;
    await scene.loadMap('de_mirage');
    const world = inside(scene).mapAssets.world;
    const looks = dressed.calls.filter((c) => c.root === world);
    expect(looks).toHaveLength(1);
    expect(looks[0].look.baked).toBe(inside(scene).look.baked);
    // And the phone-tier swap's world once.
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    const lo = inside(scene).mapAssets.world;
    expect(dressed.calls.filter((c) => c.root === lo)).toHaveLength(1);
  });

  it("draws the world's shadow once for the map, not every frame, and again when the preset or the world changes", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const drawn: THREE.Object3D[][] = [];
    const shadow = vi
      .spyOn(inside(scene).renderer.shadowMap, 'render')
      .mockImplementation((_lights, root, camera) => {
        drawn.push(shadowCasters(root, camera));
      });
    const worldMesh = () => inside(scene).mapAssets.world!.children[0];
    scene.render();
    expect(scene.stats.worldShadows).toBe(1);
    expect(shadow).toHaveBeenCalledTimes(1);
    expect(shadow.mock.lastCall?.[0]).toEqual([inside(scene).lighting.sun]);
    expect(drawn.at(-1)).toEqual([worldMesh()]);
    scene.render();
    scene.render();
    expect(scene.stats.worldShadows).toBe(1);
    scene.setQuality('low');
    scene.setQuality('medium');
    scene.render();
    expect(scene.stats.worldShadows).toBe(2);
    // The phone tier's world at low, which draws no shadow on this map, then today's again.
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    scene.render();
    expect(scene.stats.worldShadows).toBe(2);
    const lo = worldMesh();
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    expect(worldMesh()).not.toBe(lo);
    scene.render();
    expect(scene.stats.worldShadows).toBe(3);
    expect(drawn.at(-1)).toEqual([worldMesh()]);
  });

  it('keeps nothing of a baked world for its shadow once the preset draws none (low)', async () => {
    scene = new Scene(fakeCanvas());
    serveBake({ entities: true });
    await scene.loadMap('de_mirage');
    scene.render();
    const meshes: THREE.Mesh[] = [];
    for (const root of [
      inside(scene).mapAssets.world!,
      inside(scene).mapAssets.entities!.models,
    ])
      root.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
    expect(meshes.length).toBe(2);
    for (const m of meshes)
      expect(m.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(true);
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    scene.render();
    const held = inside(scene).lighting as unknown as {
      casters: THREE.Mesh[];
      casterRoots: (THREE.Object3D | null)[];
    };
    expect(held.casters).toEqual([]);
    expect(held.casterRoots).toEqual([null, null]);
    for (const m of meshes)
      expect(m.layers.isEnabled(WORLD_CASTER_LAYER)).toBe(false);
  });

  it("dresses a baked map's doors and windows once, as its world: by the light in their COLOR_0, without the detail texture", async () => {
    scene = new Scene(fakeCanvas());
    serveBake({ entities: true });
    dressed.calls.length = 0;
    await scene.loadMap('de_mirage');
    const doors = inside(scene).mapAssets.entities!.models;
    const looks = dressed.calls.filter((c) => c.root === doors);
    expect(looks).toHaveLength(1);
    expect(looks[0].look.baked).toBe(inside(scene).look.baked);
    const slab = () =>
      doors.getObjectByProperty('isMesh', true) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshLambertMaterial
      >;
    const keyOf = () => slab().material.customProgramCacheKey();
    expect(slab().material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(slab().material.lightMap).toBeNull();
    expect(keyOf()).toContain('baked-vertex-sunbaked');
    expect(keyOf()).not.toContain('detail');
    // At every preset, as the world.
    scene.setQuality('low');
    expect(slab().material).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(keyOf()).toContain('baked-vertex-sunbaked');
    // Without a bake, the AO look of today, with the detail texture where the preset has it.
    serveBake({ listed: false });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/manifest.json')
          ? {
              ok: true,
              status: 200,
              json: async () => ({
                files: { 'entities.glb': { sha256: 'c'.repeat(64) } },
              }),
            }
          : { ok: false, status: 404 }
      )
    );
    fresh();
    await scene.loadMap('de_dust2');
    const plain = inside(scene).mapAssets.entities!.models.getObjectByProperty(
      'isMesh',
      true
    ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    expect(plain.material.vertexColors).toBe(true);
    expect(plain.material.customProgramCacheKey()).not.toContain('baked');
    expect(plain.material.customProgramCacheKey()).toContain('detail');
  });

  it("holds high's sky to the white under the bloom threshold in force: a baked map's, BLOOM_THRESHOLD's again without a bake", async () => {
    const hadImage = 'Image' in globalThis;
    if (!hadImage)
      (globalThis as Record<string, unknown>).Image = class {
        src = '';
        onload: (() => void) | null = null;
      };
    try {
      gpu.floatTargets = true;
      scene = new Scene(fakeCanvas(), 'high');
      gpu.floatTargets = false;
      serveBake();
      const { scene: s3 } = inside(scene);
      await scene.loadMap('de_mirage');
      await vi.waitFor(() =>
        expect((s3.background as THREE.Texture | null)?.name).toBe(
          'SkyBehindNeutral'
        )
      );
      const exposure = atmosphereFor('de_mirage').bakedExposure;
      const threshold = BAKED_BLOOM_WHITE / exposure;
      const behind = (
        scene as unknown as { sky: { skyBehind: { threshold: number } } }
      ).sky.skyBehind;
      expect(behind.threshold).toBeCloseTo(threshold, 12);
      const want = behindNeutral(
        new THREE.Color('#405060'),
        exposure,
        skyWhite(exposure, threshold)
      );
      expect((s3.fog as THREE.Fog).color.equals(want)).toBe(true);

      serveBake({ listed: false });
      scene.dispose();
      gpu.floatTargets = true;
      scene = new Scene(fakeCanvas(), 'high');
      gpu.floatTargets = false;
      await scene.loadMap('de_dust2');
      const dust2 = atmosphereFor('de_dust2');
      const plain = behindNeutral(
        new THREE.Color(dust2.sky),
        dust2.exposure,
        skyWhite(dust2.exposure)
      );
      expect((inside(scene).scene.fog as THREE.Fog).color.equals(plain)).toBe(
        true
      );
    } finally {
      if (!hadImage) delete (globalThis as Record<string, unknown>).Image;
    }
  });

  it("in POV inside a lit smoke closes the fog in in the smoke's colour, and gives it back the sky's colour outside", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const s = scene as unknown as {
      placeFog(): void;
      sky: { skyColor: THREE.Color };
      cameras: { mode: string };
    };
    const {
      utility,
      scene: s3,
      post,
    } = inside(scene) as Inside & {
      utility: {
        eyeInSmoke(eye: THREE.Vector3): boolean;
        smokeColorAt(eye: THREE.Vector3): THREE.Color | null;
      };
    };
    const fog = s3.fog as THREE.Fog;
    const sky = s.sky.skyColor.clone();
    const lit = new THREE.Color(0.9, 0.85, 0.8);
    vi.spyOn(utility, 'eyeInSmoke').mockReturnValue(true);
    const at = vi.spyOn(utility, 'smokeColorAt').mockReturnValue(lit);
    s.cameras.mode = 'pov';
    s.placeFog();
    const exposure = atmosphereFor('de_mirage').bakedExposure;
    expect(
      fog.color.equals(
        inSmokeFog(lit, post.enabled, exposure, new THREE.Color())
      )
    ).toBe(true);
    expect(fog.color.equals(sky)).toBe(false);
    // A smoke in the fog's colour (no bake): the fog keeps the sky's.
    at.mockReturnValue(null);
    s.placeFog();
    expect(fog.color.equals(sky)).toBe(true);
    // Out of the smoke again: the sky's colour.
    at.mockReturnValue(lit);
    s.placeFog();
    vi.spyOn(utility, 'eyeInSmoke').mockReturnValue(false);
    s.placeFog();
    expect(fog.color.equals(sky)).toBe(true);
  });

  it("hands the utility the bake's sun in the grid's units (π·brightness over π), which lights the smokes; none without a bake", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const set = vi.spyOn(inside(scene).utility, 'set');
    const pack = trackPack({ samples: 400, teams: [2], players: [() => ({})] });
    scene.setFrame(0, 1050, pack);
    scene.render();
    const o = set.mock.lastCall![3];
    expect(o.grid).not.toBeNull();
    const want = new THREE.Color().fromArray(LIGHT.sun.color);
    for (const c of ['r', 'g', 'b'] as const)
      expect(o.sunLight![c]).toBeCloseTo(want[c] * LIGHT.sun.intensity, 9);
    // The new scene asks for the weapons' manifest as it is made: none here.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404 }))
    );
    fresh();
    serveBake({ listed: false });
    const plain = vi.spyOn(inside(scene).utility, 'set');
    await scene.loadMap('de_dust2');
    scene.setFrame(0, 1050, pack);
    scene.render();
    expect(plain.mock.lastCall![3].grid).toBeNull();
    expect(plain.mock.lastCall![3].sunLight).toBeNull();
  });

  it("hands the doors and windows the tone mapping's exposure, which a window's dust divides out", async () => {
    scene = new Scene(fakeCanvas());
    serveBake({ entities: true });
    await scene.loadMap('de_mirage');
    const set = vi.spyOn(inside(scene).mapAssets.entities!, 'set');
    const pack = trackPack({ samples: 400, teams: [2], players: [() => ({})] });
    scene.setFrame(0, 1050, pack);
    scene.render();
    const { renderer } = inside(scene);
    expect(renderer.toneMappingExposure).toBe(
      atmosphereFor('de_mirage').bakedExposure
    );
    expect(set.mock.lastCall?.[4]).toBe(renderer.toneMappingExposure);
  });

  it("draws the doors into the world's shadow as they stand, again on a frame one turns, and never into the players' map", async () => {
    scene = new Scene(fakeCanvas());
    serveBake({ entities: true });
    await scene.loadMap('de_mirage');
    const doors = inside(scene).mapAssets.entities!.models;
    const slab = doors.getObjectByProperty('isMesh', true) as THREE.Mesh;
    // The renderer's pass every frame is the players' map, which the baked world takes: a door
    // there would darken the world under it a second time.
    expect(slab.castShadow).toBe(false);
    expect(slab.receiveShadow).toBe(true);
    const drawn: { casters: THREE.Object3D[]; yaw: number }[] = [];
    vi.spyOn(inside(scene).renderer.shadowMap, 'render').mockImplementation(
      (_lights, root, camera) => {
        drawn.push({
          casters: shadowCasters(root, camera),
          yaw: +new THREE.Euler()
            .setFromQuaternion(doors.children[0].quaternion, 'YXZ')
            .y.toFixed(3),
        });
      }
    );
    // The door swings 90° over ticks 1100–1130 of the round.
    const pack = trackPack({ samples: 400, teams: [2], players: [() => ({})] });
    pack.entities = [{ kind: 'door', x: 0, y: 0, z: 0 }];
    pack.entityChanges = [
      {
        round: 0,
        entity: 0,
        tick: 1100,
        pitch: 0,
        yaw: 0,
        roll: 0,
        gone: false,
      },
      {
        round: 0,
        entity: 0,
        tick: 1130,
        pitch: 0,
        yaw: 9000,
        roll: 0,
        gone: false,
      },
    ];
    scene.setFrame(0, 1050, pack);
    scene.render();
    scene.render();
    expect(scene.stats.worldShadows).toBe(1);
    // Mid-swing and at its end: drawn again each time; standing still after: not.
    scene.setFrame(0, 1115, pack);
    scene.render();
    scene.setFrame(0, 1200, pack);
    scene.render();
    scene.setFrame(0, 1300, pack);
    scene.render();
    expect(scene.stats.worldShadows).toBe(3);
    // The world and the door, of everything in the scene.
    const world = inside(scene).mapAssets.world!.children[0];
    expect(drawn.map((d) => d.casters)).toEqual([
      [world, slab],
      [world, slab],
      [world, slab],
    ]);
    expect(drawn.map((d) => Math.abs(d.yaw))).toEqual([0, 0.785, 1.571]);
    expect(slab.castShadow).toBe(false);
  });

  it('keeps the bake the world is drawn with through a phone-tier swap that failed to load, for the next', async () => {
    scene = new Scene(fakeCanvas());
    const fetch = serveBake();
    await scene.loadMap('de_mirage');
    const mirage = inside(scene).look.baked!;
    loadWorld.mockImplementationOnce(async () => {
      throw new Error('world_lo.glb: HTTP 500');
    });
    scene.setQuality('low');
    await expect(scene.loadMap('de_mirage')).rejects.toThrow('HTTP 500');
    expect(worlds(scene)).toHaveLength(1);
    scene.setQuality('medium');
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    expect(loadWorld.mock.lastCall?.[0]).toContain('world_lo.glb');
    const mirageAsked = (name: string) =>
      fetch.mock.calls.filter(([u]) => String(u).includes(`de_mirage/${name}`))
        .length;
    expect(mirageAsked('light.json')).toBe(1);
    expect(mirageAsked('lightmap.webp')).toBe(1);
    expect(mirageAsked('probes.bin')).toBe(1);
    expect(inside(scene).look.baked).toBe(mirage);
    expect(worldMaterial().lightMap).toBe(mirage.lightmap);
    expect(bitmaps[0].close).not.toHaveBeenCalled();
  });

  it('lights each player shown by the light grid at their chest, and by the sky light on a map without one', async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const rig = {
      object: new THREE.Object3D(),
      setProbe: vi.fn(),
    };
    // Standing at y = 1: the chest, a metre up, is 0.8 of the way to the bright cells.
    rig.object.position.set(0, 1, 0);
    const pool = {
      size: 2,
      root: new THREE.Group(),
      active: (i: number) => (i === 0 ? rig : null),
      setLook() {},
      setViewport() {},
      dispose() {},
    };
    inside(scene).players.pool = pool;
    inside(scene).lightPlayers();
    expect(rig.setProbe).toHaveBeenCalledTimes(1);
    const s = rig.setProbe.mock.lastCall![0];
    expect(s.up.r).toBeCloseTo(0.8 * 8, 5);
    expect(s.down.g).toBeCloseTo(0.8 * (64 / 255) ** 2 * 8, 5);
    expect(s.side.b).toBeCloseTo(0.8 * (128 / 255) ** 2 * 8, 5);
    expect(s.sun).toBeCloseTo(0.8, 5);
    // The next frame lights the same sample in place: nothing is made per frame.
    rig.object.position.set(0, -10, 0);
    inside(scene).lightPlayers();
    expect(rig.setProbe.mock.lastCall![0]).toBe(s);
    expect(s.up.r).toBe(0);

    serveBake({ listed: false });
    fresh();
    await scene.loadMap('de_dust2');
    inside(scene).players.pool = pool;
    inside(scene).lightPlayers();
    expect(rig.setProbe.mock.lastCall![0]).toBeNull();
  });

  it("lights the arms with the shown player's grid light, and the sun past the hull from the eye at medium and high, by the grid at low", async () => {
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    const shown = makeProbeSample();
    shown.up.setRGB(0.5, 0.4, 0.3);
    shown.down.setRGB(0.1, 0.2, 0.3);
    shown.side.setRGB(0.2, 0.3, 0.4);
    shown.sun = 0.25;
    inside(scene).players.lightSamples[3] = shown;
    const setProbe = vi.spyOn(inside(scene).viewmodel, 'setProbe');
    // Mirage's hull here is a 10 m box at its centre: from inside it the roof hides the sun.
    const centre = v3(CENTRES.de_mirage);
    inside(scene).lightViewmodel(3, centre);
    const s = setProbe.mock.lastCall![0]!;
    expect(s).not.toBe(shown);
    expect(s.up.toArray()).toEqual(shown.up.toArray());
    expect(s.down.toArray()).toEqual(shown.down.toArray());
    expect(s.side.toArray()).toEqual(shown.side.toArray());
    expect(s.sun).toBe(0);
    // Above it, in the open.
    inside(scene).lightViewmodel(3, centre.clone().setY(20));
    expect(setProbe.mock.lastCall![0]).toBe(s);
    expect(s.sun).toBe(1);
    // At low there is no shadow map: the grid's sun.
    scene.setQuality('low');
    inside(scene).lightViewmodel(3, centre);
    expect(s.sun).toBe(0.25);
    // Nobody's light to take, or no grid: the sky light.
    scene.setQuality('medium');
    inside(scene).lightViewmodel(5, centre);
    expect(setProbe.mock.lastCall![0]).toBeNull();
    serveBake({ listed: false });
    fresh();
    await scene.loadMap('de_dust2');
    const plainProbe = vi.spyOn(inside(scene).viewmodel, 'setProbe');
    inside(scene).players.lightSamples[3] = shown;
    inside(scene).lightViewmodel(3, centre);
    expect(plainProbe.mock.lastCall![0]).toBeNull();
  });

  it("in POV draws and lights the arms only while the player shown is alive: in their death view the arms are hidden and take neither grid light nor a sun ray, until the killer's eyes", async () => {
    // The name over the other player's head is drawn on a canvas, which node lacks.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return { clearRect() {}, strokeText() {}, fillText() {} };
        }
      }
    );
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    // Every weapon model a box, as the cache holds them (no arms here: the gun is drawn alone).
    const model = new THREE.Group().add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    );
    vi.spyOn(inside(scene).weapons, 'get').mockReturnValue(model);
    // Player 1 (T) dies on sample 50 (tick 1100), killed by player 2 (CT) 2 m away.
    const pack = trackPack({
      samples: 400,
      teams: [2, 3],
      weapons: ['none', 'AK-47'],
      players: [
        (k) => (k < 50 ? {} : { flags: 0, health: 0 }),
        () => ({ x: 0, y: 80, yaw: -90 }),
      ],
      events: [event('player_death', 1100, { user_idx: 0, attacker_idx: 1 })],
    });
    const { viewmodel, players } = inside(scene);
    const { lightSamples } = players;
    // Their grid samples, as `lightPlayers` keeps them (there are no rigs here to sample at).
    lightSamples[0] = makeProbeSample();
    lightSamples[1] = makeProbeSample();
    const light = vi.spyOn(inside(scene), 'lightViewmodel');
    const probe = vi.spyOn(viewmodel, 'setProbe');
    const sees = vi.spyOn(scene.hull!, 'sees');
    const eyeOfCamera = () => {
      const c = scene.cameraDebug();
      return new THREE.Vector3(c.x, c.y, c.z);
    };
    scene.setCamera('pov', 0);
    // Alive: the gun is drawn, lit by player 1's sample and one ray to the sun from their eye.
    scene.setFrame(0, 1050, pack);
    scene.render();
    expect(viewmodel.visible).toBe(true);
    expect(light).toHaveBeenCalledTimes(1);
    expect(light.mock.lastCall![0]).toBe(0);
    expect(sees).toHaveBeenCalledTimes(1);
    expect(probe.mock.lastCall![0]).not.toBeNull();
    // Their death view, for its 2 s: the eye where they died, the arms hidden, nothing lit.
    const hold = DEATH_VIEW_S * pack.header.tick_rate;
    for (const t of [1100, 1150, 1100 + hold - 2]) {
      scene.setFrame(0, t, pack);
      scene.render();
      expect(scene.cameraDebug().shown).toBe(0);
      expect(viewmodel.visible).toBe(false);
    }
    expect(light).toHaveBeenCalledTimes(1);
    expect(sees).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
    // Then the killer's eyes: drawn again, lit by the killer's sample from the killer's eye.
    scene.setFrame(0, 1100 + hold + 2, pack);
    scene.render();
    expect(scene.cameraDebug().shown).toBe(1);
    expect(viewmodel.visible).toBe(true);
    expect(light).toHaveBeenCalledTimes(2);
    expect(light.mock.lastCall![0]).toBe(1);
    expect(light.mock.lastCall![1].distanceTo(eyeOfCamera())).toBeLessThan(
      1e-6
    );
    expect(sees).toHaveBeenCalledTimes(2);
    expect(sees.mock.lastCall![0].distanceTo(eyeOfCamera())).toBeLessThan(1e-6);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('lights the grenades in flight, the items on the ground and the bomb by the light grid on a baked map, each by its own sample, and by the sky light again without a bake', async () => {
    // The grenade's label is drawn on a canvas, which node lacks.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return { clearRect() {}, strokeText() {}, fillText() {} };
        }
      }
    );
    scene = new Scene(fakeCanvas());
    serveBake();
    await scene.loadMap('de_mirage');
    // Every weapon model a box in a glTF (Standard) material, as the cache holds them.
    const model = new THREE.Group().add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial())
    );
    vi.spyOn(inside(scene).weapons, 'get').mockReturnValue(model);
    // A smoke in flight 64 units up, an AK on the floor and the bomb planted at the feet of the
    // one player, at the origin: the grid's dark cell, 2.5 m under its bright one.
    const pack = trackPack({
      samples: 200,
      teams: [2],
      weapons: ['none', 'AK-47'],
      players: [() => ({ x: 0, y: 0, z: 0 })],
      events: [event('bomb_planted', 1100, { user_idx: 0, site: 1 })],
      grenades: [
        grenadeTrack({
          kind: 'smoke',
          thrower: 0,
          start_tick: 1100,
          from: [0, 0, 64],
          to: [400, 0, 64],
          samples: 51,
        }),
      ],
    });
    pack.ground = [
      {
        round: 0,
        id: 1,
        weapon: 1,
        tick: 1050,
        x: 0,
        y: 0,
        z: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
        gone: false,
      },
    ];
    type Lit = THREE.Mesh<THREE.BufferGeometry, THREE.MeshLambertMaterial>;
    const meshes = () => {
      const mesh = (o: THREE.Object3D | undefined) =>
        o?.getObjectByProperty('isMesh', true) as Lit;
      return {
        grenade: mesh(
          inside(scene).utility.root.getObjectByName('grenade:smokegrenade')
        ),
        gun: mesh(inside(scene).ground.root.children.find((c) => c.visible)),
        bomb: mesh(inside(scene).impacts.root.getObjectByName('bomb')),
      };
    };
    const sunOf = (m: THREE.Material) => {
      const src = THREE.ShaderLib.lambert;
      const shader = {
        uniforms: THREE.UniformsUtils.clone(src.uniforms),
        vertexShader: src.vertexShader,
        fragmentShader: src.fragmentShader,
      } as Parameters<THREE.Material['onBeforeCompile']>[0];
      m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
      return shader.uniforms.probeSun.value as number;
    };
    scene.setFrame(0, 1150, pack);
    scene.render();
    const lit = meshes();
    const materials = Object.values(lit).map((m) => m.material);
    // Copies of their own, dressed in the players' look: none is the cache's or another's.
    const cached = (model.children[0] as THREE.Mesh).material;
    expect(new Set([...materials, cached]).size).toBe(4);
    for (const m of materials) {
      expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
      expect(m.customProgramCacheKey()).toContain('probe');
      expect(m.customProgramCacheKey()).not.toContain('interim');
    }
    for (const mesh of Object.values(lit))
      expect(mesh.receiveShadow).toBe(true);
    // The gun and the bomb are read half a metre up, the grenade where it flies (1.63 m).
    expect(sunOf(lit.gun.material)).toBeCloseTo(0.5 / 2.5, 6);
    expect(sunOf(lit.bomb.material)).toBeCloseTo(0.5 / 2.5, 6);
    expect(sunOf(lit.grenade.material)).toBeCloseTo((64 * 0.0254) / 2.5, 6);

    // A map without a bake: the sky light, and the shadows the look gives them.
    serveBake({ listed: false });
    fresh();
    vi.spyOn(inside(scene).weapons, 'get').mockReturnValue(model);
    await scene.loadMap('de_dust2');
    scene.setFrame(0, 1150, pack);
    scene.render();
    const plain = meshes();
    for (const mesh of Object.values(plain))
      expect(mesh.material.customProgramCacheKey()).not.toContain('probe');
    expect(plain.gun.receiveShadow).toBe(true);
    expect(plain.grenade.receiveShadow).toBe(false);
    expect(plain.bomb.receiveShadow).toBe(false);
  });
});

// `high` with float targets: the post stack draws, and the sky is its `SkyBehindNeutral` copy.
describe("the sky's GPU copies as the preset changes", () => {
  let scene: InstanceType<typeof Scene>;
  let listeners: Listeners;
  // SMAA decodes its lookup tables from data URLs into images; node has no Image.
  const hadImage = 'Image' in globalThis;

  beforeEach(() => {
    if (!hadImage)
      (globalThis as Record<string, unknown>).Image = class {
        src = '';
        onload: (() => void) | null = null;
      };
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    loadSky.mockClear();
    gpu.floatTargets = true;
    listeners = {};
    scene = new Scene(fakeCanvas(listeners), 'high');
    gpu.floatTargets = false;
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
    if (!hadImage) delete (globalThis as Record<string, unknown>).Image;
  });

  /** Loads Mirage at `high` and waits for the post stack's copy of its sky. */
  async function atHigh() {
    serveWithSky();
    const { scene: s3 } = inside(scene);
    await scene.loadMap('de_mirage');
    await vi.waitFor(() =>
      expect((s3.background as THREE.Texture | null)?.name).toBe(
        'SkyBehindNeutral'
      )
    );
    const source = await loadSky.mock.results[0].value;
    return {
      s3,
      copy: s3.background as THREE.Texture,
      source: source as THREE.Texture,
    };
  }

  const freed = (t: THREE.Texture) => {
    const f = vi.fn();
    t.addEventListener('dispose', f);
    return f;
  };

  it("draws the sky through the post stack's copy, and frees the source's upload once copied", async () => {
    const sourceFreed = vi.fn();
    loadSky.mockImplementationOnce(async (url) => {
      const t = new THREE.Texture({ width: 2048, height: 1024 });
      t.name = url;
      t.addEventListener('dispose', sourceFreed);
      return t;
    });
    const { s3, copy } = await atHigh();
    expect(copy.mapping).toBe(THREE.EquirectangularReflectionMapping);
    // The copy has the intensity in it.
    expect(s3.backgroundIntensity).toBe(1);
    expect(sourceFreed).toHaveBeenCalledTimes(1);
  });

  it('frees the copy and the source at low, and the copy alone at medium', async () => {
    const { s3, copy, source } = await atHigh();
    const copyFreed = freed(copy);
    const sourceFreed = freed(source);
    scene.setQuality('medium');
    expect(copyFreed).toHaveBeenCalledTimes(1);
    expect(sourceFreed).not.toHaveBeenCalled();
    expect(s3.background).toBe(source);

    scene.setQuality('low');
    expect(sourceFreed).toHaveBeenCalledTimes(1);
    expect(s3.background).toBeInstanceOf(THREE.Color);
    // Back at medium the same texture is drawn again, without asking for it again.
    scene.setQuality('medium');
    expect(s3.background).toBe(source);
    expect(loadSky).toHaveBeenCalledTimes(1);
  });

  it('frees the copy straight from high to low', async () => {
    const { s3, copy, source } = await atHigh();
    const copyFreed = freed(copy);
    const sourceFreed = freed(source);
    scene.setQuality('low');
    expect(copyFreed).toHaveBeenCalledTimes(1);
    expect(sourceFreed).toHaveBeenCalledTimes(1);
    expect(s3.background).toBeInstanceOf(THREE.Color);
  });

  /**
   * Disposes `s`, checks its WebGL context was let go after three.js's dispose, and returns what
   * anything asks of its renderer from then on.
   */
  function disposeWatched(s: InstanceType<typeof Scene>): string[] {
    const renderer = inside(s).renderer as unknown as Record<
      string,
      () => void
    >;
    s.dispose();
    expect(renderer.gone).toEqual(['dispose', 'context']);
    const asked: string[] = [];
    for (const name of Object.getOwnPropertyNames(
      Object.getPrototypeOf(renderer)
    ))
      if (name !== 'constructor')
        vi.spyOn(renderer, name).mockImplementation(() => {
          asked.push(name);
        });
    return asked;
  }

  it('lets go of its WebGL context when disposed, and asks nothing of the renderer after', async () => {
    // Closed with the world in and its sky on its way: a sky that came, or the context coming
    // back, would be copied through the renderer.
    serveWithSky();
    let skyIn!: (t: THREE.Texture) => void;
    loadSky.mockImplementationOnce(() => new Promise((r) => (skyIn = r)));
    await scene.loadMap('de_mirage');
    expect(loadSky).toHaveBeenCalledTimes(1);
    const asked = disposeWatched(scene);
    const sky = new THREE.Texture();
    const skyFreed = freed(sky);
    skyIn(sky);
    await vi.waitFor(() => expect(skyFreed).toHaveBeenCalledTimes(1));
    listeners.webglcontextrestored?.();
    scene.render();
    scene.setQuality('medium');
    expect(await scene.probeFps()).toBeNaN();
    expect(asked).toEqual([]);
  });

  it('asks nothing of the renderer for a world that comes after it was disposed', async () => {
    serveWithSky();
    loadWorld.mockClear();
    let worldIn!: (g: THREE.Group) => void;
    loadWorld.mockImplementationOnce(() => new Promise((r) => (worldIn = r)));
    const load = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(loadWorld).toHaveBeenCalledTimes(1));
    const asked = disposeWatched(scene);
    worldIn(new THREE.Group());
    await load;
    expect(loadSky).not.toHaveBeenCalled();
    expect(asked).toEqual([]);
  });

  it("makes the copy again, and the world's shadow, when the WebGL context comes back", async () => {
    const { s3, copy } = await atHigh();
    const copyFreed = freed(copy);
    const shadow = vi.spyOn(inside(scene).lighting, 'invalidateWorldShadow');
    listeners.webglcontextrestored?.();
    expect(shadow).toHaveBeenCalledTimes(1);
    expect(copyFreed).toHaveBeenCalledTimes(1);
    expect(s3.background).not.toBe(copy);
    expect((s3.background as THREE.Texture).name).toBe('SkyBehindNeutral');
  });
});

describe('Scene weapons', () => {
  let scene: InstanceType<typeof Scene>;
  type WithWeapons = {
    weapons: { onLoad: (() => void) | null; get(name: string): unknown };
  };
  const weapons = () => (scene as unknown as WithWeapons).weapons;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    serve();
    scene = new Scene(fakeCanvas());
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
  });

  // A paused replay draws no new frame of its own: a gun whose model arrives after the
  // players were posed was never put in their hands until the tick moved.
  it('poses the players again when a weapon model arrives', () => {
    const pack = trackPack({ samples: 10, teams: [2], players: [() => ({})] });
    scene.setFrame(0, 1003, pack);
    const setFrame = vi.spyOn(scene, 'setFrame');
    weapons().onLoad?.();
    expect(setFrame).toHaveBeenCalledWith(0, 1003, pack);
  });

  it("asks for the models of the round's weapons when the round is first shown", () => {
    const pack = trackPack({
      samples: 10,
      teams: [2, 3],
      weapons: ['none', 'AK-47', 'Knife', 'USP-S'],
      players: [
        (k) => ({ weapon: k < 5 ? 1 : 2 }),
        (k) => ({ weapon: k < 5 ? 3 : 2 }),
      ],
    });
    const get = vi.spyOn(weapons(), 'get');
    scene.setFrame(0, 1003, pack);
    const asked = new Set(get.mock.calls.map(([n]) => n));
    expect(asked).toEqual(new Set(['ak47', 'knife_t', 'usp', 'knife']));
    get.mockClear();
    scene.setFrame(0, 1005, pack);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('Scene smokes over the effects', () => {
  let scene: InstanceType<typeof Scene>;
  type Batches = {
    utility: { root: THREE.Object3D; smokeSpheres: readonly unknown[] };
    impacts: { root: THREE.Object3D; set(...a: unknown[]): void };
    marks: { root: THREE.Object3D; set(...a: unknown[]): void };
  };
  const parts = () => scene as unknown as Batches;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    serve();
    scene = new Scene(fakeCanvas());
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
  });

  it("hands the impacts and the marks the utility's own smokes, just posed, and the marks one options object", () => {
    const pack = trackPack({
      samples: 400,
      teams: [2],
      players: [() => ({})],
      events: [
        event('smokegrenade_detonate', 1010, {
          entityid: 5,
          user_idx: 0,
          x: 400,
          y: 0,
          z: 0,
        }),
      ],
    });
    const { utility, impacts, marks } = parts();
    const hits = vi.spyOn(impacts, 'set');
    const bullets = vi.spyOn(marks, 'set');
    scene.setFrame(0, 1050, pack);
    scene.render();
    const o = hits.mock.lastCall![3] as { smokes: readonly unknown[] };
    // Not a copy: the utility's list, holding the smoke shown.
    expect(o.smokes).toBe(utility.smokeSpheres);
    expect(o.smokes).toHaveLength(1);
    const m = bullets.mock.lastCall![4] as {
      smokes: readonly unknown[];
      eye: THREE.Vector3;
    };
    expect(m.smokes).toBe(utility.smokeSpheres);
    expect(m.eye).toBeInstanceOf(THREE.Vector3);
    scene.setFrame(0, 1060, pack);
    scene.render();
    expect(bullets.mock.lastCall![4]).toBe(m);
  });

  it('makes no options object and reads no layout per draw: each part is handed the one it had, filled in place', () => {
    const pack = trackPack({
      samples: 400,
      teams: [2],
      players: [() => ({})],
    });
    // The canvas's size is read when it resizes, not in a draw.
    let reads = 0;
    const canvas = fakeCanvas();
    for (const key of ['clientWidth', 'clientHeight'] as const)
      Object.defineProperty(canvas, key, {
        get: () => {
          reads++;
          return key === 'clientWidth' ? 1600 : 900;
        },
      });
    scene.dispose();
    scene = new Scene(canvas);
    type Parts = {
      cameras: { update(...a: unknown[]): THREE.Camera };
      utility: { set(...a: unknown[]): void };
      impacts: { set(...a: unknown[]): void };
      nameTags: { update(...a: unknown[]): void };
      lastFrame: unknown;
    };
    const p = scene as unknown as Parts;
    const spies = [
      [vi.spyOn(p.cameras, 'update'), 2],
      [vi.spyOn(p.utility, 'set'), 3],
      [vi.spyOn(p.impacts, 'set'), 3],
      [vi.spyOn(p.nameTags, 'update'), 3],
    ] as const;
    scene.setFrame(0, 1050, pack);
    const last = p.lastFrame;
    scene.render();
    const first = spies.map(([s, i]) => s.mock.lastCall![i]);
    reads = 0;
    scene.setFrame(0, 1060, pack);
    scene.render();
    scene.setFrame(0, 1070, pack);
    scene.render();
    spies.forEach(([s, i], k) => expect(s.mock.lastCall![i]).toBe(first[k]));
    expect(p.lastFrame).toBe(last);
    expect(
      (p.cameras.update as unknown as { mock: { lastCall: unknown[] } }).mock
        .lastCall[2]
    ).toMatchObject({ round: 0, tick: 1070, pack });
    expect(reads).toBe(0);
  });

  it("draws the smokes' batch first of the effects' batches, which all stand at the origin and tie in depth, so what stands in front of a smoke is drawn over it", () => {
    const { utility, impacts, marks } = parts();
    const batches: THREE.Mesh[] = [];
    for (const root of [utility.root, impacts.root, marks.root])
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh && m.geometry instanceof THREE.InstancedBufferGeometry)
          batches.push(m);
      });
    const smokes = batches.find((b) => b.name === 'smokes')!;
    const covered = batches.filter((b) =>
      [
        'he-fireball',
        'he-smoke',
        'decoy-flash',
        'decoy-sparks',
        'muzzle-flashes',
        'blood-puffs',
        'impact-dust',
        'impact-sparks',
        'impact-chips',
      ].includes(b.name)
    );
    expect(covered).toHaveLength(9);
    for (const b of [smokes, ...covered]) {
      expect(b.renderOrder).toBe(0);
      b.updateWorldMatrix(true, false);
      expect(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)).toEqual(
        new THREE.Vector3()
      );
    }
    // three's transparent sort goes by render order, then depth, then id: the smokes' is lowest.
    for (const b of covered) expect(smokes.id).toBeLessThan(b.id);
  });
});

describe('Scene without the effects atlases', () => {
  let scene: InstanceType<typeof Scene>;
  type Parts = {
    utility: { root: THREE.Object3D };
    impacts: { root: THREE.Object3D };
    marksDebug(): ReturnType<BulletMarks['debug']>;
  };

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('draws every effect of the three tasks from the generated sprites when /effects/ answers 404: one warning, nothing thrown, the manifest asked for once', async () => {
    const fetch = vi.fn(async (url: string) =>
      url.includes('/effects/')
        ? { ok: false, status: 404 }
        : {
            ok: true,
            status: 200,
            json: async () => ({ files: {}, weapons: {} }),
          }
    );
    vi.stubGlobal('fetch', fetch);
    // The labels' and damage numbers' canvases.
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        readonly width: number;
        readonly height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return {
            clearRect() {},
            fillText() {},
            strokeText() {},
            measureText: () => ({ width: 10 }),
          };
        }
      }
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scene = new Scene(fakeCanvas());
    await scene.loadMap('de_mirage');
    // Mirage's stand-in hull is a 10 m box about scene (100, 0, 100). Player 0 stands 15 m off
    // its near face's middle (Source x 3346, y 3937), looking at it (yaw 0, scene +z); player 1
    // 3 m to their side.
    const S = { x: 3346, y: 3937 };
    const at = (kind: string, tick: number, id: number, dx = 0) =>
      event(kind, tick, {
        entityid: id,
        user_idx: 0,
        x: S.x + dx,
        y: S.y,
        z: 0,
      });
    const pack = trackPack({
      samples: 600,
      teams: [2, 3],
      players: [() => ({ ...S }), () => ({ x: S.x, y: S.y + 120 })],
      events: [
        at('smokegrenade_detonate', 1010, 5, 200),
        at('hegrenade_detonate', 1100, 6, 150),
        at('flashbang_detonate', 1100, 7, 100),
        at('decoy_started', 1101, 8, 50),
        at('inferno_startburn', 1090, 9, 250),
        event('weapon_fire', 1100, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('fire_bullets', 1100, {
          user_idx: 0,
          angles_x: 0,
          angles_y: 0,
          origin_x: S.x,
          origin_y: S.y,
          origin_z: 64,
        }),
        event('player_hurt', 1100, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 20,
          health: 80,
          hitgroup: 'chest',
          weapon: 'ak47',
        }),
      ],
    });
    // Seen from the free camera: in POV the shooter's own flash waits for their first-person gun.
    (scene as unknown as { cameras: { mode: string } }).cameras.mode = 'free';
    scene.setFrame(0, 1101, pack);
    scene.render();
    // Every atlas asked for has its answer by now.
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    scene.setFrame(0, 1102, pack);
    scene.render();
    const { utility, impacts } = scene as unknown as Parts;
    const shown = (root: THREE.Object3D, name: string) => {
      const out: THREE.Object3D[] = [];
      root.traverseVisible((o) => {
        if (o.name === name) out.push(o);
      });
      return out;
    };
    // The utility's: the smoke's generated puffs, the HE's generated fireball, the flash's and the
    // decoy's glow, the fire's noise flames.
    const smokes = shown(utility.root, 'smokes')[0] as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.ShaderMaterial
    >;
    expect(smokes.geometry.instanceCount).toBeGreaterThan(0);
    expect(smokes.material.uniforms.uMap.value).toBeInstanceOf(
      THREE.DataTexture
    );
    expect(shown(utility.root, 'he-fireball')).toHaveLength(0);
    expect(shown(utility.root, 'decoy-flash')).toHaveLength(0);
    expect(shown(utility.root, 'fire-flames')).toHaveLength(1);
    expect(shown(utility.root, 'fire-burst')).toHaveLength(0);
    const sprites: THREE.Sprite[] = [];
    utility.root.traverseVisible((o) => {
      if (o instanceof THREE.Sprite && o.material.opacity > 0) sprites.push(o);
    });
    // The flash's, the HE's (and its generated fireball) and the decoy's.
    expect(sprites.length).toBeGreaterThanOrEqual(4);
    for (const s of sprites)
      expect(s.material.map).toBeInstanceOf(THREE.DataTexture);
    // The impacts': the tracer's generated flash, the generated blood puff.
    expect(shown(impacts.root, 'muzzle-flash')).toHaveLength(1);
    expect(shown(impacts.root, 'muzzle-flashes')).toHaveLength(0);
    expect(shown(impacts.root, 'blood')).toHaveLength(1);
    expect(shown(impacts.root, 'blood-puffs')).toHaveLength(0);
    // The marks': the miss's hole and puff on the box, generated.
    const marks = (scene as unknown as Parts).marksDebug();
    expect(marks.holes).toHaveLength(1);
    expect(marks.puffs).toBe(1);
    // One warning for all of it, and the manifest asked for once.
    const effects = warn.mock.calls.filter(([m]) =>
      String(m).startsWith('effects:')
    );
    expect(effects).toHaveLength(1);
    expect(
      fetch.mock.calls.filter(([u]) => String(u).includes('/effects/'))
    ).toEqual([['/effects/manifest.json']]);
  });
});
