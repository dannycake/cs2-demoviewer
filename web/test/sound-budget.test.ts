// The sound budget (spec §12, the M3 plan's Global Constraints): the banks a typical match
// loads total at most 3,000,000 bytes. Measured on the Mirage match as the viewer plays it:
// every round's cues (`roundCues`) with each footfall's step set from the surface the real
// hull names under it (as `Scene.surfaceBelow` and the director ask), and the union of the
// banks those cues' sounds are cut from, by the sizes the real sounds manifest lists. Prints
// the total and the five largest banks. Skips unless both are set:
//   DEMOVIEWER_PACK=~/.local/share/demoviewer/mirage-fp.dvpk.gz ASSETS_DIR=<repo>/assets npm test

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseSoundManifest } from '../src/audio/manifest';
import { stepSetOf } from '../src/audio/surfaces';
import { toScene, UNIT } from '../src/geo/coords';
import { inflateIfGzip, parsePack } from '../src/pack/reader';
import { Hull } from '../src/scene/hull';
import { loadHull } from '../src/scene/loaders';
import { roundCues } from '../src/sim/sounds';
import { fileUrl, installBrowserShims } from './helpers/node-gltf';
import { needs } from './helpers/gates';

const PACK = process.env.DEMOVIEWER_PACK;
const ASSETS = process.env.ASSETS_DIR;

/** The banks a typical match loads, at most (bytes). */
const BUDGET = 3_000_000;

/** `Scene.surfaceBelow`'s reach: from this far over the feet to this far under them (units). */
const FEET_ABOVE = 8;
const FEET_BELOW = 32;

describe.skipIf(!PACK || !ASSETS)(
  needs('Sound budget on the Mirage match', 'DEMOVIEWER_PACK', 'ASSETS_DIR'),
  () => {
    it(`the banks every round's cues name total at most ${BUDGET.toLocaleString('en-US')} bytes`, async () => {
      installBrowserShims();
      const pack = parsePack(
        await inflateIfGzip(new Uint8Array(await readFile(PACK!)))
      );
      expect(pack.header.map).toBe('de_mirage');
      const manifest = parseSoundManifest(
        JSON.parse(
          await readFile(join(ASSETS!, 'sounds/manifest.json'), 'utf8')
        )
      );
      expect(manifest).not.toBeNull();
      const m = manifest!;
      const hull = new Hull(
        await loadHull(await fileUrl(join(ASSETS!, 'maps/de_mirage/hull.glb')))
      );
      const probe = new THREE.Vector3();
      const stepSetAt = (x: number, y: number, z: number) => {
        toScene(x, y, z + FEET_ABOVE, probe);
        return stepSetOf(
          m,
          hull.surfaceBelow(probe, (FEET_ABOVE + FEET_BELOW) * UNIT)
        );
      };

      // A key the manifest lacks names no bank: the director skips it.
      const banks = new Set<string>();
      pack.header.rounds.forEach((_, r) => {
        for (const cue of roundCues(pack, r, stepSetAt))
          if (Object.hasOwn(m.sounds, cue.key))
            banks.add(m.sounds[cue.key].bank);
      });
      const sizes = [...banks]
        .map((b) => [b, m.banks[b].bytes] as const)
        .sort((a, b) => b[1] - a[1]);
      const total = sizes.reduce((n, [, bytes]) => n + bytes, 0);
      const fmt = (n: number) => n.toLocaleString('en-US');
      console.log(
        `mirage sound banks: ${banks.size} of ${Object.keys(m.banks).length}, ` +
          `${fmt(total)} B (budget ${fmt(BUDGET)}); largest: ` +
          sizes
            .slice(0, 5)
            .map(([b, bytes]) => `${b} ${fmt(bytes)}`)
            .join(', ')
      );
      expect(banks.has('round')).toBe(true);
      expect([...banks].some((b) => b.startsWith('steps_'))).toBe(true);
      expect(total).toBeLessThanOrEqual(BUDGET);
    }, 60_000);
  }
);
