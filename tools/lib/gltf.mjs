// Shared glTF plumbing for the Node scripts: one NodeIO with every extension and
// the meshopt codec registered, triangle counting, and the material audit that
// check-map.mjs (and later the player checks) run on finished GLBs.
import { Logger, NodeIO, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import { materialFails, vmatOf } from './filters.mjs';

export { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier };

/**
 * Warnings and errors only, each distinct message once: meshopt's quantize step
 * otherwise repeats "Skipping TEXCOORD_0; out of [0,1] range." for every
 * primitive with tiling UVs (320 lines on Mirage).
 */
class OnceLogger extends Logger {
  #seen = new Set();
  constructor() { super(Logger.Verbosity.WARN); }
  warn(text) {
    if (this.#seen.has(text)) return;
    this.#seen.add(text);
    super.warn(text);
  }
}

/**
 * NodeIO that reads and writes everything the pipeline produces (incl. EXT_meshopt_compression).
 * Documents it reads (and their clones) use OnceLogger, so scripts print their own stage lines.
 */
export async function createIO() {
  await Promise.all([MeshoptDecoder.ready, MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  return new NodeIO()
    .setLogger(new OnceLogger())
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
}

/** Triangles of one primitive (0 for points and lines). */
export function primitiveTris(prim) {
  const n = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
  switch (prim.getMode()) {
    case Primitive.Mode.TRIANGLES: return Math.floor(n / 3);
    case Primitive.Mode.TRIANGLE_STRIP:
    case Primitive.Mode.TRIANGLE_FAN: return Math.max(0, n - 2);
    default: return 0;
  }
}

/** Rendered triangles: every mesh node counts its mesh once, so instanced meshes count per instance. */
export function countTris(doc) {
  let tris = 0;
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) for (const p of mesh.listPrimitives()) tris += primitiveTris(p);
  }
  return tris;
}

/**
 * Materials that must not be shipped: `extras.vmat.Name` under materials/tools/ or
 * materials/dev/, or ShaderName in filters.mjs DROP_SHADERS (csgo_black_unlit.vfx,
 * csgo_effects.vfx), plus the ShaderName values of `map`'s filters.mjs PER_MAP entry
 * when a map is given (no map: the global rule only).
 * @returns {{ material: string, vmat: string, shader: string }[]}
 */
export function listMaterialsFailing(doc, map) {
  const out = [];
  for (const m of doc.getRoot().listMaterials()) {
    const { name, shader } = vmatOf(m);
    if (materialFails(name, shader, map)) out.push({ material: m.getName(), vmat: name, shader });
  }
  return out;
}

/**
 * Removes the named attributes from every primitive (JOINTS_n and WEIGHTS_n only from meshes no
 * skinned node draws); returns how many were removed.
 */
export function stripAttributes(doc, names) {
  const skinned = new Set(doc.getRoot().listNodes().filter((n) => n.getSkin()).map((n) => n.getMesh()));
  let removed = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const name of names) {
        if (skinned.has(mesh) && /^(JOINTS|WEIGHTS)_/.test(name)) continue;
        if (prim.getAttribute(name)) { prim.setAttribute(name, null); removed++; }
      }
    }
  }
  return removed;
}
