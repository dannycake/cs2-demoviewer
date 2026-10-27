// The demo, the map and the radar share one coordinate frame: players' feet, put through
// toScene, stand on Mirage's collision hull. Samples flagged airborne are left out: a player
// mid-jump stands on nothing. What still misses stands on surfaces the hull drops (player
// clip ramps over stairs) or never had (props). Gated on the local pack and assets:
//   DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage.dvpk.gz ASSETS_DIR=<repo>/assets npm test

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { beforeAll, describe, expect, it } from 'vitest';
import { toScene, UNIT } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { FLAG, type Pack } from '../src/pack/types';
import { makeGltfLoader, mergeMeshes } from '../src/scene/loaders';
import { fileUrl, installBrowserShims } from './helpers/node-gltf';
import { needs } from './helpers/gates';

const PACK = process.env.DEMOVIEWER_PACK;
const ASSETS = process.env.ASSETS_DIR;
const GATE = needs('mirage feet on the hull', 'DEMOVIEWER_PACK', 'ASSETS_DIR');

const ROUNDS = [0, 11];
const EVERY = 50;
const RAY_UP = 10; // units above the feet
const BELOW_M = 0.4;
const MIN_HIT = 0.95;

describe.skipIf(!PACK || !ASSETS)(GATE, () => {
  let pack: Pack;
  let bvh: MeshBVH;

  beforeAll(async () => {
    installBrowserShims();
    pack = parsePack(
      await inflateIfGzip(new Uint8Array(await readFile(PACK!)))
    );
    const gltf = await makeGltfLoader().loadAsync(
      await fileUrl(join(ASSETS!, 'maps/de_mirage/hull.glb'))
    );
    bvh = new MeshBVH(mergeMeshes(gltf.scene));
  }, 60_000);

  it(`has >= ${MIN_HIT * 100}% of sampled feet within ${BELOW_M} m of the hull below`, () => {
    expect(pack.header.map).toBe('de_mirage');
    const ray = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
    const feet = new THREE.Vector3();
    let total = 0;
    let hits = 0;
    let none = 0;
    let airborne = 0;
    let airborneHits = 0;
    const gaps: number[] = [];
    for (const r of ROUNDS) {
      const round = pack.rounds[r];
      let roundTotal = 0;
      let roundHits = 0;
      round.players.forEach((t) => {
        let alive = 0;
        for (let k = 0; k < t.flags.length; k++) {
          if ((t.flags[k] & FLAG.alive) === 0) continue;
          if (alive++ % EVERY !== 0) continue;
          const f = toScene(t.x[k], t.y[k], t.z[k], feet);
          toScene(t.x[k], t.y[k], t.z[k] + RAY_UP, ray.origin);
          const hit = bvh.raycastFirst(ray, THREE.DoubleSide);
          if (t.flags[k] & FLAG.airborne) {
            airborne++;
            if (hit && f.y - hit.point.y <= BELOW_M) airborneHits++;
            continue;
          }
          roundTotal++;
          if (!hit) {
            none++;
            continue;
          }
          const gap = f.y - hit.point.y;
          gaps.push(gap);
          if (gap <= BELOW_M) roundHits++;
        }
      });
      console.log(
        `round ${r + 1}: ${roundHits}/${roundTotal} feet within ${BELOW_M} m of the hull`
      );
      total += roundTotal;
      hits += roundHits;
    }
    gaps.sort((a, b) => a - b);
    const q = (p: number) => gaps[Math.floor(p * (gaps.length - 1))];
    console.log(
      `all: ${hits}/${total} = ${((100 * hits) / total).toFixed(1)}%, ${none} with no hull below; ` +
        `gap feet-hull m: min ${q(0).toFixed(3)} median ${q(0.5).toFixed(3)} ` +
        `p95 ${q(0.95).toFixed(3)} (ray starts ${(RAY_UP * UNIT).toFixed(3)} m up); ` +
        `left out ${airborne} airborne samples, ${airborneHits} of them within ${BELOW_M} m; ` +
        `with them ${((100 * (hits + airborneHits)) / (total + airborne)).toFixed(1)}%`
    );
    expect(total).toBeGreaterThan(100);
    expect(hits / total).toBeGreaterThanOrEqual(MIN_HIT);
  });
});
