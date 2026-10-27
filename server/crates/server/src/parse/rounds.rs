//! Round boundaries, results and scores from the round lifecycle events.

use std::cmp::Ordering;

use parser::maps::ROUND_WIN_REASON;
use parser::second_pass::game_events::GameEvent;
use parser::second_pass::variants::Variant;

use super::events::{field, int_field};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct RoundSpan {
    pub start_tick: i32,
    pub freeze_end_tick: i32,
    pub end_tick: i32,
    /// 2 = T, 3 = CT, 0 = unknown.
    pub winner: u8,
    /// A `RoundEndReason` name such as `"t_killed"`, from [`reason_name`].
    pub reason: String,
    /// `(t, ct)` team scores read at the `round_end` tick, when the event carries them. Some
    /// builds have already counted the round by then and some have not: see [`scores`].
    pub score: Option<(u8, u8)>,
}

/// The `RoundEndReason` name for a numeric code, as the parser names it on builds where it
/// decodes the reason itself (`9` → `"ct_killed"`); an unknown code stays a number.
pub(super) fn reason_name(code: i64) -> String {
    i32::try_from(code)
        .ok()
        .and_then(|c| ROUND_WIN_REASON.get(&c))
        .map_or_else(|| code.to_string(), |name| name.to_string())
}

/// `round_end`'s winner (2 = T, 3 = CT, 0 = unknown) and reason name. Build 14185 carries
/// `"T"`/`"CT"` and a reason name (the parser synthesises the event); build 13984 carries the
/// game event's numeric team and `RoundEndReason` code.
pub(super) fn round_result(end: &GameEvent) -> (u8, String) {
    let winner = match field(end, "winner") {
        Some(Variant::String(s)) if s == "T" => 2,
        Some(Variant::String(s)) if s == "CT" => 3,
        _ => match int_field(end, "winner") {
            Some(w @ (2 | 3)) => w as u8,
            _ => 0,
        },
    };
    let reason = match field(end, "reason") {
        Some(Variant::String(s)) => s.parse().map_or_else(|_| s.clone(), reason_name),
        _ => int_field(end, "reason").map_or_else(String::new, reason_name),
    };
    (winner, reason)
}

/// The match's rounds, from `events` sorted by tick.
///
/// Warmup is skipped: rounds start at the round in progress at the last
/// `round_announce_match_start` (which fires when the first live round's freeze time ends),
/// or failing that at the last `begin_new_match`. A round whose `round_end` does not come
/// before the next `round_start` (warmup, or a demo cut short) is dropped.
pub(super) fn find_rounds(events: &[GameEvent]) -> Vec<RoundSpan> {
    let ticks_of = |name: &'static str| {
        events
            .iter()
            .filter(move |e| e.name == name)
            .map(|e| e.tick)
    };
    let starts: Vec<i32> = ticks_of("round_start").collect();
    let freeze_ends: Vec<i32> = ticks_of("round_freeze_end").collect();
    let ends: Vec<&GameEvent> = events.iter().filter(|e| e.name == "round_end").collect();
    let anchor = ticks_of("round_announce_match_start")
        .next_back()
        .or_else(|| ticks_of("begin_new_match").next_back());
    let first = anchor.map_or(0, |a| starts.partition_point(|&t| t <= a).saturating_sub(1));

    let mut rounds = Vec::new();
    for (i, &start) in starts.iter().enumerate().skip(first) {
        let next = starts.get(i + 1).copied().unwrap_or(i32::MAX);
        let Some(end) = ends.iter().find(|e| e.tick > start && e.tick < next) else {
            continue;
        };
        let freeze_end_tick = freeze_ends
            .iter()
            .copied()
            .find(|&t| t >= start && t <= end.tick)
            .unwrap_or(start);
        let (winner, reason) = round_result(end);
        let score = match (int_field(end, "t_score"), int_field(end, "ct_score")) {
            (Some(t), Some(ct)) => Some((t.clamp(0, 255) as u8, ct.clamp(0, 255) as u8)),
            _ => None,
        };
        rounds.push(RoundSpan {
            start_tick: start,
            freeze_end_tick,
            end_tick: end.tick,
            winner,
            reason,
            score,
        });
    }
    rounds
}

/// When the team-score prop read at `round_end` reflects the round.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Timing {
    /// Already counts the round (as on build 14185).
    Current,
    /// Still the score before the round, in the round's sides (as on build 13984): the
    /// game updates it a tick after `round_end`.
    Lagged,
}

/// `(t, ct)` scores after each round. `teams[p][r]` is player p's side in round r.
///
/// The score `round_end` carries is checked against the running score: it is taken as is when
/// it equals the running score plus the round (current), and plus the round when it equals the
/// running score (lagged), either way allowing for the sides having swapped. A score that fits
/// neither (a demo that starts mid-match) is read in the timing the demo's other rounds show.
/// Without a score, or without a timing, the round is counted: one more win for the winner's
/// side, after swapping the counts when most players who were on a side in both rounds
/// changed sides (halftime).
pub(super) fn scores(rounds: &[RoundSpan], teams: &[Vec<u8>]) -> Vec<(u8, u8)> {
    let timing = score_timing(rounds);
    let mut score = (0u8, 0u8);
    let mut out = Vec::with_capacity(rounds.len());
    for (r, round) in rounds.iter().enumerate() {
        let won = |s| add_win(s, round.winner);
        let before = [score, swap(score)];
        score = match round.score {
            Some(s) if before.iter().any(|&b| won(b) == s) => s,
            Some(s) if before.contains(&s) => won(s),
            Some(s) if timing == Some(Timing::Current) => s,
            Some(s) if timing == Some(Timing::Lagged) => won(s),
            _ if r > 0 && sides_swapped(teams, r) => won(swap(score)),
            _ => won(score),
        };
        out.push(score);
    }
    out
}

/// How the demo's `round_end` scores are timed, from the rounds whose score follows from the
/// previous round's (0:0 before the first); `None` when the rounds do not say.
fn score_timing(rounds: &[RoundSpan]) -> Option<Timing> {
    let (mut current, mut lagged) = (0, 0);
    // The previous round's score as read, and its winner.
    let mut prev = Some(((0, 0), 0));
    for round in rounds {
        if let (Some((read, winner)), Some(s)) = (prev, round.score) {
            if [read, swap(read)]
                .iter()
                .any(|&b| add_win(b, round.winner) == s)
            {
                current += 1;
            }
            let after = add_win(read, winner);
            if s == after || s == swap(after) {
                lagged += 1;
            }
        }
        prev = round.score.map(|s| (s, round.winner));
    }
    match current.cmp(&lagged) {
        Ordering::Greater => Some(Timing::Current),
        Ordering::Less => Some(Timing::Lagged),
        Ordering::Equal => None,
    }
}

fn add_win((t, ct): (u8, u8), winner: u8) -> (u8, u8) {
    match winner {
        2 => (t.saturating_add(1), ct),
        3 => (t, ct.saturating_add(1)),
        _ => (t, ct),
    }
}

fn swap((t, ct): (u8, u8)) -> (u8, u8) {
    (ct, t)
}

/// Whether most players who were on a side in both rounds `r - 1` and `r` changed sides.
fn sides_swapped(teams: &[Vec<u8>], r: usize) -> bool {
    let (mut same, mut swapped) = (0, 0);
    for p in teams {
        match (p[r - 1], p[r]) {
            (0, _) | (_, 0) => {}
            (a, b) if a == b => same += 1,
            _ => swapped += 1,
        }
    }
    swapped > same
}

#[cfg(test)]
mod tests {
    use super::super::events::test_events::ev;
    use super::*;

    fn end(tick: i32, winner: &str, reason: &str, score: Option<(i32, i32)>) -> GameEvent {
        let mut f = vec![
            ("winner", Variant::String(winner.into())),
            ("reason", Variant::String(reason.into())),
        ];
        if let Some((t, ct)) = score {
            f.push(("t_score", Variant::I32(t)));
            f.push(("ct_score", Variant::I32(ct)));
        }
        ev("round_end", tick, &f)
    }

    #[test]
    fn skips_warmup_and_cut_short_rounds() {
        let events = [
            ev("round_start", 10, &[]), // warmup
            ev("round_start", 100, &[]),
            ev("begin_new_match", 101, &[]),
            ev("round_freeze_end", 200, &[]),
            ev("round_announce_match_start", 200, &[]),
            end(500, "CT", "t_killed", Some((0, 1))),
            ev("round_start", 600, &[]),
            ev("round_freeze_end", 700, &[]),
            end(900, "T", "bomb_exploded", Some((1, 1))),
            ev("round_start", 1000, &[]), // demo ends before round_end
        ];
        let rounds = find_rounds(&events);
        assert_eq!(
            rounds,
            [
                RoundSpan {
                    start_tick: 100,
                    freeze_end_tick: 200,
                    end_tick: 500,
                    winner: 3,
                    reason: "t_killed".into(),
                    score: Some((0, 1)),
                },
                RoundSpan {
                    start_tick: 600,
                    freeze_end_tick: 700,
                    end_tick: 900,
                    winner: 2,
                    reason: "bomb_exploded".into(),
                    score: Some((1, 1)),
                },
            ]
        );
    }

    #[test]
    fn falls_back_to_begin_new_match_and_drops_endless_warmup_round() {
        let events = [
            ev("round_start", 10, &[]),
            ev("begin_new_match", 99, &[]),
            ev("round_start", 100, &[]),
            end(500, "T", "ct_killed", None),
        ];
        let rounds = find_rounds(&events);
        assert_eq!(rounds.len(), 1);
        assert_eq!(
            (rounds[0].start_tick, rounds[0].freeze_end_tick),
            (100, 100)
        );
    }

    #[test]
    fn numeric_round_end_fields_read_like_named_ones() {
        // Build 13984: the game event's own team number and RoundEndReason code.
        let old = ev(
            "round_end",
            5,
            &[("winner", Variant::I32(2)), ("reason", Variant::I32(9))],
        );
        assert_eq!(round_result(&old), (2, "ct_killed".to_string()));
        let surrender = ev(
            "round_end",
            5,
            &[("winner", Variant::U32(2)), ("reason", Variant::U32(18))],
        );
        assert_eq!(round_result(&surrender), (2, "ct_surrender".to_string()));
        // Build 14185: decoded by the parser, which leaves unknown codes as number strings.
        assert_eq!(
            round_result(&end(5, "CT", "t_killed", None)),
            (3, "t_killed".to_string())
        );
        assert_eq!(
            round_result(&end(5, "CT", "7", None)),
            (3, "bomb_defused".to_string())
        );
        assert_eq!(
            round_result(&end(5, "99", "99", None)),
            (0, "99".to_string())
        );
    }

    fn span(winner: u8, score: Option<(u8, u8)>) -> RoundSpan {
        RoundSpan {
            start_tick: 0,
            freeze_end_tick: 0,
            end_tick: 0,
            winner,
            reason: String::new(),
            score,
        }
    }

    /// Rounds won by T, T, then (sides swapped) T and CT: 1:0, 2:0, then 1:2, 1:3.
    const WINNERS: [u8; 4] = [2, 2, 2, 3];
    const AFTER: [(u8, u8); 4] = [(1, 0), (2, 0), (1, 2), (1, 3)];

    fn spans(read: [(u8, u8); 4]) -> Vec<RoundSpan> {
        WINNERS
            .iter()
            .zip(read)
            .map(|(&w, s)| span(w, Some(s)))
            .collect()
    }

    #[test]
    fn scores_read_after_the_round_are_used_as_is() {
        assert_eq!(scores(&spans(AFTER), &[]), AFTER);
    }

    #[test]
    fn scores_read_before_the_round_counts_get_it_added() {
        // Build 13984 updates the team score a tick after round_end; across halftime the
        // score read is already in the new sides.
        let read = [(0, 0), (1, 0), (0, 2), (1, 2)];
        assert_eq!(scores(&spans(read), &[]), AFTER);
    }

    #[test]
    fn a_demo_starting_mid_match_keeps_the_score_it_reads() {
        // The first round's score fits neither timing; the later rounds say which applies.
        let current = [span(2, Some((6, 3))), span(3, Some((6, 4)))];
        assert_eq!(scores(&current, &[]), [(6, 3), (6, 4)]);
        let lagged = [span(2, Some((5, 3))), span(3, Some((6, 3)))];
        assert_eq!(scores(&lagged, &[]), [(6, 3), (6, 4)]);
        // A lone round says nothing about timing: counted.
        assert_eq!(scores(&[span(2, Some((5, 3)))], &[]), [(1, 0)]);
    }

    #[test]
    fn counted_scores_follow_the_halftime_swap() {
        // Team A is CT for two rounds then T; team B the reverse.
        let teams = vec![vec![3, 3, 2], vec![3, 3, 2], vec![2, 2, 3], vec![0, 2, 3]];
        let s = scores(&[span(3, None), span(3, None), span(2, None)], &teams);
        assert_eq!(s, [(0, 1), (0, 2), (3, 0)]);
    }
}
