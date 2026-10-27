import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document } from '@gltf-transform/core';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { paths } from '../lib/paths.mjs';
import { MODEL_POSES_FILE, animationPose, poseSkinnedProps, readModelPoses, staleModelPoses, usedJoints } from '../lib/poses.mjs';
import { skinnedModel } from './skinned-model.mjs';

// Overpass's door (models/props_downtown/metal_door_112.vmdl) as Source2Viewer-CLI exports it with
// its animations: the root bone's bind rotation is the Source→glTF axis turn (x→z, y→x, z→y) that
// the `ref` animation, the pose the game draws it in, does not have. Numbers from the export.
const AXIS_TURN = [-0.5, -0.5, -0.5, 0.5];
const DOOR = {
  bind: [{ name: 'doorrootbone', r: AXIS_TURN, t: [1.6256, 0, 0.019593] }, { name: 'metal_door_112_reference', t: [-0.019593, -1.6256, 0] }],
  ref: [{ r: [0, 0, 0, 1], t: [0.019593, 1.6256, 0] }, { r: [0, 0, 0, -1], t: [-0.019593, -1.6256, 0] }],
};
// glTF x → y, y → z, z → x (column-major): what the ref pose does to the door's bind-space vertices.
const STAND_UP = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
const IDENTITY = new THREE.Matrix4().elements;

const expectMatrix = (actual, expected, eps = 1e-5) => {
  expect(actual).toHaveLength(16);
  actual.forEach((v, i) => expect(Math.abs(v - expected[i]), `element ${i}: ${actual}`).toBeLessThan(eps));
};

describe('animationPose', () => {
  it('gives the skinning matrix of each joint in the first frame of the first clip: the door stands up', () => {
    const pose = animationPose(skinnedModel({ bind: DOOR.bind, clips: { ref: DOOR.ref, open: [{ r: [0, 0.7071068, 0, 0.7071068] }] } }));
    expect(pose.anim).toBe('ref');
    expect([...pose.joints.keys()]).toEqual([0, 1]);
    expectMatrix(pose.joints.get(0), STAND_UP);
    expectMatrix(pose.joints.get(1), STAND_UP);
  });

  it('takes the named clip, and the bind pose for a bone the clip does not move', () => {
    const pose = animationPose(skinnedModel({ bind: DOOR.bind, clips: { ref: DOOR.ref, still: [{ r: AXIS_TURN, t: DOOR.bind[0].t }] } }), 'still');
    expect(pose.anim).toBe('still');
    expectMatrix(pose.joints.get(0), IDENTITY);
    expectMatrix(pose.joints.get(1), IDENTITY); // no channel for the child: it keeps its bind transform
  });

  it('reads a CUBICSPLINE key\'s value, not its in-tangent', () => {
    const cubic = DOOR.ref.map((k) => ({ ...k, cubic: 7 }));
    const pose = animationPose(skinnedModel({ bind: DOOR.bind, clips: { ref: cubic } }));
    expectMatrix(pose.joints.get(0), STAND_UP);
    expectMatrix(pose.joints.get(1), STAND_UP);
  });

  it('refuses a CUBICSPLINE output without the value after the in-tangent', () => {
    const doc = skinnedModel({ bind: DOOR.bind, clips: { ref: DOOR.ref } });
    doc.getRoot().listAnimations()[0].listSamplers()[0].setInterpolation('CUBICSPLINE');
    expect(() => animationPose(doc)).toThrow(/CUBICSPLINE/);
  });

  it('refuses a clip the model does not have, and a model without a skin', () => {
    expect(() => animationPose(skinnedModel({ bind: DOOR.bind, clips: { ref: DOOR.ref } }), 'spin')).toThrow(/no animation "spin"/);
    expect(() => animationPose(new Document())).toThrow(/no skin/);
  });

  it('usedJoints lists the joints some vertex weighs above zero', () => {
    expect([...usedJoints(skinnedModel({ bind: DOOR.bind, clips: {} }))].sort()).toEqual([0, 1]);
  });
});

/**
 * A world as VRF exports it: model nodes named `<model>.<mesh>` at their entity's transform, their
 * vertices in bind space, JOINTS_0/WEIGHTS_0 kept and the skin dropped.
 */
function world() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  // The door lying flat as exported: 2.83 m along x, 1.40 m along z, its weight all on joint 1
  // (joint 0 listed with weight 0, as VRF writes it).
  const slab = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0.02, 2.83, 0, 0.02, 2.83, 0, 1.4, 0, 0, 1.4])))
    .setAttribute('NORMAL', acc('VEC3', new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])))
    .setAttribute('TANGENT', acc('VEC4', new Float32Array([1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1, 1, 0, 0, -1])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const door = doc.createMesh('metal_door_112.metal_door_112_bg_body_lod0').addPrimitive(slab);
  // Overpass's door at its spawn: origin [-1748, -889, 100], yaw 270.
  const spawn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2).toArray();
  const doorNode = doc.createNode('metal_door_112.metal_door_112_bg_body_lod0').setMesh(door).setTranslation([-22.5806, 2.54, -44.3992]).setRotation(spawn);
  // A second instance sharing the mesh, which must be posed once, not twice.
  const twin = doc.createNode('metal_door_112.metal_door_112_bg_body_lod0').setMesh(door).setTranslation([10, 0, 0]);
  // A fan whose two blades hang on two joints, one vertex shared half and half.
  const blades = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint16Array([0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0])))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 128, 127, 0, 0])).setNormalized(true));
  const fan = doc.createNode('fan.fan_lod0').setMesh(doc.createMesh().addPrimitive(blades));
  // A prop whose drawn pose is its bind pose, one the table does not know, and a node with a skin.
  const still = (name) => doc.createNode(name).setMesh(doc.createMesh().addPrimitive(doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([1, 2, 3])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array([0, 0, 0, 0])))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0])))));
  const cone = still('traffic_cone.traffic_cone_lod0');
  const stranger = still('mystery_prop.mystery_prop_lod0');
  const skinned = still('player.body').setSkin(doc.createSkin());
  const wall = doc.createNode('wall').setMesh(doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', acc('VEC3', new Float32Array([5, 5, 5])))));
  for (const n of [doorNode, twin, fan, cone, stranger, skinned, wall]) scene.addChild(n);
  return { doc, slab, blades, doorNode, cone, stranger, skinned, wall };
}

const TABLE = {
  metal_door_112: { pose: { 1: STAND_UP } },
  // joint 0 turns 90° about y (x → −z), joint 1 lifts by 1 m
  fan: { pose: { 0: new THREE.Matrix4().makeRotationY(Math.PI / 2).toArray(), 1: new THREE.Matrix4().makeTranslation(0, 1, 0).toArray() } },
  traffic_cone: { pose: null },
};

const vectors = (acc) => Array.from({ length: acc.getCount() }, (_, i) => acc.getElement(i, []));
const expectVectors = (actual, expected, eps = 1e-5) => actual.forEach((v, i) => v.forEach((x, j) => expect(Math.abs(x - expected[i][j]), `vertex ${i}: ${v}`).toBeLessThan(eps)));

describe('poseSkinnedProps', () => {
  it('stands the flat door up in bind space, so at its spawn it is 2.83 m tall', () => {
    const w = world();
    const out = poseSkinnedProps(w.doc, TABLE);
    expect(out).toEqual({ posed: { fan: 1, metal_door_112: 2 }, unknown: ['mystery_prop'], errors: {} });
    expectVectors(vectors(w.slab.getAttribute('POSITION')), [[0.02, 0, 0], [0.02, 2.83, 0], [1.4, 2.83, 0], [1.4, 0, 0]]);
    expectVectors(vectors(w.slab.getAttribute('NORMAL')), Array(4).fill([0, 0, 1]));
    expectVectors(vectors(w.slab.getAttribute('TANGENT')), Array(4).fill([0, 1, 0, -1]));
    const box = new THREE.Box3();
    const m = new THREE.Matrix4().fromArray(w.doorNode.getWorldMatrix());
    for (const p of vectors(w.slab.getAttribute('POSITION'))) box.expandByPoint(new THREE.Vector3(...p).applyMatrix4(m));
    const size = box.getSize(new THREE.Vector3());
    expect(size.y).toBeCloseTo(2.83, 5);
    expect(Math.min(size.x, size.z)).toBeCloseTo(0, 5); // a plane standing on the floor
  });

  it('blends the joints by their weights', () => {
    const w = world();
    poseSkinnedProps(w.doc, TABLE);
    const half = 128 / 255, rest = 127 / 255;
    expectVectors(vectors(w.blades.getAttribute('POSITION')), [[0, 0, -1], [0, 2, 0], [half * 1, rest * 1, half * 0 + rest * 1]], 1e-4);
  });

  it('leaves alone what it does not pose, and names the skinned models it does not know', () => {
    const w = world();
    const before = [w.cone, w.stranger, w.skinned, w.wall].map((n) => n.getMesh().listPrimitives()[0].getAttribute('POSITION').getArray().slice());
    const out = poseSkinnedProps(w.doc, TABLE);
    [w.cone, w.stranger, w.skinned, w.wall].forEach((n, i) => expect(n.getMesh().listPrimitives()[0].getAttribute('POSITION').getArray()).toEqual(before[i]));
    expect(out.unknown).toEqual(['mystery_prop']); // not the cone (drawn as exported), the skinned body or the wall
  });

  it('refuses a vertex weighed on a joint the table has no matrix for', () => {
    const w = world();
    expect(() => poseSkinnedProps(w.doc, { ...TABLE, metal_door_112: { pose: { 0: IDENTITY } } })).toThrow(/metal_door_112.*joint 1/);
  });

  it('reports the models the table records an error for, and leaves them alone', () => {
    const w = world();
    const before = w.slab.getAttribute('POSITION').getArray().slice();
    const out = poseSkinnedProps(w.doc, { ...TABLE, metal_door_112: { error: 'its entities play different animations (ref, open)' } });
    expect(out.errors).toEqual({ metal_door_112: 'its entities play different animations (ref, open)' });
    expect(out.posed).toEqual({ fan: 1 });
    expect(w.slab.getAttribute('POSITION').getArray()).toEqual(before);
  });
});

describe('the pose table of a rip', () => {
  const RIP = { cs2Build: '2000935', vrfVersion: '20.1.7467+9e2e6c7f' };

  it('readModelPoses reads raw/<map>/model-poses.json, or gives null without one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poses-test-'));
    try {
      expect(readModelPoses(dir)).toBeNull();
      fs.writeFileSync(path.join(dir, MODEL_POSES_FILE), JSON.stringify({ ...RIP, map: 'de_x', models: { fan: { pose: null } } }));
      expect(readModelPoses(dir)).toEqual({ ...RIP, map: 'de_x', models: { fan: { pose: null } } });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('staleModelPoses names a CS2 build or VRF version that is not the rip\'s, and what makes the two agree', () => {
    expect(staleModelPoses({ ...RIP, models: {} }, RIP, 'de_x')).toBeNull();
    // rip-map.sh re-exports a rip from another CS2 build by itself; model-poses.sh then follows it.
    expect(staleModelPoses({ ...RIP, cs2Build: '2000934', models: {} }, RIP, 'de_x'))
      .toMatch(/CS2 build 2000934.*2000935; run tools\/rip-map\.sh de_x, then tools\/model-poses\.sh de_x$/);
    // After a VRF-only upgrade rip-map.sh skips the rip (same CS2 build): only --force re-exports it.
    expect(staleModelPoses({ ...RIP, vrfVersion: '20.0', models: {} }, RIP, 'de_x'))
      .toMatch(/VRF 20\.0.*20\.1\.7467.*; run tools\/rip-map\.sh de_x --force, then tools\/model-poses\.sh de_x$/);
    expect(staleModelPoses({ ...RIP, models: {} }, null, 'de_x')).toMatch(/no rip\.json.*; run tools\/rip-map\.sh de_x, then tools\/model-poses\.sh de_x$/);
  });
});

// The tables tools/model-poses.sh wrote beside the real rips (read, never written here).
const ripTable = (map) => readModelPoses(paths(map).raw);
const OVERPASS = ripTable('de_overpass');
const NUKE = ripTable('de_nuke');

describe.skipIf(!OVERPASS || !NUKE)('the pose tables of the real rips', () => {
  it('stand Overpass\'s door up and turn Nuke\'s into their doorways', () => {
    expect(OVERPASS.models.metal_door_112.anim).toBe('ref');
    expectMatrix(OVERPASS.models.metal_door_112.pose[1], STAND_UP, 1e-3);
    // Nuke's door: a quarter turn about the vertical, so its width runs along Source +y as its hull does
    expectMatrix(NUKE.models.metal_door_001_br.pose[0], new THREE.Matrix4().makeRotationY(Math.PI / 2).toArray(), 1e-3);
    expect(NUKE.models.nuke_vent_slats.pose).toBeNull();
  });
});
