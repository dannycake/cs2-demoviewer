// MapAssets' lifecycle on its own (mapassets.ts): a load that wins commits in one step, in the
// order the look needs (the bake set and the scene relit before the world is dressed and added,
// the first world fitting the cameras, the sun, the sky and the atmosphere, the scene told
// last); a load superseded by a change of tier frees what it loaded and leaves the world drawn;
// dispose frees the world, the hull, the bake and the doors, those still on their way when they
// land, and nothing it does not own. How the scene drives it is scene-map.test's and
// phone-tier.test's. The GLB loaders and the bake's lightmap are stubbed.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMapManifests } from '../src/api/assets';
import { UNLIT_LOOK } from '../src/scene/look';

/** Each GLB asked for: its URL and its answer, settled by the test. */
const glbs = vi.hoisted(() => ({
  asked: [] as { url: string; resolve: () => void; root: THREE.Group }[],
  freed: new Set<string>(),
}));
/** The bakes made and freed. */
const bakes = vi.hoisted(() => ({
  made: [] as object[],
  freed: [] as object[],
}));

vi.mock('../src/scene/loaders', async (importOriginal) => {
  const three = await import('three');
  return {
    ...(await importOriginal<typeof import('../src/scene/loaders')>()),
    loadWorld: (url: string) =>
      new Promise<THREE.Group>((resolve) => {
        const root = new three.Group();
        const box = new three.Mesh(
          new three.BoxGeometry(60, 10, 60),
          new three.MeshBasicMaterial()
        );
        box.geometry.addEventListener('dispose', () => glbs.freed.add(url));
        root.add(box);
        glbs.asked.push({ url, root, resolve: () => resolve(root) });
      }),
    loadHull: async () => new three.BoxGeometry(10, 10, 10),
  };
});
vi.mock('../src/scene/baked', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/scene/baked')>()),
  parseLightInfo: () => ({ sun: null }),
  sunModeOf: () => 'none',
  loadBaked: async () => {
    const b = { info: { sun: null }, lightmap: null, lightGrid: null };
    bakes.made.push(b);
    return b;
  },
  disposeBaked: (b: object) => bakes.freed.push(b),
}));

const { MapAssets } = await import('../src/scene/mapassets');
const { Hull } = await import('../src/scene/hull');

const MAP = 'de_mirage';
const MANIFEST = {
  files: {
    'world.glb': { sha256: 'a'.repeat(64) },
    'world_lo.glb': { sha256: 'b'.repeat(64) },
    'hull.glb': { sha256: 'c'.repeat(64) },
    'light.json': { sha256: 'd'.repeat(64) },
    'entities.glb': { sha256: 'e'.repeat(64) },
    'sky.webp': { sha256: 'f'.repeat(64) },
  },
};
const WORLD = '/maps/de_mirage/world.glb?v=aaaaaaaa';
const WORLD_LO = '/maps/de_mirage/world_lo.glb?v=bbbbbbbb';
const ENTITIES = '/maps/de_mirage/entities.glb?v=eeeeeeee';

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Answers the GLBs asked for at `urls`, and lets the load go on. */
async function land(...urls: string[]): Promise<void> {
  for (const g of glbs.asked) if (urls.includes(g.url)) g.resolve();
  await flush();
}

/** A map's assets with a host that records, in order, what they asked of the scene. */
function make() {
  const calls: string[] = [];
  const note = (name: string) => () => {
    calls.push(name);
  };
  const scene = new THREE.Scene();
  const lighting = {
    direction: new THREE.Vector3(0, -1, 0),
    invalidateWorldShadow: () => {},
    setSun: note('setSun'),
    fit: note('fit'),
    setColors: note('setColors'),
    setBakedSun: note('setBakedSun'),
  };
  const sky = {
    setSky: note('setSky'),
    setAtmosphere: note('setAtmosphere'),
    dispose: note('sky.dispose'),
  };
  const host = {
    scene,
    lighting,
    cameras: { setBounds: note('setBounds') },
    sky,
    marks: { forget: note('forget') },
    effects: {},
    phoneTier: false,
    phone: () => host.phoneTier,
    look: () => UNLIT_LOOK,
    lookReady: async () => {
      calls.push('lookReady');
    },
    relight: note('relight'),
    changed: note('changed'),
    invalidate: () => {},
  };
  const assets = new MapAssets(
    host as unknown as ConstructorParameters<typeof MapAssets>[0]
  );
  return { assets, host, scene, calls };
}

beforeEach(() => {
  forgetMapManifests();
  glbs.asked.length = 0;
  glbs.freed.clear();
  bakes.made.length = 0;
  bakes.freed.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.endsWith('manifest.json')
        ? new Response(JSON.stringify(MANIFEST))
        : new Response('{}')
    )
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MapAssets', () => {
  it('commits a load in one step, relit before the world is dressed, the first world fitted, the scene told last', async () => {
    const { assets, scene, calls } = make();
    const done = assets.load(MAP);
    await flush();
    expect(glbs.asked.map((g) => g.url).sort()).toEqual([ENTITIES, WORLD]);
    // Nothing is drawn until the world is in.
    expect(assets.world).toBeNull();
    expect(calls).toEqual(['lookReady']);
    await land(WORLD, ENTITIES);
    await done;
    expect(calls).toEqual([
      'lookReady',
      'relight',
      'setBounds',
      'setSun',
      'fit',
      'setSky',
      'setColors',
      'setAtmosphere',
      'changed',
    ]);
    expect(scene.children).toContain(assets.world);
    expect(assets.world!.name).toBe('world');
    expect(assets.hull).toBeInstanceOf(Hull);
    expect(assets.hullVersion).toBe(1);
    expect(assets.baked).toBe(bakes.made[0]);
    expect(scene.children).toContain(assets.entities!.root);
  });

  it('frees what a load superseded by a change of tier loaded, and leaves the world drawn', async () => {
    const { assets, host, scene, calls } = make();
    const first = assets.load(MAP);
    await flush();
    await land(WORLD, ENTITIES);
    await first;
    const world = assets.world;
    const hull = assets.hull;
    calls.length = 0;
    host.phoneTier = true;
    const lo = assets.load(MAP);
    await flush();
    // Back before the phone tier landed: today's world is the one drawn, nothing to swap.
    host.phoneTier = false;
    await assets.load(MAP);
    await land(WORLD_LO);
    await lo;
    expect(glbs.freed.has(WORLD_LO)).toBe(true);
    expect(glbs.freed.has(WORLD)).toBe(false);
    expect(assets.world).toBe(world);
    expect(scene.children).toContain(world);
    expect(assets.hull).toBe(hull);
    expect(assets.hullVersion).toBe(1);
    expect(calls).not.toContain('changed');
  });

  it('frees the world, the hull, the bake and the doors on dispose, and nothing it does not own', async () => {
    const { assets, scene, calls } = make();
    const other = new THREE.Group();
    scene.add(other);
    const done = assets.load(MAP);
    await flush();
    await land(WORLD, ENTITIES);
    await done;
    const hull = assets.hull!;
    const freeHull = vi.spyOn(hull, 'dispose');
    const doors = assets.entities!;
    const freeDoors = vi.spyOn(doors, 'dispose');
    const bake = assets.baked;
    calls.length = 0;
    assets.dispose();
    expect(glbs.freed.has(WORLD)).toBe(true);
    expect(freeHull).toHaveBeenCalledTimes(1);
    expect(freeDoors).toHaveBeenCalledTimes(1);
    // Once, the bake's load (which it came from) settled too.
    await flush();
    expect(bakes.freed).toEqual([bake]);
    expect(assets.world).toBeNull();
    expect(assets.hull).toBeNull();
    expect(assets.baked).toBeNull();
    expect(assets.entities).toBeNull();
    // The scene's other children, the sky and the lights are not its own.
    expect(scene.children).toEqual([other]);
    expect(calls).toEqual(['forget']);
  });

  it('asks for nothing more for a load superseded while it waits for the detail texture', async () => {
    const { assets, host } = make();
    let ready!: () => void;
    const detail = new Promise<void>((r) => (ready = r));
    host.lookReady = () => detail;
    const first = assets.load(MAP);
    await flush();
    // The viewer picks low before the detail texture is in.
    host.phoneTier = true;
    const lo = assets.load(MAP);
    await flush();
    ready();
    await flush();
    // Only the phone tier's world, and the doors once: none of today's world.
    expect(glbs.asked.map((g) => g.url).sort()).toEqual([ENTITIES, WORLD_LO]);
    await land(WORLD_LO, ENTITIES);
    await Promise.all([first, lo]);
    expect(glbs.asked).toHaveLength(2);
    expect(bakes.made).toHaveLength(1);
    expect(assets.world).toBe(glbs.asked.find((g) => g.url === WORLD_LO)!.root);
  });

  it('frees a world, a hull, doors and a bake still on their way at dispose once they land', async () => {
    const { assets, scene, calls } = make();
    const freeHull = vi.spyOn(Hull.prototype, 'dispose');
    const done = assets.load(MAP);
    await flush();
    assets.dispose();
    await land(WORLD, ENTITIES);
    await done;
    expect(glbs.freed.has(WORLD)).toBe(true);
    expect(glbs.freed.has(ENTITIES)).toBe(true);
    expect(freeHull).toHaveBeenCalledTimes(1);
    expect(bakes.made).toHaveLength(1);
    expect(bakes.freed).toEqual(bakes.made);
    expect(assets.world).toBeNull();
    expect(scene.children).toEqual([]);
    expect(calls).toEqual(['lookReady']);
  });
});
