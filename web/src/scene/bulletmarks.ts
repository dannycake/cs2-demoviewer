// What the bullets leave on the map, from the round's shots and its collision hull: where a
// miss meets a wall, a puff of dust in the colour of what it is made of (sparks off metal, chips
// off glass) and a bullet hole that stays 10 s and fades over 2; where a bullet went through a
// wall to its victim (a wallbang), the same on each face it went through; and on the wall up to
// 1.5 m behind a hit player, their blood, for 30 s. The holes and the blood are CS2's decals
// (`decals`), the dust, sparks and chips its particles (`dust`, `sparks`, `debris`;
// `effects.ts`), each atlas asked for when a mark first needs it, generated sprites until then.
//
// Every mark of a round is found once, when the round (or the timeline or the hull) changes:
// the hull's rays (`Hull.raycast`, `raycastAll`) for every shot, and on a baked map the light
// grid's light where each mark lies, kept in typed arrays. Each frame then only walks them back
// from the newest, into one batch per kind (`FlipbookBatch`): nothing is cast, sampled or made
// while playing or scrubbing, and what shows is a function of (round, tick) alone.

import * as THREE from 'three';
import { UNIT, toScene, viewDir } from '../geo/coords';
import { SURFACES, type Surface } from '../sim/surfaces';
import type { Timeline } from '../sim/timeline';
import type { Atlas, EffectAtlases } from './effects';
import { FlipbookBatch, onceFrame } from './flipbook';
import { lightAt, litCache, wallLight } from './gridlight';
import { newHullHit, type Hull, type HullHit } from './hull';
import { BLOOD, TRACER } from './impacts';
import { BREAK } from './mapents';
import { glowTexture, hash01, puffTexture } from './noise';
import { smokeCover, type SmokeSphere } from './smokecover';
import { bloomsAsEffect } from './post';
import type { LightGrid } from './probes';

/**
 * A miss's (or a wallbang's) puff, `puffS` long and `puffSize` metres across; its hole,
 * `decalSize` across, drawn `decalS` and faded over `fadeS` after; a hit's blood on the wall up
 * to `bloodReach` metres behind the victim, `bloodSize` across, for `bloodS`. A wallbang marks
 * at most `maxPenetrations` faces. The newest of each are drawn, at most `pools` of them.
 */
export const MARKS = {
  puffS: 0.5,
  puffSize: 0.35,
  decalS: 10,
  fadeS: 2,
  decalSize: 0.07,
  bloodS: 30,
  bloodSize: 0.45,
  bloodReach: 1.5,
  maxPenetrations: 4,
  pools: { decals: 96, blood: 24, puffs: 32, sparks: 48 },
} as const;

/** The dust a bullet raises off each surface (sRGB); `nodecal` is stone without the marks. */
export const DUST_COLOR: Readonly<Record<Surface, number>> = {
  stone: 0xb8b0a0,
  dirt: 0x9c8466,
  wood: 0x8a6a4a,
  soft: 0x9a9a9a,
  glass: 0xd8e4ec,
  metal: 0x8c8c8c,
  pass: 0x9a9a9a,
  nodecal: 0xb8b0a0,
};

/**
 * The `decals` atlas's sequence of each surface's hole (stone's for dirt and soft), −1 for none:
 * a bullet passes `pass` and CS2 never marks `nodecal`.
 */
export const DECAL_SEQUENCE: Readonly<Record<Surface, number>> = {
  stone: 0,
  metal: 1,
  wood: 2,
  glass: 3,
  dirt: 0,
  soft: 0,
  pass: -1,
  nodecal: -1,
};
/** The `decals` atlas's blood sequence. */
export const BLOOD_SEQUENCE = 4;

/** Metres a decal stands off its wall, along the wall's normal. */
export const DECAL_LIFT = 0.01;
/**
 * A bullet hole's dark core (`FlipbookOptions.core`): CS2's hole frames carry its depth in maps
 * this viewer does not draw, so their colours alone are flat chips (the concrete's middle 0.25
 * linear, the metal's 0.14, the glass's 0.31; only wood's is dark): within `radius` of the
 * middle (a share of the cell's half-width: a core about 2.5 cm across in a 7 cm hole) the hole
 * falls to `shade` of itself, near black on every surface.
 */
export const HOLE_CORE = { radius: 0.35, shade: 0.06 } as const;
/**
 * A puff stands `lift` off the wall and drifts `drift` metres further out over its life, growing
 * from `grow` of its size.
 */
export const PUFF = { lift: 0.08, drift: 0.25, grow: 0.5 } as const;
/**
 * Metal's sparks: `count` streaks for `seconds`, thrown off the wall at `speed` m/s (around the
 * bullet's reflection), `length` metres long, in `color` × `gain` (a light: the exposure is
 * divided out).
 */
export const SPARKS = {
  count: 6,
  seconds: 0.15,
  speed: [3, 7] as const,
  length: 0.12,
  color: 0xffb050,
  gain: 3,
} as const;
/** Glass's chips: `count` shards flying out at `speed` m/s for `MARKS.puffS`, `size` metres. */
export const CHIPS = {
  count: 4,
  speed: [1, 2.5] as const,
  size: [0.02, 0.045] as const,
  /** Turns a second a chip spins, at most. */
  spin: 3,
} as const;
/** Metres a second squared, down. */
const GRAVITY = 9.8;
/**
 * CS2's `dust` frames are dark smoke (0.084 linear at the median where they cover, measured over
 * the atlas): their colour is multiplied by this, so a puff comes out in `DUST_COLOR`.
 */
export const DUST_FRAME_GAIN = 12;
/**
 * CS2's blood decals are a near-black red (0.047 linear at the median): multiplied by this, as
 * dark a red as the blood's puff (`BLOOD.color`, 0.19).
 */
export const BLOOD_DECAL_GAIN = 4;
/**
 * A mark's light on a baked map is the grid's this far off its wall, out along its normal: the
 * light of the air it is seen through, not of the cells the wall stands in. A puff or a chip
 * takes the light of that air from every side (`lightAt`); a hole or blood, lying on the wall,
 * the wall's own by its normal, with the sun only where the wall faces it (`wallLight`).
 */
export const LIGHT_LIFT = 0.25;

/**
 * A decal drawn, for `BulletMarks.debug`: where it lies and its wall's normal, scene metres,
 * and its frame of the `decals` atlas (which surface's hole).
 */
export interface MarkDebug {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  frame: number;
}

export interface MarkOptions {
  /** The tone mapping's exposure, which the sparks divide out (1 when not tone-mapped). */
  exposure: number;
  tickRate: number;
  /** The map's light grid (a baked map's), which lights the marks, or null. */
  grid?: LightGrid | null;
  /** The sun's light in the grid's units (three's sun over π); null for none. */
  sunLight?: THREE.Color | null;
  /** The unit direction towards the sun (`Lighting.direction`), for the walls' light. */
  toSun?: Readonly<THREE.Vector3> | null;
  /**
   * The camera's right and up in the world, so a spark's streak lies along its flight on
   * screen; without them each streak is turned its own way.
   */
  screen?: { right: THREE.Vector3; up: THREE.Vector3 } | null;
  /** The camera's position, which the smokes stand between the marks and. */
  eye?: Readonly<THREE.Vector3> | null;
  /**
   * The smokes shown (the utility's, `Utility.smokeSpheres`), which fade the puffs, sparks and
   * chips behind them (`smokeCover`); none when left out. The holes and the blood lie on the
   * walls, drawn before the smokes, which cover them as they cover the walls.
   */
  smokes?: readonly SmokeSphere[] | null;
}

/** The marks of one kind found in a round, oldest first, in typed arrays. */
class MarkList {
  count = 0;
  readonly tick: Float64Array;
  /** Where it lies, on the wall (scene metres). */
  readonly point: Float32Array;
  /** The wall's unit normal on the side the mark is on. */
  readonly normal: Float32Array;
  /** The bullet's unit direction. */
  readonly dir: Float32Array;
  /** Its surface's index in `SURFACES`. */
  readonly surface: Uint8Array;
  /** In [0, 1): turns it and picks its frames. */
  readonly seed: Float32Array;
  /** The light of the air in front of it: the grid's (`relight`), else white. */
  readonly light: Float32Array;
  /** Its wall's light (`wallLight`), else white. */
  readonly wall: Float32Array;

  constructor(capacity: number) {
    this.tick = new Float64Array(capacity);
    this.point = new Float32Array(capacity * 3);
    this.normal = new Float32Array(capacity * 3);
    this.dir = new Float32Array(capacity * 3);
    this.surface = new Uint8Array(capacity);
    this.seed = new Float32Array(capacity);
    this.light = new Float32Array(capacity * 3).fill(1);
    this.wall = new Float32Array(capacity * 3).fill(1);
  }

  add(
    tick: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    dir: THREE.Vector3,
    surface: Surface,
    seed: number
  ): void {
    const i = this.count++;
    this.tick[i] = tick;
    point.toArray(this.point, i * 3);
    normal.toArray(this.normal, i * 3);
    dir.toArray(this.dir, i * 3);
    this.surface[i] = SURFACES.indexOf(surface);
    this.seed[i] = seed;
  }

  /** How many marks are made by `tick` (their tick ≤ it). */
  upTo(tick: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.tick[mid] <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

const NONE = new MarkList(0);
const METAL = SURFACES.indexOf('metal');
const GLASS = SURFACES.indexOf('glass');
/** Each surface's dust colour and hole sequence (−1 for none), by its index. */
const DUST = SURFACES.map((s) => new THREE.Color(DUST_COLOR[s]));
const HOLE_SEQUENCE = SURFACES.map((s) => DECAL_SEQUENCE[s]);
const SPARK_COLOR = new THREE.Color(SPARKS.color).multiplyScalar(SPARKS.gain);

const _e = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _r = new THREE.Vector3();
const _c = new THREE.Color();

/** `a + (b − a)·t` of a range. */
const lerp = (r: readonly [number, number], t: number) =>
  r[0] + (r[1] - r[0]) * t;
/** A number in [0, 1) for draw `n` of particle `j` of the mark seeded `seed`. */
const draw = (seed: number, j: number, n: number) =>
  hash01(seed * 97.13 + j * 13.37 + n * 3.71);

export class BulletMarks {
  /** The marks' batches; add it to the scene. */
  readonly root = new THREE.Group();
  private readonly effects: EffectAtlases;
  private readonly holes = new FlipbookBatch(MARKS.pools.decals, {
    blending: 'alpha',
    facing: 'surface',
    emissive: false,
    core: HOLE_CORE,
  });
  private readonly blood = new FlipbookBatch(MARKS.pools.blood, {
    blending: 'alpha',
    facing: 'surface',
    emissive: false,
  });
  private readonly dust = new FlipbookBatch(MARKS.pools.puffs, {
    blending: 'alpha',
    facing: 'camera',
    emissive: false,
  });
  private readonly sparks = new FlipbookBatch(MARKS.pools.sparks, {
    blending: 'additive',
    facing: 'camera',
    emissive: true,
  });
  private readonly chips = new FlipbookBatch(MARKS.pools.sparks, {
    blending: 'alpha',
    facing: 'camera',
    emissive: false,
  });
  private readonly batches: readonly FlipbookBatch[];
  /** The generated sprites until the atlases are in: a soft puff and a glow. */
  private readonly puff = puffTexture(32, 29);
  private readonly glow = glowTexture(32);
  /** What the marks were found for: the timeline, round and hull. */
  private tl: Timeline | null = null;
  private round = -1;
  private hull: Hull | null = null;
  /** The round's misses and wallbangs, and its blood. */
  private impacts = NONE;
  private bloods = NONE;
  /** What the marks' light was sampled for: the grid, the sun's light and its direction. */
  private litGrid: LightGrid | null = null;
  private readonly litSun = new THREE.Color(0, 0, 0);
  private readonly litToSun = new THREE.Vector3();
  /** The hull's answers, filled in place. */
  private readonly hit = newHullHit();
  private readonly through: HullHit[] = Array.from(
    { length: MARKS.maxPenetrations },
    newHullHit
  );
  /** The light sampled for one mark at a time. */
  private readonly lit = litCache();
  /** The last frame posed, for `debug`. */
  private posed = { round: -1, tick: NaN };

  /** The marks, from `effects`'s atlases once they are in. */
  constructor(effects: EffectAtlases) {
    this.effects = effects;
    this.root.name = 'bullet-marks';
    this.holes.mesh.name = 'bullet-holes';
    this.blood.mesh.name = 'blood-decals';
    this.dust.mesh.name = 'impact-dust';
    this.sparks.mesh.name = 'impact-sparks';
    this.chips.mesh.name = 'impact-chips';
    this.batches = [this.holes, this.blood, this.dust, this.sparks, this.chips];
    for (const b of this.batches) {
      b.mesh.visible = false;
      this.root.add(b.mesh);
    }
    // Lying on the walls, drawn before whatever else is see-through (a smoke in front of them
    // covers them; every batch stands at the origin, so they would otherwise go by age).
    this.holes.mesh.renderOrder = -1;
    this.blood.mesh.renderOrder = -1;
    // The sparks add light; the dust, holes, blood and chips cover.
    bloomsAsEffect(this.sparks.mesh);
  }

  /**
   * Draws the marks of round `round` at `tick` (a float) against `hull` (none without one): the
   * round's marks are found first if the timeline, round or hull changed, and lit again if the
   * grid or the sun did.
   */
  set(
    round: number,
    tick: number,
    tl: Timeline,
    hull: Hull | null,
    o: MarkOptions
  ): void {
    if (tl !== this.tl || round !== this.round || hull !== this.hull)
      this.find(round, tl, hull);
    const grid = o.grid ?? null;
    const sun = o.sunLight ?? null;
    const toSun = o.toSun ?? null;
    if (
      grid !== this.litGrid ||
      (grid !== null &&
        (!(sun ? this.litSun.equals(sun) : isBlack(this.litSun)) ||
          !(toSun
            ? this.litToSun.equals(toSun)
            : this.litToSun.lengthSq() === 0)))
    )
      this.relight(grid, sun, toSun);
    this.posed.round = round;
    this.posed.tick = tick;
    const batches = this.batches;
    for (let i = 0; i < batches.length; i++) batches[i].begin();
    this.drawImpacts(tick, o);
    this.drawBlood(tick, o.tickRate);
    this.sparks.setExposure(o.exposure);
    for (let i = 0; i < batches.length; i++) batches[i].end();
  }

  /**
   * What the last `set` drew, for the debug handle and the e2e: its round and tick, how many
   * marks the round has, and where each hole and blood decal drawn lies (scene metres) and the
   * normal of its wall.
   */
  debug(): {
    round: number;
    tick: number;
    marks: number;
    bloods: number;
    holes: MarkDebug[];
    blood: MarkDebug[];
    puffs: number;
    sparks: number;
    chips: number;
  } {
    const points = (b: FlipbookBatch): MarkDebug[] => {
      const g = b.mesh.geometry;
      const c = g.getAttribute('aCentre');
      const n = g.getAttribute('aNormal');
      const count = b.mesh.visible ? g.instanceCount : 0;
      return Array.from({ length: count }, (_, i) => ({
        x: c.getX(i),
        y: c.getY(i),
        z: c.getZ(i),
        nx: n.getX(i),
        ny: n.getY(i),
        nz: n.getZ(i),
        frame: g.getAttribute('aSize').getW(i),
      }));
    };
    const count = (b: FlipbookBatch) =>
      b.mesh.visible ? b.mesh.geometry.instanceCount : 0;
    return {
      round: this.posed.round,
      tick: this.posed.tick,
      marks: this.impacts.count,
      bloods: this.bloods.count,
      holes: points(this.holes),
      blood: points(this.blood),
      puffs: count(this.dust),
      sparks: count(this.sparks),
      chips: count(this.chips),
    };
  }

  /**
   * Lets go of `hull` (freed with its map) and the marks found on it, at once; the next `set`
   * finds the round's marks on the hull it is given.
   */
  forget(hull: Hull): void {
    if (this.hull !== hull) return;
    this.hull = null;
    this.tl = null;
    this.round = -1;
    this.impacts = NONE;
    this.bloods = NONE;
  }

  dispose(): void {
    if (this.hull) this.forget(this.hull);
    this.tl = null;
    for (const b of this.batches) b.dispose();
    this.puff.dispose();
    this.glow.dispose();
    this.root.removeFromParent();
  }

  /**
   * Every mark of `round`, once: for a shot with its logged eye and aim and no hit, the first
   * wall along the aim within `TRACER.reach` (where its tracer ends, `impacts.ts`); for a hit
   * that went through walls, each face along the bullet to the victim (on the side the bullet
   * met it: the face it entered by, or the outside of the one it left by), at most
   * `maxPenetrations`; for every hit, the wall within `bloodReach` behind the victim.
   */
  private find(round: number, tl: Timeline, hull: Hull | null): void {
    this.tl = tl;
    this.round = round;
    this.hull = hull;
    this.litGrid = null;
    const shots = tl.shots(round);
    if (!hull || shots.length === 0) {
      this.impacts = NONE;
      this.bloods = NONE;
      return;
    }
    const impacts = new MarkList(shots.length * MARKS.maxPenetrations);
    const bloods = new MarkList(shots.length);
    const hit = this.hit;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i];
      // Its place among its player's shots of its tick (a shotgun's pellets), in its seed.
      let nth = 0;
      for (let j = i - 1; j >= 0 && shots[j].tick === s.tick; j--)
        if (shots[j].player === s.player) nth++;
      if (!s.from) continue;
      const seed = hash01(s.tick * 0.618 + s.player * 7.31 + nth * 2.0944);
      toScene(s.from.x, s.from.y, s.from.z, _e);
      if (!s.hit) {
        if (!s.aim) continue;
        viewDir(s.aim.yaw, s.aim.pitch, _d);
        if (hull.raycast(_e, _d, TRACER.reach, hit))
          impacts.add(s.tick, hit.point, hit.normal, _d, hit.surface, seed);
        continue;
      }
      const [x, y, z] = s.hit.dir;
      _d.set(y, z, x);
      if (_d.lengthSq() < 1e-12) continue;
      _d.normalize();
      const reach = s.hit.distance * UNIT;
      if (s.hit.penetrations > 0) {
        const n = hull.raycastAll(_e, _d, reach, this.through);
        for (let k = 0; k < n; k++) {
          const h = this.through[k];
          // The outside of the face: what the bullet came from, or went on into.
          _n.copy(h.normal);
          if (h.leaving) _n.negate();
          impacts.add(
            s.tick,
            h.point,
            _n,
            _d,
            h.surface,
            hash01(seed * 31.7 + k)
          );
        }
      }
      _v.copy(_e).addScaledVector(_d, reach);
      if (
        hull.raycast(_v, _d, MARKS.bloodReach, hit) &&
        hit.surface !== 'nodecal'
      )
        bloods.add(s.tick, hit.point, hit.normal, _d, hit.surface, seed);
    }
    this.impacts = impacts;
    this.bloods = bloods;
  }

  /**
   * Every mark's light, once per mark: on a baked map (`grid`) the grid's `LIGHT_LIFT` off its
   * wall, of the air (`lightAt`, for the puffs and chips; not for the blood, which has none) and
   * of the wall (`wallLight`, for the holes and the blood); white without a grid.
   */
  private relight(
    grid: LightGrid | null,
    sun: THREE.Color | null,
    toSun: Readonly<THREE.Vector3> | null
  ): void {
    this.litGrid = grid;
    if (sun) this.litSun.copy(sun);
    else this.litSun.setRGB(0, 0, 0);
    if (toSun) this.litToSun.copy(toSun);
    else this.litToSun.set(0, 0, 0);
    this.relightList(this.impacts, true, grid, sun, toSun);
    this.relightList(this.bloods, false, grid, sun, toSun);
  }

  private relightList(
    list: MarkList,
    air: boolean,
    grid: LightGrid | null,
    sun: THREE.Color | null,
    toSun: Readonly<THREE.Vector3> | null
  ): void {
    if (!grid) {
      list.light.fill(1);
      list.wall.fill(1);
      return;
    }
    for (let i = 0; i < list.count; i++) {
      const k = i * 3;
      _n.fromArray(list.normal, k);
      _p.fromArray(list.point, k).addScaledVector(_n, LIGHT_LIFT);
      wallLight(grid, _p, _n, sun, toSun, _c).toArray(list.wall, k);
      if (!air) continue;
      lightAt(this.lit, _p, 1, 1, grid, sun);
      this.lit.lit!.toArray(list.light, k);
    }
  }

  /**
   * The misses' and wallbangs' marks at `tick`, newest first: the holes of the last
   * `decalS + fadeS` (none on `nodecal`), the puffs of the last `puffS` with metal's sparks and
   * glass's chips. Each atlas is asked for when its first mark is drawn.
   */
  private drawImpacts(tick: number, o: MarkOptions): void {
    const m = this.impacts;
    const rate = o.tickRate;
    let holes: Atlas | null | undefined;
    let dust: Atlas | null | undefined;
    let sparks: Atlas | null | undefined;
    let chips: Atlas | null | undefined;
    let holesLeft: number = MARKS.pools.decals;
    let puffsLeft: number = MARKS.pools.puffs;
    for (let i = m.upTo(tick) - 1; i >= 0; i--) {
      const age = (tick - m.tick[i]) / rate;
      if (age >= MARKS.decalS + MARKS.fadeS) break;
      if (holesLeft === 0 && (puffsLeft === 0 || age >= MARKS.puffS)) break;
      const k = i * 3;
      const surface = m.surface[i];
      const seed = m.seed[i];
      _p.fromArray(m.point, k);
      _n.fromArray(m.normal, k);
      if (holesLeft > 0 && HOLE_SEQUENCE[surface] >= 0) {
        if (holes === undefined) {
          holes = usable(this.effects.get('decals'));
          this.holes.setAtlas(holes, this.puff);
        }
        const seq = holes?.sequences[HOLE_SEQUENCE[surface]];
        const fade = Math.min(
          1,
          (MARKS.decalS + MARKS.fadeS - age) / MARKS.fadeS
        );
        _c.fromArray(m.wall, k);
        // The generated stand-in is a dark round hole.
        if (!holes) _c.multiplyScalar(0.12);
        this.holes.push(
          _p.x + _n.x * DECAL_LIFT,
          _p.y + _n.y * DECAL_LIFT,
          _p.z + _n.z * DECAL_LIFT,
          MARKS.decalSize,
          MARKS.decalSize,
          seed * Math.PI * 2,
          seq ? seq[0] + Math.floor(hash01(seed * 17.3) * seq[1]) : 0,
          _c,
          fade,
          _n.x,
          _n.y,
          _n.z
        );
        holesLeft--;
      }
      if (age >= MARKS.puffS || puffsLeft === 0) continue;
      puffsLeft--;
      if (dust === undefined) {
        dust = this.effects.get('dust');
        this.dust.setAtlas(dust, this.puff);
      }
      this.pushPuff(m, i, age, dust, o);
      if (surface === METAL && age < SPARKS.seconds) {
        if (sparks === undefined) {
          sparks = this.effects.get('sparks');
          this.sparks.setAtlas(sparks, this.glow);
        }
        this.pushSparks(m, i, age, sparks, o);
      } else if (surface === GLASS) {
        if (chips === undefined) {
          chips = this.effects.get('debris');
          this.chips.setAtlas(chips, this.puff);
        }
        this.pushChips(m, i, age, chips, o);
      }
    }
  }

  /** Impact `i`'s puff of dust, `age` seconds in: out along the wall, growing and fading. */
  private pushPuff(
    m: MarkList,
    i: number,
    age: number,
    atlas: Atlas | null,
    o: MarkOptions
  ): void {
    const k = i * 3;
    const u = age / MARKS.puffS;
    const seq = atlas?.sequences[0];
    const frame = seq ? onceFrame(seq, age, MARKS.puffS) : 0;
    if (frame === null) return;
    const out = PUFF.lift + PUFF.drift * (1 - (1 - u) * (1 - u));
    const size =
      MARKS.puffSize * (PUFF.grow + (1 - PUFF.grow) * (1 - (1 - u) * (1 - u)));
    _c.copy(DUST[m.surface[i]]);
    if (atlas) _c.multiplyScalar(DUST_FRAME_GAIN);
    _c.r *= m.light[k];
    _c.g *= m.light[k + 1];
    _c.b *= m.light[k + 2];
    const x = m.point[k] + m.normal[k] * out;
    const y = m.point[k + 1] + m.normal[k + 1] * out;
    const z = m.point[k + 2] + m.normal[k + 2] * out;
    this.dust.push(
      x,
      y,
      z,
      size * (atlas?.aspect ?? 1),
      size,
      (m.seed[i] - 0.5) * 0.6,
      frame,
      _c,
      (1 - u * u) * clearOf(o, x, y, z)
    );
  }

  /**
   * Metal impact `i`'s sparks `age` seconds in: thrown around the bullet's reflection off the
   * wall (around its way on, off a face it left by), falling, each a streak along its flight on
   * screen (`o.screen`), fading out.
   */
  private pushSparks(
    m: MarkList,
    i: number,
    age: number,
    atlas: Atlas | null,
    o: MarkOptions
  ): void {
    const screen = o.screen ?? null;
    const k = i * 3;
    const seed = m.seed[i];
    _n.fromArray(m.normal, k);
    // Off the face the bullet met, its direction reflected off the wall; off the face it left by
    // (a wallbang's way out, its direction along the face's outside), on along its way, which a
    // reflection would turn back into the wall.
    _d.fromArray(m.dir, k);
    const dn = _d.dot(_n);
    if (dn < 0) _r.copy(_d).addScaledVector(_n, -2 * dn);
    else _r.copy(_d);
    const seq = atlas?.sequences[0];
    const alpha = 1 - age / SPARKS.seconds;
    for (let j = 0; j < SPARKS.count; j++) {
      _v.set(
        draw(seed, j, 1) * 2 - 1,
        draw(seed, j, 2) * 2 - 1,
        draw(seed, j, 3) * 2 - 1
      )
        .multiplyScalar(0.9)
        .addScaledVector(_r, 0.6)
        .addScaledVector(_n, 0.8)
        .normalize()
        .multiplyScalar(lerp(SPARKS.speed, draw(seed, j, 4)));
      _p.fromArray(m.point, k)
        .addScaledVector(_n, DECAL_LIFT * 2)
        .addScaledVector(_v, age);
      _p.y -= 0.5 * GRAVITY * age * age;
      _v.y -= GRAVITY * age;
      let rotation = draw(seed, j, 5) * Math.PI * 2;
      let length = SPARKS.length;
      if (screen) {
        // Its flight on screen: the streak's length along it, shortened as it flies at the eye.
        const x = _v.dot(screen.right);
        const y = _v.dot(screen.up);
        rotation = Math.atan2(-x, y);
        length *= Math.max(
          0.25,
          Math.hypot(x, y) / Math.max(_v.length(), 1e-6)
        );
      }
      this.sparks.push(
        _p.x,
        _p.y,
        _p.z,
        length * (atlas ? atlas.aspect : 0.35),
        length,
        rotation,
        seq ? seq[0] + Math.floor(draw(seed, j, 6) * seq[1]) : 0,
        SPARK_COLOR,
        alpha * clearOf(o, _p.x, _p.y, _p.z)
      );
    }
  }

  /** Glass impact `i`'s chips `age` seconds in: shards of CS2's `debris` flying out and falling. */
  private pushChips(
    m: MarkList,
    i: number,
    age: number,
    atlas: Atlas | null,
    o: MarkOptions
  ): void {
    const k = i * 3;
    const seed = m.seed[i];
    _n.fromArray(m.normal, k);
    const seq = atlas?.sequences[0];
    const u = age / MARKS.puffS;
    const alpha = Math.min(1, (1 - u) / 0.4);
    _c.fromArray(m.light, k);
    for (let j = 0; j < CHIPS.count; j++) {
      _v.set(
        draw(seed, j, 11) * 2 - 1,
        draw(seed, j, 12) * 1.5,
        draw(seed, j, 13) * 2 - 1
      )
        .multiplyScalar(0.8)
        .addScaledVector(_n, lerp(CHIPS.speed, draw(seed, j, 14)));
      _p.fromArray(m.point, k)
        .addScaledVector(_n, DECAL_LIFT * 2)
        .addScaledVector(_v, age);
      _p.y -= 0.5 * GRAVITY * age * age;
      const size = lerp(CHIPS.size, draw(seed, j, 15));
      this.chips.push(
        _p.x,
        _p.y,
        _p.z,
        size,
        size,
        draw(seed, j, 16) * Math.PI * 2 +
          (draw(seed, j, 17) * 2 - 1) * CHIPS.spin * Math.PI * 2 * age,
        seq ? seq[0] + Math.min(j % BREAK.shards, seq[1] - 1) : 0,
        _c,
        alpha * clearOf(o, _p.x, _p.y, _p.z)
      );
    }
  }

  /** The blood decals at `tick`, newest first: those of the last `bloodS`, the last `fadeS` fading. */
  private drawBlood(tick: number, rate: number): void {
    const m = this.bloods;
    let atlas: Atlas | null | undefined;
    let left: number = MARKS.pools.blood;
    for (let i = m.upTo(tick) - 1; i >= 0 && left > 0; i--) {
      const age = (tick - m.tick[i]) / rate;
      if (age >= MARKS.bloodS) break;
      if (atlas === undefined) {
        atlas = usable(this.effects.get('decals'));
        this.blood.setAtlas(atlas, this.puff);
      }
      const k = i * 3;
      const seed = m.seed[i];
      const seq = atlas?.sequences[BLOOD_SEQUENCE];
      _c.fromArray(m.wall, k);
      // CS2's frames are near black; the generated puff is white.
      _c.multiplyScalar(atlas ? BLOOD_DECAL_GAIN : 1);
      if (!atlas) _c.multiply(BLOOD_PLAIN);
      _n.fromArray(m.normal, k);
      this.blood.push(
        m.point[k] + _n.x * DECAL_LIFT,
        m.point[k + 1] + _n.y * DECAL_LIFT,
        m.point[k + 2] + _n.z * DECAL_LIFT,
        MARKS.bloodSize,
        MARKS.bloodSize,
        seed * Math.PI * 2,
        seq ? seq[0] + Math.floor(hash01(seed * 23.9) * seq[1]) : 0,
        _c,
        Math.min(1, (MARKS.bloodS - age) / MARKS.fadeS),
        _n.x,
        _n.y,
        _n.z
      );
      left--;
    }
  }
}

/** The generated blood's colour: the blood puff's dark red. */
const BLOOD_PLAIN = new THREE.Color(BLOOD.color);

/**
 * The `decals` atlas when it has every sequence the marks draw (a hole per surface and the
 * blood), each with a frame; else null, and the generated sprites are drawn.
 */
function usable(a: Atlas | null): Atlas | null {
  if (!a || a.sequences.length <= BLOOD_SEQUENCE) return null;
  for (let i = 0; i <= BLOOD_SEQUENCE; i++)
    if (!(a.sequences[i][1] > 0)) return null;
  return a;
}

/** What the smokes of `o` leave of a sprite at (x, y, z) seen from its eye: 1 without them. */
function clearOf(o: MarkOptions, x: number, y: number, z: number): number {
  return o.smokes && o.eye ? 1 - smokeCover(o.smokes, o.eye, x, y, z) : 1;
}

function isBlack(c: THREE.Color): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0;
}
