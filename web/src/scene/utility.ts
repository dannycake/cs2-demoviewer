// Grenades and their effects in the scene, posed every frame from the round timeline alone
// (`sim/timeline.ts`): a grenade in flight is its model, a glow, a ribbon of the last 1.2 s of
// its path and a label (SMOKE, FLASH, HE, MOLLY, INC, DECOY over the thrower's name) at a fixed
// size on screen; a smoke is a cluster of puffs of CS2's smoke, grey-white and lit where it
// stands on a baked map, in the fog's colour on any other; a fire CS2's flames over a glowing
// disc with smoke rising off it (`fire.ts`); a flash the generated glow with CS2's flare over it; an HE grenade CS2's fireball,
// a ring on the ground and smoke rising after; a decoy pops as a muzzle flash throwing sparks.
// CS2's frames come from the effect atlases (`effects.ts`), each asked for when an effect that
// draws it first shows; until it arrives, and for good without one, the generated sprite of
// before draws instead (noise flames, the generated puff and glow; nothing for the fire's burst
// and the decoy's sparks). The puffs and sprites cut from an atlas are instanced batches
// (`flipbook.ts`): the smokes one, drawn farthest first, the HEs' fireballs and smoke, the decoys'
// flashes and sparks, and each fire's smoke column one each.
// Every object comes from a pool made up front and is shown or hidden, so playing, scrubbing
// and seeking allocate nothing. A grenade's model is dressed in the scene's look as the players'
// weapons are (`cloneWeapon`), which also sets the cache's shared textures' filtering: an
// undressed copy would draw differently once a player had held that kind of grenade. Each
// slot's copies have materials of their own, so that on a baked map each grenade takes the
// light grid where it flies (`ItemLight`), sampled on every frame it moves.

import * as THREE from 'three';
import { toScene } from '../geo/coords';
import type { Grenade } from '../pack/types';
import {
  FIRE_RADIUS,
  SMOKE_RADIUS,
  type Effect,
  type Projectile,
  type Timeline,
} from '../sim/timeline';
import { css } from './colors';
import type { Atlas, EffectAtlases } from './effects';
import { LabelSprites, type CanvasFactory } from './labels';
import { FlipbookBatch, frameRect, onceFrame } from './flipbook';
import {
  FLAMES,
  fireSmokePuff,
  flameAtlasMaterial,
  flameGeometry,
  flameLayout,
  flameMaterial,
  setFlameLayout,
  setFlameSequences,
  type FlameLayout,
  type SmokePuff,
} from './fire';
import { ItemLight } from './itemlight';
import type { LookMaterial, LookOptions } from './look';
import { SeededRandom } from '../sim/random';
import { glowTexture, hash01, puffTexture } from './noise';
import { bloomsAsEffect } from './post';
import { lightAt, litCache, type LitCache } from './gridlight';
import { clamp01 } from './util';
import { smokeCover, type SmokeSphere } from './smokecover';
import type { LightGrid } from './probes';
import { cloneWeapon, type WeaponCache } from './weapons';

/** Pool sizes: more at once than this are not drawn. */
export const POOLS = {
  projectiles: 16,
  smokes: 12,
  fires: 8,
  flashes: 4,
  /** An HE lasts 3.3 s with its smoke: ten at once covers a team's HEs thrown together. */
  hes: 10,
  decoys: 4,
} as const;

/**
 * A smoke's colour on a map with a bake: CS2's smokes are grey-white whatever the sky, lit as the
 * scene is, so a smoke is this albedo times the light where it stands (`poseSmoke`). Without a
 * bake it keeps the fog's colour, as before.
 */
export const SMOKE_ALBEDO = 0.8;
/**
 * How much of the light's colour a smoke keeps on a baked map; the rest is its brightness alone.
 * The light under a warm sun and off sand is orange (Mirage's at its smokes about (1.3, 1.0, 0.7)),
 * which made the whole smoke read as sand, where CS2's stays grey-white.
 */
export const SMOKE_TINT = 0.25;
export const SMOKE = {
  radius: SMOKE_RADIUS,
  expandS: 0.6,
  fadeS: 1.5,
  puffs: 16,
  lift: 1.2,
  opacity: 0.97,
  /** How fast a puff of CS2's smoke turns, radians a second (from a turn of its own). */
  turn: 0.05,
};
/**
 * CS2's smoke frames (`smokeloop_i_0_sc_hardedge`) are a mid grey, 0.32 linear where they cover
 * (alpha-weighted, measured over the atlas); the generated puff they replace is about 0.88. A
 * frame's colour is multiplied by this, so the smokes, the HE's smoke and the fire's smoke
 * column stay as bright as they were (grey-white under the bake).
 */
export const SMOKE_FRAME_GAIN = 2.75;
export const FIRE = {
  radius: FIRE_RADIUS,
  flames: 64,
  fadeInS: 0.2,
  fadeOutS: 0.5,
  light: 6,
  /** The fire light's reach in metres (three.js's cut-off, its fall-off squared). */
  distance: 9,
  lights: 2,
};
/**
 * The fire's light on a map with a bake: a glow on the floor and walls within about 3–4 m, as
 * CS2's. The bake's rooms are darker than the hemisphere light of the look without one, so the
 * 9 m light at 6 lit a whole room orange (Mirage's, 2026-10-25).
 */
export const FIRE_BAKED_LIGHT = { light: 2.5, distance: 4 };
export const FLASH = { size: 4, growS: 0.08, fadeS: 0.25 };
/**
 * An HE grenade. `size`, `growS` and `s`: the ring on the ground, grown over `ring` metres, and
 * the glow of the blast, both faded over `s` (with the generated fireball while CS2's is
 * missing). CS2's fireball (`explosion_fireball_01_flame`) is played once over `explosionS`,
 * `explosionSize` metres across: its atlas holds the sheet's five fireballs of `fireballFrames`
 * frames one after another, one of which each HE plays. After it `smokePuffs` puffs of CS2's
 * smoke rise `smokeRise` metres and fade over `smokeS`, in `smokeColor` (its albedo on a baked
 * map) at up to `smokeOpacity`, each `smokeSize` metres across at first and twice that as they
 * fade.
 */
export const HE = {
  size: 2.5,
  growS: 0.3,
  ring: 5,
  s: 0.6,
  explosionS: 0.8,
  explosionSize: 4,
  fireballFrames: 8,
  smokePuffs: 6,
  smokeS: 2.5,
  smokeRise: 1.5,
  smokeColor: 0x6b6b6b,
  smokeOpacity: 0.5,
  smokeSize: 1.8,
};
/**
 * A decoy pops every `beatS`, each pop seen for `popS`, and goes off with a bigger one over its
 * last `endS`; with CS2's frames a pop is a muzzle flash throwing `sparks` streaks
 * `sparkLength` metres long.
 */
export const DECOY = {
  beatS: 0.6,
  popS: 0.12,
  endS: 0.3,
  sparks: 3,
  sparkLength: 1.4,
};
/**
 * CS2's fireball frames are grey (the game tints them): yellow-white at the blast to orange as
 * it burns out, `FIREBALL_GAIN` times as bright, as they should show on screen (linear, the
 * exposure divided out).
 */
const FIREBALL_HOT = new THREE.Color(1, 0.62, 0.25);
const FIREBALL_COOL = new THREE.Color(1, 0.3, 0.06);
const FIREBALL_GAIN = 8;
/**
 * CS2's flare is a small hot core with faint rays: drawn this many times as bright (linear) over
 * the flash's glow, its rays show past the glow's edge.
 */
const FLARE_GAIN = 2;
/** The decoy's pop: the glow's warm white, and its sparks' yellow. */
const DECOY_FLASH = new THREE.Color(0xfff0c0);
const DECOY_SPARK = new THREE.Color(0xffd27a).multiplyScalar(2);
/** The fire's smoke column, dark. */
const FIRE_SMOKE = new THREE.Color(0x3d3834);
/** The HE's smoke without a bake, and its albedo (linear, grey) under one. */
const HE_SMOKE = new THREE.Color(HE.smokeColor);
const HE_SMOKE_ALBEDO = HE_SMOKE.r;
export const TRAIL = { seconds: 1.2, width: 0.08, points: 65 };
/** A label's height on screen in pixels, and how far above the grenade it floats (metres). */
export const LABEL = { pixels: 44, lift: 0.3 };

export const KIND_COLOR: Readonly<Record<Grenade['kind'], number>> = {
  smoke: 0xd8dde3,
  flash: 0xfff3b0,
  he: 0xff5a3c,
  molotov: 0xff8a1f,
  incendiary: 0xff8a1f,
  decoy: 0x9fd38a,
};

/** The weapon model each grenade kind flies as (`/weapons/<name>.glb`). */
export const KIND_MODEL: Readonly<Record<Grenade['kind'], string>> = {
  smoke: 'smokegrenade',
  flash: 'flashbang',
  he: 'hegrenade',
  molotov: 'molotov',
  incendiary: 'incendiary',
  decoy: 'decoy',
};

export interface UtilityOptions {
  labels: boolean;
  trails: boolean;
  /** Point lights in fires (the `high` preset). */
  lights: boolean;
  fogColor: THREE.Color;
  /** The camera's position, for the ribbons' facing and the labels' constant size. */
  eye: THREE.Vector3;
  /** Metres per screen pixel at one metre from the camera: 2·tan(fov/2) / screen height. */
  worldPerPixel: number;
  /** The tone mapping's exposure, which the flames divide out (1 when not tone-mapped). */
  exposure: number;
  /** The map's light grid (a baked map's), which lights the grenades in flight and the smokes, or null. */
  grid: LightGrid | null;
  /**
   * The sun's light on a surface facing it, in the grid's units (the scene's sun over π, as a
   * Lambert without π takes it), for the smokes on a baked map; null for none.
   */
  sunLight: THREE.Color | null;
}

const easeOut = (p: number) => 1 - (1 - p) * (1 - p);

/** Where grenade `g` (at least one sample) is at `tick` (a float), in scene metres. */
export function grenadeAt(
  g: Grenade,
  tick: number,
  tickStep: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const f = Math.min(
    Math.max(0, (tick - g.start_tick) / tickStep),
    g.samples - 1
  );
  const k = Math.floor(f);
  const j = Math.min(k + 1, g.samples - 1);
  const u = f - k;
  toScene(
    g.x[k] + (g.x[j] - g.x[k]) * u,
    g.y[k] + (g.y[j] - g.y[k]) * u,
    g.z[k] + (g.z[j] - g.z[k]) * u,
    out
  );
  return out;
}

interface ProjectileSlot {
  group: THREE.Group;
  /** This slot's copy of each grenade model it has flown, by name, in `group`. */
  models: Map<string, THREE.Object3D>;
  /** The grid's light on its copies, where the grenade flies. */
  light: ItemLight;
  glow: THREE.Sprite;
  ribbon: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  label: THREE.Sprite;
}

/** A smoke as last posed; its puffs are drawn from it into the smokes' batch. */
interface SmokeSlot extends LitCache {
  /** Shown by the last `set`. */
  shown: boolean;
  /** The smoke's entity, which lays out its puffs, and its age (seconds). */
  entity: number;
  age: number;
  /** Where its grenade lies, where its volume is centred and how far it reaches. */
  base: THREE.Vector3;
  centre: THREE.Vector3;
  radius: number;
  opacity: number;
  /** Its squared distance from the eye, to draw the farthest first. */
  distance: number;
}

interface FireSlot {
  group: THREE.Group;
  disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  /** Noise flames until the `fire` atlas arrives, CS2's after. */
  flames: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** Each flame's `fireburst` as it catches; hidden until that atlas arrives. */
  burst: THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  /** The atlases the flames and the burst draw from, once they do. */
  fireAtlas: Atlas | null;
  burstAtlas: Atlas | null;
  /** The smoke column, in the fire's frame. */
  smoke: FlipbookBatch;
  layout: FlameLayout;
  /** The fire the flames are laid out for, or −1. */
  entity: number;
  /** As last posed: strength 0 to 1, and squared distance to the eye. */
  strength: number;
  distance: number;
}

interface BurstSlot {
  group: THREE.Group;
  /** The generated glow: the flash's, the HE's, the decoy's. */
  core: THREE.Sprite;
  /** Flash only: CS2's flare over the glow, shown once its atlas is in. */
  flare: THREE.Sprite | null;
  /** HE only: the solid body of the generated fireball under the glow. */
  ball: THREE.Sprite | null;
  ring: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null;
}

/** An HE: its smoke is lit where it hangs (`smokeAt`, a vector of its own) on a baked map. */
interface HeSlot extends BurstSlot, LitCache {
  smokeAt: THREE.Vector3;
}

/** Sets a flame material's age, strength and exposure (`fire.ts`); a burst's placeholder has none. */
function timeFlames(
  m: THREE.ShaderMaterial,
  age: number,
  strength: number,
  exposure: number
): void {
  const u = m.uniforms;
  if (!u.uTime) return;
  u.uTime.value = age;
  u.uStrength.value = strength;
  u.uExposure.value = exposure;
}

/**
 * Sorts `slots` farthest first in place: an insertion sort (over at most POOLS.smokes), which
 * makes nothing.
 */
function farthestFirst(slots: SmokeSlot[]): void {
  for (let i = 1; i < slots.length; i++) {
    const s = slots[i];
    let j = i - 1;
    for (; j >= 0 && slots[j].distance < s.distance; j--)
      slots[j + 1] = slots[j];
    slots[j + 1] = s;
  }
}

const _seq: [number, number] = [0, 0];
/** The smokes' puff layouts, seeded again for each smoke. */
const _rand = new SeededRandom();

/**
 * The frame of CS2's fireball at `age`, or null outside `explosionS`. The atlas lists its five
 * fireballs (16 frames each in the sheet, every second kept) as one sequence, one after
 * another: `seed` (0..1) picks one and it is played once. An atlas that lists them as sequences
 * of their own has one of those picked.
 */
function fireballFrame(atlas: Atlas, seed: number, age: number): number | null {
  const seqs = atlas.sequences;
  if (seqs.length > 1) {
    const s = seqs[Math.min(seqs.length - 1, Math.floor(seed * seqs.length))];
    _seq[0] = s[0];
    _seq[1] = s[1];
  } else {
    const [first, count] = seqs[0];
    const n = Math.min(HE.fireballFrames, count);
    const balls = Math.max(1, Math.floor(count / n));
    _seq[0] = first + Math.min(balls - 1, Math.floor(seed * balls)) * n;
    _seq[1] = n;
  }
  return onceFrame(_seq, age, HE.explosionS);
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _rect = new THREE.Vector4();
const _puff: SmokePuff = { x: 0, y: 0, z: 0, scale: 1, opacity: 0, frame: 0 };

export class Utility {
  readonly root = new THREE.Group();
  readonly labels: LabelSprites;
  private readonly weapons: WeaponCache;
  private look: LookOptions;
  /** The materials of the slots' grenade copies, freed with them. */
  private readonly materials: LookMaterial[] = [];
  private readonly atlases: EffectAtlases;
  /** What a burst shows before its atlas arrives: nothing. */
  private readonly noBurst = new THREE.ShaderMaterial({ visible: false });
  private readonly textures = {
    puff: puffTexture(),
    glow: glowTexture(),
  };
  private readonly projectiles: ProjectileSlot[] = [];
  private readonly smokes: SmokeSlot[] = [];
  private readonly fires: FireSlot[] = [];
  private readonly flashes: BurstSlot[] = [];
  private readonly hes: HeSlot[] = [];
  private readonly decoys: BurstSlot[] = [];
  /** Every smoke's puffs: CS2's smoke frames, or the generated puff without them. */
  private readonly smokePuffs = new FlipbookBatch(POOLS.smokes * SMOKE.puffs, {
    blending: 'alpha',
    facing: 'camera',
    emissive: false,
  });
  /** The HEs' fireballs (CS2's frames only) and the smoke after them. */
  private readonly fireballs = new FlipbookBatch(POOLS.hes, {
    blending: 'additive',
    facing: 'camera',
    emissive: true,
  });
  private readonly heSmoke = new FlipbookBatch(POOLS.hes * HE.smokePuffs, {
    blending: 'alpha',
    facing: 'camera',
    emissive: false,
  });
  /** The decoys' pops: CS2's muzzle flash and sparks (until they arrive, the glow alone). */
  private readonly decoyFlashes = new FlipbookBatch(POOLS.decoys, {
    blending: 'additive',
    facing: 'camera',
    emissive: true,
  });
  private readonly decoySparks = new FlipbookBatch(
    POOLS.decoys * DECOY.sparks,
    { blending: 'additive', facing: 'camera', emissive: true }
  );
  /** The batches above, filled by each `set`. */
  private readonly batches: FlipbookBatch[];
  /** The smokes the last `set` showed, drawn farthest first. */
  private readonly shown: SmokeSlot[] = [];
  /** The flare's cell of its atlas (a copy of its texture, sharing the image), once it is in. */
  private flare: THREE.Texture | null = null;
  private flareAtlas: Atlas | null = null;
  private readonly lights: THREE.PointLight[] = [];
  /** What a label sprite shows before its first label. */
  private readonly placeholder = new THREE.SpriteMaterial({ visible: false });
  /** Geometry, materials and textures the slots share, freed on dispose. */
  private readonly owned: { dispose(): void }[] = [];
  /** The fires shown by the last `set`, nearest the eye first, for the lights. */
  private readonly burning: FireSlot[] = [];
  private readonly effects: Effect[] = [];
  private readonly flying: Projectile[] = [];

  constructor(
    weapons: WeaponCache,
    atlases: EffectAtlases,
    look: LookOptions,
    canvas?: CanvasFactory
  ) {
    this.weapons = weapons;
    this.look = look;
    this.atlases = atlases;
    this.labels = new LabelSprites(canvas);
    this.root.name = 'utility';
    const ringGeo = new THREE.RingGeometry(0.9, 1, 48).rotateX(-Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2);
    this.owned.push(ringGeo, discGeo, ...Object.values(this.textures));
    const additive = (map: THREE.Texture, color: number) =>
      this.own(
        new THREE.SpriteMaterial({
          map,
          color,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
    for (let i = 0; i < POOLS.projectiles; i++)
      this.projectiles.push(this.projectileSlot());
    for (let i = 0; i < POOLS.smokes; i++)
      this.smokes.push({
        ...litCache(),
        shown: false,
        entity: -1,
        age: 0,
        base: new THREE.Vector3(),
        centre: new THREE.Vector3(),
        radius: 0,
        opacity: 0,
        distance: 0,
      });
    this.batches = [
      this.smokePuffs,
      this.fireballs,
      this.heSmoke,
      this.decoyFlashes,
      this.decoySparks,
    ];
    const names = [
      'smokes',
      'he-fireball',
      'he-smoke',
      'decoy-flash',
      'decoy-sparks',
    ];
    this.batches.forEach((b, i) => {
      b.mesh.name = names[i];
      this.own(b);
      this.hidden(b.mesh);
    });
    // CS2's fireball and the decoy's pops add light; the smokes cover.
    bloomsAsEffect(
      this.fireballs.mesh,
      this.decoyFlashes.mesh,
      this.decoySparks.mesh
    );
    for (let i = 0; i < POOLS.fires; i++) {
      const group = this.hidden(new THREE.Group());
      const disc = new THREE.Mesh(
        discGeo,
        this.own(
          new THREE.MeshBasicMaterial({
            map: this.textures.glow,
            // Orange, not red: added to a sunlit floor, red reads as pink.
            color: 0xff6a12,
            transparent: true,
            opacity: 0.6,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          })
        )
      );
      // The flame and burst materials change when their atlases arrive: freed on dispose.
      const flames = new THREE.Mesh(
        this.own(flameGeometry(FIRE.flames)),
        flameMaterial()
      );
      flames.name = 'fire-flames';
      const burst = new THREE.Mesh(
        this.own(flameGeometry(FIRE.flames)),
        this.noBurst
      );
      burst.name = 'fire-burst';
      burst.visible = false;
      bloomsAsEffect(disc, flames, burst);
      // The quad's own bounds say nothing of where its instances stand.
      for (const m of [flames, burst]) {
        m.frustumCulled = false;
        m.renderOrder = 2;
      }
      const smoke = this.own(
        new FlipbookBatch(FLAMES.smokePuffs, {
          blending: 'alpha',
          facing: 'camera',
          emissive: false,
        })
      );
      smoke.mesh.name = 'fire-smoke';
      smoke.mesh.visible = false;
      group.add(disc, flames, burst, smoke.mesh);
      this.fires.push({
        group,
        disc,
        flames,
        burst,
        fireAtlas: null,
        burstAtlas: null,
        smoke,
        layout: flameLayout(0, FIRE.flames, FIRE.radius),
        entity: -1,
        strength: 0,
        distance: 0,
      });
    }
    const burst = (color: number, ring: boolean, flares = false): BurstSlot => {
      const group = this.hidden(new THREE.Group());
      const core = new THREE.Sprite(additive(this.textures.glow, color));
      group.add(core);
      bloomsAsEffect(core);
      let flare: BurstSlot['flare'] = null;
      if (flares) {
        // The glow stands in for its map until the atlas is in, while it is hidden.
        flare = new THREE.Sprite(additive(this.textures.glow, color));
        flare.material.color.multiplyScalar(FLARE_GAIN);
        flare.visible = false;
        group.add(flare);
        bloomsAsEffect(flare);
      }
      let r: BurstSlot['ring'] = null;
      let ball: BurstSlot['ball'] = null;
      if (ring) {
        ball = new THREE.Sprite(
          this.own(
            new THREE.SpriteMaterial({
              map: this.textures.puff,
              color: 0xffa04a,
              transparent: true,
              depthWrite: false,
            })
          )
        );
        group.add(ball);
        // The HE's fireball, yellow-white at the blast.
        bloomsAsEffect(ball);
        r = new THREE.Mesh(
          ringGeo,
          this.own(
            new THREE.MeshBasicMaterial({
              color,
              transparent: true,
              depthWrite: false,
              side: THREE.DoubleSide,
            })
          )
        );
        group.add(r);
      }
      return { group, core, flare, ball, ring: r };
    };
    for (let i = 0; i < POOLS.flashes; i++)
      this.flashes.push(burst(0xffffff, false, true));
    for (let i = 0; i < POOLS.hes; i++)
      this.hes.push({
        ...burst(0xff6a2a, true),
        ...litCache(),
        smokeAt: new THREE.Vector3(),
      });
    for (let i = 0; i < POOLS.decoys; i++)
      this.decoys.push(burst(0xfff0c0, false));
    for (let i = 0; i < FIRE.lights; i++) {
      const l = new THREE.PointLight(0xff7a1a, 0, FIRE.distance, 2);
      l.visible = false;
      this.lights.push(l);
      this.root.add(l);
    }
  }

  /** Poses every grenade and effect of round `round` at `tick` (a float). */
  set(round: number, tick: number, tl: Timeline, opts: UtilityOptions): void {
    const { tick_rate: rate, tick_step: step } = tl.pack.header;
    this.setProjectiles(
      tl.projectilesAt(round, tick, this.flying),
      tick,
      rate,
      step,
      opts,
      tl
    );
    let smoke = 0;
    let fire = 0;
    let flash = 0;
    let he = 0;
    let decoy = 0;
    this.burning.length = 0;
    this.shown.length = 0;
    for (let i = 0; i < this.batches.length; i++) this.batches[i].begin();
    const effects = tl.effectsAt(round, tick, this.effects);
    // The smokes first: the HEs, decoys and flashes behind them are faded by every one shown.
    for (const e of effects) {
      if (e.kind !== 'smoke' || smoke >= this.smokes.length) continue;
      toScene(e.x, e.y, e.z, _p);
      const age = (tick - e.startTick) / rate;
      const left = (e.endTick - tick) / rate;
      this.poseSmoke(this.smokes[smoke++], e, age, left, opts);
    }
    for (const e of effects) {
      if (e.kind === 'smoke') continue;
      const age = (tick - e.startTick) / rate;
      const left = (e.endTick - tick) / rate;
      toScene(e.x, e.y, e.z, _p);
      if (e.kind === 'fire' && fire < this.fires.length) {
        const f = this.fires[fire++];
        this.poseFire(f, e, age, left, opts.exposure);
        f.distance = _p.distanceToSquared(opts.eye);
        this.burning.push(f);
      } else if (e.kind === 'flash' && flash < this.flashes.length)
        this.poseFlash(this.flashes[flash++], age, opts);
      else if (e.kind === 'he' && he < this.hes.length)
        this.poseHe(this.hes[he++], e, age, opts);
      else if (e.kind === 'decoy' && decoy < this.decoys.length)
        this.poseDecoy(this.decoys[decoy++], e, age, left, opts);
    }
    for (let i = smoke; i < this.smokes.length; i++)
      this.smokes[i].shown = false;
    this.drawSmokes(opts);
    for (let i = 0; i < this.batches.length; i++) {
      this.batches[i].setExposure(opts.exposure);
      this.batches[i].end();
    }
    for (let i = fire; i < this.fires.length; i++)
      this.fires[i].group.visible = false;
    for (let i = flash; i < this.flashes.length; i++)
      this.flashes[i].group.visible = false;
    for (let i = he; i < this.hes.length; i++)
      this.hes[i].group.visible = false;
    for (let i = decoy; i < this.decoys.length; i++)
      this.decoys[i].group.visible = false;
    // The nearest fires get the lights. The lights stay in the scene, at zero when unused, so
    // a fire starting or ending never changes the light count and recompiles every shader.
    this.burning.sort((a, b) => a.distance - b.distance);
    const fireLight = opts.grid ? FIRE_BAKED_LIGHT : FIRE;
    this.lights.forEach((l, i) => {
      l.visible = opts.lights;
      l.distance = fireLight.distance;
      const f = this.burning[i];
      l.intensity =
        f && opts.lights
          ? fireLight.light *
            f.strength *
            (0.85 + 0.15 * Math.sin(tick * 0.9 + i))
          : 0;
      if (f) l.position.copy(f.group.position).setY(f.group.position.y + 0.6);
    });
  }

  /**
   * The smokes shown by the last `set`, as what is behind them sees them (`smokeCover`): the
   * utility's own list, refilled by each `set`, not a copy. Read only.
   */
  get smokeSpheres(): readonly SmokeSphere[] {
    return this.shown;
  }

  /**
   * The lit colour of a smoke shown by the last `set` that `eye` is inside (on a baked map), or
   * null: inside none, or a smoke in the fog's colour.
   */
  smokeColorAt(eye: THREE.Vector3): THREE.Color | null {
    for (const s of this.smokes)
      if (s.shown && s.lit && s.centre.distanceTo(eye) < s.radius) return s.lit;
    return null;
  }

  /** Whether `eye` (scene metres) is inside a smoke shown by the last `set`. */
  eyeInSmoke(eye: THREE.Vector3): boolean {
    return this.smokes.some(
      (s) => s.shown && s.centre.distanceTo(eye) < s.radius
    );
  }

  /** Dresses the grenades in `look` from the next `set` on, freeing the old dress. */
  setLook(look: LookOptions): void {
    this.look = look;
    this.dropModels();
  }

  dispose(): void {
    this.dropModels();
    for (const p of this.projectiles) {
      p.ribbon.geometry.dispose();
      p.ribbon.material.dispose();
      p.glow.material.dispose();
    }
    for (const f of this.fires) {
      f.flames.material.dispose();
      f.burst.material.dispose();
    }
    this.flare?.dispose();
    this.noBurst.dispose();
    this.labels.dispose();
    this.placeholder.dispose();
    for (const o of this.owned) o.dispose();
    this.root.removeFromParent();
  }

  /** Drops every grenade copy and frees their materials; the next `set` makes them again. */
  private dropModels(): void {
    for (const slot of this.projectiles) {
      for (const o of slot.models.values()) slot.group.remove(o);
      slot.models.clear();
      slot.light.clear();
    }
    for (const m of this.materials) m.dispose();
    this.materials.length = 0;
  }

  /**
   * A copy of grenade model `name` in the look, in materials of its own, made when the cache
   * has it; null until then.
   */
  private grenadeModel(name: string): THREE.Object3D | null {
    const src = this.weapons.get(name);
    if (!src) return null;
    // No shadows of its own, as before the dress (the grid's light lets the shadow maps reach
    // it: `ItemLight`).
    const copy = cloneWeapon(src, this.look, this.materials, false);
    copy.name = `grenade:${name}`;
    return copy;
  }

  private own<T extends { dispose(): void }>(o: T): T {
    this.owned.push(o);
    return o;
  }

  private hidden<T extends THREE.Object3D>(o: T): T {
    o.visible = false;
    this.root.add(o);
    return o;
  }

  private projectileSlot(): ProjectileSlot {
    const group = this.hidden(new THREE.Group());
    const glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.textures.glow,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    glow.scale.setScalar(0.45);
    bloomsAsEffect(glow);
    const geo = new THREE.BufferGeometry();
    const n = TRAIL.points;
    geo.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3)
    );
    geo.setAttribute(
      'color',
      new THREE.BufferAttribute(new Float32Array(n * 2 * 4), 4)
    );
    const index: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(index);
    geo.setDrawRange(0, 0);
    const ribbon = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    ribbon.frustumCulled = false;
    // In world coordinates: kept out of the moving group.
    this.hidden(ribbon);
    const label = new THREE.Sprite(this.placeholder);
    label.center.set(0.5, 0);
    label.renderOrder = 10;
    group.add(glow, label);
    return {
      group,
      models: new Map(),
      light: new ItemLight(false),
      glow,
      ribbon,
      label,
    };
  }

  private setProjectiles(
    flying: Projectile[],
    tick: number,
    rate: number,
    step: number,
    opts: UtilityOptions,
    tl: Timeline
  ): void {
    const players = tl.pack.header.players;
    for (let i = 0; i < this.projectiles.length; i++) {
      const slot = this.projectiles[i];
      const p = flying[i];
      if (!p || p.grenade.samples < 1) {
        slot.group.visible = false;
        slot.ribbon.visible = false;
        continue;
      }
      const g = p.grenade;
      const color = KIND_COLOR[g.kind];
      const flown = (tick - g.start_tick) / rate;
      grenadeAt(g, tick, step, _p);
      slot.group.visible = true;
      slot.group.position.copy(_p);
      // The model: one copy per kind, made once the cache has it; it tumbles as it flies.
      const name = KIND_MODEL[g.kind];
      let model = slot.models.get(name);
      if (!model) {
        const copy = this.grenadeModel(name);
        if (copy) {
          model = copy;
          slot.models.set(name, model);
          slot.group.add(model);
          slot.light.add(model);
        }
      }
      for (const [n, o] of slot.models) o.visible = n === name;
      model?.rotation.set(flown * 9, flown * 4, 0);
      slot.light.set(opts.grid, _p);
      slot.glow.material.color.setHex(color);
      // The label, a fixed size on screen.
      slot.label.visible = opts.labels;
      if (opts.labels) {
        const who = g.thrower < players.length ? players[g.thrower].name : '';
        slot.label.material = this.labels.material(p.label, who, css(color));
        const h = _p.distanceTo(opts.eye) * opts.worldPerPixel * LABEL.pixels;
        slot.label.scale.set(h * this.labels.aspect, h, 1);
        slot.label.position.set(0, LABEL.lift, 0);
      }
      this.poseRibbon(slot, g, tick, rate, step, color, opts);
    }
  }

  /** A strip `TRAIL.width` wide facing the camera, over the last `TRAIL.seconds` of flight. */
  private poseRibbon(
    slot: ProjectileSlot,
    g: Grenade,
    tick: number,
    rate: number,
    step: number,
    color: number,
    opts: UtilityOptions
  ): void {
    const from = Math.max(g.start_tick, tick - TRAIL.seconds * rate);
    const span = tick - from;
    const n =
      span <= 0
        ? 0
        : Math.min(TRAIL.points, Math.max(2, Math.ceil(span / step) + 1));
    slot.ribbon.visible = opts.trails && n >= 2;
    if (!slot.ribbon.visible) return;
    const geo = slot.ribbon.geometry;
    geo.setDrawRange(0, (n - 1) * 6);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const col = geo.getAttribute('color') as THREE.BufferAttribute;
    _c.setHex(color);
    const at = (i: number, out: THREE.Vector3) =>
      grenadeAt(
        g,
        from + (span * Math.min(Math.max(i, 0), n - 1)) / (n - 1),
        step,
        out
      );
    for (let i = 0; i < n; i++) {
      at(i, _q);
      // Along the path from the neighbours; across it, facing the camera.
      at(i + 1, _t).sub(at(i - 1, _s));
      _s.copy(opts.eye).sub(_q).cross(_t);
      if (_s.lengthSq() < 1e-12) _s.set(0, 1, 0);
      _s.normalize().multiplyScalar(TRAIL.width / 2);
      pos.setXYZ(i * 2, _q.x + _s.x, _q.y + _s.y, _q.z + _s.z);
      pos.setXYZ(i * 2 + 1, _q.x - _s.x, _q.y - _s.y, _q.z - _s.z);
      const u = i / (n - 1); // 0 at the tail, 1 at the grenade
      const a = 0.9 * u * u;
      col.setXYZW(i * 2, _c.r, _c.g, _c.b, a);
      col.setXYZW(i * 2 + 1, _c.r, _c.g, _c.b, a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }

  /**
   * Poses smoke `s`: its size, fade and light (on a baked map, SMOKE_ALBEDO times the light at
   * its centre, `lightAt`). Its puffs are drawn by `drawSmokes` once every smoke is posed.
   */
  private poseSmoke(
    s: SmokeSlot,
    e: Effect,
    age: number,
    left: number,
    opts: UtilityOptions
  ): void {
    const grow = easeOut(clamp01(age / SMOKE.expandS));
    s.shown = true;
    s.entity = e.entityId;
    s.age = age;
    s.base.copy(_p);
    s.centre.copy(_p).setY(_p.y + SMOKE.lift);
    s.radius = SMOKE.radius * grow;
    s.opacity = SMOKE.opacity * clamp01(left / SMOKE.fadeS);
    s.distance = s.centre.distanceToSquared(opts.eye);
    lightAt(s, s.centre, SMOKE_ALBEDO, SMOKE_TINT, opts.grid, opts.sunLight);
    this.shown.push(s);
  }

  /**
   * The shown smokes' puffs into their batch, the farthest smoke first so a nearer one covers
   * it. A puff stands where its smoke's entity puts it; with CS2's frames each is a fixed frame
   * (by a seed of its own) turning `SMOKE.turn` from a turn of that seed, as bright as the
   * generated puff (`SMOKE_FRAME_GAIN`); without them the generated puff, upright, as before.
   */
  private drawSmokes(opts: UtilityOptions): void {
    if (this.shown.length === 0) return;
    const atlas = this.atlases.get('smoke');
    const batch = this.smokePuffs;
    batch.setAtlas(atlas, this.textures.puff);
    farthestFirst(this.shown);
    for (let k = 0; k < this.shown.length; k++) {
      const s = this.shown[k];
      _c.copy(s.lit ?? opts.fogColor);
      if (atlas) _c.multiplyScalar(SMOKE_FRAME_GAIN);
      const rand = _rand.reset(s.entity * 7919 + 1);
      for (let i = 0; i < SMOKE.puffs; i++) {
        const a = rand.next() * Math.PI * 2;
        const r = Math.sqrt(rand.next()) * 0.5 * s.radius;
        const h = (0.25 + rand.next() * 0.6) * s.radius * 0.75;
        const size = Math.max(0.01, s.radius * (1.1 + rand.next() * 0.5));
        const seed = rand.next();
        batch.push(
          s.base.x + Math.cos(a) * r,
          s.base.y + h,
          s.base.z + Math.sin(a) * r,
          size,
          size,
          atlas ? seed * Math.PI * 2 + SMOKE.turn * s.age : 0,
          atlas ? Math.floor(seed * atlas.frames) : 0,
          _c,
          s.opacity
        );
      }
    }
  }

  private poseFire(
    f: FireSlot,
    e: Effect,
    age: number,
    left: number,
    exposure: number
  ): void {
    const k = Math.min(
      clamp01(age / FIRE.fadeInS),
      clamp01(left / FIRE.fadeOutS)
    );
    f.strength = k;
    f.group.visible = true;
    f.group.position.copy(_p).setY(_p.y + 0.03);
    if (f.entity !== e.entityId) {
      flameLayout(e.entityId * 104729 + 3, FIRE.flames, FIRE.radius, f.layout);
      setFlameLayout(f.flames.geometry, f.layout);
      setFlameLayout(f.burst.geometry, f.layout);
      f.entity = e.entityId;
    }
    // CS2's frames once their atlases are in; the first fire asks for them.
    const fire = this.atlases.get('fire');
    if (fire && f.fireAtlas !== fire) {
      const noise = f.flames.material;
      f.flames.material = flameAtlasMaterial(fire, 'loop');
      noise.dispose();
      setFlameSequences(f.flames.geometry, fire.sequences);
      f.fireAtlas = fire;
    }
    const burst = this.atlases.get('fireburst');
    if (burst && f.burstAtlas !== burst) {
      if (f.burst.material !== this.noBurst) f.burst.material.dispose();
      f.burst.material = flameAtlasMaterial(burst, 'once');
      setFlameSequences(f.burst.geometry, burst.sequences);
      f.burstAtlas = burst;
    }
    // The last flame catches by `spreadS` and its burst is over `burstS` after.
    f.burst.visible =
      f.burstAtlas !== null && age < FLAMES.spreadS + FLAMES.burstS;
    timeFlames(f.flames.material, age, k, exposure);
    timeFlames(f.burst.material, age, k, exposure);
    // The glow under the flames spreads with them and breathes a little.
    const spread = clamp01(age / FLAMES.spreadS);
    f.disc.scale.setScalar(FIRE.radius * 1.6 * (0.4 + 0.6 * spread));
    f.disc.material.opacity = 0.4 * k * (0.9 + 0.1 * Math.sin(age * 7.3));
    // The smoke column: frames of CS2's smoke once that atlas is in, the generated puff before.
    const smoke = this.atlases.get('smoke');
    f.smoke.setAtlas(smoke, this.textures.puff);
    _c.copy(FIRE_SMOKE);
    if (smoke) _c.multiplyScalar(SMOKE_FRAME_GAIN);
    f.smoke.begin();
    for (let i = 0; i < FLAMES.smokePuffs; i++) {
      fireSmokePuff(
        age,
        i,
        FLAMES.smokePuffs,
        e.entityId,
        FIRE.radius,
        _puff,
        smoke
      );
      const a = _puff.opacity * k;
      if (!(a > 0)) continue;
      f.smoke.push(
        _puff.x,
        _puff.y,
        _puff.z,
        _puff.scale,
        _puff.scale,
        i * 1.3 + age * 0.2,
        _puff.frame,
        _c,
        a
      );
    }
    f.smoke.end();
  }

  /** The flare's cell of its atlas, made when the atlas arrives; null until then. */
  private flareTexture(): THREE.Texture | null {
    const atlas = this.atlases.get('flare');
    if (!atlas) return null;
    if (this.flareAtlas !== atlas) {
      this.flare?.dispose();
      // A copy of the atlas's texture (the same image) showing its first frame: without
      // mipmaps and inset half a texel, so no level and no filter reaches the next cell.
      const t = atlas.texture.clone();
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      frameRect(atlas, atlas.sequences[0][0], _rect);
      const image = atlas.texture.image as
        { width?: number; height?: number } | null | undefined;
      const du = image?.width ? 0.5 / image.width : 0;
      const dv = image?.height ? 0.5 / image.height : 0;
      t.offset.set(_rect.x + du, _rect.y + dv);
      t.repeat.set(_rect.z - 2 * du, _rect.w - 2 * dv);
      t.needsUpdate = true;
      this.flare = t;
      this.flareAtlas = atlas;
    }
    return this.flare;
  }

  /**
   * What the smokes shown leave of a sprite at (x, y, z) seen from `opts.eye`: 1 without one in
   * the way (`smokeCover`).
   */
  private clear(x: number, y: number, z: number, opts: UtilityOptions): number {
    return 1 - smokeCover(this.shown, opts.eye, x, y, z);
  }

  /** A white burst: the generated glow, and CS2's flare over it once its atlas is in. */
  private poseFlash(b: BurstSlot, age: number, opts: UtilityOptions): void {
    const o =
      age < FLASH.growS ? 1 : clamp01(1 - (age - FLASH.growS) / FLASH.fadeS);
    b.group.visible = o > 0;
    b.group.position.copy(_p);
    const size = Math.max(0.01, FLASH.size * clamp01(age / FLASH.growS));
    const opacity = o * this.clear(_p.x, _p.y, _p.z, opts);
    b.core.scale.setScalar(size);
    b.core.material.opacity = opacity;
    const map = this.flareTexture();
    const flare = b.flare!;
    flare.visible = map !== null;
    if (map) {
      flare.material.map = map;
      flare.scale.setScalar(size);
      flare.material.opacity = opacity;
    }
  }

  /**
   * The ring on the ground and a glow, the blast's flash (while the fireball grows, once CS2's
   * is in); CS2's fireball once its atlas is in (the generated fireball before); then the smoke
   * rising after the fireball.
   */
  private poseHe(
    b: HeSlot,
    e: Effect,
    age: number,
    opts: UtilityOptions
  ): void {
    const p = clamp01(age / HE.s);
    b.group.visible = p < 1;
    b.group.position.copy(_p);
    const fireball = this.atlases.get('explosion');
    // The blast's sprites, all faded as its middle is; the fireball's and smoke's each by its own.
    const clear = this.clear(_p.x, _p.y, _p.z, opts);
    if (b.ball) b.ball.visible = !fireball;
    const size = Math.max(0.01, HE.size * easeOut(clamp01(age / HE.growS)));
    if (fireball) {
      const seed = hash01(e.entityId * 0.618 + 0.25);
      const frame = fireballFrame(fireball, seed, age);
      if (frame !== null) {
        _c.copy(FIREBALL_HOT)
          .lerp(FIREBALL_COOL, age / HE.explosionS)
          .multiplyScalar(FIREBALL_GAIN);
        this.fireballs.setAtlas(fireball, this.textures.glow);
        // A quarter of its size over the blast, so the ground does not cut its lower half off.
        const y = _p.y + HE.explosionSize / 4;
        this.fireballs.push(
          _p.x,
          y,
          _p.z,
          HE.explosionSize,
          HE.explosionSize,
          seed * Math.PI * 2,
          frame,
          _c,
          this.clear(_p.x, y, _p.z, opts)
        );
      }
    }
    // The blast's flash: with CS2's fireball, only while it grows (the fireball is the rest).
    b.core.scale.setScalar(size * 1.6);
    b.core.material.opacity =
      (fireball ? clamp01(1 - age / HE.growS) : 1 - p) * clear;
    if (!fireball && b.ball) {
      b.ball.scale.setScalar(size * 1.4);
      b.ball.material.opacity = (1 - p * p) * clear;
      // Yellow-white at the blast, through orange to smoke as it fades.
      b.ball.material.color.setHex(0xffe0a0).lerp(_c.setHex(0x6a5a50), p * p);
    }
    if (b.ring) {
      b.ring.position.set(0, 0.05, 0);
      b.ring.scale.setScalar(0.5 + HE.ring * easeOut(p));
      b.ring.material.opacity = 0.8 * (1 - p) * clear;
    }
    this.poseHeSmoke(b, e, age, opts);
  }

  /**
   * The HE's smoke: `smokePuffs` puffs over the blast, each rising `smokeRise` and growing as it
   * fades over `smokeS` after the fireball, in `smokeColor`, or on a baked map that albedo times
   * the light half its rise over the blast (sampled once per HE, `lightAt`). CS2's smoke frames
   * once that atlas is in (asked for with the blast, so they are in by then), the generated puff
   * before.
   */
  private poseHeSmoke(
    b: HeSlot,
    e: Effect,
    age: number,
    opts: UtilityOptions
  ): void {
    const atlas = this.atlases.get('smoke');
    const t = age - HE.explosionS;
    if (!(t >= 0) || t >= HE.smokeS) return;
    const p = t / HE.smokeS;
    b.smokeAt.copy(_p).setY(_p.y + HE.smokeRise / 2);
    lightAt(
      b,
      b.smokeAt,
      HE_SMOKE_ALBEDO,
      SMOKE_TINT,
      opts.grid,
      opts.sunLight
    );
    _c.copy(b.lit ?? HE_SMOKE);
    if (atlas) _c.multiplyScalar(SMOKE_FRAME_GAIN);
    this.heSmoke.setAtlas(atlas, this.textures.puff);
    // In quickly as the fireball goes, out slowly as it thins.
    const alpha = HE.smokeOpacity * Math.min(1, p / 0.08) * (1 - p);
    const rise = HE.smokeRise * easeOut(p);
    for (let i = 0; i < HE.smokePuffs; i++) {
      const k = e.entityId * 1.37 + i * 7.13;
      const a = hash01(k) * Math.PI * 2;
      const r = 0.3 + 0.8 * hash01(k + 1.1);
      const h = 0.2 + 0.6 * hash01(k + 2.3);
      const seed = hash01(k + 3.7);
      const size = HE.smokeSize * (0.8 + 0.4 * hash01(k + 4.9)) * (1 + p);
      const x = _p.x + Math.cos(a) * r;
      const y = _p.y + h + rise;
      const z = _p.z + Math.sin(a) * r;
      this.heSmoke.push(
        x,
        y,
        z,
        size,
        size,
        seed * Math.PI * 2 + 0.2 * t,
        atlas ? Math.floor(seed * atlas.frames) : 0,
        _c,
        alpha * this.clear(x, y, z, opts)
      );
    }
  }

  /**
   * A pop every `beatS`, and a bigger one as it goes off at the end: CS2's muzzle flash (a frame
   * by a seed of the pop) throwing `sparks` streaks once their atlases are in; the generated
   * glow before (and no sparks).
   */
  private poseDecoy(
    b: BurstSlot,
    e: Effect,
    age: number,
    left: number,
    opts: UtilityOptions
  ): void {
    const end = clamp01(1 - left / DECOY.endS);
    const pop = Math.max(clamp01(1 - (age % DECOY.beatS) / DECOY.popS), end);
    b.group.visible = pop > 0;
    b.group.position.copy(_p).setY(_p.y + 0.1);
    const size = 0.4 + 1.6 * end;
    const { x, y, z } = b.group.position;
    // Its pop, the generated glow, CS2's flash and the sparks, as much as the smokes leave of it.
    const o = pop * this.clear(x, y, z, opts);
    b.core.scale.setScalar(size);
    b.core.material.opacity = o;
    const muzzle = this.atlases.get('muzzle');
    const sparks = this.atlases.get('sparks');
    b.core.visible = !muzzle;
    if (!(pop > 0)) return;
    const seed = hash01(
      e.entityId * 0.731 + Math.floor(age / DECOY.beatS) * 1.618
    );
    if (muzzle) {
      this.decoyFlashes.setAtlas(muzzle, this.textures.glow);
      this.decoyFlashes.push(
        x,
        y,
        z,
        size,
        size,
        seed * Math.PI * 2,
        Math.floor(hash01(seed * 57.3) * muzzle.frames),
        DECOY_FLASH,
        o
      );
    }
    if (sparks) {
      // Streaks through the pop, spread round it: a star of sparks.
      const [first, count] = sparks.sequences[0];
      const length = DECOY.sparkLength * (1 + end);
      this.decoySparks.setAtlas(sparks, this.textures.glow);
      for (let i = 0; i < DECOY.sparks; i++) {
        const s = hash01(seed * 91.7 + i * 3.1);
        this.decoySparks.push(
          x,
          y,
          z,
          length * sparks.aspect,
          length,
          seed * Math.PI * 2 + (i * Math.PI) / DECOY.sparks + (s - 0.5) * 0.5,
          first + Math.min(count - 1, Math.floor(s * count)),
          DECOY_SPARK,
          o
        );
      }
    }
  }
}
