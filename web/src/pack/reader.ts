// DVPK v1 reader (docs/pack.md), with the optional TRK2, INV1, ENT1 and GND1 + GNB1 sections, the browser twin of server/crates/pack/src/read.rs: same
// section rules, same validation, so a pack the server writes always parses here and a
// malformed one fails with a message naming the rule it broke. The Rust reader gets its JSON
// field types from serde; this one checks each field the same way (`check*`), so a field of the
// wrong type is a PackError here too, not a TypeError or a NaN in whatever reads it later. One
// thing differs: both take a grenade of any `kind` string, but the viewer looks each kind up in
// a table of the six the server writes today, so this reader leaves out a grenade of any other
// kind (one a later server adds) and reads the rest of the pack.

import { messageOf } from '../errors';
import {
  GEAR,
  type Grenade,
  type GroundItem,
  type InventoryChange,
  type MapEntity,
  type MapEntityChange,
  type MatchHeader,
  type Pack,
  type PackEvent,
  type PlayerTrack,
  type RoundTracks,
} from './types';

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackError';
  }
}

const MAGIC = 'DVPK';
const VERSION = 1;
/** x,y,z,yaw,pitch as i16 + health,armor,flags,duck,weapon as u8. */
const TRACK_SAMPLE_BYTES = 15;
/** money as u16 + ammo, gear as u8 (TRK2). */
const TRACK2_SAMPLE_BYTES = 4;
/** x,y,z as i16. */
const GRENADE_SAMPLE_BYTES = 6;
/** tick as i32 + x,y,z,pitch,yaw,roll as i16 + gone as u8 (GNB1). */
const GROUND_KEY_BYTES = 17;
const PREAMBLE = 6;
const SECTION_HEAD = 12;

// Typed arrays use the platform's byte order; every browser that runs WebGL is little-endian,
// but fall back to DataView rather than silently byte-swap on one that is not.
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

const utf8 = new TextDecoder('utf-8', { fatal: true });

interface GrenadeMeta {
  entity_id: number;
  kind: string;
  thrower: number;
  start_tick: number;
  detonate_tick: number | null;
  expire_tick: number | null;
  samples: number;
}

/** A grenade as `GRB1` holds it, before the kinds the viewer does not know are left out. */
type AnyGrenade = Omit<Grenade, 'kind'> & { kind: string };

/** A `GND1` entry: a run of consecutive keys of one item, whose values are in `GNB1`. */
interface GroundRun {
  round: number;
  id: number;
  weapon: number;
  keys: number;
}

/** Inflates `bytes` when they start with the gzip magic `1f 8b`; returns them as is otherwise. */
export async function inflateIfGzip(
  bytes: Uint8Array,
  maxBytes = Infinity,
  tooLarge: () => Error = () => new PackError('pack is too large')
): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  // Read it piece by piece, so an inflate past `maxBytes` stops there instead of
  // allocating it all first.
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      parts.push(value);
    }
  } catch (e) {
    if (total > maxBytes) throw e;
    throw new PackError(`pack is not valid gzip: ${messageOf(e)}`);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Parses an inflated DVPK v1 pack. Every column is copied into its own ArrayBuffer (the
 * columns sit at unaligned offsets after variable-length JSON), so the result can be
 * transferred between threads without dragging the input along.
 */
export function parsePack(bytes: Uint8Array): Pack {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < PREAMBLE || ascii(bytes, 0) !== MAGIC) {
    throw new PackError('not a DVPK pack (bad magic)');
  }
  const version = view.getUint16(4, true);
  if (version !== VERSION) {
    throw new PackError(
      `unsupported pack version ${version}, expected ${VERSION}`
    );
  }

  let header: MatchHeader | undefined;
  let rounds: RoundTracks[] | undefined;
  let events: PackEvent[] | undefined;
  let metas: GrenadeMeta[] | undefined;
  let grenades: AnyGrenade[] | undefined;
  let extra: true | undefined;
  let inventory: InventoryChange[] | undefined;
  let mapEntities: MapEntities | undefined;
  let groundRuns: GroundRun[] | undefined;
  let ground: GroundItem[] | undefined;

  const once = <T>(slot: T | undefined, tag: string): void => {
    if (slot !== undefined) throw new PackError(`duplicate ${tag} section`);
  };

  let off = PREAMBLE;
  while (off < bytes.length) {
    if (bytes.length - off < SECTION_HEAD)
      throw new PackError('truncated section tag');
    const tag = ascii(bytes, off);
    const len = view.getBigUint64(off + 4, true);
    const start = off + SECTION_HEAD;
    const left = bytes.length - start;
    if (len > BigInt(left)) {
      throw new PackError(`section ${tag} truncated: ${left} of ${len} bytes`);
    }
    const end = start + Number(len);
    const payload = bytes.subarray(start, end);

    switch (tag) {
      case 'HDR1':
        once(header, tag);
        header = checkHeader(json(tag, payload));
        break;
      case 'TRK1':
        if (!header) throw new PackError('TRK1 section before HDR1');
        once(rounds, tag);
        rounds = decodeTracks(header, bytes, view, start, end - start);
        break;
      case 'EVT1': {
        once(events, tag);
        events = checkEvents(json(tag, payload));
        break;
      }
      case 'GRN1':
        once(metas, tag);
        metas = checkGrenadeMetas(json(tag, payload));
        break;
      case 'GRB1':
        if (!metas) throw new PackError('GRB1 section before GRN1');
        once(grenades, tag);
        grenades = decodeGrenades(metas, bytes, view, start, end - start);
        break;
      case 'TRK2':
        if (!header) throw new PackError('TRK2 section before HDR1');
        if (!rounds) throw new PackError('TRK2 section before TRK1');
        once(extra, tag);
        decodeTracks2(header, rounds, bytes, view, start, end - start);
        extra = true;
        break;
      case 'INV1':
        once(inventory, tag);
        inventory = checkInventory(json(tag, payload));
        break;
      case 'ENT1':
        once(mapEntities, tag);
        mapEntities = checkMapEntities(json(tag, payload));
        break;
      case 'GND1':
        once(groundRuns, tag);
        groundRuns = checkGroundRuns(json(tag, payload));
        break;
      case 'GNB1':
        if (!groundRuns) throw new PackError('GNB1 section before GND1');
        once(ground, tag);
        ground = decodeGround(groundRuns, bytes, view, start, end - start);
        break;
      default:
        // Unknown tags are skipped, so a v1 reader survives sections added later.
        break;
    }
    off = end;
  }

  const missing = (tag: string) => new PackError(`missing ${tag} section`);
  if (!header) throw missing('HDR1');
  if (!rounds) throw missing('TRK1');
  if (!events) throw missing('EVT1');
  if (!grenades) throw missing(metas ? 'GRB1' : 'GRN1');
  if (groundRuns && !ground) throw missing('GNB1');
  if (!extra) fillTracks2(header, rounds);
  for (const r of header.rounds) {
    if (typeof r.post_end_tick !== 'number') r.post_end_tick = r.end_tick;
  }
  for (const p of header.players) {
    if (typeof p.crosshair !== 'string') p.crosshair = null;
  }
  const pack: Pack = {
    header,
    rounds,
    events,
    grenades: grenades.filter((g): g is Grenade => isGrenadeKind(g.kind)),
    inventory: inventory ?? [],
    entities: mapEntities?.entities ?? [],
    entityChanges: mapEntities?.changes ?? [],
    ground: ground ?? [],
  };
  validate(pack, grenades);
  return pack;
}

/** Fills `money`, `ammo` and `gear` of every track from a `TRK2` payload. */
function decodeTracks2(
  h: MatchHeader,
  rounds: RoundTracks[],
  bytes: Uint8Array,
  view: DataView,
  start: number,
  len: number
): void {
  const players = h.players.length;
  const expected = h.rounds.reduce(
    (n, r) => n + players * r.samples * TRACK2_SAMPLE_BYTES,
    0
  );
  expectLength('TRK2', len, expected);
  const c = new Columns(bytes, view, start);
  h.rounds.forEach((r, i) => {
    for (const t of rounds[i].players) {
      t.money = c.u16(r.samples);
      t.ammo = c.u8(r.samples);
      t.gear = c.u8(r.samples);
    }
  });
}

/**
 * A pack without `TRK2`: every track gets zero money and gear and no magazine. The arrays are
 * shared per round (nothing writes to a track's columns).
 */
function fillTracks2(h: MatchHeader, rounds: RoundTracks[]): void {
  h.rounds.forEach((r, i) => {
    const money = new Uint16Array(r.samples);
    const ammo = new Uint8Array(r.samples).fill(GEAR.ammoNone);
    const gear = new Uint8Array(r.samples);
    for (const t of rounds[i].players) {
      t.money = money;
      t.ammo = ammo;
      t.gear = gear;
    }
  });
}

function checkInventory(v: unknown): InventoryChange[] {
  if (!Array.isArray(v)) throw new PackError('INV1 is not a JSON array');
  v.forEach((c, i) => {
    if (
      !isObject(c) ||
      !isU16(c.round) ||
      !isU8(c.player) ||
      !isI32(c.tick) ||
      !isArrayOf(c.items, isU8)
    ) {
      throw new PackError(`INV1[${i}] is not {round, player, tick, items}`);
    }
  });
  return v as InventoryChange[];
}

/** The `ENT1` payload. */
interface MapEntities {
  entities: MapEntity[];
  changes: MapEntityChange[];
}

const KINDS: readonly unknown[] = ['door', 'breakable'];

function checkMapEntities(v: unknown): MapEntities {
  if (!isObject(v) || !Array.isArray(v.entities) || !Array.isArray(v.changes)) {
    throw new PackError('ENT1 is not {entities, changes}');
  }
  v.entities.forEach((e, i) => {
    if (
      !isObject(e) ||
      !KINDS.includes(e.kind) ||
      !isI16(e.x) ||
      !isI16(e.y) ||
      !isI16(e.z)
    ) {
      throw new PackError(`ENT1 entities[${i}] is not {kind, x, y, z}`);
    }
  });
  v.changes.forEach((c, i) => {
    if (
      !isObject(c) ||
      !isU16(c.round) ||
      !isU16(c.entity) ||
      !isI32(c.tick) ||
      !isI16(c.pitch) ||
      !isI16(c.yaw) ||
      !isI16(c.roll) ||
      typeof c.gone !== 'boolean'
    ) {
      throw new PackError(
        `ENT1 changes[${i}] is not {round, entity, tick, pitch, yaw, roll, gone}`
      );
    }
  });
  return v as unknown as MapEntities;
}

/** Each run's fields as serde's `GroundRun` reads them: round u16, id u16, weapon u8, keys u32. */
function checkGroundRuns(v: unknown): GroundRun[] {
  if (!Array.isArray(v)) throw new PackError('GND1 is not a JSON array');
  v.forEach((r, i) => {
    if (
      !isObject(r) ||
      !isUint(r.round, 0xffff) ||
      !isUint(r.id, 0xffff) ||
      !isUint(r.weapon, 0xff) ||
      !isUint(r.keys, 0xffffffff)
    ) {
      throw new PackError(`GND1[${i}] is not {round, id, weapon, keys}`);
    }
  });
  return v as GroundRun[];
}

/**
 * The keys of `GNB1`: every column holds every key, run after run in `GND1` order, a run's
 * values after its first as wrapping differences from the key before (docs/pack.md).
 */
function decodeGround(
  runs: GroundRun[],
  bytes: Uint8Array,
  view: DataView,
  start: number,
  len: number
): GroundItem[] {
  // Each count is a u32; their sum times the key size must be a safe integer before it is
  // compared (the Rust reader's checked arithmetic), so crafted counts are refused here rather
  // than by an allocation.
  const n = runs.reduce((sum, r) => sum + r.keys, 0);
  const expected = n * GROUND_KEY_BYTES;
  if (!Number.isSafeInteger(expected))
    throw new PackError('GNB1 size overflows');
  expectLength('GNB1', len, expected);
  const c = new Columns(bytes, view, start);
  const tick = c.i32(n);
  const x = c.i16(n);
  const y = c.i16(n);
  const z = c.i16(n);
  const pitch = c.i16(n);
  const yaw = c.i16(n);
  const roll = c.i16(n);
  const gone = c.u8(n);
  const bad = gone.find((b) => b > 1);
  if (bad !== undefined)
    throw new PackError(`GNB1 gone byte ${bad}, not 0 or 1`);
  const out: GroundItem[] = [];
  let k = 0;
  for (const r of runs) {
    for (let j = 0; j < r.keys; j++, k++) {
      if (j > 0) {
        // Typed arrays store modulo 2^32 and 2^16: the sums wrap as the writer's did.
        tick[k] += tick[k - 1];
        x[k] += x[k - 1];
        y[k] += y[k - 1];
        z[k] += z[k - 1];
        pitch[k] += pitch[k - 1];
        yaw[k] += yaw[k - 1];
        roll[k] += roll[k - 1];
      }
      out.push({
        round: r.round,
        id: r.id,
        weapon: r.weapon,
        tick: tick[k],
        x: x[k],
        y: y[k],
        z: z[k],
        pitch: pitch[k],
        yaw: yaw[k],
        roll: roll[k],
        gone: gone[k] === 1,
      });
    }
  }
  return out;
}

function ascii(bytes: Uint8Array, off: number): string {
  return String.fromCharCode(
    bytes[off],
    bytes[off + 1],
    bytes[off + 2],
    bytes[off + 3]
  );
}

function json(tag: string, payload: Uint8Array): unknown {
  try {
    return JSON.parse(utf8.decode(payload));
  } catch (e) {
    throw new PackError(`${tag} is not valid JSON: ${messageOf(e)}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** An integer in `0..=max`. */
const isUint = (v: unknown, max: number): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

// serde's integer types, as the Rust structs declare each field.
const isU8 = (v: unknown): v is number => isUint(v, 0xff);
const isU16 = (v: unknown): v is number => isUint(v, 0xffff);
const isU32 = (v: unknown): v is number => isUint(v, 0xffffffff);
const isI16 = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= -0x8000 && (v as number) <= 0x7fff;
const isI32 = (v: unknown): v is number =>
  Number.isInteger(v) &&
  (v as number) >= -0x80000000 &&
  (v as number) <= 0x7fffffff;

const isString = (v: unknown): v is string => typeof v === 'string';

const isArrayOf = (v: unknown, is: (e: unknown) => boolean): v is unknown[] =>
  Array.isArray(v) && v.every(is);

/** serde's `Option<T>`: absent, null, or a T. */
const optional =
  (is: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === undefined || v === null || is(v);

/** A steamid as `steamid_string` reads it: a decimal u64 in a string. */
const isSteamId = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9]{1,20}$/.test(v) &&
  BigInt(v) <= 0xffffffffffffffffn;

/** A JSON object's field, the check serde's type for it makes, and that type in words. */
type Field = readonly [key: string, is: (v: unknown) => boolean, what: string];

/**
 * Refuses `v` unless it is an object whose every field in `fields` passes its check, naming the
 * first that does not (`where` is only called then).
 */
function checkFields(
  v: unknown,
  fields: readonly Field[],
  where: () => string
): void {
  if (!isObject(v)) throw new PackError(`${where()} is not an object`);
  for (const [key, is, what] of fields) {
    if (!is(v[key])) throw new PackError(`${where()}.${key} is not ${what}`);
  }
}

/** serde's `RoundInfo`. */
const ROUND_FIELDS: readonly Field[] = [
  ['number', isU16, 'a u16'],
  ['start_tick', isI32, 'an i32'],
  ['freeze_end_tick', isI32, 'an i32'],
  ['end_tick', isI32, 'an i32'],
  ['winner', isU8, 'a u8'],
  ['reason', isString, 'a string'],
  ['score_t', isU8, 'a u8'],
  ['score_ct', isU8, 'a u8'],
  ['samples', isU32, 'a u32'],
  ['post_end_tick', optional(isI32), 'an i32 or null'],
];

/** serde's `PlayerInfo`. */
const PLAYER_FIELDS: readonly Field[] = [
  ['steamid', isSteamId, 'a u64 as a decimal string'],
  ['name', isString, 'a string'],
  ['team_by_round', (v) => isArrayOf(v, isU8), 'an array of u8'],
  ['crosshair', optional(isString), 'a string or null'],
];

/** serde's `Event`: `data` is a `serde_json::Map`, an object. */
const EVENT_FIELDS: readonly Field[] = [
  ['tick', isI32, 'an i32'],
  ['kind', isString, 'a string'],
  ['data', isObject, 'an object'],
];

/** The grenade kinds the server writes, each of which the viewer's tables have. */
const GRENADE_KINDS: readonly string[] = [
  'smoke',
  'flash',
  'he',
  'molotov',
  'incendiary',
  'decoy',
] satisfies Grenade['kind'][];

function isGrenadeKind(kind: string): kind is Grenade['kind'] {
  return GRENADE_KINDS.includes(kind);
}

/** serde's `GrenadeMeta`. */
const GRENADE_FIELDS: readonly Field[] = [
  ['entity_id', isI32, 'an i32'],
  ['kind', isString, 'a string'],
  ['thrower', isU8, 'a u8'],
  ['start_tick', isI32, 'an i32'],
  ['detonate_tick', optional(isI32), 'an i32 or null'],
  ['expire_tick', optional(isI32), 'an i32 or null'],
  ['samples', isU32, 'a u32'],
];

/** Ticks a second no demo comes near (CS2 runs 64): a bound for the loops over a fuse or a round. */
const MAX_TICK_RATE = 1024;

/**
 * Checks the header as serde's `MatchHeader` reads it (`version` is `validate`'s), plus the
 * bounds the loops over time need.
 */
function checkHeader(v: unknown): MatchHeader {
  if (!isObject(v)) throw new PackError('HDR1 is not a JSON object');
  for (const key of ['map', 'server_name', 'game_build']) {
    if (!isString(v[key])) throw new PackError(`header.${key} is not a string`);
  }
  for (const key of ['players', 'rounds', 'weapons']) {
    if (!Array.isArray(v[key]))
      throw new PackError(`header.${key} is not an array`);
  }
  // Every loop over time steps by these: zero, a loop never ends (serde reads them as u32).
  for (const key of ['tick_rate', 'sample_hz', 'tick_step']) {
    const n = v[key];
    if (!isU32(n) || n === 0)
      throw new PackError(`header.${key} is not a positive integer`);
  }
  if ((v.tick_rate as number) > MAX_TICK_RATE)
    throw new PackError(`header.tick_rate is over ${MAX_TICK_RATE}`);
  if ((v.sample_hz as number) > (v.tick_rate as number))
    throw new PackError('header.sample_hz is over header.tick_rate');
  (v.weapons as unknown[]).forEach((w, i) => {
    if (!isString(w))
      throw new PackError(`header.weapons[${i}] is not a string`);
  });
  (v.rounds as unknown[]).forEach((r, i) =>
    checkFields(r, ROUND_FIELDS, () => `header.rounds[${i}]`)
  );
  (v.players as unknown[]).forEach((p, i) =>
    checkFields(p, PLAYER_FIELDS, () => `header.players[${i}]`)
  );
  return v as unknown as MatchHeader;
}

function checkEvents(v: unknown): PackEvent[] {
  if (!Array.isArray(v)) throw new PackError('EVT1 is not a JSON array');
  // A match has tens of thousands: the fields are tested inline, and `checkFields` only runs
  // to name the one that failed.
  for (let i = 0; i < v.length; i++) {
    const e: unknown = v[i];
    if (
      !isObject(e) ||
      !isI32(e.tick) ||
      typeof e.kind !== 'string' ||
      !isObject(e.data)
    )
      checkFields(e, EVENT_FIELDS, () => `EVT1[${i}]`);
  }
  return v as PackEvent[];
}

function checkGrenadeMetas(v: unknown): GrenadeMeta[] {
  if (!Array.isArray(v)) throw new PackError('GRN1 is not a JSON array');
  v.forEach((g, i) => checkFields(g, GRENADE_FIELDS, () => `GRN1[${i}]`));
  return v as GrenadeMeta[];
}

const EMPTY_U16 = new Uint16Array(0);
const EMPTY_U8 = new Uint8Array(0);

/** Copies consecutive columns out of a payload whose total length was already checked. */
class Columns {
  private readonly bytes: Uint8Array;
  private readonly view: DataView;
  private off: number;

  constructor(bytes: Uint8Array, view: DataView, off: number) {
    this.bytes = bytes;
    this.view = view;
    this.off = off;
  }

  i32(n: number): Int32Array {
    const start = this.off;
    this.off += n * 4;
    if (LITTLE_ENDIAN)
      return new Int32Array(this.bytes.slice(start, this.off).buffer);
    const out = new Int32Array(n);
    for (let i = 0; i < n; i++)
      out[i] = this.view.getInt32(start + i * 4, true);
    return out;
  }

  i16(n: number): Int16Array {
    const start = this.off;
    this.off += n * 2;
    if (LITTLE_ENDIAN)
      return new Int16Array(this.bytes.slice(start, this.off).buffer);
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++)
      out[i] = this.view.getInt16(start + i * 2, true);
    return out;
  }

  u16(n: number): Uint16Array {
    const start = this.off;
    this.off += n * 2;
    if (LITTLE_ENDIAN)
      return new Uint16Array(this.bytes.slice(start, this.off).buffer);
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++)
      out[i] = this.view.getUint16(start + i * 2, true);
    return out;
  }

  u8(n: number): Uint8Array {
    const start = this.off;
    this.off += n;
    return this.bytes.slice(start, this.off);
  }
}

function expectLength(tag: string, actual: number, expected: number): void {
  if (actual !== expected) {
    throw new PackError(
      `${tag} is ${actual} bytes, header implies ${expected}`
    );
  }
}

function decodeTracks(
  h: MatchHeader,
  bytes: Uint8Array,
  view: DataView,
  start: number,
  len: number
): RoundTracks[] {
  const players = h.players.length;
  const expected = h.rounds.reduce(
    (n, r) => n + players * r.samples * TRACK_SAMPLE_BYTES,
    0
  );
  expectLength('TRK1', len, expected);
  const c = new Columns(bytes, view, start);
  return h.rounds.map((r) => {
    const n = r.samples;
    const tracks: PlayerTrack[] = [];
    for (let p = 0; p < players; p++) {
      tracks.push({
        x: c.i16(n),
        y: c.i16(n),
        z: c.i16(n),
        yaw: c.i16(n),
        pitch: c.i16(n),
        health: c.u8(n),
        armor: c.u8(n),
        flags: c.u8(n),
        duck: c.u8(n),
        weapon: c.u8(n),
        // Filled from TRK2, or with defaults (fillTracks2).
        money: EMPTY_U16,
        ammo: EMPTY_U8,
        gear: EMPTY_U8,
      });
    }
    return { players: tracks };
  });
}

/**
 * Every grenade of `GRB1`, its kind as GRN1 has it: `parsePack` leaves out those of a kind the
 * viewer does not know (`isGrenadeKind`) once `validate` has checked them all.
 */
function decodeGrenades(
  metas: GrenadeMeta[],
  bytes: Uint8Array,
  view: DataView,
  start: number,
  len: number
): AnyGrenade[] {
  const expected = metas.reduce(
    (n, g) => n + g.samples * GRENADE_SAMPLE_BYTES,
    0
  );
  expectLength('GRB1', len, expected);
  const c = new Columns(bytes, view, start);
  return metas.map((g) => ({
    entity_id: g.entity_id,
    kind: g.kind,
    thrower: g.thrower,
    start_tick: g.start_tick,
    // serde reads an absent Option as None.
    detonate_tick: g.detonate_tick ?? null,
    expire_tick: g.expire_tick ?? null,
    samples: g.samples,
    x: c.i16(g.samples),
    y: c.i16(g.samples),
    z: c.i16(g.samples),
  }));
}

/**
 * The rules the writer enforces (types.rs `validate`), checked again on the way in, over
 * `grenades`, every grenade the pack has (`m.grenades` leaves out the kinds the viewer does
 * not know). A `tick_step` of 0 is `checkHeader`'s.
 */
function validate(m: Pack, grenades: readonly AnyGrenade[]): void {
  const h = m.header;
  if (h.version !== VERSION) {
    throw new PackError(`header.version ${h.version} != ${VERSION}`);
  }
  if (h.weapons[0] !== 'none')
    throw new PackError('header.weapons[0] must be "none"');
  if (h.weapons.length > 256) {
    throw new PackError(
      `${h.weapons.length} weapons; a u8 index addresses at most 256`
    );
  }
  h.players.forEach((p, i) => {
    if (p.team_by_round.length !== h.rounds.length) {
      throw new PackError(
        `player ${i}: team_by_round has ${p.team_by_round.length} entries ` +
          `for ${h.rounds.length} rounds`
      );
    }
  });
  const weapons = h.weapons.length;
  m.rounds.forEach((round, r) => {
    round.players.forEach((t, p) => {
      for (const w of t.weapon) {
        if (w >= weapons) {
          throw new PackError(
            `round ${r} player ${p}: weapon index ${w} out of ${weapons} weapons`
          );
        }
      }
    });
  });
  m.header.rounds.forEach((r, i) => {
    if (r.post_end_tick < r.end_tick) {
      throw new PackError(
        `round ${i}: post_end_tick ${r.post_end_tick} before end_tick ${r.end_tick}`
      );
    }
  });
  m.inventory.forEach((c, i) => {
    if (c.round >= h.rounds.length || c.player >= h.players.length) {
      throw new PackError(
        `inventory ${i}: round ${c.round} player ${c.player} out of range`
      );
    }
    const bad = c.items.find((w) => w >= weapons);
    if (bad !== undefined) {
      throw new PackError(
        `inventory ${i}: weapon index ${bad} out of ${weapons} weapons`
      );
    }
  });
  m.entityChanges.forEach((c, i) => {
    if (c.round >= h.rounds.length || c.entity >= m.entities.length) {
      throw new PackError(
        `map change ${i}: round ${c.round} entity ${c.entity} out of range`
      );
    }
    const p = m.entityChanges[i - 1];
    if (
      p &&
      (p.round - c.round || p.entity - c.entity || p.tick - c.tick) > 0
    ) {
      throw new PackError(`map changes ${i - 1} and ${i} out of order`);
    }
  });
  m.ground.forEach((g, i) => {
    if (g.round >= h.rounds.length) {
      throw new PackError(`ground item ${i}: round ${g.round} out of range`);
    }
    if (g.weapon === 0 || g.weapon >= weapons) {
      throw new PackError(
        `ground item ${i}: weapon index ${g.weapon} not in 1..${weapons}`
      );
    }
    const p = m.ground[i - 1];
    if (p && (p.round - g.round || p.id - g.id || p.tick - g.tick) > 0) {
      throw new PackError(`ground items ${i - 1} and ${i} out of order`);
    }
  });
  grenades.forEach((g, i) => {
    const player =
      Number.isInteger(g.thrower) &&
      g.thrower >= 0 &&
      g.thrower < h.players.length;
    if (g.thrower !== 255 && !player) {
      throw new PackError(
        `grenade ${i}: thrower ${g.thrower} out of ${h.players.length} players`
      );
    }
  });
}
