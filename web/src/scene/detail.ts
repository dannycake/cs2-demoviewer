// The tiling detail texture: a 256² grey noise (`public/detail.png`, made at build time by
// `scripts/make-detail.mjs`) multiplied into the diffuse colour of opaque world materials, so
// the ripped maps' low-resolution textures do not smear into flat colour up close. It is
// projected from world space, tiled every `scale` metres along the three axes and blended by
// the surface's facing (triplanar), so it needs no UVs and lines up across meshes.

import * as THREE from 'three';
import { attachHook, replaceOnce } from './hooks';

export const DETAIL_URL = '/detail.png';
/** How much of the noise shows: 0 is none, 1 multiplies it in fully. */
export const DETAIL_STRENGTH = 0.35;
/** The line the hook adds to the fragment shader; the tests look for it. */
export const DETAIL_MULTIPLY = `diffuseColor.rgb *= mix(1.0, detail, ${DETAIL_STRENGTH.toFixed(2)});`;

interface DetailUniforms {
  detailMap: THREE.IUniform<THREE.Texture>;
  detailScale: THREE.IUniform<number>;
}

/** The detail uniforms of every material it is attached to; a material without has none. */
const attached = new WeakMap<THREE.Material, DetailUniforms>();

const VERTEX_DECL = /* glsl */ `#include <common>
varying vec3 vDetailPos;`;

// After project_vertex `transformed` is the skinned, morphed object-space position.
const VERTEX_MAIN = /* glsl */ `#include <project_vertex>
vec4 detailWorld = vec4(transformed, 1.0);
#ifdef USE_BATCHING
  detailWorld = batchingMatrix * detailWorld;
#endif
#ifdef USE_INSTANCING
  detailWorld = instanceMatrix * detailWorld;
#endif
vDetailPos = (modelMatrix * detailWorld).xyz;`;

const FRAGMENT_DECL = /* glsl */ `#include <common>
uniform sampler2D detailMap;
uniform float detailScale;
varying vec3 vDetailPos;`;

// The face's world normal from the position's screen derivatives, so it works on geometry
// without normals and on flat shading alike; a degenerate one falls back to the floor's.
// The noise averages mid-grey, so twice it averages one and far surfaces keep their colour.
const FRAGMENT_MAIN = /* glsl */ `#include <color_fragment>
{
  vec3 detailN = cross(dFdx(vDetailPos), dFdy(vDetailPos));
  float detailL = dot(detailN, detailN);
  detailN = detailL > 0.0 ? abs(detailN) * inversesqrt(detailL) : vec3(0.0, 1.0, 0.0);
  detailN *= detailN;
  detailN *= detailN;
  detailN /= detailN.x + detailN.y + detailN.z;
  vec3 detailP = vDetailPos / detailScale;
  float detail = 2.0 * (
    texture2D(detailMap, detailP.zy).r * detailN.x +
    texture2D(detailMap, detailP.xz).r * detailN.y +
    texture2D(detailMap, detailP.xy).r * detailN.z);
  ${DETAIL_MULTIPLY}
}`;

/**
 * Multiplies the detail texture `tex`, tiled every `scale` metres in world space, into the
 * diffuse colour of `material` (a Lambert or Basic one, or any built-in material with
 * `color_fragment`), beside the material's other shader hooks (hooks.ts). Idempotent:
 * attaching again only changes the texture and scale.
 */
export function attachDetail(
  material: THREE.Material,
  tex: THREE.Texture,
  scale = 1.5
): void {
  const had = attached.get(material);
  if (had) {
    had.detailMap.value = tex;
    had.detailScale.value = scale;
    return;
  }
  const uniforms: DetailUniforms = {
    detailMap: { value: tex },
    detailScale: { value: scale },
  };
  attached.set(material, uniforms);
  // The renderer hands a fresh copy of the material's source to every compile.
  attachHook(material, 'detail', {
    key: 'detail',
    edit(shader) {
      Object.assign(shader.uniforms, uniforms);
      let v = replaceOnce(
        shader.vertexShader,
        '#include <common>',
        VERTEX_DECL
      );
      v = replaceOnce(v, '#include <project_vertex>', VERTEX_MAIN);
      shader.vertexShader = v;
      let f = replaceOnce(
        shader.fragmentShader,
        '#include <common>',
        FRAGMENT_DECL
      );
      f = replaceOnce(f, '#include <color_fragment>', FRAGMENT_MAIN);
      shader.fragmentShader = f;
    },
  });
}

/** Whether `attachDetail` ran on `material`. */
export function hasDetail(material: THREE.Material): boolean {
  return attached.has(material);
}

/**
 * Loads the detail texture: repeating, mipmapped and read as data (no colour conversion);
 * the look gives it the map textures' anisotropy. Null when it cannot be had: the maps then
 * go without.
 */
export async function loadDetailTexture(
  url = DETAIL_URL
): Promise<THREE.Texture | null> {
  try {
    const tex = await new THREE.TextureLoader().loadAsync(url);
    tex.name = 'detail';
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    return tex;
  } catch (e) {
    console.warn(`detail texture ${url}:`, e);
    return null;
  }
}
