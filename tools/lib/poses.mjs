// Skinned props in the pose the game draws them in. VRF's world export writes a skinned model's
// vertices in the bind space of its skeleton and drops the skeleton: the primitives keep
// JOINTS_0/WEIGHTS_0, and no node has a skin. The game never draws the bind pose. It draws the
// model posed by the animation its entity plays: a prop_dynamic's starting or idle animation,
// otherwise the model's default sequence (a door's `ref`). For most props the two poses agree.
// For some, the bind pose holds a turn the animation does not: Overpass's door
// (props_downtown/metal_door_112) lies flat, with its 2.8 m height along the floor. Nuke's four
// doors (metal_door_001_br) stand a quarter turn out of their doorways. The fans, a safety
// ribbon, a crane's load and a cloth face the wrong way.
//
// raw/<map>/model-poses.json (written beside the rip by tools/model-poses.sh; Valve-derived, so
// never in git) holds, for every model that map's world draws skinned, the skinning matrix of
// each joint its vertices use in the first frame of that animation (`pose`), null where the drawn
// pose is the exported one, or the `error` that kept model-poses from working it out.
// shrink-map.mjs applies it to the geometry with poseSkinnedProps, so no skin ships.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';

/** The pose table's name in a map's raw folder. */
export const MODEL_POSES_FILE = 'model-poses.json';

/**
 * A map's pose table, `{ map, cs2Build, vrfVersion, models: { <model>: { vmdl, entities, anim,
 * pose } | { vmdl, entities, error } } }`, from `rawDir` (assets/raw/<map>/), or null without one.
 */
export function readModelPoses(rawDir) {
  const file = path.join(rawDir, MODEL_POSES_FILE);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * Why `map`'s pose table does not belong to `rip` (raw/<map>/rip.json, null without one): another
 * CS2 build or VRF version exported its models than the world. Null when it belongs. The message
 * ends with what makes the two agree, whichever is the older: rip-map.sh re-exports a rip from
 * another CS2 build (or none) by itself, but after a VRF-only upgrade it skips the rip, which
 * still has the install's build, so only `--force` re-exports it; model-poses.sh then follows the
 * rip (a re-rip removes the table).
 */
export function staleModelPoses(table, rip, map) {
  const rerip = (force) => `; run tools/rip-map.sh ${map}${force ? ' --force' : ''}, then tools/model-poses.sh ${map}`;
  if (!rip) return `there is no rip.json beside ${MODEL_POSES_FILE}${rerip(false)}`;
  if (table.cs2Build !== rip.cs2Build) return `${MODEL_POSES_FILE} is from CS2 build ${table.cs2Build}, the rip from ${rip.cs2Build}${rerip(false)}`;
  if (table.vrfVersion !== rip.vrfVersion) return `${MODEL_POSES_FILE} is from VRF ${table.vrfVersion}, the rip from ${rip.vrfVersion}${rerip(true)}`;
  return null;
}

const JOINTS = /^JOINTS_(\d+)$/;

/** The model a VRF world node draws: its name up to the first dot (`<model>.<mesh>`). */
export const modelOf = (node) => node.getName().split('.')[0];

/** The node's local matrix: its TRS with `over` (`{ translation?, rotation?, scale? }`) in place. */
function localMatrix(node, over = {}) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...(over.translation ?? node.getTranslation())),
    new THREE.Quaternion(...(over.rotation ?? node.getRotation())),
    new THREE.Vector3(...(over.scale ?? node.getScale())),
  );
}

/** The node's world matrix, every node on its path posed by `pose` (Map node → TRS overrides). */
function posedWorld(node, pose) {
  const m = localMatrix(node, pose.get(node));
  for (let p = node.getParentNode(); p; p = p.getParentNode()) m.premultiply(localMatrix(p, pose.get(p)));
  return m;
}

/**
 * The skinning matrix of each joint of a skinned model (the first skin, drawn by its first
 * skinned node) in the first frame of animation `anim`, or of the first animation:
 * inverse(mesh node's world) × the joint's world matrix in that frame × its inverse bind matrix.
 * It takes a vertex from where the export put it (the bind pose) to where that frame puts it.
 * A bone the animation has no channel for keeps its bind transform.
 * @param {import('@gltf-transform/core').Document} doc a model as Source2Viewer-CLI exports it
 *   with --gltf_export_animations
 * @returns {{ anim: string, joints: Map<number, number[]> }} column-major 4×4 per joint index
 */
export function animationPose(doc, anim) {
  const root = doc.getRoot();
  const skin = root.listSkins()[0];
  if (!skin) throw new Error('the model has no skin');
  const clip = anim ? root.listAnimations().find((a) => a.getName() === anim) : root.listAnimations()[0];
  if (!clip) throw new Error(anim ? `the model has no animation "${anim}"` : 'the model has no animation');
  const pose = new Map();
  for (const ch of clip.listChannels()) {
    const node = ch.getTargetNode(), target = ch.getTargetPath(), sampler = ch.getSampler(), out = sampler?.getOutput();
    if (!node || !out || !['translation', 'rotation', 'scale'].includes(target)) continue;
    // A CUBICSPLINE output holds in-tangent, value, out-tangent per key: the value is element 1.
    const cubic = sampler.getInterpolation() === 'CUBICSPLINE';
    if (cubic && out.getCount() < 3) throw new Error(`${clip.getName()}: a CUBICSPLINE ${target} output of ${out.getCount()} element(s) has no value for its first key`);
    pose.set(node, { ...pose.get(node), [target]: out.getElement(cubic ? 1 : 0, []) });
  }
  const mesh = root.listNodes().find((n) => n.getSkin() === skin);
  const meshInverse = mesh ? new THREE.Matrix4().fromArray(mesh.getWorldMatrix()).invert() : new THREE.Matrix4();
  const ibm = skin.getInverseBindMatrices();
  const joints = new Map();
  skin.listJoints().forEach((joint, i) => {
    const bind = ibm ? new THREE.Matrix4().fromArray(ibm.getElement(i, [])) : new THREE.Matrix4();
    joints.set(i, meshInverse.clone().multiply(posedWorld(joint, pose)).multiply(bind).toArray());
  });
  return { anim: clip.getName(), joints };
}

/** Each JOINTS_n/WEIGHTS_n pair of a primitive, as `[joints, weights]` accessors. */
function influences(prim) {
  const out = [];
  for (const s of prim.listSemantics()) {
    const n = JOINTS.exec(s)?.[1];
    const w = n !== undefined && prim.getAttribute(`WEIGHTS_${n}`);
    if (w) out.push([prim.getAttribute(s), w]);
  }
  return out;
}

/** The joint indices some vertex of the document weighs above zero. */
export function usedJoints(doc) {
  const used = new Set();
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const [j, w] of influences(prim)) {
        const jv = [], wv = [];
        for (let i = 0; i < j.getCount(); i++) {
          j.getElement(i, jv); w.getElement(i, wv);
          jv.forEach((joint, k) => { if (wv[k] > 0) used.add(joint); });
        }
      }
    }
  }
  return used;
}

/**
 * Moves the vertices of every skinless skinned mesh node of `doc` (a primitive with JOINTS_n and
 * WEIGHTS_n, a node without a skin) whose model `models` has a pose for into that pose: each
 * vertex by the blend of its joints' matrices by their weights; NORMAL and TANGENT turn with it.
 * A mesh several nodes draw moves once. Models with a null pose, or an error, are left as they are.
 * Throws on a vertex weighed on a joint the pose has no matrix for.
 * @param {import('@gltf-transform/core').Document} doc a VRF world export
 * @param {Record<string, { pose?: Record<string, number[]> | null, error?: string }>} models the
 *   pose table's `models`
 * @returns {{ posed: Record<string, number>, unknown: string[], errors: Record<string, string> }}
 *   the nodes posed per model, the skinned models `models` does not list (sorted), and the error
 *   of each drawn model `models` has one for
 */
export function poseSkinnedProps(doc, models) {
  const posed = {}, unknown = new Set(), errors = {}, done = new Set();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh || node.getSkin()) continue;
    const prims = mesh.listPrimitives().filter((p) => influences(p).length);
    if (!prims.length) continue;
    const model = modelOf(node);
    if (!Object.hasOwn(models, model)) { unknown.add(model); continue; }
    if (models[model].error) { errors[model] = models[model].error; continue; }
    const pose = models[model].pose;
    if (!pose) continue;
    posed[model] = (posed[model] ?? 0) + 1;
    for (const prim of prims) {
      const position = prim.getAttribute('POSITION');
      if (done.has(position)) continue;
      done.add(position);
      poseVertices(prim, pose, model);
    }
  }
  return { posed: Object.fromEntries(Object.entries(posed).sort()), unknown: [...unknown].sort(), errors };
}

/** One primitive's POSITION, NORMAL and TANGENT moved by its joints' blended `pose` matrices. */
function poseVertices(prim, pose, model) {
  const position = prim.getAttribute('POSITION'), normal = prim.getAttribute('NORMAL'), tangent = prim.getAttribute('TANGENT');
  const pairs = influences(prim);
  const m = new THREE.Matrix4(), n = new THREE.Matrix3(), v = new THREE.Vector3();
  const jv = [], wv = [], el = [];
  for (let i = 0; i < position.getCount(); i++) {
    m.elements.fill(0);
    for (const [j, w] of pairs) {
      j.getElement(i, jv); w.getElement(i, wv);
      jv.forEach((joint, k) => {
        if (!(wv[k] > 0)) return;
        const s = pose[joint];
        if (!s) throw new Error(`${model}: vertex ${i} is weighed on joint ${joint}, which its pose has no matrix for; rerun tools/model-poses.sh`);
        for (let e = 0; e < 16; e++) m.elements[e] += wv[k] * s[e];
      });
    }
    position.setElement(i, v.fromArray(position.getElement(i, el)).applyMatrix4(m).toArray());
    n.setFromMatrix4(m);
    if (normal) normal.setElement(i, v.fromArray(normal.getElement(i, el)).applyMatrix3(n).normalize().toArray());
    if (tangent) {
      const t = tangent.getElement(i, el);
      tangent.setElement(i, [...v.fromArray(t).applyMatrix3(n).normalize().toArray(), t[3]]);
    }
  }
}
