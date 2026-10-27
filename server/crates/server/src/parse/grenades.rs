//! Grenade flights from the projectile pass, with detonation and expiry ticks from the events.

use ahash::{AHashMap, AHashSet};
use demoviewer_pack::{quant, GrenadeTrack};
use parser::first_pass::prop_controller::{
    ENTITY_ID_ID, GRENADE_TYPE_ID, GRENADE_X, GRENADE_Y, GRENADE_Z, STEAMID_ID, TICK_ID,
};
use parser::parse_demo::DemoOutput;
use parser::second_pass::game_events::GameEvent;

use super::events::{f32_field, int_field, steamid_field, str_field};
use super::props::Column;
use super::TICK_RATE;

/// Longest tick gap inside one flight. Entity indices are reused, so a longer gap in one
/// entity's rows starts a new grenade.
const MAX_GAP: i32 = 8;
/// How far after a flight's last row its events may come: one second.
const SLACK: i32 = TICK_RATE as i32;
/// Farthest an event may be from where the flight ended, for the position fallback.
const MAX_DIST: f32 = 300.0;
/// Longest flight track kept: two minutes (a smoke's projectile lives about 20 seconds).
/// Rows past it are left out, so edited ticks cannot make one track huge.
const MAX_FLIGHT_TICKS: i64 = 2 * 60 * TICK_RATE as i64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Smoke,
    Flash,
    He,
    /// Molotov or incendiary: both fly as `CMolotovProjectile`.
    Fire,
    Decoy,
}

fn kind_of(class: &str) -> Option<Kind> {
    Some(match class {
        "CSmokeGrenadeProjectile" | "smokegrenade_projectile" => Kind::Smoke,
        "CFlashbangProjectile" | "flashbang_projectile" => Kind::Flash,
        "CHEGrenadeProjectile" | "hegrenade_projectile" => Kind::He,
        "CMolotovProjectile" | "molotov_projectile" | "incendiarygrenade_projectile" => Kind::Fire,
        "CDecoyProjectile" | "decoy_projectile" => Kind::Decoy,
        _ => return None,
    })
}

/// One row of the projectile pass.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct ProjRow {
    pub entity_id: i32,
    pub tick: i32,
    pub kind: Kind,
    /// 0 when unknown.
    pub thrower: u64,
    pub pos: [f32; 3],
}

/// One thrown grenade: its rows, in tick order.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct Flight {
    pub entity_id: i32,
    pub kind: Kind,
    pub thrower: u64,
    pub rows: Vec<(i32, [f32; 3])>,
}

impl Flight {
    fn start(&self) -> i32 {
        self.rows[0].0
    }
    fn last(&self) -> (i32, [f32; 3]) {
        *self.rows.last().expect("a flight has rows")
    }
}

fn rows(out: &DemoOutput) -> Vec<ProjRow> {
    let df = &out.df;
    let [ty, ent, x, y, z, tick, sid] = [
        GRENADE_TYPE_ID,
        ENTITY_ID_ID,
        GRENADE_X,
        GRENADE_Y,
        GRENADE_Z,
        TICK_ID,
        STEAMID_ID,
    ]
    .map(|id| Column::of(df, id));
    (0..tick.len())
        .filter_map(|r| {
            Some(ProjRow {
                entity_id: ent.i32(r)?,
                tick: tick.i32(r)?,
                kind: kind_of(ty.str(r)?)?,
                thrower: sid.u64(r).unwrap_or(0),
                pos: [x.f32(r)?, y.f32(r)?, z.f32(r)?],
            })
        })
        .collect()
}

/// Groups rows by entity, splitting where the index was reused (a gap over `MAX_GAP` ticks, or
/// a different kind or thrower). Flights come back ordered by start tick.
pub(super) fn flights(mut rows: Vec<ProjRow>) -> Vec<Flight> {
    rows.sort_by_key(|r| (r.entity_id, r.tick));
    let mut out: Vec<Flight> = Vec::new();
    for r in rows {
        match out.last_mut() {
            Some(f)
                if f.entity_id == r.entity_id
                    && f.kind == r.kind
                    && f.thrower == r.thrower
                    && i64::from(r.tick) - i64::from(f.last().0) <= i64::from(MAX_GAP) =>
            {
                f.rows.push((r.tick, r.pos))
            }
            _ => out.push(Flight {
                entity_id: r.entity_id,
                kind: r.kind,
                thrower: r.thrower,
                rows: vec![(r.tick, r.pos)],
            }),
        }
    }
    out.sort_by_key(|f| (f.start(), f.entity_id));
    out
}

/// Positions every `step` ticks from the first row to the last (at most [`MAX_FLIGHT_TICKS`]
/// on), each from the latest row at or before the sample tick.
fn sample(rows: &[(i32, [f32; 3])], step: u32) -> [Vec<i16>; 3] {
    let start = rows[0].0;
    let step = step.max(1);
    let span = (i64::from(rows[rows.len() - 1].0) - i64::from(start)).clamp(0, MAX_FLIGHT_TICKS);
    let n = (span / i64::from(step) + 1) as usize;
    let mut out = [(); 3].map(|_| Vec::with_capacity(n));
    let mut j = 0;
    for k in 0..n {
        // Within MAX_FLIGHT_TICKS of `start`, which is at most the last row's tick.
        let t = start + (k as u32 * step) as i32;
        while j + 1 < rows.len() && rows[j + 1].0 <= t {
            j += 1;
        }
        for (axis, col) in out.iter_mut().enumerate() {
            col.push(quant::position(rows[j].1[axis]));
        }
    }
    out
}

/// The unclaimed event `name` for `flight`: the first whose `entityid` is the flight's entity
/// within its lifetime (plus `SLACK`), else the one nearest to where and when the flight ended
/// (same thrower, within `SLACK` ticks and `MAX_DIST` units). Claims what it returns.
fn match_event(
    events: &[GameEvent],
    name: &str,
    flight: &Flight,
    claimed: &mut AHashSet<usize>,
) -> Option<usize> {
    let (last_tick, last_pos) = flight.last();
    let lo = events.partition_point(|e| e.tick < flight.start());
    let candidates = || {
        events[lo..]
            .iter()
            .enumerate()
            .take_while(|(_, e)| e.tick <= last_tick + SLACK)
            .map(move |(i, e)| (lo + i, e))
            .filter(|(i, e)| e.name == name && !claimed.contains(i))
    };
    let by_id = candidates()
        .find(|(_, e)| int_field(e, "entityid") == Some(flight.entity_id as i64))
        .map(|(i, _)| i);
    let found = by_id.or_else(|| {
        candidates()
            .filter(|(_, e)| (e.tick - last_tick).abs() <= SLACK)
            .filter(|(_, e)| match steamid_field(e, "user_steamid") {
                Some(s) if s != 0 && flight.thrower != 0 => s == flight.thrower,
                _ => true,
            })
            .filter_map(|(i, e)| {
                let p = [f32_field(e, "x")?, f32_field(e, "y")?, f32_field(e, "z")?];
                let d = (0..3)
                    .map(|a| (p[a] - last_pos[a]).powi(2))
                    .sum::<f32>()
                    .sqrt();
                (d <= MAX_DIST).then_some((i, d, (e.tick - last_tick).abs()))
            })
            .min_by(|a, b| a.1.total_cmp(&b.1).then(a.2.cmp(&b.2)))
            .map(|(i, ..)| i)
    })?;
    claimed.insert(found);
    Some(found)
}

/// The end of the inferno that `events[burn]` (an `inferno_startburn`) started: the first
/// unclaimed `inferno_expire` or `inferno_extinguish` of the same inferno entity.
fn inferno_end(events: &[GameEvent], burn: usize, claimed: &mut AHashSet<usize>) -> Option<usize> {
    let id = int_field(&events[burn], "entityid")?;
    let i = (burn + 1..events.len()).find(|&i| {
        let e = &events[i];
        matches!(e.name.as_str(), "inferno_expire" | "inferno_extinguish")
            && int_field(e, "entityid") == Some(id)
            && !claimed.contains(&i)
    })?;
    claimed.insert(i);
    Some(i)
}

/// `molotov` or `incendiary`: the thrower's last `weapon_fire` of either in the two seconds
/// before the throw, else by side (CTs buy incendiaries).
fn fire_kind(
    events: &[GameEvent],
    flight: &Flight,
    team_at: &impl Fn(u64, i32) -> u8,
) -> &'static str {
    let start = flight.start();
    let lo = events.partition_point(|e| e.tick < start - 2 * TICK_RATE as i32);
    events[lo..]
        .iter()
        .take_while(|e| e.tick <= start)
        .filter(|e| {
            e.name == "weapon_fire" && steamid_field(e, "user_steamid") == Some(flight.thrower)
        })
        .filter_map(|e| match str_field(e, "weapon")? {
            "weapon_molotov" => Some("molotov"),
            "weapon_incgrenade" => Some("incendiary"),
            _ => None,
        })
        .last()
        .unwrap_or_else(|| match team_at(flight.thrower, start) {
            3 => "incendiary",
            _ => "molotov",
        })
}

/// Grenades thrown from `from_tick` to `to_tick` (inclusive), in throw order. `events` are
/// sorted by tick; `team_at(steamid, tick)` is a player's side (2/3, 0 unknown).
pub(super) fn build(
    out: &DemoOutput,
    events: &[GameEvent],
    from_tick: i32,
    to_tick: i32,
    tick_step: u32,
    players: &AHashMap<u64, usize>,
    team_at: impl Fn(u64, i32) -> u8,
) -> Vec<GrenadeTrack> {
    let mut claimed = AHashSet::default();
    let tick = |i: Option<usize>| i.map(|i| events[i].tick);
    flights(rows(out))
        .into_iter()
        .filter(|f| (from_tick..=to_tick).contains(&f.start()))
        .map(|f| {
            let (kind, detonate, expire) = match f.kind {
                Kind::Fire => {
                    let burn = match_event(events, "inferno_startburn", &f, &mut claimed);
                    let end = burn.and_then(|b| inferno_end(events, b, &mut claimed));
                    (fire_kind(events, &f, &team_at), tick(burn), tick(end))
                }
                Kind::Smoke => (
                    "smoke",
                    tick(match_event(
                        events,
                        "smokegrenade_detonate",
                        &f,
                        &mut claimed,
                    )),
                    tick(match_event(
                        events,
                        "smokegrenade_expired",
                        &f,
                        &mut claimed,
                    )),
                ),
                Kind::Flash => (
                    "flash",
                    tick(match_event(events, "flashbang_detonate", &f, &mut claimed)),
                    None,
                ),
                Kind::He => (
                    "he",
                    tick(match_event(events, "hegrenade_detonate", &f, &mut claimed)),
                    None,
                ),
                Kind::Decoy => (
                    "decoy",
                    tick(match_event(events, "decoy_detonate", &f, &mut claimed)),
                    None,
                ),
            };
            let [x, y, z] = sample(&f.rows, tick_step);
            GrenadeTrack {
                entity_id: f.entity_id,
                kind: kind.to_string(),
                thrower: players
                    .get(&f.thrower)
                    .and_then(|&i| u8::try_from(i).ok())
                    .filter(|&i| i != 255)
                    .unwrap_or(255),
                start_tick: f.start(),
                detonate_tick: detonate,
                expire_tick: expire,
                x,
                y,
                z,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::events::test_events::{ev, user};
    use super::*;
    use parser::second_pass::variants::Variant;

    fn row(entity_id: i32, tick: i32, kind: Kind, thrower: u64, x: f32) -> ProjRow {
        ProjRow {
            entity_id,
            tick,
            kind,
            thrower,
            pos: [x, 0.0, 0.0],
        }
    }

    #[test]
    fn reused_entity_index_splits_into_separate_flights() {
        let mut rows: Vec<ProjRow> = (100..=110)
            .map(|t| row(7, t, Kind::Smoke, 1, t as f32))
            .collect();
        rows.extend((300..=305).map(|t| row(7, t, Kind::He, 2, 0.0)));
        rows.extend((50..=52).map(|t| row(9, t, Kind::Flash, 1, 0.0)));
        rows.reverse();
        let f = flights(rows);
        let summary: Vec<_> = f
            .iter()
            .map(|f| (f.entity_id, f.kind, f.start(), f.rows.len()))
            .collect();
        assert_eq!(
            summary,
            [
                (9, Kind::Flash, 50, 3),
                (7, Kind::Smoke, 100, 11),
                (7, Kind::He, 300, 6)
            ]
        );
        let [x, ..] = sample(&f[1].rows, 2);
        assert_eq!(x, [100, 102, 104, 106, 108, 110]);
    }

    /// Ticks come from the demo's frame headers and may be anything: a gap that overflows
    /// `i32` still splits the flight, and one flight's track stops at `MAX_FLIGHT_TICKS`.
    #[test]
    fn edited_ticks_cannot_make_a_huge_track() {
        let rows = vec![
            row(7, i32::MIN, Kind::Smoke, 1, 0.0),
            row(7, i32::MAX, Kind::Smoke, 1, 0.0),
        ];
        let f = flights(rows);
        assert_eq!(f.len(), 2);
        assert!(f.iter().all(|f| f.rows.len() == 1));

        // Rows every 8 ticks for 10 minutes: one flight, sampled for two minutes.
        let rows: Vec<_> = (0..=4800).map(|i| (i * 8, [i as f32, 0.0, 0.0])).collect();
        let [x, y, z] = sample(&rows, 2);
        let n = (MAX_FLIGHT_TICKS / 2 + 1) as usize;
        assert_eq!((x.len(), y.len(), z.len()), (n, n, n));
        assert_eq!(x[n - 1], 960);
    }

    #[test]
    fn events_match_by_entity_id_then_by_place_and_time() {
        let f = Flight {
            entity_id: 7,
            kind: Kind::Smoke,
            thrower: 1,
            rows: vec![(100, [0.0; 3]), (200, [1000.0, 0.0, 0.0])],
        };
        let at = |tick, id: i32, x: f32, who| {
            ev(
                "smokegrenade_detonate",
                tick,
                &[
                    ("entityid", Variant::I32(id)),
                    ("x", Variant::F32(x)),
                    ("y", Variant::F32(0.0)),
                    ("z", Variant::F32(0.0)),
                    user(who),
                ],
            )
        };
        let events = [at(150, 8, 1000.0, 1), at(190, 7, 0.0, 1)];
        let mut claimed = AHashSet::default();
        assert_eq!(
            match_event(&events, "smokegrenade_detonate", &f, &mut claimed),
            Some(1)
        );
        // The by-id event is claimed; the fallback takes the near one from the same thrower.
        assert_eq!(
            match_event(&events, "smokegrenade_detonate", &f, &mut claimed),
            Some(0)
        );
        assert_eq!(
            match_event(&events, "smokegrenade_detonate", &f, &mut claimed),
            None
        );
        // Wrong thrower or too far away: no match.
        let events = [at(200, 8, 1000.0, 2), at(200, 8, 5000.0, 1)];
        assert_eq!(
            match_event(
                &events,
                "smokegrenade_detonate",
                &f,
                &mut AHashSet::default()
            ),
            None
        );
    }

    #[test]
    fn fire_kind_from_weapon_fire_else_side() {
        let f = Flight {
            entity_id: 7,
            kind: Kind::Fire,
            thrower: 1,
            rows: vec![(1000, [0.0; 3])],
        };
        let fire = |tick, weapon: &str, who| {
            ev(
                "weapon_fire",
                tick,
                &[("weapon", Variant::String(weapon.into())), user(who)],
            )
        };
        let ct = |_: u64, _: i32| 3;
        let t = |_: u64, _: i32| 2;
        assert_eq!(
            fire_kind(&[fire(990, "weapon_molotov", 1)], &f, &ct),
            "molotov"
        );
        assert_eq!(
            fire_kind(&[fire(990, "weapon_incgrenade", 1)], &f, &t),
            "incendiary"
        );
        assert_eq!(
            fire_kind(&[fire(990, "weapon_molotov", 2)], &f, &ct),
            "incendiary"
        );
        assert_eq!(
            fire_kind(&[fire(800, "weapon_molotov", 1)], &f, &ct),
            "incendiary"
        );
        assert_eq!(fire_kind(&[], &f, &t), "molotov");
    }
}
