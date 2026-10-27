//! Golden tests against real Valve matchmaking demos (local only, never in git): `mirage.dem`
//! (build 14185) and `mirage_old.dem` (build 13984, the demo bundled with the vendored parser).
//!
//! Run with `DEMOVIEWER_DEMOS=<dir> cargo test -p demoviewer-server --release -- --ignored`.
//! mirage's death count and final score come from an independent analyzer of the same demo.

use std::path::Path;
use std::time::Instant;

use demoviewer_pack::{flags, sample_tick, MapEntityKind, Match, MatchHeader};
use demoviewer_server::config::Config;
use demoviewer_server::matches::{summarize, SummaryPlayer};
use demoviewer_server::parse::parse_file;
use demoviewer_server::worker::parse_in_child;
use serde_json::Value;

fn parse(name: &str) -> (Match, f64) {
    let dir = std::env::var("DEMOVIEWER_DEMOS").expect("DEMOVIEWER_DEMOS must be set");
    let t = Instant::now();
    let m = parse_file(&Path::new(&dir).join(name)).unwrap_or_else(|e| panic!("parse {name}: {e}"));
    (m, t.elapsed().as_secs_f64())
}

/// Each round adds one win to its winner's side (the sides may swap between rounds), and every
/// reason is a name, not a numeric code.
fn assert_rounds_consistent(h: &MatchHeader) {
    let mut before = (0u8, 0u8);
    for info in &h.rounds {
        let after = (info.score_t, info.score_ct);
        let won = |(t, ct): (u8, u8)| match info.winner {
            2 => (t + 1, ct),
            3 => (t, ct + 1),
            _ => (t, ct),
        };
        assert!(
            info.winner != 0 && (after == won(before) || after == won((before.1, before.0))),
            "round {}: {before:?} then {after:?}, winner {}",
            info.number,
            info.winner
        );
        assert!(
            !info.reason.is_empty() && info.reason.parse::<i64>().is_err(),
            "round {} reason {:?}",
            info.number,
            info.reason
        );
        before = after;
    }
}

/// FLASHED is set only while a `player_blind` for that player covers the sample (the
/// `flash_duration` prop stays set for about two seconds longer).
fn assert_flashed_only_while_blind(m: &Match) {
    let h = &m.header;
    let blinds: Vec<(u64, i32, f64)> = m
        .events
        .iter()
        .filter(|e| e.kind == "player_blind")
        .filter_map(|e| {
            let secs = e.data.get("blind_duration")?.as_f64()?;
            Some((e.data.get("user_idx")?.as_u64()?, e.tick, secs))
        })
        .collect();
    let mut flashed = 0;
    for (info, tracks) in h.rounds.iter().zip(&m.rounds) {
        for (p, t) in tracks.players.iter().enumerate() {
            for (k, f) in t.flags.iter().enumerate() {
                if f & flags::FLASHED == 0 {
                    continue;
                }
                flashed += 1;
                let tick = sample_tick(info, h, k as u32);
                assert!(
                    blinds.iter().any(|&(q, from, secs)| q == p as u64
                        && from <= tick
                        && (tick as f64) < from as f64 + secs * h.tick_rate as f64 + 1.0),
                    "round {} player {p} flashed at tick {tick} without a blind",
                    info.number
                );
            }
        }
    }
    assert!(flashed > 0, "nobody is ever flashed");
}

fn assert_round_trips(m: &Match) -> usize {
    let mut buf = Vec::new();
    demoviewer_pack::write(m, &mut buf).expect("write pack");
    let back: Match = demoviewer_pack::read(&mut &buf[..]).expect("read pack");
    assert!(&back == m, "pack round-trip differs");
    buf.len()
}

#[test]
#[ignore = "needs $DEMOVIEWER_DEMOS/mirage.dem; run with --ignored"]
fn golden_mirage() {
    let (m, parse_secs) = parse("mirage.dem");
    let h = &m.header;

    assert_eq!(h.map, "de_mirage");
    assert_eq!(h.tick_rate, 64);
    assert_eq!(h.tick_step, 2);
    assert_eq!(h.players.len(), 10);
    assert_eq!(h.rounds.len(), 24);
    let last = h.rounds.last().unwrap();
    assert_eq!((last.score_t, last.score_ct), (13, 11), "final score T:CT");
    let deaths = m.events.iter().filter(|e| e.kind == "player_death").count();
    assert_eq!(deaths, 176);

    assert_eq!(m.rounds.len(), h.rounds.len());
    for (r, (info, tracks)) in h.rounds.iter().zip(&m.rounds).enumerate() {
        // Tracks run through the after-round: to just before the next round, at most 10 s.
        let post = info.post_end_tick.expect("post_end_tick");
        assert!(
            post >= info.end_tick && post <= info.end_tick + 640,
            "round {r}: post_end_tick {post}"
        );
        if let Some(next) = h.rounds.get(r + 1) {
            assert!(
                post < next.start_tick,
                "round {r}: after-round overlaps the next round"
            );
        }
        assert_eq!(
            info.samples as i32,
            (post - info.start_tick) / h.tick_step as i32 + 1,
            "round {r} sample count"
        );
        assert_eq!(tracks.players.len(), h.players.len());
        for (p, t) in tracks.players.iter().enumerate() {
            let n = info.samples as usize;
            for (name, len) in [
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
            ] {
                assert_eq!(len, n, "round {r} player {p} {name}");
            }
        }
        // Everyone is alive when the freeze time ends.
        let k = ((info.freeze_end_tick - info.start_tick) / h.tick_step as i32) as usize;
        let alive = tracks
            .players
            .iter()
            .filter(|t| t.flags[k] & flags::ALIVE != 0)
            .count();
        assert_eq!(alive, 10, "round {r}: players alive at freeze end");
    }
    assert!(
        m.grenades
            .iter()
            .any(|g| g.kind == "smoke" && g.detonate_tick.is_some()),
        "a detonated smoke"
    );
    assert_rounds_consistent(h);
    assert_flashed_only_while_blind(&m);
    let bytes = assert_round_trips(&m);

    let samples: u64 = h.rounds.iter().map(|r| r.samples as u64).sum();
    let mut kinds = std::collections::BTreeMap::<&str, (usize, usize, usize)>::new();
    for g in &m.grenades {
        let e = kinds.entry(&g.kind).or_default();
        e.0 += 1;
        e.1 += g.detonate_tick.is_some() as usize;
        e.2 += g.expire_tick.is_some() as usize;
    }
    println!("parse_file: {parse_secs:.2}s");
    println!(
        "match: {} rounds, {} players, {} samples/player, {} events, {} grenades, {} weapons",
        h.rounds.len(),
        h.players.len(),
        samples,
        m.events.len(),
        m.grenades.len(),
        h.weapons.len()
    );
    println!("grenades (count, detonated, expired): {kinds:?}");
    println!("pack: {bytes} bytes ({:.1} MB gz)", bytes as f64 / 1e6);

    assert_first_person_data(&m);
    assert_summary(&m);
    assert_world(&m);
}

/// Mirage's one breakable, a window, breaks in round indices 2 and 17 (spike of 2026-10-22),
/// and in round index 21 at tick 140011, 11 ticks before that round's `round_end`: the demo
/// removes it there, in the same tick as a `weapon_fire`, `bullet_damage` and
/// `player_bullet_hit`, and creates it again only at round 22's start (140470). The spike's
/// list missed that one. The round clean-ups that put it back are no breaks.
fn assert_world(m: &Match) {
    let panes: Vec<usize> = (0..m.map_entities.len())
        .filter(|&i| m.map_entities[i].kind == MapEntityKind::Breakable)
        .collect();
    assert_eq!(panes.len(), 1, "{:?}", m.map_entities);
    let breaks: Vec<(usize, u16, i32)> = m
        .map_changes
        .iter()
        .filter(|c| c.gone)
        .map(|c| (c.entity as usize, c.round, c.tick))
        .collect();
    assert_eq!(
        breaks,
        [
            (panes[0], 2, 12933),
            (panes[0], 17, 109596),
            (panes[0], 21, 140011)
        ]
    );

    let gz_len = |m: &Match| {
        let mut buf = Vec::new();
        demoviewer_pack::write(m, &mut buf).expect("write pack");
        buf.len()
    };
    let mut no_ent = m.clone();
    no_ent.map_entities.clear();
    no_ent.map_changes.clear();
    let mut no_gnd = m.clone();
    no_gnd.ground.clear();
    let full = gz_len(m);
    println!(
        "world: {} map entities, {} changes; {} ground keys; ENT1 +{} B, GND1+GNB1 +{} B gzipped",
        m.map_entities.len(),
        m.map_changes.len(),
        m.ground.len(),
        full - gz_len(&no_ent),
        full - gz_len(&no_gnd)
    );
}

/// The match summary: the pack's map, final score and players, every death once and every
/// kill of a player on the other side once.
fn assert_summary(m: &Match) {
    let h = &m.header;
    let s = summarize(m);
    assert_eq!(s.map, "de_mirage");
    assert_eq!((s.rounds, s.score_t, s.score_ct), (24, 13, 11));
    assert_eq!(
        (s.server_name.as_str(), s.game_build.as_str()),
        (h.server_name.as_str(), h.game_build.as_str())
    );
    let who = |p: &demoviewer_pack::PlayerInfo| (p.steamid.to_string(), p.name.clone());
    assert_eq!(
        s.players
            .iter()
            .map(|p| (p.steamid.clone(), p.name.clone()))
            .collect::<Vec<_>>(),
        h.players.iter().map(who).collect::<Vec<_>>()
    );
    for (p, info) in s.players.iter().zip(&h.players) {
        assert_eq!(Some(&p.team), info.team_by_round.last(), "{}", p.name);
    }

    let idx = |e: &demoviewer_pack::Event, key: &str| e.data.get(key).and_then(Value::as_u64);
    let deaths: Vec<_> = m
        .events
        .iter()
        .filter(|e| e.kind == "player_death")
        .collect();
    let round_of = |tick: i32| {
        h.rounds
            .iter()
            .rposition(|r| r.start_tick <= tick)
            .unwrap_or(0)
    };
    let side = |p: u64, tick: i32| h.players[p as usize].team_by_round[round_of(tick)];
    let (mut kills, mut team_kills, mut suicides) = (0, 0, 0);
    for e in &deaths {
        match (idx(e, "attacker_idx"), idx(e, "user_idx")) {
            (Some(a), Some(v)) if a == v => suicides += 1,
            (Some(a), Some(v)) if side(a, e.tick) != 0 && side(a, e.tick) == side(v, e.tick) => {
                team_kills += 1
            }
            (Some(_), _) => kills += 1,
            (None, _) => {}
        }
    }
    let sum =
        |f: fn(&SummaryPlayer) -> u16| s.players.iter().map(|p| usize::from(f(p))).sum::<usize>();
    assert_eq!(sum(|p| p.deaths), 176, "every death is a player's");
    assert_eq!(sum(|p| p.kills), kills);
    let minutes = s.duration_s / 60;
    assert!((25..=60).contains(&minutes), "{} s", s.duration_s);
    println!(
        "summary: {} s, {kills} kills, {team_kills} team kills, {suicides} suicides, {} other deaths",
        s.duration_s,
        deaths.len() - kills - team_kills - suicides
    );
}

/// Money, inventory, crosshair codes, zoom and the after-round, against values read from the
/// demo with the vendored parser directly (spike of 2026-10-22).
fn assert_first_person_data(m: &Match) {
    use demoviewer_pack::gear;
    let h = &m.header;
    let who = |name: &str| {
        h.players
            .iter()
            .position(|p| p.name.starts_with(name))
            .unwrap()
    };
    let at = |r: usize, tick: i32| ((tick - h.rounds[r].start_tick) / h.tick_step as i32) as usize;
    let (milo, svi) = (who("Milo"), who("svi_"));

    // Round 3, freeze end (tick 10778): Milo has $1650, a helmet, and knife, Glock, AK.
    let r3 = &m.rounds[2].players[milo];
    let k = at(2, 10778);
    assert_eq!(r3.money[k], 1650);
    assert_ne!(r3.gear[k] & gear::HELMET, 0);
    let inv = m
        .inventory
        .iter()
        .rfind(|c| c.round == 2 && c.player as usize == milo && c.tick <= 10778)
        .expect("Milo's inventory in round 3");
    let names: Vec<&str> = inv
        .items
        .iter()
        .map(|&i| h.weapons[i as usize].as_str())
        .collect();
    assert_eq!(names, ["knife_t", "Glock-18", "AK-47"]);
    assert_eq!(
        h.players[milo].crosshair.as_deref(),
        Some("CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB")
    );
    // His AK's magazine before and after the first shots of his round 3 fight.
    assert_eq!(r3.ammo[at(2, 11490)], 30);
    assert_eq!(r3.ammo[at(2, 11498)], 28);

    // Round 5: svi_ holds a scoped AWP (zoom level 1) at tick 20584.
    let g = m.rounds[4].players[svi].gear[at(4, 20584)];
    assert_eq!((g & gear::ZOOM_MASK) >> gear::ZOOM_SHIFT, 1);

    // The bomb that exploded after round 6 was decided is inside round 6's after-round.
    let boom = m
        .events
        .iter()
        .find(|e| e.kind == "bomb_exploded")
        .unwrap()
        .tick;
    let r6 = &h.rounds[5];
    assert!(
        boom > r6.end_tick && boom <= r6.post_end_tick.unwrap(),
        "explosion {boom}"
    );
    let inv_changes = m.inventory.len();
    println!(
        "first person: {inv_changes} inventory changes; crosshairs for {} players",
        h.players.iter().filter(|p| p.crosshair.is_some()).count()
    );
}

/// Build 13984 updates the team scores a tick after `round_end` and sends the round-end
/// reason as a number; the match ends 8:2 when the CTs surrender in round 10.
#[test]
#[ignore = "needs $DEMOVIEWER_DEMOS/mirage_old.dem; run with --ignored"]
fn golden_mirage_old() {
    let (m, parse_secs) = parse("mirage_old.dem");
    let h = &m.header;

    assert_eq!(h.map, "de_mirage");
    assert_eq!(h.game_build, "13984");
    assert_eq!(h.players.len(), 10);
    assert_eq!(h.rounds.len(), 10);
    let (first, last) = (&h.rounds[0], h.rounds.last().unwrap());
    assert_eq!((first.winner, first.reason.as_str()), (2, "ct_killed"));
    assert_eq!(
        (first.score_t, first.score_ct),
        (1, 0),
        "round 1 score T:CT"
    );
    assert_eq!((last.winner, last.reason.as_str()), (2, "ct_surrender"));
    assert_eq!((last.score_t, last.score_ct), (8, 2), "final score T:CT");
    let wins_t = h.rounds.iter().filter(|r| r.winner == 2).count();
    assert_eq!(wins_t, 8);
    let ends: Vec<_> = m.events.iter().filter(|e| e.kind == "round_end").collect();
    assert_eq!(ends.len(), 10);
    for (end, info) in ends.iter().zip(&h.rounds) {
        assert_eq!(end.data["reason"], info.reason.as_str());
        assert_eq!(end.data["winner"], info.winner);
        assert!(
            !end.data.contains_key("t_score"),
            "the lagging raw score is dropped"
        );
    }
    for (info, tracks) in h.rounds.iter().zip(&m.rounds) {
        for t in &tracks.players {
            assert_eq!(t.flags.len(), info.samples as usize);
        }
    }
    assert_rounds_consistent(h);
    assert_flashed_only_while_blind(&m);
    let bytes = assert_round_trips(&m);
    println!(
        "parse_file: {parse_secs:.2}s; {} rounds, {} events, {} grenades; pack {bytes} bytes",
        h.rounds.len(),
        m.events.len(),
        m.grenades.len()
    );
}

/// Production parses in a child process of the server binary, with its writable memory capped
/// at the default `parse_memory_bytes`: a real 237 MB demo must fit (it needs under 1 GiB).
#[tokio::test]
#[ignore = "needs $DEMOVIEWER_DEMOS/mirage.dem; run with --ignored"]
async fn golden_mirage_in_a_parse_child() {
    let dir = std::env::var("DEMOVIEWER_DEMOS").expect("DEMOVIEWER_DEMOS must be set");
    let out = tempfile::tempdir().unwrap();
    let pack = out.path().join("mirage.dvpk.gz");
    let limit = Config::default().parse_memory_bytes;
    let t = Instant::now();
    let summary = parse_in_child(
        Path::new(env!("CARGO_BIN_EXE_demoviewer-server")),
        &Path::new(&dir).join("mirage.dem"),
        &pack,
        limit,
    )
    .await
    .unwrap_or_else(|e| panic!("parse child: {e}"));
    let secs = t.elapsed().as_secs_f64();
    assert_eq!(
        (
            summary.map.as_str(),
            summary.rounds,
            summary.score_t,
            summary.score_ct
        ),
        ("de_mirage", 24, 13, 11)
    );
    assert_eq!(summary.players.len(), 10);
    let file = std::fs::File::open(&pack).unwrap();
    let m = demoviewer_pack::read(&mut std::io::BufReader::new(file)).expect("read pack");
    assert_eq!(m.header.rounds.len(), 24);
    assert_eq!(m.header.players.len(), 10);
    println!("parse child ({} MiB limit): {secs:.2}s", limit >> 20);
}
