// The weapons, grenades and defuse kits lying in the world at any (round, tick), from the
// pack's ground keys (`GND1`, docs/pack.md) alone. Everything is laid out once per pack, so
// what lies where is a pure function of (round, tick): seeking shows what playing shows, the
// next round starts with nothing on the ground, and asking allocates nothing.

import type { Pack } from '../pack/types';
import { normaliseWeapon } from './weapons';

/** An item on the ground. */
export interface GroundPose {
  /** The item's entity id. */
  id: number;
  /** Normalised (`normaliseWeapon`): also the model's name under /weapons/. */
  weapon: string;
  /** Source units. */
  x: number;
  y: number;
  z: number;
  /** Degrees; along a tumble they may run past ±180 (unwrapped from the first key). */
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * One time an item lies on the ground: its pose keys, indices `[start, end)` into
 * `Pack.ground`, from the first key's tick until `gone`.
 */
interface Stretch {
  id: number;
  weapon: string;
  start: number;
  end: number;
  from: number;
  /** The tick it is picked up or removed at, or Infinity: it lies to the round's end. */
  gone: number;
}

const NONE: readonly string[] = Object.freeze([]);

export class GroundIndex {
  readonly pack: Pack;
  /** Per round, its stretches by `from`, then id. */
  private readonly rounds: Stretch[][];
  private readonly names: readonly (readonly string[])[];
  private readonly ticks: Float64Array;
  private readonly x: Float64Array;
  private readonly y: Float64Array;
  private readonly z: Float64Array;
  /** Each key's angles in degrees, unwrapped along its stretch so a tumble turns the short way. */
  private readonly pitch: Float64Array;
  private readonly yaw: Float64Array;
  private readonly roll: Float64Array;

  constructor(pack: Pack) {
    this.pack = pack;
    const keys = pack.ground;
    const n = keys.length;
    this.ticks = new Float64Array(n);
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.z = new Float64Array(n);
    this.pitch = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.roll = new Float64Array(n);
    const rounds = pack.header.rounds.length;
    this.rounds = Array.from({ length: rounds }, () => []);
    const weapons = pack.header.weapons.map((w) => normaliseWeapon(w));
    // The keys are sorted by (round, id, tick). A stretch runs from a pose key over the pose
    // keys after it of the same item, and ends at a `gone` key, at a key of another weapon
    // under the same id (the id was taken by a new item), or after the item's last key.
    let open: Stretch | null = null;
    let openRound = 0;
    for (let i = 0; i <= n; i++) {
      const k = i < n ? keys[i] : null;
      const weapon = k ? (weapons[k.weapon] ?? '') : '';
      const same =
        k !== null &&
        open !== null &&
        k.round === openRound &&
        k.id === open.id;
      if (open && (!same || k!.gone || weapon !== open.weapon)) {
        open.gone = same ? k!.tick : Infinity;
        this.rounds[openRound]?.push(open);
        open = null;
      }
      if (!k || k.gone) continue;
      this.ticks[i] = k.tick;
      this.x[i] = k.x;
      this.y[i] = k.y;
      this.z[i] = k.z;
      // The key before, when it is a pose key of this stretch.
      const prev = open ? i - 1 : -1;
      this.pitch[i] = unwrap(k.pitch / 100, prev < 0 ? null : this.pitch[prev]);
      this.yaw[i] = unwrap(k.yaw / 100, prev < 0 ? null : this.yaw[prev]);
      this.roll[i] = unwrap(k.roll / 100, prev < 0 ? null : this.roll[prev]);
      if (open) open.end = i + 1;
      else {
        open = {
          id: k.id,
          weapon,
          start: i,
          end: i + 1,
          from: k.tick,
          gone: Infinity,
        };
        openRound = k.round;
      }
    }
    for (const r of this.rounds)
      r.sort((a, b) => a.from - b.from || a.id - b.id);
    this.names = this.rounds.map((r) =>
      r.length
        ? Object.freeze(
            [...new Set(r.map((s) => s.weapon))].filter(Boolean).sort()
          )
        : NONE
    );
  }

  /**
   * Writes the items lying in round `round` at `tick` (a float), newest first (the one put
   * down last), to `out[0]`, `out[1]`, … and returns how many, at most `limit`. An item lies
   * from a pose key until its next `gone` key, at the linear interpolation of its pose keys
   * around `tick` and the last held after them. The objects already in `out` are reused (one
   * is added only where there is none), and what lies past the count is left as it is.
   */
  at(round: number, tick: number, out: GroundPose[], limit = Infinity): number {
    const list = this.rounds[round];
    if (!list) return 0;
    let n = 0;
    for (let s = list.length - 1; s >= 0 && n < limit; s--) {
      const st = list[s];
      if (!(tick >= st.from) || tick >= st.gone) continue;
      const p = (out[n] ??= {
        id: 0,
        weapon: '',
        x: 0,
        y: 0,
        z: 0,
        pitch: 0,
        yaw: 0,
        roll: 0,
      });
      this.pose(st, tick, p);
      n++;
    }
    return n;
  }

  /** The models of the items of round `round`, normalised, sorted, once each. */
  weaponsIn(round: number): readonly string[] {
    return this.names[round] ?? NONE;
  }

  private pose(st: Stretch, tick: number, out: GroundPose): void {
    out.id = st.id;
    out.weapon = st.weapon;
    // The last key at or before `tick`.
    let lo = st.start;
    let hi = st.end - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.ticks[mid] <= tick) lo = mid;
      else hi = mid - 1;
    }
    const next = lo + 1;
    const t =
      next < st.end
        ? (tick - this.ticks[lo]) / (this.ticks[next] - this.ticks[lo])
        : 0;
    const b = next < st.end ? next : lo;
    out.x = lerp(this.x[lo], this.x[b], t);
    out.y = lerp(this.y[lo], this.y[b], t);
    out.z = lerp(this.z[lo], this.z[b], t);
    out.pitch = lerp(this.pitch[lo], this.pitch[b], t);
    out.yaw = lerp(this.yaw[lo], this.yaw[b], t);
    out.roll = lerp(this.roll[lo], this.roll[b], t);
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
