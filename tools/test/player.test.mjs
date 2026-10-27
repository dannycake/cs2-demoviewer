import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import { cloneDocument, prune } from '@gltf-transform/functions';
import { skinSurvives, clipNames } from '../lib/skin.mjs';
import {
  selectThirdPerson, stripBoneChannels, orphanSamplers, worldClipBases, clipBase, playerPaths, CLIPS_OPTIONAL, CLIPS_REQUIRED, CLIPS_REQUESTED, PLAYER_MODELS, SIDES, WORLD_CLIP_PREFIX,
} from '../lib/players.mjs';

// One skinned primitive (a quad, 4 vertices, each bound to its own joint), a skin
// over a 4-joint chain, and two animations that rotate the joints.
function rig(clips = ['walk_n_rifle', 'idle_rifle']) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);

  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0])))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 0, 2, 3])));
  const mesh = doc.createMesh('body').addPrimitive(prim);

  const joints = [0, 1, 2, 3].map((i) => doc.createNode(`joint${i}`).setTranslation([0, i === 0 ? 0 : 0.25, 0]));
  for (let i = 1; i < joints.length; i++) joints[i - 1].addChild(joints[i]);
  const ibm = new Float32Array(16 * 4);
  for (let i = 0; i < 4; i++) ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.25 * i, 0, 1], i * 16);
  const skin = doc.createSkin('skin').setSkeleton(joints[0]).setInverseBindMatrices(acc('MAT4', ibm));
  for (const j of joints) skin.addJoint(j);

  const body = doc.createNode('body').setMesh(mesh).setSkin(skin);
  doc.createScene('scene').addChild(joints[0]).addChild(body);

  // Names deliberately out of order, so clipNames has to sort.
  for (const name of clips) {
    const sampler = doc.createAnimationSampler()
      .setInput(acc('SCALAR', new Float32Array([0, 1])))
      .setOutput(acc('VEC4', new Float32Array([0, 0, 0, 1, 0, 0, 0.38268343, 0.9238795])))
      .setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(joints[1]).setTargetPath('rotation').setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel);
  }
  return { doc };
}

test('an untouched clone keeps the skin', () => {
  const { doc } = rig();
  expect(skinSurvives(doc, cloneDocument(doc))).toBe(true);
});

test('a skinned primitive that loses WEIGHTS_0 fails', () => {
  const { doc } = rig();
  const after = cloneDocument(doc);
  for (const m of after.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('WEIGHTS_0', null);
  expect(skinSurvives(doc, after)).toBe(false);
});

test('a skinned primitive that loses JOINTS_0 fails', () => {
  const { doc } = rig();
  const after = cloneDocument(doc);
  for (const m of after.getRoot().listMeshes()) for (const p of m.listPrimitives()) p.setAttribute('JOINTS_0', null);
  expect(skinSurvives(doc, after)).toBe(false);
});

test('a dropped animation fails', () => {
  const { doc } = rig();
  const after = cloneDocument(doc);
  after.getRoot().listAnimations().find((a) => a.getName() === 'idle_rifle').dispose();
  expect(skinSurvives(doc, after)).toBe(false);
});

test('a lost joint, a second skin or no skin fails', () => {
  const { doc } = rig();
  const lessJoints = cloneDocument(doc);
  const skin = lessJoints.getRoot().listSkins()[0];
  skin.removeJoint(skin.listJoints()[3]);
  expect(skinSurvives(doc, lessJoints)).toBe(false);

  const twoSkins = cloneDocument(doc);
  twoSkins.getRoot().listSkins()[0].clone();
  expect(skinSurvives(doc, twoSkins)).toBe(false);

  const noSkin = cloneDocument(doc);
  noSkin.getRoot().listSkins()[0].dispose();
  expect(skinSurvives(doc, noSkin)).toBe(false);
});

test('a skinned mesh node that loses its skin fails', () => {
  const { doc } = rig();
  const after = cloneDocument(doc);
  after.getRoot().listNodes().find((n) => n.getName() === 'body').setSkin(null);
  expect(skinSurvives(doc, after)).toBe(false);
});

test('clipNames returns the animation names sorted', () => {
  const { doc } = rig();
  expect(clipNames(doc)).toEqual(['idle_rifle', 'walk_n_rifle']);
});

// The rig as VRF exports an agent: third-person clips under animation/anims/world/,
// a viewmodel clip of the same short name, the weapon skeleton with its
// placeholder mesh and second skin, and a first-person mesh group.
function vrfRig(clips) {
  const { doc } = rig(clips);
  const root = doc.getRoot();
  const buffer = root.listBuffers()[0];
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const scene = root.listScenes()[0];
  const body = root.listNodes().find((n) => n.getName() === 'body');
  const skin = body.getSkin();

  for (const a of root.listAnimations()) a.setName(`animation/anims/world/rifle/_default_rifle/${a.getName()}`);

  const weaponRoot = doc.createNode('animation/skeletons/weapons/m4a1_silencer.vnmskel');
  const weapon = doc.createNode('weapon');
  weaponRoot.addChild(weapon);
  const weaponSkin = doc.createSkin().addJoint(weapon)
    .setInverseBindMatrices(acc('MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
  const placeholder = doc.createMesh().addPrimitive(doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array(9)))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]))));
  scene.addChild(weaponRoot)
    .addChild(doc.createNode('animation/skeletons/weapons/m4a1_silencer.vnmskel.empty_mesh_reference').setMesh(placeholder).setSkin(weaponSkin));

  scene.addChild(doc.createNode('agents/models/ctm_sas/ctm_sas.vmdl_c.firstperson_sleeves')
    .setMesh(body.getMesh().clone()).setSkin(skin));

  const joint1 = root.listNodes().find((n) => n.getName() === 'joint1');
  const sampler = doc.createAnimationSampler()
    .setInput(acc('SCALAR', new Float32Array([0])))
    .setOutput(acc('VEC3', new Float32Array([0, 0, 0])));
  // Like VRF's, the viewmodel clip animates both the weapon and the body joints.
  const viewmodel = doc.createAnimation('animation/anims/viewmodel/rifle/_default_rifle/idle_rifle').addSampler(sampler)
    .addChannel(doc.createAnimationChannel().setTargetNode(weapon).setTargetPath('translation').setSampler(sampler));
  const sampler2 = doc.createAnimationSampler()
    .setInput(acc('SCALAR', new Float32Array([0])))
    .setOutput(acc('VEC3', new Float32Array([0, 0, 0])));
  viewmodel.addSampler(sampler2)
    .addChannel(doc.createAnimationChannel().setTargetNode(joint1).setTargetPath('translation').setSampler(sampler2));
  return { doc };
}

test('selectThirdPerson keeps the third-person body and its clips under short names', async () => {
  const { doc } = vrfRig();
  expect(doc.getRoot().listSkins()).toHaveLength(2);
  expect(worldClipBases(doc)).toEqual(['idle_rifle', 'walk_n_rifle']);

  const r = selectThirdPerson(doc);
  expect(r.clips).toEqual(['idle_rifle', 'walk_n_rifle']);
  expect(r.droppedClips).toEqual(['animation/anims/viewmodel/rifle/_default_rifle/idle_rifle']);
  // weapon skeleton root + weapon joint + placeholder mesh node + first-person node
  expect(r.droppedNodes).toBe(4);
  expect(clipNames(doc)).toEqual(['idle_rifle', 'walk_n_rifle']);
  expect(doc.getRoot().listNodes().map((n) => n.getName()).sort())
    .toEqual(['body', 'joint0', 'joint1', 'joint2', 'joint3']);

  await doc.transform(prune());
  expect(doc.getRoot().listSkins()).toHaveLength(1);
  expect(doc.getRoot().listSkins()[0].listJoints()).toHaveLength(4);
  expect(skinSurvives(rig().doc, doc)).toBe(true);
});

test('stripBoneChannels keeps rotations everywhere and translations only on the root and pelvis', () => {
  const { doc } = rig(['run_n_rifle']);
  const [j0, j1] = doc.getRoot().listNodes().filter((n) => /^joint[01]$/.test(n.getName()));
  j0.setName('pelvis');
  const anim = doc.getRoot().listAnimations()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const add = (node, pathName, type, out) => {
    const s = doc.createAnimationSampler().setInput(acc('SCALAR', new Float32Array([0, 1]))).setOutput(acc(type, out));
    anim.addSampler(s).addChannel(doc.createAnimationChannel().setTargetNode(node).setTargetPath(pathName).setSampler(s));
  };
  add(j0, 'translation', 'VEC3', new Float32Array([0, 0, 0, 0, 0.1, 0]));
  add(j1, 'translation', 'VEC3', new Float32Array([0, 0, 0, 0, 0.1, 0]));
  add(j1, 'scale', 'VEC3', new Float32Array([1, 1, 1, 1, 1, 1]));
  expect(stripBoneChannels(doc)).toBe(2);
  const left = anim.listChannels().map((c) => `${c.getTargetNode().getName()}.${c.getTargetPath()}`).sort();
  expect(left).toEqual(['joint1.rotation', 'pelvis.translation']);
  expect(anim.listSamplers()).toHaveLength(2);
});

test('selectThirdPerson strips the channels of a kept clip that animate a dropped node, and drops a clip left empty', () => {
  const { doc } = vrfRig();
  const weapon = doc.getRoot().listNodes().find((n) => n.getName() === 'weapon');
  const anims = doc.getRoot().listAnimations().filter((a) => a.getName().startsWith(WORLD_CLIP_PREFIX));
  const before = anims.length;
  // The first clip's only channel moves the weapon: it is stripped and the clip goes.
  const victim = anims[0];
  const victimName = victim.getName();
  victim.listChannels()[0].setTargetNode(weapon);
  const r = selectThirdPerson(doc);
  expect(r.strippedChannels).toBe(1);
  expect(r.droppedClips).toContain(victimName);
  expect(r.clips).toHaveLength(before - 1);
  for (const a of doc.getRoot().listAnimations()) for (const ch of a.listChannels()) expect(ch.getTargetNode().getName()).not.toBe('weapon');
  // Dropped clips and stripped channels take their samplers with them, so prune can drop the keyframes.
  expect(orphanSamplers(doc)).toHaveLength(0);
});

test('player constants: required clips lead the request list, CT and T agents', () => {
  expect([...CLIPS_REQUIRED].slice(0, 6)).toEqual(['idle_rifle', 'run_n_rifle', 'walk_n_rifle', 'crouch_n_rifle', 'idle_crouch_rifle', 'inair_stand_rifle']);
  expect(CLIPS_REQUESTED.slice(0, CLIPS_REQUIRED.length)).toEqual([...CLIPS_REQUIRED]);
  expect(PLAYER_MODELS).toEqual({ ct: 'agents/models/ctm_sas/ctm_sas.vmdl_c', t: 'agents/models/tm_phoenix/tm_phoenix.vmdl_c' });
  expect(clipBase('animation/anims/world/rifle/_default_rifle/run_n_rifle')).toBe('run_n_rifle');
  expect(() => playerPaths('spec')).toThrow(/side must be one of ct, t/);
});

const SHRINK_PLAYER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shrink-player.mjs');
const CHECK_PLAYERS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-players.mjs');

/**
 * A temp ASSETS_DIR holding raw/players/rip.json and a generated GLB with the given clips for
 * each of `sides` (ct alone by default), rip.json naming `unmatched` as VRF's unmatched clips.
 */
async function rawPlayers(clips, { sides = ['ct'], unmatched = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'player-test-'));
  const raw = path.join(root, 'raw', 'players');
  const models = {};
  for (const side of sides) {
    const glb = `${side}/${path.basename(PLAYER_MODELS[side], '.vmdl_c')}.glb`;
    fs.mkdirSync(path.join(raw, side), { recursive: true });
    const { doc } = vrfRig(clips);
    await new NodeIO().write(path.join(raw, glb), doc);
    models[side] = { vmdl: PLAYER_MODELS[side], glb, unmatchedClips: [...unmatched] };
  }
  fs.writeFileSync(path.join(raw, 'rip.json'), JSON.stringify({
    cs2Build: '1', vrfVersion: 'test', exportedAt: '2026-01-01T00:00:00Z', clipsRequested: [...CLIPS_REQUESTED], models,
  }));
  return root;
}
const shrink = (root, ...args) => spawnSync(process.execPath, [SHRINK_PLAYER, ...args], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });

test('CLI: writes players/ct.glb and ct.shrink.json; the written file keeps one 4-joint skin and the clips', async () => {
  const root = await rawPlayers(CLIPS_REQUIRED);
  try {
    const r = shrink(root, 'ct');
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'players', 'ct.shrink.json'), 'utf8'));
    expect(report).toMatchObject({ model: PLAYER_MODELS.ct, clips: [...CLIPS_REQUIRED].sort(), joints: 4 });
    expect(typeof report.simplified).toBe('boolean');
    expect(report.bytes).toBe(fs.statSync(path.join(root, 'players', 'ct.glb')).size);
    expect(fs.readdirSync(path.join(root)).filter((f) => f.includes('.tmp-'))).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test('CLI: a required clip missing from the raw file exits 2 and writes nothing; usage errors exit 1', async () => {
  const root = await rawPlayers(CLIPS_REQUIRED.filter((c) => c !== 'run_n_rifle'));
  try {
    const r = shrink(root, 'ct');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/lacks required clip\(s\) run_n_rifle/);
    expect(fs.existsSync(path.join(root, 'players'))).toBe(false);
    expect(shrink(root).status).toBe(1);
    expect(shrink(root, 'spec').status).toBe(1);
    expect(shrink(root, 't').status).toBe(1); // rip.json has no models.t
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

// CLIP_SET asks for clips no shipped GLB has carried yet (inair_stand_knife, added after the
// last players rip), and CS2 may drop any clip in an update. Either way VRF names it unmatched
// and leaves it out: that rip must still build, and pass the gate build-assets.sh runs next.
test('CLI: a rip without an optional clip, as VRF leaves out one it cannot match, builds both sides and passes check-players', async () => {
  const absent = 'inair_stand_knife';
  expect(CLIPS_OPTIONAL).toContain(absent);
  const root = await rawPlayers(CLIPS_REQUESTED.filter((c) => c !== absent), { sides: SIDES, unmatched: [absent] });
  try {
    for (const side of SIDES) {
      const r = shrink(root, side);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`absent   1 optional clip(s): ${absent}`);
      const report = JSON.parse(fs.readFileSync(path.join(root, 'players', `${side}.shrink.json`), 'utf8'));
      expect(report.clips).toHaveLength(CLIPS_REQUESTED.length - 1);
      expect(report.clipsOptionalAbsent).toEqual([absent]);
    }
    const check = spawnSync(process.execPath, [CHECK_PLAYERS], { env: { ...process.env, ASSETS_DIR: root }, encoding: 'utf8' });
    expect(check.stdout).not.toMatch(/FAIL/);
    expect(check.status).toBe(0);
    for (const side of SIDES) expect(check.stdout).toMatch(new RegExp(`${side}\\.glb optional clips absent +1: ${absent} +— +OK`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
