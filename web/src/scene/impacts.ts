// Shots, hits and the bomb in the scene, from the round timeline and the posed rigs: a tracer
// from the muzzle along the view to the first wall (60 ms) with a muzzle flash (50 ms) as big as
// the gun's class, a puff of blood where a hit landed (0.35 s, bigger for the kill), the damage
// listed beside the hit player in small monospaced numbers (1.2 s), the
// planted bomb with its red light blinking faster towards the end, the dropped bomb, and the
// explosion. The flashes and the blood are CS2's own frames (`muzzle`, `blood`; `effects.ts`)
// once their atlases are in, each asked for when a shot or a hit first needs it, and generated
// sprites until then. The player seen in first person fires from their first-person gun's
// muzzle. Pooled like `utility.ts`: nothing is made while playing or scrubbing. The bomb is a
// copy of the C4's model dressed in the scene's look as the players' weapons are
// (`cloneWeapon`), in materials of its own, so that on a baked map it takes the light grid where
// it lies (`ItemLight`), sampled when it is planted or dropped somewhere new.

import * as THREE from 'three';
import { UNIT, eyePoint, toScene, viewDir } from '../geo/coords';
import { newPlayerState, playerStateAt, type PlayerState } from '../sim/sample';
import { blinkOn, type Hit, type Timeline } from '../sim/timeline';
import { muzzleClass } from '../sim/weapons';
import { TEAM_HEX, css } from './colors';
import type { EffectAtlases } from './effects';
import { FlipbookBatch } from './flipbook';
import { smokeCover, type SmokeSphere } from './smokecover';
import { newHullHit, type Hull } from './hull';
import { LabelSprites, MONO_CENTER_Y, type CanvasFactory } from './labels';
import { FLOOR_LIFT, ItemLight } from './itemlight';
import type { LookMaterial, LookOptions } from './look';
import { lightAt, litCache, type LitCache } from './gridlight';
import { clamp01 } from './util';
import { glowTexture, hash01, puffTexture } from './noise';
import { bloomsAsEffect } from './post';
import type { LightGrid } from './probes';
import { cloneWeapon, type WeaponCache } from './weapons';

/**
 * A shot's tracer: from the gun to where the bullet went, `width` metres wide but never under
 * `minPixels` on screen, for `seconds`; a miss runs from the shooter's eye along the aim to the
 * first wall within `reach` that stops a bullet (past chainlink: where its mark is,
 * `bulletmarks.ts`). A gun without a model in hand fires from `forward` ahead of the
 * hand. A tracer whose end is less than `minLength` ahead of the gun (a wall between the eye and
 * the muzzle: the gun poked into it) is not drawn; its flash is.
 */
export const TRACER = {
  width: 0.02,
  minPixels: 1.5,
  seconds: 0.06,
  reach: 40,
  forward: 0.5,
  minLength: 0.05,
};
/**
 * A shot's muzzle flash, for `seconds`, fading: one of CS2's `muzzle` frames (`flame_omni`,
 * picked and turned by the shot's tick and player), `size` metres across by the gun's class
 * (`muzzleClass`), a suppressed gun's `suppressed` of that and half as bright. The player seen in
 * first person fires theirs from their first-person gun's muzzle at `firstPerson` of the size
 * (times the viewmodel's magnification), where a full-size flash would fill the view. Until the
 * frames are in, the generated glow, as big.
 */
export const MUZZLE = {
  seconds: 0.05,
  size: {
    rifle: 0.45,
    pistol: 0.3,
    smg: 0.35,
    sniper: 0.6,
    shotgun: 0.55,
    mg: 0.5,
  },
  suppressed: 0.4,
  firstPerson: 0.5,
};
/** The flash's light: CS2's frames are grey; hot enough that their cores burn white. */
const MUZZLE_COLOR = new THREE.Color(0xffc070).multiplyScalar(2.5);
/**
 * Before a wall nearer the eye than the first-person muzzle, the flash stands this far in front
 * of it, and never nearer the eye than `minShare` of the way out.
 */
const FIRST_PERSON_WALL = { gap: 0.02, minShare: 0.1 };
/**
 * A hit's blood: a dark red puff (`color`) that grows by `grow` and fades over `seconds`, `size`
 * metres across but never under `minPixels` on screen, times `fatal` for the killing hit and
 * `headshot` more for a headshot, moved `toCamera` metres from the hit bone towards the camera
 * so the body does not hide it. Not a light: on a baked map `color` is its albedo, lit by the
 * light grid where the victim stood (`bloodColor`). Once CS2's `blood` frames are in, the puff
 * is a frame of the splatter sequence (`BLOOD_SPLATTER`), headshots too: the headshot sequence
 * is chunks of bone and skull, which read as a blot over the head at this size.
 */
export const BLOOD = {
  seconds: 0.35,
  size: 0.25,
  grow: 0.6,
  fatal: 1.5,
  headshot: 1.25,
  toCamera: 0.35,
  minPixels: 24,
  color: 0x7a0808,
};
/**
 * Damage numbers: a column beside each hit player, `right` metres to the right of their chest
 * as the camera sees it, oldest on top and each new hit a line below (`line` times the text
 * height apart); `pixels` high, shown for `seconds`, fading over the last `fadeS`, at most
 * `opacity`. In the attacker's team colour, `mine` for the player being watched; a headshot
 * reads `HS`.
 */
export const DAMAGE = {
  seconds: 1.2,
  pixels: 18,
  line: 1.15,
  right: 0.35,
  top: 0.3,
  fadeS: 0.3,
  opacity: 0.9,
  mine: '#ffe066',
};
export const BOOM = { size: 12, seconds: 1.5 };
/** The planted bomb's light's size; it blinks as `blinkOn` says (`sim/timeline`). */
export const BLINK_SIZE = 0.35;
export const IMPACT_POOLS = { tracers: 24, blood: 16, numbers: 24 } as const;
/** The `blood` atlas's splatter sequence (`bloodsplatter`), after the headshot's. */
export const BLOOD_SPLATTER = 1;
/**
 * CS2's splatter frames are near black (0.016 linear red at the median where they cover,
 * measured over the atlas), their shape in their alpha: a frame's colour is multiplied by this,
 * so the blood comes out as dark a red as the generated puff's.
 */
export const BLOOD_FRAME_GAIN = 60;
/**
 * And thin: alpha 0.35 at the median where they cover (0.77 at most). Their alpha is multiplied
 * by this, up to 1, so a splat covers as the generated puff did.
 */
export const BLOOD_FRAME_ALPHA = 2.5;
/** The blood's albedo, linear. */
const BLOOD_COLOR = new THREE.Color(BLOOD.color);

/** The colour of a hit's damage number when its attacker is on no side. */
export const NEUTRAL_HEX = 0x9aa0a6;

/** The bone a hit group's blood and number sit on. */
export const HITGROUP_BONE: Readonly<Record<string, string>> = {
  head: 'head_0',
  neck: 'neck_0',
  chest: 'spine_2',
  generic: 'spine_2',
  stomach: 'pelvis',
  left_arm: 'arm_upper_L',
  right_arm: 'arm_upper_R',
  left_leg: 'leg_upper_L',
  right_leg: 'leg_upper_R',
};

/** The gun drawn in first person: where its muzzle is in the scene (`Viewmodel.muzzle`). */
export interface FirstPersonMuzzle {
  /** The player whose eyes the view looks through. */
  player: number;
  /**
   * Their gun's muzzle in the scene, where the viewmodel's camera shows it; null when no gun is
   * drawn (scoped, dead, not loaded yet).
   */
  point: THREE.Vector3 | null;
  /** How much bigger than life the viewmodel's narrower field of view draws the gun. */
  scale: number;
}

/** What impacts need of a player's posed model. */
export interface PosedRig {
  object: THREE.Object3D;
  bone(name: string): THREE.Object3D | undefined;
  /**
   * Where the shots leave the gun in the hand (in the scene), into `out`; false without a gun
   * model in the hand.
   */
  muzzle?(out: THREE.Vector3): boolean;
}

export interface ImpactOptions {
  /** The players' states at the frame (header order). */
  states: readonly PlayerState[];
  /** The posed rig of player `i`, or null. */
  rig: (i: number) => PosedRig | null;
  hull: Hull | null;
  damageNumbers: boolean;
  /** The player being watched, whose damage numbers take `DAMAGE.mine`; null for nobody. */
  shown: number | null;
  eye: THREE.Vector3;
  /**
   * The camera's right and up in the world, so screen-aligned layouts (the damage column)
   * stay straight; without them they are taken from the direction to the anchor.
   */
  screen?: { right: THREE.Vector3; up: THREE.Vector3 };
  /** Metres per screen pixel at one metre from the camera. */
  worldPerPixel: number;
  /** The map's light grid (a baked map's), which lights the bomb and the blood, or null. */
  grid: LightGrid | null;
  /** The sun's light in the grid's units (three's sun over π), for the blood; null for none. */
  sunLight?: THREE.Color | null;
  /** The tone mapping's exposure, which CS2's flashes divide out (1 when not tone-mapped). */
  exposure: number;
  /**
   * The player seen in first person and their gun's muzzle, from which their tracer leaves and
   * their flash shows (none while no gun is drawn); null or left out in a third-person view.
   */
  firstPerson?: FirstPersonMuzzle | null;
  /**
   * The smokes shown (the utility's, `Utility.smokeSpheres`), which fade the flashes and the
   * blood behind them (`smokeCover`); none when left out. The first-person player's own flash,
   * in front of every smoke, is never faded.
   */
  smokes?: readonly SmokeSphere[];
}

/** A blood puff's light: sampled for one hit (its tick and victim), at `at`. */
interface BloodLight extends LitCache {
  tick: number;
  victim: number;
  at: THREE.Vector3;
}

interface Tracer {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  /** The generated flash, until CS2's frames are in. */
  flash: THREE.Sprite;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _e = new THREE.Vector3();
const _lifted = new THREE.Vector3();
const _p = new THREE.Vector3();
const _f = new THREE.Vector3();
const _blood = new THREE.Color();
const _wall = newHullHit();
const UP = new THREE.Vector3(0, 1, 0);
const NO_SMOKES: readonly SmokeSphere[] = [];

/**
 * Metres from `from` along unit `dir` to the first wall a bullet stops at, within
 * `TRACER.reach` (all of it without one or without a hull): the ray `BulletMarks` marks the wall
 * by.
 */
function missReach(
  hull: Hull | null,
  from: THREE.Vector3,
  dir: THREE.Vector3
): number {
  return hull?.raycast(from, dir, TRACER.reach, _wall)
    ? _wall.distance
    : TRACER.reach;
}

export class Impacts {
  readonly root = new THREE.Group();
  readonly labels: LabelSprites;
  private readonly weapons: WeaponCache;
  private look: LookOptions;
  private readonly effects: EffectAtlases;
  private readonly glow = glowTexture();
  private readonly puff = puffTexture(64, 23);
  private readonly tracers: Tracer[] = [];
  private readonly blood: THREE.Sprite[] = [];
  /** CS2's muzzle flashes, one per tracer at most (the tracers' glow sprites until they are in). */
  private readonly flashes = new FlipbookBatch(IMPACT_POOLS.tracers, {
    blending: 'additive',
    facing: 'camera',
    emissive: true,
  });
  /** CS2's blood, one per puff (the generated puffs until it is in): lit, not a light. */
  private readonly bloodFrames = new FlipbookBatch(IMPACT_POOLS.blood, {
    blending: 'alpha',
    facing: 'camera',
    emissive: false,
    alphaGain: BLOOD_FRAME_ALPHA,
  });
  /**
   * Each blood slot's light on a baked map, kept while the slot shows the same hit of the same
   * timeline (`bloodTimeline`): another demo's hit of the same tick and victim stood elsewhere.
   */
  private readonly bloodLights: BloodLight[] = Array.from(
    { length: IMPACT_POOLS.blood },
    () => ({ ...litCache(), tick: -1, victim: -1, at: new THREE.Vector3() })
  );
  private bloodTimeline: Timeline | null = null;
  /** Per hit player, the lines of their damage column so far this frame (`setHits`). */
  private readonly rows = new Map<number, number>();
  /** Where a hit's victim stood at its tick (`bloodColor`). */
  private readonly victim = newPlayerState();
  private readonly numbers: THREE.Sprite[] = [];
  private readonly bomb = new THREE.Group();
  private readonly bombLight: THREE.Sprite;
  private readonly boom: THREE.Sprite;
  private readonly boomBall: THREE.Sprite;
  /** The C4's copy in `bomb`, made in `look` once the cache has the model. */
  private bombModel: THREE.Object3D | null = null;
  /** Its materials, freed with it. */
  private readonly bombMaterials: LookMaterial[] = [];
  /** The grid's light on it, where it lies. */
  private readonly bombLit = new ItemLight(false);
  private readonly placeholder = new THREE.SpriteMaterial({ visible: false });
  private readonly owned: { dispose(): void }[] = [];

  /**
   * Shots, hits and the bomb, its model dressed in `look` (the players' look), the flashes and
   * the blood from `effects` once their atlases are in.
   */
  constructor(
    weapons: WeaponCache,
    look: LookOptions,
    effects: EffectAtlases,
    canvas?: CanvasFactory
  ) {
    this.weapons = weapons;
    this.look = look;
    this.effects = effects;
    this.labels = new LabelSprites(canvas);
    this.root.name = 'impacts';
    this.owned.push(this.glow, this.puff, this.placeholder);
    const additive = (color: number) =>
      this.own(
        new THREE.SpriteMaterial({
          map: this.glow,
          color,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
    for (let i = 0; i < IMPACT_POOLS.tracers; i++) {
      const geo = this.own(new THREE.BufferGeometry());
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array(12), 3)
      );
      geo.setIndex([0, 1, 2, 1, 3, 2]);
      const mesh = new THREE.Mesh(
        geo,
        this.own(
          new THREE.MeshBasicMaterial({
            color: 0xffe2a0,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
          })
        )
      );
      mesh.frustumCulled = false;
      mesh.name = 'tracer';
      const flash = new THREE.Sprite(additive(0xffc070));
      flash.name = 'muzzle-flash';
      this.hide(mesh);
      this.hide(flash);
      bloomsAsEffect(mesh, flash);
      this.tracers.push({ mesh, flash });
    }
    for (let i = 0; i < IMPACT_POOLS.blood; i++) {
      const s = new THREE.Sprite(
        this.own(
          new THREE.SpriteMaterial({
            map: this.puff,
            color: BLOOD.color,
            transparent: true,
            depthWrite: false,
          })
        )
      );
      s.name = 'blood';
      this.blood.push(this.hide(s));
    }
    this.flashes.mesh.name = 'muzzle-flashes';
    this.bloodFrames.mesh.name = 'blood-puffs';
    for (const b of [this.flashes, this.bloodFrames]) {
      this.own(b);
      this.hide(b.mesh);
    }
    // The flashes add light; the blood covers.
    bloomsAsEffect(this.flashes.mesh);
    for (let i = 0; i < IMPACT_POOLS.numbers; i++) {
      const s = this.hide(new THREE.Sprite(this.placeholder));
      s.center.set(0, MONO_CENTER_Y);
      s.renderOrder = 11;
      this.numbers.push(s);
    }
    this.bombLight = new THREE.Sprite(additive(0xff2a2a));
    this.bombLight.scale.setScalar(BLINK_SIZE);
    this.bomb.add(this.bombLight);
    this.hide(this.bomb);
    this.boom = this.hide(new THREE.Sprite(additive(0xff8a3a)));
    bloomsAsEffect(this.bombLight, this.boom);
    this.boomBall = this.hide(
      new THREE.Sprite(
        this.own(
          new THREE.SpriteMaterial({
            map: this.puff,
            color: 0xffd090,
            transparent: true,
            depthWrite: false,
          })
        )
      )
    );
  }

  /** Poses the shots, hits and bomb of round `round` at `tick` (a float). */
  set(round: number, tick: number, tl: Timeline, o: ImpactOptions): void {
    const header = tl.pack.header;
    const rate = header.tick_rate;
    this.setShots(round, tick, tl, o, rate);
    this.setHits(round, tick, tl, o, rate);
    this.setBomb(round, tick, tl, rate, o.grid);
  }

  /** Dresses the bomb in `look` from the next `set` on, freeing the old dress. */
  setLook(look: LookOptions): void {
    this.look = look;
    this.dropBomb();
  }

  dispose(): void {
    this.dropBomb();
    this.labels.dispose();
    for (const o of this.owned) o.dispose();
    this.root.removeFromParent();
  }

  /** Takes the bomb's copy out and frees its materials; the next `set` makes it again. */
  private dropBomb(): void {
    this.bombModel?.removeFromParent();
    this.bombModel = null;
    this.bombLit.clear();
    for (const m of this.bombMaterials) m.dispose();
    this.bombMaterials.length = 0;
  }

  private own<T extends { dispose(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  private hide<T extends THREE.Object3D>(o: T): T {
    o.visible = false;
    this.root.add(o);
    return o;
  }

  /**
   * Where player `i`'s shot leaves from, into `out`, and how big its flash is there (a share of
   * `MUZZLE.size`): the muzzle of the gun in their hand (`PosedRig.muzzle`), else `TRACER.forward`
   * ahead of the `wpn` bone, else 30 cm ahead of the eye, at full size. The player seen
   * in first person fires from their first-person gun's muzzle, at `MUZZLE.firstPerson` times
   * the viewmodel's scale; a wall nearer the eye than it brings the flash in front of it, along
   * the line from the eye (the same place and size on screen). Without their gun drawn
   * (scoped), from the hidden model's gun, with no flash.
   */
  private muzzle(
    i: number,
    o: ImpactOptions,
    dir: THREE.Vector3,
    out: THREE.Vector3
  ): number {
    const fp = o.firstPerson;
    if (fp && fp.player === i && fp.point) {
      out.copy(fp.point);
      let k = MUZZLE.firstPerson * fp.scale;
      const d = o.eye.distanceTo(out);
      const free = o.hull && d > 0 ? o.hull.freeDistance(o.eye, out, 0) : d;
      if (free < d) {
        const f = Math.max(
          FIRST_PERSON_WALL.minShare,
          (free - FIRST_PERSON_WALL.gap) / d
        );
        out.sub(o.eye).multiplyScalar(f).add(o.eye);
        k *= f;
      }
      return k;
    }
    const flash = fp && fp.player === i ? 0 : 1;
    const rig = o.rig(i);
    const wpn = rig?.bone('wpn');
    if (rig && wpn && rig.object.visible) {
      rig.object.updateWorldMatrix(true, true);
      if (!rig.muzzle?.(out))
        wpn.getWorldPosition(out).addScaledVector(dir, TRACER.forward);
      return flash;
    }
    eyePoint(o.states[i], out);
    out.addScaledVector(dir, 0.3);
    return flash;
  }

  private setShots(
    round: number,
    tick: number,
    tl: Timeline,
    o: ImpactOptions,
    rate: number
  ): void {
    const shots = tl.shotsAt(round, tick, TRACER.seconds * rate);
    this.flashes.begin();
    let n = 0;
    for (const shot of shots) {
      if (n >= this.tracers.length) break;
      const kind = muzzleClass(shot.weapon);
      const s = o.states[shot.player];
      if (kind === null || !s?.present) continue;
      const t = this.tracers[n++];
      if (shot.from && shot.aim) {
        // Where the bullet went, from the shot's own record: from the shooter's eye along
        // the logged aim (recoil in it) to the first wall, or for a hit along the bullet's
        // own direction (spread in it) to the player. The tracer runs there from the gun.
        toScene(shot.from.x, shot.from.y, shot.from.z, _e);
        if (shot.hit) {
          const [x, y, z] = shot.hit.dir;
          _d.set(y, z, x).normalize();
          _b.copy(_e).addScaledVector(_d, shot.hit.distance * UNIT);
        } else {
          viewDir(shot.aim.yaw, shot.aim.pitch, _d);
          _b.copy(_e).addScaledVector(_d, missReach(o.hull, _e, _d));
        }
      } else {
        // No record of the shot: along the view, from the eye to the first wall, as a miss.
        // From the eye, not the gun: a muzzle poked into a wall would find it at once.
        viewDir(s.yaw, s.pitch, _d);
        eyePoint(s, _e);
        _b.copy(_e).addScaledVector(_d, missReach(o.hull, _e, _d));
      }
      _f.copy(_d);
      const flash = this.muzzle(shot.player, o, _d, _a);
      // What the smokes leave of it: all of the first-person player's own, at their gun.
      const fp = o.firstPerson;
      const own = !!fp && fp.player === shot.player && fp.point !== null;
      const clear = own
        ? 1
        : 1 - smokeCover(o.smokes ?? NO_SMOKES, o.eye, _a.x, _a.y, _a.z);
      _d.subVectors(_b, _a);
      // Not ahead of the gun (the wall nearer the eye than the muzzle): no tracer to draw.
      const drawn = _d.dot(_f) >= TRACER.minLength;
      if (_d.lengthSq() < 1e-12) _d.copy(_f);
      _d.normalize();
      const dim = shot.suppressed ? 0.5 : 1;
      // A quad facing the camera, at least `minPixels` wide on screen at its near end.
      const w =
        Math.max(
          TRACER.width,
          _a.distanceTo(o.eye) * o.worldPerPixel * TRACER.minPixels
        ) / 2;
      _s.copy(o.eye).sub(_a).cross(_d);
      if (_s.lengthSq() < 1e-12) _s.set(0, 1, 0);
      _s.normalize().multiplyScalar(w);
      const pos = t.mesh.geometry.getAttribute(
        'position'
      ) as THREE.BufferAttribute;
      pos.setXYZ(0, _a.x + _s.x, _a.y + _s.y, _a.z + _s.z);
      pos.setXYZ(1, _a.x - _s.x, _a.y - _s.y, _a.z - _s.z);
      pos.setXYZ(2, _b.x + _s.x, _b.y + _s.y, _b.z + _s.z);
      pos.setXYZ(3, _b.x - _s.x, _b.y - _s.y, _b.z - _s.z);
      pos.needsUpdate = true;
      const age = (tick - shot.tick) / rate;
      t.mesh.visible = drawn;
      t.mesh.material.opacity = 0.9 * dim * clamp01(1 - age / TRACER.seconds);
      const size =
        MUZZLE.size[kind] * (shot.suppressed ? MUZZLE.suppressed : 1) * flash;
      const on = age < MUZZLE.seconds && size > 0;
      const opacity = dim * clamp01(1 - age / MUZZLE.seconds) * clear;
      // CS2's frame once it is in (the first flash asks for it), the glow before.
      const atlas = on ? this.effects.get('muzzle') : null;
      t.flash.visible = on && !atlas;
      t.flash.position.copy(_a);
      t.flash.scale.setScalar(size);
      t.flash.material.opacity = opacity;
      if (atlas) {
        const seed = hash01(shot.tick * 0.618 + shot.player * 7.31);
        this.flashes.setAtlas(atlas, this.glow);
        this.flashes.push(
          _a.x,
          _a.y,
          _a.z,
          size * atlas.aspect,
          size,
          seed * Math.PI * 2,
          Math.floor(hash01(seed * 57.3) * atlas.frames),
          MUZZLE_COLOR,
          opacity
        );
      }
    }
    for (let i = n; i < this.tracers.length; i++) {
      this.tracers[i].mesh.visible = false;
      this.tracers[i].flash.visible = false;
    }
    this.flashes.setExposure(o.exposure);
    this.flashes.end();
  }

  /** Where hit `group` landed on player `i`: its bone, else the chest height over the feet. */
  private hitPoint(
    i: number,
    group: string,
    o: ImpactOptions,
    out: THREE.Vector3
  ): THREE.Vector3 {
    const rig = o.rig(i);
    const bone = rig?.bone(HITGROUP_BONE[group] ?? 'spine_2');
    if (rig && bone) {
      rig.object.updateWorldMatrix(true, true);
      return bone.getWorldPosition(out);
    }
    const s = o.states[i];
    toScene(s?.x ?? 0, s?.y ?? 0, s?.z ?? 0, out);
    out.y += 1.3;
    return out;
  }

  /**
   * The colour of the blood in slot `i`, showing hit `h`: `BLOOD.color`, and on a baked map
   * that albedo lit by the light grid where the victim's eyes were at the hit's tick (one point
   * per hit: the grid is far coarser than a body, and a point of the hit, not of the frame,
   * lights it the same whether played or seeked to), and by the sun past it. Sampled when the
   * slot takes another hit or the grid or the sun changes, not every frame. Into a shared colour.
   */
  private bloodColor(
    i: number,
    h: Hit,
    round: number,
    tl: Timeline,
    o: ImpactOptions
  ): THREE.Color {
    const c = this.bloodLights[i];
    if (o.grid && (c.tick !== h.tick || c.victim !== h.victim)) {
      c.tick = h.tick;
      c.victim = h.victim;
      const { header, rounds } = tl.pack;
      const track = rounds[round]?.players[h.victim];
      const info = header.rounds[round];
      if (track && info)
        eyePoint(playerStateAt(track, info, h.tick, header, this.victim), c.at);
      else this.hitPoint(h.victim, 'head', o, c.at);
    }
    // Null without a grid: the flat colour.
    lightAt(c, c.at, 1, 1, o.grid, o.sunLight ?? null);
    _blood.copy(BLOOD_COLOR);
    return c.lit ? _blood.multiply(c.lit) : _blood;
  }

  private setHits(
    round: number,
    tick: number,
    tl: Timeline,
    o: ImpactOptions,
    rate: number
  ): void {
    const hits = tl.hitsAt(round, tick, DAMAGE.seconds * rate);
    const teams = tl.pack.header.players;
    if (tl !== this.bloodTimeline) {
      this.bloodTimeline = tl;
      for (const c of this.bloodLights) c.tick = c.victim = -1;
    }
    this.bloodFrames.begin();
    let blood = 0;
    let numbers = 0;
    const rows = this.rows;
    rows.clear();
    hits.forEach((h, i) => {
      // Its place among its victim's hits of its tick (a shotgun's pellets land together; an HE
      // or a collateral hits two players on one tick, each with a splat of their own).
      let nth = 0;
      for (let j = i - 1; j >= 0 && hits[j].tick === h.tick; j--)
        if (hits[j].victim === h.victim) nth++;
      if (h.victim < 0 || h.victim >= o.states.length) return;
      const age = (tick - h.tick) / rate;
      this.hitPoint(h.victim, h.hitgroup, o, _a);
      if (age < BLOOD.seconds && blood < this.blood.length) {
        const s = this.blood[blood++];
        const u = age / BLOOD.seconds;
        _p.copy(_a);
        _d.subVectors(o.eye, _a);
        const toEye = _d.length();
        if (toEye > 1e-6)
          _p.addScaledVector(_d, Math.min(BLOOD.toCamera, toEye / 2) / toEye);
        // It sinks a little as it spreads.
        _p.y -= 0.15 * u * u;
        const k =
          (h.fatal ? BLOOD.fatal : 1) * (h.headshot ? BLOOD.headshot : 1);
        const floor = _p.distanceTo(o.eye) * o.worldPerPixel * BLOOD.minPixels;
        const size = Math.max(floor, BLOOD.size) * k * (1 + BLOOD.grow * u);
        const opacity =
          0.95 *
          (1 - u * u) *
          (1 - smokeCover(o.smokes ?? NO_SMOKES, o.eye, _p.x, _p.y, _p.z));
        // Each hit's puff turned its own way, the pellets of one shot and its victims too.
        const rotation =
          (h.tick * 2.39996 + nth * 2.0944 + h.victim * 0.9273) % (Math.PI * 2);
        const color = this.bloodColor(blood - 1, h, round, tl, o);
        // CS2's splatter once it is in (the first puff asks for it), the generated puff before
        // and from an atlas without the sequence.
        const atlas = this.effects.get('blood');
        const seq = atlas?.sequences[BLOOD_SPLATTER] ?? atlas?.sequences[0];
        const frames = seq && seq[1] > 0 ? seq : null;
        s.visible = !frames;
        s.position.copy(_p);
        s.scale.setScalar(size);
        s.material.opacity = opacity;
        s.material.rotation = rotation;
        s.material.color.copy(color);
        if (atlas && frames) {
          // The sequence's splat (its first frame, a spray with drips) for a tick's first hit,
          // turned its own way; the drops after it for the pellets landing with it.
          this.bloodFrames.setAtlas(atlas, this.puff);
          this.bloodFrames.push(
            _p.x,
            _p.y,
            _p.z,
            size * atlas.aspect,
            size,
            rotation,
            frames[0] + (nth % frames[1]),
            _c.copy(color).multiplyScalar(BLOOD_FRAME_GAIN),
            opacity
          );
        }
      }
      if (!o.damageNumbers || numbers >= this.numbers.length) return;
      const s = this.numbers[numbers++];
      const team =
        h.attacker !== null
          ? teams[h.attacker]?.team_by_round[round]
          : undefined;
      const color =
        h.attacker !== null && h.attacker === o.shown
          ? DAMAGE.mine
          : css(
              team !== undefined ? (TEAM_HEX[team] ?? NEUTRAL_HEX) : NEUTRAL_HEX
            );
      const text = `−${h.damage}${h.headshot ? ' HS' : ''}`;
      s.material = this.labels.material(text, '', color, 'mono');
      const row = rows.get(h.victim) ?? 0;
      rows.set(h.victim, row + 1);
      // The column starts by the shoulder, right of the chest as the camera sees it, and runs
      // down the screen (along the camera's up, so it stays straight when looking down).
      this.hitPoint(h.victim, 'chest', o, s.position);
      if (o.screen) {
        _s.copy(o.screen.right);
        _b.copy(o.screen.up);
      } else {
        _d.subVectors(s.position, o.eye).normalize();
        _s.crossVectors(_d, UP);
        if (_s.lengthSq() > 1e-9) _s.normalize();
        _b.crossVectors(_s, _d);
      }
      s.position.addScaledVector(_s, DAMAGE.right);
      const perPixel = s.position.distanceTo(o.eye) * o.worldPerPixel;
      s.position.addScaledVector(
        _b,
        DAMAGE.top - row * perPixel * DAMAGE.pixels * DAMAGE.line
      );
      const height = perPixel * DAMAGE.pixels * 2;
      s.scale.set(height * this.labels.aspect, height, 1);
      s.material.opacity =
        DAMAGE.opacity * clamp01((DAMAGE.seconds - age) / DAMAGE.fadeS);
      s.visible = true;
    });
    for (let i = blood; i < this.blood.length; i++)
      this.blood[i].visible = false;
    this.bloodFrames.setExposure(o.exposure);
    this.bloodFrames.end();
    for (let i = numbers; i < this.numbers.length; i++)
      this.numbers[i].visible = false;
  }

  private setBomb(
    round: number,
    tick: number,
    tl: Timeline,
    rate: number,
    grid: LightGrid | null
  ): void {
    const b = tl.bombAt(round, tick);
    this.boom.visible = false;
    this.boomBall.visible = false;
    const lying = b.kind === 'planted' || b.kind === 'dropped';
    this.bomb.visible = lying;
    if (lying) {
      toScene(b.x, b.y, b.z, this.bomb.position);
      if (!this.bombModel) {
        const src = this.weapons.get('c4');
        if (src) {
          this.bombModel = cloneWeapon(
            src,
            this.look,
            this.bombMaterials,
            false
          );
          this.bombModel.name = 'bomb';
          this.bomb.add(this.bombModel);
          this.bombLit.add(this.bombModel);
        }
      }
      _lifted.copy(this.bomb.position).y += FLOOR_LIFT;
      this.bombLit.set(grid, _lifted);
      this.bombLight.position.set(0, 0.12, 0);
      this.bombLight.visible =
        b.kind === 'planted' && blinkOn((tick - b.tick) / rate);
    }
    if (b.kind === 'exploded') {
      const age = (tick - b.tick) / rate;
      if (age >= 0 && age < BOOM.seconds) {
        const p = age / BOOM.seconds;
        toScene(b.x, b.y, b.z, this.boom.position);
        this.boom.position.y += 1.5;
        this.boomBall.position.copy(this.boom.position);
        const grow = 1 - (1 - Math.min(1, p * 4)) ** 2;
        this.boom.visible = true;
        this.boom.scale.setScalar(BOOM.size * grow * 1.4);
        this.boom.material.opacity = 1 - p;
        this.boomBall.visible = true;
        this.boomBall.scale.setScalar(BOOM.size * grow);
        this.boomBall.material.opacity = 1 - p * p;
        this.boomBall.material.color
          .setHex(0xffe0a0)
          .lerp(_c.setHex(0x5a4e46), p * p);
      }
    }
  }
}
