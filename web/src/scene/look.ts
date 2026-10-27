// The look of a loaded scene, set at load and again whenever the quality changes: every
// material becomes a lit Lambert or an unlit Basic one that keeps the texture, base colour,
// alpha mode and baked AO (COLOR_0); lit meshes without normals get smooth ones computed;
// alpha-tested cutouts are drawn from both sides, lit ones with their front normal bent
// towards the sky; textures get anisotropic filtering; opaque
// materials get the tiling detail texture when there is one; and lights that came with the
// file are removed, the scene's own light the map. A map with CS2's bake (baked.ts) dresses its
// world in it at every preset: a Lambert lit by the lightmap where the mesh has the lightmap UV
// (`uv1`), by the light in COLOR_0 where it has that instead, without the detail texture. CS2's
// glass is see-through (`GLASS`).

import * as THREE from 'three';
import { attachBaked, type Baked, type BakedSource } from './baked';
import { attachDetail } from './detail';
import { attachHook, replaceOnce } from './hooks';
import { needsUpload } from './images';

export interface LookOptions {
  /** Lambert materials, lit by the scene's lights, instead of unlit Basic ones. */
  lit: boolean;
  /**
   * Lit meshes without normals get smooth ones computed from their welded geometry; off,
   * they are flat-shaded from screen-space derivatives instead. Ignored when unlit.
   */
  smoothNormals: boolean;
  /** The texture anisotropy, capped at `MAX_ANISOTROPY`; 1 is plain trilinear filtering. */
  maxAnisotropy: number;
  /**
   * The tiling detail texture (detail.ts), multiplied into the opaque materials `applyLook`
   * makes: not cutouts, not blended ones, not those the bake lights (its light has the real
   * variation), and never the players' (`materialFor` alone).
   */
  detail?: THREE.Texture;
  /**
   * The map's bake: `applyLook` lights the world from it at every preset, `lit` or not, in
   * place of the sky light (and the sun, where the sun is in it). `materialFor` alone (the
   * players', the weapons') ignores it.
   */
  baked?: Baked;
}

export type LookMaterial = THREE.MeshLambertMaterial | THREE.MeshBasicMaterial;

/** Anisotropic filtering past 8x costs fill rate for no visible gain on these textures. */
export const MAX_ANISOTROPY = 8;

/**
 * CS2's glass: every material of the `csgo_glass.vfx` shader (the vmat in the glTF's extras,
 * which GLTFLoader puts in `userData`) exports from VRF as BLEND with base alpha 1 and no
 * texture, so it drew opaque white or beige: windows (Mirage's before it breaks, Nuke's) and
 * the static glass of most maps. `materialFor` draws it this see-through (`opacity`), frosted
 * glass less so (`frosted`: its vmat is named so, as Nuke's `hr_glass_frosted_004`, which CS2
 * draws as milky panes no one sees through), without depth writes, tinted by its
 * `GlassTintColor` (an sRGB colour) where it has one.
 */
export const GLASS = Object.freeze({
  shader: 'csgo_glass.vfx',
  opacity: 0.3,
  frosted: 0.7,
});

/** The glTF extras' vmat of a material, as far as the look reads it. */
interface Vmat {
  Name?: unknown;
  ShaderName?: unknown;
  VectorParams?: { GlassTintColor?: unknown };
}

/** Glass `m`'s opacity: frosted glass (its vmat's name says so) lets less through. */
function glassOpacity(m: THREE.Material): number {
  const name = (m.userData.vmat as Vmat | undefined)?.Name;
  return /frosted/i.test(typeof name === 'string' ? name : m.name)
    ? GLASS.frosted
    : GLASS.opacity;
}

/** Whether `m` (a loader's material or a look material, which keeps its extras) is CS2's glass. */
function isGlass(m: THREE.Material): boolean {
  return (m.userData.vmat as Vmat | undefined)?.ShaderName === GLASS.shader;
}

/** Glass `m`'s tint, linear, or null without a valid one. */
function glassTint(m: THREE.Material): THREE.Color | null {
  const t = (m.userData.vmat as Vmat | undefined)?.VectorParams?.GlassTintColor;
  if (
    !Array.isArray(t) ||
    t.length < 3 ||
    !t.slice(0, 3).every((v) => typeof v === 'number' && Number.isFinite(v))
  )
    return null;
  return new THREE.Color().setRGB(t[0], t[1], t[2], THREE.SRGBColorSpace);
}

/** The glass materials `materialFor` made, whose colour already holds their tint. */
const tinted = new WeakSet<THREE.Material>();

/** Phase 3's look: unlit, nothing computed, plain filtering. */
export const UNLIT_LOOK: Readonly<LookOptions> = {
  lit: false,
  smoothNormals: false,
  maxAnisotropy: 1,
};

/** Whether two looks dress a world the same way. */
export function sameLook(a: LookOptions, b: LookOptions): boolean {
  return (
    a.lit === b.lit &&
    a.smoothNormals === b.smoothNormals &&
    a.maxAnisotropy === b.maxAnisotropy &&
    a.detail === b.detail &&
    a.baked === b.baked
  );
}

/**
 * The material `src` is drawn with under look `o`, on geometry that has COLOR_0 when
 * `hasColor`. A new material that shares `src`'s textures and keeps a copy of its `userData`
 * (the glTF's extras); `src` is left as it is. CS2's glass is drawn see-through (`GLASS`).
 */
export function materialFor(
  src: THREE.Material,
  o: LookOptions & { hasColor: boolean }
): LookMaterial {
  // Any of the loader's materials, or a look material from an earlier call.
  const s = src as THREE.Material & {
    map?: THREE.Texture | null;
    color?: THREE.Color;
  };
  const cutout = s.alphaTest > 0;
  const glass = isGlass(s);
  const color = s.color ? s.color.clone() : new THREE.Color(0xffffff);
  const tint = glass && !tinted.has(s) ? glassTint(s) : null;
  if (tint) color.multiply(tint);
  const params = {
    name: s.name,
    map: s.map ?? null,
    color,
    vertexColors: o.hasColor,
    // glTF's doubleSided (foliage, fences, cloth) stays visible from behind, and so does any
    // cutout: the source maps often leave alpha-tested cards single-sided.
    side:
      cutout || s.side === THREE.DoubleSide
        ? THREE.DoubleSide
        : THREE.FrontSide,
    transparent: glass || s.transparent,
    opacity: glass ? glassOpacity(s) : s.opacity,
    alphaTest: s.alphaTest,
    depthWrite: glass ? false : s.depthWrite,
  };
  const m = o.lit
    ? new THREE.MeshLambertMaterial({
        ...params,
        flatShading: !o.smoothNormals,
      })
    : new THREE.MeshBasicMaterial(params);
  // The extras ride along (a copy of their own), so the next look (a preset change) finds the
  // glass again.
  m.userData = { ...s.userData };
  if (glass) tinted.add(m);
  return m;
}

/**
 * Lit cutouts (leaves, ivy, grass cards) shade both sides with the front face's normal, bent
 * towards the sky. three.js turns a back face's normal around, so a leaf seen from below
 * faced the ground and took the sky light's dark ground colour: near-black foliage. Flat
 * shading's normal faces the camera, and `faceDirection` turns it to the front face too.
 */
const FOLIAGE_NORMAL = `#include <normal_fragment_begin>
#ifdef DOUBLE_SIDED
  normal *= faceDirection;
#endif
normal = normalize(normal + 0.6 * (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);`;

/** Gives lit cutout `m` the foliage normal; cutouts never get the detail hook. */
function attachFoliage(m: THREE.MeshLambertMaterial): void {
  attachHook(m, 'foliage', {
    key: 'foliage',
    edit(shader) {
      shader.fragmentShader = replaceOnce(
        shader.fragmentShader,
        '#include <normal_fragment_begin>',
        FOLIAGE_NORMAL
      );
    },
  });
}

/**
 * Which of a world geometry's attributes carries `b`'s light: the lightmap UV when the bake
 * has a lightmap, else COLOR_0; null for neither, which keeps today's material.
 */
function bakedSourceOf(
  b: Baked,
  hasUv1: boolean,
  hasColor: boolean
): BakedSource | null {
  if (hasUv1 && b.lightmap) return 'lightmap';
  return hasColor ? 'vertex' : null;
}

/**
 * Replaces the zero-length normals `computeVertexNormals` leaves where faces cancel at a
 * shared vertex (back-to-back faces) or are degenerate with straight up: the shader's
 * `normalize` turns a zero normal into NaN, and bloom spreads one NaN pixel over the frame.
 * Returns how many it replaced.
 */
export function fillZeroNormals(geo: THREE.BufferGeometry): number {
  const n = geo.getAttribute('normal');
  if (!n) return 0;
  let filled = 0;
  for (let i = 0; i < n.count; i++) {
    const x = n.getX(i);
    const y = n.getY(i);
    const z = n.getZ(i);
    if (x * x + y * y + z * z < 1e-12) {
      n.setXYZ(i, 0, 1, 0);
      filled++;
    }
  }
  if (filled) n.needsUpdate = true;
  return filled;
}

/**
 * Sets `t`'s anisotropy to `n` (capped), marking it for re-upload only when it changes: a texture
 * whose decoded image was released (images.ts) is uploaded again once its image is back.
 */
export function setAnisotropy(t: THREE.Texture, n: number): void {
  const a = Math.max(1, Math.min(MAX_ANISOTROPY, Math.floor(n) || 1));
  if (t.anisotropy === a) return;
  t.anisotropy = a;
  needsUpload(t);
}

/**
 * Dresses, one mesh at a time, a model the caller cloned (a player rig, the first-person arms,
 * a weapon) in look `o`: each of the mesh's materials is replaced by the one `materialFor`
 * makes, once per source material, COLOR_0 presence and normals presence (shared by the meshes
 * that shared it), smooth where the geometry has normals and flat where it has none, its
 * texture at the look's anisotropy. The materials made are pushed to `out`, for the caller to
 * tint and free; the source materials stay as they are (the template's, shared by every clone).
 */
export function modelDresser(
  o: LookOptions,
  out: LookMaterial[]
): (mesh: THREE.Mesh) => void {
  const made = new Map<string, LookMaterial>();
  const convert = (src: THREE.Material, geo: THREE.BufferGeometry) => {
    const hasColor = geo.hasAttribute('color');
    const smoothNormals = geo.hasAttribute('normal');
    const key = `${src.uuid}:${hasColor}:${smoothNormals}`;
    let m = made.get(key);
    if (!m) {
      m = materialFor(src, { ...o, smoothNormals, hasColor });
      if (m.map) setAnisotropy(m.map, o.maxAnisotropy);
      made.set(key, m);
      out.push(m);
    }
    return m;
  };
  return (mesh) => {
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => convert(m, mesh.geometry))
      : convert(mesh.material, mesh.geometry);
  };
}

/**
 * Applies look `o` to every mesh under `root`: each material is replaced by
 * `materialFor` (one per source material, COLOR_0 presence and lightmap UV presence, shared
 * by the meshes that shared it), with `o.detail` attached to the opaque ones, and the replaced
 * materials are disposed, their textures kept, so `root` must own its materials. With
 * `o.baked`, a mesh with the lightmap UV or COLOR_0 gets a Lambert lit by the bake instead,
 * `lit` or not (flat-shaded when normals are not smooth) and without the detail texture; one
 * with neither keeps today's material. Normals are computed only for lit, smooth geometry that has none, so a model's
 * own normals (the players') are never touched. Lights under `root` are removed. Running it
 * again with other options switches the look in place.
 */
export function applyLook(
  root: THREE.Object3D,
  o: LookOptions
): { meshes: number; lightsRemoved: number; normalsComputed: number } {
  const lights: THREE.Object3D[] = [];
  const made = new Map<string, LookMaterial>();
  const replaced = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  let meshes = 0;
  let normalsComputed = 0;
  const convert = (src: THREE.Material, hasColor: boolean, hasUv1: boolean) => {
    const key = `${src.uuid}:${hasColor}:${hasUv1}`;
    let m = made.get(key);
    if (!m) {
      const source = o.baked ? bakedSourceOf(o.baked, hasUv1, hasColor) : null;
      const bakedLit = !!(o.baked && source);
      if (o.baked && source) {
        const lambert = materialFor(src, {
          ...o,
          lit: true,
          hasColor: false,
        }) as THREE.MeshLambertMaterial;
        attachBaked(lambert, o.baked, source);
        m = lambert;
      } else m = materialFor(src, { ...o, hasColor });
      // The bake's own light has the surface's real variation: the detail noise on top of it
      // reads as grain (Nuke's lobby walls, Mirage's palace), so what it lights goes without.
      if (o.detail && !bakedLit && !m.transparent && m.alphaTest === 0)
        attachDetail(m, o.detail);
      else if (m.alphaTest > 0 && m instanceof THREE.MeshLambertMaterial)
        attachFoliage(m);
      made.set(key, m);
      replaced.add(src);
      if (m.map) textures.add(m.map);
    }
    return m;
  };
  root.traverse((obj) => {
    if ((obj as THREE.Light).isLight) {
      lights.push(obj);
      return;
    }
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const geo = mesh.geometry;
    // Geometry shared between meshes is computed once: the second one finds the normals.
    if (o.lit && o.smoothNormals && !geo.hasAttribute('normal')) {
      geo.computeVertexNormals();
      fillZeroNormals(geo);
      normalsComputed++;
    }
    const hasColor = geo.hasAttribute('color');
    const hasUv1 = geo.hasAttribute('uv1');
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map((m) => convert(m, hasColor, hasUv1))
      : convert(mesh.material, hasColor, hasUv1);
  });
  for (const l of lights) l.removeFromParent();
  if (o.detail && made.size) textures.add(o.detail);
  for (const t of textures) setAnisotropy(t, o.maxAnisotropy);
  for (const m of replaced) m.dispose();
  return { meshes, lightsRemoved: lights.length, normalsComputed };
}
