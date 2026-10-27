import { describe, expect, test } from 'vitest';
import { Document } from '@gltf-transform/core';
import { GROUND_MODELS, MODEL_NAMES, MODEL_PATHS, selectWeaponBody, takeModelAttach, takeWeaponAttach, weaponPaths, WEAPON_MODELS, WEAPON_NAMES } from '../lib/weapons.mjs';
import { WEAPON_CLIP_SUFFIX } from '../lib/players.mjs';

// A VRF-like weapon export: mesh-group nodes named `<vmdl>.<group>`.
function weaponDoc(groups) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('scene');
  for (const g of groups) {
    const prim = doc.createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buffer))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 1, 2])).setBuffer(buffer));
    scene.addChild(doc.createNode(`weapons/models/x/weapon_x.vmdl_c.${g}`).setMesh(doc.createMesh(g).addPrimitive(prim)));
  }
  return doc;
}

describe('WEAPON_MODELS', () => {
  test('every weapon with per-weapon clips has a model, plus the grenades, c4, knives and healthshot', () => {
    for (const w of Object.keys(WEAPON_CLIP_SUFFIX)) expect(WEAPON_MODELS).toHaveProperty(w);
    for (const w of ['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incendiary', 'decoy', 'c4', 'knife', 'knife_t', 'healthshot']) {
      expect(WEAPON_MODELS).toHaveProperty(w);
    }
    expect(WEAPON_NAMES).toHaveLength(45);
  });

  test('model paths are world weapon models and names are sorted and unique', () => {
    for (const [name, vmdl] of Object.entries(WEAPON_MODELS)) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
      expect(vmdl).toMatch(/^weapons\/models\/[a-z0-9_/]+\/weapon_[a-z0-9_]+\.vmdl_c$/);
    }
    expect([...WEAPON_NAMES]).toEqual([...new Set(WEAPON_NAMES)].sort());
  });
});

describe('GROUND_MODELS', () => {
  test('the defuse kit is a model of its own, seen only on the ground, and no weapon a player holds', () => {
    expect(GROUND_MODELS).toEqual({ defuser: 'weapons/models/defuser/defuser.vmdl_c' });
    // WEAPON_NAMES also drives the viewmodels (one clip folder per held weapon): it keeps 45.
    expect(WEAPON_NAMES).not.toContain('defuser');
  });

  test('MODEL_NAMES is every model ripped and shrunk: the 45 weapons and the kit, sorted', () => {
    expect(MODEL_NAMES).toHaveLength(46);
    expect([...MODEL_NAMES]).toEqual([...WEAPON_NAMES, 'defuser'].sort());
    expect(MODEL_PATHS.defuser).toBe(GROUND_MODELS.defuser);
    for (const name of WEAPON_NAMES) expect(MODEL_PATHS[name]).toBe(WEAPON_MODELS[name]);
    expect(Object.keys(MODEL_PATHS).sort()).toEqual([...MODEL_NAMES]);
  });
});

describe('selectWeaponBody', () => {
  test('drops body_hd when body_legacy exists and keeps the extras', () => {
    const doc = weaponDoc(['body_legacy', 'body_hd', 'c4_screen']);
    expect(selectWeaponBody(doc)).toEqual({ dropped: ['body_hd'], kept: ['body_legacy', 'c4_screen'] });
    expect(doc.getRoot().listNodes().filter((n) => n.getMesh()).map((n) => n.getName().split('.').pop()).sort()).toEqual(['body_legacy', 'c4_screen']);
  });

  test('keeps body_hd when it is the only body, and a lone body', () => {
    expect(selectWeaponBody(weaponDoc(['body_hd', 'c4_screen']))).toEqual({ dropped: [], kept: ['body_hd', 'c4_screen'] });
    expect(selectWeaponBody(weaponDoc(['body']))).toEqual({ dropped: [], kept: ['body'] });
  });

  test('a model with no mesh node is an error', () => {
    expect(() => selectWeaponBody(new Document())).toThrow(/no mesh node/);
  });
});

// A VRF export with its skeleton (`--gltf_export_animations`): the M4A4's `weapon` root bone,
// a child bone, a mesh skinned to them and a clip.
function skinnedWeaponDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('weapon_rif_m4a4.vmdl_c');
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const top = doc.createNode('weapons/models/m4a4/weapon_rif_m4a4.vmdl_c');
  const weapon = doc.createNode('weapon').setTranslation([-0.005, 0.315, 0.463]).setRotation([-0.5, -0.5, -0.5, 0.5]);
  const offset = doc.createNode('weapon_offset');
  top.addChild(weapon);
  weapon.addChild(offset);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0.2, 0.1, 0, 0.3, 0.9, 0, 0.1, 0.5])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));
  const skin = doc.createSkin().addJoint(weapon).addJoint(offset).setInverseBindMatrices(acc('MAT4', new Float32Array(32)));
  const body = doc.createNode('weapons/models/m4a4/weapon_rif_m4a4.vmdl_c.body_legacy').setMesh(doc.createMesh('body').addPrimitive(prim)).setSkin(skin);
  scene.addChild(top).addChild(body);
  const sampler = doc.createAnimationSampler().setInput(acc('SCALAR', new Float32Array([0]))).setOutput(acc('VEC3', new Float32Array([0, 0, 0])));
  doc.createAnimation('shoot').addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(offset).setTargetPath('translation').setSampler(sampler));
  return doc;
}

describe('takeWeaponAttach', () => {
  test('keeps the `weapon` bone\'s rest pose on the scene and drops the skeleton, skin and clips', () => {
    const doc = skinnedWeaponDoc();
    const attach = takeWeaponAttach(doc);
    expect(attach.translation).toEqual([-0.005, 0.315, 0.463]);
    expect(attach.rotation).toEqual([-0.5, -0.5, -0.5, 0.5]);
    const root = doc.getRoot();
    expect(root.listScenes()[0].getExtras()).toEqual({ attach });
    expect(root.listSkins()).toHaveLength(0);
    expect(root.listAnimations()).toHaveLength(0);
    expect(root.listNodes().map((n) => n.getName())).toEqual(['weapons/models/m4a4/weapon_rif_m4a4.vmdl_c.body_legacy']);
    const prim = root.listMeshes()[0].listPrimitives()[0];
    expect(prim.listSemantics()).toEqual(['POSITION']);
    // Nothing left behind for prune to miss: the clip's keys, the joints and weights.
    const kept = [prim.getAttribute('POSITION'), prim.getIndices()];
    expect(root.listAccessors().map((a) => kept.indexOf(a))).toEqual([0, 1]);
    // The mesh stays where the export put it: the model's own frame.
    expect(Array.from(prim.getAttribute('POSITION').getArray())).toEqual(Array.from(new Float32Array([0, 0.2, 0.1, 0, 0.3, 0.9, 0, 0.1, 0.5])));
  });

  test('an export without the skeleton is an error naming the fix', () => {
    expect(() => takeWeaponAttach(weaponDoc(['body_legacy']))).toThrow(/no `weapon` bone.*rip-weapons\.sh --force/);
  });
});

// The kit's export: a mesh skinned to one bone, `weapon_hand_r`, and no `weapon` bone.
function kitDoc() {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('defuser.vmdl_c');
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const top = doc.createNode('weapons/models/defuser/defuser.vmdl_c');
  const hand = doc.createNode('weapon_hand_r').setTranslation([0, 0.01, 0.02]);
  top.addChild(hand);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(12)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2])));
  const skin = doc.createSkin().addJoint(hand).setInverseBindMatrices(acc('MAT4', new Float32Array(16)));
  const body = doc.createNode('weapons/models/defuser/defuser.vmdl_c.body').setMesh(doc.createMesh('body').addPrimitive(prim)).setSkin(skin);
  scene.addChild(top).addChild(body);
  return doc;
}

describe('takeModelAttach', () => {
  test('a held weapon takes its `weapon` bone\'s rest pose, as takeWeaponAttach does', () => {
    expect(takeModelAttach('m4a4', skinnedWeaponDoc())).toEqual({ translation: [-0.005, 0.315, 0.463], rotation: [-0.5, -0.5, -0.5, 0.5] });
    expect(() => takeModelAttach('ak47', weaponDoc(['body_legacy']))).toThrow(/no `weapon` bone/);
  });

  test('a ground-only model has no attach, and still loses its skeleton, skin and joint attributes', () => {
    const doc = kitDoc();
    expect(takeModelAttach('defuser', doc)).toBeNull();
    const root = doc.getRoot();
    expect(root.listScenes()[0].getExtras()).toEqual({});
    expect(root.listSkins()).toHaveLength(0);
    expect(root.listNodes().map((n) => n.getName())).toEqual(['weapons/models/defuser/defuser.vmdl_c.body']);
    const prim = root.listMeshes()[0].listPrimitives()[0];
    expect(prim.listSemantics()).toEqual(['POSITION']);
    expect(root.listAccessors()).toHaveLength(2);
  });
});

describe('weaponPaths', () => {
  test('shared paths without a name, per-weapon files with one, unknown names refused', () => {
    const p = weaponPaths();
    expect(p.out.endsWith('/weapons')).toBe(true);
    expect(p.ripJson.endsWith('/raw/weapons/rip.json')).toBe(true);
    expect(p.glb).toBeUndefined();
    const ak = weaponPaths('ak47');
    expect(ak.glb.endsWith('/weapons/ak47.glb')).toBe(true);
    expect(ak.gz.endsWith('/weapons/ak47.glb.gz')).toBe(true);
    expect(ak.shrinkJson.endsWith('/weapons/ak47.shrink.json')).toBe(true);
    expect(weaponPaths('defuser').glb.endsWith('/weapons/defuser.glb')).toBe(true);
    expect(() => weaponPaths('ak-47')).toThrow(/invalid weapon name/);
    expect(() => weaponPaths('scar')).toThrow(/unknown weapon 'scar'/);
  });
});
