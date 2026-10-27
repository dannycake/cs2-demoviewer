// GroundItems: the pool of weapon models lying in the world, posed from a GroundIndex at
// (round, tick). A real WeaponCache with a loader the test settles by hand stands in for the
// network.

import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { sourceAnglesToQuaternion, toScene } from '../src/geo/coords';
import type { GroundItem, Pack } from '../src/pack/types';
import { GROUND_POOL, GroundItems } from '../src/scene/ground';
import { UNLIT_LOOK, type LookOptions } from '../src/scene/look';
import { OUTLINE } from '../src/scene/outline';
import { makeProbeSample, sampleLightGrid } from '../src/scene/probes';
import { WeaponCache } from '../src/scene/weapons';
import { GroundIndex } from '../src/sim/ground';
import { lightGrid } from './helpers/light-grid';
import { playbackPack } from './helpers/playback-pack';

const WEAPONS = ['none', 'AK-47', 'Flashbang', 'defuser', 'Glock-18'];
const LIT: LookOptions = { lit: true, smoothNormals: true, maxAnisotropy: 8 };

/** A loader whose loads the test settles by hand, by model name. */
function manualLoader() {
  const pending = new Map<string, (ok: boolean) => void>();
  const load = (url: string) => {
    const name = /\/weapons\/([^.?]+)\.glb/.exec(url)![1];
    return new Promise<THREE.Object3D>((resolve, reject) => {
      pending.set(name, (ok) => {
        if (!ok) return reject(new Error('404'));
        const g = new THREE.Group();
        g.name = name;
        g.add(
          new THREE.Mesh(
            new THREE.BoxGeometry(),
            new THREE.MeshStandardMaterial({ map: new THREE.Texture() })
          )
        );
        resolve(g);
      });
    });
  };
  const settle = async (name: string, ok = true) => {
    pending.get(name)!(ok);
    await new Promise((r) => setTimeout(r, 0));
  };
  return { pending, load, settle };
}

const key = (
  id: number,
  weapon: number,
  tick: number,
  at: [number, number, number],
  angles: [number, number, number] = [0, 0, 0]
): GroundItem => ({
  round: 0,
  id,
  weapon,
  tick,
  x: at[0],
  y: at[1],
  z: at[2],
  pitch: angles[0] * 100,
  yaw: angles[1] * 100,
  roll: angles[2] * 100,
  gone: false,
});

function index(ground: GroundItem[]): GroundIndex {
  const p: Pack = playbackPack({ rounds: [{ start: 1000, end: 9000 }] });
  p.header.weapons = [...WEAPONS];
  p.ground = ground;
  return new GroundIndex(p);
}

const shown = (items: GroundItems) =>
  items.root.children.filter((c) => c.visible);

async function loaded(...names: string[]) {
  const loader = manualLoader();
  const cache = new WeaponCache(loader.load);
  for (const n of names) {
    cache.get(n);
    await loader.settle(n);
  }
  return { cache, loader };
}

describe('GroundItems', () => {
  it('draws each item at its position, turned by its angles, at the players’ render order', async () => {
    const { cache } = await loaded('ak47', 'defuser');
    const items = new GroundItems(cache, LIT);
    const ground = index([
      key(10, 1, 2000, [100, -200, 30], [10, 45, -20]),
      key(11, 3, 2500, [-50, 60, -7], [0, 200, 0]),
    ]);
    items.set(0, 3000, ground);
    const drawn = shown(items);
    expect(drawn).toHaveLength(2);
    // Newest first: the kit, then the AK.
    const at = (x: number, y: number, z: number) =>
      toScene(x, y, z, new THREE.Vector3());
    const turn = (p: number, y: number, r: number) =>
      sourceAnglesToQuaternion(p, y, r, new THREE.Quaternion());
    expect(drawn[0].position.distanceTo(at(-50, 60, -7))).toBeLessThan(1e-9);
    expect(drawn[0].quaternion.angleTo(turn(0, 200, 0))).toBeLessThan(1e-6);
    expect(drawn[1].position.distanceTo(at(100, -200, 30))).toBeLessThan(1e-9);
    expect(drawn[1].quaternion.angleTo(turn(10, 45, -20))).toBeLessThan(1e-6);
    // Each slot shows one model: the item's.
    const models = drawn.map((s) =>
      s.children.filter((c) => c.visible).map((c) => c.name)
    );
    expect(models).toEqual([['ground:defuser'], ['ground:ak47']]);
    drawn[0].traverse((o) => {
      if ((o as THREE.Mesh).isMesh)
        expect(o.renderOrder).toBe(OUTLINE.rigOrder);
    });
  });

  it(`shows the newest ${GROUND_POOL} of more, leaving the oldest out`, async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    const ground = index(
      Array.from({ length: 50 }, (_, i) => key(i, 1, 2000 + i, [i * 10, 0, 0]))
    );
    items.set(0, 3000, ground);
    const xs = shown(items).map((s) => Math.round(s.position.z / 0.0254));
    expect(xs).toHaveLength(GROUND_POOL);
    expect(xs).not.toContain(0);
    expect(xs).not.toContain(10);
    expect(new Set(xs).size).toBe(GROUND_POOL);
  });

  it('hides an item until its model loads, and shows it on the next set once it has', async () => {
    const loader = manualLoader();
    const cache = new WeaponCache(loader.load);
    const items = new GroundItems(cache, LIT);
    const ground = index([key(1, 2, 2000, [1, 2, 3])]);
    items.set(0, 3000, ground);
    expect(loader.pending.has('flashbang')).toBe(true);
    expect(shown(items)).toEqual([]);
    items.set(0, 3000, ground);
    expect(shown(items)).toEqual([]);
    // What the e2e waits on: the frame's round and tick, and an item still waiting.
    expect(items.debug()).toEqual({
      round: 0,
      tick: 3000,
      waiting: 1,
      items: [],
    });
    await loader.settle('flashbang');
    items.set(0, 3001, ground);
    expect(shown(items)).toHaveLength(1);
    expect(items.debug()).toMatchObject({
      round: 0,
      tick: 3001,
      waiting: 0,
      items: [{ id: 1, weapon: 'flashbang' }],
    });
    expect(items.debug().items[0].x).toBeCloseTo(1, 9);
  });

  it('counts an item whose model failed as hidden, not as waiting', async () => {
    const loader = manualLoader();
    const cache = new WeaponCache(loader.load);
    const items = new GroundItems(cache, LIT);
    const ground = index([
      key(1, 2, 2000, [1, 2, 3]),
      key(2, 3, 2000, [4, 5, 6]),
    ]);
    items.set(0, 3000, ground);
    expect(items.debug().waiting).toBe(2);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await loader.settle('flashbang', false);
    } finally {
      console.warn = warn;
    }
    items.set(0, 3001, ground);
    // The kit still loads; the flashbang never will, so nothing waits on it.
    expect(items.debug()).toMatchObject({ tick: 3001, waiting: 1, items: [] });
    await loader.settle('defuser');
    items.set(0, 3002, ground);
    expect(items.debug()).toMatchObject({ waiting: 0, items: [{ id: 2 }] });
  });

  it('keeps an item whose model failed hidden, with one load', async () => {
    const loader = manualLoader();
    const cache = new WeaponCache(loader.load);
    const items = new GroundItems(cache, LIT);
    const ground = index([key(1, 2, 2000, [1, 2, 3])]);
    items.set(0, 3000, ground);
    const warn = console.warn;
    console.warn = () => {};
    try {
      await loader.settle('flashbang', false);
    } finally {
      console.warn = warn;
    }
    loader.pending.clear();
    for (let i = 0; i < 5; i++) items.set(0, 3000 + i, ground);
    expect(shown(items)).toEqual([]);
    expect(loader.pending.size).toBe(0);
  });

  it('keeps only the copy it shows in a slot, so the copies it swapped out cost nothing', async () => {
    const { cache } = await loaded('ak47', 'flashbang', 'defuser');
    const items = new GroundItems(cache, LIT);
    // One item at a time, each a different weapon, all in slot 0.
    const ground = index([
      key(1, 1, 2000, [0, 0, 0]),
      { ...key(1, 1, 2100, [0, 0, 0]), gone: true },
      key(2, 2, 2200, [10, 0, 0]),
      { ...key(2, 2, 2300, [10, 0, 0]), gone: true },
      key(3, 3, 2400, [20, 0, 0]),
      { ...key(3, 3, 2500, [20, 0, 0]), gone: true },
    ]);
    const slot = items.root.children[0];
    const names: string[] = [];
    for (const tick of [2050, 2250, 2450, 2050, 2450, 2250, 2050]) {
      items.set(0, tick, ground);
      expect(slot.visible).toBe(true);
      expect(slot.children).toHaveLength(1);
      names.push(slot.children[0].name);
    }
    expect(names).toEqual([
      'ground:ak47',
      'ground:flashbang',
      'ground:defuser',
      'ground:ak47',
      'ground:defuser',
      'ground:flashbang',
      'ground:ak47',
    ]);
    for (const s of items.root.children)
      expect(s.children.length).toBeLessThanOrEqual(1);
  });

  it('lends each item a copy of its weapon from a pool per weapon, taken back when its slot shows another: once each weapon has as many copies as ever lay at once, nothing more is made, playing again or seeking', async () => {
    const { cache } = await loaded('ak47', 'flashbang');
    const items = new GroundItems(cache, LIT);
    // Newest first, so every item put down or picked up moves the others between slots: AKs
    // 1 and 3 and flashbang 2 come and go, at most two AKs and one flashbang at once.
    const ground = index([
      key(1, 1, 2000, [0, 0, 0]),
      key(2, 2, 2100, [10, 0, 0]),
      key(3, 1, 2200, [20, 0, 0]),
      { ...key(2, 2, 2300, [10, 0, 0]), gone: true },
      { ...key(1, 1, 2400, [0, 0, 0]), gone: true },
    ]);
    const copies = new Set<THREE.Object3D>();
    const play = (ticks: number[]) => {
      for (const t of ticks) {
        items.set(0, t, ground);
        for (const s of shown(items)) {
          expect(s.children).toHaveLength(1);
          copies.add(s.children[0]);
        }
      }
    };
    const playback = Array.from({ length: 60 }, (_, i) => 1990 + i * 10);
    play(playback);
    expect(copies.size).toBe(3);
    expect(
      [...copies].map((c) => c.name).sort((a, b) => a.localeCompare(b))
    ).toEqual(['ground:ak47', 'ground:ak47', 'ground:flashbang']);
    // Warm: playing again, backwards, and seeking about make nothing.
    const get = vi.spyOn(cache, 'get');
    play(playback);
    play([...playback].reverse());
    play(Array.from({ length: 40 }, (_, i) => 1990 + ((i * 337) % 600)));
    expect(copies.size).toBe(3);
    expect(get).not.toHaveBeenCalled();
    // A frame like the last keeps every item's copy where it is.
    items.set(0, 2250, ground);
    const before = shown(items).map((s) => s.children[0]);
    items.set(0, 2251, ground);
    expect(shown(items).map((s) => s.children[0])).toEqual(before);
  });

  it("frees the copies' materials only when the look changes or on dispose, not when one goes back to its pool", async () => {
    const { cache } = await loaded('ak47', 'flashbang');
    const items = new GroundItems(cache, LIT);
    const ground = index([
      key(1, 1, 2000, [0, 0, 0]),
      key(2, 2, 2100, [10, 0, 0]),
      { ...key(2, 2, 2300, [10, 0, 0]), gone: true },
    ]);
    const materials = new Set<THREE.Material>();
    for (const t of [2050, 2150, 2350, 2150, 2050]) {
      items.set(0, t, ground);
      for (const s of shown(items))
        s.traverse((o) => {
          if ((o as THREE.Mesh).isMesh)
            materials.add((o as THREE.Mesh).material as THREE.Material);
        });
    }
    expect(materials.size).toBe(2);
    let freed = 0;
    for (const m of materials) m.addEventListener('dispose', () => freed++);
    for (const t of [2350, 2150, 2050, 2350]) items.set(0, t, ground);
    expect(freed).toBe(0);
    items.setLook(UNLIT_LOOK);
    expect(freed).toBe(2);
  });

  it('seeks without adding or removing children, and draws the same thing back', async () => {
    const { cache } = await loaded('ak47', 'flashbang', 'defuser');
    const items = new GroundItems(cache, LIT);
    const ground = index([
      key(1, 1, 2000, [0, 0, 0]),
      { ...key(1, 1, 2500, [0, 0, 0]), gone: true },
      key(2, 2, 3000, [10, 0, 0]),
      key(3, 3, 4000, [20, 0, 0]),
      key(4, 1, 5000, [30, 0, 0]),
    ]);
    // What is drawn: each shown slot's place, turn and model.
    const snap = () =>
      shown(items).map((s) => [
        ...s.position.toArray(),
        ...s.quaternion.toArray(),
        ...s.children.filter((c) => c.visible).map((c) => c.name),
      ]);
    items.set(0, 6000, ground);
    const children = [...items.root.children];
    expect(children).toHaveLength(GROUND_POOL);
    const late = snap();
    for (let i = 0; i < 20; i++)
      items.set(0, 1500 + ((i * 937) % 5000), ground);
    expect(items.root.children).toEqual(children);
    items.set(0, 6000, ground);
    expect(snap()).toEqual(late);
  });

  it('dresses its copies in the look, as the players’ weapons are, one set of materials per item', async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    items.set(
      0,
      3000,
      index([key(1, 1, 2000, [0, 0, 0]), key(2, 1, 2000, [50, 0, 0])])
    );
    const meshes = shown(items).map(
      (s) => s.getObjectByProperty('isMesh', true) as THREE.Mesh
    );
    expect(meshes).toHaveLength(2);
    const m = meshes[0].material as THREE.MeshLambertMaterial;
    expect(m.isMeshLambertMaterial).toBe(true);
    // Each item takes its own light from the grid, so each has materials of its own.
    expect(meshes[1].material).not.toBe(m);
    expect((meshes[1].material as THREE.MeshLambertMaterial).map).toBe(m.map);
    // The texture is the cache's, filtered as every copy of it is under this look: what a
    // ground copy looks like does not depend on whether a player has held that weapon yet.
    const src = cache
      .get('ak47')!
      .getObjectByProperty('isMesh', true) as THREE.Mesh;
    expect(m.map).toBe((src.material as THREE.MeshStandardMaterial).map);
    expect(m.map!.anisotropy).toBe(8);
    expect(meshes[0].castShadow && meshes[0].receiveShadow).toBe(true);
    expect(meshes[0].geometry).toBe(src.geometry);
  });

  it('lights each item by the light grid half a metre over where it lies, sampled once while it lies still, and by the sky light without a grid', async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    const grid = lightGrid();
    // Item 1 lies at Source z 0 (scene y 0), item 2 a metre up (z ≈ 39.37) on a ledge; item 1
    // falls from z 20 to 0 over ticks 2000–2010.
    const ground = index([
      key(1, 1, 2000, [0, 0, 20]),
      key(1, 1, 2010, [0, 0, 0]),
      key(2, 1, 2000, [50, 0, 1 / 0.0254]),
    ]);
    const meshOf = (id: number) =>
      items.root.children
        .filter((c) => c.visible)
        .find((_, i) => items.debug().items[i].id === id)!
        .getObjectByProperty('isMesh', true) as THREE.Mesh<
        THREE.BufferGeometry,
        THREE.MeshLambertMaterial
      >;
    const sampleOf = (id: number) => {
      const src = THREE.ShaderLib.lambert;
      const shader = {
        uniforms: THREE.UniformsUtils.clone(src.uniforms),
        vertexShader: src.vertexShader,
        fragmentShader: src.fragmentShader,
      } as Parameters<THREE.Material['onBeforeCompile']>[0];
      meshOf(id).material.onBeforeCompile(
        shader,
        null as unknown as THREE.WebGLRenderer
      );
      return {
        up: shader.uniforms.probeUp.value as THREE.Color,
        sun: shader.uniforms.probeSun.value as number,
      };
    };
    const want = (y: number) =>
      sampleLightGrid(grid, new THREE.Vector3(0, y, 0), makeProbeSample());
    items.set(0, 3000, ground, grid);
    expect(sampleOf(1).up.r).toBeCloseTo(want(0.5).up.r, 6);
    expect(sampleOf(1).sun).toBeCloseTo(0.2, 6);
    expect(sampleOf(2).sun).toBeCloseTo(0.6, 4);
    expect(items.debug().items.map((i) => [i.id, +i.sun!.toFixed(4)])).toEqual([
      [2, 0.6],
      [1, 0.2],
    ]);
    // The shadow maps reach it at medium and high, as they reach the players.
    expect(meshOf(1).receiveShadow).toBe(true);
    // Lying still it is not sampled again: a mark in its sample stays.
    sampleOf(1).up.r = 99;
    items.set(0, 3500, ground, grid);
    expect(sampleOf(1).up.r).toBe(99);
    // Where it moves (falling, at 2005), it is.
    items.set(0, 2005, ground, grid);
    expect(sampleOf(1).up.r).toBeCloseTo(want(10 * 0.0254 + 0.5).up.r, 5);
    // Without a grid: the sky light, and the shadows as the look gives them.
    items.set(0, 3000, ground, null);
    expect(meshOf(1).material.customProgramCacheKey()).not.toContain('probe');
    expect(items.debug().items.map((i) => i.sun)).toEqual([null, null]);
    expect(meshOf(1).receiveShadow).toBe(true);
  });

  it('says where on screen each item is drawn, for a camera and a canvas size, and nowhere without one', async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    items.set(0, 3000, index([key(1, 1, 2000, [0, 0, 0])]));
    // The model is a 1 m box at the item's place, which is the origin; the camera 5 m off
    // along +z looks at it.
    const camera = new THREE.PerspectiveCamera(90, 2, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const [item] = items.debug({ camera, width: 800, height: 400 }).items;
    // ±0.5 m at 4.5 m (its near face) in a view 2·5 m tall over 400 px: about ±22 px.
    const [x0, y0, x1, y1] = item.screen!;
    expect(x0).toBeCloseTo(400 - 200 * (0.5 / 4.5), 0);
    expect(x1).toBeCloseTo(400 + 200 * (0.5 / 4.5), 0);
    expect(y0).toBeCloseTo(200 - 200 * (0.5 / 4.5), 0);
    expect(y1).toBeCloseTo(200 + 200 * (0.5 / 4.5), 0);
    expect(items.debug().items[0].screen).toBeNull();
  });

  it('dresses them again, freeing the old materials, when the look changes', async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    const ground = index([key(1, 1, 2000, [0, 0, 0])]);
    items.set(0, 3000, ground);
    const mesh = () =>
      shown(items)[0].getObjectByProperty('isMesh', true) as THREE.Mesh;
    const old = mesh().material as THREE.Material;
    let freed = false;
    old.addEventListener('dispose', () => (freed = true));
    items.setLook(UNLIT_LOOK);
    expect(freed).toBe(true);
    // Until the next set nothing is posed: no slot shows, and no frame is claimed.
    expect(shown(items)).toEqual([]);
    expect(items.debug()).toMatchObject({ items: [] });
    expect(items.debug().tick).toBeNaN();
    items.set(0, 3000, ground);
    expect(
      (mesh().material as THREE.MeshBasicMaterial).isMeshBasicMaterial
    ).toBe(true);
    expect(shown(items)[0].children).toHaveLength(1);
  });

  it('dispose takes the pool out of the scene and frees its materials, not the cache’s geometry', async () => {
    const { cache } = await loaded('ak47');
    const items = new GroundItems(cache, LIT);
    const scene = new THREE.Scene();
    scene.add(items.root);
    items.set(0, 3000, index([key(1, 1, 2000, [0, 0, 0])]));
    const mesh = shown(items)[0].getObjectByProperty(
      'isMesh',
      true
    ) as THREE.Mesh;
    let freed = 0;
    (mesh.material as THREE.Material).addEventListener(
      'dispose',
      () => freed++
    );
    mesh.geometry.addEventListener('dispose', () => (freed += 100));
    items.dispose();
    expect(items.root.parent).toBeNull();
    expect(freed).toBe(1);
  });
});
