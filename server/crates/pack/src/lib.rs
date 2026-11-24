//! DVPK replay pack format: types, writer and reader.
//!
//! The byte layout is specified in `docs/pack.md` at the repository root.

mod format;
mod read;
mod types;
mod write;

pub use read::read;
pub use types::{
    flags, gear, quant, sample_tick, Event, GrenadeTrack, GroundItem, InventoryChange, MapEntity,
    MapEntityChange, MapEntityKind, Match, MatchHeader, PlayerInfo, PlayerRank, PlayerTrack,
    RoundInfo, RoundTracks, PACK_VERSION,
};
pub use write::{write, write_limited, MAX_PACK_BYTES};
