// The shader edits the viewer makes to three's built-in materials (the detail texture, the
// foliage normal, CS2's baked light, the light grid on the players, the outlines' rim), composed,
// each failing loudly where three.js moved what it edits (`replaceOnce`): a material has
// one `onBeforeCompile` that runs every edit attached to it, in the order they were attached,
// and one program cache key that names them all. three keeps one of each per material, so two
// edits that set their own would leave only the last.

import * as THREE from 'three';

/** What the renderer hands `onBeforeCompile`: a fresh copy of the material's source. */
export type ShaderSource = Parameters<THREE.Material['onBeforeCompile']>[0];

export interface ShaderHook {
  /**
   * Names the edit in the program cache key: two hooks that edit the source differently must
   * have different keys. Uniform values may differ under one key.
   */
  readonly key: string;
  /**
   * Edits `shader`'s source and adds its uniforms; it runs on clean source every compile of
   * `material`. three compiles a material once per program key and keeps the uniforms it was
   * given then, so a uniform whose value changes must be read through the object made here.
   */
  edit(shader: ShaderSource, material: THREE.Material): void;
}

/** Every material's hooks by slot, in the order they were first attached. */
const hooksOf = new WeakMap<THREE.Material, Map<string, ShaderHook>>();

/**
 * Attaches `hook` to `material` in `slot`, replacing what that slot held (so attaching again is
 * idempotent), and keeps every other slot's edit. The material recompiles on its next draw.
 */
export function attachHook(
  material: THREE.Material,
  slot: string,
  hook: ShaderHook
): void {
  let hooks = hooksOf.get(material);
  if (!hooks) {
    const all = new Map<string, ShaderHook>();
    hooks = all;
    hooksOf.set(material, all);
    material.onBeforeCompile = (shader) => {
      for (const h of all.values()) h.edit(shader, material);
    };
    material.customProgramCacheKey = () =>
      `demoviewer-${[...all.values()].map((h) => h.key).join('+')}`;
  }
  hooks.set(slot, hook);
  material.needsUpdate = true;
}

/**
 * Takes the hook in `slot` off `material`, keeping the others; with none left the material is
 * plain again (three's own `onBeforeCompile` and program key). The material recompiles on its
 * next draw. A slot that holds nothing changes nothing.
 */
export function detachHook(material: THREE.Material, slot: string): void {
  const hooks = hooksOf.get(material);
  if (!hooks?.delete(slot)) return;
  if (hooks.size === 0) {
    hooksOf.delete(material);
    const own = material as Partial<
      Pick<THREE.Material, 'onBeforeCompile' | 'customProgramCacheKey'>
    >;
    delete own.onBeforeCompile;
    delete own.customProgramCacheKey;
  }
  material.needsUpdate = true;
}

/** The hook in `material`'s `slot`, if one was attached. */
export function hookIn(
  material: THREE.Material,
  slot: string
): ShaderHook | undefined {
  return hooksOf.get(material)?.get(slot);
}

/**
 * `source` with `include` (an `#include <…>` line, which must be there exactly once) replaced
 * by `by`. Throws otherwise: a three.js upgrade that moved the chunk must fail loudly, not
 * draw the material without the edit.
 */
export function replaceOnce(
  source: string,
  include: string,
  by: string
): string {
  const at = source.indexOf(include);
  if (at < 0 || source.indexOf(include, at + include.length) >= 0)
    throw new Error(`shader hook: expected one ${include}`);
  return source.slice(0, at) + by + source.slice(at + include.length);
}

// The light chunk of three's lit materials, cut at the blocks the viewer replaces. Each marker
// must be there once and in this order: a three.js upgrade that moved one fails loudly.
const DIR = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
const RECT =
  '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
const INDIRECT = '#if defined( RE_IndirectDiffuse )';
const SPECULAR = '#if defined( RE_IndirectSpecular )';

/**
 * three's `lights_fragment_begin` with its directional-light block (the sun's, shadows
 * included) replaced by `directional` and its indirect-diffuse block (ambient, light probe and
 * hemisphere light) by `indirect`, which must declare `irradiance` (and `iblIrradiance`) under
 * `RE_IndirectDiffuse` as three's does. Point, spot and rect-area lights are three's own.
 */
export function lightsBegin(directional: string, indirect: string): string {
  const src = THREE.ShaderChunk.lights_fragment_begin;
  const at = [DIR, RECT, INDIRECT, SPECULAR].map((m) => {
    const i = src.indexOf(m);
    if (i < 0 || src.indexOf(m, i + 1) >= 0)
      throw new Error(
        `shader hook: expected one ${m} in lights_fragment_begin`
      );
    return i;
  });
  if (!at.every((v, i) => i === 0 || v > at[i - 1]))
    throw new Error('shader hook: lights_fragment_begin is out of order');
  const [dir, rect, indirectAt, specular] = at;
  return (
    src.slice(0, dir) +
    directional +
    src.slice(rect, indirectAt) +
    indirect +
    src.slice(specular)
  );
}

/**
 * A directional-light block for `lightsBegin` that darkens every directional light by every
 * directional shadow map at once: their product, in the float `seen`, or `unshadowed` (a GLSL
 * float expression) without a shadow map. Where the sun's shadow is split in two maps of the
 * same box (lighting.ts: the world's, drawn once, and the players', every frame), what the sun
 * lights must be past both; the players' map's own light is black, so it adds nothing itself.
 */
export function directionalPastEveryShadow(
  seen: string,
  unshadowed: string
): string {
  return /* glsl */ `#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )

	float ${seen} = ${unshadowed};
	#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
	${seen} = 1.0;
	DirectionalLightShadow directionalLightShadow;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
		directionalLightShadow = directionalLightShadows[ i ];
		${seen} *= receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
	}
	#pragma unroll_loop_end
	#endif

	DirectionalLight directionalLight;
	#pragma unroll_loop_start
	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];
		getDirectionalLightInfo( directionalLight, directLight );
		directLight.color *= ${seen};
		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end

#endif

`;
}
