//! Doors, breakables and items on the ground, from the parser's world-entity records
//! (`parser::second_pass::world_entities`).
//!
//! A door or a breakable is one map entity however often the demo creates it again (each
//! round's clean-up does, under new entity ids): it is known by its spawn position. A door
//! becomes keys of its swings, a breakable a `gone` change when it breaks. A weapon nobody
//! owns, and a defuse kit, becomes a ground item: keys of its path from where it lands, and a
//! `gone` key when it is picked up or removed. Everything is per round: a round starts with
//! every breakable whole and nothing on the ground, except what the demo shows otherwise at
//! the round's start (a key at `start_tick`); every door has a key at `start_tick`, since a
//! demo can start with a door open.

use ahash::AHashMap;
use demoviewer_pack::{quant, GroundItem, MapEntity, MapEntityChange, MapEntityKind, RoundInfo};
use parser::second_pass::world_entities::{WorldEntityRecord, WorldKind, NO_OWNER};

use super::tracks::Weapons;

/// Door keys follow a swing to half a degree (doors turn in place).
const DOOR_TOL: (f32, f32) = (1.0, 0.5);
/// Ground item keys follow a path to a unit and two degrees.
const GROUND_TOL: (f32, f32) = (1.0, 2.0);
/// A breakable removed and created again at its spot within this many ticks was cleaned up,
/// not broken.
const RECREATED_TICKS: i32 = 8;
/// A defuse kit appears within this many ticks of its carrier's death…
const KIT_TICKS: i32 = 64;
/// …and this many units of where they died.
const KIT_UNITS: f32 = 128.0;
/// `simplify` keeps a sample at least this often, which bounds its work on a long straight
/// path to linear.
const MAX_SPAN: usize = 512;

/// What the pack carries about the world beside the players: `ENT1` and `GND1`.
#[derive(Debug, Default, PartialEq)]
pub(super) struct World {
    pub entities: Vec<MapEntity>,
    pub changes: Vec<MapEntityChange>,
    pub ground: Vec<GroundItem>,
}

/// A pose: `x, y, z` in units, then `pitch, yaw, roll` in degrees.
type Pose = [f32; 6];

/// Where a door or breakable spawned, in pack units, and what it is: one map entity.
type Spot = (i16, i16, i16, u8);

fn pose(r: &WorldEntityRecord) -> Pose {
    [r.x, r.y, r.z, r.angles[0], r.angles[1], r.angles[2]]
}

fn has_position(r: &WorldEntityRecord) -> bool {
    r.x.is_finite() && r.y.is_finite() && r.z.is_finite()
}

/// Two records of one entity carry the same state (`tick` aside).
fn same_state(a: &WorldEntityRecord, b: &WorldEntityRecord) -> bool {
    let bits = |r: &WorldEntityRecord| pose(r).map(f32::to_bits);
    a.kind == b.kind
        && bits(a) == bits(b)
        && a.owner == b.owner
        && a.item_def == b.item_def
        && a.item_name == b.item_name
        && a.deleted == b.deleted
}

/// One entity from its creation to its removal: an entity id's records in between, in tick
/// order, without repeats of the same state.
struct Instance {
    kind: WorldKind,
    records: Vec<WorldEntityRecord>,
}

impl Instance {
    fn created(&self) -> i32 {
        self.records[0].tick
    }

    fn removed(&self) -> Option<&WorldEntityRecord> {
        self.records.last().filter(|r| r.deleted)
    }

    /// Its first known position.
    fn spawn(&self) -> Option<[f32; 3]> {
        self.records
            .iter()
            .find(|r| has_position(r))
            .map(|r| [r.x, r.y, r.z])
    }

    fn spot(&self) -> Option<Spot> {
        let rank = match self.kind {
            WorldKind::Door => 0,
            WorldKind::Breakable => 1,
            _ => return None,
        };
        let [x, y, z] = self.spawn()?;
        Some((
            quant::position(x),
            quant::position(y),
            quant::position(z),
            rank,
        ))
    }
}

/// The records as instances, in order of creation. A record identical to its entity's last
/// state is dropped: every full packet creates every entity again in the parser's parallel
/// parse. A record of another kind in an entity's slot ends that entity at its tick, removal
/// or not: the parallel parse misses a removal that falls between two threads.
fn instances(records: &[WorldEntityRecord]) -> Vec<Instance> {
    let mut sorted: Vec<&WorldEntityRecord> = records.iter().collect();
    sorted.sort_by_key(|r| (r.tick, r.entity_id));
    let mut out: Vec<Instance> = Vec::new();
    let mut open: AHashMap<i32, usize> = AHashMap::default();
    for r in sorted {
        if let Some(&i) = open.get(&r.entity_id) {
            if out[i].kind != r.kind {
                let last = &out[i].records[out[i].records.len() - 1];
                let end = WorldEntityRecord {
                    tick: r.tick,
                    deleted: true,
                    ..last.clone()
                };
                out[i].records.push(end);
                open.remove(&r.entity_id);
            }
        }
        match open.get(&r.entity_id).copied() {
            Some(i) => {
                let inst = &mut out[i];
                if !same_state(&inst.records[inst.records.len() - 1], r) {
                    inst.records.push(r.clone());
                }
                if r.deleted {
                    open.remove(&r.entity_id);
                }
            }
            // A removal of nothing known.
            None if r.deleted => {}
            None => {
                open.insert(r.entity_id, out.len());
                out.push(Instance {
                    kind: r.kind,
                    records: vec![r.clone()],
                });
            }
        }
    }
    out
}

/// The last tick of a round's play.
fn play_end(round: &RoundInfo) -> i32 {
    round.post_end_tick.unwrap_or(round.end_tick)
}

/// The round whose play holds `tick`.
fn round_at(rounds: &[RoundInfo], tick: i32) -> Option<usize> {
    let i = rounds
        .partition_point(|r| r.start_tick <= tick)
        .checked_sub(1)?;
    (tick <= play_end(&rounds[i])).then_some(i)
}

/// Samples of a pose, with a hold inserted before each sample that follows a gap: the demo
/// sends nothing while an entity stands still. Angles are unwrapped as they come.
#[derive(Default)]
struct Series {
    ticks: Vec<i32>,
    poses: Vec<Pose>,
}

impl Series {
    fn push(&mut self, tick: i32, mut p: Pose) {
        if self.ticks.last().is_some_and(|&t| t >= tick) {
            self.ticks.pop();
            self.poses.pop();
        }
        if let (Some(&last_tick), Some(&last)) = (self.ticks.last(), self.poses.last()) {
            if tick - 1 > last_tick {
                self.ticks.push(tick - 1);
                self.poses.push(last);
            }
            for k in 3..6 {
                p[k] -= 360.0 * ((p[k] - last[k]) / 360.0).round();
            }
        }
        self.ticks.push(tick);
        self.poses.push(p);
    }

    fn is_empty(&self) -> bool {
        self.ticks.is_empty()
    }

    /// The samples `simplify` keeps; a last key that repeats the one before is dropped, since
    /// a pose holds after its last key.
    fn keys(&self, (tol_pos, tol_ang): (f32, f32)) -> Vec<(i32, Pose)> {
        let mut keys: Vec<(i32, Pose)> = simplify(&self.ticks, &self.poses, tol_pos, tol_ang)
            .into_iter()
            .map(|i| (self.ticks[i], self.poses[i]))
            .collect();
        while keys.len() >= 2 && packed(&keys[keys.len() - 1].1) == packed(&keys[keys.len() - 2].1)
        {
            keys.pop();
        }
        keys
    }
}

/// A pose as the pack stores it.
fn packed(p: &Pose) -> [i16; 6] {
    [
        quant::position(p[0]),
        quant::position(p[1]),
        quant::position(p[2]),
        quant::angle(p[3]),
        quant::angle(p[4]),
        quant::angle(p[5]),
    ]
}

/// One round of a timeline of `(tick, pose)`, `None` while hidden: the pose at the round's
/// start, then each change within its play.
fn round_of<'t>(
    timeline: &'t [(i32, Option<Pose>)],
    round: &RoundInfo,
) -> (Option<Pose>, &'t [(i32, Option<Pose>)]) {
    let from = timeline.partition_point(|s| s.0 <= round.start_tick);
    let to = timeline.partition_point(|s| s.0 <= play_end(round));
    let start = from.checked_sub(1).and_then(|i| timeline[i].1);
    (start, &timeline[from..to.max(from)])
}

fn change(round: usize, entity: u16, tick: i32, p: &Pose, gone: bool) -> MapEntityChange {
    let q = packed(p);
    MapEntityChange {
        round: round as u16,
        entity,
        tick,
        pitch: q[3],
        yaw: q[4],
        roll: q[5],
        gone,
    }
}

/// A door's keys in each round: its angles at the round's start, then its swings. A door's
/// first record is no closed spawn (a demo can start with a door open), so every round
/// states where its doors start. Before its first record a door is as that record shows it.
fn door_changes(
    entity: u16,
    timeline: &[(i32, Option<Pose>)],
    rounds: &[RoundInfo],
    out: &mut Vec<MapEntityChange>,
) {
    let Some(first) = timeline.first().and_then(|s| s.1) else {
        return;
    };
    for (r, round) in rounds.iter().enumerate() {
        let (start, changes) = round_of(timeline, round);
        let mut series = Series::default();
        series.push(round.start_tick, start.unwrap_or(first));
        for &(tick, p) in changes {
            if let Some(p) = p {
                series.push(tick, p);
            }
        }
        for (tick, p) in series.keys(DOOR_TOL) {
            out.push(change(r, entity, tick, &p, false));
        }
    }
}

/// A ground item: what it is and when it lies where.
struct GroundTrack {
    id: u16,
    name: &'static str,
    timeline: Vec<(i32, Option<Pose>)>,
}

/// A weapon is on the ground while nobody owns it and it has a position and a known item.
/// The first records after its owner clears can still carry the position it had while held
/// (relative to its holder); those are skipped until the position changes.
fn weapon_track(inst: &Instance) -> Option<GroundTrack> {
    let mut name = None;
    let mut timeline = Vec::with_capacity(inst.records.len());
    let mut held_at: Option<[f32; 3]> = None;
    let mut stale: Option<[f32; 3]> = None;
    let mut was_free = false;
    for r in &inst.records {
        let at = [r.x, r.y, r.z];
        let free = !r.deleted && r.owner == NO_OWNER;
        if free && !was_free {
            stale = held_at;
        }
        was_free = free;
        if !r.deleted && r.owner != NO_OWNER && r.owner != u32::MAX {
            held_at = Some(at);
        }
        let moved = stale.is_none_or(|s| s.map(f32::to_bits) != at.map(f32::to_bits));
        let visible = free && has_position(r) && r.item_name.is_some() && moved;
        if visible {
            stale = None;
            name = name.or(r.item_name);
        }
        timeline.push((r.tick, visible.then(|| pose(r))));
    }
    Some(GroundTrack {
        id: u16::try_from(inst.records[0].entity_id).ok()?,
        name: name?,
        timeline,
    })
}

/// A physics prop is a defuse kit when it appears near a kit carrier's death, shortly after.
fn kit_track(inst: &Instance, kit_drops: &[(i32, [f32; 3])]) -> Option<GroundTrack> {
    let at = inst.spawn()?;
    let created = inst.created();
    let near = |d: [f32; 3]| {
        let (dx, dy, dz) = (at[0] - d[0], at[1] - d[1], at[2] - d[2]);
        (dx * dx + dy * dy + dz * dz).sqrt() <= KIT_UNITS
    };
    if !kit_drops
        .iter()
        .any(|&(tick, d)| (0..=KIT_TICKS).contains(&(created - tick)) && near(d))
    {
        return None;
    }
    let timeline = inst
        .records
        .iter()
        .map(|r| (r.tick, (!r.deleted && has_position(r)).then(|| pose(r))))
        .collect();
    Some(GroundTrack {
        id: u16::try_from(inst.records[0].entity_id).ok()?,
        name: "defuser",
        timeline,
    })
}

fn ground_key(round: usize, id: u16, weapon: u8, tick: i32, p: &Pose, gone: bool) -> GroundItem {
    let q = packed(p);
    GroundItem {
        round: round as u16,
        id,
        weapon,
        tick,
        x: q[0],
        y: q[1],
        z: q[2],
        pitch: q[3],
        yaw: q[4],
        roll: q[5],
        gone,
    }
}

/// A ground item's keys in each round it lies in. Its weapon name joins `weapons` only when
/// it has a key; an item whose name gets no index (past 256 names) is left out.
fn ground_keys(
    track: &GroundTrack,
    rounds: &[RoundInfo],
    weapons: &mut Weapons,
    out: &mut Vec<GroundItem>,
) {
    let mut weapon = None;
    for (r, round) in rounds.iter().enumerate() {
        let (start, changes) = round_of(&track.timeline, round);
        if start.is_none() && !changes.iter().any(|s| s.1.is_some()) {
            continue;
        }
        let index = *weapon.get_or_insert_with(|| weapons.index(Some(track.name)));
        if index == 0 {
            return;
        }
        let mut series = Series::default();
        if let Some(p) = start {
            series.push(round.start_tick, p);
        }
        let mut emit = |series: &Series, gone: Option<i32>| {
            for (tick, p) in series.keys(GROUND_TOL) {
                out.push(ground_key(r, track.id, index, tick, &p, false));
            }
            if let (Some(tick), Some(last)) = (gone, series.poses.last()) {
                out.push(ground_key(r, track.id, index, tick, last, true));
            }
        };
        for &(tick, p) in changes {
            match p {
                Some(p) => series.push(tick, p),
                None if !series.is_empty() => {
                    emit(&series, Some(tick));
                    series = Series::default();
                }
                None => {}
            }
        }
        if !series.is_empty() {
            emit(&series, None);
        }
    }
}

/// Doors, breakables and items on the ground from `records` (in any order), within `rounds`.
/// `kit_drops` are where and when CTs carrying a defuse kit died; ground items' names join
/// `weapons`.
pub(super) fn build(
    records: &[WorldEntityRecord],
    rounds: &[RoundInfo],
    kit_drops: &[(i32, [f32; 3])],
    weapons: &mut Weapons,
) -> World {
    let instances = instances(records);

    // Map entities, in order of spawn position.
    let mut spots: Vec<Spot> = instances.iter().filter_map(Instance::spot).collect();
    spots.sort_unstable();
    spots.dedup();
    spots.truncate(usize::from(u16::MAX) + 1);
    let index: AHashMap<Spot, u16> = spots
        .iter()
        .enumerate()
        .map(|(i, &s)| (s, i as u16))
        .collect();
    let entities = spots
        .iter()
        .map(|&(x, y, z, rank)| MapEntity {
            kind: if rank == 0 {
                MapEntityKind::Door
            } else {
                MapEntityKind::Breakable
            },
            x,
            y,
            z,
        })
        .collect();

    let mut changes = Vec::new();
    let mut door_timelines: Vec<Vec<(i32, Option<Pose>)>> = vec![Vec::new(); spots.len()];
    let mut restored: AHashMap<Spot, Vec<i32>> = AHashMap::default();
    for inst in &instances {
        let Some(&entity) = inst.spot().and_then(|s| index.get(&s)) else {
            continue;
        };
        match inst.kind {
            WorldKind::Door => door_timelines[entity as usize].extend(
                inst.records
                    .iter()
                    .filter(|r| !r.deleted)
                    .map(|r| (r.tick, Some(pose(r)))),
            ),
            _ => restored
                .entry(spots[entity as usize])
                .or_default()
                .push(inst.created()),
        }
    }
    for (entity, timeline) in door_timelines.iter_mut().enumerate() {
        timeline.sort_by_key(|s| s.0);
        door_changes(entity as u16, timeline, rounds, &mut changes);
    }
    // A breakable breaks when it is removed before its round is decided and not created
    // again at its spot right after (a round's clean-up, or the demo's end).
    for inst in instances.iter().filter(|i| i.kind == WorldKind::Breakable) {
        let (Some(spot), Some(removed)) = (inst.spot(), inst.removed()) else {
            continue;
        };
        // A spot past the last index has no entity to break.
        let Some(&entity) = index.get(&spot) else {
            continue;
        };
        let Some(r) =
            round_at(rounds, removed.tick).filter(|&r| removed.tick <= rounds[r].end_tick)
        else {
            continue;
        };
        let cleaned_up = restored.get(&spot).is_some_and(|created| {
            created
                .iter()
                .any(|&t| (removed.tick..=removed.tick + RECREATED_TICKS).contains(&t))
        });
        if !cleaned_up {
            changes.push(change(r, entity, removed.tick, &pose(removed), true));
        }
    }
    changes.sort_by_key(|c| (c.round, c.entity, c.tick));

    let mut ground = Vec::new();
    for inst in &instances {
        let track = match inst.kind {
            WorldKind::Weapon => weapon_track(inst),
            WorldKind::AnimGraph => kit_track(inst, kit_drops),
            _ => None,
        };
        if let Some(track) = track {
            ground_keys(&track, rounds, weapons, &mut ground);
        }
    }
    ground.sort_by_key(|g| (g.round, g.id, g.tick));

    World {
        entities,
        changes,
        ground,
    }
}

/// The samples to keep of a path given at `ticks` (positions in units, angles in degrees,
/// unwrapped): the first and the last, and, walking forward from the last kept sample, the
/// sample before the first one at which linear interpolation from the last kept sample
/// misses an intermediate sample by more than `tol_pos` or `tol_ang`. Also the sample before
/// an angle would turn 180° or more from the last kept sample (the viewer turns between keys
/// the shorter way round), and at least every [`MAX_SPAN`] samples.
pub(super) fn simplify(
    ticks: &[i32],
    values: &[[f32; 6]],
    tol_pos: f32,
    tol_ang: f32,
) -> Vec<usize> {
    let n = ticks.len().min(values.len());
    if n == 0 {
        return Vec::new();
    }
    let misses = |from: usize, to: usize, i: usize| {
        let (t0, t1) = (ticks[from] as f64, ticks[to] as f64);
        let f = if t1 > t0 {
            (ticks[i] as f64 - t0) / (t1 - t0)
        } else {
            0.0
        };
        (0..6).any(|k| {
            let (a, b) = (values[from][k] as f64, values[to][k] as f64);
            let tol = if k < 3 { tol_pos } else { tol_ang };
            let miss = (values[i][k] as f64 - (a + (b - a) * f)).abs();
            // NaN never fits.
            miss.is_nan() || miss > tol as f64
        })
    };
    let half_turn =
        |from: usize, to: usize| (3..6).any(|k| (values[to][k] - values[from][k]).abs() >= 180.0);
    let mut kept = vec![0];
    let mut anchor = 0;
    let mut to = 2;
    while to < n {
        if to - anchor > MAX_SPAN
            || half_turn(anchor, to)
            || (anchor + 1..to).any(|i| misses(anchor, to, i))
        {
            anchor = to - 1;
            kept.push(anchor);
            to = anchor + 2;
        } else {
            to += 1;
        }
    }
    if n > 1 {
        kept.push(n - 1);
    }
    kept
}

#[cfg(test)]
mod tests {
    use super::*;
    use demoviewer_pack::MapEntityKind;
    use parser::second_pass::world_entities::{WorldKind, NO_OWNER};

    fn round(number: u16, start_tick: i32, end_tick: i32, post_end_tick: i32) -> RoundInfo {
        RoundInfo {
            number,
            start_tick,
            freeze_end_tick: start_tick + 1000,
            end_tick,
            winner: 2,
            reason: "t_killed".into(),
            score_t: number as u8,
            score_ct: 0,
            samples: 0,
            post_end_tick: Some(post_end_tick),
        }
    }

    fn rounds() -> Vec<RoundInfo> {
        vec![round(1, 1000, 6000, 6300), round(2, 7000, 12000, 12300)]
    }

    fn rec(
        tick: i32,
        id: i32,
        kind: WorldKind,
        pos: [f32; 3],
        angles: [f32; 3],
    ) -> WorldEntityRecord {
        WorldEntityRecord {
            tick,
            entity_id: id,
            kind,
            x: pos[0],
            y: pos[1],
            z: pos[2],
            angles,
            owner: NO_OWNER,
            item_def: None,
            item_name: None,
            deleted: false,
        }
    }

    fn deleted(r: WorldEntityRecord) -> WorldEntityRecord {
        WorldEntityRecord { deleted: true, ..r }
    }

    fn build_plain(records: &[WorldEntityRecord]) -> World {
        build(records, &rounds(), &[], &mut Weapons::new())
    }

    #[test]
    fn simplify_keeps_the_start_and_end_of_a_door_swing_and_the_last_sample() {
        // 0° to −87.5° at 3.125°/tick (28 ticks), then 30 still ticks.
        let ticks: Vec<i32> = (0..=58).collect();
        let swing = |end: f32| -> Vec<[f32; 6]> {
            (0..=59)
                .map(|t| [0.0, 0.0, 0.0, 0.0, (-3.125 * t as f32).max(end), 0.0])
                .collect()
        };
        assert_eq!(simplify(&ticks, &swing(-87.5)[..59], 1.0, 0.5), [0, 28, 58]);
        // The real swing to −90°: its last step is 2.5°, so the swing's end takes two keys.
        let ticks: Vec<i32> = (0..=59).collect();
        assert_eq!(simplify(&ticks, &swing(-90.0), 1.0, 0.5), [0, 28, 29, 59]);
    }

    #[test]
    fn simplify_of_a_constant_series_keeps_its_first_and_last_sample() {
        let ticks: Vec<i32> = (100..110).collect();
        let values = vec![[1.0, 2.0, 3.0, 0.0, 90.0, 0.0]; 10];
        assert_eq!(simplify(&ticks, &values, 1.0, 2.0), [0, 9]);
        assert_eq!(simplify(&ticks[..1], &values[..1], 1.0, 2.0), [0]);
        assert_eq!(simplify(&[], &[], 1.0, 2.0), Vec::<usize>::new());
    }

    #[test]
    fn simplify_interpolates_by_tick_within_each_tolerance() {
        // Linear in ticks, unevenly spaced: the middle sample is on the line.
        let at = |x: f32| [x, 0.0, 0.0, 0.0, 0.0, 0.0];
        assert_eq!(
            simplify(&[0, 1, 10], &[at(0.0), at(1.0), at(10.0)], 1.0, 2.0),
            [0, 2]
        );
        // A bump of 0.9 units passes a 1-unit tolerance; one of 1.5 is kept.
        let xs = |bump: f32| [at(0.0), at(0.0), at(bump), at(0.0), at(0.0)];
        assert_eq!(simplify(&[0, 1, 2, 3, 4], &xs(0.9), 1.0, 2.0), [0, 4]);
        assert_eq!(simplify(&[0, 1, 2, 3, 4], &xs(1.5), 1.0, 2.0), [0, 2, 4]);
        // Angles use their own tolerance: 1.5° passes 2°, not 1°.
        let yaw = |bump: f32| -> Vec<[f32; 6]> {
            [0.0, 0.0, bump, 0.0, 0.0]
                .iter()
                .map(|&y| [0.0, 0.0, 0.0, 0.0, y, 0.0])
                .collect()
        };
        assert_eq!(simplify(&[0, 1, 2, 3, 4], &yaw(1.5), 1.0, 2.0), [0, 4]);
        assert_eq!(simplify(&[0, 1, 2, 3, 4], &yaw(1.5), 1.0, 1.0), [0, 2, 4]);
    }

    #[test]
    fn simplify_keeps_keys_less_than_a_half_turn_apart() {
        // A steady spin of 10° a tick for 60 ticks: one line, but 600° long.
        let ticks: Vec<i32> = (0..=60).collect();
        let values: Vec<[f32; 6]> = ticks
            .iter()
            .map(|&t| [0.0, 0.0, 0.0, 0.0, 10.0 * t as f32, 0.0])
            .collect();
        let kept = simplify(&ticks, &values, 1.0, 2.0);
        assert_eq!(kept, [0, 17, 34, 51, 60]);
        for w in kept.windows(2) {
            assert!(values[w[1]][4] - values[w[0]][4] < 180.0);
        }
    }

    const DOOR: [f32; 3] = [257.0, -1310.0, -416.0];

    /// Door `id` swinging open from tick `from`: 3.125° a tick to −90°, in 29 ticks.
    fn door_swing(id: i32, from: i32) -> Vec<WorldEntityRecord> {
        (1..=29)
            .map(|k| {
                let yaw = (-3.125 * k as f32).max(-90.0);
                rec(from + k, id, WorldKind::Door, DOOR, [0.0, yaw, 0.0])
            })
            .collect()
    }

    /// `(round, entity, tick, yaw, gone)` of each change.
    fn keys(changes: &[MapEntityChange]) -> Vec<(u16, u16, i32, i16, bool)> {
        changes
            .iter()
            .map(|c| (c.round, c.entity, c.tick, c.yaw, c.gone))
            .collect()
    }

    #[test]
    fn a_door_swing_is_one_map_entity_with_the_keys_of_its_swing() {
        let mut records = vec![rec(500, 100, WorldKind::Door, DOOR, [0.0; 3])];
        records.extend(door_swing(100, 2000));
        let w = build_plain(&records);
        assert_eq!(
            w.entities,
            [MapEntity {
                kind: MapEntityKind::Door,
                x: 257,
                y: -1310,
                z: -416
            }]
        );
        assert_eq!(
            keys(&w.changes),
            [
                // Closed when round 0 starts and until 2000, then open at 2029.
                (0, 0, 1000, 0, false),
                (0, 0, 2000, 0, false),
                (0, 0, 2028, -8750, false),
                (0, 0, 2029, -9000, false),
                // Still open when round 1 starts.
                (1, 0, 7000, -9000, false),
            ]
        );
        assert!(w.ground.is_empty());
    }

    #[test]
    fn a_door_created_again_under_a_new_entity_id_keeps_its_index() {
        let mut records = vec![
            rec(500, 100, WorldKind::Door, DOOR, [0.0; 3]),
            rec(
                500,
                300,
                WorldKind::Breakable,
                [1414.5, -391.0, -341.0],
                [0.0; 3],
            ),
        ];
        records.extend(door_swing(100, 2000));
        // Round 1's clean-up removes the open door and creates it again, closed, under a new
        // id and a fraction of a unit off.
        records.push(deleted(rec(
            7000,
            100,
            WorldKind::Door,
            DOOR,
            [0.0, -90.0, 0.0],
        )));
        records.push(rec(
            7000,
            230,
            WorldKind::Door,
            [257.2, -1309.8, -416.1],
            [0.0; 3],
        ));
        records.extend(door_swing(230, 9000));
        let w = build_plain(&records);
        // In order of position: the door (x 257) before the breakable (x 1415).
        let kinds: Vec<(MapEntityKind, i16)> = w.entities.iter().map(|e| (e.kind, e.x)).collect();
        assert_eq!(
            kinds,
            [(MapEntityKind::Door, 257), (MapEntityKind::Breakable, 1415)]
        );
        assert_eq!(
            keys(&w.changes),
            [
                (0, 0, 1000, 0, false),
                (0, 0, 2000, 0, false),
                (0, 0, 2028, -8750, false),
                (0, 0, 2029, -9000, false),
                (1, 0, 7000, 0, false),
                (1, 0, 9000, 0, false),
                (1, 0, 9028, -8750, false),
                (1, 0, 9029, -9000, false),
            ]
        );
    }

    #[test]
    fn a_door_open_when_the_demo_starts_has_its_angles_at_each_rounds_start() {
        // Open from its first record on, and never moved: its first record is no closed spawn.
        let w = build_plain(&[rec(500, 100, WorldKind::Door, DOOR, [0.0, -90.0, 0.0])]);
        assert_eq!(
            keys(&w.changes),
            [(0, 0, 1000, -9000, false), (1, 0, 7000, -9000, false)]
        );
        // Closed in round 1 at 8000 and left so: round 1 starts open and swings shut.
        let mut records = vec![rec(500, 100, WorldKind::Door, DOOR, [0.0, -90.0, 0.0])];
        records.extend(
            door_swing(100, 8000)
                .into_iter()
                .map(|r| WorldEntityRecord {
                    angles: [0.0, -90.0 - r.angles[1], 0.0],
                    ..r
                }),
        );
        let w = build_plain(&records);
        let round_1: Vec<_> = keys(&w.changes).into_iter().filter(|k| k.0 == 1).collect();
        assert_eq!(round_1[0], (1, 0, 7000, -9000, false), "{round_1:?}");
        assert_eq!(
            round_1.last().unwrap(),
            &(1, 0, 8029, 0, false),
            "{round_1:?}"
        );
    }

    #[test]
    fn a_record_identical_to_the_entitys_last_state_adds_no_key() {
        let mut records = vec![rec(500, 100, WorldKind::Door, DOOR, [0.0; 3])];
        records.extend(door_swing(100, 2000));
        let before = build_plain(&records);
        // What a full packet sends again, 3,840 ticks later.
        records.push(rec(
            2029 + 3840,
            100,
            WorldKind::Door,
            DOOR,
            [0.0, -90.0, 0.0],
        ));
        assert_eq!(build_plain(&records), before);
    }

    #[test]
    fn a_breakable_is_gone_at_a_delete_inside_its_round_that_is_no_clean_up() {
        const PANE: [f32; 3] = [-863.03, -2508.18, -88.5];
        let pane = |tick, id| rec(tick, id, WorldKind::Breakable, PANE, [0.0; 3]);
        let changes = |records: &[WorldEntityRecord]| keys(&build_plain(records).changes);
        // Broken mid-round 0.
        assert_eq!(
            changes(&[pane(500, 300), deleted(pane(3000, 300))]),
            [(0, 0, 3000, 0, true)]
        );
        // Removed after round 0 was decided (its end_tick is 6000): not a break.
        assert!(changes(&[pane(500, 300), deleted(pane(6100, 300))]).is_empty());
        // Removed and created again 2 ticks later: a clean-up.
        assert!(changes(&[pane(500, 300), deleted(pane(3000, 300)), pane(3002, 301)]).is_empty());
        // Broken in round 0, back for round 1, broken again in round 1.
        assert_eq!(
            changes(&[
                pane(500, 300),
                deleted(pane(3000, 300)),
                pane(7000, 302),
                deleted(pane(9000, 302)),
            ]),
            [(0, 0, 3000, 0, true), (1, 0, 9000, 0, true)]
        );
    }

    #[test]
    fn a_break_of_an_entity_past_the_last_index_is_left_out() {
        // 65,536 panes take every index; one more, past them all in position order, breaks.
        let pane = |tick, id: i32, pos| rec(tick, id, WorldKind::Breakable, pos, [0.0; 3]);
        let mut records: Vec<WorldEntityRecord> = (0..65536)
            .map(|i| pane(500, i, [(i % 256) as f32, (i / 256) as f32, 0.0]))
            .collect();
        records.push(pane(500, 70000, [1000.0, 0.0, 0.0]));
        records.push(deleted(pane(3000, 70000, [1000.0, 0.0, 0.0])));
        records.push(deleted(pane(3000, 0, [0.0, 0.0, 0.0])));
        let w = build_plain(&records);
        assert_eq!(w.entities.len(), 65536);
        assert_eq!(keys(&w.changes), [(0, 0, 3000, 0, true)]);
    }

    fn ak(tick: i32, pos: [f32; 3], owner: u32) -> WorldEntityRecord {
        WorldEntityRecord {
            owner,
            item_def: Some(7),
            item_name: Some("AK-47"),
            ..rec(tick, 400, WorldKind::Weapon, pos, [0.0, 30.0, 0.0])
        }
    }

    /// An AK held from 1500, dropped at 3000 (the owner clears a tick before the position
    /// follows), falling in a straight line for 30 ticks.
    fn ak_drop() -> Vec<WorldEntityRecord> {
        let mut records = vec![
            ak(1500, [1.0, 2.0, 3.0], 0x0001_0002),
            ak(3000, [1.0, 2.0, 3.0], NO_OWNER),
        ];
        records.extend((1..=30).map(|k| {
            let k = k as f32;
            ak(
                3000 + k as i32,
                [500.0 + 2.0 * k, 600.0, 100.0 - 3.0 * k],
                NO_OWNER,
            )
        }));
        records
    }

    /// `(round, id, tick, x, y, z, gone)` of each ground key.
    fn ground_keys(ground: &[GroundItem]) -> Vec<(u16, u16, i32, i16, i16, i16, bool)> {
        ground
            .iter()
            .map(|g| (g.round, g.id, g.tick, g.x, g.y, g.z, g.gone))
            .collect()
    }

    #[test]
    fn a_dropped_weapon_lies_where_it_fell_until_picked_up() {
        let mut records = ak_drop();
        records.push(ak(4000, [560.0, 600.0, 10.0], 0x0002_0003));
        let mut weapons = Weapons::new();
        let w = build(&records, &rounds(), &[], &mut weapons);
        let names = weapons.into_names();
        let keys = ground_keys(&w.ground);
        let (gone, path): (Vec<_>, Vec<_>) = keys.iter().copied().partition(|k| k.6);
        assert!(path.len() <= 4, "{keys:?}");
        // From where it lands, never from where it was held.
        assert_eq!(path[0], (0, 400, 3001, 502, 600, 97, false));
        assert_eq!(path.last().unwrap(), &(0, 400, 3030, 560, 600, 10, false));
        assert_eq!(gone, [(0, 400, 4000, 560, 600, 10, true)]);
        assert!(w.ground.iter().all(|g| names[g.weapon as usize] == "AK-47"));
        assert!(w.ground.iter().all(|g| g.yaw == 3000 && g.pitch == 0));
        assert!(w.entities.is_empty() && w.changes.is_empty());
    }

    #[test]
    fn an_item_still_on_the_ground_when_a_round_starts_has_a_key_at_the_start() {
        let w = build_plain(&ak_drop());
        let starts: Vec<_> = ground_keys(&w.ground)
            .into_iter()
            .filter(|k| k.0 == 1)
            .collect();
        assert_eq!(starts, [(1, 400, 7000, 560, 600, 10, false)]);
        // Removed by round 1's clean-up: nothing in round 1, and no gone key in round 0.
        let mut records = ak_drop();
        records.push(deleted(ak(7000, [560.0, 600.0, 10.0], NO_OWNER)));
        let w = build_plain(&records);
        assert!(w.ground.iter().all(|g| g.round == 0 && !g.gone));
    }

    #[test]
    fn an_entity_id_taken_by_another_kind_without_a_delete_ends_the_old_entity() {
        // The parallel parse can miss a removal at a thread boundary: the next thread's full
        // packet creates a door in the slot of a gun lying on the ground.
        let mut records = ak_drop();
        records.push(rec(4000, 400, WorldKind::Door, DOOR, [0.0; 3]));
        let w = build_plain(&records);
        let keys = ground_keys(&w.ground);
        let gone: Vec<_> = keys.iter().copied().filter(|k| k.6).collect();
        assert_eq!(gone, [(0, 400, 4000, 560, 600, 10, true)], "{keys:?}");
        assert!(w.ground.iter().all(|g| g.round == 0), "{keys:?}");
        // The same with a removal of the new kind, never seen created.
        let mut records = ak_drop();
        records.push(deleted(rec(4000, 400, WorldKind::Door, DOOR, [0.0; 3])));
        let keys = ground_keys(&build_plain(&records).ground);
        assert_eq!(keys.last().unwrap(), &(0, 400, 4000, 560, 600, 10, true));
    }

    #[test]
    fn an_item_whose_name_gets_no_weapon_index_is_left_out() {
        // 256 names: `Weapons::index` gives a new name 0, which a ground item may not carry.
        let full = |with_ak: bool| {
            let mut weapons = Weapons::new();
            for i in 1..256 {
                let name = if with_ak && i == 200 {
                    "AK-47".to_string()
                } else {
                    format!("w{i}")
                };
                assert_eq!(weapons.index(Some(&name)), i as u8);
            }
            weapons
        };
        let kit_drops = [(2000, [100.0, 200.0, 0.0])];
        let kit = rec(
            2010,
            500,
            WorldKind::AnimGraph,
            [130.0, 240.0, 0.0],
            [0.0; 3],
        );
        let mut records = ak_drop();
        records.push(kit);
        let mut weapons = full(false);
        let w = build(&records, &rounds(), &kit_drops, &mut weapons);
        assert!(w.ground.is_empty(), "{:?}", ground_keys(&w.ground));
        assert_eq!(weapons.into_names().len(), 256);
        // A name already in the table keeps its index; the kit's new name is still left out.
        let mut weapons = full(true);
        let w = build(&records, &rounds(), &kit_drops, &mut weapons);
        assert!(!w.ground.is_empty());
        assert!(w.ground.iter().all(|g| g.id == 400 && g.weapon == 200));
        assert_eq!(weapons.into_names().len(), 256);
    }

    #[test]
    fn a_weapon_without_a_known_item_or_a_position_is_not_on_the_ground() {
        let mut records = ak_drop();
        for r in &mut records {
            r.item_name = None;
        }
        assert!(build_plain(&records).ground.is_empty());
        let mut records = ak_drop();
        for r in &mut records {
            r.z = f32::NAN;
        }
        assert!(build_plain(&records).ground.is_empty());
    }

    #[test]
    fn an_anim_graph_is_a_defuse_kit_only_near_a_kit_carriers_death() {
        let kit_drops = [(2000, [100.0, 200.0, 0.0])];
        let anim = |tick, id, pos| rec(tick, id, WorldKind::AnimGraph, pos, [0.0; 3]);
        let mut weapons = Weapons::new();
        // 10 ticks after the death, 50 units away; picked up at 2500.
        let records = [
            anim(2010, 500, [130.0, 240.0, 0.0]),
            deleted(anim(2500, 500, [130.0, 240.0, 0.0])),
        ];
        let w = build(&records, &rounds(), &kit_drops, &mut weapons);
        assert_eq!(
            ground_keys(&w.ground),
            [
                (0, 500, 2010, 130, 240, 0, false),
                (0, 500, 2500, 130, 240, 0, true)
            ]
        );
        assert_eq!(weapons.into_names()[w.ground[0].weapon as usize], "defuser");

        // 300 units away, or 100 ticks later: something else, and no name is added.
        let mut weapons = Weapons::new();
        for records in [
            [anim(2010, 501, [400.0, 200.0, 0.0])],
            [anim(2100, 502, [130.0, 240.0, 0.0])],
        ] {
            let w = build(&records, &rounds(), &kit_drops, &mut weapons);
            assert!(w.ground.is_empty());
        }
        assert_eq!(weapons.into_names(), ["none"]);
    }

    #[test]
    fn records_outside_every_round_make_no_keys_of_their_own() {
        // Warmup, before round 0: a door swing and a broken pane.
        let mut records = vec![rec(100, 100, WorldKind::Door, DOOR, [0.0; 3])];
        records.extend(door_swing(100, 200));
        records.extend(door_swing(100, 300).into_iter().map(|r| WorldEntityRecord {
            angles: [0.0, -90.0 - r.angles[1], 0.0],
            ..r
        }));
        let pane = [-863.0, -2508.0, -88.0];
        records.push(rec(100, 300, WorldKind::Breakable, pane, [0.0; 3]));
        records.push(deleted(rec(400, 300, WorldKind::Breakable, pane, [0.0; 3])));
        let w = build_plain(&records);
        assert_eq!(w.entities.len(), 2);
        // The door (after the pane, in position order) has only each round's start key:
        // closed, as warmup left it.
        assert_eq!(
            keys(&w.changes),
            [(0, 1, 1000, 0, false), (1, 1, 7000, 0, false)]
        );
    }
}
