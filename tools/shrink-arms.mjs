#!/usr/bin/env node
// node tools/shrink-arms.mjs <ct|t|all>
//
// assets/raw/players/<rip.json models[side].glb>       (the agent, its `firstperson_*` meshes)
// + assets/raw/viewmodels/rifle/rifle_ak/idle_ak.glb   (the viewmodel skeleton)
//   → assets/viewmodels/arms_<side>.glb + .glb.gz + arms_<side>.shrink.json
//
// The agent export carries the first-person arms (`firstperson_default_gloves_arms`,
// `firstperson_sleeves`) skinned to the world skeleton, which the viewmodel clips do not move.
// They are moved onto the viewmodel skeleton by name (selectFirstPerson, reskinArms): the
// skeleton is copied from a clip export (lib/viewmodels.mjs copySkeleton), the meshes keep
// their joint order and inverse bind matrices, and a joint the viewmodel skeleton lacks (the
// twist bones; the unweighted spine, legs and jiggle bones) hangs from its nearest ancestor
// that it has, at its rest offset from it. Then: TANGENT and TEXCOORD_1+ stripped and every
// texture but the base colour dropped (the viewer's look draws only that) → dedup → prune →
// weld + simplify(0.5, 0.002) on a clone, kept only if lib/skin.mjs skinSurvives →
// textureCompress(WebP 256 px q80) → prune → meshopt(scene quantization) → a gzip -9 sibling.
// The written file is read back and must pass skinSurvives against the pre-simplify document.
// Files are written into assets/viewmodels/arms_<side>.tmp-<pid>/ and renamed beside it (lib/stage.mjs).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import * as THREE from 'three';
import { cloneDocument, dedup, meshopt, prune, simplify, textureCompress, weld } from '@gltf-transform/functions';
import { isMain } from './lib/cli.mjs';
import { createIO, countTris, MeshoptEncoder, MeshoptSimplifier } from './lib/gltf.mjs';
import { disposeClip, playerPaths, SIDES } from './lib/players.mjs';
import { skinSurvives } from './lib/skin.mjs';
import { staging } from './lib/stage.mjs';
import { fitTextures } from './lib/alpha.mjs';
import { armsPaths, copySkeleton, RIG_ROOT, viewmodelPaths } from './lib/viewmodels.mjs';

export const PARAMS = Object.freeze({
  steps: ['selectFirstPerson', 'copySkeleton', 'reskinArms', 'strip', 'dedup', 'prune', 'weld + simplify (if the skin survives)', 'textureCompress', 'prune', 'meshopt', 'gzip'],
  /** Any viewmodel clip export holds the whole skeleton; this one is always ripped. */
  skeletonFrom: 'ak47/idle',
  firstPerson: '\\.firstperson_',
  simplify: { ratio: 0.5, error: 0.002 },
  texture: { format: 'webp', size: 256, quality: 80 },
  // One quantization volume for both meshes: 'mesh' gives each its own corrected skin.
  meshopt: { level: 'high', quantizationVolume: 'scene' },
  gzip: { level: 9 },
});

const FIRST_PERSON = new RegExp(PARAMS.firstPerson);
const usage = 'usage: node tools/shrink-arms.mjs <ct|t|all>';

function fail(msg, code = 1) {
  console.error(`shrink-arms: ${msg}`);
  process.exit(code);
}

const parentOf = (n) => n.listParents().find((p) => p.propertyType === 'Node') ?? null;

function disposeTree(n) {
  for (const c of n.listChildren()) disposeTree(c);
  n.dispose();
}

/**
 * Keeps the first-person mesh nodes of an agent export, in place: every clip goes (with its
 * samplers), every other mesh node loses its mesh and skin (and a skin left unused goes).
 * Returns the kept nodes.
 */
export function selectFirstPerson(doc) {
  const root = doc.getRoot();
  for (const a of root.listAnimations()) disposeClip(a);
  const kept = root.listNodes().filter((n) => n.getMesh() && FIRST_PERSON.test(n.getName()));
  if (kept.length === 0) throw new Error('the agent export has no firstperson_* mesh');
  const skins = new Set();
  for (const n of root.listNodes()) {
    if (!n.getMesh() || kept.includes(n)) continue;
    if (n.getSkin()) skins.add(n.getSkin());
    n.setMesh(null).setSkin(null);
  }
  for (const s of skins) if (!s.listParents().some((p) => p.propertyType === 'Node')) s.dispose();
  return kept;
}

/**
 * Skins `meshNodes` (all with the same joint names) to `bones` (copySkeleton's) under `rigRoot`:
 * one skin, the old joint order and inverse bind matrices; a joint `bones` lacks is made, hung
 * from its nearest ancestor `bones` has (or the rig root) at its rest offset from it. Then
 * drops every scene node but the rig and the meshes, which move to the scene root unscaled.
 * Returns the joints made, as `<joint><-<parent>`.
 */
export function reskinArms(doc, meshNodes, rigRoot, bones) {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const old = meshNodes[0].getSkin();
  if (!old) throw new Error(`${meshNodes[0].getName()} has no skin`);
  const names = old.listJoints().map((j) => j.getName());
  for (const n of meshNodes) {
    const s = n.getSkin();
    if (!s || s.listJoints().map((j) => j.getName()).join() !== names.join()) throw new Error(`${n.getName()} is skinned to other joints than ${meshNodes[0].getName()}`);
  }
  const made = [];
  const world = (n) => new THREE.Matrix4().fromArray(n.getWorldMatrix());
  const skin = doc.createSkin('arms').setInverseBindMatrices(old.getInverseBindMatrices()).setSkeleton(rigRoot);
  for (const j of old.listJoints()) {
    let n = bones.get(j.getName());
    if (!n) {
      let p = parentOf(j);
      while (p && !bones.has(p.getName())) p = parentOf(p);
      const parent = p ? bones.get(p.getName()) : rigRoot;
      const local = p ? world(p).invert().multiply(world(j)) : world(j);
      const t = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      local.decompose(t, q, s);
      n = doc.createNode(j.getName()).setTranslation(t.toArray()).setRotation(q.toArray()).setScale(s.toArray());
      parent.addChild(n);
      bones.set(j.getName(), n);
      made.push(`${j.getName()}<-${p ? p.getName() : RIG_ROOT}`);
    }
    skin.addJoint(n);
  }
  const oldSkins = new Set(meshNodes.map((n) => n.getSkin()));
  for (const n of meshNodes) n.setSkin(skin);
  for (const s of oldSkins) s.dispose();
  const keep = new Set([rigRoot, ...meshNodes]);
  for (const n of [...scene.listChildren()]) if (!keep.has(n)) disposeTree(n);
  for (const n of meshNodes) {
    parentOf(n)?.removeChild(n);
    if (!scene.listChildren().includes(n)) scene.addChild(n);
    n.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
  }
  return made;
}

/**
 * What the viewer does not draw, in place: TANGENT and TEXCOORD_1+ of every primitive, and every
 * material texture but the base colour. Returns the attributes and textures dropped.
 */
export function stripUnseen(doc) {
  const attrs = new Set();
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives())
      for (const s of prim.listSemantics())
        if (s === 'TANGENT' || /^TEXCOORD_[1-9]/.test(s)) {
          prim.setAttribute(s, null);
          attrs.add(s);
        }
  let textures = 0;
  for (const m of doc.getRoot().listMaterials()) {
    for (const [get, set] of [['getNormalTexture', 'setNormalTexture'], ['getOcclusionTexture', 'setOcclusionTexture'], ['getMetallicRoughnessTexture', 'setMetallicRoughnessTexture'], ['getEmissiveTexture', 'setEmissiveTexture']]) {
      if (m[get]()) {
        m[set](null);
        textures++;
      }
    }
  }
  return { attributes: [...attrs].sort(), textures };
}

/** Shrinks one side's arms; returns its report. Throws on any failure. */
export async function shrinkArms(side, io, log = () => {}) {
  const PP = playerPaths(side);
  const P = armsPaths(side);
  const VP = viewmodelPaths('ak47');
  const t0 = performance.now();
  if (!fs.existsSync(PP.ripJson)) throw new Error(`${PP.ripJson} is missing; run tools/rip-players.sh`);
  if (!fs.existsSync(VP.ripJson)) throw new Error(`${VP.ripJson} is missing; run tools/rip-viewmodels.sh`);
  const rip = JSON.parse(fs.readFileSync(PP.ripJson, 'utf8'));
  const vrip = JSON.parse(fs.readFileSync(VP.ripJson, 'utf8'));
  const entry = rip.models?.[side];
  if (!entry?.glb) throw new Error(`${PP.ripJson} has no models.${side}.glb`);
  const skeletonFile = path.join(VP.dir, 'idle_ak.glb');
  if (!fs.existsSync(skeletonFile)) throw new Error(`${skeletonFile} is missing; run tools/rip-viewmodels.sh --force`);

  const doc = await io.read(path.join(PP.raw, entry.glb));
  const meshNodes = selectFirstPerson(doc);
  const trisIn = meshNodes.reduce((n, m) => n + m.getMesh().listPrimitives().reduce((k, p) => k + (p.getIndices()?.getCount() ?? 0) / 3, 0), 0);
  const { root: rigRoot, bones } = copySkeleton(doc, await io.read(skeletonFile));
  const skeletonBones = [...bones.keys()];
  const made = reskinArms(doc, meshNodes, rigRoot, bones);
  const stripped = stripUnseen(doc);
  await doc.transform(dedup(), prune());
  const trisKept = countTris(doc);
  const joints = doc.getRoot().listSkins()[0]?.listJoints().length ?? 0;

  let out = null;
  let simplified = false;
  const trial = cloneDocument(doc);
  try {
    await trial.transform(weld(), simplify({ simplifier: MeshoptSimplifier, ...PARAMS.simplify }));
    if (skinSurvives(doc, trial)) {
      out = trial;
      simplified = true;
    }
  } catch (e) {
    log(`simplify threw ${String(e?.message ?? e).split('\n')[0]}; kept unsimplified`);
  }
  out ??= cloneDocument(doc);
  // Fitted first, colour and alpha apart (lib/alpha.mjs), so textureCompress only encodes.
  await fitTextures(out, [PARAMS.texture.size, PARAMS.texture.size]);
  await out.transform(
    textureCompress({ encoder: sharp, targetFormat: PARAMS.texture.format, resize: [PARAMS.texture.size, PARAMS.texture.size], quality: PARAMS.texture.quality }),
    prune(),
    meshopt({ encoder: MeshoptEncoder, ...PARAMS.meshopt }),
  );
  const bytes = await io.writeBinary(out);
  const gz = zlib.gzipSync(bytes, PARAMS.gzip);
  const back = await io.readBinary(bytes);
  if (!skinSurvives(doc, back)) throw new Error('the written GLB fails skinSurvives against the re-skinned model');
  const backNames = new Set(back.getRoot().listNodes().map((n) => n.getName()));
  const lost = skeletonBones.filter((b) => !backNames.has(b));
  if (lost.length) throw new Error(`the written GLB lost skeleton bones ${lost.join(', ')}`);
  if (back.getRoot().listAnimations().length) throw new Error('the written GLB has clips');

  const report = {
    model: entry.vmdl, side, joints, skeletonBones: skeletonBones.length, made,
    trisIn, trisKept, trisOut: countTris(back), simplified, stripped,
    bytes: bytes.byteLength, gzBytes: gz.byteLength, textures: back.getRoot().listTextures().length,
    materials: back.getRoot().listMaterials().map((m) => m.getName()).sort(),
    raw: { glb: entry.glb, cs2Build: rip.cs2Build, vrfVersion: rip.vrfVersion, skeleton: path.relative(VP.raw, skeletonFile), viewmodelsBuild: vrip.cs2Build },
    seconds: +((performance.now() - t0) / 1000).toFixed(1),
    params: PARAMS,
  };

  const base = `arms_${side}`;
  const stage = staging(path.join(P.out, base));
  try {
    stage.write(`${base}.glb`, bytes);
    stage.write(`${base}.glb.gz`, gz);
    stage.write(`${base}.shrink.json`, JSON.stringify(report, null, 2) + '\n');
    stage.commit(P.out, [`${base}.glb`, `${base}.glb.gz`, `${base}.shrink.json`]);
  } finally {
    stage.abort();
  }
  log(`${base}: ${trisIn} → ${trisKept} → ${report.trisOut} tris (simplified ${simplified}), ${joints} joints (${made.length} hung), ${report.textures} textures, ${(bytes.byteLength / 1e3).toFixed(0)} KB (${(gz.byteLength / 1e3).toFixed(0)} KB gz), ${report.seconds}s`);
  return report;
}

async function main() {
  const arg = process.argv[2];
  if (!arg || process.argv.length > 3) fail(usage, 2);
  const sides = arg === 'all' ? SIDES : [arg];
  if (!sides.every((s) => SIDES.includes(s))) fail(usage, 2);
  const io = await createIO();
  for (const side of sides) {
    try {
      await shrinkArms(side, io, (m) => console.log(m));
    } catch (e) {
      if (process.env.DEBUG) console.error(e?.stack);
      fail(`${side}: ${String(e?.message ?? e).split('\n')[0]} (DEBUG=1 for the stack)`);
    }
  }
}

if (isMain(import.meta.url)) await main();
