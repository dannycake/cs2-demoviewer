# DVPK replay pack, version 1

One pack per match, produced by the server (`demoviewer-pack` crate,
`server/crates/pack`) and read by the browser with `DataView` → typed arrays. All integers
are little-endian.

## Byte layout

Stream is gzip; inside: magic `b"DVPK"`, `u16 LE` version; then sections
`[4-byte ASCII tag][u64 LE payload length][payload]` until EOF. Tags in order:

- `HDR1` = JSON `MatchHeader`;
- `TRK1` = for each round, for each player (header order): `x,y,z,yaw,pitch` as
  `i16 LE × samples` each, then `health,armor,flags,duck,weapon` as `u8 × samples` each;
- `EVT1` = JSON array of `Event`;
- `GRN1` = JSON array of `{entity_id, kind, thrower, start_tick, detonate_tick, expire_tick, samples}`;
- `GRB1` = for each grenade in GRN1 order: `x,y,z` as `i16 LE × samples`;
- `TRK2` (optional, after `TRK1`) = for each round, for each player (header order): `money` as
  `u16 LE × samples`, then `ammo` and `gear` as `u8 × samples` each;
- `INV1` (optional) = JSON array of `InventoryChange`;
- `ENT1` (optional, after `INV1`) = JSON `{ "entities": [MapEntity], "changes": [MapEntityChange] }`;
- `GND1` (optional, after `ENT1`) = JSON array of `{round, id, weapon, keys}`, one per run of
  ground keys;
- `GNB1` (with `GND1`, after it) = the keys of every run, `N = Σ keys`, as columns: `tick` as
  `i32 LE × N`, then `x,y,z,pitch,yaw,roll` as `i16 LE × N` each, then `gone` as `u8 × N`
  (0 or 1). Each column lists the keys run after run in `GND1` order. Within a run, a
  column's first value is the key's own; every later value is the difference from the run's
  previous key, in wrapping two's-complement arithmetic (`i32` for `tick`, `i16` for the
  others), so a reader adds it to the previous value with the same wrapping. `gone` is not
  differenced.

Readers ignore unknown tags. That is what keeps `TRK2` and `INV1` (added 2026-10-22, phase
3d), and `ENT1`, `GND1` and `GNB1` (milestone 2b), compatible: the version stayed 1, a reader written
before them skips them, and a pack written before them simply lacks them. The writer emits
each optional section only when it has something in it.

Quantisation: positions `round(units)` clamped to i16; yaw/pitch `round(deg·100)` with yaw
normalised to (-180,180]; `duck = round(duck_amount·255)`; `weapon` = index into
`header.weapons` (0 = `"none"`, always the first entry).

## JSON sections

`HDR1` — `MatchHeader`:

```json
{
  "version": 1,
  "map": "de_mirage",
  "server_name": "…",
  "game_build": "…",
  "tick_rate": 64,
  "sample_hz": 32,
  "tick_step": 2,
  "players": [{ "steamid": "76561198000000001", "name": "…", "team_by_round": [2, 2, 3],
                "crosshair": "CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB",
                "rank": { "kind": 11, "value": 8058, "wins": 14, "if_win": 8150,
                          "if_loss": 7960, "if_tie": 8058 } }],
  "rounds": [{ "number": 1, "start_tick": 1000, "freeze_end_tick": 2280, "end_tick": 7000,
               "post_end_tick": 7446, "winner": 2, "reason": "t_killed", "score_t": 1,
               "score_ct": 0, "samples": 3224 }],
  "weapons": ["none", "ak47", "knife"]
}
```

- `steamid` is a **decimal string**: 64-bit Steam IDs exceed JavaScript's 2^53 safe-integer
  range, so a JSON number would be silently rounded by `JSON.parse`.
- `team_by_round[r]`: 2 = T, 3 = CT, 0 = unknown; one entry per round.
- `winner`: 2 = T, 3 = CT, 0 = unknown. `score_t`/`score_ct` are the scores after the round.
- `samples`: the length of every column of every player track in that round. Sample `k` is
  at tick `start_tick + k · tick_step`.
- `end_tick` is the `round_end` event: the round is decided. `post_end_tick` (optional) is the
  last tick of the round's play, after that: the game goes on during the restart delay (exit
  frags, saves, a bomb that explodes after the last CT died). It is the next round's
  `start_tick − tick_step`, at most 10 s after `end_tick` (so a half-time break is not
  swallowed), and for the last round the last tick of the demo's player data. The tracks run
  to it. Absent in older packs, whose tracks end at `end_tick`; treat it as `end_tick`.
- `crosshair` (optional): the player's crosshair share code, the last non-empty one in the
  demo.
- `rank` (optional; absent in packs written before it existed): the player's matchmaking
  rank as the match started, from the first sample whose rank type is set (later samples can
  drop back to 0); a player the demo never ranks (a tournament server ranks nobody) has
  `kind` 0. `kind` is `m_iCompetitiveRankType`: 11 = Premier,
  12 = Competitive (per map), 7 = Wingman. `value` is `m_iCompetitiveRanking`: the Premier
  rating, or the skill group 1–18; 0 = unrated. `wins` is `m_iCompetitiveWins`; `if_win`,
  `if_loss` and `if_tie` are the rating or group the game predicts after each result.

`EVT1` — `[{ "tick": 1234, "kind": "player_death", "data": { … } }]`; `kind` is the game
event name and `data` its fields.

`GRN1` — `detonate_tick` and `expire_tick` are `null` when unknown; `kind` is one of `smoke`,
`flash`, `he`, `molotov`, `incendiary`, `decoy` (a reader takes any string: the web viewer
leaves out a grenade of a kind it does not know and reads the rest); `thrower` is a player
index or 255 when unknown; samples run every `tick_step` ticks from `start_tick`.

`INV1` — `[{ "round": 2, "player": 0, "tick": 10778, "items": [4, 1, 16] }]`: a player's
inventory from `tick` on within round `round` (indices into `header.rounds` and
`header.players`), `items` indexing `header.weapons` in the game's order. One entry at the
first sample of a round that has the player's inventory, then one each time it changes. The
names are the game's display names (`"knife_t"`, `"Glock-18"`, `"AK-47"`, `"High Explosive
Grenade"`, `"C4 Explosive"`), which is also what the `weapon` column carries.

`ENT1` — the map's doors and breakables, and how they move within each round:

```json
{
  "entities": [{ "kind": "door", "x": 257, "y": -1310, "z": -416 },
               { "kind": "breakable", "x": 1415, "y": -391, "z": -341 }],
  "changes": [{ "round": 3, "entity": 0, "tick": 20000, "pitch": 0, "yaw": 0, "roll": 0, "gone": false },
              { "round": 3, "entity": 0, "tick": 20029, "pitch": 0, "yaw": -9000, "roll": 0, "gone": false },
              { "round": 3, "entity": 1, "tick": 21544, "pitch": 0, "yaw": 0, "roll": 0, "gone": true }]
}
```

- `kind` is `door` (any entity class whose name contains `Door`) or `breakable`
  (`CBreakable`). An entity is known by its spawn position, in units: the demo creates doors
  and breakables again under new entity ids (each round's clean-up does), and the map's own
  entity lump has the same origins, which is how the viewer finds the model to move.
  `entities` are in order of `(x, y, z)`.
- `changes`, sorted by `(round, entity, tick)`: the entity's absolute angles (as yaw/pitch
  above, hundredths of a degree in (-180, 180]) from `tick` on within round `round`
  (indices into `header.rounds` and `entities`). Within a round, the pose between two keys is
  their linear interpolation, the shorter way round; after the last key it holds. Before its
  first key in a round, an entity is at its spawn pose. Every door has a key at each round's
  `start_tick`, its angles then (a demo can start with a door open, so the first state the
  demo shows of a door is no closed spawn), and its keys follow each swing to half a degree.
- `gone: true` is a breakable's break: it is not drawn from `tick` to the end of the round.
  A removal is a break only before the round is decided (`end_tick`) and when the entity is
  not created again at its spot within 8 ticks: each round's clean-up removes and restores
  every breakable, and the demo's end removes everything.
- The viewer's twin of these types is `MapEntity` and `MapEntityChange` in
  `web/src/pack/types.ts`, read by `web/src/pack/reader.ts` into `Pack.entities` and
  `Pack.entityChanges` (both empty without `ENT1`) under the same range and order rules. It finds
  each entity's model in the map's `entities.glb` by spawn position (within 2 units of the root's
  `extras.origin`) and class (`web/src/scene/mapents.ts`).

`GND1` + `GNB1` — weapons and defuse kits lying in the world, as keys
`{round, id, weapon, tick, x, y, z, pitch, yaw, roll, gone}` (the `GroundItem` type) sorted by
`(round, id, tick)`. The pack stores them like the grenades: `GND1` lists runs of consecutive
keys sharing `round`, `id` and `weapon`, `[{ "round": 5, "id": 412, "weapon": 7, "keys": 9 }]`,
and `GNB1` holds the keys' columns, differences within each run. (On the Nuke demo below, a
JSON array of keys came to 100 KB gzipped, per-run blocks of absolute values to 59 KB, and
these columns to 43.5 KB.)

- `id` is the item's entity id: the keys of one item within a round. `weapon` indexes
  `header.weapons` and is never 0: the item's display name, as in `INV1` (`"AK-47"`,
  `"Flashbang"`), or `"defuser"` for a defuse kit. Never the C4 (the dropped bomb is drawn
  from `bomb_dropped`/`bomb_pickup`), a knife or armour.
- A key is the item's position (units) and angles (hundredths of a degree) from `tick` on
  within round `round`; between keys the viewer interpolates, after the last it holds. Keys
  follow the item's fall to a unit and two degrees. `gone: true` (with the last pose) is a
  pickup or a removal: the item is not drawn from `tick` until a later key of the same `id`.
- An item is on the ground from where it lands: while a weapon has no owner, a position and
  a known item, without the first records after its owner clears, which can still carry its
  position relative to its holder. A defuse kit is the physics prop that appears within 64
  ticks and 128 units of the death of a CT who carried one.
- A round starts with nothing on the ground, except an item still lying there when it
  starts, which has a key at `start_tick`. The demo removes dropped items at a round's
  start by creating the map's entities in their slots, without a delete; the parser hook
  counts that as their removal.
- The viewer's twin of the type is `GroundItem` in `web/src/pack/types.ts`, read by
  `web/src/pack/reader.ts` into `Pack.ground` (empty without `GND1`) under the same rules.
  `web/src/sim/ground.ts` lays out what lies where in each round, and
  `web/src/scene/ground.ts` draws it with the weapon models under `/weapons/` (the kit's is
  `defuser.glb`, `tools/lib/weapons.mjs` `GROUND_MODELS`).

Measured 2026-10-24, gzipped growth of the pack with each section (written with and without
it):

| demo | map entities | changes | `ENT1` | ground keys (items) | `GND1` + `GNB1` |
|------|--------------|---------|--------|---------------------|-----------------|
| Nuke (`match730_…_404.dem`, 137 MB) | 4 doors, 2 breakables | 96 | +0.9 KB | 5,171 (193 runs, 895 keys on kits) | +43.5 KB |
| Mirage (`mirage.dem`, 237 MB) | 1 breakable | 3 breaks | +0.1 KB | 9,147 (338 runs, 1,516 keys on kits) | +74.2 KB |

Most ground keys are falls and tumbles (a dropped gun spins several degrees a tick until it
settles) and kits, which rock slowly for seconds after landing.

## TRK2 columns

- `money`: the player's account balance, clamped to 0–65535; 0 without data.
- `ammo`: rounds in the active weapon's magazine, at most 254; 255 when the weapon has no
  magazine (knife, grenade, C4), the player is dead, or there is no data. Reserve ammo is
  not carried: the demo's reserve prop reads 0 throughout.
- `gear` bits: 0 helmet, 1 defuse kit, 2–3 zoom level (0 unscoped, 1, 2); 0 for a dead
  player or no data.

Measured 2026-10-22 on the 237 MB Mirage demo: the props behind `TRK2`, `INV1` and
`crosshair` take the tick pass from 0.46 s to 0.93 s; the pack grows from about 2.4 MB to
2.55 MB gzipped; 1,400 inventory changes; all ten crosshair codes present.

## Player flags (`flags` column)

| bit | value | meaning  |
|-----|-------|----------|
| 0   | 1     | alive    |
| 1   | 2     | scoped   |
| 2   | 4     | flashed  |
| 3   | 8     | has bomb |
| 4   | 16    | defusing |
| 5   | 32    | airborne |
| 6   | 64    | walking  |

## Quantisation details

- Positions: world units rounded half away from zero, saturating at ±32767/-32768.
- Angles: yaw **and pitch** are normalised to (-180°, 180°] before scaling, so stored values
  lie in (-18000, 18000]; a value that rounds to -18000 is stored as 18000. Pitch in its
  normal ±89° range is unaffected; the normalisation only guards against 0–360° inputs.
- Non-finite inputs quantise to 0.

## Reader rules

- The version after the magic must equal 1; anything else is refused.
- Sections may appear in any order, except that `TRK1` must follow `HDR1` (its sizes come
  from the header) and `GRB1` must follow `GRN1`. All five sections are required; a known
  tag that appears twice is an error.
- `TRK1` must be exactly `Σ_rounds players × samples × 15` bytes and `GRB1` exactly
  `Σ_grenades samples × 6` bytes. `TRK2`, when present, must follow `TRK1` and be exactly
  `Σ_rounds players × samples × 4` bytes.
- `ENT1` and `GND1` are optional: without them, there are no map entities, changes or ground
  items (every door at spawn, nothing on the ground). `GNB1` is required with `GND1`, must
  follow it, must be exactly `Σ_runs keys × 17` bytes, and holds only 0 or 1 in `gone`. A
  change's `round` and `entity` must be in range; a ground item's `round` must be in range
  and its `weapon` in `1..header.weapons.len()`. Changes must be sorted by
  `(round, entity, tick)` and ground items by `(round, id, tick)`.
- Without `TRK2`, `money`, `ammo` and `gear` are absent for every track; with it, present for
  every track. An `INV1` entry's round, player and item indices must be in range, and
  `post_end_tick`, when present, must not be before `end_tick`.
- The pack is also refused when `header.weapons[0] != "none"`, a `weapon` index is out of
  range, `team_by_round` has the wrong length, or a grenade `thrower` is neither a player
  index nor 255. The writer enforces the same rules, so it never produces a pack the reader
  rejects.
- Reading continues to end of stream, so the gzip CRC is always checked.

`TRK1`, `GRB1` and `GNB1` offsets are not aligned (they follow variable-length JSON), so read
them with `DataView.getInt16(offset, true)` (`getInt32` for `GNB1` ticks) or copy into a
fresh buffer before taking a typed-array view.
