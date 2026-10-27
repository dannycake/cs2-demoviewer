// The phone tier (the `low` preset's world and players, with smaller textures): Scene.loadMap and
// Scene.loadRigs load `world_lo.glb` and `players/<side>_lo.glb` at the scene's tier where the
// manifests list them, today's files where they do not, and never the HD world an older
// manifest still lists; a preset change to or from `low` swaps them by itself under the same
// view, without dressing the outgoing ones in the new look (no texture of theirs fetched or
// uploaded again), frees the models it replaced and reloads nothing when the files stay the
// same; a measured preset keeps the files. A restored WebGL context draws nothing until the GLB
// textures' released images are back (images.ts). WebGL does not exist in node: the renderer
// and the GLB loaders are stubbed, as in scene-map.test.ts.

import { Document, NodeIO } from '@gltf-transform/core';
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMapManifests } from '../src/api/assets';
import type { MatchHeader } from '../src/pack/types';
import { imageReleased, trackImage } from '../src/scene/images';
import type { RigTemplate } from '../src/scene/loaders';
import { PRESETS } from '../src/scene/quality';

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>();
  class FakeRenderer {
    readonly info = { render: { triangles: 0 }, autoReset: true, reset() {} };
    readonly capabilities = { getMaxAnisotropy: () => 16 };
    readonly extensions = { has: () => false };
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
    render(scene: THREE.Scene, camera: THREE.Camera) {
      (scene.onAfterRender as (...args: unknown[]) => void)(
        this,
        scene,
        camera
      );
    }
    dispose() {}
    forceContextLoss() {}
  }
  return { ...three, WebGLRenderer: FakeRenderer };
});

/** Each world: a box with a texture of its own, its URL in the texture's name. */
const loadWorld = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.Group>>(async (url) => {
    const { Group, Mesh, BoxGeometry, MeshBasicMaterial, Texture } =
      await import('three');
    const map = new Texture({ width: 4, height: 4, close() {} });
    map.name = url;
    const g = new Group();
    g.add(
      new Mesh(new BoxGeometry(60, 10, 60), new MeshBasicMaterial({ map }))
    );
    return g;
  })
);
const loadHull = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<THREE.BufferGeometry>>(async () => {
    const { BoxGeometry } = await import('three');
    return new BoxGeometry(10, 10, 10);
  })
);
/**
 * Each player model: one mesh with a texture of its own, held on `wpn`, its URL in the root's
 * and the texture's name, each one made listed in `made` with whether it was freed; a test can
 * hold a URL's answer back (`held`).
 */
const rigs = vi.hoisted(() => ({
  held: new Map<string, Promise<void>>(),
  made: [] as { url: string; template: RigTemplate; freed: boolean }[],
}));
const loadRigTemplate = vi.hoisted(() =>
  vi.fn<(url: string) => Promise<RigTemplate>>(async (url) => {
    await rigs.held.get(url);
    const { Bone, BoxGeometry, Group, Mesh, MeshStandardMaterial, Texture } =
      await import('three');
    const root = new Group();
    root.name = url;
    root.add(Object.assign(new Bone(), { name: 'wpn' }));
    const map = new Texture({ width: 4, height: 4, close() {} });
    map.name = url;
    const body = new Mesh(new BoxGeometry(), new MeshStandardMaterial({ map }));
    root.add(body);
    const template = { scene: root, clips: new Map(), variants: new Map() };
    const made = { url, template, freed: false };
    body.geometry.addEventListener('dispose', () => (made.freed = true));
    rigs.made.push(made);
    return template;
  })
);
vi.mock('../src/scene/loaders', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/loaders')>()),
  loadWorld,
  loadHull,
  loadRigTemplate,
}));
vi.mock('../src/scene/detail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/detail')>()),
  loadDetailTexture: async () => null,
}));

const { Scene } = await import('../src/scene/Scene');

// Each test serves its own manifests: none is kept from the last one's.
beforeEach(forgetMapManifests);

type Inside = {
  scene: THREE.Scene;
  mapAssets: { world: THREE.Group | null };
  players: { pool: { templates: Record<2 | 3, RigTemplate> } | null };
  cameras: { camera: THREE.PerspectiveCamera };
};
const inside = (s: InstanceType<typeof Scene>) => s as unknown as Inside;

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

const sha = (c: string) => c.repeat(64);

/**
 * Mirage's manifest, with the phone tier (`world_lo.glb`, `lo`) or without; `old`, as one
 * built before the HD world's removal, which still lists it (`world_hd.glb`, `hd`).
 */
function mapManifest(phone: boolean, old = false) {
  return {
    files: {
      'world.glb': { sha256: sha('a') },
      ...(old ? { 'world_hd.glb': { sha256: sha('b') } } : {}),
      ...(phone ? { 'world_lo.glb': { sha256: sha('c') } } : {}),
      'hull.glb': { sha256: sha('d') },
    },
    ...(old ? { hd: { textureSize: 1024 } } : {}),
    ...(phone ? { lo: { textureSize: 128 } } : {}),
  };
}

/** The players' manifest, each side with its phone tier (`lo`) or without. */
function playersManifest(phone: boolean) {
  const side = (s: string, full: string, lo: string) => ({
    sha256: sha(full),
    ...(phone
      ? { lo: { file: `${s}_lo.glb`, textureSize: 512, sha256: sha(lo) } }
      : {}),
  });
  return { ct: side('ct', '1', '2'), t: side('t', '3', '4') };
}

const WORLD = '/maps/de_mirage/world.glb?v=aaaaaaaa';
const WORLD_LO = '/maps/de_mirage/world_lo.glb?v=cccccccc';
const CT = '/players/ct.glb?v=11111111';
const CT_LO = '/players/ct_lo.glb?v=22222222';
const T = '/players/t.glb?v=33333333';
const T_LO = '/players/t_lo.glb?v=44444444';

/**
 * Answers the map's and the players' manifests (with the phone tier or not; the map's built
 * before the HD world's removal with `old`), and `files`.
 */
function serve(
  phone: boolean,
  files: Record<string, Uint8Array> = {},
  old = false
) {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith('/maps/de_mirage/manifest.json'))
      return Response.json(mapManifest(phone, old));
    if (url === '/players/manifest.json')
      return Response.json(playersManifest(phone));
    const bytes = files[url];
    if (bytes) return new Response(bytes as Uint8Array<ArrayBuffer>);
    return new Response(null, { status: 404 });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const HEADER = { players: [{}, {}] } as unknown as MatchHeader;

/** Whether each model made from `url` was freed, in the order they were made. */
const freedOf = (url: string) =>
  rigs.made.filter((m) => m.url === url).map((m) => m.freed);

const templateUrls = () => loadRigTemplate.mock.calls.map((c) => c[0]).sort();
const worldUrls = () => loadWorld.mock.calls.map((c) => c[0]);
const poolUrls = (s: InstanceType<typeof Scene>) => {
  const t = inside(s).players.pool!.templates;
  return [t[3].scene.name, t[2].scene.name].sort();
};

describe('the phone tier', () => {
  let scene: InstanceType<typeof Scene>;
  let listeners: Listeners;

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    loadWorld.mockClear();
    loadHull.mockClear();
    loadRigTemplate.mockClear();
    rigs.held.clear();
    rigs.made.length = 0;
    listeners = {};
    scene = new Scene(fakeCanvas(listeners), 'low');
  });

  afterEach(() => {
    scene.dispose();
    vi.unstubAllGlobals();
  });

  it('is the low preset’s alone', () => {
    expect(PRESETS.low.phoneTier).toBe(true);
    expect(PRESETS.medium.phoneTier).toBe(false);
    expect(PRESETS.high.phoneTier).toBe(false);
  });

  it("loads world_lo.glb and the players' phone tier when the manifests list them", async () => {
    serve(true);
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD_LO]);
    expect(templateUrls()).toEqual([CT_LO, T_LO]);
    expect(poolUrls(scene)).toEqual([CT_LO, T_LO]);
  });

  it("loads today's files when the manifests have no phone tier", async () => {
    serve(false);
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD]);
    expect(templateUrls()).toEqual([CT, T]);
  });

  it('never loads the HD world an older manifest lists', async () => {
    serve(true, {}, true);
    await scene.loadMap('de_mirage');
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    expect(worldUrls()).toEqual([WORLD_LO, WORLD]);
  });

  it("swaps to world.glb and the full players on a preset change by itself, keeping the view and the hull, and frees the phone tier's models", async () => {
    serve(true);
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    const loWorld = inside(scene).mapAssets.world!;
    const camera = inside(scene).cameras.camera;
    camera.position.set(1, 2, 3);

    // Nobody asks again: the scene loads its map and its players at the new tier.
    scene.setQuality('high');
    await vi.waitFor(() =>
      expect(inside(scene).mapAssets.world).not.toBe(loWorld)
    );
    expect(worldUrls()).toEqual([WORLD_LO, WORLD]);
    expect(loWorld.parent).toBeNull();
    expect(
      inside(scene).scene.children.filter((c) => c.name === 'world')
    ).toHaveLength(1);
    expect(loadHull).toHaveBeenCalledTimes(1);
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
    await vi.waitFor(() => expect(poolUrls(scene)).toEqual([CT, T]));
    expect([...freedOf(CT_LO), ...freedOf(T_LO)]).toEqual([true, true]);
    expect([...freedOf(CT), ...freedOf(T)]).toEqual([false, false]);

    // And back to low, the viewer's own calls joining the swap: each model loaded once.
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD_LO, WORLD, WORLD_LO]);
    expect(templateUrls()).toEqual([CT, CT_LO, CT_LO, T, T_LO, T_LO]);
    expect(poolUrls(scene)).toEqual([CT_LO, T_LO]);
    expect([...freedOf(CT), ...freedOf(T)]).toEqual([true, true]);
    expect([...freedOf(CT_LO), ...freedOf(T_LO)]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });

  it('reloads nothing on a preset change that names the same files', async () => {
    serve(false);
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    const world = inside(scene).mapAssets.world;
    const pool = inside(scene).players.pool;
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD]);
    expect(templateUrls()).toEqual([CT, T]);
    expect(inside(scene).mapAssets.world).toBe(world);
    expect(inside(scene).players.pool).toBe(pool);
  });

  /**
   * Makes a rig of each side in the pool, as a frame showing them would (the pool dresses only
   * the rigs it made).
   */
  const makeRigs = (s: InstanceType<typeof Scene>) => {
    const pool = inside(s).players.pool as unknown as {
      slots: Record<2 | 3, unknown>[];
      make(team: 2 | 3, i: number): unknown;
    };
    pool.slots[0][2] = pool.make(2, 0);
    pool.slots[1][3] = pool.make(3, 1);
  };
  /** The textures of the world and of the pool's players drawn now. */
  const drawnTextures = (s: InstanceType<typeof Scene>) => {
    const out: THREE.Texture[] = [];
    const roots = [
      inside(s).mapAssets.world!,
      inside(s).players.pool!.templates[2].scene,
    ];
    roots.push(inside(s).players.pool!.templates[3].scene);
    for (const root of roots)
      root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial;
        if (m?.map) out.push(m.map);
      });
    return out;
  };
  /** Tracks each texture's image (images.ts) as its GLB's, and uploads it: released now. */
  const upload = (textures: THREE.Texture[]) => {
    for (const t of textures) {
      trackImage(t, { url: t.name, image: 0 });
      t.onUpdate!(t);
      expect(imageReleased(t)).toBe(true);
    }
  };

  it('leaves the world and the players it swaps out as they are: none of their textures is fetched or uploaded again', async () => {
    const fetch = serve(true);
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    makeRigs(scene);
    const full = drawnTextures(scene);
    expect(full.map((t) => t.name).sort()).toEqual([WORLD, CT, T]);
    upload(full);
    const versions = full.map((t) => t.version);
    const fetched = () =>
      fetch.mock.calls.map((c) => c[0]).filter((u) => u.includes('.glb'));

    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    const lo = drawnTextures(scene);
    expect(lo.map((t) => t.name).sort()).toEqual([WORLD_LO, CT_LO, T_LO]);
    // The outgoing ones kept medium's anisotropy and were never marked for upload, so
    // images.ts asked for none of their GLBs; the incoming ones are dressed in low's.
    expect(full.map((t) => t.anisotropy)).toEqual([8, 8, 8]);
    expect(full.map((t) => t.version)).toEqual(versions);
    expect(lo.map((t) => t.anisotropy)).toEqual([1, 1, 1]);
    upload(lo);
    const loVersions = lo.map((t) => t.version);

    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(lo.map((t) => t.anisotropy)).toEqual([1, 1, 1]);
    expect(lo.map((t) => t.version)).toEqual(loVersions);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetched()).toEqual([]);
  });

  it('swaps nothing for a change of tier and back before the swap is in: the models drawn are kept as they are, the phone tier freed when it lands', async () => {
    const fetch = serve(true);
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    makeRigs(scene);
    const world = inside(scene).mapAssets.world;
    const pool = inside(scene).players.pool;
    const full = drawnTextures(scene);
    upload(full);
    const versions = full.map((t) => t.version);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    rigs.held.set(CT_LO, hold);
    rigs.held.set(T_LO, hold);
    let land!: (g: THREE.Group) => void;
    loadWorld.mockImplementationOnce(
      () => new Promise<THREE.Group>((r) => (land = r))
    );

    scene.setQuality('low');
    const loMap = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(land).toBeDefined());
    await vi.waitFor(() => expect(templateUrls()).toContain(T_LO));
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    const late = new THREE.Group();
    land(late);
    release();
    await loMap;
    await new Promise((r) => setTimeout(r, 0));
    expect(inside(scene).mapAssets.world).toBe(world);
    expect(inside(scene).players.pool).toBe(pool);
    // The full models were not loaded again, nor dressed again (their look never changed).
    expect(templateUrls()).toEqual([CT, CT_LO, T, T_LO]);
    expect(worldUrls()).toEqual([WORLD, WORLD_LO]);
    expect(full.map((t) => t.version)).toEqual(versions);
    // No texture of theirs asked for its image again (images.ts would fetch its GLB).
    expect(
      fetch.mock.calls.map((c) => c[0]).filter((u) => u.includes('.glb'))
    ).toEqual([]);
    await vi.waitFor(() =>
      expect([...freedOf(CT_LO), ...freedOf(T_LO)]).toEqual([true, true])
    );
    expect([...freedOf(CT), ...freedOf(T)]).toEqual([false, false]);
  });

  it('dresses the world and the players it kept in the new look when the swap fails', async () => {
    serve(true);
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    makeRigs(scene);
    const world = inside(scene).mapAssets.world;
    const full = drawnTextures(scene);
    loadWorld.mockRejectedValueOnce(new Error('world_lo.glb: HTTP 500'));
    loadRigTemplate.mockRejectedValueOnce(new Error('ct_lo.glb: HTTP 500'));
    scene.setQuality('low');
    // The viewer's calls, made as the preset changes, join the swap and hear its failures.
    const map = scene.loadMap('de_mirage');
    const players = scene.loadRigs(HEADER);
    await expect(map).rejects.toThrow('HTTP 500');
    await expect(players).rejects.toThrow('HTTP 500');
    expect(inside(scene).mapAssets.world).toBe(world);
    expect(poolUrls(scene)).toEqual([CT, T]);
    // In low's look: anisotropy 1 on the world's texture and on the rigs' (remade in it).
    expect(full.map((t) => t.anisotropy)).toEqual([1, 1, 1]);
  });

  it('keeps the files a measured preset was measured with, and swaps at a chosen one', async () => {
    serve(true);
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    makeRigs(scene);
    const world = inside(scene).mapAssets.world;
    const full = drawnTextures(scene);

    // Measured: low's look on the files loaded to measure it.
    scene.setQuality('low', true);
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD]);
    expect(templateUrls()).toEqual([CT, T]);
    expect(inside(scene).mapAssets.world).toBe(world);
    expect(full.map((t) => t.anisotropy)).toEqual([1, 1, 1]);

    // Chosen afterwards: medium keeps them, and low is the phone tier again.
    scene.setQuality('medium');
    await scene.loadMap('de_mirage');
    expect(worldUrls()).toEqual([WORLD]);
    scene.setQuality('low');
    await scene.loadMap('de_mirage');
    await scene.loadRigs(HEADER);
    expect(worldUrls()).toEqual([WORLD, WORLD_LO]);
    expect(poolUrls(scene)).toEqual([CT_LO, T_LO]);
  });

  it('loads the files a measured preset was measured with in a scene made at it, as the next demo of the page does', async () => {
    serve(true);
    // The page's next demo: a new scene at the `low` measured on the first one's.
    const next = new Scene(fakeCanvas(), 'low', true);
    try {
      // The viewer says the preset again once the scene is made: nothing changes.
      next.setQuality('low', true);
      await next.loadMap('de_mirage');
      await next.loadRigs(HEADER);
      expect(worldUrls()).toEqual([WORLD]);
      expect(templateUrls()).toEqual([CT, T]);
      expect(poolUrls(next)).toEqual([CT, T]);

      // Chosen afterwards: low is the phone tier again.
      next.setQuality('medium');
      next.setQuality('low');
      await next.loadMap('de_mirage');
      await next.loadRigs(HEADER);
      expect(worldUrls()).toEqual([WORLD, WORLD_LO]);
      expect(poolUrls(next)).toEqual([CT_LO, T_LO]);
    } finally {
      next.dispose();
    }
  });

  it('loads a world once for calls that ask for it while it loads, whatever the preset', async () => {
    serve(true);
    let land!: (g: THREE.Group) => void;
    loadWorld.mockImplementationOnce(
      () => new Promise<THREE.Group>((r) => (land = r))
    );
    scene.setQuality('medium');
    const first = scene.loadMap('de_mirage');
    await vi.waitFor(() => expect(land).toBeDefined());
    // Another preset of the same tier, and the viewer asking again at it: the same load.
    scene.setQuality('high');
    expect(scene.loadMap('de_mirage')).toBe(first);
    const world = new THREE.Group();
    land(world);
    await first;
    expect(worldUrls()).toEqual([WORLD]);
    expect(inside(scene).mapAssets.world).toBe(world);
  });

  it('makes the pool of the last of two overlapping rig loads, and frees the models of the other', async () => {
    serve(true);
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    rigs.held.set(CT, hold);
    rigs.held.set(T, hold);
    scene.setQuality('medium');
    const full = scene.loadRigs(HEADER);
    await vi.waitFor(() => expect(templateUrls()).toEqual([CT, T]));
    scene.setQuality('low');
    const lo = scene.loadRigs(HEADER);
    await lo;
    expect(poolUrls(scene)).toEqual([CT_LO, T_LO]);
    expect([...freedOf(CT), ...freedOf(T)]).toEqual([]);
    release();
    await full;
    // The full models arrived last: never drawn, freed.
    expect(poolUrls(scene)).toEqual([CT_LO, T_LO]);
    expect([...freedOf(CT), ...freedOf(T)]).toEqual([true, true]);
    expect([...freedOf(CT_LO), ...freedOf(T_LO)]).toEqual([false, false]);
  });

  it('draws nothing after a restored WebGL context until the released images are back, then draws them', async () => {
    const doc = new Document();
    doc.createBuffer();
    doc
      .createTexture('stone')
      .setImage(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 7))
      .setMimeType('image/png');
    const glb = await new NodeIO().writeBinary(doc);
    serve(true, { [WORLD_LO]: glb });
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async (blob: Blob) => ({
        width: 4,
        height: 4,
        bytes: [...new Uint8Array(await blob.arrayBuffer())],
        close() {},
      }))
    );
    await scene.loadMap('de_mirage');
    const map = (
      inside(scene).mapAssets.world!.children[0] as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshBasicMaterial
      >
    ).material.map!;
    trackImage(map, { url: WORLD_LO, image: 0 });
    // Uploaded: its image released.
    map.onUpdate!(map);
    expect(imageReleased(map)).toBe(true);

    listeners.webglcontextrestored?.();
    const frames = scene.stats.frames;
    scene.render();
    expect(scene.stats.frames).toBe(frames);
    await vi.waitFor(() => expect(imageReleased(map)).toBe(false));
    await new Promise((r) => setTimeout(r, 0));
    expect((map.image as { bytes: number[] }).bytes).toEqual([
      0x89, 0x50, 0x4e, 0x47, 7,
    ]);
    expect(map.source.dataReady).toBe(true);
    scene.render();
    expect(scene.stats.frames).toBe(frames + 1);
  });
});
