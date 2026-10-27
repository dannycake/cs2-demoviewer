// shrinkWeapon on a ground-only model (the kit): no `weapon` bone, no attach, and the report
// names the VRF that exported it, which a model added to an older rip carries on its own entry.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createIO } from '../lib/gltf.mjs';
import { GROUND_MODELS } from '../lib/weapons.mjs';
import { shrinkWeapon } from '../shrink-weapon.mjs';

let root;
let assets;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'shrink-weapon-test-'));
  assets = process.env.ASSETS_DIR;
  process.env.ASSETS_DIR = root;
});
afterEach(() => {
  if (assets === undefined) delete process.env.ASSETS_DIR;
  else process.env.ASSETS_DIR = assets;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The kit's export as VRF writes it: one mesh skinned to `weapon_hand_r`. */
async function writeKit(file) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('defuser.vmdl_c');
  const acc = (type, array) => doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  const top = doc.createNode('weapons/models/defuser/defuser.vmdl_c');
  const hand = doc.createNode('weapon_hand_r');
  top.addChild(hand);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc('VEC3', new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0, 0.1, 0.1, 0])))
    .setAttribute('JOINTS_0', acc('VEC4', new Uint8Array(16)))
    .setAttribute('WEIGHTS_0', acc('VEC4', new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])))
    .setIndices(acc('SCALAR', new Uint16Array([0, 1, 2, 1, 3, 2])));
  const skin = doc.createSkin().addJoint(hand).setInverseBindMatrices(acc('MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])));
  const body = doc.createNode('weapons/models/defuser/defuser.vmdl_c.w_defuser_bg_studio_lod0')
    .setMesh(doc.createMesh('body').addPrimitive(prim)).setSkin(skin);
  scene.addChild(top).addChild(body);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await new NodeIO().write(file, doc);
}

describe('shrinkWeapon', () => {
  test('shrinks the kit without an attach, naming the VRF of its own entry, else the rip\'s', async () => {
    await writeKit(path.join(root, 'raw', 'weapons', 'defuser', 'defuser.glb'));
    const io = await createIO();
    const entry = { vmdl: GROUND_MODELS.defuser, glb: 'defuser/defuser.glb' };
    const rip = { cs2Build: '2000935', vrfVersion: '20.1.old', models: { defuser: { ...entry, vrfVersion: '20.1.new' } } };
    const r = await shrinkWeapon('defuser', io, rip);
    expect(r.attach).toBeNull();
    expect(r.raw).toEqual({ glb: 'defuser/defuser.glb', cs2Build: '2000935', vrfVersion: '20.1.new' });
    const out = path.join(root, 'weapons');
    expect(fs.readdirSync(out).sort()).toEqual(['defuser.glb', 'defuser.glb.gz', 'defuser.shrink.json']);
    const back = await io.read(path.join(out, 'defuser.glb'));
    expect(back.getRoot().listSkins()).toHaveLength(0);
    expect(back.getRoot().listScenes()[0].getExtras().attach).toBeUndefined();

    const old = await shrinkWeapon('defuser', io, { ...rip, models: { defuser: entry } });
    expect(old.raw.vrfVersion).toBe('20.1.old');
  });
});
