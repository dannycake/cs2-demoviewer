import { describe, expect, test } from 'vitest';
import { Document } from '@gltf-transform/core';
import { reskinArms, selectFirstPerson, stripUnseen } from '../shrink-arms.mjs';
import { RIG_ROOT } from '../lib/viewmodels.mjs';

// An agent-like export: the world skeleton (root_motion → spine_0 → clavicle_L → arm_upper_L →
// arm_upper_L_TWIST; spine_0 is no joint), a third-person body and two first-person meshes,
// each with its own copy of the body skin, and a clip.
function agentDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const node = (name, parent, t = [0, 0, 0]) => {
    const n = doc.createNode(name).setTranslation(t);
    (parent ?? scene).addChild(n);
    return n;
  };
  const model = node('agents/models/x/x.vmdl_c');
  const rm = node('root_motion', model);
  const spine = node('spine_0', rm, [0, 1, 0]);
  const clav = node('clavicle_L', spine, [0.1, 0.4, 0]);
  const upper = node('arm_upper_L', clav, [0.1, 0, 0]);
  const twist = node('arm_upper_L_TWIST', upper, [0.15, 0, 0]);
  const joints = [rm, clav, upper, twist];
  const ibm = doc.createAccessor().setType('MAT4').setArray(new Float32Array(16 * joints.length)).setBuffer(buffer);
  const mesh = (group) => {
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(9)).setBuffer(buffer))
      .setAttribute('TANGENT', doc.createAccessor().setType('VEC4').setArray(new Float32Array(12)).setBuffer(buffer))
      .setAttribute('TEXCOORD_1', doc.createAccessor().setType('VEC2').setArray(new Float32Array(6)).setBuffer(buffer))
      .setMaterial(doc.createMaterial(group).setNormalTexture(doc.createTexture('n')).setBaseColorTexture(doc.createTexture('c')));
    const skin = doc.createSkin().setInverseBindMatrices(ibm);
    for (const j of joints) skin.addJoint(j);
    return node(`agents/models/x/x.vmdl_c.${group}`).setMesh(doc.createMesh(group).addPrimitive(prim)).setSkin(skin);
  };
  mesh('thirdperson_body');
  mesh('firstperson_default_gloves_arms');
  mesh('firstperson_sleeves');
  doc.createAnimation('run');
  return { doc, ibm };
}

describe('shrink-arms', () => {
  test('selectFirstPerson keeps the firstperson_* meshes and drops every clip', () => {
    const { doc } = agentDoc();
    const kept = selectFirstPerson(doc);
    expect(kept.map((n) => n.getName().split('.').pop())).toEqual(['firstperson_default_gloves_arms', 'firstperson_sleeves']);
    expect(doc.getRoot().listAnimations()).toHaveLength(0);
    expect(doc.getRoot().listNodes().filter((n) => n.getMesh())).toHaveLength(2);
  });

  test('reskinArms: one skin in the old joint order; missing joints hang from the nearest bone the rig has, at their rest offset', () => {
    const { doc, ibm } = agentDoc();
    const meshes = selectFirstPerson(doc);
    const scene = doc.getRoot().listScenes()[0];
    const rig = doc.createNode(RIG_ROOT);
    scene.addChild(rig);
    const rm = doc.createNode('root_motion');
    const upper = doc.createNode('arm_upper_L').setTranslation([0.3, 0, 0]);
    rig.addChild(rm);
    rm.addChild(upper);
    const bones = new Map([['root_motion', rm], ['arm_upper_L', upper]]);
    const made = reskinArms(doc, meshes, rig, bones);
    expect(made).toEqual(['clavicle_L<-root_motion', 'arm_upper_L_TWIST<-arm_upper_L']);
    const skins = doc.getRoot().listSkins();
    expect(skins).toHaveLength(1);
    expect(skins[0].listJoints().map((j) => j.getName())).toEqual(['root_motion', 'clavicle_L', 'arm_upper_L', 'arm_upper_L_TWIST']);
    expect(skins[0].getInverseBindMatrices()).toBe(ibm);
    for (const m of meshes) expect(m.getSkin()).toBe(skins[0]);
    // clavicle_L was two levels below root_motion (spine_0 between): the offsets compose.
    const clav = bones.get('clavicle_L');
    expect(clav.getTranslation().map((v) => +v.toFixed(6))).toEqual([0.1, 1.4, 0]);
    expect(bones.get('arm_upper_L_TWIST').getTranslation().map((v) => +v.toFixed(6))).toEqual([0.15, 0, 0]);
    // Only the rig and the two meshes are left in the scene.
    expect(scene.listChildren().map((n) => n.getName()).sort()).toEqual(['agents/models/x/x.vmdl_c.firstperson_default_gloves_arms', 'agents/models/x/x.vmdl_c.firstperson_sleeves', RIG_ROOT]);
    expect(doc.getRoot().listNodes().filter((n) => n.getName() === 'spine_0')).toHaveLength(0);
  });

  test('stripUnseen drops tangents, extra UV sets and every texture but the base colour', () => {
    const { doc } = agentDoc();
    selectFirstPerson(doc);
    expect(stripUnseen(doc)).toEqual({ attributes: ['TANGENT', 'TEXCOORD_1'], textures: 3 });
    for (const m of doc.getRoot().listMaterials()) {
      expect(m.getNormalTexture()).toBeNull();
      expect(m.getBaseColorTexture()).not.toBeNull();
    }
  });
});
