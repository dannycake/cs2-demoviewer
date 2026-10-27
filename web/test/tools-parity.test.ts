// The formats the asset pipeline (tools/) writes and the viewer reads, one test each: the tools'
// own writer (or reader, or table) and the viewer's run on the same data and must agree, as
// weapons.test.ts holds the clip tables together. Each pair was kept equal by a "the same as …"
// comment only, so a change on one side passed both suites while the viewer misread the file.
// Where a gate (check-map.mjs) validates a file, every file it passes must be one the viewer
// reads: a gate that passes what the viewer refuses ships a map drawn without it.
// The tools' modules import sharp, @gltf-transform and three from tools/node_modules, which only
// this file of the web suite loads: without them (`cd tools && npm ci`) every describe here is
// skipped, saying so, rather than the file failing to load.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe as vitestDescribe, expect, it } from 'vitest';
import { surfaceOfNode } from '../src/audio/surfaces';
import { sourceAnglesToQuaternion, worldToRadar } from '../src/geo/coords';
import { parseOverview } from '../src/radar/overview';
import {
  LIGHTMAP_DECODE,
  VERTEX_LIGHT_DECODE,
  parseLightInfo,
} from '../src/scene/baked';
import { FLOOR_LIFT } from '../src/scene/itemlight';
import {
  makeProbeSample,
  parseLightGrid,
  sampleLightGrid,
} from '../src/scene/probes';
import { FLAG } from '../src/pack/types';
import { locomotionBlend } from '../src/sim/locomotion';
import type { Family } from '../src/sim/weapons';
import { has, needs } from './helpers/gates';
import {
  GRID,
  GRID_RANGE,
  ONE_CELL,
  ONE_CELL_RANGE,
  lightGridFile,
  oneCellFile,
} from './helpers/light-grid';
import { LIGHT_JSONS } from './helpers/light-json';
import type * as Tools from './helpers/tools';

const TOOLS_DEPS = new URL('../../tools/node_modules/', import.meta.url);
const TOOLS_INSTALLED = fs.existsSync(TOOLS_DEPS);
// Straight to stderr: vitest shows no console output of a file whose tests all skipped.
if (!TOOLS_INSTALLED)
  process.stderr.write(
    `tools-parity.test.ts skipped: ${fileURLToPath(TOOLS_DEPS)} is missing; run cd tools && npm ci\n`
  );
const tools: typeof Tools = TOOLS_INSTALLED
  ? await import('./helpers/tools')
  : (undefined as never);
/** vitest's describe, skipped without the tools' modules. */
const describe = vitestDescribe.skipIf(!TOOLS_INSTALLED);

/** A seeded generator (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `bytes` as the ArrayBuffer the viewer's fetch hands its readers. */
const arrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  new Uint8Array(bytes).buffer;

describe('probes.bin: tools/lib/probes.mjs and scene/probes.ts', () => {
  const RANGE = 8;

  /** A 3×2×4 grid of random light, some of it past the range (the encoder clamps it). */
  function randomGrid(seed: number): Tools.ToolsLightGrid {
    const r = rng(seed);
    const size = [3, 2, 4];
    const n = size[0] * size[1] * size[2];
    const fill = (k: number, scale: number) =>
      Float32Array.from({ length: k }, () => r() * scale);
    return {
      origin: [-3.25, 0.5, 12.75],
      step: 2.5,
      size,
      up: fill(3 * n, RANGE * 1.2),
      down: fill(3 * n, RANGE * 0.5),
      side: fill(3 * n, RANGE),
      sun: fill(n, 1),
    };
  }

  /** Points inside the grid and past every side of it. */
  function points(seed: number, count: number): THREE.Vector3[] {
    const r = rng(seed);
    return Array.from(
      { length: count },
      () => new THREE.Vector3(-10 + r() * 20, -3 + r() * 9, 5 + r() * 20)
    );
  }

  /** Expects the viewer's sample at each point to be the pipeline's. */
  function expectSamplesAgree(bytes: Uint8Array): void {
    const decoded = tools.decodeLightGrid(bytes);
    const grid = parseLightGrid(arrayBuffer(bytes));
    const out = makeProbeSample();
    for (const p of points(7, 300)) {
      const want = tools.sampleGrid(decoded, [p.x, p.y, p.z]);
      const got = sampleLightGrid(grid, p, out);
      const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 5);
      (['up', 'down', 'side'] as const).forEach((face) => {
        near(got[face].r, want[face][0]);
        near(got[face].g, want[face][1]);
        near(got[face].b, want[face][2]);
      });
      near(got.sun, want.sun);
    }
  }

  it('the viewer reads the header encodeLightGrid writes, and samples it as the pipeline does', () => {
    const bytes = tools.encodeLightGrid(randomGrid(1), RANGE);
    const decoded = tools.decodeLightGrid(bytes);
    const grid = parseLightGrid(arrayBuffer(bytes));
    expect(grid.version).toBe(decoded.version);
    expect(grid.origin).toEqual(decoded.origin);
    expect(grid.step).toBe(decoded.step);
    expect(grid.size).toEqual(decoded.size);
    expect(grid.range).toBe(RANGE);
    expectSamplesAgree(bytes);
  });

  it('reads a version 1 grid (up, down, the sun; side their mean) as the pipeline does', () => {
    const v2 = tools.encodeLightGrid(randomGrid(2), RANGE);
    const n = 3 * 2 * 4;
    const v1 = new Uint8Array(36 + 8 * n);
    v1.set(v2.subarray(0, 36));
    new DataView(v1.buffer).setUint16(4, 1, true);
    for (let c = 0; c < n; c++) {
      v1.set(v2.subarray(36 + 10 * c, 36 + 10 * c + 6), 36 + 8 * c);
      v1[36 + 8 * c + 6] = v2[36 + 10 * c + 9];
    }
    expect(tools.decodeLightGrid(v1).version).toBe(1);
    expectSamplesAgree(v1);
  });

  it('refuses exactly the files the pipeline refuses', () => {
    const good = tools.encodeLightGrid(randomGrid(3), RANGE);
    const edit = (f: (v: DataView) => void) => {
      const b = new Uint8Array(good);
      f(new DataView(b.buffer));
      return b;
    };
    const cases: [string, Uint8Array][] = [
      ['whole', good],
      ['short', good.subarray(0, 35)],
      ['one byte long', new Uint8Array([...good, 0])],
      ['one byte short', good.subarray(0, good.length - 1)],
      ['bad magic', edit((v) => v.setUint8(0, 0x58))],
      ['version 3', edit((v) => v.setUint16(4, 3, true))],
      ['version 1 length', edit((v) => v.setUint16(4, 1, true))],
      ['no cells', edit((v) => v.setUint16(24, 0, true))],
      ['step 0', edit((v) => v.setFloat32(20, 0, true))],
      ['range 0', edit((v) => v.setFloat32(32, 0, true))],
      ['range below 0', edit((v) => v.setFloat32(32, -8, true))],
      ['origin NaN', edit((v) => v.setFloat32(12, NaN, true))],
    ];
    const throws = (f: () => unknown) => {
      try {
        f();
        return false;
      } catch {
        return true;
      }
    };
    for (const [name, bytes] of cases) {
      const tool = throws(() => tools.decodeLightGrid(bytes));
      const web = throws(() => parseLightGrid(arrayBuffer(bytes)));
      expect({ name, web }).toEqual({ name, web: tool });
    }
  });

  it("the fixture grids (helpers/light-grid.ts) are the encoder's, with the bytes they name", () => {
    expect([...new Uint8Array(lightGridFile())]).toEqual([
      ...tools.encodeLightGrid(GRID, GRID_RANGE),
    ]);
    const cells = [...new Uint8Array(lightGridFile(), 36)];
    expect(cells).toEqual([
      ...[0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ...[255, 255, 255, 64, 64, 64, 128, 128, 128, 255],
    ]);
    expect([...new Uint8Array(oneCellFile())]).toEqual([
      ...tools.encodeLightGrid(ONE_CELL, ONE_CELL_RANGE),
    ]);
    expect([...new Uint8Array(oneCellFile(), 36)]).toEqual([
      200, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it('reads items on the floor at the lowest height the refit fits the grid to', () => {
    expect(FLOOR_LIFT).toBe(Math.min(...tools.FIT.heights));
  });
});

describe('light.json: tools/lib/light.mjs and scene/baked.ts', () => {
  const SUN = {
    dir: [0.3346, 0.866, -0.3716],
    color: [1, 0.7379, 0.4508],
    intensity: 3,
    baked: true,
  };
  /** light.json as shrink-map.mjs writes it for each shape of bake (built in the tests). */
  const written = () => ({
    H2: tools.lightJson({ range: 8, lightmapSize: [1024, 1024], sun: SUN }),
    'H2, 2048 × 1024': tools.lightJson({
      range: 12.5,
      lightmapSize: [2048, 1024],
      sun: SUN,
    }),
    'tier V, a dynamic sun': tools.lightJson({
      range: 16,
      lightmapSize: null,
      sun: { ...SUN, baked: false },
    }),
    'no sun': tools.lightJson({ range: 4, lightmapSize: null, sun: null }),
  });

  it('the fixtures (helpers/light-json.ts) are what lightJson writes for their bakes', () => {
    for (const [map, json] of Object.entries(LIGHT_JSONS)) {
      const bake = {
        range: json.range,
        lightmapSize: json.lightmap?.size ?? null,
        sun: json.sun,
      };
      expect(tools.lightJson(bake), map).toEqual(json);
    }
  });

  it('the viewer reads every light.json shrink-map.mjs writes, field for field', () => {
    for (const [name, json] of Object.entries(written())) {
      const parsed = JSON.parse(JSON.stringify(json)) as unknown;
      expect(tools.lightJsonProblem(parsed), name).toBeNull();
      expect(parseLightInfo(parsed), name).toEqual(json);
    }
  });

  it('every light.json check-map.mjs passes, the viewer draws with its bake', () => {
    const shapes = written();
    const h2 = shapes.H2;
    const sun = SUN;
    const variants: [string, unknown][] = [
      ...Object.entries(shapes),
      ['no light grid', { ...h2, probes: null }],
      ['another light grid name', { ...h2, probes: { file: 'grid.bin' } }],
      ['a sun with no direction', { ...h2, sun: { ...sun, dir: [0, 0, 0] } }],
      [
        'a sun of negative brightness',
        { ...h2, sun: { ...sun, intensity: -1 } },
      ],
      ['a sun of no brightness', { ...h2, sun: { ...sun, intensity: 0 } }],
      ['a sun without baked', { ...h2, sun: { ...sun, baked: undefined } }],
      [
        'a lightmap of a fractional size',
        { ...h2, lightmap: { file: 'lightmap.webp', size: [1024.5, 1024] } },
      ],
      [
        'another lightmap name',
        { ...h2, lightmap: { file: 'light.webp', size: [1024, 1024] } },
      ],
      ['version 1', { ...h2, version: 1 }],
      ['range 0', { ...h2, range: 0 }],
      [
        'no sun key',
        {
          version: 2,
          range: 8,
          lightmap: null,
          probes: { file: 'probes.bin' },
        },
      ],
      ['an array', [h2]],
    ];
    for (const [name, json] of variants) {
      if (tools.lightJsonProblem(json) === null)
        expect(parseLightInfo(json), name).not.toBeNull();
    }
  });
});

describe('the bake encodings: tools/lib/lightmap.mjs lightBytes and scene/baked.ts', () => {
  /**
   * A decode the shaders run (LIGHTMAP_DECODE, VERTEX_LIGHT_DECODE) as a function of one channel
   * of its input: a product of the input's `.rgb`, `bakedRange` and constants, componentwise, so
   * a number stands for each of r, g and b. Any other shape fails here: the pipeline's encoding
   * would need a new reading.
   */
  function decodeOf(
    glsl: string,
    input: string
  ): (x: number, range: number) => number {
    const factors = glsl
      .replace(/^\s*\w+\s*=\s*/, '')
      .replace(/;\s*$/, '')
      .split('*')
      .map((f) => f.trim());
    const known = [`${input}.rgb`, 'bakedRange'];
    expect(
      factors.every((f) => known.includes(f) || /^\d+(\.\d+)?$/.test(f))
    ).toBe(true);
    return (x, range) =>
      factors.reduce(
        (p, f) => p * (f === known[0] ? x : f === known[1] ? range : Number(f)),
        1
      );
  }
  const lightmapDecode = decodeOf(LIGHTMAP_DECODE, 'lightMapTexel');
  const vertexDecode = decodeOf(VERTEX_LIGHT_DECODE, 'color');

  it('the shader decodes every lightmap byte to the light the pipeline says it holds', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const range of [4, 8, 16.25]) {
      const want = tools.decodeLightmap(bytes, range);
      bytes.forEach((b) =>
        expect(lightmapDecode(b / 255, range)).toBeCloseTo(want[b], 4)
      );
    }
  });

  it('the light lightBytes stores comes back within one code of itself, in the lightmap and in COLOR_0', () => {
    const r = rng(11);
    for (const [bits, decode] of [
      [tools.LIGHTMAP_BITS, lightmapDecode],
      [tools.VERTEX_LIGHT_BITS, vertexDecode],
    ] as const) {
      const step = 2 ** (8 - bits);
      for (let i = 0; i < 500; i++) {
        const range = 2 + r() * 14;
        const rgb = [r() * range, r() * range, r() * range];
        const codes = tools.lightBytes(rgb, range, bits);
        codes.forEach((code, k) => {
          // Codes are 255 · sqrt(light / range) on the `bits`-bit grid: the decoded light's code
          // is within one grid step of the true light's.
          const back = decode(code / 255, range);
          const trueCode = 255 * Math.sqrt(rgb[k] / range);
          const backCode = 255 * Math.sqrt(back / range);
          expect(Math.abs(backCode - trueCode)).toBeLessThanOrEqual(
            step + 1e-9
          );
        });
      }
    }
  });
});

describe('overview.json: tools/lib/overview.mjs and radar/overview.ts', () => {
  const NUKE = `"de_nuke"
{
  "pos_x" "-3453" "pos_y" "2887" "scale" "7"
  "verticalsections"
  {
    "default" { "AltitudeMax" "10000" "AltitudeMin" "-495" }
    "lower" { "AltitudeMax" "-495" "AltitudeMin" "-10000" }
  }
  "CTSpawn_x" "0.82" "CTSpawn_y" "0.45" "TSpawn_x" "0.19" "TSpawn_y" "0.54"
  "bombA_x" "0.58" "bombA_y" "0.48" "bombB_x" "0.58" "bombB_y" "0.58"
}`;
  const MIRAGE = `"de_mirage"
{
  "pos_x" "-3230" "pos_y" "1713" "scale" "5.00"
  "bombA_x" "0.54" "bombA_y" "0.76" "bombB_x" "0.23" "bombB_y" "0.28"
  "inset_left" "0.135" "inset_top" "0.08" "inset_right" "0.105" "inset_bottom" "0.08"
}`;
  const nuke = () =>
    JSON.parse(
      JSON.stringify(
        tools.overviewFromKv('de_nuke', tools.parseKv(NUKE), {
          default: 'radar.png',
          lower: 'radar_lower.png',
        })
      )
    ) as Record<string, unknown>;
  const mirage = () =>
    JSON.parse(
      JSON.stringify(
        tools.overviewFromKv('de_mirage', tools.parseKv(MIRAGE), {
          default: 'radar.png',
        })
      )
    ) as Record<string, unknown>;

  it('the viewer reads what radar.mjs writes, field for field', () => {
    for (const ov of [nuke(), mirage()]) {
      const got = parseOverview(ov);
      expect(got).not.toBeNull();
      expect(got).toEqual({
        map: ov.map,
        posX: ov.posX,
        posY: ov.posY,
        scale: ov.scale,
        size: ov.size,
        sections: ov.sections,
        bombA: ov.bombA,
        bombB: ov.bombB,
        inset: ov.inset,
      });
    }
  });

  it('places a point on the radar where the pipeline does', () => {
    const r = rng(5);
    for (const ov of [nuke(), mirage()]) {
      const parsed = parseOverview(ov);
      if (!parsed) throw new Error('unreadable overview');
      for (let i = 0; i < 100; i++) {
        const x = -4000 + r() * 8000;
        const y = -4000 + r() * 8000;
        expect(worldToRadar(x, y, parsed)).toEqual(
          tools.worldToRadar(
            x,
            y,
            ov as { posX: number; posY: number; scale: number }
          )
        );
      }
    }
  });

  it('every overview.json check-map.mjs passes, the viewer reads', () => {
    const ov = nuke();
    const [main, lower] = ov.sections as Record<string, unknown>[];
    const variants: [string, unknown][] = [
      ['whole', ov],
      ['mirage', mirage()],
      [
        'a section in capitals',
        {
          ...ov,
          sections: [
            main,
            { ...lower, name: 'Lower', image: 'radar_Lower.png' },
          ],
        },
      ],
      [
        'an image in capitals',
        { ...ov, sections: [main, { ...lower, image: 'radar_LOWER.png' }] },
      ],
      ['no size', { ...ov, size: undefined }],
      ['no sections', { ...ov, sections: [] }],
      ['a scale of 0', { ...ov, scale: 0 }],
      ['no markers', { ...ov, bombA: null, bombB: null }],
      ['an array', [ov]],
    ];
    for (const [name, v] of variants) {
      if (tools.overviewProblem(v, 'de_nuke') === null)
        expect(parseOverview(v), name).not.toBeNull();
    }
  });
});

describe("entities.glb's root rotations: tools/lib/entities.mjs and geo/coords.ts", () => {
  it('turns Source angles into the rotation the pipeline gives each root', () => {
    const r = rng(3);
    const q = { x: 0, y: 0, z: 0, w: 1 };
    const angles: [number, number, number][] = [
      [0, 0, 0],
      [0, 90, 0],
      [-90, 0, 0],
      [0, 0, 180],
      [10, 200, -30],
    ];
    for (let i = 0; i < 200; i++)
      angles.push([r() * 360 - 180, r() * 720 - 360, r() * 360 - 180]);
    for (const [pitch, yaw, roll] of angles) {
      const [x, y, z, w] = tools.anglesToGltfQuat([pitch, yaw, roll]);
      sourceAnglesToQuaternion(pitch, yaw, roll, q);
      // q and −q are one rotation.
      const dot = q.x * x + q.y * y + q.z * z + q.w * w;
      expect(Math.abs(dot)).toBeCloseTo(1, 9);
    }
  });
});

describe('surfaces: tools/lib/sounds.mjs and audio/surfaces.ts', () => {
  it('reads every hull node name as the sounds build keys it', () => {
    const names = [
      'physics_group_wood_plank',
      'physics_group',
      'physics_group_',
      'physics_passbullets_vrf_unknown_key_2838185980',
      'physics_window_glass',
      'physics_ladder_passbullets_wood_ladder',
      'physics_passbullets_window_chainlink',
      'physics_group_metal',
      'physics_ConditionallySolid_foliage',
      'physics_blocksound_concrete',
      'physics_GROUP_Metal_Grate',
      'physics_groupie',
      'physics_ladder',
      'physics_',
      'physics',
      'world',
      'func_door',
      'Physics_group_dirt',
      '',
    ];
    for (const name of names)
      expect({ name, surface: surfaceOfNode(name) }).toEqual({
        name,
        surface: tools.surfaceOfNode(name),
      });
  });
});

describe('player clips: tools/lib/players.mjs CLIP_SET and sim/locomotion.ts', () => {
  const FAMILIES: Family[] = ['rifle', 'pistol', 'knife', 'grenade', 'c4'];

  /** Every clip locomotionBlend asks for, over speeds, directions, crouch, flags and turns. */
  function clipsAsked(family: Family): Set<string> {
    const asked = new Set<string>();
    for (const speed of [0, 10, 60, 139, 141, 250])
      for (let angle = -180; angle < 360; angle += 7.5)
        for (const duck of [0, 64, 128, 255])
          for (const flags of [0, FLAG.walking, FLAG.airborne])
            for (const vertical of [0, 100])
              for (const yawRate of [0, 60, -60, 120, -120, 400, -400])
                for (const c of locomotionBlend({
                  speed,
                  velocityAngle: angle,
                  vertical,
                  duck,
                  flags,
                  yawRate,
                  family,
                }))
                  asked.add(c.clip);
    return asked;
  }

  let allOnce: Set<string> | undefined;
  /** Every clip locomotionBlend asks for, over every family (worked out once). */
  const allAsked = () =>
    (allOnce ??= new Set(FAMILIES.flatMap((f) => [...clipsAsked(f)])));

  /**
   * Clips it asks for that CLIP_SET requests but no built player GLB carries yet: the players are
   * re-ripped only when CS2 updates, so a clip added to CLIP_SET waits for the next rip, and until
   * then PlayerRig plays the family idle in its place. `inair_stand_knife`, which a knife player
   * in the air asks for (sim/locomotion.ts `inair_stand_${family}`): CLIP_SET has requested it
   * since 2026-10-27, and CS2 build 2000935 ships it, but the built players were ripped from that
   * build before it was asked for, so `idle_knife` plays. Keep it here until a real build carries
   * it (check-players stops listing it among the optional clips absent; the ASSETS_DIR test below
   * fails on such a build), then remove it.
   */
  const NOT_CARRIED = ['inair_stand_knife'];

  it('asks only for clips tools requests from VRF', () => {
    const requested = new Set(tools.CLIPS_REQUESTED);
    expect([...allAsked()].filter((c) => !requested.has(c)).sort()).toEqual([]);
  });

  it('names as not carried yet only clips it asks for', () => {
    for (const clip of NOT_CARRIED) expect([...allAsked()]).toContain(clip);
  });

  it.skipIf(!has('ASSETS_DIR'))(
    needs(
      'the built players carry every clip it asks for, but those not carried yet',
      'ASSETS_DIR'
    ),
    () => {
      for (const side of ['ct', 't']) {
        const shrink = `${process.env.ASSETS_DIR}/players/${side}.shrink.json`;
        const { clips } = JSON.parse(fs.readFileSync(shrink, 'utf8')) as {
          clips: string[];
        };
        const carried = new Set(clips);
        expect(
          [...allAsked()].filter((c) => !carried.has(c)).sort(),
          side
        ).toEqual(NOT_CARRIED);
      }
    }
  );

  it('blends every directional clip each family ships, and no other', () => {
    for (const family of ['rifle', 'pistol', 'knife'] as const) {
      const directional = (clips: Iterable<string>) =>
        [...clips]
          .filter((c) => /^(run|walk|crouch)_[nsew]{1,2}_/.test(c))
          .sort();
      expect(directional(clipsAsked(family)), family).toEqual(
        directional(tools.CLIP_SET[family])
      );
    }
  });
});
