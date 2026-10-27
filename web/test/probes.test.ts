// CS2's light grid on the players (probes.ts): probes.bin read exactly as tools/lib/probes.mjs
// writes it (and refused as `decodeLightGrid` refuses it), sampled trilinearly in linear light
// at a point clamped into the grid, and the shader hook that lights a player's material from
// the sample in place of the sky light, with the sun past its shadow maps or, without one, the
// grid's sun. Compiled here the way the renderer does it, by handing `onBeforeCompile` a fresh
// copy of the material's source.

import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { RigTemplate } from '../src/scene/loaders';
import { PlayerRig } from '../src/scene/PlayerRig';
import {
  attachProbe,
  detachProbe,
  makeProbeSample,
  parseLightGrid,
  sampleLightGrid,
  type LightGrid,
} from '../src/scene/probes';
import { WeaponCache } from '../src/scene/weapons';
import { newPlayerState } from '../src/sim/sample';
import { FLAG } from '../src/pack/types';
import type { RigInput } from '../src/scene/frame';
import { familyOf } from '../src/sim/weapons';

type ShaderObject = Parameters<THREE.Material['onBeforeCompile']>[0];

/** What the renderer passes to `onBeforeCompile` for a Lambert material. */
function compile(m: THREE.Material): ShaderObject {
  const src = THREE.ShaderLib.lambert;
  const shader = {
    uniforms: THREE.UniformsUtils.clone(src.uniforms),
    vertexShader: src.vertexShader,
    fragmentShader: src.fragmentShader,
  } as ShaderObject;
  m.onBeforeCompile(shader, null as unknown as THREE.WebGLRenderer);
  return shader;
}

/** `src` with every `#include <chunk>` replaced by its chunk, as WebGLProgram resolves them. */
function resolve(src: string): string {
  return src.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name: string) =>
    resolve(THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk] as string)
  );
}

const count = (s: string, part: string) => s.split(part).length - 1;

/** One cell of version 2: up R G B, down R G B, side R G B, sun (tools/README.md, "probes.bin"). */
type Cell = [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/**
 * probes.bin as tools/lib/probes.mjs `encodeLightGrid` writes it, little-endian; `cells` of
 * `bytes` each (version 1's are 8: up, down, sun, 0).
 */
function gridFile({
  origin = [0, 0, 0],
  step = 2.5,
  size = [2, 1, 1],
  range = 8,
  cells,
  magic = 'DVLG',
  version = 2,
  bytes = 10,
  extra = 0,
}: {
  origin?: number[];
  step?: number;
  size?: number[];
  range?: number;
  cells: number[][];
  magic?: string;
  version?: number;
  bytes?: number;
  extra?: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(36 + bytes * cells.length + extra);
  const v = new DataView(buf);
  for (let i = 0; i < 4; i++) v.setUint8(i, magic.charCodeAt(i));
  v.setUint16(4, version, true);
  origin.forEach((o, a) => v.setFloat32(8 + 4 * a, o, true));
  v.setFloat32(20, step, true);
  size.forEach((s, a) => v.setUint16(24 + 2 * a, s, true));
  v.setFloat32(32, range, true);
  cells.forEach((c, i) =>
    c.forEach((b, k) => v.setUint8(36 + bytes * i + k, b))
  );
  return buf;
}

/** A byte's light: (b / 255)² · range, as `decodeLightGrid` reads it. */
const light = (b: number, range = 8) => (b / 255) ** 2 * range;

const DARK: Cell = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const BRIGHT: Cell = [255, 128, 64, 32, 64, 96, 200, 100, 50, 255];

describe('parseLightGrid', () => {
  it('reads a 2×1×1 grid to its exact header and cells', () => {
    const g = parseLightGrid(
      gridFile({
        origin: [1.5, -2.25, 3],
        step: 2.5,
        size: [2, 1, 1],
        range: 16,
        cells: [DARK, BRIGHT],
      })
    );
    expect(g.origin).toEqual([1.5, -2.25, 3]);
    expect(g.step).toBe(2.5);
    expect(g.size).toEqual([2, 1, 1]);
    expect(g.range).toBe(16);
    expect(g.version).toBe(2);
    expect(g.cells).toBeInstanceOf(Uint8Array);
    expect(g.cells.length).toBe(20);
    expect([...g.cells.subarray(10, 20)]).toEqual(BRIGHT);
  });

  it('reads version 1 (8 bytes a cell: up, down, sun, 0), as 146d893–4ef350d wrote it', () => {
    const g = parseLightGrid(
      gridFile({
        version: 1,
        bytes: 8,
        cells: [
          [0, 0, 0, 0, 0, 0, 0, 0],
          [255, 128, 64, 32, 64, 96, 255, 0],
        ],
      })
    );
    expect(g.version).toBe(1);
    expect(g.cells.length).toBe(16);
  });

  it('refuses what decodeLightGrid refuses: a bad magic, version or length, or a header no encode writes', () => {
    const ok = { cells: [DARK, BRIGHT] };
    expect(() => parseLightGrid(gridFile({ ...ok, magic: 'DVLX' }))).toThrow(
      'bad magic'
    );
    for (const version of [0, 3])
      expect(() => parseLightGrid(gridFile({ ...ok, version }))).toThrow(
        `version ${version}, not 1 or 2`
      );
    expect(() => parseLightGrid(gridFile({ ...ok, extra: 1 }))).toThrow(
      'length'
    );
    // Version 2's cells under version 1's header: 10 bytes a cell are not 8.
    expect(() => parseLightGrid(gridFile({ ...ok, version: 1 }))).toThrow(
      'length 56, not 52'
    );
    expect(() => parseLightGrid(gridFile({ cells: [DARK] }))).toThrow('length');
    expect(() => parseLightGrid(new ArrayBuffer(35))).toThrow('header');
    expect(() => parseLightGrid(gridFile({ ...ok, step: 0 }))).toThrow('step');
    expect(() => parseLightGrid(gridFile({ ...ok, range: -1 }))).toThrow(
      'range'
    );
    expect(() =>
      parseLightGrid(gridFile({ size: [0, 1, 1], cells: [] }))
    ).toThrow('no cells');
    expect(() =>
      parseLightGrid(gridFile({ ...ok, origin: [Number.NaN, 0, 0] }))
    ).toThrow('origin');
  });
});

describe('sampleLightGrid', () => {
  const grid = (cells: Cell[], size = [2, 1, 1]): LightGrid =>
    parseLightGrid(gridFile({ origin: [10, 0, 0], step: 2.5, size, cells }));

  it('interpolates decoded linear light: halfway from a dark cell to a bright one is half its light', () => {
    const g = grid([DARK, BRIGHT]);
    const s = sampleLightGrid(
      g,
      new THREE.Vector3(11.25, 0, 0),
      makeProbeSample()
    );
    // In the bytes the midpoint would read (127.5 / 255)² · 8 = 2, a stop too dark: the light is
    // the mean of the two decoded values.
    expect(s.up.r).toBeCloseTo(light(255) / 2, 6);
    expect(s.up.r).toBeCloseTo(4, 6);
    expect(s.up.g).toBeCloseTo(light(128) / 2, 6);
    expect(s.up.b).toBeCloseTo(light(64) / 2, 6);
    expect(s.down.r).toBeCloseTo(light(32) / 2, 6);
    expect(s.down.g).toBeCloseTo(light(64) / 2, 6);
    expect(s.down.b).toBeCloseTo(light(96) / 2, 6);
    expect(s.side.r).toBeCloseTo(light(200) / 2, 6);
    expect(s.side.g).toBeCloseTo(light(100) / 2, 6);
    expect(s.side.b).toBeCloseTo(light(50) / 2, 6);
    // The sun's visibility is linear in its byte.
    expect(s.sun).toBeCloseTo(0.5, 6);

    const lit: Cell = [100, 100, 100, 50, 50, 50, 70, 80, 90, 51];
    const m = sampleLightGrid(
      grid([lit, BRIGHT]),
      new THREE.Vector3(11.25, 0, 0),
      makeProbeSample()
    );
    expect(m.up.r).toBeCloseTo((light(100) + light(255)) / 2, 6);
    expect(m.down.g).toBeCloseTo((light(50) + light(64)) / 2, 6);
    expect(m.side.b).toBeCloseTo((light(90) + light(50)) / 2, 6);
    expect(m.sun).toBeCloseTo((51 / 255 + 1) / 2, 6);
  });

  it("gives version 1's cells a side of the mean of their up and down, the light they gave a surface facing sideways", () => {
    const g = parseLightGrid(
      gridFile({
        origin: [10, 0, 0],
        version: 1,
        bytes: 8,
        cells: [
          [0, 0, 0, 0, 0, 0, 0, 0],
          [255, 128, 64, 32, 64, 96, 255, 0],
        ],
      })
    );
    const s = sampleLightGrid(
      g,
      new THREE.Vector3(11.25, 0, 0),
      makeProbeSample()
    );
    expect(s.up.r).toBeCloseTo(light(255) / 2, 6);
    expect(s.down.b).toBeCloseTo(light(96) / 2, 6);
    expect(s.side.r).toBeCloseTo((light(255) + light(32)) / 4, 6);
    expect(s.side.g).toBeCloseTo((light(128) + light(64)) / 4, 6);
    expect(s.side.b).toBeCloseTo((light(64) + light(96)) / 4, 6);
    expect(s.sun).toBeCloseTo(0.5, 6);
  });

  it('weighs the eight cells around a point trilinearly', () => {
    const cells: Cell[] = [];
    for (let k = 0; k < 8; k++)
      cells.push([k * 30, 0, 0, 0, 0, 255 - k * 30, 0, 7 * k, 0, k * 30]);
    const g = parseLightGrid(
      gridFile({ origin: [0, 0, 0], step: 2, size: [2, 2, 2], cells })
    );
    const t = [0.25, 0.5, 0.75];
    const s = sampleLightGrid(
      g,
      new THREE.Vector3(2 * t[0], 2 * t[1], 2 * t[2]),
      makeProbeSample()
    );
    let up = 0;
    let down = 0;
    let side = 0;
    let sun = 0;
    for (let k = 0; k < 8; k++) {
      const [x, y, z] = [k & 1, (k >> 1) & 1, (k >> 2) & 1];
      const w =
        (x ? t[0] : 1 - t[0]) * (y ? t[1] : 1 - t[1]) * (z ? t[2] : 1 - t[2]);
      // Cell (x, y, z) is at x + nx·(y + ny·z): k itself.
      up += w * light(cells[k][0]);
      down += w * light(cells[k][5]);
      side += w * light(cells[k][7]);
      sun += (w * cells[k][9]) / 255;
    }
    expect(s.up.r).toBeCloseTo(up, 6);
    expect(s.down.b).toBeCloseTo(down, 6);
    expect(s.side.g).toBeCloseTo(side, 6);
    expect(s.sun).toBeCloseTo(sun, 6);
  });

  it("gives a point beyond either end that end's cell, never nothing where the cell has light", () => {
    const end: Cell = [40, 50, 60, 10, 20, 30, 25, 35, 45, 128];
    const g = grid([end, BRIGHT]);
    const out = makeProbeSample();
    for (const p of [
      new THREE.Vector3(-500, 0, 0),
      new THREE.Vector3(10, 40, -30),
      new THREE.Vector3(9.99, -7, 3),
    ]) {
      expect(sampleLightGrid(g, p, out)).toBe(out);
      expect(out.up.r).toBeCloseTo(light(40), 6);
      expect(out.up.b).toBeCloseTo(light(60), 6);
      expect(out.down.g).toBeCloseTo(light(20), 6);
      expect(out.side.b).toBeCloseTo(light(45), 6);
      expect(out.sun).toBeCloseTo(128 / 255, 6);
      expect(out.up.r).toBeGreaterThan(0);
    }
    sampleLightGrid(g, new THREE.Vector3(1e6, 2, 2), out);
    expect(out.up.r).toBeCloseTo(light(255), 6);
    expect(out.sun).toBe(1);
  });

  it('reads a cell, never NaN, for a position that is not a number', () => {
    const g = grid([BRIGHT, DARK]);
    const out = sampleLightGrid(
      g,
      new THREE.Vector3(Number.NaN, 0, Number.NaN),
      makeProbeSample()
    );
    expect(out.up.r).toBeCloseTo(light(255), 6);
    expect(Number.isNaN(out.sun)).toBe(false);
  });
});

describe('attachProbe', () => {
  it('puts the probe term in the fragment once however often it is attached', () => {
    const s = makeProbeSample();
    const m = new THREE.MeshLambertMaterial();
    attachProbe(m, s);
    attachProbe(m, s);
    const shader = compile(m);
    const f = resolve(shader.fragmentShader);
    expect(count(f, 'vec3 irradiance = PI * probeLight;')).toBe(1);
    expect(count(shader.fragmentShader, 'uniform vec3 probeUp;')).toBe(1);
    expect(count(shader.fragmentShader, 'uniform vec3 probeSide;')).toBe(1);
    // The grid's light replaces the ambient, probe and sky light.
    expect(f).not.toContain('irradiance += getHemisphereLightIrradiance');
    expect(f).not.toContain('getAmbientLightIrradiance( ambientLightColor )');
    expect(m.customProgramCacheKey()).toBe('demoviewer-probe');
    // A recompile starts from clean source.
    expect(
      count(
        resolve(compile(m).fragmentShader),
        'vec3 irradiance = PI * probeLight;'
      )
    ).toBe(1);
  });

  it("reads the rig's sample as it changes, and another sample's after a rebind, without recompiling", () => {
    const a = makeProbeSample();
    const m = new THREE.MeshLambertMaterial();
    attachProbe(m, a);
    const { uniforms } = compile(m);
    a.up.setRGB(1, 2, 3);
    a.down.setRGB(0.1, 0.2, 0.3);
    a.side.setRGB(0.4, 0.5, 0.6);
    a.sun = 0.25;
    expect(uniforms.probeUp.value).toBe(a.up);
    expect(uniforms.probeDown.value).toBe(a.down);
    expect(uniforms.probeSide.value).toBe(a.side);
    expect(uniforms.probeSun.value).toBe(0.25);
    expect(uniforms.probeZenith.value.toArray()).toEqual([0, 1, 0]);
    const version = m.version;
    const b = makeProbeSample();
    b.sun = 0.75;
    const zenith = new THREE.Vector3(0, 0, 1);
    attachProbe(m, b, zenith);
    expect(m.version).toBe(version);
    expect(uniforms.probeUp.value).toBe(b.up);
    expect(uniforms.probeSide.value).toBe(b.side);
    expect(uniforms.probeSun.value).toBe(0.75);
    expect(uniforms.probeZenith.value).toBe(zenith);
  });

  it('lights by up, down and side weighed by the square of the normal along each, as CS2 weighs its cube, π times the bake', () => {
    const m = new THREE.MeshLambertMaterial();
    attachProbe(m, makeProbeSample());
    const f = resolve(compile(m).fragmentShader);
    expect(f).toContain(
      'float probeY = dot( geometryNormal, normalize( ( viewMatrix * vec4( probeZenith, 0.0 ) ).xyz ) );'
    );
    expect(f).toContain('float probeAbove = max( probeY, 0.0 );');
    expect(f).toContain('float probeBelow = max( - probeY, 0.0 );');
    expect(f).toContain(
      'vec3 probeLight = probeUp * ( probeAbove * probeAbove ) + probeDown * ( probeBelow * probeBelow ) + probeSide * ( 1.0 - probeY * probeY );'
    );
    expect(f).toContain('vec3 irradiance = PI * probeLight;');
    expect(f).not.toContain('mix( probeDown, probeUp');
  });

  it('lets the sun through every shadow map at once, or by the grid without one', () => {
    const m = new THREE.MeshLambertMaterial();
    attachProbe(m, makeProbeSample());
    const f = resolve(compile(m).fragmentShader);
    // Past the shadow maps: the product of every directional shadow (the world's and the
    // players' where the sun is in the bake), on the sun's colour.
    expect(f).toMatch(
      /#if defined\( USE_SHADOWMAP \) && NUM_DIR_LIGHT_SHADOWS > 0\s+probeSunSeen = 1\.0;[\s\S]*?for \( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i \+\+ \)[\s\S]*?probeSunSeen \*= receiveShadow \? getShadow\(/
    );
    expect(f).toContain('float probeSunSeen = probeSun;');
    expect(f).toMatch(
      /getDirectionalLightInfo\( directionalLight, directLight \);\s+directLight\.color \*= probeSunSeen;\s+RE_Direct\(/
    );
    // three's own per-light shadow is gone: it would apply the players' map to the black light
    // only.
    expect(f).not.toContain(
      'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap'
    );
    // Point lights (the molotov's) still light the players.
    expect(f).toMatch(
      /getPointLightInfo\( pointLight, geometryPosition, directLight \);[\s\S]*?RE_Direct\(/
    );
  });

  it('restores the plain material when detached', () => {
    const plain = new THREE.MeshLambertMaterial().customProgramCacheKey();
    const m = new THREE.MeshLambertMaterial();
    attachProbe(m, makeProbeSample());
    const version = m.version;
    detachProbe(m);
    expect(m.customProgramCacheKey()).toBe(plain);
    expect(m.version).toBeGreaterThan(version);
    expect(compile(m).fragmentShader).toBe(
      THREE.ShaderLib.lambert.fragmentShader
    );
    // Detaching what has none changes nothing.
    const v = m.version;
    detachProbe(m);
    expect(m.version).toBe(v);
  });
});

/** A model of one mesh with its own normals, holding weapons on `wpn`. */
function template(): RigTemplate {
  const root = new THREE.Group();
  const wpn = Object.assign(new THREE.Bone(), { name: 'wpn' });
  root.add(wpn);
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(),
    new THREE.MeshStandardMaterial()
  );
  root.add(body);
  return { scene: root, clips: new Map(), variants: new Map() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function holding(weapon: string): RigInput {
  return {
    state: {
      ...newPlayerState(),
      present: true,
      flags: FLAG.alive,
      health: 100,
    },
    team: 2,
    tick: 1000,
    clipTime: 0,
    deathTicks: null,
    death: null,
    actions: [],
    weapon,
    family: familyOf(weapon),
    locomotion: [],
  };
}

describe('PlayerRig.setProbe', () => {
  const LIT = { lit: true, smoothNormals: true, maxAnisotropy: 1 };

  it('lights the body and every weapon it holds from the sample, and gives the plain look back on null', async () => {
    const cache = new WeaponCache(async () => {
      const g = new THREE.Group();
      g.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(),
          new THREE.MeshStandardMaterial()
        )
      );
      return g;
    });
    cache.get('ak47');
    cache.get('deagle');
    await flush();
    const rig = new PlayerRig(template(), 2, LIT, cache);
    rig.apply(holding('ak47'), { tick_rate: 64 });
    const s = makeProbeSample();
    rig.setProbe(s);
    // A weapon first held after the sample was set gets it too.
    rig.apply(holding('deagle'), { tick_rate: 64 });
    const materials: THREE.Material[] = [];
    rig.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) materials.push(mesh.material as THREE.Material);
    });
    expect(materials.length).toBe(3);
    for (const m of materials)
      expect(m.customProgramCacheKey()).toBe('demoviewer-probe');
    // The same sample again changes nothing.
    const versions = materials.map((m) => m.version);
    rig.setProbe(s);
    expect(materials.map((m) => m.version)).toEqual(versions);

    rig.setProbe(null);
    const plain = new THREE.MeshLambertMaterial().customProgramCacheKey();
    for (const m of materials) expect(m.customProgramCacheKey()).toBe(plain);
  });
});
