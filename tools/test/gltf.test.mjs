import { Document } from '@gltf-transform/core';
import { describe, expect, it } from 'vitest';
import { stripAttributes } from '../lib/gltf.mjs';

describe('stripAttributes', () => {
  it('keeps JOINTS_n and WEIGHTS_n on a mesh a skinned node draws, and strips them elsewhere', () => {
    const doc = new Document();
    const buffer = doc.createBuffer();
    const scene = doc.createScene();
    const accessor = (type, n) => doc.createAccessor().setType(type).setArray(new Float32Array(n)).setBuffer(buffer);
    const mesh = (name) => doc.createMesh(name).addPrimitive(doc.createPrimitive()
      .setAttribute('POSITION', accessor('VEC3', 9))
      .setAttribute('JOINTS_0', accessor('VEC4', 12))
      .setAttribute('WEIGHTS_0', accessor('VEC4', 12))
      .setAttribute('_TEXCOORD_4', accessor('VEC2', 6)));
    const skin = doc.createSkin().addJoint(doc.createNode('bone'));
    const skinned = mesh('skinned');
    const bare = mesh('bare');
    scene.addChild(doc.createNode('a').setMesh(skinned).setSkin(skin));
    scene.addChild(doc.createNode('b').setMesh(bare));
    const semantics = (m) => m.listPrimitives()[0].listSemantics().sort();

    expect(stripAttributes(doc, ['_TEXCOORD_4', 'JOINTS_0', 'WEIGHTS_0', 'COLOR_0'])).toBe(4);
    expect(semantics(skinned)).toEqual(['JOINTS_0', 'POSITION', 'WEIGHTS_0']);
    expect(semantics(bare)).toEqual(['POSITION']);
  });
});
