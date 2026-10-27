// A one-round pack with real track columns, for the sim modules: each player is a function
// of the sample index returning position, angles and columns, so a test can describe a run,
// a turn or a death in a line.

import {
  FLAG,
  type Pack,
  type PackEvent,
  type Grenade,
  type PlayerTrack,
} from '../../src/pack/types';

export interface SampleSpec {
  x?: number;
  y?: number;
  z?: number;
  yaw?: number;
  pitch?: number;
  health?: number;
  armor?: number;
  flags?: number;
  duck?: number;
  /** Index into `weapons`. */
  weapon?: number;
  /** Bit set of `GEAR`. */
  gear?: number;
}

export interface TrackPackOptions {
  /** Per player: the sample at index k (0-based). Defaults fill what is left out. */
  players: ((k: number) => SampleSpec)[];
  samples?: number;
  tick_rate?: number;
  tick_step?: number;
  start_tick?: number;
  /** Ticks after the start; default 0. */
  freeze?: number;
  weapons?: string[];
  events?: PackEvent[];
  grenades?: Grenade[];
  /** Team per player index; default: first half T (2), rest CT (3). */
  teams?: number[];
}

export function trackPack(o: TrackPackOptions): Pack {
  const tickRate = o.tick_rate ?? 64;
  const tickStep = o.tick_step ?? 2;
  const samples = o.samples ?? 200;
  const start = o.start_tick ?? 1000;
  const n = o.players.length;
  const round = {
    number: 1,
    start_tick: start,
    freeze_end_tick: start + (o.freeze ?? 0),
    end_tick: start + (samples - 1) * tickStep,
    post_end_tick: start + (samples - 1) * tickStep,
    winner: 2,
    reason: 't_killed',
    score_t: 1,
    score_ct: 0,
    samples,
  };
  const tracks: PlayerTrack[] = o.players.map((fn) => {
    const t: PlayerTrack = {
      x: new Int16Array(samples),
      y: new Int16Array(samples),
      z: new Int16Array(samples),
      yaw: new Int16Array(samples),
      pitch: new Int16Array(samples),
      health: new Uint8Array(samples),
      armor: new Uint8Array(samples),
      flags: new Uint8Array(samples),
      duck: new Uint8Array(samples),
      weapon: new Uint8Array(samples),
      money: new Uint16Array(samples),
      ammo: new Uint8Array(samples).fill(255),
      gear: new Uint8Array(samples),
    };
    for (let k = 0; k < samples; k++) {
      const s = fn(k);
      t.x[k] = Math.round(s.x ?? 0);
      t.y[k] = Math.round(s.y ?? 0);
      t.z[k] = Math.round(s.z ?? 0);
      t.yaw[k] = Math.round((s.yaw ?? 0) * 100);
      t.pitch[k] = Math.round((s.pitch ?? 0) * 100);
      t.health[k] = s.health ?? 100;
      t.armor[k] = s.armor ?? 0;
      t.flags[k] = s.flags ?? FLAG.alive;
      t.duck[k] = s.duck ?? 0;
      t.weapon[k] = s.weapon ?? 1;
      t.gear[k] = s.gear ?? 0;
    }
    return t;
  });
  return {
    header: {
      version: 1,
      map: 'de_mirage',
      server_name: 'test',
      game_build: '0',
      tick_rate: tickRate,
      sample_hz: tickRate / tickStep,
      tick_step: tickStep,
      players: Array.from({ length: n }, (_, i) => ({
        steamid: String(76561198000000000n + BigInt(i)),
        name: `player${i + 1}`,
        team_by_round: [o.teams?.[i] ?? (i < Math.ceil(n / 2) ? 2 : 3)],
        crosshair: null,
      })),
      rounds: [round],
      weapons: o.weapons ?? ['none', 'ak47'],
    },
    rounds: [{ players: tracks }],
    events: o.events ?? [],
    grenades: o.grenades ?? [],
    inventory: [],
    entities: [],
    entityChanges: [],
    ground: [],
  };
}

/** A grenade track: `samples` points from `from` towards `to`, one per tick step. */
export function grenadeTrack(o: {
  kind: Grenade['kind'];
  thrower: number;
  start_tick: number;
  from: [number, number, number];
  to: [number, number, number];
  samples?: number;
  entity_id?: number;
}): Grenade {
  const samples = o.samples ?? 10;
  const g: Grenade = {
    entity_id: o.entity_id ?? 1,
    kind: o.kind,
    thrower: o.thrower,
    start_tick: o.start_tick,
    detonate_tick: null,
    expire_tick: null,
    samples,
    x: new Int16Array(samples),
    y: new Int16Array(samples),
    z: new Int16Array(samples),
  };
  for (let k = 0; k < samples; k++) {
    const t = samples > 1 ? k / (samples - 1) : 0;
    g.x[k] = Math.round(o.from[0] + (o.to[0] - o.from[0]) * t);
    g.y[k] = Math.round(o.from[1] + (o.to[1] - o.from[1]) * t);
    g.z[k] = Math.round(o.from[2] + (o.to[2] - o.from[2]) * t);
  }
  return g;
}

export function event(
  kind: string,
  tick: number,
  data: Record<string, unknown>
): PackEvent {
  return { tick, kind, data };
}

/**
 * `p` with a second round after its first, `gap` ticks after its end, with the same tracks: the
 * pack's events fall in whichever round their tick does.
 */
export function withSecondRound(p: Pack, gap = 1000): Pack {
  const r = p.header.rounds[0];
  const start = r.post_end_tick + gap;
  const second = {
    ...r,
    number: 2,
    start_tick: start,
    freeze_end_tick: start + (r.freeze_end_tick - r.start_tick),
    end_tick: start + (r.end_tick - r.start_tick),
    post_end_tick: start + (r.post_end_tick - r.start_tick),
  };
  return {
    ...p,
    header: { ...p.header, rounds: [r, second] },
    rounds: [p.rounds[0], p.rounds[0]],
  };
}
