// CS2's baked light on the world (tools/README.md, "The light"): the map's light.json, the
// lightmap (lightmap.webp) for the primitives that kept their lightmap UV (TEXCOORD_1, which
// GLTFLoader names `uv1`), the light every other primitive carries in COLOR_0, and the light
// grid (probes.bin, probes.ts) the players are lit by. A world material with the bake takes its
// indirect light from it in place of the ambient, probe and hemisphere terms. Where the sun is
// in the bake, the world takes no runtime sun, and the players' shadow map (Lighting's
// `playerShadow`) darkens the baked light instead; where it is not (de_cache), the runtime sun
// lights the world on top of the bake, past the world's shadow map and the players' (the shadow
// is split there too); with no sun (none, or brightness 0 like Train's) the world takes neither.
// Point lights (the molotov's) light the baked world as any other.
//
// Encodings (tools/lib/lightmap.mjs `lightBytes`, one `range` per map):
// the lightmap (8 bits a channel, lossless WebP) and COLOR_0 (6 bits) are both
// sqrt(light / range), squared here, light = rgb² · range; the lightmap per fragment, COLOR_0 per
// vertex. Both are a Lambert bake without π, which `lightMapIntensity = π` cancels against
// three's 1/π.

import * as THREE from 'three';
import {
  attachHook,
  directionalPastEveryShadow,
  lightsBegin,
  replaceOnce,
  type ShaderHook,
} from './hooks';
import { parseLightGrid, type LightGrid } from './probes';

/**
 * The light.json version this viewer draws: 2, the lightmap as sqrt(light / range). Version 1's
 * was RGBM, which this decode would misread, so a bundle meets only the assets it knows and
 * draws any other map as without a bake.
 */
export const LIGHT_VERSION = 2;

/** The map's light.json (tools/lib/light.mjs `lightJson`). */
export interface LightInfo {
  version: typeof LIGHT_VERSION;
  /** The one range of both encodings, in linear light. */
  range: number;
  /** The lightmap's file beside light.json and its size; null under tier V (vertex light only). */
  lightmap: { file: string; size: [number, number] } | null;
  /**
   * The map's sun (`light_environment`): the direction towards it in scene axes, its linear
   * colour and brightness, and whether the bake holds it. Null without one. The shadow box is
   * fitted along the direction; where the bake holds the sun, the players' and the arms' sun is
   * this one, at π times its brightness (`Lighting.setBakedSun`), else the atmosphere's.
   */
  sun: {
    dir: [number, number, number];
    color: [number, number, number];
    intensity: number;
    baked: boolean;
  } | null;
  /** The light grid the players are lit by (probes.bin): every bake has one. */
  probes: { file: string };
}

/** A map's bake as the world and the players draw it. */
export interface Baked {
  readonly info: LightInfo;
  /**
   * lightmap.webp, sqrt(light / range) as linear data on `uv1`; null under tier V, or when it did
   * not load (`lightmapError`).
   */
  readonly lightmap: THREE.Texture | null;
  /** probes.bin, the light the players take. */
  readonly lightGrid: LightGrid;
  /**
   * Why the lightmap light.json names did not load (missing, or not decoded), beside a grid that
   * did: the vertex-lit primitives keep the bake, the lightmapped ones are drawn without it.
   * Absent when it loaded or under tier V.
   */
  readonly lightmapError?: string;
}

/** Which of a world primitive's attributes carries its light. */
export type BakedSource = 'lightmap' | 'vertex';

/**
 * How the world takes the sun: `baked` (in the bake; the shadow map only darkens it), `live`
 * (outside it, de_cache: the runtime sun and its shadow, as today) or `none`.
 */
export type SunMode = 'baked' | 'live' | 'none';

/** Cancels three's 1/π in Lambert: the bake is a Lambert irradiance without π. */
export const LIGHTMAP_INTENSITY = Math.PI;
/** How much of the baked light a player's shadow leaves, where the sun is in the bake. */
export const PLAYER_SHADOW = 0.5;
/** The lightmap's decode in the fragment shader: sqrt(light / range), squared (the tests look for it). */
export const LIGHTMAP_DECODE =
  'lightMapTexel.rgb * lightMapTexel.rgb * bakedRange';
/** COLOR_0's decode in the vertex shader, interpolated as linear light. */
export const VERTEX_LIGHT_DECODE =
  'vBakedLight = color.rgb * color.rgb * bakedRange;';

const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const finite = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);

function triple(v: unknown): [number, number, number] | null {
  return Array.isArray(v) && v.length === 3 && v.every(finite)
    ? [v[0], v[1], v[2]]
    : null;
}

function fileOf(v: unknown): { file: string } | null {
  return isObject(v) && typeof v.file === 'string' && FILE.test(v.file)
    ? { file: v.file }
    : null;
}

/**
 * `json` as a LightInfo, or null when it is not one that can light the world: a version other
 * than `LIGHT_VERSION`, a range that is not a positive number, a file name that leaves the
 * map's folder, a sun without a direction, no light grid (the players would have neither its
 * light nor their own), or a field of the wrong type.
 */
export function parseLightInfo(json: unknown): LightInfo | null {
  if (!isObject(json) || json.version !== LIGHT_VERSION) return null;
  const { range } = json;
  if (!finite(range) || range <= 0) return null;

  let lightmap: LightInfo['lightmap'] = null;
  if (json.lightmap !== null) {
    const f = fileOf(json.lightmap);
    const size = isObject(json.lightmap) ? json.lightmap.size : null;
    if (
      !f ||
      !Array.isArray(size) ||
      size.length !== 2 ||
      !size.every((n) => Number.isInteger(n) && n > 0)
    )
      return null;
    lightmap = { file: f.file, size: [size[0], size[1]] };
  }

  let sun: LightInfo['sun'] = null;
  if (json.sun !== null) {
    const s = json.sun;
    if (!isObject(s)) return null;
    const dir = triple(s.dir);
    const color = triple(s.color);
    if (
      !dir ||
      Math.hypot(...dir) < 1e-6 ||
      !color ||
      !finite(s.intensity) ||
      s.intensity < 0 ||
      typeof s.baked !== 'boolean'
    )
      return null;
    sun = { dir, color, intensity: s.intensity, baked: s.baked };
  }

  const probes = fileOf(json.probes);
  if (!probes) return null;
  return { version: LIGHT_VERSION, range, lightmap, sun, probes };
}

/** How the world under `info` takes the sun; brightness 0, or a black sun, is no sun. */
export function sunModeOf(info: LightInfo): SunMode {
  const s = info.sun;
  if (!s || !(s.intensity > 0) || !(Math.max(...s.color) > 0)) return 'none';
  return s.baked ? 'baked' : 'live';
}

/**
 * Loads `info`'s lightmap and light grid, by the URLs `file` gives their names, together. The
 * lightmap is sqrt(light / range) data: decoded without premultiplying or colour-managing (every
 * channel is linear data, not colour), linear colour space, on `uv1` with no flip (the
 * lightmap's rows are in glTF UV order). No mipmaps: the 1024² atlas is magnified almost
 * everywhere, and a mip level would average neighbouring charts. Rejects, naming the URL, when
 * the grid is missing or not one (`parseLightGrid`), freeing a lightmap decoded beside it: the
 * players and the vertex light need it. A lightmap that is missing or does not decode beside a
 * grid that loaded is no lightmap, its error kept in `lightmapError` (naming the URL): the
 * primitives lit by vertex light keep the bake. Tier V has no lightmap to load.
 */
export async function loadBaked(
  file: (name: string) => string,
  info: LightInfo
): Promise<Baked> {
  const [lightmap, grid] = await Promise.allSettled([
    loadLightmap(file, info),
    loadLightGrid(file, info),
  ]);
  if (grid.status === 'rejected') {
    if (lightmap.status === 'fulfilled') freeLightmap(lightmap.value);
    throw grid.reason;
  }
  if (lightmap.status === 'rejected') {
    const e: unknown = lightmap.reason;
    return {
      info,
      lightmap: null,
      lightGrid: grid.value,
      lightmapError: e instanceof Error ? e.message : String(e),
    };
  }
  return { info, lightmap: lightmap.value, lightGrid: grid.value };
}

/** `info`'s probes.bin. */
async function loadLightGrid(
  file: (name: string) => string,
  info: LightInfo
): Promise<LightGrid> {
  const url = file(info.probes.file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  try {
    return parseLightGrid(await res.arrayBuffer());
  } catch (e) {
    throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** `info`'s lightmap as a texture (see `loadBaked`), or null under tier V. */
async function loadLightmap(
  file: (name: string) => string,
  info: LightInfo
): Promise<THREE.Texture | null> {
  if (!info.lightmap) return null;
  const url = file(info.lightmap.file);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(await res.blob(), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
    });
  } catch (e) {
    throw new Error(`${url}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const t = new THREE.Texture(bitmap);
  t.name = url;
  t.channel = 1;
  t.flipY = false;
  t.premultiplyAlpha = false;
  t.colorSpace = THREE.NoColorSpace;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Frees lightmap `t`: its upload and its decoded image. */
function freeLightmap(t: THREE.Texture | null): void {
  if (!t) return;
  t.dispose();
  const image = t.image as { close?: () => void } | null;
  image?.close?.();
}

const disposed = new WeakSet<Baked>();

/** Frees `b`'s lightmap: its upload and its decoded image. A second call does nothing. */
export function disposeBaked(b: Baked): void {
  if (!b.lightmap || disposed.has(b)) return;
  disposed.add(b);
  freeLightmap(b.lightmap);
}

const LIGHTMAP_LINE =
  'vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;';

/**
 * Where the sun is in the bake: no direct sun, and the players' shadow darkens the baked light.
 * Their shadow is the one map whose light lights nothing (black: Lighting's `playerShadow`);
 * the sun's own map holds the world's shadows, which the bake has already.
 */
const DIR_IN_BAKE = /* glsl */ `float bakedShade = 1.0;
#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct ) && defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	DirectionalLight directionalLight;
	DirectionalLightShadow directionalLightShadow;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		#if ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		if ( directionalLight.color == vec3( 0.0 ) ) {
			directionalLightShadow = directionalLightShadows[ i ];
			bakedShade *= ( receiveShadow && dot( geometryNormal, directLight.direction ) > 0.0 ) ? mix( ${PLAYER_SHADOW.toFixed(1)}, 1.0, getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) ) : 1.0;
		}
		#endif
	}
	#pragma unroll_loop_end
#endif

`;

/**
 * Where the sun is drawn at runtime beside the bake (de_cache): the sun as three draws it, but
 * past both shadow maps of the split (Lighting), the world's own, drawn once, and the players',
 * every frame, so the world is in its own shadows and the players'.
 */
const DIR_LIVE = directionalPastEveryShadow('bakedSunSeen', '1.0');

/** The indirect light starts at nothing: the bake (added in the maps chunk) replaces it. */
const INDIRECT_BAKED = /* glsl */ `#if defined( RE_IndirectDiffuse )

	vec3 iblIrradiance = vec3( 0.0 );

	// CS2's baked light replaces the ambient, probe and hemisphere light.
	vec3 irradiance = vec3( 0.0 );

#endif

`;

/** `lights_fragment_begin` for a sun in mode `mode`, built once per mode from three's. */
const beginChunks = new Map<SunMode, string>();
function bakedLightsBegin(mode: SunMode): string {
  let chunk = beginChunks.get(mode);
  if (chunk) return chunk;
  const sun = mode === 'live' ? DIR_LIVE : mode === 'baked' ? DIR_IN_BAKE : '';
  chunk = lightsBegin(sun, INDIRECT_BAKED);
  beginChunks.set(mode, chunk);
  return chunk;
}

let lightmapMaps: string | null = null;
/** `lights_fragment_maps` with the lightmap decoded (`LIGHTMAP_DECODE`). */
function lightsMapsDecoded(): string {
  if (lightmapMaps) return lightmapMaps;
  lightmapMaps = replaceOnce(
    THREE.ShaderChunk.lights_fragment_maps,
    LIGHTMAP_LINE,
    `vec3 lightMapIrradiance = ${LIGHTMAP_DECODE} * lightMapIntensity;`
  );
  return lightmapMaps;
}

/** The hook of `b` for `source`, made once and shared (with its uniform) by every material. */
const hooks = new WeakMap<Baked, Partial<Record<BakedSource, ShaderHook>>>();

function hookFor(b: Baked, source: BakedSource): ShaderHook {
  let mine = hooks.get(b);
  if (!mine) hooks.set(b, (mine = {}));
  const had = mine[source];
  if (had) return had;
  const mode = sunModeOf(b.info);
  const bakedRange = { value: b.info.range };
  const shade =
    mode === 'baked'
      ? `
#if defined( RE_IndirectDiffuse )
	irradiance *= bakedShade;
#endif`
      : '';
  const hook: ShaderHook = {
    key: `baked-${source}-sun${mode}`,
    edit(shader) {
      shader.uniforms.bakedRange = bakedRange;
      let f = shader.fragmentShader;
      f = replaceOnce(
        f,
        '#include <lights_fragment_begin>',
        bakedLightsBegin(mode)
      );
      if (source === 'lightmap') {
        f = replaceOnce(
          f,
          '#include <common>',
          '#include <common>\nuniform float bakedRange;'
        );
        f = replaceOnce(
          f,
          '#include <lights_fragment_maps>',
          lightsMapsDecoded() + shade
        );
      } else {
        f = replaceOnce(
          f,
          '#include <common>',
          '#include <common>\nvarying vec3 vBakedLight;'
        );
        f = replaceOnce(
          f,
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
#if defined( RE_IndirectDiffuse )
	irradiance += vBakedLight * PI;
#endif${shade}`
        );
        let v = shader.vertexShader;
        v = replaceOnce(
          v,
          '#include <common>',
          `#include <common>
uniform float bakedRange;
varying vec3 vBakedLight;
#if !defined( USE_COLOR ) && !defined( USE_COLOR_ALPHA )
attribute vec4 color;
#endif`
        );
        v = replaceOnce(
          v,
          '#include <color_vertex>',
          `#include <color_vertex>\n${VERTEX_LIGHT_DECODE}`
        );
        shader.vertexShader = v;
      }
      shader.fragmentShader = f;
    },
  };
  mine[source] = hook;
  return hook;
}

/**
 * Lights world material `m` with `b`: from the lightmap (`m` must be drawn on geometry with
 * `uv1`, and `b` must have one) or from the light in COLOR_0 (`vertex`; COLOR_0 is then never
 * the diffuse colour). Idempotent; composes with the material's other shader hooks.
 */
export function attachBaked(
  m: THREE.MeshLambertMaterial,
  b: Baked,
  source: BakedSource
): void {
  m.vertexColors = false;
  if (source === 'lightmap') {
    if (!b.lightmap) throw new Error('attachBaked: the bake has no lightmap');
    m.lightMap = b.lightmap;
    m.lightMapIntensity = LIGHTMAP_INTENSITY;
  } else m.lightMap = null;
  attachHook(m, 'baked', hookFor(b, source));
}
