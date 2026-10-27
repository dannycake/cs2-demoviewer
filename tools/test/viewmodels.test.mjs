import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import { Document } from '@gltf-transform/core';
import {
  clipSuffix, copyClip, copySkeleton, dirsCoverWeapons, HELPER_BONE, listClips, RIG_ROOT, selectClips, trackAtRest,
  TYPICAL_MATCH, viewmodelPaths, VIEWMODEL_DIR_LIST, VIEWMODEL_DIRS, VIEWMODEL_SKELETON, WEAPON_BONES_KEPT,
} from '../lib/viewmodels.mjs';
import { WEAPON_NAMES } from '../lib/weapons.mjs';

// Folder listings as rip-viewmodels.sh found them (CS2 build 2000934).
const LISTING = {
  'rifle/rifle_ak': ['draw_ak', 'idle_ak', 'lookat01_ak', 'lookat01_draw_ak', 'lookat01_transfix_ak', 'lookat03_ak', 'lookat03_draw_ak', 'lookat03_transfix_ak', 'lookat_draw_ak', 'reload_ak', 'shoot1_ak'],
  'rifle/rifle_g3sg1': ['draw_g3sg1', 'idle1_g3sg1', 'lookat01_g3sg1', 'reload_g3sg1', 'shoot1_g3sg1'],
  'rifle/rifle_ssg08': ['draw_ssg08', 'draw_ssg08_lgcy', 'idle_ssg08', 'idle_ssg08_lgcy', 'lookat01_ssg08', 'lookat01_ssg08_lgcy', 'reload_ssg08', 'reload_ssg08_lgcy', 'shoot1_ssg08', 'shoot1_ssg08_lgcy'],
  'pistol/_default_pistol': ['draw_pistol', 'draw_silenced_pistol', 'idle_pistol', 'idle_slide_back_pistol', 'lookat01_pistol', 'reload_empty_pistol', 'reload_pistol', 'shoot1_pistol', 'shoot_empty_pistol', 'silencer_attach_pistol', 'silencer_detach_pistol'],
  'pistol/pistol_elite': ['draw_elite', 'idle_elite', 'idle_leftempty_elite', 'idle_leftrightempty_elite', 'lookat01_elite', 'reload_elite', 'shoot_left1_elite', 'shoot_leftlast_elite', 'shoot_right1_elite', 'shoot_rightlast_elite', 'ui_keychain_elite'],
  'pistol/pistol_revolver': ['chamber_position_anim_revolver_0', 'draw_2_revolver', 'draw_revolver', 'dryfire_revolver', 'idle_revolver', 'lookat01_revolver', 'prepare_shoot_revolver', 'reload_revolver', 'shoot1_revolver', 'shoot_alt1_revolver'],
  'pistol/pistol_taser': ['draw_taser', 'idle_taser', 'lookat01_taser', 'shoot1_taser'],
  'knife/knife_default_t': ['draw_default_t', 'heavy_backstab_default_t', 'heavy_hit1_default_t', 'heavy_miss1_default_t', 'idle2_default_t', 'idle_default_t', 'light_backstab2_default_t', 'light_backstab_default_t', 'light_hit1_default_t', 'light_hit2_default_t', 'light_miss1_default_t', 'light_miss2_default_t', 'lookat01_default_t'],
  'grenade/grenade_smokegrenade': ['draw_smoke', 'idle_smoke', 'lookat01_smoke', 'lookat02_smoke', 'pullpin_smoke', 'throwcharge_high_smoke', 'throwcharge_low_smoke', 'throwcharge_mid_smoke', 'throw_overhand_smoke', 'throw_underhand_smoke'],
  'equipment/c4': ['draw_c4', 'idle_c4', 'lookat01_c4', 'lookat02_c4', 'lookat03_c4', 'plant_c4'],
  'equipment/healthshot': ['draw_healthshot', 'idle_healthshot', 'inject_healthshot'],
};

describe('VIEWMODEL_DIRS', () => {
  test('one folder per weapon model, the same names as WEAPON_MODELS', () => {
    expect(Object.keys(VIEWMODEL_DIRS).sort()).toEqual([...WEAPON_NAMES]);
    expect(dirsCoverWeapons()).toBe(true);
  });

  test('the M4A1-S, USP-S and decoy use the family defaults; each default knife has its own', () => {
    expect(VIEWMODEL_DIRS.m4a1s).toBe('rifle/_default_rifle');
    expect(VIEWMODEL_DIRS.usp).toBe('pistol/_default_pistol');
    expect(VIEWMODEL_DIRS.decoy).toBe('grenade/_default_grenade');
    expect(VIEWMODEL_DIRS.knife).toBe('knife/_default_knife');
    expect(VIEWMODEL_DIRS.knife_t).toBe('knife/knife_default_t');
    expect(VIEWMODEL_DIRS.glock).toBe('pistol/pistol_glock18');
    expect(VIEWMODEL_DIRS.c4).toBe('equipment/c4');
  });

  test('the export list is every folder once, sorted, in <group>/<folder> form', () => {
    expect(VIEWMODEL_DIR_LIST).toHaveLength(45);
    expect([...VIEWMODEL_DIR_LIST]).toEqual([...new Set(Object.values(VIEWMODEL_DIRS))].sort());
    for (const d of VIEWMODEL_DIR_LIST) expect(d).toMatch(/^(rifle|pistol|knife|grenade|equipment)\/[a-z0-9_]+$/);
  });

  test('the typical match names weapons that exist', () => {
    for (const w of TYPICAL_MATCH) expect(VIEWMODEL_DIRS).toHaveProperty(w);
  });

  test('viewmodelPaths', () => {
    const p = viewmodelPaths('ak47');
    expect(p.dir.endsWith('/raw/viewmodels/rifle/rifle_ak')).toBe(true);
    expect(p.glb.endsWith('/viewmodels/ak47.glb')).toBe(true);
    expect(() => viewmodelPaths('nope')).toThrow(/unknown weapon/);
    expect(() => viewmodelPaths('../x')).toThrow(/invalid weapon name/);
  });
});

describe('clipSuffix and selectClips', () => {
  test('the suffix is the shortest draw_ clip', () => {
    expect(clipSuffix(LISTING['rifle/rifle_ak'])).toBe('ak');
    expect(clipSuffix(LISTING['pistol/_default_pistol'])).toBe('pistol');
    expect(clipSuffix(LISTING['pistol/pistol_revolver'])).toBe('revolver');
    expect(clipSuffix(LISTING['knife/knife_default_t'])).toBe('default_t');
    expect(clipSuffix(LISTING['grenade/grenade_smokegrenade'])).toBe('smoke');
    expect(clipSuffix(['idle_x'])).toBeNull();
  });

  test('guns: idle, draw, the first shot and the reload', () => {
    expect(selectClips('ak47', LISTING['rifle/rifle_ak'])).toEqual({ idle: 'idle_ak', draw: 'draw_ak', shoot: 'shoot1_ak', reload: 'reload_ak' });
    expect(selectClips('g3sg1', LISTING['rifle/rifle_g3sg1'])).toMatchObject({ idle: 'idle1_g3sg1' });
    // Not the legacy model's clips.
    expect(selectClips('ssg08', LISTING['rifle/rifle_ssg08'])).toEqual({ idle: 'idle_ssg08', draw: 'draw_ssg08', shoot: 'shoot1_ssg08', reload: 'reload_ssg08' });
    expect(selectClips('revolver', LISTING['pistol/pistol_revolver'])).toEqual({ idle: 'idle_revolver', draw: 'draw_revolver', shoot: 'shoot1_revolver', reload: 'reload_revolver' });
    expect(selectClips('taser', LISTING['pistol/pistol_taser'])).toEqual({ idle: 'idle_taser', draw: 'draw_taser', shoot: 'shoot1_taser' });
  });

  test('the USP-S draws with its silencer on; the P2000 folder default does not', () => {
    expect(selectClips('usp', LISTING['pistol/_default_pistol'])).toEqual({ idle: 'idle_pistol', draw: 'draw_silenced_pistol', shoot: 'shoot1_pistol', reload: 'reload_pistol' });
  });

  test('the Dual Berettas shoot right then left', () => {
    expect(selectClips('elite', LISTING['pistol/pistol_elite'])).toEqual({ idle: 'idle_elite', draw: 'draw_elite', shoot: 'shoot_right1_elite', shoot_left: 'shoot_left1_elite', reload: 'reload_elite' });
  });

  test('the knife swings light; grenades pull the pin and throw both ways; the c4 plants', () => {
    expect(selectClips('knife_t', LISTING['knife/knife_default_t'])).toEqual({ idle: 'idle_default_t', draw: 'draw_default_t', shoot: 'light_miss1_default_t' });
    expect(selectClips('smokegrenade', LISTING['grenade/grenade_smokegrenade'])).toEqual({
      idle: 'idle_smoke', draw: 'draw_smoke', pullpin: 'pullpin_smoke', throw: 'throw_overhand_smoke', throw_underhand: 'throw_underhand_smoke',
    });
    expect(selectClips('c4', LISTING['equipment/c4'])).toEqual({ idle: 'idle_c4', draw: 'draw_c4', plant: 'plant_c4' });
    expect(selectClips('healthshot', LISTING['equipment/healthshot'])).toEqual({ idle: 'idle_healthshot', draw: 'draw_healthshot' });
  });

  test('a folder without an idle or a draw is an error naming the weapon', () => {
    expect(() => selectClips('ak47', ['draw_ak', 'shoot1_ak'])).toThrow(/ak47: no idle/);
    expect(() => selectClips('ak47', ['idle_ak'])).toThrow(/ak47: no idle or draw/);
  });

  const ripJson = viewmodelPaths().ripJson;
  test.skipIf(!fs.existsSync(ripJson))('every weapon finds its clips in the real rip', () => {
    for (const name of WEAPON_NAMES) {
      const picks = selectClips(name, listClips(viewmodelPaths(name).dir));
      expect(Object.keys(picks)).toEqual(expect.arrayContaining(['idle', 'draw']));
    }
  });
});

describe('bone filtering', () => {
  test('helper bones are the IK targets on the weapon and in the hands', () => {
    for (const b of ['wpnHand_L', 'wpnHand_R', 'attachHand_L', 'attachHand_R', 'wpnTip', 'wpnEnd']) expect(b).toMatch(HELPER_BONE);
    for (const b of ['wpn', 'hand_L', 'root_motion', 'armUpperShoulder_R', 'finger_index_0_L', 'wpnTipX']) expect(b).not.toMatch(HELPER_BONE);
  });

  test('trackAtRest: within 1e-5 of the rest value on every key', () => {
    expect(trackAtRest(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]), [0, 0, 0, 1])).toBe(true);
    expect(trackAtRest(new Float32Array([0, 0, 0, 1, 0, 0.01, 0, 1]), [0, 0, 0, 1])).toBe(false);
    expect(trackAtRest(new Float32Array([1, 2, 3.000001]), [1, 2, 3])).toBe(true);
  });

  // A VRF viewmodel clip export: the viewmodel skeleton (with helpers) beside a weapon
  // skeleton, and one clip that moves the hand, a helper, the weapon's left hand and its bolt,
  // and keeps the wrist at rest.
  function clipExport() {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene();
    const node = (name, parent, t = [0, 0, 0], r = [0, 0, 0, 1]) => {
      const n = doc.createNode(name).setTranslation(t).setRotation(r);
      (parent ?? scene).addChild(n);
      return n;
    };
    const vm = node(VIEWMODEL_SKELETON);
    const rm = node('root_motion', vm, [0, 0, 0], [-0.5, -0.5, -0.5, 0.5]);
    const wpn = node('wpn', rm, [0.4318, 0, 0]);
    node('wpnTip', wpn, [0.15, 0, 0]);
    const hand = node('hand_R', node('arm_lower_R', rm, [0.1, 0, 0]), [0.28, 0, 0]);
    node('attachHand_R', hand, [0.1, 0, 0]);
    const ws = node('animation/skeletons/weapons/elite.vnmskel');
    const weapon = node('weapon', ws, [0, 0, 0], [-0.5, -0.5, -0.5, 0.5]);
    const left = node('weapon_hand_l', weapon, [0, 0.508, 0.0051]);
    const bolt = node('slide_r', weapon, [-0.06, 0, 0.04]);
    const anim = doc.createAnimation('clip');
    const track = (target, path, values, type) => {
      const smp = doc.createAnimationSampler()
        .setInput(doc.createAccessor().setType('SCALAR').setArray(new Float32Array([0, 0.5])).setBuffer(buffer))
        .setOutput(doc.createAccessor().setType(type).setArray(new Float32Array(values)).setBuffer(buffer));
      anim.addSampler(smp).addChannel(doc.createAnimationChannel().setTargetNode(target).setTargetPath(path).setSampler(smp));
    };
    track(hand, 'rotation', [0, 0, 0, 1, 0, 0.2, 0, 0.98], 'VEC4');
    track(hand, 'translation', [0.28, 0, 0, 0.28, 0, 0], 'VEC3'); // at rest: dropped
    track(doc.getRoot().listNodes().find((n) => n.getName() === 'attachHand_R'), 'translation', [0.1, 0, 0, 0.2, 0, 0], 'VEC3');
    track(left, 'translation', [0, 0.508, 0.0051, 0, 0.1, 0], 'VEC3');
    track(bolt, 'translation', [-0.06, 0, 0.04, -0.1, 0, 0.04], 'VEC3');
    return doc;
  }

  test('copySkeleton copies the skeleton under the rig root without helpers', () => {
    const doc = new Document();
    doc.createScene();
    const { root, bones } = copySkeleton(doc, clipExport());
    expect(root.getName()).toBe(RIG_ROOT);
    expect([...bones.keys()].sort()).toEqual(['arm_lower_R', 'hand_R', 'root_motion', 'wpn']);
    expect(bones.get('root_motion').getRotation()).toEqual([-0.5, -0.5, -0.5, 0.5]);
    expect(bones.get('wpn').getTranslation()[0]).toBeCloseTo(0.4318, 6);
  });

  test('copyClip keeps moving viewmodel bones, drops helpers, rest tracks and the weapon skeleton', () => {
    const doc = new Document();
    doc.createBuffer();
    doc.createScene();
    const src = clipExport();
    const { bones } = copySkeleton(doc, src);
    const c = copyClip(doc, bones, src, 'idle');
    expect(c).toMatchObject({ kept: 1, atRest: 1, skipped: 3, seconds: 0.5 });
    expect(c.anim.getName()).toBe('idle');
    expect(c.anim.listChannels().map((ch) => `${ch.getTargetNode().getName()}.${ch.getTargetPath()}`)).toEqual(['hand_R.rotation']);
  });

  test('a kept weapon bone hangs under wpn and keeps its channel (the Dual Berettas\' left pistol)', () => {
    expect(WEAPON_BONES_KEPT.elite).toEqual(['weapon_hand_l', 'weapon_hand_r']);
    expect(WEAPON_BONES_KEPT.molotov).toEqual(['weapon_hand_l', 'weapon_hand_r']);
    expect(Object.keys(WEAPON_BONES_KEPT).sort()).toEqual(['elite', 'molotov']);
    const doc = new Document();
    doc.createBuffer();
    doc.createScene();
    const src = clipExport();
    const { bones } = copySkeleton(doc, src, ['weapon_hand_l']);
    const left = bones.get('weapon_hand_l');
    expect(left.listParents().find((p) => p.propertyType === 'Node').getName()).toBe('wpn');
    expect(left.getTranslation()).toEqual([0, 0.508, 0.0051]);
    const c = copyClip(doc, bones, src, 'shoot', ['weapon_hand_l']);
    expect(c.anim.listChannels().map((ch) => `${ch.getTargetNode().getName()}.${ch.getTargetPath()}`).sort()).toEqual(['hand_R.rotation', 'weapon_hand_l.translation']);
  });

  test('an export without the viewmodel skeleton is an error', () => {
    const doc = new Document();
    expect(() => copySkeleton(doc, new Document())).toThrow(/viewmodel\.vnmskel/);
  });
});
