// CS2's baked light on the world (baked.ts): light.json read strictly, the lightmap
// (sqrt(light / range)) loaded as data on the lightmap UV, and the shader hook that replaces the ambient and sky
// light of a world material with the bake (the lightmap, or the light in COLOR_0), drops the
// runtime sun where the sun is in the bake, and keeps point lights. Compiled here the way the
// renderer does it, by handing `onBeforeCompile` a fresh copy of the material's source; node
// has no WebGL and no image decoding, so `createImageBitmap` is stubbed.

import * as THREE from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIGHTMAP_INTENSITY,
  PLAYER_SHADOW,
  LIGHTMAP_DECODE,
  VERTEX_LIGHT_DECODE,
  attachBaked,
  disposeBaked,
  loadBaked,
  parseLightInfo,
  sunModeOf,
  type Baked,
  type LightInfo,
} from '../src/scene/baked';
import { DETAIL_MULTIPLY, attachDetail } from '../src/scene/detail';
import { oneCellFile } from './helpers/light-grid';
import { NUKE_LIGHT } from './helpers/light-json';

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

/** Nuke's light.json, as tools/lib/light.mjs writes it (tools-parity.test.ts checks it). */
const NUKE: LightInfo = NUKE_LIGHT;

/** A light grid of one cell, for the hooks, which never read it. */
const GRID = {
  origin: [0, 0, 0] as [number, number, number],
  step: 2.5,
  size: [1, 1, 1] as [number, number, number],
  range: 16,
  version: 2 as const,
  cells: new Uint8Array(10),
};

function bake(info: LightInfo = NUKE): Baked {
  return {
    info,
    lightmap: info.lightmap ? new THREE.Texture() : null,
    lightGrid: GRID,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('parseLightInfo', () => {
  it("reads Task 4's light.json, and tier V's without a lightmap", () => {
    expect(parseLightInfo(JSON.parse(JSON.stringify(NUKE)))).toEqual(NUKE);
    const v = { ...NUKE, lightmap: null };
    expect(parseLightInfo(v)).toEqual(v);
    const noSun = { ...NUKE, sun: null };
    expect(parseLightInfo(noSun)).toEqual(noSun);
  });

  it('refuses version 1 (the RGBM lightmap, which this viewer would misdecode) and versions it does not know', () => {
    for (const version of [1, 3, '2', undefined])
      expect(parseLightInfo({ ...NUKE, version })).toBeNull();
  });

  it('refuses a bake without a light grid: its players would have neither the grid nor their own light', () => {
    expect(parseLightInfo({ ...NUKE, probes: null })).toBeNull();
    const without: Partial<LightInfo> = { ...NUKE };
    delete without.probes;
    expect(parseLightInfo(without)).toBeNull();
  });

  it('refuses what would light the world wrongly or ask for another path', () => {
    const bad: unknown[] = [
      null,
      'light',
      [],
      { ...NUKE, version: 3 },
      { ...NUKE, range: 0 },
      { ...NUKE, range: Number.NaN },
      { ...NUKE, range: '16' },
      { ...NUKE, lightmap: { file: '../world.glb', size: [1024, 1024] } },
      { ...NUKE, lightmap: { file: '', size: [1024, 1024] } },
      { ...NUKE, lightmap: { file: 'lightmap.webp' } },
      { ...NUKE, sun: { ...NUKE.sun, dir: [0, 0, 0] } },
      { ...NUKE, sun: { ...NUKE.sun, dir: [0, 1] } },
      { ...NUKE, sun: { ...NUKE.sun, baked: 'yes' } },
      { ...NUKE, sun: { ...NUKE.sun, intensity: -1 } },
      { ...NUKE, probes: { file: 'a/b.bin' } },
    ];
    for (const v of bad) expect(parseLightInfo(v)).toBeNull();
  });
});

describe('sunModeOf', () => {
  it('baked, live only outside the bake (de_cache), none without a sun or at brightness 0 (Train)', () => {
    expect(sunModeOf(NUKE)).toBe('baked');
    expect(sunModeOf({ ...NUKE, sun: { ...NUKE.sun!, baked: false } })).toBe(
      'live'
    );
    expect(sunModeOf({ ...NUKE, sun: null })).toBe('none');
    // Train ships `baked: true, intensity: 0`: nothing is baked for it and nothing to add.
    expect(sunModeOf({ ...NUKE, sun: { ...NUKE.sun!, intensity: 0 } })).toBe(
      'none'
    );
    expect(
      sunModeOf({ ...NUKE, sun: { ...NUKE.sun!, baked: false, intensity: 0 } })
    ).toBe('none');
    // A black sun is no sun either.
    expect(
      sunModeOf({ ...NUKE, sun: { ...NUKE.sun!, color: [0, 0, 0] } })
    ).toBe('none');
  });
});

describe('loadBaked', () => {
  /**
   * Serves a lightmap and a light grid (404 for the one `ok` or `gridOk` refuses), and decodes
   * every image to a 1024² bitmap.
   */
  function stubImages(ok = true, gridOk = true, grid = oneCellFile()) {
    const fetch = vi.fn(async (url: string) => {
      const served = url.includes('probes.bin') ? gridOk : ok;
      return {
        ok: served,
        status: served ? 200 : 404,
        blob: async () => new Blob(['webp']),
        arrayBuffer: async () => grid,
      };
    });
    const bitmap = { width: 1024, height: 1024, close: vi.fn() };
    const decode = vi.fn<
      (image: Blob, options?: ImageBitmapOptions) => Promise<typeof bitmap>
    >(async () => bitmap);
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('createImageBitmap', decode);
    return { fetch, decode, bitmap };
  }

  it('loads the lightmap as linear data on the lightmap UV, without flipping it', async () => {
    const { fetch, decode, bitmap } = stubImages();
    const b = await loadBaked((n) => `/maps/de_nuke/${n}?v=bda293c0`, NUKE);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([u]) => u)).toEqual([
      '/maps/de_nuke/lightmap.webp?v=bda293c0',
      '/maps/de_nuke/probes.bin?v=bda293c0',
    ]);
    // sqrt(light / range) in each channel: data, never premultiplied, never colour-managed.
    expect(decode.mock.lastCall?.[1]).toMatchObject({
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
    const t = b.lightmap!;
    expect(t.image).toBe(bitmap);
    expect(t.channel).toBe(1);
    expect(t.flipY).toBe(false);
    expect(t.colorSpace).toBe(THREE.NoColorSpace);
    expect(t.premultiplyAlpha).toBe(false);
    expect(t.version).toBeGreaterThan(0);
    expect(b.info).toBe(NUKE);
  });

  it('asks for no lightmap under tier V, only the grid', async () => {
    const { fetch } = stubImages();
    const b = await loadBaked((n) => n, { ...NUKE, lightmap: null });
    expect(b.lightmap).toBeNull();
    expect(fetch.mock.calls.map(([u]) => u)).toEqual(['probes.bin']);
    expect(b.lightGrid.size).toEqual([1, 1, 1]);
  });

  it("loads the light grid beside the lightmap, and rejects naming the grid's URL, freeing the lightmap, when it is missing or not one", async () => {
    stubImages();
    const b = await loadBaked((n) => `/maps/de_nuke/${n}`, NUKE);
    expect(b.lightGrid?.size).toEqual([1, 1, 1]);
    expect(b.lightGrid?.range).toBe(16);
    expect(b.lightGrid?.cells[0]).toBe(200);

    const missing = stubImages(true, false);
    await expect(loadBaked((n) => `/maps/de_nuke/${n}`, NUKE)).rejects.toThrow(
      '/maps/de_nuke/probes.bin: HTTP 404'
    );
    expect(missing.bitmap.close).toHaveBeenCalledTimes(1);

    const bad = stubImages(true, true, oneCellFile('XXXX'));
    await expect(loadBaked((n) => `/maps/de_nuke/${n}`, NUKE)).rejects.toThrow(
      '/maps/de_nuke/probes.bin: not a light grid: bad magic'
    );
    expect(bad.bitmap.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the bake without its lightmap, naming why, when only the lightmap is missing or does not decode', async () => {
    stubImages(false);
    const missing = await loadBaked((n) => `/maps/de_nuke/${n}`, NUKE);
    expect(missing.lightmap).toBeNull();
    expect(missing.lightmapError).toBe('/maps/de_nuke/lightmap.webp: HTTP 404');
    expect(missing.lightGrid.size).toEqual([1, 1, 1]);
    expect(missing.info).toBe(NUKE);

    const { decode } = stubImages();
    decode.mockRejectedValueOnce(
      new Error('the source image could not be decoded')
    );
    const broken = await loadBaked((n) => `/maps/de_nuke/${n}`, NUKE);
    expect(broken.lightmap).toBeNull();
    expect(broken.lightmapError).toBe(
      '/maps/de_nuke/lightmap.webp: the source image could not be decoded'
    );
    // Loaded, or tier V: no error.
    stubImages();
    expect((await loadBaked((n) => n, NUKE)).lightmapError).toBeUndefined();
    expect(
      (await loadBaked((n) => n, { ...NUKE, lightmap: null })).lightmapError
    ).toBeUndefined();
    // Without the grid as well, nothing is kept: the grid's error.
    stubImages(false, false);
    await expect(loadBaked((n) => `/maps/de_nuke/${n}`, NUKE)).rejects.toThrow(
      '/maps/de_nuke/probes.bin: HTTP 404'
    );
  });

  it('frees the texture and the decoded image', async () => {
    const { bitmap } = stubImages();
    const b = await loadBaked((n) => n, NUKE);
    const freed = vi.fn();
    b.lightmap!.addEventListener('dispose', freed);
    disposeBaked(b);
    expect(freed).toHaveBeenCalledTimes(1);
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });
});

describe('attachBaked', () => {
  it('decodes the lightmap, sqrt(light / range) squared, once however often it is attached, at intensity π', () => {
    const b = bake();
    const m = new THREE.MeshLambertMaterial();
    attachBaked(m, b, 'lightmap');
    attachBaked(m, b, 'lightmap');
    expect(m.lightMap).toBe(b.lightmap);
    expect(m.lightMapIntensity).toBe(LIGHTMAP_INTENSITY);
    expect(LIGHTMAP_INTENSITY).toBe(Math.PI);
    const s = compile(m);
    expect(count(s.fragmentShader, LIGHTMAP_DECODE)).toBe(1);
    expect(LIGHTMAP_DECODE).toBe(
      'lightMapTexel.rgb * lightMapTexel.rgb * bakedRange'
    );
    expect(s.uniforms.bakedRange.value).toBe(16);
    // A recompile starts from clean source.
    expect(count(compile(m).fragmentShader, LIGHTMAP_DECODE)).toBe(1);
  });

  it('keys the two sources, and each sun mode, apart', () => {
    const keyOf = (bk: Baked, source: 'lightmap' | 'vertex') => {
      const m = new THREE.MeshLambertMaterial();
      attachBaked(m, bk, source);
      return m.customProgramCacheKey();
    };
    const live = bake({ ...NUKE, sun: { ...NUKE.sun!, baked: false } });
    const none = bake({ ...NUKE, sun: { ...NUKE.sun!, intensity: 0 } });
    const keys = [
      keyOf(bake(), 'lightmap'),
      keyOf(bake(), 'vertex'),
      keyOf(live, 'lightmap'),
      keyOf(live, 'vertex'),
      keyOf(none, 'lightmap'),
      keyOf(none, 'vertex'),
    ];
    expect(new Set(keys).size).toBe(6);
    for (const k of keys) expect(k).toMatch(/^demoviewer-baked-/);
    expect(keys[0]).toContain('lightmap');
    expect(keys[1]).toContain('vertex');
  });

  it('reads COLOR_0 as light, squared and scaled by the range, never as the diffuse colour', () => {
    const b = bake({ ...NUKE, lightmap: null });
    const m = new THREE.MeshLambertMaterial({ vertexColors: true });
    attachBaked(m, b, 'vertex');
    expect(m.vertexColors).toBe(false);
    expect(m.lightMap).toBeNull();
    const s = compile(m);
    expect(count(s.vertexShader, VERTEX_LIGHT_DECODE)).toBe(1);
    expect(VERTEX_LIGHT_DECODE).toContain('color.rgb * color.rgb * bakedRange');
    const f = resolve(s.fragmentShader);
    expect(f).toContain('irradiance += vBakedLight * PI;');
    expect(f).not.toContain(LIGHTMAP_DECODE);
    // COLOR_0 reaches the shader as its own attribute, not as three's vertex colour.
    expect(s.vertexShader).toMatch(
      /#if !defined\( USE_COLOR \) && !defined\( USE_COLOR_ALPHA \)\nattribute vec4 color;/
    );
  });

  it('replaces the ambient and sky light, and the sun where it is baked, but keeps point lights', () => {
    for (const source of ['lightmap', 'vertex'] as const) {
      const m = new THREE.MeshLambertMaterial();
      attachBaked(m, bake(), source);
      const f = resolve(compile(m).fragmentShader);
      expect(f).not.toContain('irradiance = getAmbientLightIrradiance');
      expect(f).not.toContain('irradiance += getHemisphereLightIrradiance');
      expect(f).not.toContain('irradiance += getLightProbeIrradiance');
      // The molotov's PointLight still lights the baked world (ruling 15).
      expect(f).toMatch(
        /getPointLightInfo\( pointLight, geometryPosition, directLight \);[\s\S]*?RE_Direct\(/
      );
      // In the bake: the sun's shadow map only darkens the baked light (players' shadows).
      expect(f).toContain(
        'getDirectionalLightInfo( directionalLight, directLight );'
      );
      expect(f).not.toMatch(
        /getDirectionalLightInfo\( directionalLight, directLight \);[\s\S]*?RE_Direct\([\s\S]*?#if \( NUM_RECT_AREA_LIGHTS/
      );
      expect(f).toContain(`mix( ${PLAYER_SHADOW.toFixed(1)}, 1.0,`);
      expect(f).toContain('irradiance *= bakedShade;');
      // Only the players' shadow darkens it: the light that lights nothing casts theirs, and
      // the sun's own map (the world's shadows, already in the bake) is passed over.
      expect(f).toMatch(
        /if \( directionalLight\.color == vec3\( 0\.0 \) \) \{\s+directionalLightShadow = directionalLightShadows\[ i \];\s+bakedShade \*= /
      );
    }
    expect(PLAYER_SHADOW).toBe(0.5);
  });

  it("lets the runtime sun light the world where it is not in the bake (de_cache), past every shadow map at once: the world's, drawn once, and the players'", () => {
    const m = new THREE.MeshLambertMaterial();
    attachBaked(
      m,
      bake({ ...NUKE, sun: { ...NUKE.sun!, baked: false } }),
      'lightmap'
    );
    const f = resolve(compile(m).fragmentShader);
    // Every directional shadow map multiplied into how much of the sun gets there…
    expect(f).toMatch(
      /float bakedSunSeen = 1\.0;[\s\S]*?#if defined\( USE_SHADOWMAP \) && NUM_DIR_LIGHT_SHADOWS > 0\s*bakedSunSeen = 1\.0;[\s\S]*?for \( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i \+\+ \) \{[\s\S]*?bakedSunSeen \*= receiveShadow \? getShadow\(/
    );
    // …then every directional light (the sun; the players' map's light is black) past it.
    expect(f).toMatch(
      /getDirectionalLightInfo\( directionalLight, directLight \);\s*directLight\.color \*= bakedSunSeen;\s*RE_Direct\(/
    );
    // Not three's block, which darkens each directional light by its own map alone.
    expect(f).not.toContain(
      '( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]'
    );
    expect(f).not.toContain('irradiance *= bakedShade;');
    expect(f).not.toContain('irradiance += getHemisphereLightIrradiance');
  });

  it('gives the world no sun at all at brightness 0 (Train): no direct light, no shadow darkening', () => {
    for (const sun of [{ ...NUKE.sun!, intensity: 0 }, null]) {
      const m = new THREE.MeshLambertMaterial();
      attachBaked(m, bake({ ...NUKE, sun }), 'lightmap');
      const f = resolve(compile(m).fragmentShader);
      expect(f).not.toContain(
        'getDirectionalLightInfo( directionalLight, directLight );'
      );
      expect(f).not.toContain('bakedShade');
      expect(f).toContain(LIGHTMAP_DECODE);
      // Point lights stay.
      expect(f).toContain(
        'getPointLightInfo( pointLight, geometryPosition, directLight );'
      );
    }
  });

  it('composes with the detail texture: both edits, one program key naming both', () => {
    const m = new THREE.MeshLambertMaterial();
    attachBaked(m, bake(), 'lightmap');
    attachDetail(m, new THREE.Texture());
    attachBaked(m, bake(), 'lightmap');
    const s = compile(m);
    expect(count(s.fragmentShader, LIGHTMAP_DECODE)).toBe(1);
    expect(count(s.fragmentShader, DETAIL_MULTIPLY)).toBe(1);
    expect(count(s.fragmentShader, 'uniform sampler2D detailMap;')).toBe(1);
    expect(s.uniforms.detailMap).toBeDefined();
    expect(s.uniforms.bakedRange).toBeDefined();
    const key = m.customProgramCacheKey();
    expect(key).toContain('baked-lightmap');
    expect(key).toContain('detail');
  });
});
