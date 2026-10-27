//! Layout constants shared by the writer and reader.

use serde::{Deserialize, Serialize};

use crate::types::{GrenadeTrack, MapEntity, MapEntityChange};

pub(crate) const MAGIC: [u8; 4] = *b"DVPK";

pub(crate) const HDR1: [u8; 4] = *b"HDR1";
pub(crate) const TRK1: [u8; 4] = *b"TRK1";
pub(crate) const EVT1: [u8; 4] = *b"EVT1";
pub(crate) const GRN1: [u8; 4] = *b"GRN1";
pub(crate) const GRB1: [u8; 4] = *b"GRB1";
pub(crate) const TRK2: [u8; 4] = *b"TRK2";
pub(crate) const INV1: [u8; 4] = *b"INV1";
pub(crate) const ENT1: [u8; 4] = *b"ENT1";
pub(crate) const GND1: [u8; 4] = *b"GND1";
pub(crate) const GNB1: [u8; 4] = *b"GNB1";

/// Bytes per player sample in `TRK1`: five `i16` columns and five `u8` columns.
pub(crate) const TRACK_SAMPLE_BYTES: u64 = 5 * 2 + 5;
/// Bytes per player sample in `TRK2`: `money` as `u16`, `ammo` and `gear` as `u8`.
pub(crate) const TRACK2_SAMPLE_BYTES: u64 = 2 + 1 + 1;
/// Bytes per grenade sample in `GRB1`: `x`, `y`, `z` as `i16`.
pub(crate) const GRENADE_SAMPLE_BYTES: u64 = 3 * 2;
/// Bytes per ground key in `GNB1`: `tick` as `i32`; `x`, `y`, `z`, `pitch`, `yaw`, `roll` as
/// `i16`; `gone` as `u8`.
pub(crate) const GROUND_KEY_BYTES: u64 = 4 + 6 * 2 + 1;

/// One `GRN1` entry: a grenade without its samples.
#[derive(Serialize, Deserialize)]
pub(crate) struct GrenadeMeta {
    pub entity_id: i32,
    pub kind: String,
    pub thrower: u8,
    pub start_tick: i32,
    pub detonate_tick: Option<i32>,
    pub expire_tick: Option<i32>,
    pub samples: u32,
}

impl From<&GrenadeTrack> for GrenadeMeta {
    fn from(g: &GrenadeTrack) -> Self {
        GrenadeMeta {
            entity_id: g.entity_id,
            kind: g.kind.clone(),
            thrower: g.thrower,
            start_tick: g.start_tick,
            detonate_tick: g.detonate_tick,
            expire_tick: g.expire_tick,
            samples: g.x.len() as u32,
        }
    }
}

/// The `ENT1` payload, as written.
#[derive(Serialize)]
pub(crate) struct MapEntitiesRef<'a> {
    pub entities: &'a [MapEntity],
    pub changes: &'a [MapEntityChange],
}

/// The `ENT1` payload, as read.
#[derive(Default, Deserialize)]
pub(crate) struct MapEntities {
    pub entities: Vec<MapEntity>,
    pub changes: Vec<MapEntityChange>,
}

/// One `GND1` entry: a run of consecutive ground keys of one item, without the keys.
#[derive(Debug, Serialize, Deserialize)]
pub(crate) struct GroundRun {
    pub round: u16,
    pub id: u16,
    pub weapon: u8,
    pub keys: u32,
}
