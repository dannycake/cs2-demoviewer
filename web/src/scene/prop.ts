// One GLB prop put in the scene for the homepage video (`tools/home-video.mjs`): the CS2 chicken
// in Dust 2's mid. It is dressed in the players' look and lit by the map's light grid as
// an item on the ground is (`ItemLight`), casts the sun's shadow, and is posed only when asked
// (`pose`): where it stands, which way it faces and how far into which clip, so a frame-by-frame
// capture that poses it from the replay's clock draws the same frame every time.

import * as THREE from 'three';
import { ItemLight } from './itemlight';
import { loadGltf } from './loaders';
import { modelDresser, type LookMaterial, type LookOptions } from './look';
import type { LightGrid } from './probes';

/** Where and how the prop stands, in scene metres and degrees. */
export interface PropPose {
  x: number;
  y: number;
  z: number;
  /** Turn about the up axis, degrees (0 faces the scene's +z, the Source +x). */
  yaw: number;
  /** The clip shown, by name, and the seconds into it (wrapped by its length). */
  clip: string;
  t: number;
  /** A second clip blended over the first with weight `w` (0..1), for a walk easing in. */
  clip2?: string;
  t2?: number;
  w?: number;
  /** Uniform scale over the file's own; 1 by default. */
  scale?: number;
}

export class Prop {
  readonly root = new THREE.Group();
  readonly clips: string[];
  readonly durations: number[];
  private readonly mixer: THREE.AnimationMixer;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private readonly materials: LookMaterial[] = [];
  private readonly light = new ItemLight(true);
  private readonly chest = new THREE.Vector3();
  /** The model's height in metres as loaded, for the light's sample point. */
  readonly height: number;

  private constructor(model: THREE.Object3D, clips: THREE.AnimationClip[]) {
    this.root.name = 'prop';
    this.root.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    for (const c of clips) {
      // The walk's root motion would carry the model off its spot: the pose places it.
      const tracks = c.tracks.filter(
        (t) => !/^root_motion\.position$/.test(t.name)
      );
      const clip = new THREE.AnimationClip(c.name, c.duration, tracks);
      const a = this.mixer.clipAction(clip);
      a.play();
      a.setEffectiveWeight(0);
      this.actions.set(c.name, a);
    }
    this.clips = clips.map((c) => c.name);
    this.durations = clips.map((c) => c.duration);
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    this.height = Math.max(0.1, box.max.y - box.min.y);
    this.light.add(model);
  }

  /** A prop of a model already loaded, undressed (tests). */
  static fromModel(model: THREE.Object3D, clips: THREE.AnimationClip[]): Prop {
    return new Prop(model, clips);
  }

  /** Loads the GLB at `url`, dressed in `look`. */
  static async load(url: string, look: LookOptions): Promise<Prop> {
    const gltf = await loadGltf(url);
    const model = gltf.scene;
    const materials: LookMaterial[] = [];
    const dress = modelDresser(look, materials);
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      dress(mesh);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // A skinned mesh's bounds are its bind pose's: the clips move it past them.
      mesh.frustumCulled = false;
    });
    const p = new Prop(model, gltf.animations);
    p.materials.push(...materials);
    return p;
  }

  /** Poses the prop (`PropPose`) and lights it by `grid` where it stands. */
  pose(p: PropPose, grid: LightGrid | null): void {
    this.root.position.set(p.x, p.y, p.z);
    this.root.rotation.set(0, (p.yaw * Math.PI) / 180, 0);
    this.root.scale.setScalar(p.scale ?? 1);
    const w2 = p.clip2 ? Math.min(1, Math.max(0, p.w ?? 0)) : 0;
    for (const [name, a] of this.actions) {
      const d = a.getClip().duration || 1;
      if (name === p.clip) {
        a.setEffectiveWeight(1 - w2);
        a.time = ((p.t % d) + d) % d;
      } else if (name === p.clip2) {
        a.setEffectiveWeight(w2);
        a.time = ((((p.t2 ?? p.t) % d) + d) % d) as number;
      } else a.setEffectiveWeight(0);
    }
    this.mixer.update(0);
    this.root.updateMatrixWorld(true);
    this.chest
      .copy(this.root.position)
      .setY(this.root.position.y + 0.5 * this.height * (p.scale ?? 1) + 0.3);
    this.light.set(grid, this.chest);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    for (const m of this.materials) m.dispose();
  }
}
