// The map's doors and breakables at any (round, tick), from the pack's change list (`ENT1`,
// docs/pack.md) alone: a door's angles between its keys, a window there or broken. Everything
// is laid out once per pack, so a pose is a pure function of (round, tick): seeking shows what
// playing shows, and asking allocates nothing.

import type { Pack } from '../pack/types';

export interface EntityPose {
  /** False from the entity's break to the end of the round. */
  visible: boolean;
  /** No key yet this round: draw the spawn transform (the angles are then 0). */
  spawn: boolean;
  /** Degrees; along a swing they may run past ±180 (unwrapped from the round's first key). */
  pitch: number;
  yaw: number;
  roll: number;
}

/** The changes of one entity in one round, as indices into `Pack.entityChanges`. */
interface Run {
  start: number;
  end: number;
  /** The tick of the run's first `gone` key, or Infinity. */
  gone: number;
}

const NO_RUN: Run = { start: 0, end: 0, gone: Infinity };
const NO_BREAKS: readonly { tick: number; entity: number }[] = [];

export class MapEntityIndex {
  readonly pack: Pack;
  private readonly entities: number;
  private readonly rounds: number;
  /** At `round * entities + entity`. */
  private readonly runs: Run[];
  private readonly ticks: Float64Array;
  /** Each key's angles in degrees, unwrapped along its run so a swing turns the shorter way. */
  private readonly pitch: Float64Array;
  private readonly yaw: Float64Array;
  private readonly roll: Float64Array;
  /** Per round, the breaks (each run's first `gone` key) in tick order. */
  private readonly breaks: { tick: number; entity: number }[][];

  constructor(pack: Pack) {
    this.pack = pack;
    const changes = pack.entityChanges;
    this.entities = pack.entities.length;
    this.rounds = pack.header.rounds.length;
    this.runs = new Array<Run>(this.entities * this.rounds).fill(NO_RUN);
    const n = changes.length;
    this.ticks = new Float64Array(n);
    this.pitch = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.roll = new Float64Array(n);
    this.breaks = Array.from({ length: this.rounds }, () => []);
    // The changes are sorted by (round, entity, tick): each run is a block of them.
    for (let i = 0; i < n;) {
      const { round, entity } = changes[i];
      const run: Run = { start: i, end: i, gone: Infinity };
      for (; i < n; i++) {
        const c = changes[i];
        if (c.round !== round || c.entity !== entity) break;
        this.ticks[i] = c.tick;
        const first = i === run.start;
        this.pitch[i] = unwrap(c.pitch / 100, first ? null : this.pitch[i - 1]);
        this.yaw[i] = unwrap(c.yaw / 100, first ? null : this.yaw[i - 1]);
        this.roll[i] = unwrap(c.roll / 100, first ? null : this.roll[i - 1]);
        if (c.gone && run.gone === Infinity) {
          run.gone = c.tick;
          this.breaks[round]?.push({ tick: c.tick, entity });
        }
      }
      run.end = i;
      if (round < this.rounds && entity < this.entities)
        this.runs[round * this.entities + entity] = run;
    }
    for (const b of this.breaks)
      b.sort((p, q) => p.tick - q.tick || p.entity - q.entity);
  }

  /**
   * Entity `entity`'s pose at `tick` (a float) of round `round`: at spawn before its first key
   * in the round, then the linear interpolation of its keys around `tick`, the last held after
   * it; hidden from a `gone` key at or before `tick` on. Unknown entities and rounds are at
   * spawn.
   */
  poseAt(
    entity: number,
    round: number,
    tick: number,
    out: EntityPose
  ): EntityPose {
    out.visible = true;
    out.spawn = true;
    out.pitch = 0;
    out.yaw = 0;
    out.roll = 0;
    const run = this.run(entity, round);
    if (run.start === run.end || !(tick >= this.ticks[run.start])) return out;
    out.spawn = false;
    out.visible = tick < run.gone;
    // The last key at or before `tick`.
    let lo = run.start;
    let hi = run.end - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ticks[mid] <= tick) lo = mid;
      else hi = mid - 1;
    }
    const next = lo + 1;
    if (next < run.end) {
      const t = (tick - this.ticks[lo]) / (this.ticks[next] - this.ticks[lo]);
      out.pitch = lerp(this.pitch[lo], this.pitch[next], t);
      out.yaw = lerp(this.yaw[lo], this.yaw[next], t);
      out.roll = lerp(this.roll[lo], this.roll[next], t);
    } else {
      out.pitch = this.pitch[lo];
      out.yaw = this.yaw[lo];
      out.roll = this.roll[lo];
    }
    return out;
  }

  /**
   * Writes the entities of round `round` whose break falls in `(tick − windowTicks, tick]`,
   * in break order, to `out[0]`, `out[1]`, … and returns how many; `out`'s length and what lies
   * past the count are left as they are, so a reused array keeps its storage.
   */
  breaksAt(
    round: number,
    tick: number,
    windowTicks: number,
    out: number[]
  ): number {
    let n = 0;
    for (const b of this.breaks[round] ?? NO_BREAKS) {
      if (b.tick > tick) break;
      if (b.tick > tick - windowTicks) out[n++] = b.entity;
    }
    return n;
  }

  /** The tick of entity `entity`'s break in round `round`, or null when it stays whole. */
  breakTick(entity: number, round: number): number | null {
    const g = this.run(entity, round).gone;
    return g === Infinity ? null : g;
  }

  private run(entity: number, round: number): Run {
    if (
      !(entity >= 0 && entity < this.entities) ||
      !(round >= 0 && round < this.rounds)
    )
      return NO_RUN;
    return this.runs[round * this.entities + entity] ?? NO_RUN;
  }
}

/** `deg` moved by whole turns to within 180° of `prev` (as is without one). */
function unwrap(deg: number, prev: number | null): number {
  if (prev === null) return deg;
  return deg - 360 * Math.round((deg - prev) / 360);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
