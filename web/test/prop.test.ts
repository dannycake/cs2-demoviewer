// A GLB prop in the scene (the homepage video's chicken): posed only when asked, so a frame-by-frame
// capture that poses it from the replay's clock draws the same frame every time.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { Prop, type PropPose } from '../src/scene/prop';

/** A model with one bone, and a clip `idle` moving it along x over 2 s. */
function model(): { model: THREE.Object3D; clips: THREE.AnimationClip[] } {
  const root = new THREE.Group();
  const bone = new THREE.Bone();
  bone.name = 'b';
  root.add(bone);
  const track = new THREE.VectorKeyframeTrack(
    'b.position',
    [0, 2],
    [0, 0, 0, 2, 0, 0]
  );
  const walk = new THREE.VectorKeyframeTrack(
    'b.position',
    [0, 1],
    [0, 0, 0, 0, 0, 3]
  );
  return {
    model: root,
    clips: [
      new THREE.AnimationClip('idle', 2, [track]),
      new THREE.AnimationClip('walk', 1, [walk]),
    ],
  };
}

const state = (p: Prop) => {
  const b = p.root.getObjectByName('b')!;
  return [...p.root.matrixWorld.elements, ...b.position.toArray()];
};

describe('Prop', () => {
  it('poses a prop the same way twice for the same pose (deterministic frames)', () => {
    const { model: m, clips } = model();
    const p = Prop.fromModel(m, clips);
    expect(p.clips).toEqual(['idle', 'walk']);
    const a: PropPose = { x: 1, y: 0.5, z: -2, yaw: 90, clip: 'idle', t: 0.5 };
    p.pose(a, null);
    const first = state(p);
    expect(p.root.getObjectByName('b')!.position.x).toBeCloseTo(0.5);
    p.pose({ x: 9, y: 9, z: 9, yaw: 10, clip: 'walk', t: 0.7 }, null);
    expect(state(p)).not.toEqual(first);
    p.pose(a, null);
    expect(state(p)).toEqual(first);
    // Seconds wrap by the clip's length.
    p.pose({ ...a, t: 2.5 }, null);
    expect(state(p)).toEqual(first);
    p.dispose();
  });
});
