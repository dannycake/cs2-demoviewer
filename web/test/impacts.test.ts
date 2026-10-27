import * as THREE from 'three';
import { EFFECTS_LAYER } from '../src/scene/post';
import { describe, expect, it, vi } from 'vitest';
import type { EffectsManifest } from '../src/api/assets';
import { eyePoint, toScene, viewDir } from '../src/geo/coords';
import type { EffectAtlases } from '../src/scene/effects';
import { lightAt, litCache } from '../src/scene/gridlight';
import type { LabelCanvas } from '../src/scene/labels';
import {
  BLOOD,
  BLOOD_FRAME_GAIN,
  BOOM,
  DAMAGE,
  IMPACT_POOLS,
  Impacts,
  MUZZLE,
  NEUTRAL_HEX,
  TRACER,
  type ImpactOptions,
} from '../src/scene/impacts';
import { TEAM_HEX } from '../src/scene/colors';
import { newHullHit, type HullHit } from '../src/scene/hull';
import type { SmokeSphere } from '../src/scene/smokecover';
import { SMOKE } from '../src/scene/utility';
import { UNLIT_LOOK, type LookOptions } from '../src/scene/look';
import { WeaponCache } from '../src/scene/weapons';
import { FLAG } from '../src/pack/types';
import {
  newPlayerState,
  playerStateAt,
  type PlayerState,
} from '../src/sim/sample';
import { BOMB_S, Timeline } from '../src/sim/timeline';
import { countCalls } from './helpers/count-calls';
import { lightGrid } from './helpers/light-grid';
import { noAtlases, stubAtlases } from './helpers/stub-atlases';

// The grid sampler, spied through: the blood samples the grid once per hit.
vi.mock('../src/scene/probes', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/scene/probes')>();
  return { ...m, sampleLightGrid: vi.fn(m.sampleLightGrid) };
});
import { sampleLightGrid } from '../src/scene/probes';
import { event, trackPack, withSecondRound } from './helpers/track-pack';
import { wall, wallsHull } from './helpers/walls';

const R = 64;
const PLANT = 2000;

function timeline() {
  return new Timeline(
    trackPack({
      samples: 3000,
      teams: [2, 3],
      players: [
        () => ({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0 }),
        (k) => ({
          x: 300,
          y: 400,
          z: 5,
          flags: FLAG.alive | (k < 400 ? FLAG.bomb : 0),
        }),
      ],
      events: [
        // One shot of each kind of flash, apart.
        event('weapon_fire', 2500, { user_idx: 0, weapon: 'weapon_awp' }),
        event('weapon_fire', 2600, {
          user_idx: 0,
          weapon: 'weapon_m4a1_silencer',
        }),
        event('weapon_fire', 2700, { user_idx: 0, weapon: 'weapon_mag7' }),
        event('weapon_fire', 2800, { user_idx: 0, weapon: 'weapon_taser' }),
        // Both players fire at once.
        event('weapon_fire', 2900, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', 2900, { user_idx: 1, weapon: 'weapon_glock' }),
        event('weapon_fire', 1000, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('weapon_fire', 1100, { user_idx: 0, weapon: 'weapon_knife' }),
        // Shots with their logged aim (yaw 90 while the view faces yaw 0), one a hit.
        event('weapon_fire', 1500, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('fire_bullets', 1500, {
          user_idx: 0,
          angles_x: 0,
          angles_y: 90,
          origin_x: 0,
          origin_y: 0,
          origin_z: 64,
        }),
        event('weapon_fire', 1600, { user_idx: 0, weapon: 'weapon_ak47' }),
        event('fire_bullets', 1600, {
          user_idx: 0,
          angles_x: 0,
          angles_y: 50,
          origin_x: 0,
          origin_y: 0,
          origin_z: 64,
        }),
        event('bullet_damage', 1600, {
          attacker_idx: 0,
          victim_idx: 1,
          damage_dir_x: 0.6,
          damage_dir_y: 0.8,
          damage_dir_z: 0,
          distance: 200,
        }),
        event('player_hurt', 1200, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 49,
          health: 51,
          hitgroup: 'chest',
          weapon: 'ak47',
        }),
        event('player_hurt', 1220, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 20,
          health: 31,
          hitgroup: 'stomach',
          weapon: 'ak47',
        }),
        event('player_hurt', 1300, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 100,
          health: 0,
          hitgroup: 'head',
          weapon: 'ak47',
        }),
        event('player_hurt', 1400, {
          user_idx: 1,
          attacker_idx: null,
          dmg_health: 5,
          health: 46,
          hitgroup: 'generic',
          weapon: 'world',
        }),
        // A body hit and a headshot that did not kill, apart; two pellets landing together.
        event('player_hurt', 2400, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 20,
          health: 80,
          hitgroup: 'chest',
          weapon: 'ak47',
        }),
        event('player_hurt', 2450, {
          user_idx: 1,
          attacker_idx: 0,
          dmg_health: 30,
          health: 50,
          hitgroup: 'head',
          weapon: 'ak47',
        }),
        ...[0, 1].map(() =>
          event('player_hurt', 2650, {
            user_idx: 1,
            attacker_idx: 0,
            dmg_health: 9,
            health: 41,
            hitgroup: 'chest',
            weapon: 'mag7',
          })
        ),
        event('bomb_planted', PLANT, { user_idx: 1, site: 109 }),
        event('bomb_exploded', PLANT + BOMB_S * R, { user_idx: 1, site: 109 }),
      ],
    })
  );
}

/** Canvases recording the label text, colour and font drawn. */
function canvases() {
  const drawn: { text: string; color: string }[] = [];
  const fonts: string[] = [];
  const make = (width: number, height: number): LabelCanvas => {
    const g = {
      fillStyle: '',
      font: '',
      clearRect() {},
      strokeText() {},
      fillText(text: string) {
        drawn.push({ text, color: g.fillStyle });
        fonts.push(g.font);
      },
    };
    return { width, height, getContext: () => g };
  };
  return { drawn, fonts, make };
}

function states(): PlayerState[] {
  const s = (x: number, y: number, z: number): PlayerState =>
    ({
      present: true,
      x,
      y,
      z,
      yaw: 0,
      pitch: 0,
      duck: 0,
      flags: FLAG.alive,
    }) as PlayerState;
  return [s(0, 0, 0), s(300, 400, 5)];
}

function opts(
  _tl: Timeline,
  _tick: number,
  o: Partial<ImpactOptions> = {}
): ImpactOptions {
  return {
    states: states(),
    rig: () => null,
    hull: null,
    damageNumbers: true,
    eye: new THREE.Vector3(0, 3, -6),
    worldPerPixel: 0.001,
    shown: null,
    grid: null,
    exposure: 1,
    ...o,
  };
}

/** Impacts drawing the generated sprites: their atlases never arrive. */
function impacts(make?: ReturnType<typeof canvases>['make']) {
  const cache = new WeaponCache(async () => new THREE.Group());
  return new Impacts(cache, UNLIT_LOOK, noAtlases(), make ?? canvases().make);
}

const LIT: LookOptions = { lit: true, smoothNormals: true, maxAnisotropy: 8 };

const shown = (root: THREE.Object3D, type: 'Mesh' | 'Sprite') =>
  root.children.filter((c) => c.visible && c.type === type);

/** The atlases impacts draw from, as the effects manifest lists them (CS2 build 2000935). */
const ATLASES: EffectsManifest = {
  atlases: {
    muzzle: {
      file: 'muzzle.webp',
      width: 1024,
      height: 64,
      cell: [64, 64],
      cols: 16,
      frames: 15,
      sequences: [[0, 15]],
    },
    blood: {
      file: 'blood.webp',
      width: 1024,
      height: 64,
      cell: [64, 64],
      cols: 16,
      frames: 10,
      sequences: [
        [0, 6],
        [6, 4],
      ],
    },
  },
};

function withAtlases(atlases: ReturnType<typeof stubAtlases>['atlases']) {
  const cache = new WeaponCache(async () => new THREE.Group());
  return new Impacts(cache, UNLIT_LOOK, atlases, canvases().make);
}

/** Impacts whose atlases are in. */
async function loaded() {
  const s = stubAtlases(ATLASES);
  const im = withAtlases(s.atlases);
  const tl = timeline();
  // A shot and a hit ask for the two atlases.
  im.set(0, 1001, tl, opts(tl, 1001));
  im.set(0, 1201, tl, opts(tl, 1201));
  await s.release('muzzle.webp');
  await s.release('blood.webp');
  return { im, tl, s };
}

const batch = (im: Impacts, name: string) =>
  im.root.getObjectByName(name) as THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;

/** The sprites a batch draws now. */
function instances(im: Impacts, name: string) {
  const m = batch(im, name);
  const g = m.geometry;
  const n = m.visible ? g.instanceCount : 0;
  const centre = g.getAttribute('aCentre');
  const size = g.getAttribute('aSize');
  const color = g.getAttribute('aColor');
  return Array.from({ length: n }, (_, i) => ({
    at: new THREE.Vector3().fromBufferAttribute(
      centre as THREE.BufferAttribute,
      i
    ),
    w: size.getX(i),
    h: size.getY(i),
    rotation: size.getZ(i),
    frame: size.getW(i),
    color: new THREE.Color(color.getX(i), color.getY(i), color.getZ(i)),
    alpha: color.getW(i),
  }));
}

const tracers = (im: Impacts) =>
  im.root.children.filter(
    (c): c is THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> =>
      c.visible && c.name === 'tracer'
  );

/** A tracer's ends, the middles of its quad's two short sides. */
function ends(t: THREE.Mesh) {
  const p = t.geometry.getAttribute('position') as THREE.BufferAttribute;
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(p, i);
  return {
    near: v(0).add(v(1)).multiplyScalar(0.5),
    far: v(2).add(v(3)).multiplyScalar(0.5),
  };
}

/** The generated flashes shown (the tracers' glow sprites). */
const glows = (im: Impacts) =>
  im.root.children.filter((c) => c.visible && c.name === 'muzzle-flash');

/** A posed rig holding player 0's gun at the hand (1, 1.4, 0), its muzzle at `muzzle`. */
function gunRig(muzzle: THREE.Vector3) {
  const object = new THREE.Group();
  const wpn = new THREE.Object3D();
  wpn.position.set(1, 1.4, 0);
  object.add(wpn);
  return {
    object,
    bone: (n: string) => (n === 'wpn' ? wpn : undefined),
    muzzle: (out: THREE.Vector3): boolean => (out.copy(muzzle), true),
  };
}

/**
 * A stand-in hull: `free` for the cameras' and the muzzle's casts (`freeDistance`), and a
 * bullet's ray (`raycast`) stopping `ray(from, dir)` metres on, null for nothing in reach.
 */
const stubHull = (o: {
  free: (a: THREE.Vector3, b: THREE.Vector3) => number;
  ray: (from: THREE.Vector3, dir: THREE.Vector3) => number | null;
}) =>
  ({
    freeDistance: o.free,
    raycast: (
      from: THREE.Vector3,
      dir: THREE.Vector3,
      max: number,
      out: HullHit
    ) => {
      const t = o.ray(from, dir);
      if (t === null || t > max) return false;
      out.distance = t;
      out.point.copy(from).addScaledVector(dir, t);
      return true;
    },
  }) as unknown as ImpactOptions['hull'];

/** A hull that is a wall across the view (scene +z) at z = `w`. */
const wallAt = (w: number) =>
  stubHull({
    free: (a, b) => {
      if (a.z >= w) return 0;
      const length = a.distanceTo(b);
      return b.z <= w ? length : (length * (w - a.z)) / (b.z - a.z);
    },
    ray: (a, d) => (a.z >= w ? 0 : d.z > 0 ? (w - a.z) / d.z : null),
  });

/** Whether `m` adds light: three's additive blending, or a batch's ONE, ONE. */
const adds = (m: THREE.Material) =>
  m.blending === THREE.AdditiveBlending ||
  (m.blending === THREE.CustomBlending &&
    m.blendSrc === THREE.OneFactor &&
    m.blendDst === THREE.OneFactor);

describe('Impacts', () => {
  it("puts the tracers, muzzle flashes (CS2's frames too) and the bomb's blink and blast on the effects layer beside the default one, for a baked world's bloom (post.ts); not the blood (either kind) or the labels", async () => {
    const tl = timeline();
    const s = stubAtlases(ATLASES);
    const im = withAtlases(s.atlases);
    im.set(0, 1001, tl, opts(tl, 1001));
    const effect = (o: THREE.Object3D) =>
      o.layers.isEnabled(EFFECTS_LAYER) && o.layers.isEnabled(0);
    const tracer = tracers(im)[0];
    expect(effect(tracer)).toBe(true);
    const flash = shown(im.root, 'Sprite').find(
      (o) =>
        ((o as THREE.Sprite).material as THREE.Material).blending ===
        THREE.AdditiveBlending
    )!;
    expect(effect(flash)).toBe(true);
    // Once CS2's frames are in, the flashes and the blood are batches of their own.
    await s.release('muzzle.webp');
    im.set(0, 1201, tl, opts(tl, 1201));
    await s.release('blood.webp');
    im.set(0, 1001, tl, opts(tl, 1001));
    expect(batch(im, 'muzzle-flashes').visible).toBe(true);
    im.set(0, 1201, tl, opts(tl, 1201));
    expect(batch(im, 'blood-puffs').visible).toBe(true);
    let others = 0;
    let additives = 0;
    const kinds = new Set<string>();
    im.root.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (!(o instanceof THREE.Sprite || o instanceof THREE.Mesh) || !m) return;
      if (Array.isArray(m)) return;
      kinds.add(o.type);
      if (adds(m)) {
        additives++;
        expect(effect(o), o.name).toBe(true);
      } else {
        others++;
        expect(effect(o), o.name).toBe(false);
      }
    });
    expect(kinds).toEqual(new Set(['Mesh', 'Sprite']));
    expect(others).toBeGreaterThan(1);
    expect(additives).toBeGreaterThan(3);
    expect(effect(batch(im, 'muzzle-flashes'))).toBe(true);
    expect(effect(batch(im, 'blood-puffs'))).toBe(false);
  });

  it('draws a tracer for 60 ms after a gun shot, none for a knife', () => {
    const tl = timeline();
    const im = impacts();
    for (const t of [1000, 1001, 1003]) {
      im.set(0, t, tl, opts(tl, t));
      expect(shown(im.root, 'Mesh')).toHaveLength(1);
    }
    im.set(0, 1000 + Math.ceil(TRACER.seconds * R), tl, opts(tl, 1004));
    expect(shown(im.root, 'Mesh')).toHaveLength(0);
    im.set(0, 1101, tl, opts(tl, 1101));
    expect(shown(im.root, 'Mesh')).toHaveLength(0);
  });

  it("follows the shot's logged aim, recoil in it, not the view: a miss to the first wall, a hit along the bullet's own path to the player", () => {
    const tl = timeline();
    const im = impacts();
    const hull = stubHull({ free: () => 5, ray: () => 5 });
    const far = () => {
      const p = (shown(im.root, 'Mesh')[0] as THREE.Mesh).geometry.getAttribute(
        'position'
      );
      return new THREE.Vector3()
        .fromBufferAttribute(p, 2)
        .add(new THREE.Vector3().fromBufferAttribute(p, 3))
        .multiplyScalar(0.5);
    };
    const eye = toScene(0, 0, 64, new THREE.Vector3()) as THREE.Vector3;
    im.set(0, 1501, tl, opts(tl, 1501, { hull }));
    const aim = viewDir(90, 0, new THREE.Vector3()) as THREE.Vector3;
    expect(far().distanceTo(eye.clone().addScaledVector(aim, 5))).toBeLessThan(
      1e-4
    );
    // A hit ends at the player, along damage_dir (Source (x, y, z) → scene (y, z, x)).
    im.set(0, 1601, tl, opts(tl, 1601, { hull }));
    const dir = new THREE.Vector3(0.8, 0, 0.6);
    expect(
      far().distanceTo(eye.clone().addScaledVector(dir, 200 * 0.0254))
    ).toBeLessThan(1e-4);
  });

  it('runs a tracer from the gun along the view to the first wall, found from the eye', () => {
    const tl = timeline();
    const im = impacts();
    const hull = stubHull({ free: () => 5, ray: () => 5 });
    im.set(0, 1001, tl, opts(tl, 1001, { hull }));
    const mesh = shown(im.root, 'Mesh')[0] as THREE.Mesh;
    const p = mesh.geometry.getAttribute('position');
    const near = new THREE.Vector3()
      .fromBufferAttribute(p, 0)
      .add(new THREE.Vector3().fromBufferAttribute(p, 1))
      .multiplyScalar(0.5);
    const far = new THREE.Vector3()
      .fromBufferAttribute(p, 2)
      .add(new THREE.Vector3().fromBufferAttribute(p, 3))
      .multiplyScalar(0.5);
    // Yaw 0 looks along Source +x, which is scene +z; without a rig the gun is 0.3 m ahead.
    const eye = eyePoint(states()[0], new THREE.Vector3());
    expect(far.distanceTo(eye.clone().setZ(eye.z + 5))).toBeLessThan(1e-6);
    expect(near.distanceTo(eye.clone().setZ(eye.z + 0.3))).toBeLessThan(1e-6);
    expect(far.clone().sub(near).normalize().z).toBeCloseTo(1, 6);
  });

  it("lists damage to the right of the hit player, newest below, small and monospaced, in the attacker's colour", () => {
    const tl = timeline();
    const c = canvases();
    const im = impacts(c.make);
    const eye = new THREE.Vector3(0, 3, -6);
    const num = () =>
      shown(im.root, 'Sprite').filter((s) => s.renderOrder === 11);
    im.set(0, 1225, tl, opts(tl, 1225, { eye }));
    expect(num()).toHaveLength(2);
    expect(c.drawn.slice(-2)).toEqual([
      { text: '−49', color: `#${TEAM_HEX[2].toString(16)}` },
      { text: '−20', color: `#${TEAM_HEX[2].toString(16)}` },
    ]);
    expect(c.fonts.at(-1)).toMatch(/monospace/);
    const [older, newer] = num();
    // To the right of the body as the camera sees it, the newer one under the older one.
    const body = new THREE.Vector3();
    toScene(300, 400, 5, body);
    body.y += 1.3;
    const right = body
      .clone()
      .sub(eye)
      .cross(new THREE.Vector3(0, 1, 0))
      .normalize();
    expect(older.position.clone().sub(body).dot(right)).toBeGreaterThan(0.2);
    expect(newer.position.clone().sub(body).dot(right)).toBeCloseTo(
      older.position.clone().sub(body).dot(right),
      5
    );
    expect(newer.position.y).toBeLessThan(older.position.y);
    // Small: DAMAGE.pixels high on screen, no bigger than 20 px.
    expect(DAMAGE.pixels).toBeLessThanOrEqual(20);
    const px = newer.scale.y / (newer.position.distanceTo(eye) * 0.001);
    expect(px).toBeCloseTo(DAMAGE.pixels * 2, 0);
    // They stay where they are while they show, then fade.
    const y = older.position.y;
    im.set(0, 1230, tl, opts(tl, 1230, { eye }));
    expect(num()[0].position.y).toBeCloseTo(y, 6);
    // Dealt by the player being watched: their own colour.
    im.set(0, 1225, tl, opts(tl, 1225, { eye, shown: 0 }));
    expect(c.drawn.at(-1)).toEqual({ text: '−20', color: DAMAGE.mine });
    // A headshot says so; the world's damage is grey.
    im.set(0, 1301, tl, opts(tl, 1301, { eye }));
    expect(c.drawn.at(-1)).toEqual({
      text: '−100 HS',
      color: `#${TEAM_HEX[2].toString(16)}`,
    });
    im.set(0, 1401, tl, opts(tl, 1401, { eye }));
    expect(c.drawn.at(-1)).toEqual({
      text: '−5',
      color: `#${NEUTRAL_HEX.toString(16)}`,
    });
    im.set(0, 1401, tl, opts(tl, 1401, { damageNumbers: false }));
    expect(num()).toHaveLength(0);
  });

  it('puts a red blood puff in front of the hit body, bigger for the killing hit, gone after BLOOD.seconds', () => {
    const tl = timeline();
    const im = impacts();
    const eye = new THREE.Vector3(0, 3, -6);
    const blood = () =>
      im.root.children.filter(
        (c): c is THREE.Sprite => c.visible && c.name === 'blood'
      );
    im.set(0, 1201, tl, opts(tl, 1201, { eye }));
    expect(blood()).toHaveLength(1);
    const { color } = blood()[0].material;
    expect(color.r).toBeGreaterThan(3 * color.g);
    expect(blood()[0].material.blending).toBe(THREE.NormalBlending);
    // In front of the body as the camera sees it, not buried at the bone inside it.
    const bone = new THREE.Vector3();
    toScene(300, 400, 5, bone);
    bone.y += 1.3;
    expect(blood()[0].position.distanceTo(eye)).toBeLessThan(
      bone.distanceTo(eye) - 0.2
    );
    const wound = blood()[0].scale.x;
    im.set(0, 1301, tl, opts(tl, 1301, { eye }));
    expect(blood()).toHaveLength(1);
    expect(blood()[0].scale.x).toBeGreaterThan(wound * 1.3);
    im.set(0, 1300 + Math.ceil(BLOOD.seconds * R), tl, opts(tl, 1330, { eye }));
    expect(blood()).toHaveLength(0);
  });

  it('lays the planted bomb where it was planted, blinking faster towards the end, then blows it', () => {
    const tl = timeline();
    const im = impacts();
    im.set(0, PLANT + 10, tl, opts(tl, PLANT + 10));
    const bomb = im.root.children.find((c) => c.type === 'Group' && c.visible)!;
    expect(bomb).toBeDefined();
    const at = toScene(300, 400, 5, new THREE.Vector3()) as THREE.Vector3;
    expect(bomb.position.distanceTo(at)).toBeLessThan(1e-6);
    im.set(0, PLANT + BOMB_S * R + 10, tl, opts(tl, PLANT + BOMB_S * R + 10));
    expect(bomb.visible).toBe(false);
    expect(shown(im.root, 'Sprite').length).toBeGreaterThanOrEqual(2);
    im.set(0, PLANT + (BOMB_S + BOOM.seconds) * R + 1, tl, opts(tl, 0));
    expect(shown(im.root, 'Sprite')).toHaveLength(0);
  });
});

describe("CS2's muzzle flashes and blood", () => {
  it("flashes a CS2 muzzle frame for 50 ms at the gun, as big as the weapon's class, additive and emissive", async () => {
    const { im, tl } = await loaded();
    im.set(0, 2500, tl, opts(tl, 2500));
    const [awp] = instances(im, 'muzzle-flashes');
    expect(instances(im, 'muzzle-flashes')).toHaveLength(1);
    expect(MUZZLE.size.sniper).toBe(0.6);
    expect(awp.w).toBeCloseTo(0.6, 6);
    expect(awp.h).toBeCloseTo(0.6, 6);
    expect(awp.frame).toBeGreaterThanOrEqual(0);
    expect(awp.frame).toBeLessThan(15);
    expect(Number.isInteger(awp.frame)).toBe(true);
    expect(awp.alpha).toBeCloseTo(1, 6);
    // At the gun: where the tracer starts.
    expect(awp.at.distanceTo(ends(tracers(im)[0]).near)).toBeLessThan(1e-6);
    // Instead of the generated glow, not beside it.
    expect(glows(im)).toHaveLength(0);
    const m = batch(im, 'muzzle-flashes').material;
    expect(adds(m)).toBe(true);
    expect(m.defines.EMISSIVE).toBeDefined();
    im.set(0, 2500 + 0.06 * R, tl, opts(tl, 2500 + 0.06 * R));
    expect(instances(im, 'muzzle-flashes')).toHaveLength(0);
    expect(batch(im, 'muzzle-flashes').visible).toBe(false);
  });

  it('turns and picks each flash by its tick and player, the same every time it is drawn', async () => {
    const { im, tl } = await loaded();
    im.set(0, 2900, tl, opts(tl, 2900));
    const [a, b] = instances(im, 'muzzle-flashes');
    expect(a.rotation).not.toBeCloseTo(b.rotation, 3);
    im.set(0, 2500, tl, opts(tl, 2500));
    im.set(0, 2900, tl, opts(tl, 2900));
    const again = instances(im, 'muzzle-flashes');
    expect(again[0]).toEqual(a);
    expect(again[1]).toEqual(b);
  });

  it("fires from the muzzle of the gun in the shooter's hand (the rig's), not a set distance past the hand", async () => {
    const { im, tl } = await loaded();
    const muzzle = new THREE.Vector3(1, 1.4, 0.8);
    const rig = gunRig(muzzle);
    im.set(0, 2500, tl, opts(tl, 2500, { rig: (i) => (i === 0 ? rig : null) }));
    expect(
      instances(im, 'muzzle-flashes')[0].at.distanceTo(muzzle)
    ).toBeLessThan(1e-6);
    expect(ends(tracers(im)[0]).near.distanceTo(muzzle)).toBeLessThan(1e-6);
    // Without a gun in the hand (not loaded yet): TRACER.forward past the hand, as before.
    rig.muzzle = () => false;
    im.set(0, 2500, tl, opts(tl, 2500, { rig: (i) => (i === 0 ? rig : null) }));
    const hand = new THREE.Vector3(1, 1.4, 0).addScaledVector(
      viewDir(0, 0, new THREE.Vector3()) as THREE.Vector3,
      TRACER.forward
    );
    expect(instances(im, 'muzzle-flashes')[0].at.distanceTo(hand)).toBeLessThan(
      1e-6
    );
  });

  it("finds a miss's wall from the eye, not the gun, and draws no tracer for a muzzle past the wall (the gun poked into it), its flash still", async () => {
    const { im, tl } = await loaded();
    const muzzle = new THREE.Vector3(1, 1.4, 0.8);
    const rig = { ...gunRig(muzzle) };
    const on = (W: number) =>
      opts(tl, 2500, { rig: (i) => (i === 0 ? rig : null), hull: wallAt(W) });
    const eye = eyePoint(states()[0], new THREE.Vector3());
    im.set(0, 2500, tl, on(5));
    const [t] = tracers(im);
    expect(ends(t).near.distanceTo(muzzle)).toBeLessThan(1e-6);
    expect(ends(t).far.distanceTo(eye.clone().setZ(5))).toBeLessThan(1e-6);
    // The wall 0.6 m ahead, the muzzle 0.8 m: no tracer, a flash at the muzzle.
    im.set(0, 2500, tl, on(0.6));
    expect(tracers(im)).toHaveLength(0);
    expect(instances(im, 'muzzle-flashes')).toHaveLength(1);
    expect(
      instances(im, 'muzzle-flashes')[0].at.distanceTo(muzzle)
    ).toBeLessThan(1e-6);
  });

  it('runs a miss past the chainlink to the wall its bullet hole is on (the same ray as BulletMarks)', () => {
    const tl = timeline();
    const im = impacts();
    // The shot at 1001 has no logged aim: from player 0's eye along their view, scene +z.
    const eye = eyePoint(states()[0], new THREE.Vector3());
    const hull = wallsHull(
      wall('physics_passbullets_chainlink', eye.z + 2),
      wall('physics_group_metal', eye.z + 5)
    );
    // The hull's walls are 20 m planes about the origin; the eye's height is in them.
    im.set(0, 1001, tl, opts(tl, 1001, { hull }));
    const far = ends(tracers(im)[0]).far;
    expect(far.distanceTo(eye.clone().setZ(eye.z + 5))).toBeLessThan(1e-4);
    // Where BulletMarks finds the miss's wall: the same ray, the same hit.
    const hit = newHullHit();
    expect(
      hull.raycast(eye, new THREE.Vector3(0, 0, 1), TRACER.reach, hit)
    ).toBe(true);
    expect(hit.point.distanceTo(far)).toBeLessThan(1e-4);
  });

  it("draws a suppressed weapon's flash at 0.4 of its size and half as bright", async () => {
    const { im, tl } = await loaded();
    im.set(0, 2600, tl, opts(tl, 2600));
    const [m4] = instances(im, 'muzzle-flashes');
    expect(MUZZLE.suppressed).toBe(0.4);
    expect(m4.w).toBeCloseTo(0.18, 6);
    expect(m4.alpha).toBeCloseTo(0.5, 6);
  });

  it('runs tracers for every gun (a shotgun now) and none for the taser', async () => {
    const { im, tl } = await loaded();
    im.set(0, 2701, tl, opts(tl, 2701));
    expect(tracers(im)).toHaveLength(1);
    expect(instances(im, 'muzzle-flashes')[0].w).toBeCloseTo(
      MUZZLE.size.shotgun,
      6
    );
    im.set(0, 2801, tl, opts(tl, 2801));
    expect(tracers(im)).toHaveLength(0);
    expect(instances(im, 'muzzle-flashes')).toHaveLength(0);
    expect(glows(im)).toHaveLength(0);
  });

  it("draws every hit's blood from CS2's splatter frames where the puff was, and the puff no more", async () => {
    const { im, tl } = await loaded();
    const eye = new THREE.Vector3(0, 3, -6);
    const sprites = () =>
      im.root.children.filter((c) => c.visible && c.name === 'blood');
    // The chest at 1200: the splatter, at the puff's place and size.
    const plain = impacts();
    plain.set(0, 1201, tl, opts(tl, 1201, { eye }));
    const puff = plain.root.children.find(
      (c): c is THREE.Sprite => c.visible && c.name === 'blood'
    )!;
    im.set(0, 1201, tl, opts(tl, 1201, { eye }));
    expect(sprites()).toHaveLength(0);
    const [body] = instances(im, 'blood-puffs');
    expect(instances(im, 'blood-puffs')).toHaveLength(1);
    expect(body.frame).toBeGreaterThanOrEqual(6);
    expect(body.frame).toBeLessThanOrEqual(9);
    expect(body.at.distanceTo(puff.position)).toBeLessThan(1e-6);
    expect(body.w).toBeCloseTo(puff.scale.x, 6);
    expect(body.rotation).toBeCloseTo(puff.material.rotation, 6);
    expect(body.alpha).toBeCloseTo(puff.material.opacity, 6);
    // The killing headshot at 1300: the splatter too, bigger.
    im.set(0, 1301, tl, opts(tl, 1301, { eye }));
    const [head] = instances(im, 'blood-puffs');
    expect(head.frame).toBeGreaterThanOrEqual(6);
    expect(head.frame).toBeLessThanOrEqual(9);
    expect(head.w).toBeGreaterThan(body.w * 1.5);
    // Covering, not adding light.
    expect(adds(batch(im, 'blood-puffs').material)).toBe(false);
    im.set(0, 1300 + Math.ceil(BLOOD.seconds * R), tl, opts(tl, 1330, { eye }));
    expect(instances(im, 'blood-puffs')).toHaveLength(0);
  });

  it("draws a headshot's blood 1.25 times as big as a body hit's, the killing hit's 1.5 times on top", async () => {
    const { im, tl } = await loaded();
    expect(BLOOD.headshot).toBe(1.25);
    im.set(0, 2401, tl, opts(tl, 2401));
    const [body] = instances(im, 'blood-puffs');
    im.set(0, 2451, tl, opts(tl, 2451));
    const [head] = instances(im, 'blood-puffs');
    expect(head.w / body.w).toBeCloseTo(1.25, 6);
    expect(head.frame).toBeGreaterThanOrEqual(6);
    expect(head.frame).toBeLessThanOrEqual(9);
    // The killing headshot at 1300 against the body hit at 1200, at the same age.
    im.set(0, 1201, tl, opts(tl, 1201));
    const [chest] = instances(im, 'blood-puffs');
    im.set(0, 1301, tl, opts(tl, 1301));
    const [kill] = instances(im, 'blood-puffs');
    expect(kill.w / chest.w).toBeCloseTo(BLOOD.fatal * BLOOD.headshot, 6);
  });

  it('turns and picks apart the pellets of one shot that land together, the same each time they are drawn', async () => {
    const { im, tl } = await loaded();
    im.set(0, 2651, tl, opts(tl, 2651));
    const [a, b] = instances(im, 'blood-puffs');
    expect(instances(im, 'blood-puffs')).toHaveLength(2);
    expect(a.frame).not.toBe(b.frame);
    expect(a.rotation).not.toBeCloseTo(b.rotation, 3);
    for (const f of [a.frame, b.frame]) {
      expect(f).toBeGreaterThanOrEqual(6);
      expect(f).toBeLessThanOrEqual(9);
    }
    im.set(0, 1201, tl, opts(tl, 1201));
    im.set(0, 2651, tl, opts(tl, 2651));
    expect(instances(im, 'blood-puffs')).toEqual([a, b]);
  });

  it("counts a tick's pellets per victim: two players hit on one tick (an HE, a collateral) each get the splat", async () => {
    const { im } = await loaded();
    const hurt = (tick: number, victim: number) =>
      event('player_hurt', tick, {
        user_idx: victim,
        attacker_idx: 0,
        dmg_health: 20,
        health: 80,
        hitgroup: 'chest',
        weapon: 'hegrenade',
      });
    const tl = new Timeline(
      trackPack({
        samples: 3000,
        teams: [2, 3, 3],
        players: [
          () => ({ x: 0, y: 0, z: 0 }),
          () => ({ x: 300, y: 400, z: 5 }),
          () => ({ x: 300, y: -400, z: 5 }),
        ],
        // Two victims on one tick; then one's two pellets either side of the other's one.
        events: [
          hurt(1200, 1),
          hurt(1200, 2),
          hurt(1300, 1),
          hurt(1300, 2),
          hurt(1300, 1),
        ],
      })
    );
    const three = [...states(), { ...states()[1], y: -400 }];
    const splat = ATLASES.atlases!.blood!.sequences[1][0];
    im.set(0, 1201, tl, opts(tl, 1201, { states: three }));
    const [a, b] = instances(im, 'blood-puffs');
    expect([a.frame, b.frame]).toEqual([splat, splat]);
    // Each turned its own way.
    expect(a.rotation).not.toBeCloseTo(b.rotation, 3);
    im.set(0, 1301, tl, opts(tl, 1301, { states: three }));
    expect(instances(im, 'blood-puffs').map((p) => p.frame)).toEqual([
      splat,
      splat,
      splat + 1,
    ]);
  });

  it('lights the blood on a baked map by the grid where the victim stood at the hit, sampled once per hit; a dark red, not a light, without a grid as before', async () => {
    const { im, tl } = await loaded();
    const grid = lightGrid();
    const sunLight = new THREE.Color(2, 1.5, 1);
    // The victim's eyes at the hit's tick, lit as the smokes are, keeping all the light's colour.
    const { pack } = tl;
    const at = eyePoint(
      playerStateAt(
        pack.rounds[0].players[1],
        pack.header.rounds[0],
        1200,
        pack.header,
        newPlayerState()
      ),
      new THREE.Vector3()
    );
    const light = litCache();
    lightAt(light, at, 1, 1, grid, sunLight);
    const lit = new THREE.Color(BLOOD.color).multiply(light.lit!);
    // The instance colours are float32: to six figures.
    const near = (a: THREE.Color, b: THREE.Color) =>
      (['r', 'g', 'b'] as const).forEach((c) =>
        expect(a[c] / b[c]).toBeCloseTo(1, 6)
      );
    vi.mocked(sampleLightGrid).mockClear();
    im.set(0, 1201, tl, opts(tl, 1201, { grid, sunLight }));
    expect(sampleLightGrid).toHaveBeenCalledTimes(1);
    near(
      instances(im, 'blood-puffs')[0].color,
      lit.clone().multiplyScalar(BLOOD_FRAME_GAIN)
    );
    // Its next frames, the body moving: sampled no more.
    for (let t = 1202; t < 1212; t++)
      im.set(0, t, tl, opts(tl, t, { grid, sunLight }));
    expect(sampleLightGrid).toHaveBeenCalledTimes(1);
    // Without a grid: the flat dark red.
    im.set(0, 1201, tl, opts(tl, 1201));
    near(
      instances(im, 'blood-puffs')[0].color,
      new THREE.Color(BLOOD.color).multiplyScalar(BLOOD_FRAME_GAIN)
    );
    // Not a light: neither divided by the exposure nor on the bloom's layer.
    const m = batch(im, 'blood-puffs');
    expect(m.material.defines.EMISSIVE).toBeUndefined();
    expect(m.layers.isEnabled(EFFECTS_LAYER)).toBe(false);
    // The generated puff, before the atlas, takes the same light.
    const plain = impacts();
    plain.set(0, 1201, tl, opts(tl, 1201, { grid, sunLight }));
    const sprite = plain.root.children.find(
      (c): c is THREE.Sprite => c.visible && c.name === 'blood'
    )!;
    near(sprite.material.color, lit);
  });

  it("samples the blood's light again for another demo's hit of the same tick and victim, on the same grid", async () => {
    const { im, tl } = await loaded();
    const grid = lightGrid();
    // Another match: the same hit (tick 1200, player 1) with the victim 3 m higher.
    const other = new Timeline(
      trackPack({
        samples: 3000,
        teams: [2, 3],
        players: [
          () => ({ x: 0, y: 0, z: 0 }),
          () => ({ x: 300, y: 400, z: 125 }),
        ],
        events: [
          event('player_hurt', 1200, {
            user_idx: 1,
            attacker_idx: 0,
            dmg_health: 49,
            health: 51,
            hitgroup: 'chest',
            weapon: 'ak47',
          }),
        ],
      })
    );
    const colorAt = (t: Timeline) => {
      const { pack } = t;
      const at = eyePoint(
        playerStateAt(
          pack.rounds[0].players[1],
          pack.header.rounds[0],
          1200,
          pack.header,
          newPlayerState()
        ),
        new THREE.Vector3()
      );
      const light = litCache();
      lightAt(light, at, 1, 1, grid, null);
      return new THREE.Color(BLOOD.color)
        .multiply(light.lit!)
        .multiplyScalar(BLOOD_FRAME_GAIN);
    };
    const near = (a: THREE.Color, b: THREE.Color) =>
      (['r', 'g', 'b'] as const).forEach((c) =>
        expect(a[c] / b[c]).toBeCloseTo(1, 6)
      );
    im.set(0, 1201, tl, opts(tl, 1201, { grid }));
    near(instances(im, 'blood-puffs')[0].color, colorAt(tl));
    im.set(0, 1201, other, opts(other, 1201, { grid }));
    expect(colorAt(other).equals(colorAt(tl))).toBe(false);
    near(instances(im, 'blood-puffs')[0].color, colorAt(other));
    // And back.
    im.set(0, 1201, tl, opts(tl, 1201, { grid }));
    near(instances(im, 'blood-puffs')[0].color, colorAt(tl));
  });

  it('draws the generated puff, and throws nothing, from a blood atlas that lists no sequences', () => {
    const tl = timeline();
    const atlas = {
      texture: new THREE.Texture(),
      cols: 16,
      rows: 1,
      frames: 10,
      sequences: [],
      aspect: 1,
    };
    const effects = {
      get: (k: string) => (k === 'blood' ? atlas : null),
    } as unknown as EffectAtlases;
    const im = new Impacts(
      new WeaponCache(async () => new THREE.Group()),
      UNLIT_LOOK,
      effects,
      canvases().make
    );
    expect(() => im.set(0, 1201, tl, opts(tl, 1201))).not.toThrow();
    expect(
      im.root.children.filter((c) => c.visible && c.name === 'blood')
    ).toHaveLength(1);
    expect(instances(im, 'blood-puffs')).toHaveLength(0);
  });

  it('draws the generated glow and puff until the atlases are in, and asks for each only when a shot or a hit needs it', async () => {
    const s = stubAtlases(ATLASES);
    const im = withAtlases(s.atlases);
    const tl = timeline();
    im.set(0, PLANT + 10, tl, opts(tl, PLANT + 10));
    expect(s.fetches).toBe(0);
    im.set(0, 1001, tl, opts(tl, 1001));
    expect(glows(im)).toHaveLength(1);
    expect(instances(im, 'muzzle-flashes')).toHaveLength(0);
    await Promise.resolve();
    expect(s.fetches).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect([...s.pending.keys()]).toEqual(['muzzle.webp']);
    im.set(0, 1201, tl, opts(tl, 1201));
    expect(
      im.root.children.filter((c) => c.visible && c.name === 'blood')
    ).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 0));
    expect([...s.pending.keys()]).toEqual(['muzzle.webp', 'blood.webp']);
    expect(s.fetches).toBe(1);
  });

  it("draws the first-person player's flash at their gun's muzzle, sized for first person, and none of theirs when no gun is drawn", async () => {
    const { im, tl } = await loaded();
    const eye = new THREE.Vector3(0, 1.6, 0);
    const point = new THREE.Vector3(0.15, 1.5, 0.7);
    im.set(
      0,
      2900,
      tl,
      opts(tl, 2900, { eye, firstPerson: { player: 0, point, scale: 1.5 } })
    );
    const flashes = instances(im, 'muzzle-flashes');
    expect(flashes).toHaveLength(2);
    const mine = flashes.find((f) => f.at.distanceTo(point) < 1e-6)!;
    expect(mine).toBeDefined();
    expect(mine.w).toBeCloseTo(MUZZLE.size.rifle * MUZZLE.firstPerson * 1.5, 6);
    // Their tracer leaves from the same muzzle.
    expect(tracers(im).some((t) => ends(t).near.distanceTo(point) < 1e-6)).toBe(
      true
    );
    // The other player's flash is the third-person one, at full size.
    const theirs = flashes.find((f) => f !== mine)!;
    expect(theirs.w).toBeCloseTo(MUZZLE.size.pistol, 6);
    // A wall nearer than the muzzle: the flash comes in front of it, the same on screen.
    const hull = stubHull({
      free: (a, b) => Math.min(0.4, a.distanceTo(b)),
      ray: () => 0.4,
    });
    im.set(
      0,
      2900,
      tl,
      opts(tl, 2900, {
        eye,
        hull,
        firstPerson: { player: 0, point, scale: 1.5 },
      })
    );
    const near = instances(im, 'muzzle-flashes').find(
      (f) => f.w < MUZZLE.size.pistol - 1e-6
    )!;
    const k = near.at.distanceTo(eye) / point.distanceTo(eye);
    expect(k).toBeLessThan(0.4 / point.distanceTo(eye));
    expect(
      near.at
        .clone()
        .sub(eye)
        .normalize()
        .dot(point.clone().sub(eye).normalize())
    ).toBeCloseTo(1, 9);
    expect(near.w).toBeCloseTo(mine.w * k, 6);
    // Scoped (no gun drawn): no flash of theirs; the other player's still.
    im.set(
      0,
      2900,
      tl,
      opts(tl, 2900, { eye, firstPerson: { player: 0, point: null, scale: 1 } })
    );
    expect(instances(im, 'muzzle-flashes')).toHaveLength(1);
    expect(instances(im, 'muzzle-flashes')[0].w).toBeCloseTo(
      MUZZLE.size.pistol,
      6
    );
    // Nor the generated glow without the atlases.
    const plain = impacts();
    plain.set(
      0,
      2900,
      tl,
      opts(tl, 2900, { eye, firstPerson: { player: 0, point: null, scale: 1 } })
    );
    expect(glows(plain)).toHaveLength(1);
  });

  it("draws only a round's own flashes and blood: seeking into the next round's start drops them, and seeking back draws them again", async () => {
    const { im, tl: one } = await loaded();
    const tl = new Timeline(withSecondRound(one.pack, 1));
    const [first, next] = tl.pack.header.rounds;
    // The fixture's last shot and hit, by its round's end.
    const shot = 2900;
    expect(shot).toBeLessThan(first.post_end_tick);
    const snap = () => ({
      flashes: instances(im, 'muzzle-flashes'),
      blood: instances(im, 'blood-puffs'),
      tracers: tracers(im).length,
    });
    im.set(0, shot + 1, tl, opts(tl, shot + 1));
    im.set(0, 2651, tl, opts(tl, 2651));
    const blood = snap();
    expect(blood.blood).toHaveLength(2);
    im.set(0, shot + 1, tl, opts(tl, shot + 1));
    const flashes = snap();
    expect(flashes.flashes).toHaveLength(2);
    // Round 1 opens with none of round 0's.
    for (const t of [next.start_tick, next.start_tick + 1]) {
      im.set(1, t, tl, opts(tl, t));
      expect(snap()).toEqual({ flashes: [], blood: [], tracers: 0 });
    }
    im.set(0, 2651, tl, opts(tl, 2651));
    expect(snap()).toEqual(blood);
    im.set(0, shot + 1, tl, opts(tl, shot + 1));
    expect(snap()).toEqual(flashes);
  });

  it('keeps its batches and pools over twenty seeks, and makes no update range per frame', async () => {
    const { im, tl } = await loaded();
    const ticks = [2500, 2600, 2701, 2900, 1001, 1201, 1301, 1601];
    for (const t of ticks) im.set(0, t, tl, opts(tl, t));
    const arrays = () => {
      const out: unknown[] = [];
      im.root.traverse((o) => {
        const g = (o as THREE.Mesh).geometry;
        if (g instanceof THREE.InstancedBufferGeometry)
          for (const a of Object.values(g.attributes)) out.push(a.array);
      });
      return out;
    };
    const was = arrays();
    const children = im.root.children.length;
    const o = opts(tl, 0);
    const calls = countCalls(() => {
      for (let i = 0; i < 20; i++) im.set(0, ticks[i % ticks.length], tl, o);
    });
    expect(calls.range).toBe(0);
    expect(im.root.children.length).toBe(children);
    const now = arrays();
    expect(now.length).toBe(was.length);
    now.forEach((a, i) => expect(a).toBe(was[i]));
    expect(
      batch(im, 'muzzle-flashes').geometry.getAttribute('aSize').count
    ).toBe(IMPACT_POOLS.tracers);
    expect(batch(im, 'blood-puffs').geometry.getAttribute('aSize').count).toBe(
      IMPACT_POOLS.blood
    );
  });
});

describe('smokes in front of the shots and the blood', () => {
  /** A smoke at `SMOKE.opacity`, `radius` metres about (x, y, z). */
  const smoke = (
    x: number,
    y: number,
    z: number,
    radius: number
  ): SmokeSphere => ({
    centre: new THREE.Vector3(x, y, z),
    radius,
    opacity: SMOKE.opacity,
  });
  const ak = (fs: ReturnType<typeof instances>) =>
    fs.find((f) => Math.abs(f.h - MUZZLE.size.rifle) < 1e-6)!;
  const glock = (fs: ReturnType<typeof instances>) =>
    fs.find((f) => Math.abs(f.h - MUZZLE.size.pistol) < 1e-6)!;

  it('fades a flash behind a smoke by the smoke between it and the eye, and none in front of it or beside it', async () => {
    const { im, tl } = await loaded();
    // Both players fire: player 0's AK at the origin, player 1's Glock 13 m off to the right.
    im.set(0, 2900, tl, opts(tl, 2900));
    const clear = instances(im, 'muzzle-flashes');
    expect(clear).toHaveLength(2);
    // A smoke between the eye (0, 3, −6) and the AK, out of the way of the Glock.
    im.set(0, 2900, tl, opts(tl, 2900, { smokes: [smoke(0, 2.3, -3, 1.2)] }));
    const behind = instances(im, 'muzzle-flashes');
    expect(ak(behind).alpha).toBeCloseTo(
      ak(clear).alpha * (1 - SMOKE.opacity),
      6
    );
    expect(glock(behind).alpha).toBe(glock(clear).alpha);
    // The same place, size and frame: only its light is cut.
    expect(ak(behind).at.equals(ak(clear).at)).toBe(true);
    expect(ak(behind).frame).toBe(ak(clear).frame);
    // A smoke behind the AK (and away from the Glock): both as without it.
    im.set(0, 2900, tl, opts(tl, 2900, { smokes: [smoke(0, 1.6, 3, 1.2)] }));
    const front = instances(im, 'muzzle-flashes');
    expect(ak(front).alpha).toBe(ak(clear).alpha);
    expect(glock(front).alpha).toBe(glock(clear).alpha);
    // The generated glow before CS2's frames, the same.
    const plain = impacts();
    plain.set(0, 2900, tl, opts(tl, 2900));
    const was = glows(plain).map((g) => (g as THREE.Sprite).material.opacity);
    plain.set(
      0,
      2900,
      tl,
      opts(tl, 2900, { smokes: [smoke(0, 2.3, -3, 1.2)] })
    );
    const now = glows(plain).map((g) => (g as THREE.Sprite).material.opacity);
    expect(now.filter((o, i) => o === was[i])).toHaveLength(1);
    expect(
      now.some((o, i) => Math.abs(o - was[i] * (1 - SMOKE.opacity)) < 1e-6)
    ).toBe(true);
  });

  it("never fades the first-person player's own flash, which is in front of every smoke, even from inside one", async () => {
    const { im, tl } = await loaded();
    const eye = new THREE.Vector3(0, 1.6, 0);
    const point = new THREE.Vector3(0.15, 1.5, 0.7);
    const firstPerson = { player: 0, point, scale: 1.5 };
    im.set(0, 2900, tl, opts(tl, 2900, { eye, firstPerson }));
    const clear = instances(im, 'muzzle-flashes');
    // The eye in a smoke 1.5 m across: 0.7 m of it before the gun's muzzle.
    const smokes = [smoke(0, 1.6, 0, 1.5)];
    im.set(0, 2900, tl, opts(tl, 2900, { eye, firstPerson, smokes }));
    const inside = instances(im, 'muzzle-flashes');
    const mine = (fs: ReturnType<typeof instances>) =>
      fs.find((f) => f.at.distanceTo(point) < 1e-6)!;
    expect(mine(inside).alpha).toBe(mine(clear).alpha);
    expect(mine(inside).alpha).toBeGreaterThan(0.5);
    // The other player's, out past the smoke, is hidden by it.
    expect(glock(inside).alpha).toBeCloseTo(
      glock(clear).alpha * (1 - SMOKE.opacity),
      6
    );
  });

  it("fades the blood of a hit behind a smoke, CS2's and the generated puff", async () => {
    const { im, tl } = await loaded();
    im.set(0, 1201, tl, opts(tl, 1201));
    const clear = instances(im, 'blood-puffs');
    expect(clear).toHaveLength(1);
    // Halfway between the eye (0, 3, −6) and the hit player's chest.
    const p = clear[0].at;
    const mid = new THREE.Vector3(0, 3, -6).add(p).multiplyScalar(0.5);
    const smokes = [smoke(mid.x, mid.y, mid.z, 1.5)];
    im.set(0, 1201, tl, opts(tl, 1201, { smokes }));
    const hidden = instances(im, 'blood-puffs');
    expect(hidden[0].alpha).toBeCloseTo(
      clear[0].alpha * (1 - SMOKE.opacity),
      6
    );
    const plain = impacts();
    plain.set(0, 1201, tl, opts(tl, 1201));
    const puff = shown(plain.root, 'Sprite').find(
      (c) => c.name === 'blood'
    ) as THREE.Sprite;
    const was = puff.material.opacity;
    plain.set(0, 1201, tl, opts(tl, 1201, { smokes }));
    expect(puff.material.opacity).toBeCloseTo(was * (1 - SMOKE.opacity), 6);
  });
});

describe('the bomb', () => {
  /** Impacts whose weapon cache holds a C4 with a glTF (Standard) material, as the real one. */
  async function withBomb() {
    const cache = new WeaponCache(async () => {
      const g = new THREE.Group();
      g.add(
        new THREE.Mesh(
          new THREE.BoxGeometry(0.3, 0.1, 0.2),
          new THREE.MeshStandardMaterial({ map: new THREE.Texture() })
        )
      );
      return g;
    });
    cache.get('c4');
    await new Promise((r) => setTimeout(r, 0));
    return {
      cache,
      im: new Impacts(cache, LIT, noAtlases(), canvases().make),
    };
  }

  const meshOf = (im: Impacts) =>
    im.root
      .getObjectByName('bomb')!
      .getObjectByProperty('isMesh', true) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshLambertMaterial
    >;

  it("is dressed in the look as the players' weapons are, in materials of its own", async () => {
    const { cache, im } = await withBomb();
    const tl = timeline();
    im.set(0, PLANT + 10, tl, opts(tl, PLANT + 10));
    const m = meshOf(im).material;
    const src = cache
      .get('c4')!
      .getObjectByProperty('isMesh', true) as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >;
    expect(m).toBeInstanceOf(THREE.MeshLambertMaterial);
    expect(m).not.toBe(src.material);
    expect(m.map).toBe(src.material.map);
    expect(m.map!.anisotropy).toBe(8);
    // A new look dresses it again, freeing the old materials.
    let freed = 0;
    m.addEventListener('dispose', () => freed++);
    im.setLook(UNLIT_LOOK);
    expect(freed).toBe(1);
    im.set(0, PLANT + 10, tl, opts(tl, PLANT + 10));
    expect(meshOf(im).material).toBeInstanceOf(THREE.MeshBasicMaterial);
    meshOf(im).material.addEventListener('dispose', () => (freed += 10));
    im.dispose();
    expect(freed).toBe(11);
  });

  it('is lit by the light grid half a metre over where it lies, and by the sky light without a grid', async () => {
    const { im } = await withBomb();
    const tl = timeline();
    const grid = lightGrid();
    im.set(0, PLANT + 10, tl, opts(tl, PLANT + 10, { grid }));
    const mesh = meshOf(im);
    expect(mesh.material.customProgramCacheKey()).toContain('probe');
    const src = THREE.ShaderLib.lambert;
    const shader = {
      uniforms: THREE.UniformsUtils.clone(src.uniforms),
      vertexShader: src.vertexShader,
      fragmentShader: src.fragmentShader,
    } as Parameters<THREE.Material['onBeforeCompile']>[0];
    mesh.material.onBeforeCompile(
      shader,
      null as unknown as THREE.WebGLRenderer
    );
    // Planted at 5 units up, 0.13 m: read at 0.63 m.
    const at = toScene(300, 400, 5, new THREE.Vector3()) as THREE.Vector3;
    expect(shader.uniforms.probeSun.value).toBeCloseTo((at.y + 0.5) / 2.5, 6);
    expect(mesh.receiveShadow).toBe(true);
    im.set(0, PLANT + 20, tl, opts(tl, PLANT + 20));
    expect(mesh.material.customProgramCacheKey()).not.toContain('probe');
    expect(mesh.receiveShadow).toBe(false);
  });
});
