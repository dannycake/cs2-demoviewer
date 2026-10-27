// GLB loading for the map, its collision hull and the player rigs, and the map's sky. Every
// GLB is meshopt-compressed and quantized (tools/README.md); the world carries no normals and,
// in COLOR_0, baked AO, or with CS2's bake (baked.ts) the light of the primitives that have no
// lightmap UV (TEXCOORD_1); it gets its materials and normals from the look (look.ts). Of a
// material's textures only the base colour's is decoded (the looks draw no other), and its
// decoded image is released once it is on the GPU (images.ts).

import * as THREE from 'three';
import {
  GLTFLoader,
  type GLTF,
  type GLTFLoaderPlugin,
  type GLTFParser,
} from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { surfaceOfNode } from '../audio/surfaces';
import { SURFACES, surfaceOf } from '../sim/surfaces';
import { trackImage } from './images';

export interface RigTemplate {
  /** The model as loaded; rigs are `SkeletonUtils.clone`s of it. */
  scene: THREE.Group;
  /** Every animation clip of the file by name (`run_n_rifle`, `shoot_ak`, ...). */
  clips: Map<string, THREE.AnimationClip>;
  /** Derived clips (`upper:<name>`, `additive:<name>`), made on first use and shared by every rig. */
  variants: Map<string, THREE.AnimationClip>;
}

/** A material's glTF texture slots no look draws (`materialFor` keeps the base colour's alone). */
interface GltfMaterialDef {
  normalTexture?: unknown;
  occlusionTexture?: unknown;
  emissiveTexture?: unknown;
  pbrMetallicRoughness?: { metallicRoughnessTexture?: unknown };
}

/**
 * Drops every material's normal, occlusion, emissive and metal-roughness textures from the file
 * before it is read, so GLTFLoader never decodes them: the looks draw a material's base colour
 * texture alone, and the others' images were decoded and held for nothing (on Nuke's world 345
 * of its 710 images, on the players 21 of their 31).
 */
class BaseColorOnly implements GLTFLoaderPlugin {
  readonly name = 'demoviewer_base_color_only';
  private readonly parser: GLTFParser;
  constructor(parser: GLTFParser) {
    this.parser = parser;
  }
  beforeRoot(): null {
    const json = this.parser.json as { materials?: GltfMaterialDef[] };
    for (const m of json.materials ?? []) {
      delete m.normalTexture;
      delete m.occlusionTexture;
      delete m.emissiveTexture;
      delete m.pbrMetallicRoughness?.metallicRoughnessTexture;
    }
    return null;
  }
}

export function makeGltfLoader(): GLTFLoader {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  loader.register((parser) => new BaseColorOnly(parser));
  return loader;
}

/**
 * The GLB at `url`, each texture's decoded image released after its upload and fetched again
 * from `url` when it is needed again (`trackImage`). Its textures are its own (`ownTextures`):
 * `disposeObject` frees them with it.
 */
export async function loadGltf(url: string): Promise<GLTF> {
  const gltf = await makeGltfLoader().loadAsync(url);
  trackImages(gltf, url);
  ownTextures(gltf.scene);
  return gltf;
}

/**
 * The textures a model owns, which `disposeObject` frees with it: the ones its GLB brought.
 * Its materials may also carry textures it only borrows, which outlive it: the bake's lightmap
 * (baked.ts) on a baked world's and its doors' materials is the bake's, kept across the
 * phone-tier swap and still drawn by the doors and the next world.
 */
const owned = new WeakSet<THREE.Texture>();

/** Makes every texture of `root`'s materials the model's own, for `disposeObject` to free. */
export function ownTextures(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const material of Array.isArray(m) ? m : [m])
      for (const v of Object.values(material))
        if (v instanceof THREE.Texture) owned.add(v);
  });
}

/** The glTF of a texture, as far as finding its image goes. */
interface GltfTextureDef {
  source?: number;
  extensions?: { EXT_texture_webp?: { source?: number } };
}

/**
 * Tracks the image of every texture of `gltf`'s materials (`trackImage`) that is in the GLB at
 * `url` itself (a buffer view of its binary chunk); any other keeps its image.
 */
function trackImages(gltf: GLTF, url: string): void {
  const json = gltf.parser.json as {
    textures?: GltfTextureDef[];
    images?: { bufferView?: number }[];
    bufferViews?: {
      buffer?: number;
      byteLength: number;
      extensions?: object;
    }[];
    buffers?: { uri?: string }[];
  };
  const seen = new Set<THREE.Texture>();
  gltf.scene.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const material of Array.isArray(m) ? m : [m])
      for (const v of Object.values(material)) {
        const t = v as THREE.Texture | null;
        if (!t?.isTexture || seen.has(t)) continue;
        seen.add(t);
        const def =
          json.textures?.[gltf.parser.associations.get(t)?.textures ?? -1];
        const image = def?.extensions?.EXT_texture_webp?.source ?? def?.source;
        const view =
          json.bufferViews?.[json.images?.[image ?? -1]?.bufferView ?? -1];
        if (
          image !== undefined &&
          view &&
          (view.buffer ?? 0) === 0 &&
          !view.extensions &&
          json.buffers?.[0]?.uri === undefined
        )
          trackImage(t, { url, image, bytes: view.byteLength });
      }
  });
}

/**
 * The map's world at `url` as the file has it, undressed: the scene dresses a new map's world
 * itself once its bake is in (`applyLook`), so it is dressed once.
 */
export async function loadWorld(url: string): Promise<THREE.Group> {
  return (await loadGltf(url)).scene;
}

/**
 * The map's collision hull as one indexed geometry in scene metres: every mesh of the file in
 * world space, indexed or not, each vertex with the surface of its collision group, for the
 * bullets and for the footsteps (`mergeMeshes`).
 */
export async function loadHull(url: string): Promise<THREE.BufferGeometry> {
  const gltf = await makeGltfLoader().loadAsync(url);
  const geometry = mergeMeshes(gltf.scene);
  disposeObject(gltf.scene);
  return geometry;
}

/**
 * The map's sky.webp (tools/sky.mjs): CS2's sky as a 2:1 equirect, sRGB, for
 * `scene.background`. Its rows are top-down, so three's default flipY puts the zenith at v = 1.
 * No mipmaps: the background samples it near 1:1, and the cube three.js makes from it takes
 * the same filters, so they would only cost GPU memory (a third more of each).
 */
export async function loadSky(url: string): Promise<THREE.Texture> {
  const texture = await new THREE.TextureLoader().loadAsync(url);
  texture.name = url;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  return texture;
}

export async function loadRigTemplate(url: string): Promise<RigTemplate> {
  return rigTemplateFromGltf(await loadGltf(url));
}

/** The template for a player model: its scene and every clip by name. */
export function rigTemplateFromGltf(gltf: GLTF): RigTemplate {
  const clips = new Map<string, THREE.AnimationClip>();
  for (const clip of gltf.animations)
    if (!clips.has(clip.name)) clips.set(clip.name, clip);
  return { scene: gltf.scene, clips, variants: new Map() };
}

/**
 * Every mesh under `root` in world space, as one indexed geometry of positions and, per vertex,
 * a `surface` (`Uint8`, an index into `SURFACES`), what a bullet meets: `surfaceOf` the name of
 * the mesh or of its nearest named ancestor (the hull's collision group); and a `surfaceName`
 * (`Uint16`, an index into `userData.surfaceNames`, whose 0 is `default`), the surface a player
 * stands on as the sounds manifest names it: `surfaceOfNode` of the mesh or of its nearest
 * ancestor that is a collision group, `default` when none is. A mesh without an index
 * contributes its vertices in order; a mirrored one's triangles are wound back, so every face
 * keeps facing out of its solid.
 */
export function mergeMeshes(root: THREE.Object3D): THREE.BufferGeometry {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
  });
  let verts = 0;
  let idx = 0;
  for (const m of meshes) {
    verts += m.geometry.attributes.position.count;
    idx += m.geometry.index?.count ?? m.geometry.attributes.position.count;
  }
  const pos = new Float32Array(verts * 3);
  const surface = new Uint8Array(verts);
  const surfaceName = new Uint16Array(verts);
  const surfaceNames = ['default'];
  const index = new Uint32Array(idx);
  const v = new THREE.Vector3();
  let vo = 0;
  let io = 0;
  for (const m of meshes) {
    const a = m.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      v.fromBufferAttribute(a, i).applyMatrix4(m.matrixWorld);
      v.toArray(pos, (vo + i) * 3);
    }
    const group = groupName(m);
    surface.fill(SURFACES.indexOf(surfaceOf(group)), vo, vo + a.count);
    const name = surfaceNameOf(m);
    let id = surfaceNames.indexOf(name);
    if (id < 0) id = surfaceNames.push(name) - 1;
    surfaceName.fill(id, vo, vo + a.count);
    const src = m.geometry.index;
    const n = src?.count ?? a.count;
    // A mirrored node (a negative determinant) turns its triangles inside out: wound back, they
    // face out of their solid again, as the hull's rays read them (`HullHit.leaving`).
    const flip = m.matrixWorld.determinant() < 0;
    for (let i = 0; i < n; i++) {
      // (a, b, c) → (a, c, b).
      const j = !flip ? i : i % 3 === 1 ? i + 1 : i % 3 === 2 ? i - 1 : i;
      index[io + i] = vo + (src ? src.getX(j) : j);
    }
    vo += a.count;
    io += n;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('surface', new THREE.BufferAttribute(surface, 1));
  g.setAttribute('surfaceName', new THREE.BufferAttribute(surfaceName, 1));
  g.userData.surfaceNames = surfaceNames;
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/** The name of `o` or of its nearest named ancestor (`nameOf`); empty when none has one. */
function groupName(o: THREE.Object3D): string {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const name = nameOf(p);
    if (name) return name;
  }
  return '';
}

/**
 * The surface (`surfaceOfNode`) of `o` or of its nearest ancestor that is a collision group,
 * past any named otherwise (a `mesh_3` in `physics_group_wood` is wood); `default` when none is.
 */
function surfaceNameOf(o: THREE.Object3D): string {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) {
    const surface = surfaceOfNode(nameOf(p));
    if (surface !== null) return surface;
  }
  return 'default';
}

/**
 * The name of `o` as the file has it. GLTFLoader makes a repeated name unique (Mirage's second
 * `physics_group_metal` is `physics_group_metal_1`) and keeps the file's in `userData.name`.
 */
function nameOf(o: THREE.Object3D): string {
  const name: unknown = o.userData.name;
  return typeof name === 'string' && name ? name : o.name;
}

/**
 * Frees the GPU resources of a loaded model: its geometries, its materials and the textures it
 * owns (`ownTextures`), not the ones it borrows (the bake's lightmap).
 */
export function disposeObject(root: THREE.Object3D): void {
  const textures = new Set<THREE.Texture>();
  const materials = new Set<THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material])
      materials.add(m);
  });
  for (const m of materials) {
    for (const v of Object.values(m))
      if (v instanceof THREE.Texture && owned.has(v)) textures.add(v);
    m.dispose();
  }
  for (const t of textures) t.dispose();
}
