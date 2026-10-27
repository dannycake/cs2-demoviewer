//! demoviewer patch: doors, breakables, weapons and other physics props in the world, as
//! change records (`ParserInputs::parse_world_entities`).
//!
//! The decode loop feeds every field of a tracked entity to [`WorldEntities::observe`],
//! baselines included and whether or not the prop controller wants the field; entity
//! creation calls [`WorldEntities::create`] and the delete branch [`WorldEntities::delete`].
//! Once per tick, `collect_entities` calls [`SecondPassParser::collect_world_entities`],
//! which records each tracked entity whose state changed during the tick.

use crate::second_pass::collect_data::coord_from_cell;
use crate::second_pass::parser_settings::SecondPassParser;
use crate::second_pass::path_ops::FieldPath;
use crate::second_pass::variants::Variant;
use ahash::AHashMap;
use csgoproto::maps::WEAPINDICIES;

/// `m_hOwnerEntity` of an entity nobody owns.
pub const NO_OWNER: u32 = 0x00FF_FFFF;

/// What a tracked entity is, from its class name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorldKind {
    Door,
    Breakable,
    Weapon,
    AnimGraph,
}

/// Weapon classes whose names do not start with `CWeapon`.
const WEAPON_CLASSES: [&str; 8] = [
    "CAK47",
    "CDEagle",
    "CFlashbang",
    "CSmokeGrenade",
    "CHEGrenade",
    "CIncendiaryGrenade",
    "CMolotovGrenade",
    "CDecoyGrenade",
];

/// The kind of entity a class is, or `None` when it is not tracked: projectiles, the C4 and
/// knives are not.
pub fn world_kind(class: &str) -> Option<WorldKind> {
    if class.contains("Door") {
        Some(WorldKind::Door)
    } else if class == "CBreakable" {
        Some(WorldKind::Breakable)
    } else if class == "CBaseAnimGraph" {
        Some(WorldKind::AnimGraph)
    } else if class.starts_with("CWeapon") || WEAPON_CLASSES.contains(&class) {
        Some(WorldKind::Weapon)
    } else {
        None
    }
}

/// A tracked entity's state at `tick`, or its removal.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldEntityRecord {
    pub tick: i32,
    pub entity_id: i32,
    pub kind: WorldKind,
    /// World position; NaN until the demo has sent the entity's cell and offset on that axis.
    pub x: f32,
    pub y: f32,
    pub z: f32,
    /// `m_angRotation`: pitch, yaw, roll in degrees.
    pub angles: [f32; 3],
    /// `m_hOwnerEntity` as sent, [`NO_OWNER`] for none; `u32::MAX` until the demo sends it.
    pub owner: u32,
    pub item_def: Option<u32>,
    /// `item_def`'s display name (`csgoproto::maps::WEAPINDICIES`), when it has one.
    pub item_name: Option<&'static str>,
    /// The entity was removed at `tick`; the other fields are its last state.
    pub deleted: bool,
}

/// Which tracked value a field holds, from the last segment of its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    Cell(usize),
    Offset(usize),
    Angles,
    Owner,
    ItemDef,
    Untracked,
}

impl Slot {
    fn of(full_name: &str) -> Slot {
        match full_name.rsplit('.').next().unwrap_or_default() {
            "m_cellX" => Slot::Cell(0),
            "m_cellY" => Slot::Cell(1),
            "m_cellZ" => Slot::Cell(2),
            "m_vecX" => Slot::Offset(0),
            "m_vecY" => Slot::Offset(1),
            "m_vecZ" => Slot::Offset(2),
            "m_angRotation" => Slot::Angles,
            "m_hOwnerEntity" => Slot::Owner,
            "m_iItemDefinitionIndex" => Slot::ItemDef,
            _ => Slot::Untracked,
        }
    }
}

/// A field path as a map key: its entries up to `last`, the rest -1 (so `[0]` and `[0, 0]`
/// differ).
fn path_key(path: &FieldPath) -> [i32; 7] {
    let mut key = [-1; 7];
    let n = (path.last + 1).min(key.len());
    key[..n].copy_from_slice(&path.path[..n]);
    key
}

#[derive(Debug, Clone)]
struct State {
    kind: WorldKind,
    cell: [Option<u32>; 3],
    offset: [Option<f32>; 3],
    angles: [f32; 3],
    owner: u32,
    item_def: Option<u32>,
    /// Changed since the last record.
    changed: bool,
}

impl State {
    fn new(kind: WorldKind) -> Self {
        State {
            kind,
            cell: [None; 3],
            offset: [None; 3],
            angles: [0.0; 3],
            owner: u32::MAX,
            item_def: None,
            changed: true,
        }
    }

    /// Sets the field in `slot` to `value`; whether that changed anything.
    fn set(&mut self, slot: Slot, value: &Variant) -> bool {
        fn put<T: PartialEq>(field: &mut T, value: T) -> bool {
            let changed = *field != value;
            *field = value;
            changed
        }
        match (slot, value) {
            (Slot::Cell(i), Variant::U32(v)) => put(&mut self.cell[i], Some(*v)),
            // Bits, so that a NaN offset sent twice is no change.
            (Slot::Offset(i), Variant::F32(v)) => {
                let changed = self.offset[i].map(f32::to_bits) != Some(v.to_bits());
                self.offset[i] = Some(*v);
                changed
            }
            (Slot::Angles, Variant::VecXYZ(v)) => {
                let changed = self.angles.map(f32::to_bits) != v.map(f32::to_bits);
                self.angles = *v;
                changed
            }
            (Slot::Owner, Variant::U32(v)) => put(&mut self.owner, *v),
            (Slot::ItemDef, Variant::U32(v)) => put(&mut self.item_def, Some(*v)),
            _ => false,
        }
    }

    fn record(&self, tick: i32, entity_id: i32, deleted: bool) -> WorldEntityRecord {
        let axis = |i: usize| match (self.cell[i], self.offset[i]) {
            (Some(cell), Some(offset)) => coord_from_cell(Ok(Variant::U32(cell)), Ok(Variant::F32(offset))).unwrap_or(f32::NAN),
            _ => f32::NAN,
        };
        WorldEntityRecord {
            tick,
            entity_id,
            kind: self.kind,
            x: axis(0),
            y: axis(1),
            z: axis(2),
            angles: self.angles,
            owner: self.owner,
            item_def: self.item_def,
            item_name: self.item_def.and_then(|d| WEAPINDICIES.get(&d).copied()),
            deleted,
        }
    }
}

/// Per-pass state of the tracked entities, and the records collected so far.
#[derive(Debug, Default)]
pub struct WorldEntities {
    /// By class id; empty when the table is off.
    kinds: Vec<Option<WorldKind>>,
    /// By class id and field path, filled on first sight.
    slots: AHashMap<(u32, [i32; 7]), Slot>,
    states: AHashMap<i32, State>,
    /// Entities changed since the last `collect`, in the order they first changed.
    changed: Vec<i32>,
    pub records: Vec<WorldEntityRecord>,
}

impl WorldEntities {
    /// A table for classes named `classes`, in class id order; tracks nothing unless `enabled`.
    pub fn new<'c>(enabled: bool, classes: impl Iterator<Item = &'c str>) -> Self {
        WorldEntities {
            kinds: if enabled { classes.map(world_kind).collect() } else { Vec::new() },
            ..WorldEntities::default()
        }
    }

    /// The kind of entity class `cls_id` is, or `None` when untracked (or the table is off).
    #[inline]
    pub fn kind(&self, cls_id: u32) -> Option<WorldKind> {
        self.kinds.get(cls_id as usize).copied().flatten()
    }

    /// A new entity of class `cls_id` at `entity_id` at `tick`. One that replaces a tracked
    /// entity removes it: the demo reuses a slot without a delete (each round's clean-up
    /// creates the map's entities in the slots of the weapons and kits left lying).
    pub fn create(&mut self, entity_id: i32, cls_id: u32, tick: i32) {
        self.delete(entity_id, tick);
        if let Some(kind) = self.kind(cls_id) {
            self.states.insert(entity_id, State::new(kind));
            self.changed.push(entity_id);
        }
    }

    /// Field `full_name` (at `path` in class `cls_id`) of entity `entity_id` decoded as `value`.
    pub fn observe(&mut self, cls_id: u32, entity_id: i32, path: &FieldPath, full_name: &str, value: &Variant) {
        let Some(state) = self.states.get_mut(&entity_id) else {
            return;
        };
        let slot = *self.slots.entry((cls_id, path_key(path))).or_insert_with(|| Slot::of(full_name));
        if state.set(slot, value) && !state.changed {
            state.changed = true;
            self.changed.push(entity_id);
        }
    }

    /// Entity `entity_id` was removed at `tick`.
    pub fn delete(&mut self, entity_id: i32, tick: i32) {
        if let Some(state) = self.states.remove(&entity_id) {
            self.records.push(state.record(tick, entity_id, true));
        }
    }

    /// Records every tracked entity whose state changed since the last call, at `tick`.
    pub fn collect(&mut self, tick: i32) {
        for &entity_id in &self.changed {
            if let Some(state) = self.states.get_mut(&entity_id) {
                if state.changed {
                    state.changed = false;
                    self.records.push(state.record(tick, entity_id, false));
                }
            }
        }
        self.changed.clear();
    }
}

impl<'a> SecondPassParser<'a> {
    pub fn collect_world_entities(&mut self) {
        self.world_entities.collect(self.tick);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn world_kind_tracks_doors_breakables_weapons_and_anim_graphs_only() {
        assert_eq!(world_kind("CAK47"), Some(WorldKind::Weapon));
        assert_eq!(world_kind("CWeaponM4A1"), Some(WorldKind::Weapon));
        assert_eq!(world_kind("CFlashbang"), Some(WorldKind::Weapon));
        assert_eq!(world_kind("CSmokeGrenadeProjectile"), None);
        assert_eq!(world_kind("CC4"), None);
        assert_eq!(world_kind("CKnife"), None);
        assert_eq!(world_kind("CPropDoorRotating"), Some(WorldKind::Door));
        assert_eq!(world_kind("CBreakable"), Some(WorldKind::Breakable));
        assert_eq!(world_kind("CBaseAnimGraph"), Some(WorldKind::AnimGraph));
    }

    fn path(i: i32) -> FieldPath {
        FieldPath {
            path: [i, 0, 0, 0, 0, 0, 0],
            last: 0,
        }
    }

    const CELL_X: &str = "CAK47.CBodyComponentBaseAnimGraph.m_cellX";
    const CELL_Y: &str = "CAK47.CBodyComponentBaseAnimGraph.m_cellY";
    const CELL_Z: &str = "CAK47.CBodyComponentBaseAnimGraph.m_cellZ";
    const VEC_X: &str = "CAK47.CBodyComponentBaseAnimGraph.m_vecX";
    const VEC_Y: &str = "CAK47.CBodyComponentBaseAnimGraph.m_vecY";
    const VEC_Z: &str = "CAK47.CBodyComponentBaseAnimGraph.m_vecZ";
    const ANGLES: &str = "CAK47.CBodyComponentBaseAnimGraph.m_angRotation";
    const OWNER: &str = "CAK47.m_hOwnerEntity";
    const ITEM_DEF: &str = "CAK47.m_AttributeManager.m_Item.m_iItemDefinitionIndex";
    const CLIP: &str = "CAK47.m_iClip1";

    #[test]
    fn world_entities_table_records_each_change_once_and_each_delete() {
        let mut w = WorldEntities::new(true, ["CCSPlayerPawn", "CAK47"].into_iter());
        assert_eq!(w.kind(0), None);
        assert_eq!(w.kind(1), Some(WorldKind::Weapon));
        assert_eq!(w.kind(2), None, "an unknown class id");

        w.create(5, 1, 99);
        for (i, (name, value)) in [
            (CELL_X, Variant::U32(33)),
            (CELL_Y, Variant::U32(30)),
            (CELL_Z, Variant::U32(32)),
            (VEC_X, Variant::F32(1.5)),
            (VEC_Y, Variant::F32(-2.0)),
            (VEC_Z, Variant::F32(64.0)),
            (ANGLES, Variant::VecXYZ([0.0, 90.0, 0.0])),
            (OWNER, Variant::U32(NO_OWNER)),
            (ITEM_DEF, Variant::U32(7)),
            (CLIP, Variant::U32(30)),
        ]
        .iter()
        .enumerate()
        {
            w.observe(1, 5, &path(i as i32), name, value);
        }
        w.collect(100);
        assert_eq!(
            w.records,
            [WorldEntityRecord {
                tick: 100,
                entity_id: 5,
                kind: WorldKind::Weapon,
                // cell · 512 − 16384 + offset
                x: 513.5,
                y: -1026.0,
                z: 64.0,
                angles: [0.0, 90.0, 0.0],
                owner: NO_OWNER,
                item_def: Some(7),
                item_name: Some("AK-47"),
                deleted: false,
            }]
        );

        // The same value again, or a field that is not tracked: nothing changed.
        w.observe(1, 5, &path(0), CELL_X, &Variant::U32(33));
        w.observe(1, 5, &path(9), CLIP, &Variant::U32(29));
        w.collect(101);
        assert_eq!(w.records.len(), 1);

        // Two changes in one tick: one record, with both.
        w.observe(1, 5, &path(5), VEC_Z, &Variant::F32(60.0));
        w.observe(1, 5, &path(7), OWNER, &Variant::U32(0x0004_0002));
        w.collect(102);
        assert_eq!(w.records.len(), 2);
        assert_eq!((w.records[1].tick, w.records[1].z, w.records[1].owner), (102, 60.0, 0x0004_0002));

        // A delete records the last state, removed.
        w.delete(5, 103);
        w.collect(103);
        assert_eq!(w.records.len(), 3);
        let last = &w.records[2];
        assert_eq!((last.tick, last.deleted, last.z), (103, true, 60.0));
        // Deleting an untracked entity records nothing.
        w.delete(6, 104);
        assert_eq!(w.records.len(), 3);

        // A new entity starts with no position and an unknown owner.
        w.create(5, 1, 105);
        w.collect(105);
        let fresh = &w.records[3];
        assert!(fresh.x.is_nan() && fresh.y.is_nan() && fresh.z.is_nan());
        assert_eq!((fresh.owner, fresh.item_def, fresh.deleted), (u32::MAX, None, false));

        // A tracked entity created over another one, or an untracked one created over it,
        // removes it.
        w.create(5, 1, 106);
        w.collect(106);
        assert_eq!(w.records.len(), 6);
        assert_eq!((w.records[4].tick, w.records[4].deleted), (106, true));
        assert_eq!((w.records[5].tick, w.records[5].deleted), (106, false));
        w.create(5, 0, 107);
        w.collect(107);
        assert_eq!(w.records.len(), 7);
        assert_eq!((w.records[6].tick, w.records[6].deleted), (107, true));
        w.observe(0, 5, &path(0), CELL_X, &Variant::U32(40));
        w.collect(108);
        assert_eq!(w.records.len(), 7, "an untracked entity records nothing");
    }

    #[test]
    fn a_disabled_table_tracks_nothing() {
        let mut w = WorldEntities::new(false, ["CAK47"].into_iter());
        assert_eq!(w.kind(0), None);
        w.create(5, 0, 100);
        w.observe(0, 5, &path(0), CELL_X, &Variant::U32(33));
        w.collect(100);
        w.delete(5, 101);
        assert!(w.records.is_empty());
    }
}
