//! Game events: conversion to pack `Event`s, field access, and the bomb-carrier timeline.

use ahash::AHashMap;
use demoviewer_pack::Event;
use parser::second_pass::game_events::GameEvent;
use parser::second_pass::variants::Variant;
use serde_json::{json, Map, Value};

use super::rounds::round_result;

/// Field `name` of `e`, if present and not null.
pub(super) fn field<'e>(e: &'e GameEvent, name: &str) -> Option<&'e Variant> {
    e.fields.iter().find(|f| f.name == name)?.data.as_ref()
}

pub(super) fn int_field(e: &GameEvent, name: &str) -> Option<i64> {
    match field(e, name)? {
        Variant::I32(v) => Some(*v as i64),
        Variant::U32(v) => Some(*v as i64),
        Variant::U64(v) => (*v).try_into().ok(),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}

pub(super) fn f32_field(e: &GameEvent, name: &str) -> Option<f32> {
    match field(e, name)? {
        Variant::F32(v) => Some(*v),
        Variant::I32(v) => Some(*v as f32),
        Variant::U32(v) => Some(*v as f32),
        _ => None,
    }
}

pub(super) fn str_field<'e>(e: &'e GameEvent, name: &str) -> Option<&'e str> {
    match field(e, name)? {
        Variant::String(s) => Some(s),
        _ => None,
    }
}

/// A steamid field: demoparser emits `user_steamid` and friends as decimal strings.
pub(super) fn steamid_field(e: &GameEvent, name: &str) -> Option<u64> {
    steamid(field(e, name)?)
}

fn steamid(v: &Variant) -> Option<u64> {
    match v {
        Variant::U64(v) => Some(*v),
        Variant::String(s) => s.parse().ok(),
        _ => None,
    }
}

/// The parser's events, sorted by tick. The parser leaves a few out of order (connect events
/// are appended at the end); the stable sort keeps same-tick events in emission order.
pub(super) fn sorted(mut events: Vec<GameEvent>) -> Vec<GameEvent> {
    events.sort_by_key(|e| e.tick);
    events
}

/// Every event from `from_tick` to `to_tick` (inclusive) as a pack `Event`. Each `*_steamid`
/// column gains a `*_idx` column (index into `players`, or null). The `tick` column is dropped
/// (it is `Event::tick`), and so are the team scores the events pass attaches to every event
/// (on some builds they lag the round; `RoundInfo` has the real ones). `round_end`'s `winner`
/// and `reason` are written as in `RoundInfo` (2/3/0 and a reason name) whatever the build.
pub(super) fn convert(
    events: &[GameEvent],
    from_tick: i32,
    to_tick: i32,
    players: &AHashMap<u64, usize>,
) -> Vec<Event> {
    events
        .iter()
        .filter(|e| (from_tick..=to_tick).contains(&e.tick))
        .map(|e| {
            let mut data = Map::new();
            for f in &e.fields {
                let name = f.name.as_str();
                if matches!(name, "tick" | "t_score" | "ct_score") {
                    continue;
                }
                if let Some(prefix) = name.strip_suffix("_steamid") {
                    let idx = f
                        .data
                        .as_ref()
                        .and_then(steamid)
                        .and_then(|s| players.get(&s))
                        .map_or(Value::Null, |&i| json!(i));
                    data.insert(format!("{prefix}_idx"), idx);
                }
                data.insert(f.name.clone(), f.data.as_ref().map_or(Value::Null, to_json));
            }
            if e.name == "round_end" {
                let (winner, reason) = round_result(e);
                data.insert("winner".into(), json!(winner));
                data.insert("reason".into(), json!(reason));
            }
            Event {
                tick: e.tick,
                kind: e.name.clone(),
                data,
            }
        })
        .collect()
}

/// JSON for an event value. 64-bit integers become decimal strings (they exceed JavaScript's
/// safe-integer range).
fn to_json(v: &Variant) -> Value {
    match v {
        Variant::Bool(b) => json!(b),
        Variant::U32(n) => json!(n),
        Variant::I32(n) => json!(n),
        Variant::F32(f) => float(*f),
        Variant::U64(n) => json!(n.to_string()),
        Variant::String(s) => json!(s),
        Variant::VecXY(v) => Value::Array(v.iter().map(|&f| float(f)).collect()),
        Variant::VecXYZ(v) => Value::Array(v.iter().map(|&f| float(f)).collect()),
        Variant::StringVec(v) => json!(v),
        Variant::U32Vec(v) => json!(v),
        Variant::U64Vec(v) => Value::Array(v.iter().map(|n| json!(n.to_string())).collect()),
        Variant::Stickers(v) => Value::Array(
            v.iter()
                .map(|s| json!({"name": s.name, "id": s.id, "wear": float(s.wear), "x": float(s.x), "y": float(s.y)}))
                .collect(),
        ),
        Variant::InputHistory(_) | Variant::UserCmdSubtickMoves(_) => Value::Null,
    }
}

/// An `f32` as the JSON number with its shortest decimal form (`0.1`, not
/// `0.10000000149011612`); NaN and infinities become null.
fn float(f: f32) -> Value {
    f.to_string()
        .parse::<f64>()
        .ok()
        .and_then(serde_json::Number::from_f64)
        .map_or(Value::Null, Value::Number)
}

/// Who carries the bomb, as a list of `(tick, carrier)` changes over `(from_tick, to_tick]`,
/// starting from nobody: `bomb_pickup` hands it to the user, and so does an `item_pickup` of
/// the `c4` (a pickup during freeze time fires only that); `bomb_dropped` and `bomb_planted`
/// take it away, and so does the carrier's `player_death`.
pub(super) fn bomb_carrier(
    events: &[GameEvent],
    from_tick: i32,
    to_tick: i32,
    players: &AHashMap<u64, usize>,
) -> Vec<(i32, Option<usize>)> {
    let mut carrier = None;
    let mut changes = Vec::new();
    let start = events.partition_point(|e| e.tick <= from_tick);
    for e in events[start..].iter().take_while(|e| e.tick <= to_tick) {
        let user = || steamid_field(e, "user_steamid").and_then(|s| players.get(&s).copied());
        let next = match e.name.as_str() {
            "bomb_pickup" => user(),
            "item_pickup" if str_field(e, "item") == Some("c4") => user(),
            "bomb_dropped" | "bomb_planted" => None,
            "player_death" if user().is_some() && user() == carrier => None,
            _ => continue,
        };
        if next != carrier {
            carrier = next;
            changes.push((e.tick, carrier));
        }
    }
    changes
}

/// The carrier at `tick` given `changes` from [`bomb_carrier`].
pub(super) fn carrier_at(changes: &[(i32, Option<usize>)], tick: i32) -> Option<usize> {
    let i = changes.partition_point(|&(t, _)| t <= tick);
    changes.get(i.checked_sub(1)?)?.1
}

/// When each player is blind: per index into `players` (`players.len()` lists), sorted
/// disjoint `[from, to)` tick ranges, each `player_blind` covering its `blind_duration`
/// seconds from its tick. (The `flash_duration` prop is no measure of this: it stays set for
/// about two seconds after the player can see again.)
pub(super) fn blind_ranges(
    events: &[GameEvent],
    tick_rate: u32,
    players: &AHashMap<u64, usize>,
) -> Vec<Vec<(i32, i32)>> {
    let mut out: Vec<Vec<(i32, i32)>> = vec![Vec::new(); players.len()];
    for e in events.iter().filter(|e| e.name == "player_blind") {
        let Some(ranges) = steamid_field(e, "user_steamid")
            .and_then(|s| players.get(&s))
            .and_then(|&p| out.get_mut(p))
        else {
            continue;
        };
        let Some(secs) = f32_field(e, "blind_duration").filter(|&s| s > 0.0) else {
            continue;
        };
        // `as` saturates, so a garbage duration cannot overflow.
        let to = e
            .tick
            .saturating_add((f64::from(secs) * f64::from(tick_rate)).round() as i32);
        match ranges.last_mut() {
            Some(last) if e.tick <= last.1 => last.1 = last.1.max(to),
            _ => ranges.push((e.tick, to)),
        }
    }
    out
}

/// Whether `tick` is inside one of `ranges` from [`blind_ranges`].
pub(super) fn blind_at(ranges: &[(i32, i32)], tick: i32) -> bool {
    let i = ranges.partition_point(|&(from, _)| from <= tick);
    i.checked_sub(1).is_some_and(|i| tick < ranges[i].1)
}

#[cfg(test)]
pub(super) mod test_events {
    use parser::second_pass::game_events::{EventField, GameEvent};
    use parser::second_pass::variants::Variant;

    pub fn ev(name: &str, tick: i32, fields: &[(&str, Variant)]) -> GameEvent {
        GameEvent {
            name: name.to_string(),
            tick,
            fields: fields
                .iter()
                .map(|(n, v)| EventField {
                    name: n.to_string(),
                    data: Some(v.clone()),
                })
                .collect(),
        }
    }

    pub fn user(steamid: u64) -> (&'static str, Variant) {
        ("user_steamid", Variant::String(steamid.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::test_events::{ev, user};
    use super::*;

    fn players() -> AHashMap<u64, usize> {
        [(100, 0), (200, 1)].into_iter().collect()
    }

    #[test]
    fn convert_pairs_steamids_with_indices_and_drops_extras() {
        let events = [
            ev("player_spawn", 5, &[user(100)]),
            ev(
                "player_death",
                10,
                &[
                    user(100),
                    ("attacker_steamid", Variant::String("200".into())),
                    ("assister_steamid", Variant::String("0".into())),
                    ("headshot", Variant::Bool(true)),
                    ("distance", Variant::F32(0.1)),
                    ("tick", Variant::I32(10)),
                    ("t_score", Variant::I32(1)),
                ],
            ),
            ev(
                "round_end",
                11,
                &[
                    ("t_score", Variant::I32(1)),
                    ("ct_score", Variant::I32(0)),
                    ("winner", Variant::I32(2)),
                    ("reason", Variant::I32(9)),
                ],
            ),
            ev("player_death", 12, &[user(100)]),
        ];
        let out = convert(&events, 10, 11, &players());
        assert_eq!(
            out.len(),
            2,
            "events outside from_tick..=to_tick are dropped"
        );
        let d = &out[0].data;
        assert_eq!((out[0].tick, out[0].kind.as_str()), (10, "player_death"));
        assert_eq!(d["user_steamid"], json!("100"));
        assert_eq!(d["user_idx"], json!(0));
        assert_eq!(d["attacker_idx"], json!(1));
        assert_eq!(d["assister_idx"], Value::Null);
        assert_eq!(d["headshot"], json!(true));
        assert_eq!(d["distance"].to_string(), "0.1");
        assert!(!d.contains_key("tick") && !d.contains_key("t_score"));
        let end = &out[1].data;
        assert!(!end.contains_key("t_score") && !end.contains_key("ct_score"));
        assert_eq!(
            (&end["winner"], &end["reason"]),
            (&json!(2), &json!("ct_killed"))
        );
    }

    #[test]
    fn blind_ranges_cover_each_blind_duration_and_merge_overlaps() {
        let blind = |tick, steamid, secs| {
            ev(
                "player_blind",
                tick,
                &[user(steamid), ("blind_duration", Variant::F32(secs))],
            )
        };
        let events = [
            blind(100, 100, 1.0),
            blind(130, 100, 0.25), // inside the first: no change
            blind(150, 100, 1.0),  // overlaps: extends it to 214
            blind(300, 100, 0.5),
            blind(300, 200, 0.0),                  // not blinded at all
            blind(300, 999, 2.0),                  // not a player
            ev("player_blind", 400, &[user(200)]), // no duration
        ];
        let r = blind_ranges(&events, 64, &players());
        assert_eq!(r, [vec![(100, 214), (300, 332)], vec![]]);
        let at = |t| blind_at(&r[0], t);
        assert!(!at(99) && at(100) && at(213) && !at(214) && at(331) && !at(332));
        assert!(!blind_at(&r[1], 300));
    }

    #[test]
    fn bomb_carrier_follows_pickup_drop_plant_and_death() {
        let events = [
            ev("bomb_pickup", 5, &[user(100)]),
            ev("bomb_pickup", 10, &[user(100)]),
            ev("bomb_dropped", 20, &[user(100)]),
            ev("bomb_pickup", 30, &[user(200)]),
            ev("player_death", 35, &[user(100)]),
            ev("player_death", 40, &[user(200)]),
            ev(
                "item_pickup",
                45,
                &[user(200), ("item", Variant::String("knife".into()))],
            ),
            ev(
                "item_pickup",
                50,
                &[user(100), ("item", Variant::String("c4".into()))],
            ),
            ev("bomb_planted", 60, &[user(100)]),
            ev("bomb_pickup", 70, &[user(200)]),
        ];
        let changes = bomb_carrier(&events, 5, 65, &players());
        assert_eq!(
            changes,
            [
                (10, Some(0)),
                (20, None),
                (30, Some(1)),
                (40, None),
                (50, Some(0)),
                (60, None)
            ]
        );
        assert_eq!(carrier_at(&changes, 9), None);
        assert_eq!(carrier_at(&changes, 10), Some(0));
        assert_eq!(carrier_at(&changes, 39), Some(1));
        assert_eq!(carrier_at(&changes, 100), None);
    }
}
