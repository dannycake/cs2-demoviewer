// The decoded DVPK v1 pack (docs/pack.md), with the optional data (TRK2, INV1, ENT1, GND1,
// crosshair, post_end_tick) filled with defaults when a pack lacks it. Field names follow the pack's JSON so the header
// and events are used exactly as the server wrote them.

export interface MatchHeader {
  version: 1;
  map: string;
  server_name: string;
  game_build: string;
  tick_rate: number;
  sample_hz: number;
  tick_step: number;
  players: PlayerInfo[];
  rounds: RoundInfo[];
  /** Weapon names indexed by the `weapon` column; `weapons[0]` is always `"none"`. */
  weapons: string[];
}

export interface PlayerInfo {
  /** Decimal string: 64-bit Steam ids do not survive a JSON number. */
  steamid: string;
  name: string;
  /** Per round: 2 = T, 3 = CT, 0 = unknown / not playing. */
  team_by_round: number[];
  /** The player's crosshair share code (`CSGO-xxxxx-…`); null in packs without it. */
  crosshair: string | null;
}

export interface RoundInfo {
  number: number;
  start_tick: number;
  freeze_end_tick: number;
  end_tick: number;
  /** 2 = T, 3 = CT, 0 = unknown. */
  winner: number;
  reason: string;
  /** Scores after the round. */
  score_t: number;
  score_ct: number;
  /** Length of every column of every player track; sample k is at start_tick + k * tick_step. */
  samples: number;
  /**
   * Last tick of the round's play: `end_tick` is the `round_end` event (the round is decided),
   * the game goes on until this (the restart delay). The tracks cover it. Equal to `end_tick`
   * in packs without it.
   */
  post_end_tick: number;
}

/** One player's columns for one round; every column has `RoundInfo.samples` entries. */
export interface PlayerTrack {
  /** Source units. */
  x: Int16Array;
  y: Int16Array;
  z: Int16Array;
  /** Degrees x 100, in (-18000, 18000]. */
  yaw: Int16Array;
  pitch: Int16Array;
  health: Uint8Array;
  armor: Uint8Array;
  /** Bit set of `FLAG`. */
  flags: Uint8Array;
  /** round(duck_amount * 255). */
  duck: Uint8Array;
  /** Index into `MatchHeader.weapons`. */
  weapon: Uint8Array;
  /** Money; 0 in packs without it (`TRK2`). */
  money: Uint16Array;
  /** Rounds in the active weapon's magazine; `GEAR.ammoNone` without one or without data. */
  ammo: Uint8Array;
  /** Bit set of `GEAR`: helmet, defuse kit, zoom level; 0 in packs without it. */
  gear: Uint8Array;
}

export interface RoundTracks {
  /** In `header.players` order. */
  players: PlayerTrack[];
}

export interface PackEvent {
  tick: number;
  /** The game event name, e.g. `player_death`. */
  kind: string;
  data: Record<string, unknown>;
}

export interface Grenade {
  entity_id: number;
  kind: 'smoke' | 'flash' | 'he' | 'molotov' | 'incendiary' | 'decoy';
  /** Player index, or 255 when unknown. */
  thrower: number;
  start_tick: number;
  detonate_tick: number | null;
  expire_tick: number | null;
  /** Samples run every `tick_step` ticks from `start_tick`. */
  samples: number;
  x: Int16Array;
  y: Int16Array;
  z: Int16Array;
}

export interface Pack {
  header: MatchHeader;
  /** In `header.rounds` order. */
  rounds: RoundTracks[];
  events: PackEvent[];
  grenades: Grenade[];
  /** Each player's inventory from a tick on, within a round (`INV1`); empty without it. */
  inventory: InventoryChange[];
  /** The map's doors and breakables (`ENT1`), by spawn position; empty without it. */
  entities: MapEntity[];
  /**
   * How `entities` move and break within each round (`ENT1`), sorted by
   * `(round, entity, tick)`; empty without it.
   */
  entityChanges: MapEntityChange[];
  /**
   * Weapons, grenades and kits lying in the world (`GND1` + `GNB1`), sorted by
   * `(round, id, tick)`; empty without them.
   */
  ground: GroundItem[];
}

/**
 * A key of an item lying in the world: its pose from `tick` on within `round`, or with `gone`
 * its pickup (or removal). Between two pose keys of an item the viewer interpolates; after the
 * last it holds, until a `gone` key; a later pose key of the same `id` puts it down again.
 */
export interface GroundItem {
  /** Index into `header.rounds`. */
  round: number;
  /** The item's entity id: one item within a round. */
  id: number;
  /** Index into `header.weapons`, never 0: a display name (`"AK-47"`), or `"defuser"` for a kit. */
  weapon: number;
  tick: number;
  /** Source units. */
  x: number;
  y: number;
  z: number;
  /** Degrees x 100, in (-18000, 18000]. */
  pitch: number;
  yaw: number;
  roll: number;
  /** Picked up or removed: not drawn from `tick` on, until a later key. */
  gone: boolean;
}

/**
 * A door or breakable of the map. The demo makes these again under new entity ids, so one is
 * known by its spawn position, which is also its origin in the map's entity lump.
 */
export interface MapEntity {
  /** `door`: any class whose name has `Door` in it; `breakable`: `CBreakable`. */
  kind: 'door' | 'breakable';
  /** Spawn position, Source units (rounded). */
  x: number;
  y: number;
  z: number;
}

/**
 * A map entity's pose from `tick` on, within `round`: a key of its swing, or its break. Before
 * its first change in a round an entity is at spawn; between two keys it turns the shorter way.
 */
export interface MapEntityChange {
  /** Index into `header.rounds`. */
  round: number;
  /** Index into `Pack.entities`. */
  entity: number;
  tick: number;
  /** Absolute angles, degrees x 100, in (-18000, 18000]. */
  pitch: number;
  yaw: number;
  roll: number;
  /** Broken: not drawn from `tick` to the round's end. */
  gone: boolean;
}

export interface InventoryChange {
  /** Index into `header.rounds`. */
  round: number;
  /** Index into `header.players`. */
  player: number;
  tick: number;
  /** Indices into `header.weapons`, in the game's order. */
  items: number[];
}

/** Bits of the `gear` column, and the `ammo` value for "no magazine". */
export const GEAR = {
  helmet: 1,
  kit: 2,
  zoomShift: 2,
  zoomMask: 0b1100,
  ammoNone: 255,
} as const;

/** The zoom level (0, 1, 2) in a `gear` value. */
export function zoomOf(gear: number): number {
  return (gear & GEAR.zoomMask) >> GEAR.zoomShift;
}

export const FLAG = {
  alive: 1,
  scoped: 2,
  flashed: 4,
  bomb: 8,
  defusing: 16,
  airborne: 32,
  walking: 64,
} as const;
