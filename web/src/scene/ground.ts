// Weapons, grenades and defuse kits lying where they fell (`GroundIndex`): a pool of
// `GROUND_POOL` slots made up front, each posed at its item's place and angles and showing a
// copy of the item's weapon model, hidden until the model has loaded. Past the pool the oldest
// items are left out. The copies come from a pool per weapon: a slot borrows a free copy of its
// item's weapon and gives it back when it shows something else, and a copy is made only when
// none is free. Items fill the slots newest first, so one put down or picked up moves the others
// between slots; the copies just change hands. A weapon ends with as many copies as ever lay at
// once, and a warm pool makes nothing more, playing again or seeking. Posing allocates nothing
// but in three's re-parenting of a copy that changes hands, and a copy out of the scene costs no
// matrix update. The copies are dressed in the scene's look as the players' weapons are
// (`cloneWeapon`), which also sets the cache's shared textures' filtering: an undressed copy
// would draw differently once a player had held that weapon, so what a frame shows would depend
// on what was played before it. Each copy has materials of its own, and its own light, so that
// on a baked map each item takes the light grid where it lies (`ItemLight`), sampled when it is
// put down, moves or lands on another item, not while it lies still. They are freed only with
// the look (`setLook`) or on `dispose`.

import * as THREE from 'three';
import { sourceAnglesToQuaternion, toScene, UNIT } from '../geo/coords';
import type { GroundIndex, GroundPose } from '../sim/ground';
import { FLOOR_LIFT, ItemLight } from './itemlight';
import type { LookMaterial, LookOptions } from './look';
import { OUTLINE } from './outline';
import type { LightGrid } from './probes';
import { cloneWeapon, type WeaponCache } from './weapons';

/** The most items drawn at once: a round of ten players' guns, grenades and kits. */
export const GROUND_POOL = 48;

/** A copy of a weapon model, in materials of its own, lit where the item it shows lies. */
interface Copy {
  object: THREE.Object3D;
  /** The weapon it is a copy of. */
  weapon: string;
  materials: LookMaterial[];
  light: ItemLight;
}

/** A weapon's copies: all it has, and those no slot shows. */
interface Pool {
  all: Copy[];
  free: Copy[];
}

interface Slot {
  group: THREE.Group;
  /** The copy it borrowed and shows in `group`, or null. */
  shown: Copy | null;
  /** The item in it, for `debug`. */
  id: number;
  weapon: string;
}

const turn = new THREE.Quaternion();
const lifted = new THREE.Vector3();

export class GroundItems {
  readonly root = new THREE.Group();
  private readonly weapons: WeaponCache;
  private look: LookOptions;
  private readonly slots: Slot[];
  private readonly poses: GroundPose[];
  /** Per weapon name, its copies. */
  private readonly pools = new Map<string, Pool>();
  /** The grid the last `set` lit the items by, for `debug`. */
  private grid: LightGrid | null = null;
  /** What the last `set` posed, for `debug`: its round and tick, and the items hidden while their model loads. */
  private posedRound = -1;
  private posedTick = Number.NaN;
  private waiting = 0;

  constructor(weapons: WeaponCache, look: LookOptions) {
    this.weapons = weapons;
    this.look = look;
    this.root.name = 'ground';
    this.slots = Array.from({ length: GROUND_POOL }, () => {
      const group = new THREE.Group();
      group.name = 'ground-item';
      group.visible = false;
      this.root.add(group);
      return { group, shown: null, id: -1, weapon: '' };
    });
    this.poses = Array.from({ length: GROUND_POOL }, () => ({
      id: 0,
      weapon: '',
      x: 0,
      y: 0,
      z: 0,
      pitch: 0,
      yaw: 0,
      roll: 0,
    }));
  }

  /**
   * Poses the items lying in round `round` at `tick` (a float). An item whose model is not
   * in the cache yet is hidden; asking for it starts its load, and a later call shows it. With
   * `grid` (a baked map's) each item shown is lit by it `FLOOR_LIFT` above where it lies,
   * sampled again only when it moves; without, by the scene's light.
   */
  set(
    round: number,
    tick: number,
    index: GroundIndex,
    grid: LightGrid | null = null
  ): void {
    const n = index.at(round, tick, this.poses, GROUND_POOL);
    this.posedRound = round;
    this.posedTick = tick;
    this.waiting = 0;
    this.grid = grid;
    // Copies whose slot now shows another weapon, or nothing, go back first, so the slots
    // after them can borrow them this very frame.
    for (let i = 0; i < GROUND_POOL; i++) {
      const slot = this.slots[i];
      const c = slot.shown;
      if (c && (i >= n || this.poses[i].weapon !== c.weapon)) {
        slot.group.remove(c.object);
        this.pools.get(c.weapon)?.free.push(c);
        slot.shown = null;
      }
    }
    for (let i = 0; i < GROUND_POOL; i++) {
      const slot = this.slots[i];
      const p = this.poses[i];
      if (i < n && !slot.shown) {
        const c = this.borrow(p.weapon);
        if (c) {
          slot.group.add(c.object);
          slot.shown = c;
        }
      }
      const c = slot.shown;
      slot.group.visible = c !== null;
      if (!c) {
        // A model that failed (or is not in the manifest) never comes: nothing waits on it.
        if (i < n && this.weapons.loading(p.weapon)) this.waiting++;
        continue;
      }
      slot.id = p.id;
      slot.weapon = p.weapon;
      toScene(p.x, p.y, p.z, slot.group.position);
      slot.group.quaternion.copy(
        sourceAnglesToQuaternion(p.pitch, p.yaw, p.roll, turn)
      );
      lifted.copy(slot.group.position).y += FLOOR_LIFT;
      c.light.set(grid, lifted);
    }
  }

  /**
   * What the last `set` posed, for the debug handle and the e2e: its round and tick (−1 and NaN
   * when nothing is posed), how many items it hid while their model loads (not those whose
   * model failed, which never shows), and the items drawn, in Source units, each with the
   * grid's sun where it lies (0 in the shade, 1 in the sun) or null when no grid lights it, and,
   * with `view` (the camera drawn last and the canvas's size in CSS pixels), the rectangle its
   * model's bounds cover on screen, `[left, top, right, bottom]` (null without).
   */
  debug(view?: { camera: THREE.Camera; width: number; height: number }): {
    round: number;
    tick: number;
    waiting: number;
    items: {
      id: number;
      weapon: string;
      x: number;
      y: number;
      z: number;
      sun: number | null;
      screen: [number, number, number, number] | null;
    }[];
  } {
    return {
      round: this.posedRound,
      tick: this.posedTick,
      waiting: this.waiting,
      items: this.slots
        .filter((s) => s.group.visible)
        .map((s) => {
          const p = s.group.position;
          return {
            id: s.id,
            weapon: s.weapon,
            x: p.z / UNIT,
            y: p.x / UNIT,
            z: p.y / UNIT,
            sun: this.grid && s.shown ? s.shown.light.sample.sun : null,
            screen: view ? onScreen(s.group, view) : null,
          };
        }),
    };
  }

  /** Dresses the items in `look` from the next `set` on, freeing the old dress. */
  setLook(look: LookOptions): void {
    this.look = look;
    this.drop();
  }

  /** Takes the pool out of the scene and frees its materials; the geometry is the cache's. */
  dispose(): void {
    this.root.removeFromParent();
    this.drop();
  }

  /**
   * Drops every copy and frees their materials; the next `set` makes them again and poses the
   * pool. Until then nothing shows, and `debug` claims no frame.
   */
  private drop(): void {
    for (const s of this.slots) {
      if (s.shown) s.group.remove(s.shown.object);
      s.shown = null;
      s.group.visible = false;
    }
    for (const pool of this.pools.values())
      for (const c of pool.all) for (const m of c.materials) m.dispose();
    this.pools.clear();
    this.posedRound = -1;
    this.posedTick = Number.NaN;
    this.waiting = 0;
  }

  /**
   * A free copy of `name` from its pool, or a new one in materials of its own when none is free
   * and the cache has the model; null until then.
   */
  private borrow(name: string): Copy | null {
    let pool = this.pools.get(name);
    const free = pool?.free.pop();
    if (free) return free;
    const src = this.weapons.get(name);
    if (!src) return null;
    const materials: LookMaterial[] = [];
    const object = cloneWeapon(src, this.look, materials, true);
    object.name = `ground:${name}`;
    // Drawn with the players, after the x-ray (`OUTLINE`): at the world's order the x-ray
    // would take a gun for a wall and paint the silhouette of a player behind it over it.
    object.traverse((o) => {
      o.renderOrder = OUTLINE.rigOrder;
    });
    const light = new ItemLight(true);
    light.add(object);
    const c: Copy = { object, weapon: name, materials, light };
    if (!pool) {
      pool = { all: [], free: [] };
      this.pools.set(name, pool);
    }
    pool.all.push(c);
    return c;
  }
}

/** The rectangle, in CSS pixels, the bounds of `o` cover in `view` (`GroundItems.debug`). */
function onScreen(
  o: THREE.Object3D,
  view: { camera: THREE.Camera; width: number; height: number }
): [number, number, number, number] {
  o.updateWorldMatrix(true, true);
  const box = new THREE.Box3().setFromObject(o);
  const p = new THREE.Vector3();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 8; k++) {
    p.set(
      k & 1 ? box.max.x : box.min.x,
      k & 2 ? box.max.y : box.min.y,
      k & 4 ? box.max.z : box.min.z
    ).project(view.camera);
    const x = ((p.x + 1) / 2) * view.width;
    const y = ((1 - p.y) / 2) * view.height;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}
