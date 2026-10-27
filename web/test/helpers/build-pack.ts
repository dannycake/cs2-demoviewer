// Writes a DVPK v1 pack byte for byte as docs/pack.md lays it out, so the reader tests do
// not depend on the Rust writer. Column values are deterministic functions of
// (round, player, column, sample) so a test can recompute any value it reads back.

import type {
  GroundItem,
  InventoryChange,
  MapEntity,
  MapEntityChange,
  MatchHeader,
  Pack,
  PackEvent,
} from '../../src/pack/types';

export interface BuildRound {
  samples: number;
  start_tick: number;
}

export interface BuildGrenade {
  samples: number;
  entity_id?: number;
  kind?: 'smoke' | 'flash' | 'he' | 'molotov' | 'incendiary' | 'decoy';
  thrower?: number;
  start_tick?: number;
  detonate_tick?: number | null;
  expire_tick?: number | null;
}

export interface BuildOptions {
  players: number;
  rounds: BuildRound[];
  tick_step: number;
  events?: PackEvent[];
  grenades?: BuildGrenade[];
  /** Replaces the 4 magic bytes. */
  magic?: string;
  version?: number;
  /** Section tags in write order; may omit, repeat or add unknown tags. */
  order?: string[];
  /** Bytes cut from the end of a section's payload (its length field shrinks with it). */
  trim?: Partial<Record<string, number>>;
  /** Fields merged over the generated header JSON. */
  header?: Record<string, unknown>;
  /** Overrides the weapon column (default: a valid index into `weapons`). */
  weapon?: (round: number, player: number, sample: number) => number;
  /** The `INV1` payload (written when `order` lists `INV1`). */
  inventory?: InventoryChange[];
  /** The `ENT1` payload (written when `order` lists `ENT1`); none of either by default. */
  mapEntities?: { entities: MapEntity[]; changes: MapEntityChange[] };
  /**
   * The ground items, sorted by `(round, id, tick)`, written as `GND1` runs and `GNB1`
   * columns (when `order` lists them); none by default.
   */
  ground?: GroundItem[];
  /** Raw payloads that replace the generated ones, by tag. */
  payload?: Partial<Record<string, Uint8Array>>;
}

export const WEAPONS = ['none', 'ak47', 'm4a1', 'knife'];
export const I16_COLUMNS = ['x', 'y', 'z', 'yaw', 'pitch'] as const;
export const U8_COLUMNS = [
  'health',
  'armor',
  'flags',
  'duck',
  'weapon',
] as const;

/** i16 column `c` (0..4 = x,y,z,yaw,pitch) of player `p` in round `r` at sample `k`. */
export function i16Value(r: number, p: number, c: number, k: number): number {
  return ((r * 7919 + p * 104729 + c * 1299709 + k * 15485863) % 65536) - 32768;
}

/** u8 column `c` (0..3 = health,armor,flags,duck; 4 = weapon) of player `p` in round `r` at sample `k`. */
export function u8Value(r: number, p: number, c: number, k: number): number {
  if (c === 4) return (r + p + k) % WEAPONS.length;
  return (r * 31 + p * 17 + c * 53 + k * 11) % 256;
}

/** TRK2 column `c` (0 = money, 1 = ammo, 2 = gear) of player `p` in round `r` at sample `k`. */
export function extraValue(r: number, p: number, c: number, k: number): number {
  if (c === 0) return (r * 1000 + p * 100 + k * 7) % 65536;
  if (c === 1) return (r + p * 3 + k) % 256;
  return (r * 3 + p + k) % 16;
}

/** Grenade coordinate `c` (0..2 = x,y,z) of grenade `g` at sample `k`. */
export function grenadeValue(g: number, c: number, k: number): number {
  return ((g * 3001 + c * 7001 + k * 9001) % 65536) - 32768;
}

export function buildHeader(o: BuildOptions): MatchHeader {
  const rounds = o.rounds.map((r, i) => ({
    number: i + 1,
    start_tick: r.start_tick,
    freeze_end_tick: r.start_tick + 10,
    end_tick: r.start_tick + Math.max(0, r.samples - 1) * o.tick_step,
    post_end_tick: r.start_tick + Math.max(0, r.samples - 1) * o.tick_step,
    winner: i % 2 === 0 ? 2 : 3,
    reason: i % 2 === 0 ? 't_killed' : 'ct_killed',
    score_t: Math.ceil((i + 1) / 2),
    score_ct: Math.floor((i + 1) / 2),
    samples: r.samples,
  }));
  const players = Array.from({ length: o.players }, (_, p) => ({
    // 64-bit Steam ids exceed 2^53: the pack keeps them as decimal strings.
    steamid: String(76561198000000000n + BigInt(p) * 1000000007n),
    name: `player ${p} ✓`,
    team_by_round: o.rounds.map((_, r) => ((p + r) % 2 === 0 ? 2 : 3)),
    crosshair: null,
  }));
  return {
    version: 1,
    map: 'de_test',
    server_name: 'test server',
    game_build: '14185',
    tick_rate: 64,
    sample_hz: 64 / o.tick_step,
    tick_step: o.tick_step,
    players,
    rounds,
    weapons: [...WEAPONS],
  };
}

export function grenadeMetas(o: BuildOptions) {
  return (o.grenades ?? []).map((g, i) => ({
    entity_id: g.entity_id ?? 100 + i,
    kind: g.kind ?? 'smoke',
    thrower: g.thrower ?? i % Math.max(1, o.players),
    start_tick: g.start_tick ?? 200 + i,
    detonate_tick: g.detonate_tick === undefined ? 300 + i : g.detonate_tick,
    expire_tick: g.expire_tick === undefined ? null : g.expire_tick,
    samples: g.samples,
  }));
}

class ByteWriter {
  private chunks: Uint8Array[] = [];

  bytes(b: Uint8Array): void {
    this.chunks.push(b);
  }

  ascii(s: string): void {
    this.bytes(new Uint8Array([...s].map((ch) => ch.charCodeAt(0))));
  }

  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.bytes(b);
  }

  u64(v: number): void {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v), true);
    this.bytes(b);
  }

  i16s(values: number[]): void {
    const b = new Uint8Array(values.length * 2);
    const view = new DataView(b.buffer);
    values.forEach((v, i) => view.setInt16(i * 2, v, true));
    this.bytes(b);
  }

  u8s(values: number[]): void {
    this.bytes(Uint8Array.from(values));
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.chunks.reduce((n, c) => n + c.length, 0));
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

const range = (n: number) => Array.from({ length: n }, (_, k) => k);

function trackPayload(o: BuildOptions): Uint8Array {
  const w = new ByteWriter();
  o.rounds.forEach((round, r) => {
    for (let p = 0; p < o.players; p++) {
      for (let c = 0; c < 5; c++)
        w.i16s(range(round.samples).map((k) => i16Value(r, p, c, k)));
      for (let c = 0; c < 5; c++) {
        const value =
          c === 4 && o.weapon
            ? (k: number) => o.weapon!(r, p, k)
            : (k: number) => u8Value(r, p, c, k);
        w.u8s(range(round.samples).map(value));
      }
    }
  });
  return w.finish();
}

function extraPayload(o: BuildOptions): Uint8Array {
  const w = new ByteWriter();
  o.rounds.forEach((round, r) => {
    for (let p = 0; p < o.players; p++) {
      const money = range(round.samples).map((k) => extraValue(r, p, 0, k));
      const b = new Uint8Array(money.length * 2);
      const view = new DataView(b.buffer);
      money.forEach((v, i) => view.setUint16(i * 2, v, true));
      w.bytes(b);
      for (let c = 1; c < 3; c++)
        w.u8s(range(round.samples).map((k) => extraValue(r, p, c, k)));
    }
  });
  return w.finish();
}

function grenadePayload(o: BuildOptions): Uint8Array {
  const w = new ByteWriter();
  (o.grenades ?? []).forEach((g, i) => {
    for (let c = 0; c < 3; c++)
      w.i16s(range(g.samples).map((k) => grenadeValue(i, c, k)));
  });
  return w.finish();
}

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

/** `GND1`: the items as runs of consecutive keys sharing `round`, `id` and `weapon`. */
export function groundRuns(items: GroundItem[]) {
  const runs: { round: number; id: number; weapon: number; keys: number }[] =
    [];
  for (const g of items) {
    const last = runs.at(-1);
    if (
      last &&
      last.round === g.round &&
      last.id === g.id &&
      last.weapon === g.weapon
    )
      last.keys++;
    else runs.push({ round: g.round, id: g.id, weapon: g.weapon, keys: 1 });
  }
  return runs;
}

/**
 * `GNB1`, as docs/pack.md lays it out: `tick` i32 × N, then `x,y,z,pitch,yaw,roll` i16 × N each,
 * then `gone` u8 × N; within a run, a value after the first is the wrapping difference from
 * the key before.
 */
function groundPayload(items: GroundItem[]): Uint8Array {
  const n = items.length;
  const b = new Uint8Array(n * 17);
  const view = new DataView(b.buffer);
  const first = new Set<number>();
  let at = 0;
  for (const r of groundRuns(items)) {
    first.add(at);
    at += r.keys;
  }
  const diff = (k: number, f: (g: GroundItem) => number) =>
    first.has(k) ? f(items[k]) : f(items[k]) - f(items[k - 1]);
  items.forEach((_, k) =>
    view.setInt32(
      k * 4,
      diff(k, (g) => g.tick),
      true
    )
  );
  const cols = ['x', 'y', 'z', 'pitch', 'yaw', 'roll'] as const;
  cols.forEach((c, i) =>
    items.forEach((_, k) =>
      // setInt16 keeps the low 16 bits: the wrapping difference.
      view.setInt16(
        n * 4 + (i * n + k) * 2,
        diff(k, (g) => g[c]),
        true
      )
    )
  );
  items.forEach((g, k) => (b[n * 16 + k] = g.gone ? 1 : 0));
  return b;
}

export function buildPack(o: BuildOptions): Uint8Array {
  const payloads: Record<string, () => Uint8Array> = {
    HDR1: () => json({ ...buildHeader(o), ...o.header }),
    TRK1: () => trackPayload(o),
    EVT1: () => json(o.events ?? []),
    GRN1: () => json(grenadeMetas(o)),
    GRB1: () => grenadePayload(o),
    TRK2: () => extraPayload(o),
    INV1: () => json(o.inventory ?? []),
    ENT1: () => json(o.mapEntities ?? { entities: [], changes: [] }),
    GND1: () => json(groundRuns(o.ground ?? [])),
    GNB1: () => groundPayload(o.ground ?? []),
  };
  const w = new ByteWriter();
  w.ascii(o.magic ?? 'DVPK');
  w.u16(o.version ?? 1);
  for (const tag of o.order ?? ['HDR1', 'TRK1', 'EVT1', 'GRN1', 'GRB1']) {
    let payload =
      o.payload?.[tag] ?? payloads[tag]?.() ?? json({ unknown: tag });
    const cut = o.trim?.[tag] ?? 0;
    if (cut) payload = payload.subarray(0, payload.length - cut);
    w.ascii(tag);
    w.u64(payload.length);
    w.bytes(payload);
  }
  return w.finish();
}

/**
 * `pack` written as a DVPK v1 pack with every section (TRK2, INV1, ENT1 and GND1 + GNB1
 * included), so a pack made up in code (synthetic-match.ts) is read by `parsePack` as a real
 * one is. The columns are written as they are; nothing is checked here (the reader does).
 */
export function encodePack(pack: Pack): Uint8Array {
  const { header } = pack;
  const tracks = new ByteWriter();
  const extra = new ByteWriter();
  for (const round of pack.rounds)
    for (const t of round.players) {
      for (const c of I16_COLUMNS) tracks.i16s([...t[c]]);
      for (const c of U8_COLUMNS) tracks.u8s([...t[c]]);
      const money = new Uint8Array(t.money.length * 2);
      const view = new DataView(money.buffer);
      t.money.forEach((v, i) => view.setUint16(i * 2, v, true));
      extra.bytes(money);
      extra.u8s([...t.ammo]);
      extra.u8s([...t.gear]);
    }
  const grenades = new ByteWriter();
  for (const g of pack.grenades)
    for (const c of ['x', 'y', 'z'] as const) grenades.i16s([...g[c]]);
  const sections: [string, Uint8Array][] = [
    ['HDR1', json(header)],
    ['TRK1', tracks.finish()],
    ['EVT1', json(pack.events)],
    [
      'GRN1',
      json(
        pack.grenades.map((g) => ({
          entity_id: g.entity_id,
          kind: g.kind,
          thrower: g.thrower,
          start_tick: g.start_tick,
          detonate_tick: g.detonate_tick,
          expire_tick: g.expire_tick,
          samples: g.samples,
        }))
      ),
    ],
    ['GRB1', grenades.finish()],
    ['TRK2', extra.finish()],
    ['INV1', json(pack.inventory)],
    ['ENT1', json({ entities: pack.entities, changes: pack.entityChanges })],
    ['GND1', json(groundRuns(pack.ground))],
    ['GNB1', groundPayload(pack.ground)],
  ];
  const w = new ByteWriter();
  w.ascii('DVPK');
  w.u16(header.version);
  for (const [tag, payload] of sections) {
    w.ascii(tag);
    w.u64(payload.length);
    w.bytes(payload);
  }
  return w.finish();
}
