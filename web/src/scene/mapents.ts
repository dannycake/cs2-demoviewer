// The map's doors and breakables (`/maps/<map>/entities.glb`, tools/README.md): one root node
// per entity at its spawn transform, named by hammer id, with the entity lump's `classname`,
// `origin` (Source units) and `angles` in its extras. `bind` finds each of a pack's entities its
// node by spawn position and class; `set` turns each door to its angles at (round, tick) and
// hides each window from its break, which throws glass chips and a puff of dust for a moment.
// A node no pack entity finds stays at its spawn transform. The nodes draw at render order 0,
// with the world, so the team x-ray (outline.ts) shows players behind a door as behind a wall.
// Everything is made up front; posing allocates nothing.

import * as THREE from 'three';
import { sourceAnglesToQuaternion } from '../geo/coords';
import type { MapEntity, Pack } from '../pack/types';
import type { EntityPose, MapEntityIndex } from '../sim/mapents';
import type { Atlas, EffectAtlases } from './effects';
import { FlipbookBatch, onceFrame } from './flipbook';
import { disposeObject } from './loaders';
import { seeded } from '../sim/random';
import { puffTexture } from './noise';

/** How far, in Source units, a pack entity's spawn may be from its node's `origin`. */
export const MATCH_UNITS = 2;

/** The entity-lump classes each kind of pack entity may be. */
export const CLASSES: Readonly<Record<MapEntity['kind'], readonly string[]>> = {
  door: ['prop_door_rotating', 'func_door_rotating', 'func_door'],
  breakable: ['func_breakable'],
};

/** A window's break: chips of glass flying out and a puff of dust, at its middle. */
export const BREAK = Object.freeze({
  /** Seconds it is drawn. */
  lifeS: 0.6,
  chips: 8,
  /** A chip's size, metres. */
  chipM: [0.05, 0.12] as const,
  /** Outwards and upwards, metres a second. */
  outMs: [1.2, 2.8] as const,
  upMs: [0.3, 2.2] as const,
  gravity: 9.8,
  /** Turns a second a chip spins, at most. */
  spin: 2,
  /** The `debris` atlas frames that are shards of glass, from its sequence's first. */
  shards: 3,
  /** The dust puff's size as it grows, metres. */
  dustM: [0.5, 1.6] as const,
  /** Its opacity, held for the first `dustHold` of its life and then faded out. */
  dustAlpha: 1,
  dustHold: 0.4,
  /**
   * Its tint over the `dust` atlas, linear and above 1: the atlas is dark smoke (about 0.09
   * linear where it is opaque), and this lifts it to light plaster and glass dust (about 0.55
   * linear, 0.88 once exposed at `dustExposure`) that reads against the dark wall behind a
   * window.
   */
  dustTint: [6.4, 6.1, 5.6] as const,
  /** Its colour over the generated puff (no atlas), which is light already. */
  dustPlain: 0xbdb8ae,
  /**
   * The tone mapping's exposure the dust's colours were chosen under: Mirage's without its
   * bake. The dust is drawn as the screen should show it there (its colour times this, the
   * exposure of the frame divided out), so it reads as the same light dust at every map's
   * exposure, baked (Mirage 1.3, Nuke 1.2) or not.
   */
  dustExposure: 1.6,
});

interface Node {
  object: THREE.Object3D;
  classname: string;
  origin: [number, number, number] | null;
  spawn: THREE.Quaternion;
  spawnVisible: boolean;
  /** The middle of its bounding box at spawn, scene metres. */
  centre: THREE.Vector3;
}

const _q = new THREE.Quaternion();
const _white = new THREE.Color(1, 1, 1);
const _dustTint = new THREE.Color()
  .setRGB(...BREAK.dustTint)
  .multiplyScalar(BREAK.dustExposure);
const _dustPlain = new THREE.Color(BREAK.dustPlain).multiplyScalar(
  BREAK.dustExposure
);

export class MapEntities {
  /** The models and the break's sprites; add it to the scene. */
  readonly root = new THREE.Group();
  /** The entities.glb scene this was made with: what the look dresses. */
  readonly models: THREE.Group;
  private readonly effects: EffectAtlases;
  private readonly nodes: Node[];
  /** Per node and chip: velocity x, y, z (m/s), size (m), spin (rad/s), first turn (rad), frame. */
  private readonly chips: Float32Array;
  private readonly debris: FlipbookBatch;
  private readonly dust: FlipbookBatch;
  /** What the break draws until (or unless) its atlases arrive. */
  private readonly fallback: THREE.Texture;
  /** The pack `bind` matched, and per pack entity its node (-1 for none). */
  private pack: Pack | null = null;
  private nodeOf = new Int32Array(0);
  private warned = false;
  private readonly pose: EntityPose = {
    visible: true,
    spawn: true,
    pitch: 0,
    yaw: 0,
    roll: 0,
  };
  private readonly broken: number[] = [];
  /**
   * Each node's rotation (x, y, z, w) and visibility as the last `set` left them; NaN before
   * the first, so the first `set` reports a change.
   */
  private readonly posed: Float64Array;

  constructor(entitiesScene: THREE.Group, effects: EffectAtlases) {
    this.models = entitiesScene;
    this.effects = effects;
    this.root.name = 'entities';
    entitiesScene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.nodes = entitiesScene.children.map((object) => {
      const extras = object.userData as {
        classname?: unknown;
        origin?: unknown;
      };
      const origin = extras.origin;
      box.setFromObject(object);
      return {
        object,
        classname: typeof extras.classname === 'string' ? extras.classname : '',
        origin:
          Array.isArray(origin) &&
          origin.length === 3 &&
          origin.every((v) => typeof v === 'number')
            ? (origin as [number, number, number])
            : null,
        spawn: object.quaternion.clone(),
        spawnVisible: object.visible,
        centre: box.isEmpty()
          ? object.getWorldPosition(new THREE.Vector3())
          : box.getCenter(new THREE.Vector3()),
      };
    });
    this.posed = new Float64Array(this.nodes.length * 5).fill(Number.NaN);
    const n = Math.max(1, this.nodes.length);
    this.chips = new Float32Array(n * BREAK.chips * 7);
    for (let i = 0; i < n; i++) {
      const rand = seeded(7919 * (i + 1));
      for (let c = 0; c < BREAK.chips; c++) {
        const o = (i * BREAK.chips + c) * 7;
        const a = ((c + rand()) / BREAK.chips) * Math.PI * 2;
        const out = between(BREAK.outMs, rand());
        this.chips[o] = Math.sin(a) * out;
        this.chips[o + 1] = between(BREAK.upMs, rand());
        this.chips[o + 2] = Math.cos(a) * out;
        this.chips[o + 3] = between(BREAK.chipM, rand());
        this.chips[o + 4] = (rand() * 2 - 1) * BREAK.spin * Math.PI * 2;
        this.chips[o + 5] = rand() * Math.PI * 2;
        this.chips[o + 6] = c % BREAK.shards;
      }
    }
    this.fallback = puffTexture(32, 13);
    const opts = {
      blending: 'alpha',
      facing: 'camera',
      emissive: false,
    } as const;
    this.debris = new FlipbookBatch(n * BREAK.chips, opts);
    // Its colour is the screen's: the tone mapping's exposure is divided out (`set`).
    this.dust = new FlipbookBatch(n, { ...opts, emissive: true });
    this.debris.mesh.name = 'break-debris';
    this.dust.mesh.name = 'break-dust';
    for (const b of [this.debris, this.dust]) {
      b.setAtlas(null, this.fallback);
      b.mesh.visible = false;
    }
    this.root.add(entitiesScene, this.debris.mesh, this.dust.mesh);
  }

  /**
   * Matches `pack`'s entities to the nodes: each to the nearest node not yet taken whose
   * `origin` is within `MATCH_UNITS` and whose class fits its kind. What matches nothing on
   * either side is warned about once in the life of this map (a pack without `ENT1` has no
   * entities, and so nothing to warn about) and stays at spawn. Every node starts at spawn.
   */
  bind(pack: Pack): void {
    this.pack = pack;
    this.nodeOf = new Int32Array(pack.entities.length).fill(-1);
    for (const n of this.nodes) toSpawn(n);
    const taken = new Set<number>();
    const lost: string[] = [];
    pack.entities.forEach((e, i) => {
      let best = -1;
      let bestD = MATCH_UNITS;
      this.nodes.forEach((n, k) => {
        if (taken.has(k) || !n.origin || !CLASSES[e.kind].includes(n.classname))
          return;
        const d = Math.hypot(
          n.origin[0] - e.x,
          n.origin[1] - e.y,
          n.origin[2] - e.z
        );
        if (d <= bestD) {
          best = k;
          bestD = d;
        }
      });
      if (best < 0) lost.push(`${e.kind} at (${e.x}, ${e.y}, ${e.z})`);
      else {
        taken.add(best);
        this.nodeOf[i] = best;
      }
    });
    // GLTFLoader drops the colons of a hammer id from the node's name: the origin says more.
    const alone = this.nodes
      .filter((_, k) => !taken.has(k))
      .map(
        (n) =>
          `${n.classname || 'node'} ${n.object.name}` +
          (n.origin ? ` at (${n.origin.join(', ')})` : '')
      );
    if (pack.entities.length === 0 || (!lost.length && !alone.length)) return;
    if (this.warned) return;
    this.warned = true;
    const parts = [];
    if (lost.length)
      parts.push(`the demo's ${lost.join(', ')} match nothing in entities.glb`);
    if (alone.length)
      parts.push(
        `entities.glb's ${alone.join(', ')} match nothing in the demo`
      );
    console.warn(`entities: ${parts.join('; ')}; they stay at spawn`);
  }

  /**
   * Poses the bound pack's entities at `tick` (a float) of round `round` from `index` (made
   * from that pack), and draws the breaks of the last `BREAK.lifeS`, their dust with the tone
   * mapping's `exposure` divided out (1 when not tone-mapped). An index of another pack
   * changes nothing. Returns whether any node turned, showed or hid since the last call (or
   * since `bind` put them at spawn): what the sun's shadow of the world holds (lighting.ts
   * `drawWorldShadow`) must then be drawn again.
   */
  set(
    round: number,
    tick: number,
    index: MapEntityIndex,
    tickRate: number,
    exposure = 1
  ): boolean {
    this.dust.setExposure(exposure);
    if (index.pack !== this.pack) return this.moved();
    const pose = this.pose;
    for (let e = 0; e < this.nodeOf.length; e++) {
      const k = this.nodeOf[e];
      if (k < 0) continue;
      const n = this.nodes[k];
      index.poseAt(e, round, tick, pose);
      if (pose.spawn) toSpawn(n);
      else {
        n.object.quaternion.copy(
          sourceAnglesToQuaternion(pose.pitch, pose.yaw, pose.roll, _q)
        );
        n.object.visible = pose.visible;
      }
    }
    this.drawBreaks(round, tick, index, tickRate);
    return this.moved();
  }

  /** Whether any node's rotation or visibility differs from the last call's; records them. */
  private moved(): boolean {
    let moved = false;
    const p = this.posed;
    for (let k = 0; k < this.nodes.length; k++) {
      const n = this.nodes[k].object;
      const q = n.quaternion;
      const o = 5 * k;
      const v = n.visible ? 1 : 0;
      if (
        p[o] === q.x &&
        p[o + 1] === q.y &&
        p[o + 2] === q.z &&
        p[o + 3] === q.w &&
        p[o + 4] === v
      )
        continue;
      moved = true;
      p[o] = q.x;
      p[o + 1] = q.y;
      p[o + 2] = q.z;
      p[o + 3] = q.w;
      p[o + 4] = v;
    }
    return moved;
  }

  dispose(): void {
    this.root.removeFromParent();
    disposeObject(this.models);
    this.debris.dispose();
    this.dust.dispose();
    this.fallback.dispose();
  }

  private drawBreaks(
    round: number,
    tick: number,
    index: MapEntityIndex,
    tickRate: number
  ): void {
    const count = index.breaksAt(
      round,
      tick,
      BREAK.lifeS * tickRate,
      this.broken
    );
    this.debris.begin();
    this.dust.begin();
    if (count > 0) {
      // Asked for only now: nothing under /effects/ loads before a window breaks.
      const debris = this.effects.get('debris');
      const dust = this.effects.get('dust');
      this.debris.setAtlas(debris, this.fallback);
      this.dust.setAtlas(dust, this.fallback);
      for (let i = 0; i < count; i++) {
        const e = this.broken[i];
        const k = this.nodeOf[e] ?? -1;
        const at = index.breakTick(e, round);
        if (k < 0 || at === null) continue;
        const age = (tick - at) / tickRate;
        this.pushBreak(k, age, debris, dust);
      }
    }
    this.debris.end();
    this.dust.end();
  }

  /** Node `k`'s chips and dust `age` seconds after it broke, from the atlases once they are in. */
  private pushBreak(
    k: number,
    age: number,
    debris: Atlas | null,
    dust: Atlas | null
  ): void {
    const shards = debris?.sequences[0];
    const t = Math.min(1, Math.max(0, age / BREAK.lifeS));
    const c = this.nodes[k].centre;
    const fade = Math.min(1, (1 - t) / 0.4);
    for (let i = 0; i < BREAK.chips; i++) {
      const o = (k * BREAK.chips + i) * 7;
      const ch = this.chips;
      this.debris.push(
        c.x + ch[o] * age,
        c.y + ch[o + 1] * age - 0.5 * BREAK.gravity * age * age,
        c.z + ch[o + 2] * age,
        ch[o + 3],
        ch[o + 3],
        ch[o + 5] + ch[o + 4] * age,
        shards ? shards[0] + Math.min(ch[o + 6], shards[1] - 1) : 0,
        _white,
        fade
      );
    }
    const puff = dust?.sequences[0];
    const frame = puff ? onceFrame(puff, age, BREAK.lifeS) : 0;
    if (frame === null) return;
    const size = between(BREAK.dustM, 1 - (1 - t) * (1 - t));
    this.dust.push(
      c.x,
      c.y,
      c.z,
      size * (dust?.aspect ?? 1),
      size,
      this.chips[k * BREAK.chips * 7 + 5],
      frame,
      dust ? _dustTint : _dustPlain,
      BREAK.dustAlpha * Math.min(1, (1 - t) / (1 - BREAK.dustHold))
    );
  }
}

function toSpawn(n: Node): void {
  n.object.quaternion.copy(n.spawn);
  n.object.visible = n.spawnVisible;
}

/** The value `t` (0..1) of the way across `[a, b]`. */
function between(range: readonly [number, number], t: number): number {
  return range[0] + (range[1] - range[0]) * t;
}
