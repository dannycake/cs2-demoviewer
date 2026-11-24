use std::io::{ErrorKind, Read, Write};

use demoviewer_pack::{
    flags, gear, read, sample_tick, write, write_limited, Event, GrenadeTrack, GroundItem,
    InventoryChange, MapEntity, MapEntityChange, MapEntityKind, Match, MatchHeader, PlayerInfo,
    PlayerTrack, RoundInfo, RoundTracks, PACK_VERSION,
};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde_json::json;

const SAMPLES: u32 = 5;

fn track(seed: i16) -> PlayerTrack {
    let n = SAMPLES as usize;
    let s = |base: i16| {
        (0..n as i16)
            .map(|k| base.wrapping_add(k * 7))
            .collect::<Vec<i16>>()
    };
    let b = |base: u8| {
        (0..n as u8)
            .map(|k| base.wrapping_add(k * 3))
            .collect::<Vec<u8>>()
    };
    PlayerTrack {
        x: s(seed),
        y: s(-seed),
        z: vec![i16::MIN, -1, 0, 1, i16::MAX],
        yaw: vec![18000, -17999, 0, 9000, -9000],
        pitch: s(seed / 10),
        health: b(100),
        armor: b(seed as u8),
        flags: vec![
            flags::ALIVE,
            flags::ALIVE | flags::SCOPED,
            flags::ALIVE | flags::FLASHED | flags::HAS_BOMB,
            flags::ALIVE | flags::DEFUSING | flags::AIRBORNE | flags::WALKING,
            0,
        ],
        duck: vec![0, 64, 128, 255, 0],
        weapon: vec![0, 1, 2, 1, 0],
        money: vec![],
        ammo: vec![],
        gear: vec![],
    }
}

fn sample_match() -> Match {
    let rounds = vec![
        RoundInfo {
            number: 1,
            start_tick: 1000,
            freeze_end_tick: 2280,
            end_tick: 1008,
            winner: 2,
            reason: "t_killed".into(),
            score_t: 1,
            score_ct: 0,
            samples: SAMPLES,
            post_end_tick: None,
        },
        RoundInfo {
            number: 2,
            start_tick: 9000,
            freeze_end_tick: 10280,
            end_tick: 9008,
            winner: 3,
            reason: "bomb_defused".into(),
            score_t: 1,
            score_ct: 1,
            samples: SAMPLES,
            post_end_tick: None,
        },
    ];
    let header = MatchHeader {
        version: PACK_VERSION,
        map: "de_mirage".into(),
        server_name: "Valve CS2 Server (srcds)".into(),
        game_build: "14000".into(),
        tick_rate: 64,
        sample_hz: 32,
        tick_step: 2,
        players: vec![
            PlayerInfo {
                steamid: 76561198000000001,
                name: "alpha".into(),
                team_by_round: vec![2, 3],
                crosshair: None,
                rank: None,
            },
            PlayerInfo {
                steamid: 76561198099999999,
                name: "ブラボー \"q\"".into(),
                team_by_round: vec![3, 0],
                crosshair: None,
                rank: None,
            },
        ],
        rounds,
        weapons: vec!["none".into(), "ak47".into(), "knife".into()],
    };
    let events = vec![
        Event {
            tick: 1002,
            kind: "round_freeze_end".into(),
            data: serde_json::Map::new(),
        },
        Event {
            tick: 1004,
            kind: "player_death".into(),
            data: json!({
                "user_steamid": "76561198000000001",
                "user_idx": 0,
                "attacker_steamid": "76561198099999999",
                "attacker_idx": 1,
                "assister_steamid": null,
                "assister_idx": null,
                "headshot": true,
                "distance": 12.345678901234567,
                "weapon": "ak47"
            })
            .as_object()
            .unwrap()
            .clone(),
        },
        Event {
            tick: 9006,
            kind: "bomb_defused".into(),
            data: json!({"site": 426, "nested": {"a": [1, -2.5, "x"]}})
                .as_object()
                .unwrap()
                .clone(),
        },
    ];
    let grenades = vec![GrenadeTrack {
        entity_id: 321,
        kind: "smoke".into(),
        thrower: 1,
        start_tick: 9001,
        detonate_tick: Some(9005),
        expire_tick: None,
        x: vec![-1200, -1100, -1000, -950],
        y: vec![300, 310, 320, 321],
        z: vec![-160, -100, -80, -159],
    }];
    Match {
        header,
        rounds: vec![
            RoundTracks {
                players: vec![track(100), track(-2000)],
            },
            RoundTracks {
                players: vec![track(3000), track(i16::MAX)],
            },
        ],
        events,
        grenades,
        inventory: vec![],
        map_entities: vec![],
        map_changes: vec![],
        ground: vec![],
    }
}

fn to_pack(m: &Match) -> Vec<u8> {
    let mut out = Vec::new();
    write(m, &mut out).expect("write");
    out
}

fn gunzip(bytes: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    GzDecoder::new(bytes).read_to_end(&mut raw).expect("gunzip");
    raw
}

fn gzip(raw: &[u8]) -> Vec<u8> {
    let mut enc = GzEncoder::new(Vec::new(), Compression::fast());
    enc.write_all(raw).unwrap();
    enc.finish().unwrap()
}

/// A decoded section: tag and payload.
type Section = ([u8; 4], Vec<u8>);

/// Splits a decompressed pack into its version and `(tag, payload)` sections.
fn sections(raw: &[u8]) -> (u16, Vec<Section>) {
    assert_eq!(&raw[..4], b"DVPK");
    let version = u16::from_le_bytes([raw[4], raw[5]]);
    let mut out = Vec::new();
    let mut at = 6;
    while at < raw.len() {
        let tag: [u8; 4] = raw[at..at + 4].try_into().unwrap();
        let len = u64::from_le_bytes(raw[at + 4..at + 12].try_into().unwrap()) as usize;
        out.push((tag, raw[at + 12..at + 12 + len].to_vec()));
        at += 12 + len;
    }
    (version, out)
}

fn assemble(version: u16, secs: &[Section]) -> Vec<u8> {
    let mut raw = b"DVPK".to_vec();
    raw.extend_from_slice(&version.to_le_bytes());
    for (tag, payload) in secs {
        raw.extend_from_slice(tag);
        raw.extend_from_slice(&(payload.len() as u64).to_le_bytes());
        raw.extend_from_slice(payload);
    }
    raw
}

fn read_bytes(bytes: &[u8]) -> std::io::Result<Match> {
    read(&mut &bytes[..])
}

#[test]
fn roundtrip_preserves_every_field() {
    let m = sample_match();
    let bytes = to_pack(&m);
    assert_eq!(&bytes[..2], &[0x1f, 0x8b], "pack must be gzip");

    let raw = gunzip(&bytes);
    let (version, secs) = sections(&raw);
    assert_eq!(version, PACK_VERSION);
    let tags: Vec<&[u8]> = secs.iter().map(|(t, _)| &t[..]).collect();
    assert_eq!(tags, vec![&b"HDR1"[..], b"TRK1", b"EVT1", b"GRN1", b"GRB1"]);
    // TRK1: 2 rounds × 2 players × 5 samples × (5 × i16 + 5 × u8)
    assert_eq!(secs[1].1.len(), 2 * 2 * 5 * 15);
    // GRB1: 1 grenade × 4 samples × 3 × i16
    assert_eq!(secs[4].1.len(), 4 * 6);

    let back = read_bytes(&bytes).expect("read");
    let (h, bh) = (&m.header, &back.header);
    assert_eq!(bh.version, h.version);
    assert_eq!(bh.map, h.map);
    assert_eq!(bh.server_name, h.server_name);
    assert_eq!(bh.game_build, h.game_build);
    assert_eq!(bh.tick_rate, h.tick_rate);
    assert_eq!(bh.sample_hz, h.sample_hz);
    assert_eq!(bh.tick_step, h.tick_step);
    assert_eq!(bh.players, h.players);
    assert_eq!(bh.rounds, h.rounds);
    assert_eq!(bh.weapons, h.weapons);
    assert_eq!(back.rounds.len(), m.rounds.len());
    for (br, mr) in back.rounds.iter().zip(&m.rounds) {
        assert_eq!(br.players.len(), mr.players.len());
        for (bp, mp) in br.players.iter().zip(&mr.players) {
            assert_eq!(bp.x, mp.x);
            assert_eq!(bp.y, mp.y);
            assert_eq!(bp.z, mp.z);
            assert_eq!(bp.yaw, mp.yaw);
            assert_eq!(bp.pitch, mp.pitch);
            assert_eq!(bp.health, mp.health);
            assert_eq!(bp.armor, mp.armor);
            assert_eq!(bp.flags, mp.flags);
            assert_eq!(bp.duck, mp.duck);
            assert_eq!(bp.weapon, mp.weapon);
        }
    }
    assert_eq!(back.events, m.events);
    assert_eq!(back.grenades, m.grenades);
    assert_eq!(back, m);

    let r = &m.header.rounds[1];
    assert_eq!(sample_tick(r, h, 3), r.start_tick + 3 * h.tick_step as i32);
    assert_eq!(sample_tick(r, h, 0), r.start_tick);
}

#[test]
fn steamid_is_a_json_string() {
    // u64 steamids exceed JS's 2^53 safe-integer range; the browser must not see a number.
    let raw = gunzip(&to_pack(&sample_match()));
    let (_, secs) = sections(&raw);
    let hdr: serde_json::Value = serde_json::from_slice(&secs[0].1).unwrap();
    assert_eq!(hdr["players"][0]["steamid"], json!("76561198000000001"));
}

#[test]
fn garbage_after_magic_is_an_error_not_a_panic() {
    let mut seed = 0x2545_f491_u32;
    let garbage: Vec<u8> = (0..4096)
        .map(|_| {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (seed >> 24) as u8
        })
        .collect();
    let dvpk_garbage = [&b"DVPK"[..], &garbage].concat();

    // Not gzip at all.
    assert!(read_bytes(&dvpk_garbage).is_err());
    // Gzip'd, garbage after the magic.
    assert!(read_bytes(&gzip(&dvpk_garbage)).is_err());
    // Valid version, then garbage sections (huge declared length).
    assert!(read_bytes(&gzip(&[&b"DVPK\x01\x00"[..], &garbage].concat())).is_err());
    // A header section whose JSON is broken.
    let bad_hdr = assemble(1, &[(*b"HDR1", b"{bad".to_vec())]);
    assert!(read_bytes(&gzip(&bad_hdr)).is_err());
    // Wrong magic, unsupported version, empty stream.
    let raw = gunzip(&to_pack(&sample_match()));
    let mut wrong_magic = raw.clone();
    wrong_magic[..4].copy_from_slice(b"DVPX");
    assert!(read_bytes(&gzip(&wrong_magic)).is_err());
    let mut future = raw.clone();
    future[4..6].copy_from_slice(&(PACK_VERSION + 1).to_le_bytes());
    assert!(read_bytes(&gzip(&future)).is_err());
    assert!(read_bytes(&gzip(b"")).is_err());
    assert!(read_bytes(b"").is_err());
    // Truncated at every few bytes of the decompressed stream, and of the gzip stream.
    for cut in (0..raw.len()).step_by(7) {
        assert!(
            read_bytes(&gzip(&raw[..cut])).is_err(),
            "decompressed cut at {cut}"
        );
    }
    let packed = to_pack(&sample_match());
    for cut in 0..packed.len() - 8 {
        assert!(read_bytes(&packed[..cut]).is_err(), "gzip cut at {cut}");
    }
}

#[test]
fn missing_or_misordered_sections_are_errors() {
    let raw = gunzip(&to_pack(&sample_match()));
    let (v, secs) = sections(&raw);
    for skip in 0..secs.len() {
        let partial: Vec<_> = secs
            .iter()
            .enumerate()
            .filter(|(i, _)| *i != skip)
            .map(|(_, s)| s.clone())
            .collect();
        assert!(
            read_bytes(&gzip(&assemble(v, &partial))).is_err(),
            "missing section {skip}"
        );
    }
    // TRK1 before HDR1: the reader cannot know the sample counts.
    let swapped = [
        secs[1].clone(),
        secs[0].clone(),
        secs[2].clone(),
        secs[3].clone(),
        secs[4].clone(),
    ];
    assert!(read_bytes(&gzip(&assemble(v, &swapped))).is_err());
    // A known section twice.
    let doubled = [secs.clone(), vec![secs[2].clone()]].concat();
    assert!(read_bytes(&gzip(&assemble(v, &doubled))).is_err());
}

#[test]
fn track_length_mismatch_is_invalid_data() {
    let raw = gunzip(&to_pack(&sample_match()));
    let (v, mut secs) = sections(&raw);
    let mut header: MatchHeader = serde_json::from_slice(&secs[0].1).unwrap();
    header.rounds[1].samples = SAMPLES + 1;
    secs[0].1 = serde_json::to_vec(&header).unwrap();
    let err = read_bytes(&gzip(&assemble(v, &secs))).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");

    // Grenade sample count that disagrees with GRB1.
    let (v, mut secs) = sections(&raw);
    let mut gm: serde_json::Value = serde_json::from_slice(&secs[3].1).unwrap();
    gm[0]["samples"] = json!(5);
    secs[3].1 = serde_json::to_vec(&gm).unwrap();
    let err = read_bytes(&gzip(&assemble(v, &secs))).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");

    // team_by_round shorter than rounds.
    let (v, mut secs) = sections(&raw);
    let mut header: MatchHeader = serde_json::from_slice(&secs[0].1).unwrap();
    header.players[0].team_by_round.pop();
    secs[0].1 = serde_json::to_vec(&header).unwrap();
    let err = read_bytes(&gzip(&assemble(v, &secs))).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");
}

#[test]
fn unknown_section_is_skipped() {
    let m = sample_match();
    let raw = gunzip(&to_pack(&m));
    let (v, mut secs) = sections(&raw);
    secs.insert(1, (*b"ZZZ1", vec![0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]));
    secs.push((*b"ZZZ2", Vec::new()));
    let back = read_bytes(&gzip(&assemble(v, &secs))).expect("unknown tags must be ignored");
    assert_eq!(back, m);
}

#[test]
fn write_refuses_an_inconsistent_match() {
    let mut out = Vec::new();

    let mut m = sample_match();
    m.rounds[0].players[1].yaw.pop();
    assert_eq!(
        write(&m, &mut out).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );

    let mut m = sample_match();
    m.rounds.pop();
    assert_eq!(
        write(&m, &mut out).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );

    let mut m = sample_match();
    m.grenades[0].z.push(0);
    assert_eq!(
        write(&m, &mut out).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );

    let mut m = sample_match();
    m.rounds[1].players[0].weapon[2] = 3; // only 3 weapons
    assert_eq!(
        write(&m, &mut out).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );

    let mut m = sample_match();
    m.header.weapons[0] = "ak47".into();
    assert_eq!(
        write(&m, &mut out).unwrap_err().kind(),
        ErrorKind::InvalidInput
    );
}

#[test]
fn write_refuses_a_pack_that_would_inflate_past_the_limit() {
    let m = sample_match();
    let size = gunzip(&to_pack(&m)).len() as u64;
    let mut out = Vec::new();
    write_limited(&m, &mut out, size).expect("a pack exactly at the limit");
    assert_eq!(read_bytes(&out).unwrap(), m);
    let err = write_limited(&m, &mut Vec::new(), size - 1).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::FileTooLarge);
}

#[test]
fn empty_match_roundtrips() {
    let mut m = sample_match();
    m.header.rounds.clear();
    m.header.weapons.truncate(1);
    for p in &mut m.header.players {
        p.team_by_round.clear();
    }
    m.rounds.clear();
    m.events.clear();
    m.grenades.clear();
    assert_eq!(read_bytes(&to_pack(&m)).unwrap(), m);
}

/// `sample_match` with every optional field filled: money, ammo and gear on every track
/// (`TRK2`), inventory changes (`INV1`), crosshair codes and after-round ends.
fn first_person_match() -> Match {
    let mut m = sample_match();
    for (i, r) in m.header.rounds.iter_mut().enumerate() {
        r.post_end_tick = Some(r.end_tick + 400 + i as i32);
    }
    m.header.players[0].crosshair = Some("CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB".into());
    for (r, round) in m.rounds.iter_mut().enumerate() {
        for (p, t) in round.players.iter_mut().enumerate() {
            let n = t.x.len();
            t.money = (0..n)
                .map(|k| (800 + 1000 * r + 100 * p + k) as u16)
                .collect();
            t.money[0] = u16::MAX;
            t.ammo = (0..n)
                .map(|k| {
                    if k == 0 {
                        gear::AMMO_NONE
                    } else {
                        30 - k as u8
                    }
                })
                .collect();
            t.gear = (0..n)
                .map(|k| gear::pack(k % 2 == 0, p == 1, (k % 3) as u8))
                .collect();
        }
    }
    m.inventory = vec![
        InventoryChange {
            round: 0,
            player: 0,
            tick: 1000,
            items: vec![2, 1],
        },
        InventoryChange {
            round: 1,
            player: 1,
            tick: 9004,
            items: vec![],
        },
    ];
    m
}

#[test]
fn roundtrip_preserves_the_first_person_data() {
    let m = first_person_match();
    let bytes = to_pack(&m);
    let back = read_bytes(&bytes).expect("read");
    assert_eq!(back, m);
    let (_, secs) = sections(&gunzip(&bytes));
    let tags: Vec<&[u8]> = secs.iter().map(|(t, _)| &t[..]).collect();
    assert_eq!(
        tags,
        [
            &b"HDR1"[..],
            b"TRK1",
            b"EVT1",
            b"GRN1",
            b"GRB1",
            b"TRK2",
            b"INV1"
        ]
    );
    // 2 rounds × 2 players × 5 samples × 4 bytes.
    assert_eq!(secs[5].1.len(), 2 * 2 * 5 * 4);
}

#[test]
fn a_pack_without_the_optional_data_writes_no_optional_sections_and_reads_back_empty() {
    let m = sample_match();
    let (_, secs) = sections(&gunzip(&to_pack(&m)));
    assert!(secs.iter().all(|(t, _)| t != b"TRK2" && t != b"INV1"));
    let back = read_bytes(&to_pack(&m)).unwrap();
    assert!(back.inventory.is_empty());
    assert!(back
        .rounds
        .iter()
        .flat_map(|r| &r.players)
        .all(|t| t.money.is_empty() && t.gear.is_empty()));
    assert!(back.header.rounds.iter().all(|r| r.post_end_tick.is_none()));
    // And the header JSON carries no null fields for them.
    let hdr = String::from_utf8(sections(&gunzip(&to_pack(&m))).1[0].1.clone()).unwrap();
    assert!(!hdr.contains("post_end_tick") && !hdr.contains("crosshair"));
}

#[test]
fn the_first_person_sections_are_skipped_by_a_reader_that_does_not_know_them() {
    // What an older reader sees: the same pack with TRK2 and INV1 renamed to unknown tags.
    let m = first_person_match();
    let (version, mut secs) = sections(&gunzip(&to_pack(&m)));
    for (tag, _) in &mut secs {
        if tag == b"TRK2" {
            *tag = *b"ZZZ1";
        }
        if tag == b"INV1" {
            *tag = *b"ZZZ2";
        }
    }
    let back = read_bytes(&gzip(&assemble(version, &secs))).expect("read");
    assert!(back.inventory.is_empty());
    assert_eq!(back.header, m.header);
}

#[test]
fn first_person_data_that_breaks_the_rules_is_refused() {
    let refused = |m: &Match| {
        let mut out = Vec::new();
        write(m, &mut out).expect_err("write must refuse");
    };
    let mut m = first_person_match();
    m.rounds[1].players[0].ammo.pop();
    refused(&m);
    let mut m = first_person_match();
    m.rounds[0].players[1].money.clear();
    refused(&m);
    let mut m = first_person_match();
    m.inventory[0].items.push(9);
    refused(&m);
    let mut m = first_person_match();
    m.inventory[1].player = 7;
    refused(&m);
    let mut m = first_person_match();
    m.header.rounds[0].post_end_tick = Some(m.header.rounds[0].end_tick - 1);
    refused(&m);
    // A TRK2 whose length disagrees with the header is invalid data on read.
    let (version, mut secs) = sections(&gunzip(&to_pack(&first_person_match())));
    let trk2 = secs.iter_mut().find(|(t, _)| t == b"TRK2").unwrap();
    trk2.1.pop();
    let err = read_bytes(&gzip(&assemble(version, &secs))).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData);
}

fn change(round: u16, entity: u16, tick: i32, yaw: i16, gone: bool) -> MapEntityChange {
    MapEntityChange {
        round,
        entity,
        tick,
        pitch: 0,
        yaw,
        roll: 0,
        gone,
    }
}

fn ground(round: u16, id: u16, weapon: u8, tick: i32, z: i16, gone: bool) -> GroundItem {
    GroundItem {
        round,
        id,
        weapon,
        tick,
        x: -1200,
        y: 300,
        z,
        pitch: -1500,
        yaw: 4500,
        roll: 9000,
        gone,
    }
}

/// `first_person_match` with a door, a breakable and items on the ground (`ENT1`, `GND1`).
fn world_match() -> Match {
    let mut m = first_person_match();
    m.map_entities = vec![
        MapEntity {
            kind: MapEntityKind::Door,
            x: 257,
            y: -1310,
            z: -416,
        },
        MapEntity {
            kind: MapEntityKind::Breakable,
            x: -863,
            y: -2508,
            z: -89,
        },
    ];
    m.map_changes = vec![
        change(0, 0, 1000, 0, false),
        change(0, 0, 1029, -9000, false),
        change(0, 1, 1004, 0, true),
        change(1, 0, 9002, 17000, false),
        change(1, 0, 9004, -17000, false),
    ];
    m.ground = vec![
        ground(0, 412, 1, 1002, -100, false),
        ground(0, 412, 1, 1006, -160, false),
        ground(0, 412, 1, 1007, -160, true),
        ground(0, 500, 2, 1003, -150, false),
        ground(1, 87, 2, 9001, -159, false),
    ];
    m
}

#[test]
fn roundtrip_preserves_doors_breakables_and_ground_items() {
    let m = world_match();
    let bytes = to_pack(&m);
    assert_eq!(read_bytes(&bytes).expect("read"), m);
    let (_, secs) = sections(&gunzip(&bytes));
    let tags: Vec<&[u8]> = secs.iter().map(|(t, _)| &t[..]).collect();
    assert_eq!(
        tags,
        [
            &b"HDR1"[..],
            b"TRK1",
            b"EVT1",
            b"GRN1",
            b"GRB1",
            b"TRK2",
            b"INV1",
            b"ENT1",
            b"GND1",
            b"GNB1"
        ]
    );
    let ent: serde_json::Value = serde_json::from_slice(&secs[7].1).unwrap();
    assert_eq!(ent["entities"][0]["kind"], "door");
    assert_eq!(ent["entities"][1]["kind"], "breakable");
    assert_eq!(ent["changes"].as_array().unwrap().len(), 5);
    assert_eq!(ent["changes"][2]["gone"], true);
    // GND1: one entry per run of keys of one item; GNB1: their keys, 17 bytes each.
    let gnd: serde_json::Value = serde_json::from_slice(&secs[8].1).unwrap();
    assert_eq!(
        gnd,
        json!([
            {"round": 0, "id": 412, "weapon": 1, "keys": 3},
            {"round": 0, "id": 500, "weapon": 2, "keys": 1},
            {"round": 1, "id": 87, "weapon": 2, "keys": 1}
        ])
    );
    let gnb = &secs[9].1;
    assert_eq!(gnb.len(), 5 * 17);
    // Columns over all 5 keys in run order: tick as i32, then x, y, z, pitch, yaw, roll as
    // i16, then gone. A run's first value is as is, the next ones differences from the key
    // before.
    let i32s = |o: usize| -> Vec<i32> {
        (0..5)
            .map(|k| i32::from_le_bytes(gnb[o + 4 * k..o + 4 * k + 4].try_into().unwrap()))
            .collect()
    };
    let i16s = |o: usize| -> Vec<i16> {
        (0..5)
            .map(|k| i16::from_le_bytes(gnb[o + 2 * k..o + 2 * k + 2].try_into().unwrap()))
            .collect()
    };
    assert_eq!(i32s(0), [1002, 4, 1, 1003, 9001]);
    assert_eq!(i16s(20), [-1200, 0, 0, -1200, -1200]);
    assert_eq!(i16s(40), [-100, -60, 0, -150, -159]);
    assert_eq!(i16s(60), [4500, 0, 0, 4500, 4500]);
    assert_eq!(&gnb[80..85], [0, 0, 1, 0, 0]);
}

#[test]
fn ground_key_differences_wrap_without_loss() {
    let mut m = world_match();
    let g = &mut m.ground;
    (g[0].tick, g[1].tick, g[2].tick) = (i32::MIN, i32::MAX - 1, i32::MAX);
    (g[0].x, g[1].x, g[2].x) = (i16::MIN, i16::MAX, i16::MIN);
    (g[0].yaw, g[1].yaw, g[2].yaw) = (18000, -17999, 18000);
    assert_eq!(read_bytes(&to_pack(&m)).unwrap(), m);
}

#[test]
fn a_pack_without_world_entities_writes_no_ent1_or_gnd1_and_reads_back_empty() {
    for m in [sample_match(), first_person_match()] {
        let bytes = to_pack(&m);
        let (_, secs) = sections(&gunzip(&bytes));
        assert!(secs.iter().all(|(t, _)| t != b"ENT1" && t != b"GND1"));
        let back = read_bytes(&bytes).unwrap();
        assert!(back.map_entities.is_empty() && back.map_changes.is_empty());
        assert!(back.ground.is_empty());
    }
    // Ground items alone, and map entities alone, each write only their own section.
    let mut m = world_match();
    m.map_entities.clear();
    m.map_changes.clear();
    let (_, secs) = sections(&gunzip(&to_pack(&m)));
    assert_eq!(secs[secs.len() - 2].0, *b"GND1");
    assert_eq!(secs[secs.len() - 1].0, *b"GNB1");
    assert!(secs.iter().all(|(t, _)| t != b"ENT1"));
    assert_eq!(read_bytes(&to_pack(&m)).unwrap(), m);
    let mut m = world_match();
    m.ground.clear();
    let (_, secs) = sections(&gunzip(&to_pack(&m)));
    assert_eq!(secs.last().unwrap().0, *b"ENT1");
    assert_eq!(read_bytes(&to_pack(&m)).unwrap(), m);
}

#[test]
fn the_world_entity_sections_are_skipped_by_a_reader_that_does_not_know_them() {
    let m = world_match();
    let (version, mut secs) = sections(&gunzip(&to_pack(&m)));
    for (tag, _) in &mut secs {
        match &*tag {
            b"ENT1" => *tag = *b"ZZZ1",
            b"GND1" => *tag = *b"ZZZ2",
            b"GNB1" => *tag = *b"ZZZ3",
            _ => {}
        }
    }
    let back = read_bytes(&gzip(&assemble(version, &secs))).expect("read");
    assert!(back.map_entities.is_empty() && back.map_changes.is_empty());
    assert!(back.ground.is_empty());
    assert_eq!(back.header, m.header);
    assert_eq!(back.inventory, m.inventory);
}

#[test]
fn world_entities_that_break_the_rules_are_refused() {
    let refused = |m: &Match, why: &str| {
        let err = write(m, &mut Vec::new()).expect_err(why);
        assert_eq!(err.kind(), ErrorKind::InvalidInput, "{why}: {err}");
    };
    let mut m = world_match();
    m.map_changes[1].entity = 2;
    refused(&m, "a change of an entity out of range");
    let mut m = world_match();
    m.map_changes[3].round = 2;
    refused(&m, "a change in a round out of range");
    let mut m = world_match();
    m.map_changes.swap(0, 1);
    refused(&m, "changes out of order");
    let mut m = world_match();
    m.ground[0].weapon = 0;
    refused(&m, "a ground item that is no weapon");
    let mut m = world_match();
    m.ground[3].weapon = 3;
    refused(&m, "a ground item's weapon out of range");
    let mut m = world_match();
    m.ground[4].round = 2;
    refused(&m, "a ground item in a round out of range");
    let mut m = world_match();
    m.ground.swap(2, 3);
    refused(&m, "ground items out of order");

    // The reader refuses the same: an ENT1 whose change names an entity past the list.
    let (version, mut secs) = sections(&gunzip(&to_pack(&world_match())));
    let ent = secs.iter_mut().find(|(t, _)| t == b"ENT1").unwrap();
    let mut v: serde_json::Value = serde_json::from_slice(&ent.1).unwrap();
    v["changes"][0]["entity"] = json!(9);
    ent.1 = serde_json::to_vec(&v).unwrap();
    let err = read_bytes(&gzip(&assemble(version, &secs))).unwrap_err();
    assert_eq!(err.kind(), ErrorKind::InvalidData, "{err}");
}

#[test]
fn ground_sections_that_disagree_are_refused() {
    let (version, secs) = sections(&gunzip(&to_pack(&world_match())));
    let refused = |secs: &[Section], why: &str| {
        let err = read_bytes(&gzip(&assemble(version, secs))).expect_err(why);
        assert_eq!(err.kind(), ErrorKind::InvalidData, "{why}: {err}");
    };
    let at = |tag: &[u8; 4]| secs.iter().position(|(t, _)| t == tag).unwrap();
    // GNB1 a byte short, or a byte long, of what GND1 counts.
    let mut short = secs.clone();
    short[at(b"GNB1")].1.pop();
    refused(&short, "a short GNB1");
    let mut long = secs.clone();
    long[at(b"GNB1")].1.push(0);
    refused(&long, "a long GNB1");
    // Each without the other, and GNB1 first.
    let mut no_gnb = secs.clone();
    no_gnb.remove(at(b"GNB1"));
    refused(&no_gnb, "GND1 without GNB1");
    let mut no_gnd = secs.clone();
    no_gnd.remove(at(b"GND1"));
    refused(&no_gnd, "GNB1 without GND1");
    let mut swapped = secs.clone();
    swapped.swap(at(b"GND1"), at(b"GNB1"));
    refused(&swapped, "GNB1 before GND1");
    // A gone byte other than 0 or 1.
    let mut two = secs.clone();
    let gnb = &mut two[at(b"GNB1")].1;
    let last = gnb.len() - 1;
    gnb[last] = 2;
    refused(&two, "a gone byte of 2");
}
