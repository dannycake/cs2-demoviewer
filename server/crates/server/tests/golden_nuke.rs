//! Golden test against a real Valve matchmaking demo of Nuke (local only, never in git):
//! `nuke.dem`, a hard link to `match730_003837789388360646804_1912149738_404.dem`. Its doors,
//! breakables and items on the ground, against the spike of 2026-10-22 that logged every
//! decoded field of those entities.
//!
//! Run with `DEMOVIEWER_DEMOS=<dir> cargo test -p demoviewer-server --release -- --ignored`.

use std::path::Path;
use std::time::Instant;

use demoviewer_pack::{MapEntity, MapEntityKind, Match};
use demoviewer_server::parse::parse_file;

/// The four doors' spawn positions in the spike: exactly their `default_ents.vents` origins.
const DOORS: [[f32; 3]; 4] = [
    [1047.0, -920.0, -768.0],
    [1047.0, -1040.0, -768.0],
    [305.19, -1350.38, -767.99],
    [257.0, -1310.0, -416.0],
];

/// What a ground item may be: a gun or a grenade (by its `WEAPINDICIES` display name), or a
/// defuse kit. Never the C4, a knife or armour.
const GROUND_NAMES: &[&str] = &[
    "Desert Eagle",
    "Dual Berettas",
    "Five-SeveN",
    "Glock-18",
    "AK-47",
    "AUG",
    "AWP",
    "FAMAS",
    "G3SG1",
    "Galil AR",
    "M249",
    "M4A4",
    "MAC-10",
    "P90",
    "MP5-SD",
    "UMP-45",
    "XM1014",
    "PP-Bizon",
    "MAG-7",
    "Negev",
    "Sawed-Off",
    "Tec-9",
    "Zeus x27",
    "P2000",
    "MP7",
    "MP9",
    "Nova",
    "P250",
    "SCAR-20",
    "SG 553",
    "SSG 08",
    "Flashbang",
    "High Explosive Grenade",
    "Smoke Grenade",
    "Molotov",
    "Decoy Grenade",
    "Incendiary Grenade",
    "M4A1-S",
    "USP-S",
    "CZ75-Auto",
    "R8 Revolver",
    "defuser",
];

fn distance(e: &MapEntity, p: [f32; 3]) -> f32 {
    let d = [e.x as f32 - p[0], e.y as f32 - p[1], e.z as f32 - p[2]];
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

/// How far, in degrees, a yaw of `to` is turned from `from` (both in hundredths).
fn turned(from: i16, to: i16) -> f64 {
    let d = (to as f64 - from as f64) / 100.0;
    ((d + 180.0).rem_euclid(360.0) - 180.0).abs()
}

fn gz_len(m: &Match) -> usize {
    let mut buf = Vec::new();
    demoviewer_pack::write(m, &mut buf).expect("write pack");
    buf.len()
}

/// Bytes the gzipped pack grows by with `ENT1` and with `GND1` (and its `GNB1`).
fn world_growth(m: &Match) -> (usize, usize) {
    let full = gz_len(m);
    let mut no_ent = m.clone();
    no_ent.map_entities.clear();
    no_ent.map_changes.clear();
    let mut no_gnd = m.clone();
    no_gnd.ground.clear();
    (full - gz_len(&no_ent), full - gz_len(&no_gnd))
}

#[test]
#[ignore = "needs $DEMOVIEWER_DEMOS/nuke.dem; run with --ignored"]
fn golden_nuke_doors_breakables_and_ground_items() {
    let dir = std::env::var("DEMOVIEWER_DEMOS").expect("DEMOVIEWER_DEMOS must be set");
    let t = Instant::now();
    let m = parse_file(&Path::new(&dir).join("nuke.dem")).expect("parse nuke.dem");
    let parse_secs = t.elapsed().as_secs_f64();
    let h = &m.header;
    assert_eq!(h.map, "de_nuke");

    let of_kind = |kind: MapEntityKind| -> Vec<usize> {
        (0..m.map_entities.len())
            .filter(|&i| m.map_entities[i].kind == kind)
            .collect()
    };
    let doors = of_kind(MapEntityKind::Door);
    assert_eq!(doors.len(), 4, "{:?}", m.map_entities);
    for spot in DOORS {
        let near = doors
            .iter()
            .filter(|&&i| distance(&m.map_entities[i], spot) <= 1.0)
            .count();
        assert_eq!(near, 1, "one door at {spot:?}: {:?}", m.map_entities);
    }
    for &i in &doors {
        let swings = (0..h.rounds.len()).any(|r| {
            let keys: Vec<_> = m
                .map_changes
                .iter()
                .filter(|c| c.round as usize == r && c.entity as usize == i)
                .collect();
            keys.first().is_some_and(|first| {
                keys.iter()
                    .any(|k| (80.0..=100.0).contains(&turned(first.yaw, k.yaw)))
            })
        });
        assert!(swings, "door {i} never swings open in a round");
    }

    // Both breakables survive the match: they are removed only when the demo ends, after the
    // last round_end.
    assert_eq!(of_kind(MapEntityKind::Breakable).len(), 2);
    assert!(m.map_changes.iter().all(|c| !c.gone));

    assert!(m.ground.len() > 50, "{} ground keys", m.ground.len());
    for g in &m.ground {
        let name = h.weapons[g.weapon as usize].as_str();
        assert!(GROUND_NAMES.contains(&name), "a ground item named {name:?}");
        assert_ne!(name, "C4 Explosive");
    }

    let inside = |round: u16, tick: i32| {
        let r = &h.rounds[round as usize];
        (r.start_tick..=r.post_end_tick.unwrap_or(r.end_tick)).contains(&tick)
    };
    for c in &m.map_changes {
        assert!(inside(c.round, c.tick), "{c:?}");
    }
    for g in &m.ground {
        assert!(inside(g.round, g.tick), "{g:?}");
    }

    let mut buf = Vec::new();
    demoviewer_pack::write(&m, &mut buf).expect("write pack");
    let back = demoviewer_pack::read(&mut &buf[..]).expect("read pack");
    assert!(back == m, "pack round-trip differs");

    let (ent, gnd) = world_growth(&m);
    let items = {
        let mut ids: Vec<(u16, u16)> = m.ground.iter().map(|g| (g.round, g.id)).collect();
        ids.dedup();
        ids.len()
    };
    let kits = m
        .ground
        .iter()
        .filter(|g| h.weapons[g.weapon as usize] == "defuser")
        .count();
    println!(
        "nuke: parse_file {parse_secs:.2}s; {} map entities, {} changes; {} ground keys \
         ({} gone, {kits} on kits) for {items} items; ENT1 +{ent} B, GND1+GNB1 +{gnd} B gzipped; \
         pack {} B",
        m.map_entities.len(),
        m.map_changes.len(),
        m.ground.len(),
        m.ground.iter().filter(|g| g.gone).count(),
        buf.len()
    );
    assert!(ent <= 8 * 1024, "ENT1 adds {ent} bytes");
    assert!(gnd <= 60 * 1024, "GND1 adds {gnd} bytes");
}
