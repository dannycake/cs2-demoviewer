// A skinned model as Source2Viewer-CLI exports it, for the pose tests (poses.test.mjs) and the
// pose table's generator (model-poses.test.mjs).
import { Document } from '@gltf-transform/core';
import * as THREE from 'three';

/**
 * A model as Source2Viewer-CLI exports it with --gltf_export_animations: a chain of bones, a
 * skinned mesh, clips. A key with `cubic` is a CUBICSPLINE sampler whose tangents are `cubic`.
 * `joints` are the mesh's three vertices' JOINTS_0 (4 per vertex; by default bones 1, 1 and 0/1).
 */
export function skinnedModel({ bind, clips, joints = [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0] }) {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene();
  const root = doc.createNode('models/x.vmdl_c');
  scene.addChild(root);
  const bones = [];
  let parent = root;
  for (const b of bind) {
    const bone = doc.createNode(b.name).setTranslation(b.t ?? [0, 0, 0]).setRotation(b.r ?? [0, 0, 0, 1]);
    parent.addChild(bone);
    bones.push(bone);
    parent = bone;
  }
  const ibm = bones.flatMap((b) => new THREE.Matrix4().fromArray(b.getWorldMatrix()).invert().toArray());
  const skin = doc.createSkin().setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(new Float32Array(ibm)).setBuffer(buffer));
  for (const b of bones) skin.addJoint(b);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(buffer))
    .setAttribute('JOINTS_0', doc.createAccessor().setType('VEC4').setArray(new Uint8Array(joints)).setBuffer(buffer))
    .setAttribute('WEIGHTS_0', doc.createAccessor().setType('VEC4').setArray(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.5, 0, 0])).setBuffer(buffer));
  scene.addChild(doc.createNode('models/x.vmdl_c.body').setMesh(doc.createMesh().addPrimitive(prim)).setSkin(skin));
  for (const [name, keys] of Object.entries(clips)) {
    const anim = doc.createAnimation(name);
    keys.forEach((k, i) => {
      for (const [path, value, type] of [['translation', k.t, 'VEC3'], ['rotation', k.r, 'VEC4']]) {
        if (!value) continue;
        const tangent = k.cubic && Array(value.length).fill(k.cubic);
        const sampler = doc.createAnimationSampler()
          .setInput(doc.createAccessor().setArray(new Float32Array([0])).setBuffer(buffer))
          .setOutput(doc.createAccessor().setType(type).setArray(new Float32Array(tangent ? [...tangent, ...value, ...tangent] : value)).setBuffer(buffer))
          .setInterpolation(tangent ? 'CUBICSPLINE' : 'LINEAR');
        anim.addSampler(sampler).addChannel(doc.createAnimationChannel().setTargetNode(bones[i]).setTargetPath(path).setSampler(sampler));
      }
    });
  }
  return doc;
}
