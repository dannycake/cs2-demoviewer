//! Golden test against a real Valve matchmaking demo of Dust II recorded after CS2 began
//! sending 8-bit fields with the `fixed8` encoder (local only, never in git): `dust2_fixed8.dem`,
//! `match730_003855870534956875855_0913796105_274.dem`, server tree `csgo_v2000950`.
//!
//! Read as varints, the first such byte of 128 or more (a chicken's pose recipe, in every
//! full packet) took the bytes after it with it, and the demo failed with `EntityNotFound`.
//!
//! Run with `DEMOVIEWER_DEMOS=<dir> cargo test -p demoviewer-server --release -- --ignored`.

use std::path::Path;

use demoviewer_server::parse::parse_file;

#[test]
#[ignore = "needs $DEMOVIEWER_DEMOS/dust2_fixed8.dem; run with --ignored"]
fn golden_dust2_fixed8() {
    let dir = std::env::var("DEMOVIEWER_DEMOS").expect("DEMOVIEWER_DEMOS must be set");
    let m = parse_file(&Path::new(&dir).join("dust2_fixed8.dem"))
        .unwrap_or_else(|e| panic!("parse dust2_fixed8.dem: {e}"));
    let h = &m.header;

    assert_eq!(h.map, "de_dust2");
    assert_eq!(h.game_build, "14201");
    assert_eq!(h.players.len(), 10);
    // As this parser reads it: no independent analyzer has seen this demo.
    assert_eq!(h.rounds.len(), 18);
    let last = h.rounds.last().unwrap();
    assert_eq!((last.score_t, last.score_ct), (5, 13), "final score T:CT");
    // Every round is won by a side, and adds one to that side's score.
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
        before = after;
    }
    // `m_iTeamNum` is one of the fixed8 fields: five players a side, in every round.
    for (i, _) in h.rounds.iter().enumerate() {
        let side = |team: u8| {
            h.players
                .iter()
                .filter(|p| p.team_by_round[i] == team)
                .count()
        };
        assert_eq!((side(2), side(3)), (5, 5), "round {}", i + 1);
    }
}
