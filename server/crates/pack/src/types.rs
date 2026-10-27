use serde::{Deserialize, Serialize};

/// Version written after the `DVPK` magic. Readers refuse any other value.
pub const PACK_VERSION: u16 = 1;

/// Everything the viewer needs about the match except the per-sample data.
/// Carried as JSON in the `HDR1` section.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchHeader {
    pub version: u16,
    pub map: String,
    pub server_name: String,
    pub game_build: String,
    pub tick_rate: u32,
    pub sample_hz: u32,
    pub tick_step: u32,
    pub players: Vec<PlayerInfo>,
    pub rounds: Vec<RoundInfo>,
    /// Weapon names indexed by `PlayerTrack::weapon`; entry 0 is always `"none"`.
    pub weapons: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PlayerInfo {
    /// Serialized as a decimal string: 64-bit steamids exceed JavaScript's safe-integer range.
    #[serde(with = "steamid_string")]
    pub steamid: u64,
    pub name: String,
    /// 2 = T, 3 = CT, 0 = unknown; `len == header.rounds.len()`.
    pub team_by_round: Vec<u8>,
    /// The player's crosshair share code (`CSGO-xxxxx-…`), the last one seen; absent in
    /// packs written before it existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub crosshair: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoundInfo {
    pub number: u16,
    pub start_tick: i32,
    pub freeze_end_tick: i32,
    pub end_tick: i32,
    /// 2 = T, 3 = CT, 0 = unknown.
    pub winner: u8,
    pub reason: String,
    /// Scores after this round.
    pub score_t: u8,
    pub score_ct: u8,
    /// Number of samples in every `PlayerTrack` of this round.
    pub samples: u32,
    /// Last tick of the round's play, after `end_tick` (the `round_end` event): the seconds
    /// before the next round starts, when the game goes on. The tracks cover it. Absent in
    /// packs written before it existed, which end at `end_tick`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub post_end_tick: Option<i32>,
}

/// One player's samples for one round; every `Vec` has `round.samples` entries.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PlayerTrack {
    pub x: Vec<i16>,
    pub y: Vec<i16>,
    pub z: Vec<i16>,
    /// Hundredths of a degree in (-18000, 18000].
    pub yaw: Vec<i16>,
    pub pitch: Vec<i16>,
    pub health: Vec<u8>,
    pub armor: Vec<u8>,
    /// Bit set of [`flags`].
    pub flags: Vec<u8>,
    /// `round(duck_amount · 255)`.
    pub duck: Vec<u8>,
    /// Index into `header.weapons`.
    pub weapon: Vec<u8>,
    /// Money; with `ammo` and `gear`, either empty (a pack without `TRK2`) or `samples` long.
    #[serde(default)]
    pub money: Vec<u16>,
    /// Rounds in the active weapon's magazine; [`gear::AMMO_NONE`] without one.
    #[serde(default)]
    pub ammo: Vec<u8>,
    /// Bit set of [`gear`]: helmet, defuse kit, zoom level.
    #[serde(default)]
    pub gear: Vec<u8>,
}

/// Tracks for one round, in `header.players` order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RoundTracks {
    pub players: Vec<PlayerTrack>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub tick: i32,
    pub kind: String,
    pub data: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GrenadeTrack {
    pub entity_id: i32,
    /// One of `smoke`, `flash`, `he`, `molotov`, `incendiary`, `decoy`.
    pub kind: String,
    /// Player index, or 255 when unknown.
    pub thrower: u8,
    pub start_tick: i32,
    pub detonate_tick: Option<i32>,
    pub expire_tick: Option<i32>,
    /// Samples every `header.tick_step` ticks from `start_tick`; `x`, `y`, `z` have equal length.
    pub x: Vec<i16>,
    pub y: Vec<i16>,
    pub z: Vec<i16>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Match {
    pub header: MatchHeader,
    /// Same order and length as `header.rounds`.
    pub rounds: Vec<RoundTracks>,
    pub events: Vec<Event>,
    pub grenades: Vec<GrenadeTrack>,
    /// Each player's inventory when a round starts and whenever it changes (`INV1`).
    #[serde(default)]
    pub inventory: Vec<InventoryChange>,
    /// The map's doors and breakables (`ENT1`), by spawn position.
    #[serde(default)]
    pub map_entities: Vec<MapEntity>,
    /// How `map_entities` move and break within each round (`ENT1`), sorted by
    /// `(round, entity, tick)`.
    #[serde(default)]
    pub map_changes: Vec<MapEntityChange>,
    /// Weapons and defuse kits lying in the world (`GND1` and `GNB1`), sorted by
    /// `(round, id, tick)`.
    #[serde(default)]
    pub ground: Vec<GroundItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MapEntityKind {
    Door,
    Breakable,
}

/// A door or breakable of the map, at its spawn position.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapEntity {
    pub kind: MapEntityKind,
    /// Spawn position, world units.
    pub x: i16,
    pub y: i16,
    pub z: i16,
}

/// A map entity's pose from `tick` on, within `round`: a key of its swing, or its break.
/// Before its first change in a round, an entity is at spawn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MapEntityChange {
    /// Index into `header.rounds`.
    pub round: u16,
    /// Index into `Match::map_entities`.
    pub entity: u16,
    pub tick: i32,
    /// Absolute angles, as [`quant::angle`].
    pub pitch: i16,
    pub yaw: i16,
    pub roll: i16,
    /// Broken: not drawn from `tick` to the round's end.
    pub gone: bool,
}

/// An item on the ground from `tick` on, within `round`: a key of its path, or its removal.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct GroundItem {
    /// Index into `header.rounds`.
    pub round: u16,
    /// The item's entity id: one item within a round.
    pub id: u16,
    /// Index into `header.weapons`, never 0.
    pub weapon: u8,
    pub tick: i32,
    /// World units.
    pub x: i16,
    pub y: i16,
    pub z: i16,
    /// As [`quant::angle`].
    pub pitch: i16,
    pub yaw: i16,
    pub roll: i16,
    /// Picked up or removed: not drawn from `tick` on, until a later key.
    pub gone: bool,
}

/// A player's inventory from `tick` on, within `round`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InventoryChange {
    /// Index into `header.rounds`.
    pub round: u16,
    /// Index into `header.players`.
    pub player: u8,
    pub tick: i32,
    /// Indices into `header.weapons`, in the game's order.
    pub items: Vec<u8>,
}

/// Bits of `PlayerTrack::gear`, and the magazine value for "no magazine".
pub mod gear {
    pub const HELMET: u8 = 1;
    pub const DEFUSE_KIT: u8 = 2;
    /// Zoom level (0, 1, 2) in bits 2–3.
    pub const ZOOM_SHIFT: u8 = 2;
    pub const ZOOM_MASK: u8 = 0b1100;
    pub const AMMO_NONE: u8 = 255;

    pub fn pack(helmet: bool, kit: bool, zoom: u8) -> u8 {
        ((helmet as u8) * HELMET) | ((kit as u8) * DEFUSE_KIT) | (zoom.min(3) << ZOOM_SHIFT)
    }
}

/// Bits of `PlayerTrack::flags`.
pub mod flags {
    pub const ALIVE: u8 = 1;
    pub const SCOPED: u8 = 2;
    pub const FLASHED: u8 = 4;
    pub const HAS_BOMB: u8 = 8;
    pub const DEFUSING: u8 = 16;
    pub const AIRBORNE: u8 = 32;
    pub const WALKING: u8 = 64;
}

/// Game tick of sample `k` of `round`.
pub fn sample_tick(round: &RoundInfo, header: &MatchHeader, k: u32) -> i32 {
    round.start_tick + (k * header.tick_step) as i32
}

/// Quantisation from game values to pack values, as specified in `docs/pack.md`.
pub mod quant {
    /// World units rounded to the nearest integer, saturating at the `i16` range; NaN → 0.
    pub fn position(units: f32) -> i16 {
        // `as` saturates and maps NaN to 0.
        units.round() as i16
    }

    /// Degrees normalised to (-180, 180], in hundredths of a degree; NaN/∞ → 0.
    pub fn angle(deg: f32) -> i16 {
        let mut d = (deg as f64).rem_euclid(360.0);
        if !d.is_finite() {
            return 0;
        }
        if d > 180.0 {
            d -= 360.0;
        }
        match (d * 100.0).round() as i16 {
            -18000 => 18000,
            q => q,
        }
    }

    /// `round(amount · 255)` clamped to 0..=255; NaN → 0.
    pub fn duck(amount: f32) -> u8 {
        (amount * 255.0).round() as u8
    }
}

mod steamid_string {
    use serde::{de, Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(id: &u64, s: S) -> Result<S::Ok, S::Error> {
        s.collect_str(id)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        String::deserialize(d)?.parse().map_err(de::Error::custom)
    }
}

/// Internal consistency rules shared by the writer (refuses to write) and reader (refuses to load).
pub(crate) fn validate(m: &Match) -> Result<(), String> {
    let h = &m.header;
    if h.version != PACK_VERSION {
        return Err(format!("header.version {} != {PACK_VERSION}", h.version));
    }
    if h.tick_step == 0 {
        return Err("header.tick_step is 0".into());
    }
    if h.weapons.first().map(String::as_str) != Some("none") {
        return Err("header.weapons[0] must be \"none\"".into());
    }
    if h.weapons.len() > 256 {
        return Err(format!(
            "{} weapons; a u8 index addresses at most 256",
            h.weapons.len()
        ));
    }
    if m.rounds.len() != h.rounds.len() {
        return Err(format!(
            "{} round tracks for {} rounds",
            m.rounds.len(),
            h.rounds.len()
        ));
    }
    for (i, p) in h.players.iter().enumerate() {
        if p.team_by_round.len() != h.rounds.len() {
            return Err(format!(
                "player {i}: team_by_round has {} entries for {} rounds",
                p.team_by_round.len(),
                h.rounds.len()
            ));
        }
    }
    // Money, ammo and gear are all present (TRK2) or all absent, for every track.
    let has_extra = m
        .rounds
        .iter()
        .flat_map(|r| &r.players)
        .any(|t| !t.money.is_empty() || !t.ammo.is_empty() || !t.gear.is_empty());
    for (r, info) in h.rounds.iter().enumerate() {
        if let Some(post) = info.post_end_tick {
            if post < info.end_tick {
                return Err(format!(
                    "round {r}: post_end_tick {post} before end_tick {}",
                    info.end_tick
                ));
            }
        }
    }
    for (i, c) in m.inventory.iter().enumerate() {
        if c.round as usize >= h.rounds.len() || c.player as usize >= h.players.len() {
            return Err(format!(
                "inventory {i}: round {} player {} out of range",
                c.round, c.player
            ));
        }
        if let Some(w) = c.items.iter().find(|&&w| w as usize >= h.weapons.len()) {
            return Err(format!(
                "inventory {i}: weapon index {w} out of {} weapons",
                h.weapons.len()
            ));
        }
    }
    for (r, (info, tracks)) in h.rounds.iter().zip(&m.rounds).enumerate() {
        if tracks.players.len() != h.players.len() {
            return Err(format!(
                "round {r}: {} tracks for {} players",
                tracks.players.len(),
                h.players.len()
            ));
        }
        let n = info.samples as usize;
        for (p, t) in tracks.players.iter().enumerate() {
            let lens = [
                ("x", t.x.len()),
                ("y", t.y.len()),
                ("z", t.z.len()),
                ("yaw", t.yaw.len()),
                ("pitch", t.pitch.len()),
                ("health", t.health.len()),
                ("armor", t.armor.len()),
                ("flags", t.flags.len()),
                ("duck", t.duck.len()),
                ("weapon", t.weapon.len()),
            ];
            if let Some((name, len)) = lens.iter().find(|(_, len)| *len != n) {
                return Err(format!(
                    "round {r} player {p}: {name} has {len} samples, round has {n}"
                ));
            }
            let extra = [
                ("money", t.money.len()),
                ("ammo", t.ammo.len()),
                ("gear", t.gear.len()),
            ];
            let want = if has_extra { n } else { 0 };
            if let Some((name, len)) = extra.iter().find(|(_, len)| *len != want) {
                return Err(format!(
                    "round {r} player {p}: {name} has {len} samples, expected {want}"
                ));
            }
            if let Some(w) = t.weapon.iter().find(|&&w| w as usize >= h.weapons.len()) {
                return Err(format!(
                    "round {r} player {p}: weapon index {w} out of {} weapons",
                    h.weapons.len()
                ));
            }
        }
    }
    for (i, c) in m.map_changes.iter().enumerate() {
        if c.round as usize >= h.rounds.len() || c.entity as usize >= m.map_entities.len() {
            return Err(format!(
                "map change {i}: round {} entity {} out of range",
                c.round, c.entity
            ));
        }
    }
    let change_key = |c: &MapEntityChange| (c.round, c.entity, c.tick);
    if let Some(i) = m
        .map_changes
        .windows(2)
        .position(|w| change_key(&w[0]) > change_key(&w[1]))
    {
        return Err(format!("map changes {i} and {} out of order", i + 1));
    }
    for (i, g) in m.ground.iter().enumerate() {
        if g.round as usize >= h.rounds.len() {
            return Err(format!("ground item {i}: round {} out of range", g.round));
        }
        if g.weapon == 0 || g.weapon as usize >= h.weapons.len() {
            return Err(format!(
                "ground item {i}: weapon index {} not in 1..{}",
                g.weapon,
                h.weapons.len()
            ));
        }
    }
    let ground_key = |g: &GroundItem| (g.round, g.id, g.tick);
    if let Some(i) = m
        .ground
        .windows(2)
        .position(|w| ground_key(&w[0]) > ground_key(&w[1]))
    {
        return Err(format!("ground items {i} and {} out of order", i + 1));
    }
    for (i, g) in m.grenades.iter().enumerate() {
        if g.y.len() != g.x.len() || g.z.len() != g.x.len() {
            return Err(format!(
                "grenade {i}: x/y/z lengths {}/{}/{} differ",
                g.x.len(),
                g.y.len(),
                g.z.len()
            ));
        }
        if g.thrower != 255 && g.thrower as usize >= h.players.len() {
            return Err(format!(
                "grenade {i}: thrower {} out of {} players",
                g.thrower,
                h.players.len()
            ));
        }
    }
    Ok(())
}
