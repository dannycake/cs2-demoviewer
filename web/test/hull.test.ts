// Hull: sphere casts and closest points against a map's collision hull. A 10 m box stands in
// for a map: casts from its centre stop a sphere radius short of a wall, a cast that touches
// nothing travels its whole length, and the closest point from the centre lies on a face.
// Walls merged from named hull groups carry their surface: a bullet's ray meets the nearest
// that does not pass bullets. A ray straight down names the surface under a player's feet, a
// floor bullets pass (a grate) included. The gated cases load Mirage's hull.glb through loadHull,
// check a point 1 m above the first live sample of player 0 in round 1 and the bullets' rays
// against freeDistance's, and log what a cast costs; and name the surface under the spawns and
// under players' feet across the match (ASSETS_DIR alone runs the spawns):
//   DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage.dvpk.gz ASSETS_DIR=<repo>/assets npm test

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  parseSoundManifest,
  seeded,
  type SoundManifest,
} from '../src/audio/manifest';
import { stepSetOf } from '../src/audio/surfaces';
import { toScene, UNIT, viewDir } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { FLAG, type Pack } from '../src/pack/types';
import { Hull, newHullHit } from '../src/scene/hull';
import { loadHull, mergeMeshes } from '../src/scene/loaders';
import { SURFACES } from '../src/sim/surfaces';
import { fileUrl, installBrowserShims } from './helpers/node-gltf';
import { fenceMetalWood, wall } from './helpers/walls';
import { cpuTimed } from './helpers/cpu-time';
import { needs } from './helpers/gates';

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe('Hull (a 10 m box around the origin)', () => {
  const hull = new Hull(new THREE.BoxGeometry(10, 10, 10));
  const centre = v3(0, 0, 0);

  it('stops a sphere cast at the wall, a radius short of it', () => {
    expect(hull.freeDistance(centre, v3(20, 0, 0), 0.3)).toBeCloseTo(4.7, 2);
    expect(hull.freeDistance(centre, v3(0, -20, 0), 0.3)).toBeCloseTo(4.7, 2);
    expect(hull.freeDistance(v3(1, 2, 0), v3(1, 2, 30), 0.5)).toBeCloseTo(
      4.5,
      2
    );
  });

  it('stops a diagonal cast where the sphere first touches', () => {
    // Along (1, 1, 0)/√2 the sphere touches x = 5 − r and y = 5 − r at the same time.
    const to = v3(20, 20, 0);
    const d = hull.freeDistance(centre, to, 0.3);
    expect(d).toBeCloseTo(4.7 * Math.SQRT2, 2);
  });

  it('travels the whole way when it touches nothing', () => {
    expect(hull.freeDistance(centre, v3(2, 0, 0), 0.3)).toBeCloseTo(2, 6);
    expect(hull.freeDistance(centre, v3(-1, 1, 2), 0.3)).toBeCloseTo(
      Math.sqrt(6),
      6
    );
    // A wall exactly a radius past the end is not touched before the end.
    expect(hull.freeDistance(centre, v3(4.6, 0, 0), 0.3)).toBeCloseTo(4.6, 6);
  });

  it('stops a cast of radius 0 (a ray) at the plane it passes through', () => {
    // A 1.37 m wall: the gap at the pierce point is a tiny positive float, never <= 0.
    const plane = new Hull(
      new THREE.PlaneGeometry(20, 20).translate(0, 0, 1.37)
    );
    expect(
      Math.abs(plane.freeDistance(centre, v3(0, 0, 40), 0) - 1.37)
    ).toBeLessThan(1e-3);
    let clear = 0;
    for (let i = 0; i < 200; i++) {
      const a = (i / 200) * Math.PI * 2;
      const to = v3(Math.cos(a) * 3, Math.sin(a) * 3, 40);
      const d = plane.freeDistance(centre, to, 0);
      const hit = (1.37 / 40) * to.length();
      if (d > hit + 1e-3) clear++;
      expect(Math.abs(d - hit)).toBeLessThan(1e-3);
    }
    expect(clear).toBe(0);
    expect(hull.freeDistance(centre, v3(20, 0, 0), 0)).toBeCloseTo(5, 3);
  });

  it('does not move a sphere that already touches, or a cast of no length', () => {
    expect(hull.freeDistance(v3(4.8, 0, 0), v3(0, 0, 0), 0.3)).toBe(0);
    expect(hull.freeDistance(centre, centre, 0.3)).toBe(0);
  });

  it('knows its bounds, the box the cameras and the shadow are fitted to', () => {
    expect(hull.bounds.min.toArray()).toEqual([-5, -5, -5]);
    expect(hull.bounds.max.toArray()).toEqual([5, 5, 5]);
    // A copy: moving it moves nothing.
    hull.bounds.translate(v3(100, 0, 0));
    expect(hull.bounds.min.x).toBe(-5);
  });

  it('sees along a ray as far as it goes without meeting the hull: the sun from the eye', () => {
    // Inside the box every way out meets a wall or the roof.
    expect(hull.sees(centre, v3(0, 1, 0))).toBe(false);
    expect(hull.sees(centre, v3(0.6, 0.8, 0))).toBe(false);
    // Above it, or beside it looking away, nothing is in the way.
    expect(hull.sees(v3(0, 6, 0), v3(0, 1, 0))).toBe(true);
    expect(hull.sees(v3(8, 0, 0), v3(0.6, 0.8, 0))).toBe(true);
    // Beside it looking across it, the box is in the way.
    expect(hull.sees(v3(8, 0, 0), v3(-1, 0, 0))).toBe(false);
  });

  it('finds the closest point from the centre on a face, 5 m away', () => {
    const out = new THREE.Vector3(NaN, NaN, NaN);
    expect(hull.closestPoint(centre, out)).toBeCloseTo(5, 6);
    const onFace = [out.x, out.y, out.z].filter(
      (c) => Math.abs(Math.abs(c) - 5) < 1e-6
    );
    expect(onFace.length).toBeGreaterThanOrEqual(1);
    expect(out.length()).toBeCloseTo(5, 6);
  });
});

describe('Hull rays by surface (walls merged from named meshes)', () => {
  // The chainlink at 2 m (bullets pass it), metal at 5 m, wood at 8 m facing away.
  const hull = fenceMetalWood();
  const geometry = hull.geometry;
  const origin = v3(0, 0, 0);
  const ahead = v3(0, 0, 1);

  it("writes each vertex's surface, from its mesh's name or its nearest named ancestor", () => {
    const surface = geometry.getAttribute('surface') as THREE.BufferAttribute;
    expect(surface.array).toBeInstanceOf(Uint8Array);
    const of = (z: number) => {
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++)
        if (Math.abs(pos.getZ(i) - z) < 1e-6) return SURFACES[surface.getX(i)];
      return null;
    };
    expect([of(2), of(5), of(8)]).toEqual(['pass', 'metal', 'wood']);
    // An unnamed mesh takes the name of the group it is in.
    const group = new THREE.Group();
    group.name = 'physics_group_glass';
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1)));
    const glass = mergeMeshes(group).getAttribute('surface');
    expect(SURFACES[glass.getX(0)]).toBe('glass');
  });

  it("writes each vertex's surface name too, as the sounds manifest keys it, 0 for default", () => {
    const names = geometry.userData.surfaceNames as string[];
    const name = geometry.getAttribute('surfaceName') as THREE.BufferAttribute;
    expect(name.array).toBeInstanceOf(Uint16Array);
    expect(names[0]).toBe('default');
    const of = (z: number) => {
      const pos = geometry.getAttribute('position');
      for (let i = 0; i < pos.count; i++)
        if (Math.abs(pos.getZ(i) - z) < 1e-6) return names[name.getX(i)];
      return null;
    };
    expect([of(2), of(5), of(8)]).toEqual(['chainlink', 'metal', 'wood']);
    // A bare group, a mesh named as no collision group, and a name GLTFLoader made unique
    // (`physics_group_metal_1`: the file's name is kept in `userData.name`).
    const bare = wall('physics_group', 1);
    const unnamed = wall('mesh_0', 2);
    const repeated = wall('physics_group_metal_1', 3);
    repeated.userData.name = 'physics_group_metal';
    // A mesh named otherwise in a collision group (a GLTFLoader `mesh_3`) takes the group's.
    const wood = new THREE.Group();
    wood.name = 'physics_group_wood';
    wood.add(wall('mesh_3', 4));
    const merged = mergeMeshes(
      new THREE.Group().add(bare, unnamed, repeated, wood)
    );
    const ids = merged.getAttribute('surfaceName');
    const at = (k: number) =>
      (merged.userData.surfaceNames as string[])[ids.getX(k * 4)];
    expect([0, 1, 2, 3].map(at)).toEqual([
      'default',
      'default',
      'metal',
      'wood',
    ]);
    // The bullets' surface of each is as it was: by the nearest name, `mesh_3`'s own.
    const surface = merged.getAttribute('surface');
    expect([0, 1, 2, 3].map((k) => SURFACES[surface.getX(k * 4)])).toEqual([
      'stone',
      'stone',
      'metal',
      'stone',
    ]);
  });

  it('raycast: the nearest hit past what bullets pass, its normal facing the ray', () => {
    const out = newHullHit();
    expect(hull.raycast(origin, ahead, 40, out)).toBe(true);
    expect(out.distance).toBeCloseTo(5, 6);
    expect(out.point.z).toBeCloseTo(5, 6);
    expect(out.normal.x).toBeCloseTo(0, 6);
    expect(out.normal.y).toBeCloseTo(0, 6);
    expect(out.normal.z).toBeCloseTo(-1, 6);
    expect(out.surface).toBe('metal');
    expect(out.leaving).toBe(false);
    // Nothing within reach.
    expect(hull.raycast(origin, ahead, 4.9, out)).toBe(false);
    expect(hull.raycast(origin, v3(0, 1, 0), 40, out)).toBe(false);
    // From beyond the wood, back towards the origin: the wood's face, facing that ray.
    expect(hull.raycast(v3(0, 0, 10), v3(0, 0, -1), 40, out)).toBe(true);
    expect(out.distance).toBeCloseTo(2, 6);
    expect(out.surface).toBe('wood');
    expect(out.normal.z).toBeCloseTo(1, 6);
    expect(out.leaving).toBe(false);
  });

  it('raycastAll: every hit by distance up to out.length, what bullets pass skipped, each wall once', () => {
    // The ray meets each wall on the diagonal its two triangles share.
    const out = [newHullHit(), newHullHit(), newHullHit()];
    expect(hull.raycastAll(origin, ahead, 40, out)).toBe(2);
    expect(
      out.slice(0, 2).map((h) => [h.surface, +h.distance.toFixed(4)])
    ).toEqual([
      ['metal', 5],
      ['wood', 8],
    ]);
    // The wood faces away from the origin: the ray leaves through it, and the normal still faces
    // the ray.
    expect(out[1].leaving).toBe(true);
    expect(out[1].normal.z).toBeCloseTo(-1, 6);
    expect(hull.raycastAll(origin, ahead, 6, out)).toBe(1);
    const one = [newHullHit()];
    expect(hull.raycastAll(origin, ahead, 40, one)).toBe(1);
    expect(one[0].surface).toBe('metal');
    // Off the diagonal, inside one triangle.
    expect(hull.raycastAll(v3(3, -1, 0), ahead, 40, out)).toBe(2);
    expect(hull.raycastAll(origin, v3(0, 1, 0), 40, out)).toBe(0);
  });

  it('drops the faces two abutting pieces of a wall share, so they take none of the marks a wallbang leaves', () => {
    // A 2 m thick wall of two 1 m boxes, abutting at z = 6, between z = 5 and 7.
    const piece = (z: number) => {
      const g = new THREE.BoxGeometry(20, 20, 1).translate(0, 0, z);
      const m = new THREE.Mesh(g);
      m.name = 'physics_group_concrete';
      return m;
    };
    const root = new THREE.Group();
    root.add(piece(5.5), piece(6.5));
    const wallOfTwo = new Hull(mergeMeshes(root));
    // Two to keep: the way in and the way out, not the faces at 6 between the pieces.
    const two = [newHullHit(), newHullHit()];
    expect(wallOfTwo.raycastAll(v3(0.3, 0.2, 0), ahead, 40, two)).toBe(2);
    expect(two.map((h) => [+h.distance.toFixed(4), h.leaving])).toEqual([
      [5, false],
      [7, true],
    ]);
    // A sheet in the open with a face each way (two triangles back to back): both sides kept.
    const front = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20).rotateY(Math.PI).translate(0, 0, 3)
    );
    const backFace = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20).translate(0, 0, 3)
    );
    const sheet = new Hull(mergeMeshes(new THREE.Group().add(front, backFace)));
    const both = [newHullHit(), newHullHit(), newHullHit()];
    expect(sheet.raycastAll(v3(0.3, 0.2, 0), ahead, 40, both)).toBe(2);
    expect(
      both
        .slice(0, 2)
        .map((h) => h.leaving)
        .sort()
    ).toEqual([false, true]);
  });

  it('leaves freeDistance as it was: the cameras still stop at the chainlink', () => {
    expect(hull.freeDistance(origin, v3(0, 0, 40), 0)).toBeCloseTo(2, 3);
  });

  it('finds a wall within reach from inside boxes of the BVH that run on far past it', () => {
    // A 200 m long room around the origin and a wall across it 5 m ahead: the room's boxes hold
    // the origin and leave it 100 m on.
    const room = new THREE.BoxGeometry(20, 20, 200);
    room.deleteAttribute('normal');
    room.deleteAttribute('uv');
    const across = new THREE.PlaneGeometry(20, 20, 8, 8).translate(0, 0, 5);
    across.deleteAttribute('normal');
    across.deleteAttribute('uv');
    const long = new THREE.Group();
    long.add(new THREE.Mesh(room), new THREE.Mesh(across));
    const inside = new Hull(mergeMeshes(long));
    const out = newHullHit();
    expect(inside.raycast(v3(0.3, 0.2, 0), ahead, 10, out)).toBe(true);
    expect(out.distance).toBeCloseTo(5, 6);
    const all = [newHullHit(), newHullHit()];
    expect(inside.raycastAll(v3(0.3, 0.2, 0), ahead, 120, all)).toBe(2);
    expect(all.map((h) => +h.distance.toFixed(4))).toEqual([5, 100]);
  });

  it("keeps a mirrored group's faces facing out: its triangles are wound back when merged", () => {
    // A wall facing the origin, under a node mirrored in x (a negative determinant).
    const mirrored = new THREE.Group();
    mirrored.scale.set(-1, 1, 1);
    mirrored.add(wall('physics_group_metal', 5));
    const root = new THREE.Group();
    root.add(mirrored);
    const out = newHullHit();
    const hull = new Hull(mergeMeshes(root));
    expect(hull.raycast(origin, ahead, 40, out)).toBe(true);
    expect(out.leaving).toBe(false);
    expect(out.normal.z).toBeCloseTo(-1, 6);
    // Mirrored twice is not mirrored.
    const twice = new THREE.Group();
    twice.scale.set(1, -1, 1);
    twice.add(mirrored.clone());
    const back = new Hull(mergeMeshes(new THREE.Group().add(twice)));
    expect(back.raycast(origin, ahead, 40, out)).toBe(true);
    expect(out.leaving).toBe(false);
  });

  it('counts a geometry without surfaces as stone', () => {
    const plain = new Hull(new THREE.PlaneGeometry(20, 20).translate(0, 0, 3));
    const out = newHullHit();
    expect(plain.raycast(origin, ahead, 40, out)).toBe(true);
    expect(out.surface).toBe('stone');
    expect(out.distance).toBeCloseTo(3, 6);
  });
});

describe('Hull.surfaceBelow (the surface under the feet)', () => {
  /** A 20 m floor at height `y`, facing up, named as a hull group. */
  const floor = (name: string, y: number) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2)
    );
    m.name = name;
    m.position.y = y;
    return m;
  };
  // A wood floor at 0 and a metal slab 3 m over it.
  const hull = new Hull(
    mergeMeshes(
      new THREE.Group().add(
        floor('physics_group_wood', 0),
        floor('physics_group_metal', 3)
      )
    )
  );

  it('names the first surface straight down within maxDrop', () => {
    expect(hull.surfaceBelow(v3(0, 0.1, 0), 1)).toBe('wood');
    expect(hull.surfaceBelow(v3(0, 3.1, 0), 1)).toBe('metal');
    expect(hull.surfaceBelow(v3(2, 2.9, -4), 3)).toBe('wood');
    // Nothing within reach, nothing under the point, or no reach.
    expect(hull.surfaceBelow(v3(0, 5, 0), 1)).toBeNull();
    expect(hull.surfaceBelow(v3(0, 2.9, 0), 2.8)).toBeNull();
    expect(hull.surfaceBelow(v3(30, 0.1, 0), 1)).toBeNull();
    expect(hull.surfaceBelow(v3(0, 0.1, 0), 0)).toBeNull();
  });

  it('stands on a floor bullets pass (a grate), where the bullets go through it', () => {
    const grated = new Hull(
      mergeMeshes(
        new THREE.Group().add(
          floor('physics_group_concrete', 0),
          floor('physics_passbullets_metalgrate', 1)
        )
      )
    );
    expect(grated.surfaceBelow(v3(0, 1.1, 0), 1)).toBe('metalgrate');
    // The bullets' ray down still meets the concrete under it, after as before.
    const out = newHullHit();
    expect(grated.raycast(v3(0, 1.1, 0), v3(0, -1, 0), 5, out)).toBe(true);
    expect(out.distance).toBeCloseTo(1.1, 6);
    expect(grated.surfaceBelow(v3(0, 0.5, 0), 1)).toBe('concrete');
  });

  it('is null on a hull without surface names', () => {
    const plain = new Hull(
      new THREE.PlaneGeometry(20, 20).rotateX(-Math.PI / 2)
    );
    expect(plain.surfaceBelow(v3(0, 0.1, 0), 1)).toBeNull();
  });
});

const PACK = process.env.DEMOVIEWER_PACK;
const ASSETS = process.env.ASSETS_DIR;
const GATE = needs('Mirage hull', 'DEMOVIEWER_PACK', 'ASSETS_DIR');

/**
 * Every 8th live sample of every player in round 1, from 1.6 m above the feet toward 2.4 m
 * behind the view and 1.1 m up: the shape of the follow camera's cast.
 */
function followCasts(pack: Pack): {
  from: THREE.Vector3[];
  to: THREE.Vector3[];
} {
  const from: THREE.Vector3[] = [];
  const to: THREE.Vector3[] = [];
  pack.rounds[0].players.forEach((t) => {
    for (let k = 0; k < t.flags.length; k += 8) {
      if ((t.flags[k] & FLAG.alive) === 0) continue;
      const f = new THREE.Vector3();
      toScene(t.x[k], t.y[k], t.z[k], f).y += 1.6;
      const back = new THREE.Vector3();
      viewDir(t.yaw[k] / 100, 0, back);
      from.push(f);
      to.push(
        f
          .clone()
          .addScaledVector(back, -2.4)
          .setY(f.y + 1.1)
      );
    }
  });
  return { from, to };
}

/** The first point on a `step` grid along the segment where the sphere touches the hull. */
function sampledFreeDistance(
  hull: Hull,
  from: THREE.Vector3,
  to: THREE.Vector3,
  radius: number,
  step: number
): number {
  const length = from.distanceTo(to);
  const p = new THREE.Vector3();
  const out = new THREE.Vector3();
  for (let t = 0; t < length; t += step) {
    p.lerpVectors(from, to, t / length);
    if (hull.closestPoint(p, out) <= radius) return Math.max(0, t - step);
  }
  return hull.closestPoint(to, out) <= radius ? length - step : length;
}

describe.skipIf(!PACK || !ASSETS)(GATE, () => {
  let pack: Pack;
  let hull: Hull;

  beforeAll(async () => {
    installBrowserShims();
    pack = parsePack(
      await inflateIfGzip(new Uint8Array(await readFile(PACK!)))
    );
    const t0 = performance.now();
    const geometry = await loadHull(
      await fileUrl(join(ASSETS!, 'maps/de_mirage/hull.glb'))
    );
    const t1 = performance.now();
    hull = new Hull(geometry);
    const t2 = performance.now();
    console.log(
      `mirage hull: ${geometry.index!.count / 3} triangles, ` +
        `load+merge ${(t1 - t0).toFixed(0)} ms, bvh ${(t2 - t1).toFixed(0)} ms`
    );
  }, 60_000);

  it('puts the hull 0.3 to 1.5 m from a point 1 m above the spawn floor', () => {
    expect(pack.header.map).toBe('de_mirage');
    const t = pack.rounds[0].players[0];
    const k = t.flags.findIndex((f) => (f & FLAG.alive) !== 0);
    expect(k).toBeGreaterThanOrEqual(0);
    const p = new THREE.Vector3();
    toScene(t.x[k], t.y[k], t.z[k], p).y += 1;
    const out = new THREE.Vector3();
    const d = hull.closestPoint(p, out);
    const down = hull.freeDistance(p, p.clone().setY(p.y - 3), 0.3);
    console.log(
      `player 0 round 1 tick sample ${k}: closest hull ${d.toFixed(3)} m, ` +
        `sphere cast 3 m down travels ${down.toFixed(3)} m`
    );
    expect(d).toBeGreaterThan(0.3);
    expect(d).toBeLessThan(1.5);
    expect(out.distanceTo(p)).toBeCloseTo(d, 6);
    expect(down).toBeLessThan(1);
  });

  it('casts a 0.3 m sphere 2.4 m back from players in under 0.05 ms of CPU', () => {
    const { from, to } = followCasts(pack);
    expect(from.length).toBeGreaterThan(500);
    for (let i = 0; i < from.length; i++)
      hull.freeDistance(from[i], to[i], 0.3); // warm up
    const { value: blocked, ms } = cpuTimed(() => {
      let n = 0;
      for (let i = 0; i < from.length; i++) {
        const d = hull.freeDistance(from[i], to[i], 0.3);
        if (d < from[i].distanceTo(to[i]) - 1e-6) n++;
      }
      return n;
    });
    const cast = ms / from.length;
    const out = new THREE.Vector3();
    const closest =
      cpuTimed(() => {
        for (const p of from) hull.closestPoint(p, out);
      }).ms / from.length;
    console.log(
      `mirage casts: ${from.length}, ${blocked} blocked; ` +
        `freeDistance ${(cast * 1000).toFixed(1)} µs, closestPoint ${(closest * 1000).toFixed(1)} µs per call`
    );
    expect(cast).toBeLessThan(0.05);
  });

  it('agrees with a sphere stepped along the same casts every 5 mm', () => {
    const { from, to } = followCasts(pack);
    const picked: number[] = [];
    let blocked = 0;
    for (let i = 0; i < from.length; i++) {
      const isBlocked =
        hull.freeDistance(from[i], to[i], 0.3) < from[i].distanceTo(to[i]);
      if (isBlocked ? blocked++ % 4 === 0 : i % 40 === 0) picked.push(i);
    }
    let worst = 0;
    for (const i of picked) {
      const d = hull.freeDistance(from[i], to[i], 0.3);
      const ref = sampledFreeDistance(hull, from[i], to[i], 0.3, 0.005);
      worst = Math.max(worst, Math.abs(d - ref));
    }
    console.log(
      `mirage casts checked against 5 mm steps: ${picked.length}, worst gap ${(worst * 1000).toFixed(1)} mm`
    );
    expect(picked.length).toBeGreaterThan(80);
    expect(worst).toBeLessThan(0.01);
  });
  it('meets the wall a ray of freeDistance stops at, or one past it where bullets pass, in µs', () => {
    const { from } = followCasts(pack);
    const dir = v3(0, 0, 0);
    const to = v3(0, 0, 0);
    const hit = newHullHit();
    let met = 0;
    let past = 0;
    let shorter = 0;
    const surfaces = new Set<string>();
    const t0 = performance.now();
    for (let i = 0; i < from.length; i++) {
      const a = (i * 2.39996) % (Math.PI * 2);
      dir.set(Math.sin(a), -0.15, Math.cos(a)).normalize();
      if (hull.raycast(from[i], dir, 40, hit)) {
        met++;
        surfaces.add(hit.surface);
      }
    }
    const each = (performance.now() - t0) / from.length;
    for (let i = 0; i < from.length; i++) {
      const a = (i * 2.39996) % (Math.PI * 2);
      dir.set(Math.sin(a), -0.15, Math.cos(a)).normalize();
      const free = hull.freeDistance(
        from[i],
        to.copy(from[i]).addScaledVector(dir, 40),
        0
      );
      const d = hull.raycast(from[i], dir, 40, hit) ? hit.distance : 40;
      if (d < free - 0.01) shorter++;
      else if (d > free + 0.01) past++;
    }
    console.log(
      `mirage rays: ${from.length}, ${met} met (${[...surfaces].join(', ')}), ${past} past a face bullets pass; raycast ${(each * 1000).toFixed(1)} µs per call`
    );
    expect(met).toBeGreaterThan(from.length / 2);
    expect(shorter).toBe(0);
    expect(past).toBeLessThan(from.length / 50);
  });
});

/**
 * Feet of round 1's players at their spawns, from the Mirage pack (Source units): the five Ts
 * and the five CTs.
 */
const SPAWNS = {
  t: [
    [1296, 32, -168],
    [1136, -160, -164],
    [1216, -307, -165],
    [1136, -256, -165],
    [1216, -16, -164],
  ],
  ct: [
    [-1776, -1976, -264],
    [-1656, -1800, -267],
    [-1776, -1800, -264],
    [-1656, -1976, -267],
    [-1720, -1896, -268],
  ],
};

describe.skipIf(!ASSETS)(
  needs('Mirage hull surfaces, by the sounds manifest', 'ASSETS_DIR'),
  () => {
    let hull: Hull;
    let manifest: SoundManifest | null = null;
    /** As `Scene.surfaceBelow`: from 8 units over the feet down to 32 under them. */
    const below = (x: number, y: number, z: number) =>
      hull.surfaceBelow(
        toScene(x, y, z + 8, new THREE.Vector3()) as THREE.Vector3,
        40 * UNIT
      );

    beforeAll(async () => {
      installBrowserShims();
      hull = new Hull(
        await loadHull(await fileUrl(join(ASSETS!, 'maps/de_mirage/hull.glb')))
      );
      try {
        manifest = parseSoundManifest(
          JSON.parse(
            await readFile(join(ASSETS!, 'sounds/manifest.json'), 'utf8')
          )
        );
      } catch {
        manifest = null;
      }
    }, 60_000);

    it("names every collision group as the sounds manifest's surfaces do", () => {
      const names = hull.geometry.userData.surfaceNames as string[];
      console.log(`mirage surface names: ${names.join(', ')}`);
      expect(names[0]).toBe('default');
      expect(names).toContain('plaster');
      expect(names).toContain('wood_ladder');
      if (manifest)
        expect(
          names.filter((n) => !Object.hasOwn(manifest!.surfaces, n))
        ).toEqual([]);
    });

    it('answers a surface under every spawn', () => {
      const t = SPAWNS.t.map(([x, y, z]) => below(x, y, z));
      const ct = SPAWNS.ct.map(([x, y, z]) => below(x, y, z));
      console.log(`mirage spawns: T ${t.join(', ')}; CT ${ct.join(', ')}`);
      for (const s of [...t, ...ct]) expect(s).not.toBeNull();
      if (manifest)
        console.log(
          `mirage spawn step sets: T ${t.map((s) => stepSetOf(manifest!, s)).join(', ')}; ` +
            `CT ${ct.map((s) => stepSetOf(manifest!, s)).join(', ')}`
        );
    });

    it.skipIf(!PACK)(
      needs(
        'answers plaster or concrete under most of 100 players on the ground across the match',
        'DEMOVIEWER_PACK'
      ),
      async () => {
        const pack = parsePack(
          await inflateIfGzip(new Uint8Array(await readFile(PACK!)))
        );
        expect(pack.header.map).toBe('de_mirage');
        // Every live sample on the ground, then 100 of them by a fixed seed.
        const feet: [number, number, number][] = [];
        for (const round of pack.rounds)
          for (const t of round.players)
            for (let k = 0; k < t.flags.length; k++)
              if (
                (t.flags[k] & FLAG.alive) !== 0 &&
                (t.flags[k] & FLAG.airborne) === 0
              )
                feet.push([t.x[k], t.y[k], t.z[k]]);
        const counts = new Map<string, number>();
        const t0 = performance.now();
        for (let i = 0; i < 100; i++) {
          const [x, y, z] = feet[Math.floor(seeded(1, i) * feet.length)];
          const s = below(x, y, z) ?? 'none';
          counts.set(s, (counts.get(s) ?? 0) + 1);
        }
        const each = (performance.now() - t0) / 100;
        const sorted = [...counts].sort((a, b) => b[1] - a[1]);
        console.log(
          `mirage feet (100 of ${feet.length}): ` +
            sorted.map(([s, n]) => `${s} ${n}`).join(', ') +
            `; surfaceBelow ${(each * 1000).toFixed(1)} µs per call`
        );
        const stone =
          (counts.get('plaster') ?? 0) + (counts.get('concrete') ?? 0);
        expect(stone).toBeGreaterThan(50);
        expect(counts.get('none') ?? 0).toBeLessThan(10);
      },
      60_000
    );
  }
);
