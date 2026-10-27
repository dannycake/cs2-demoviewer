// The sounds manifest in the browser (`audio/manifest.ts`): what a sound's layers are, how loud a
// layer is at a distance by its curve, which clip a seed picks; and the step set of the surface a
// player stands on (`audio/surfaces.ts`), named from the hull's collision group as `hull.glb`
// names it. The gated case parses the real `/sounds/manifest.json`:
//   ASSETS_DIR=<repo>/assets npm test

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  curveGain,
  parseSoundManifest,
  pickClip,
  seeded,
  type SoundLayer,
  type SoundManifest,
} from '../src/audio/manifest';
import { stepSetOf, surfaceOfNode } from '../src/audio/surfaces';
import { needs } from './helpers/gates';

/** The AK-47's close layer (`Weapon_AK47.Single`): full to 175.7 units, 0.0147 from 2,500. */
const AK: [number, number][] = [
  [25, 0.8],
  [30, 1],
  [175.7143, 1],
  [440, 0.735294],
  [1288, 0.330882],
  [2500, 0.014706],
];

const layer = (clips: [number, number][]): SoundLayer => ({
  clips,
  volume: 1,
  volumeRandom: [0, 0],
  pitch: 1,
  pitchRandom: [0, 0],
  curve: AK,
  offset: [0, 0, 60],
  loop: false,
});

const SHA = 'ab'.repeat(32);

/** A manifest as tools/build-sounds.mjs writes it, with one sound per way to be dropped. */
function raw(): Record<string, unknown> {
  return {
    schema: 1,
    cs2Build: '2000935',
    banks: {
      weapon_ak47: { sha256: SHA, bytes: 66975, seconds: 10.27 },
      steps_concrete: { sha256: SHA, bytes: 20000, seconds: 3.1 },
    },
    sounds: {
      'shot:ak47': {
        bank: 'weapon_ak47',
        layers: [
          layer([
            [0, 1.9429],
            [1.9929, 2.1562],
          ]),
          { ...layer([[6.3724, 3.8978]]), curve: [[800, 0]] },
        ],
      },
      'step:concrete:ct': {
        bank: 'steps_concrete',
        layers: [{ ...layer([[0, 0.2]]), curve: null }],
      },
      // A bank the manifest does not list.
      'shot:m4a1': { bank: 'weapon_m4a1', layers: [layer([[0, 1]])] },
      // No clip in any layer.
      'shot:empty': { bank: 'weapon_ak47', layers: [layer([])] },
      'shot:nolayers': { bank: 'weapon_ak47', layers: [] },
    },
    surfaces: { plaster: 'concrete', concrete: 'concrete', default: 'default' },
  };
}

describe('curveGain', () => {
  it("is the curve's first gain before its first point and its last past its last", () => {
    expect(curveGain(AK, 20)).toBe(0.8);
    expect(curveGain(AK, 9999)).toBe(0.014706);
  });

  it('runs linearly between two points', () => {
    const g = curveGain(AK, 300);
    expect(g).toBeLessThan(1);
    expect(g).toBeGreaterThan(0.735294);
    const t = (300 - 175.7143) / (440 - 175.7143);
    expect(g).toBeCloseTo(1 + t * (0.735294 - 1), 9);
    expect(curveGain(AK, 27.5)).toBeCloseTo(0.9, 9);
    expect(curveGain(AK, 440)).toBe(0.735294);
    expect(curveGain(AK, 100)).toBe(1);
  });

  it("is the first point's gain for no distance (NaN)", () => {
    expect(curveGain(AK, NaN)).toBe(0.8);
  });

  it('is 1 without a curve', () => {
    expect(curveGain(null, 0)).toBe(1);
    expect(curveGain(null, 5000)).toBe(1);
    expect(curveGain([], 5000)).toBe(1);
  });
});

describe('parseSoundManifest', () => {
  it('keeps every sound whose bank it lists and that has a clip, and the surfaces', () => {
    const m = parseSoundManifest(raw())!;
    expect(Object.keys(m.banks)).toEqual(['weapon_ak47', 'steps_concrete']);
    expect(m.banks.weapon_ak47).toEqual({
      sha256: SHA,
      bytes: 66975,
      seconds: 10.27,
    });
    expect(Object.keys(m.sounds)).toEqual(['shot:ak47', 'step:concrete:ct']);
    const ak = m.sounds['shot:ak47'];
    expect(ak.bank).toBe('weapon_ak47');
    expect(ak.layers).toHaveLength(2);
    expect(ak.layers[0]).toEqual(
      layer([
        [0, 1.9429],
        [1.9929, 2.1562],
      ])
    );
    expect(ak.layers[1].curve).toEqual([[800, 0]]);
    expect(m.sounds['step:concrete:ct'].layers[0].curve).toBeNull();
    expect(m.surfaces).toEqual({
      plaster: 'concrete',
      concrete: 'concrete',
      default: 'default',
    });
  });

  it('drops a sound naming a bank it does not list, or with no clip', () => {
    const m = parseSoundManifest(raw())!;
    expect(m.sounds['shot:m4a1']).toBeUndefined();
    expect(m.sounds['shot:empty']).toBeUndefined();
    expect(m.sounds['shot:nolayers']).toBeUndefined();
  });

  it('drops a layer without a clip, keeping the sound by its others', () => {
    const r = raw();
    const sounds = r.sounds as Record<string, { layers: unknown[] }>;
    sounds['shot:ak47'].layers.push(layer([]), 'not a layer');
    expect(
      parseSoundManifest(r)!.sounds['shot:ak47'].layers.map(
        (l) => l.clips.length
      )
    ).toEqual([2, 1]);
  });

  it('is null for anything without banks and sounds', () => {
    expect(parseSoundManifest([])).toBeNull();
    expect(parseSoundManifest(null)).toBeNull();
    expect(parseSoundManifest('{}')).toBeNull();
    expect(parseSoundManifest({ banks: {}, sounds: [] })).toBeNull();
    expect(parseSoundManifest({ sounds: {} })).toBeNull();
    // Surfaces are optional: every step then takes the default set.
    expect(parseSoundManifest({ banks: {}, sounds: {} })).toEqual({
      banks: {},
      sounds: {},
      surfaces: {},
    });
  });
});

describe('seeded and pickClip', () => {
  const three = layer([
    [0, 1],
    [1, 1],
    [2, 1],
  ]);

  it('seeded is a number in [0, 1) fixed by the seed and the draw', () => {
    for (let s = 0; s < 50; s++) {
      const a = seeded(s * 7919, s);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThan(1);
      expect(seeded(s * 7919, s)).toBe(a);
    }
    expect(seeded(42, 0)).not.toBe(seeded(42, 1));
    // mulberry32 of seed + i: the same draw by either.
    expect(seeded(42, 1)).toBe(seeded(43, 0));
    expect(seeded(0xffffffff, 1)).toBe(seeded(0, 0));
  });

  it('pickClip picks the same clip for the same seed, and every clip over 100 seeds', () => {
    const seen = new Set<number>();
    for (let s = 0; s < 100; s++) {
      const c = pickClip(three, s * 2654435761);
      expect(pickClip(three, s * 2654435761)).toBe(c);
      seen.add(c[0]);
    }
    expect([...seen].sort()).toEqual([0, 1, 2]);
    expect(pickClip(layer([[4, 2]]), 123)).toEqual([4, 2]);
  });
});

describe('surfaceOfNode', () => {
  it("names a collision group's surface as the sounds manifest keys it", () => {
    expect(surfaceOfNode('physics_group_wood_plank')).toBe('wood_plank');
    expect(surfaceOfNode('physics_group')).toBe('default');
    expect(
      surfaceOfNode('physics_passbullets_vrf_unknown_key_2838185980')
    ).toBe('vrf_unknown_key_2838185980');
    expect(surfaceOfNode('physics_window_glass')).toBe('glass');
    expect(surfaceOfNode('physics_ladder_passbullets_wood_ladder')).toBe(
      'wood_ladder'
    );
    expect(surfaceOfNode('physics_passbullets_window_chainlink')).toBe(
      'chainlink'
    );
    expect(surfaceOfNode('physics_group_metal')).toBe('metal');
    // Train's two groups named for how they block, then what they are made of.
    expect(surfaceOfNode('physics_ConditionallySolid_foliage')).toBe('foliage');
    expect(surfaceOfNode('physics_blocksound_window_glass')).toBe('glass');
  });

  it('is null for a node that is not a collision group', () => {
    expect(surfaceOfNode('world')).toBeNull();
    expect(surfaceOfNode('')).toBeNull();
    expect(surfaceOfNode('mesh_0')).toBeNull();
  });
});

describe('stepSetOf', () => {
  const m = parseSoundManifest(raw())!;

  it("is the surface's step set, or default for no surface or one the table does not know", () => {
    expect(stepSetOf(m, 'plaster')).toBe('concrete');
    expect(stepSetOf(m, 'default')).toBe('default');
    expect(stepSetOf(m, 'unobtainium')).toBe('default');
    expect(stepSetOf(m, null)).toBe('default');
    expect(stepSetOf(m, 'constructor')).toBe('default');
  });
});

const ASSETS = process.env.ASSETS_DIR;

describe.skipIf(!ASSETS)(
  needs('the real sounds manifest', 'ASSETS_DIR'),
  () => {
    it('parses whole: every sound kept, the AK in two layers, plaster stepping as concrete', async () => {
      const text = await readFile(
        join(ASSETS!, 'sounds/manifest.json'),
        'utf8'
      );
      const json = JSON.parse(text) as {
        sounds: Record<string, unknown>;
        surfaces: Record<string, unknown>;
      };
      const m = parseSoundManifest(json) as SoundManifest;
      expect(m).not.toBeNull();
      expect(Object.keys(m.sounds)).toEqual(Object.keys(json.sounds));
      expect(Object.keys(m.surfaces)).toEqual(Object.keys(json.surfaces));
      const ak = m.sounds['shot:ak47'];
      expect(ak.layers.map((l) => l.clips.length)).toEqual([3, 1]);
      expect(curveGain(ak.layers[0].curve, 20)).toBe(0.8);
      expect(curveGain(ak.layers[1].curve, 300)).toBe(0);
      expect(stepSetOf(m, 'plaster')).toBe('concrete');
      expect(stepSetOf(m, 'vrf_unknown_key_2838185980')).toBe('metalrailing');
      // Every step set the table names has its CT step and its landing.
      for (const set of new Set(Object.values(m.surfaces))) {
        expect(m.sounds[`step:${set}:ct`], set).toBeDefined();
        expect(m.sounds[`land:${set}`], set).toBeDefined();
      }
      console.log(
        `sounds manifest: ${Object.keys(m.banks).length} banks, ` +
          `${Object.keys(m.sounds).length} sounds, ` +
          `${Object.keys(m.surfaces).length} surfaces in ` +
          `${new Set(Object.values(m.surfaces)).size} step sets`
      );
    });
  }
);
