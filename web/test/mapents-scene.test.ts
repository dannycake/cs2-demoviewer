// MapEntities: the map's doors and breakables (entities.glb, one root node per entity at its
// spawn transform) posed from the pack. A pack entity finds its node by spawn position and
// class; what finds nothing stays at spawn, with one warning; a break throws chips and dust.

import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceAnglesToQuaternion, toScene } from '../src/geo/coords';
import type { EffectsManifest } from '../src/api/assets';
import type { MapEntity, MapEntityChange, Pack } from '../src/pack/types';
import { EffectAtlases } from '../src/scene/effects';
import { BREAK, MapEntities } from '../src/scene/mapents';
import { MapEntityIndex } from '../src/sim/mapents';
import { playbackPack } from './helpers/playback-pack';

const RATE = 64;
const DOOR_ORIGIN = [1047, -920, -768] as const;
const WINDOW_ORIGIN = [1414.5, -391, -341] as const;

/** A root node as entities.glb has it: named by hammer id, at the spawn, a mesh under it. */
function entityNode(
  name: string,
  classname: string,
  origin: readonly number[],
  angles: readonly number[],
  size: [number, number, number],
  offset: [number, number, number]
): THREE.Object3D {
  const node = new THREE.Object3D();
  node.name = name;
  node.userData = { classname, origin: [...origin], angles: [...angles] };
  const [x, y, z] = origin;
  const p = toScene(x, y, z);
  node.position.set(p.x, p.y, p.z);
  sourceAnglesToQuaternion(angles[0], angles[1], angles[2], node.quaternion);
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshBasicMaterial()
  );
  mesh.position.set(...offset);
  node.add(mesh);
  return node;
}

function entitiesScene(): THREE.Group {
  const g = new THREE.Group();
  g.add(
    entityNode(
      '2:61814:19238',
      'prop_door_rotating',
      DOOR_ORIGIN,
      [0, 180, 0],
      [1.2, 2.2, 0.06],
      [0.6, 1.1, 0]
    ),
    entityNode(
      '2:61814:21692',
      'func_breakable',
      WINDOW_ORIGIN,
      [0, 0, 0],
      [1, 1, 0.02],
      [0, 0.5, 0]
    )
  );
  return g;
}

const door: MapEntity = { kind: 'door', x: 1047, y: -920, z: -768 };
const window_: MapEntity = { kind: 'breakable', x: 1415, y: -391, z: -341 };

const key = (
  round: number,
  entity: number,
  tick: number,
  yaw: number,
  gone = false
): MapEntityChange => ({ round, entity, tick, pitch: 0, yaw, roll: 0, gone });

/** The door swings 180° → 90° over 1000–1029 in round 0; the window breaks at 3000. */
function pack(
  entities: MapEntity[] = [door, window_],
  changes: MapEntityChange[] = [
    key(0, 0, 1000, 18000),
    key(0, 0, 1029, 9000),
    key(0, 1, 3000, 0, true),
  ]
): Pack {
  const p = playbackPack({
    rounds: [
      { start: 0, end: 4000 },
      { start: 4100, end: 8000 },
    ],
    tick_rate: RATE,
  });
  p.entities = entities;
  p.entityChanges = changes;
  return p;
}

/** Atlases that never arrive: the burst draws the generated sprite. */
function noAtlases(): EffectAtlases {
  return new EffectAtlases({ fetchJson: async () => null });
}

function atlases(): EffectAtlases {
  const entry = (file: string, frames: number) => ({
    file,
    width: 1024,
    height: 32,
    cell: [32, 32] as [number, number],
    cols: 32,
    frames,
    sequences: [[0, frames]] as [number, number][],
  });
  const manifest: EffectsManifest = {
    atlases: { debris: entry('debris.webp', 16), dust: entry('dust.webp', 32) },
  };
  return new EffectAtlases({
    fetchJson: async () => manifest,
    loadTexture: async () => new THREE.Texture(),
  });
}

const sameRotation = (a: THREE.Quaternion, b: THREE.Quaternion) =>
  // q and −q are the same rotation.
  expect(1 - Math.abs(a.dot(b))).toBeLessThan(1e-9);

const want = (pitch: number, yaw: number, roll: number) =>
  sourceAnglesToQuaternion(pitch, yaw, roll, new THREE.Quaternion());

/** `a` holds the very objects of `b`, in order. */
function sameItems(a: readonly unknown[], b: readonly unknown[]) {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(x).toBe(b[i]));
}

/** The batches' meshes: every child of `root` but the models. */
const batches = (e: MapEntities) =>
  e.root.children.filter(
    (c): c is THREE.Mesh<THREE.InstancedBufferGeometry> => c !== e.models
  );

describe('MapEntities', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('swings the door node by the pack and puts it back at spawn before the swing', () => {
    const scene = entitiesScene();
    const node = scene.children[0];
    const spawn = node.quaternion.clone();
    const ents = new MapEntities(scene, noAtlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);

    ents.set(0, 1014.5, index, RATE);
    sameRotation(node.quaternion, want(0, 135, 0));
    ents.set(0, 2000, index, RATE);
    sameRotation(node.quaternion, want(0, 90, 0));
    // Seeking back before the first key, and into the next round, restores the spawn.
    ents.set(0, 999, index, RATE);
    expect(node.quaternion.equals(spawn)).toBe(true);
    ents.set(0, 2000, index, RATE);
    ents.set(1, 4200, index, RATE);
    expect(node.quaternion.equals(spawn)).toBe(true);
    // The hinge stays where it is.
    const p0 = toScene(...DOOR_ORIGIN);
    expect(node.position.toArray()).toEqual([p0.x, p0.y, p0.z]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("says when a door turned or a window broke since the last pose, for the sun's shadow of the world", () => {
    const scene = entitiesScene();
    const ents = new MapEntities(scene, noAtlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    // The first pose is news; standing still is not.
    expect(ents.set(0, 500, index, RATE)).toBe(true);
    expect(ents.set(0, 600, index, RATE)).toBe(false);
    // The swing, every frame of it, and nothing once it is done.
    expect(ents.set(0, 1010, index, RATE)).toBe(true);
    expect(ents.set(0, 1020, index, RATE)).toBe(true);
    expect(ents.set(0, 1500, index, RATE)).toBe(true);
    expect(ents.set(0, 2000, index, RATE)).toBe(false);
    // The window breaks: hidden.
    expect(ents.set(0, 3001, index, RATE)).toBe(true);
    expect(ents.set(0, 3010, index, RATE)).toBe(false);
    // A seek back to spawn, a bind to another pack (spawn again) and an index of another pack.
    expect(ents.set(0, 999, index, RATE)).toBe(true);
    expect(ents.set(0, 999, index, RATE)).toBe(false);
    ents.set(0, 2000, index, RATE);
    const q = pack();
    ents.bind(q);
    expect(ents.set(0, 2000, index, RATE)).toBe(true);
    expect(ents.set(0, 2000, new MapEntityIndex(q), RATE)).toBe(true);
    expect(ents.set(0, 2001, new MapEntityIndex(q), RATE)).toBe(false);
  });

  it("draws a door the round starts with open (its one key in the round, at the round's start) open all round, and says so once", () => {
    const scene = entitiesScene();
    const node = scene.children[0];
    const spawn = node.quaternion.clone();
    const ents = new MapEntities(scene, noAtlases());
    // Round 1 (4100–8000) starts with the door at 90°, as the server keys every door at a
    // round's start; nothing moves it after.
    const p = pack(
      [door, window_],
      [
        key(0, 0, 1000, 18000),
        key(0, 0, 1029, 9000),
        key(0, 1, 3000, 0, true),
        key(1, 0, 4100, 9000),
      ]
    );
    const index = new MapEntityIndex(p);
    ents.bind(p);
    expect(ents.set(1, 4100, index, RATE)).toBe(true);
    sameRotation(node.quaternion, want(0, 90, 0));
    expect(ents.set(1, 6000, index, RATE)).toBe(false);
    expect(ents.set(1, 7999, index, RATE)).toBe(false);
    sameRotation(node.quaternion, want(0, 90, 0));
    // Round 0 before its swing is at spawn; back in round 1 the start key holds it open again.
    expect(ents.set(0, 500, index, RATE)).toBe(true);
    expect(node.quaternion.equals(spawn)).toBe(true);
    expect(ents.set(1, 5000, index, RATE)).toBe(true);
    sameRotation(node.quaternion, want(0, 90, 0));
    expect(warn).not.toHaveBeenCalled();
  });

  it('hides the window from its break to the end of the round, and throws chips and dust', async () => {
    const scene = entitiesScene();
    const node = scene.children[1];
    const ents = new MapEntities(scene, noAtlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    const [debris, dust] = batches(ents);

    ents.set(0, 2999, index, RATE);
    expect(node.visible).toBe(true);
    expect(debris.visible || dust.visible).toBe(false);

    ents.set(0, 3001, index, RATE);
    expect(node.visible).toBe(false);
    expect(debris.visible && dust.visible).toBe(true);
    expect(debris.geometry.instanceCount).toBe(8);
    expect(dust.geometry.instanceCount).toBe(1);
    // The dust stands at the window's bounding-box centre.
    const centre = new THREE.Box3()
      .setFromObject(scene.children[1])
      .getCenter(new THREE.Vector3());
    const at = dust.geometry.getAttribute('aCentre');
    // Float32 attributes: to a tenth of a millimetre.
    expect(at.getX(0)).toBeCloseTo(centre.x, 4);
    expect(at.getY(0)).toBeCloseTo(centre.y, 4);
    expect(at.getZ(0)).toBeCloseTo(centre.z, 4);

    // 0.6 s on, the burst is over; the window stays broken to the round's end.
    ents.set(0, 3000 + 0.6 * RATE, index, RATE);
    expect(node.visible).toBe(false);
    expect(debris.visible || dust.visible).toBe(false);
    ents.set(1, 4200, index, RATE);
    expect(node.visible).toBe(true);
    // The generated sprite stood in for the atlases, which never came: one warning.
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^effects:/);
  });

  it('asks for the burst atlases only when a break is drawn', () => {
    const effects = atlases();
    const get = vi.spyOn(effects, 'get');
    const ents = new MapEntities(entitiesScene(), effects);
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    ents.set(0, 1014.5, index, RATE);
    ents.set(0, 2999, index, RATE);
    expect(get).not.toHaveBeenCalled();
    ents.set(0, 3001, index, RATE);
    expect(get.mock.calls.map((c) => c[0]).sort()).toEqual(['debris', 'dust']);
  });

  it('lifts the dark dust atlas to light dust, opaque until it fades', async () => {
    const ents = new MapEntities(entitiesScene(), atlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    const at = 3000 + 0.15 * RATE;
    ents.set(0, at, index, RATE);
    // The atlases arrive; the next frame draws with them.
    await new Promise((r) => setTimeout(r, 0));
    ents.set(0, at, index, RATE);
    const color = batches(ents)[1].geometry.getAttribute('aColor');
    expect(color.getX(0)).toBeGreaterThan(5);
    expect(color.getW(0)).toBe(1);
    ents.set(0, 3000 + 0.5 * RATE, index, RATE);
    expect(color.getW(0)).toBeLessThan(0.5);
  });

  it("shows the dust as light dust at any map's exposure: its colour is the screen's, the tone mapping's exposure divided out", async () => {
    const ents = new MapEntities(entitiesScene(), atlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    const at = 3000 + 0.15 * RATE;
    ents.set(0, at, index, RATE, 1.3);
    await new Promise((r) => setTimeout(r, 0));
    ents.set(0, at, index, RATE, 1.3);
    const [debris, dust] = batches(ents) as THREE.Mesh<
      THREE.InstancedBufferGeometry,
      THREE.ShaderMaterial
    >[];
    expect(dust.material.defines.EMISSIVE).toBe('');
    expect(dust.material.uniforms.uExposure.value).toBe(1.3);
    // What M2b chose at Mirage's exposure without the bake, where it was judged, on screen.
    const color = dust.geometry.getAttribute('aColor');
    expect(color.getX(0)).toBeCloseTo(
      BREAK.dustTint[0] * BREAK.dustExposure,
      5
    );
    expect(BREAK.dustExposure).toBe(1.6);
    // Untone-mapped (low on a map without a bake), nothing to divide out.
    ents.set(0, at, index, RATE, 1);
    expect(dust.material.uniforms.uExposure.value).toBe(1);
    // The chips are lit glass, as before: not divided.
    expect(debris.material.defines.EMISSIVE).toBeUndefined();
  });

  it('warns once, listing what matches nothing, and leaves those at spawn', () => {
    const scene = entitiesScene();
    const spawn = scene.children.map((n) => n.quaternion.clone());
    const ents = new MapEntities(scene, noAtlases());
    const p = pack(
      [{ kind: 'door', x: 0, y: 0, z: 0 }, window_],
      [key(0, 0, 1000, 18000), key(0, 0, 1029, 9000)]
    );
    const index = new MapEntityIndex(p);
    ents.bind(p);
    ents.set(0, 1014.5, index, RATE);
    expect(warn).toHaveBeenCalledTimes(1);
    const text = String(warn.mock.calls[0][0]);
    expect(text).toMatch(/door at \(0, 0, 0\)/);
    expect(text).toMatch(/2:61814:19238/);
    expect(scene.children[0].quaternion.equals(spawn[0])).toBe(true);
    // A second pack of the same map does not warn again.
    ents.bind(pack([{ kind: 'door', x: 0, y: 0, z: 0 }], []));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('matches by class as well as by place', () => {
    const ents = new MapEntities(entitiesScene(), noAtlases());
    // A breakable where the door is matches nothing; the door stays at spawn.
    const p = pack(
      [{ kind: 'breakable', x: 1047, y: -920, z: -768 }],
      [key(0, 0, 1000, 0, true)]
    );
    ents.bind(p);
    ents.set(0, 1001, new MapEntityIndex(p), RATE);
    expect(ents.models.children[0].visible).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('keeps every node at spawn, without a warning, for a pack without ENT1', () => {
    const scene = entitiesScene();
    const spawn = scene.children.map((n) => n.quaternion.clone());
    const ents = new MapEntities(scene, noAtlases());
    const p = pack([], []);
    const index = new MapEntityIndex(p);
    ents.bind(p);
    for (const t of [0, 1014.5, 3001]) ents.set(0, t, index, RATE);
    scene.children.forEach((n, i) => {
      expect(n.quaternion.equals(spawn[i])).toBe(true);
      expect(n.visible).toBe(true);
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('poses with the objects it was made with: 20 alternating frames add nothing', () => {
    const ents = new MapEntities(entitiesScene(), noAtlases());
    const p = pack();
    const index = new MapEntityIndex(p);
    ents.bind(p);
    ents.set(0, 3010, index, RATE);
    const children = [...ents.root.children];
    const objects: THREE.Object3D[] = [];
    ents.root.traverse((o) => objects.push(o));
    const arrays = batches(ents).flatMap((b) =>
      Object.values(b.geometry.attributes).map((a) => a.array)
    );
    // Mid-swing and mid-break in turn, ending mid-break.
    for (let i = 0; i < 20; i++)
      ents.set(0, i % 2 ? 3010 : 1014.5, index, RATE);
    sameItems(ents.root.children, children);
    const after: THREE.Object3D[] = [];
    ents.root.traverse((o) => after.push(o));
    sameItems(after, objects);
    sameItems(
      batches(ents).flatMap((b) =>
        Object.values(b.geometry.attributes).map((a) => a.array)
      ),
      arrays
    );
    expect(batches(ents).map((b) => b.geometry.instanceCount)).toEqual([8, 1]);
  });

  it('draws at the world’s render order, so the x-ray still shows players behind a door', () => {
    const ents = new MapEntities(entitiesScene(), noAtlases());
    ents.models.traverse((o) => expect(o.renderOrder).toBe(0));
  });
});
