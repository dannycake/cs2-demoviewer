//! A file that is not a CS2 demo must come back as `Err` (or, for a truncated demo, as a
//! `Match` with no complete rounds), never as a panic or a hang.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use demoviewer_server::parse::{parse_demo, parse_file, round_samples, MAX_ROUND_TICKS};
use parser::first_pass::read_bits::Bitreader;

#[test]
fn rejects_text() {
    let err = parse_demo(b"not a demo").unwrap_err();
    println!("text: {err}");
}

#[test]
fn rejects_empty_and_short_input() {
    assert!(parse_demo(b"").is_err());
    assert!(parse_demo(b"PBDEMS2\0").is_err());
}

#[test]
fn rejects_source1_demo() {
    let bytes = [&b"HL2DEMO\0"[..], &[0u8; 2000][..]].concat();
    let err = parse_demo(&bytes).unwrap_err();
    println!("HL2DEMO: {err}");
}

#[test]
fn rejects_cs2_magic_followed_by_garbage() {
    // xorshift64: deterministic "random" bytes without a dependency.
    let mut s: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut bytes = b"PBDEMS2\0".to_vec();
    bytes.extend((0..65_536).map(|_| {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s as u8
    }));
    let err = parse_demo(&bytes).unwrap_err();
    println!("PBDEMS2 + garbage: {err}");
}

#[test]
fn truncated_demo_errors_or_has_no_rounds() {
    let Some(dir) = std::env::var_os("DEMOVIEWER_DEMOS") else {
        println!("note: DEMOVIEWER_DEMOS is not set; skipping the truncated-demo check");
        return;
    };
    let mut bytes = Vec::new();
    File::open(Path::new(&dir).join("mirage.dem"))
        .expect("open mirage.dem")
        .take(4_000_000)
        .read_to_end(&mut bytes)
        .expect("read mirage.dem");
    match parse_demo(&bytes) {
        Err(e) => println!("truncated: Err({e})"),
        Ok(m) => {
            println!(
                "truncated: Ok, {} rounds, {} events",
                m.header.rounds.len(),
                m.events.len()
            );
            assert_eq!(
                m.header.rounds.len(),
                0,
                "a cut-short round must be dropped"
            );
            assert_eq!(m.rounds.len(), 0);
        }
    }
}

/// A 6-byte snappy frame whose header claims `u32::MAX` bytes once decompressed. The parser
/// used to allocate and zero 4 GiB for it, and aborted the whole process under a memory
/// limit. It must be refused before anything is allocated.
#[test]
fn a_frame_claiming_gigabytes_is_refused_before_allocating() {
    let mut bytes = b"PBDEMS2\0".to_vec();
    bytes.extend([0u8; 8]);
    // cmd 0x41 (compressed DemFileHeader), tick 0, size 6, then the snappy length varint.
    bytes.extend([0x41, 0x00, 0x06, 0xff, 0xff, 0xff, 0xff, 0x0f, 0x00, 0x00]);
    assert_eq!(bytes.len(), 26);
    let err = parse_demo(&bytes).unwrap_err();
    assert!(err.0.contains("claims 4294967295 bytes"), "{err}");
}

/// A length read from the bit stream is checked against what is left before it is allocated.
#[test]
fn a_length_past_the_end_of_the_stream_is_refused_before_allocating() {
    let data = [7u8; 16];
    let mut r = Bitreader::new(&data);
    assert!(r.ensure_bytes_left(17).is_err());
    assert!(r.read_n_bytes(u32::MAX as usize).is_err());
    assert_eq!(r.read_n_bytes(16).unwrap(), [7u8; 16]);
}

/// Round ticks come from the demo's frame headers, so the tracks they size are bounded: one
/// round, and all rounds times all players together.
#[test]
fn round_lengths_and_the_track_budget_are_bounded() {
    assert_eq!(
        round_samples([(100, 300), (400, 400)], 2, 10).unwrap(),
        [101, 1]
    );
    let hour = i32::try_from(MAX_ROUND_TICKS).unwrap();
    assert_eq!(round_samples([(0, hour)], 2, 10).unwrap(), [115_201]);
    let err = round_samples([(5, 6), (0, hour + 1)], 2, 10).unwrap_err();
    assert!(
        err.0.contains("round 2") && err.0.contains("60-minute"),
        "{err}"
    );
    // The review's edited demo moved the last round_end to tick 0x7F000000; and a span that
    // overflows an i32 difference.
    assert!(round_samples([(56_000, 0x7F00_0000)], 2, 10).is_err());
    assert!(round_samples([(i32::MIN, i32::MAX)], 2, 10).is_err());

    // Hour-long rounds pass one by one, but not 6 of them with 10 players (6.9 million
    // samples).
    let rounds: Vec<(i32, i32)> = (0..6).map(|r| (r * hour, (r + 1) * hour)).collect();
    assert!(round_samples(rounds[..5].iter().copied(), 2, 10).is_ok());
    let err = round_samples(rounds.iter().copied(), 2, 10).unwrap_err();
    assert!(err.0.contains("too long to replay"), "{err}");
}

/// A demo file the server cannot open fails with a fixed message: the path and the OS error go
/// to the log, not into the demo's record (code-health review 2026-10-26: "open
/// /data/tmp/<id>.dem: No such file or directory").
#[test]
fn an_unreadable_file_names_no_path() {
    let err = parse_file(Path::new("/nonexistent/demoviewer/abc.dem")).unwrap_err();
    assert_eq!(
        err.to_string(),
        "the server could not read the demo; try again later"
    );
}
