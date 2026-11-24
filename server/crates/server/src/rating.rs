//! The performance rating: one number per player per match, ~1.00 for an average player.
//!
//! How it is worked out (the FAQ line): each player's match is turned into six rates per round
//! they played — kills, survival (rounds they did not die), KAST (rounds with a kill, an assist,
//! survival or a traded death), damage, multi-kill rounds (2 to 5 kills in a round, weighted by
//! the square of the kills, so one 4k counts for more than four single kills) and opening duels
//! won — and each rate is divided by its average over the matches we hold. The rating is the
//! weighted sum: kills 25 %, survival 20 %, KAST 20 %, damage 20 %, multi-kills 10 %, opening
//! duels 5 %. A player exactly at every average rates 1.00; 1.20 is a fifth better than the
//! average line. It is modelled on HLTV's public ratings, computed only from demos we parsed.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::matches::SummaryPlayer;

/// The least rounds a line needs to count towards the norms: a player who joined for two
/// rounds would pull every average towards noise.
pub const CALIBRATION_MIN_ROUNDS: u16 = 10;

/// The weights of the six parts (they sum to 1, so a line at the norms rates 1.00).
const W_KILLS: f64 = 0.25;
const W_SURVIVAL: f64 = 0.20;
const W_KAST: f64 = 0.20;
const W_DAMAGE: f64 = 0.20;
const W_MULTI: f64 = 0.10;
const W_OPENING: f64 = 0.05;

/// The weight of a round with 2, 3, 4 and 5+ kills in the multi-kill part: the kills squared.
const MULTI_POINTS: [f64; 4] = [4.0, 9.0, 16.0, 25.0];

/// One player's numbers in one match, as the rating reads them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct RatingLine {
    /// Rounds on a side; every rate is per one of them.
    pub rounds: u16,
    pub kills: u16,
    pub deaths: u16,
    pub assists: u16,
    pub damage: u32,
    pub kast_rounds: u16,
    pub multi_kills: [u16; 4],
    pub opening_wins: u16,
    pub opening_losses: u16,
}

impl From<&SummaryPlayer> for RatingLine {
    fn from(p: &SummaryPlayer) -> Self {
        RatingLine {
            rounds: p.rounds,
            kills: p.kills,
            deaths: p.deaths,
            assists: p.assists,
            damage: p.damage,
            kast_rounds: p.kast_rounds,
            multi_kills: p.multi_kills,
            opening_wins: p.opening_wins,
            opening_losses: p.opening_losses,
        }
    }
}

/// The corpus's average of each per-round rate, which a rate is divided by.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct RatingNorms {
    /// Kills per round.
    pub kills: f64,
    /// Rounds survived per round (1 − deaths per round, at least 0).
    pub survival: f64,
    /// KAST rounds per round.
    pub kast: f64,
    /// Damage per round (ADR).
    pub damage: f64,
    /// Multi-kill points per round ([`MULTI_POINTS`]).
    pub multi: f64,
    /// Opening duels won per round.
    pub opening: f64,
    /// How many lines the averages are over.
    pub lines: u32,
}

/// The six per-round rates of a line with rounds, in [`RatingNorms`]' order.
fn rates(l: &RatingLine) -> Option<[f64; 6]> {
    if l.rounds == 0 {
        return None;
    }
    let r = f64::from(l.rounds);
    let multi: f64 = l
        .multi_kills
        .iter()
        .zip(MULTI_POINTS)
        .map(|(&n, w)| f64::from(n) * w)
        .sum();
    Some([
        f64::from(l.kills) / r,
        (f64::from(l.rounds) - f64::from(l.deaths)).max(0.0) / r,
        f64::from(l.kast_rounds) / r,
        f64::from(l.damage) / r,
        multi / r,
        f64::from(l.opening_wins) / r,
    ])
}

/// The rating of `line` against `norms`; `None` without rounds; never negative.
pub fn rating(line: &RatingLine, norms: &RatingNorms) -> Option<f32> {
    let x = rates(line)?;
    let means = [
        norms.kills,
        norms.survival,
        norms.kast,
        norms.damage,
        norms.multi,
        norms.opening,
    ];
    let weights = [W_KILLS, W_SURVIVAL, W_KAST, W_DAMAGE, W_MULTI, W_OPENING];
    // A part whose average is 0 (a corpus without a single multi-kill, say) counts as average.
    let r: f64 = x
        .iter()
        .zip(means)
        .zip(weights)
        .map(|((&x, m), w)| w * if m > 0.0 { x / m } else { 1.0 })
        .sum();
    Some(r.max(0.0) as f32)
}

/// The norms of `lines`: each rate's mean over the lines with at least
/// [`CALIBRATION_MIN_ROUNDS`] rounds. The rating is linear in the rates, so those lines then
/// average exactly 1.00.
pub fn calibrate(lines: &[RatingLine]) -> RatingNorms {
    let used: Vec<[f64; 6]> = lines
        .iter()
        .filter(|l| l.rounds >= CALIBRATION_MIN_ROUNDS)
        .filter_map(rates)
        .collect();
    let mean = |i: usize| {
        if used.is_empty() {
            0.0
        } else {
            used.iter().map(|r| r[i]).sum::<f64>() / used.len() as f64
        }
    };
    RatingNorms {
        kills: mean(0),
        survival: mean(1),
        kast: mean(2),
        damage: mean(3),
        multi: mean(4),
        opening: mean(5),
        lines: u32::try_from(used.len()).unwrap_or(u32::MAX),
    }
}

/// The committed norms (`rating-norms.json`), parsed once.
pub fn norms() -> &'static RatingNorms {
    static NORMS: LazyLock<RatingNorms> = LazyLock::new(|| {
        serde_json::from_str(include_str!("rating-norms.json")).expect("rating-norms.json")
    });
    &NORMS
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{rngs::StdRng, Rng, SeedableRng};

    /// A line `rounds` long at exactly the norms' per-round rates.
    fn at_norms(n: &RatingNorms, rounds: u16) -> RatingLine {
        let r = f64::from(rounds);
        let x = |rate: f64| (rate * r).round() as u16;
        RatingLine {
            rounds,
            kills: x(n.kills),
            deaths: rounds - x(n.survival),
            assists: 0,
            damage: (n.damage * r).round() as u32,
            kast_rounds: x(n.kast),
            multi_kills: [x(n.multi / 4.0), 0, 0, 0],
            opening_wins: x(n.opening),
            opening_losses: 0,
        }
    }

    fn norms_of(
        kills: f64,
        survival: f64,
        kast: f64,
        damage: f64,
        multi: f64,
        opening: f64,
    ) -> RatingNorms {
        RatingNorms {
            kills,
            survival,
            kast,
            damage,
            multi,
            opening,
            lines: 1,
        }
    }

    fn line() -> RatingLine {
        RatingLine {
            rounds: 20,
            kills: 16,
            deaths: 14,
            assists: 4,
            damage: 1600,
            kast_rounds: 14,
            multi_kills: [3, 1, 0, 0],
            opening_wins: 3,
            opening_losses: 3,
        }
    }

    #[test]
    fn a_line_at_the_norms_rates_one() {
        // Rates that come out whole over 20 rounds.
        let n = norms_of(0.75, 0.30, 0.70, 80.0, 0.20, 0.10);
        let l = at_norms(&n, 20);
        assert!(
            (rating(&l, &n).unwrap() - 1.0).abs() < 0.001,
            "{:?}",
            rating(&l, &n)
        );
    }

    #[test]
    fn calibrated_norms_average_one_over_their_lines() {
        let mut rng = StdRng::seed_from_u64(7);
        let lines: Vec<RatingLine> = (0..300)
            .map(|_| {
                let rounds = rng.gen_range(16..30);
                RatingLine {
                    rounds,
                    kills: rng.gen_range(0..40),
                    deaths: rng.gen_range(0..rounds),
                    assists: rng.gen_range(0..10),
                    damage: rng.gen_range(0..4000),
                    kast_rounds: rng.gen_range(0..=rounds),
                    multi_kills: [
                        rng.gen_range(0..6),
                        rng.gen_range(0..3),
                        rng.gen_range(0..2),
                        0,
                    ],
                    opening_wins: rng.gen_range(0..6),
                    opening_losses: rng.gen_range(0..6),
                }
            })
            .collect();
        let n = calibrate(&lines);
        assert_eq!(n.lines, 300);
        let mean = lines.iter().filter_map(|l| rating(l, &n)).sum::<f32>() / lines.len() as f32;
        assert!((mean - 1.0).abs() < 0.01, "{mean}");
    }

    #[test]
    fn more_kills_rate_higher_all_else_equal() {
        let n = norms();
        let more = RatingLine {
            kills: 20,
            ..line()
        };
        assert!(rating(&more, n) > rating(&line(), n));
    }

    #[test]
    fn more_deaths_rate_lower_all_else_equal() {
        let n = norms();
        let more = RatingLine {
            deaths: 18,
            ..line()
        };
        assert!(rating(&more, n) < rating(&line(), n));
    }

    #[test]
    fn opening_wins_rate_higher_than_opening_losses() {
        let n = norms();
        let won = RatingLine {
            opening_wins: 6,
            opening_losses: 0,
            ..line()
        };
        let lost = RatingLine {
            opening_wins: 0,
            opening_losses: 6,
            ..line()
        };
        assert!(rating(&won, n) > rating(&lost, n));
    }

    #[test]
    fn a_multi_kill_round_rates_higher_than_the_same_kills_spread_out() {
        let n = norms();
        // The same 16 kills: four of them in one round, against no round with more than one.
        let bunched = RatingLine {
            multi_kills: [0, 0, 1, 0],
            ..line()
        };
        let spread = RatingLine {
            multi_kills: [0, 0, 0, 0],
            ..line()
        };
        assert!(rating(&bunched, n) > rating(&spread, n));
    }

    #[test]
    fn zero_rounds_has_no_rating_and_none_is_negative() {
        let n = norms();
        assert_eq!(
            rating(
                &RatingLine {
                    rounds: 0,
                    ..line()
                },
                n
            ),
            None
        );
        let worst = RatingLine {
            rounds: 20,
            kills: 0,
            deaths: 40, // more deaths than rounds: a broken line still rates 0, not below
            assists: 0,
            damage: 0,
            kast_rounds: 0,
            multi_kills: [0; 4],
            opening_wins: 0,
            opening_losses: 20,
        };
        assert_eq!(rating(&worst, n), Some(0.0));
    }

    #[test]
    fn the_committed_norms_parse() {
        assert!(norms().lines > 0);
        assert!(norms().kills > 0.0 && norms().damage > 0.0);
    }

    #[derive(serde::Deserialize)]
    struct Case {
        norms: RatingNorms,
        line: RatingLine,
        rating: Option<f32>,
    }

    #[test]
    fn rating_cases_match_the_fixture() {
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/rating-cases.json")).unwrap();
        assert_eq!(cases.len(), 8);
        for (i, c) in cases.iter().enumerate() {
            match (rating(&c.line, &c.norms), c.rating) {
                (Some(got), Some(want)) => {
                    assert!((got - want).abs() < 0.0005, "case {i}: {got} vs {want}")
                }
                (got, want) => assert_eq!(got, want, "case {i}"),
            }
        }
    }

    /// The committed norms rate the corpus they came from at 1.00 on average.
    #[test]
    #[ignore = "needs DEMOVIEWER_CORPUS_SUMMARIES=<dir of matches/*.json>; run with --ignored"]
    fn corpus_average_is_one() {
        let dir =
            std::env::var("DEMOVIEWER_CORPUS_SUMMARIES").expect("DEMOVIEWER_CORPUS_SUMMARIES");
        let mut ratings = Vec::new();
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_some_and(|e| e == "json") {
                let s: crate::matches::MatchSummary =
                    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
                for p in &s.players {
                    let l = RatingLine::from(p);
                    if l.rounds >= CALIBRATION_MIN_ROUNDS {
                        ratings.extend(rating(&l, norms()));
                    }
                }
            }
        }
        assert!(!ratings.is_empty());
        let mean = ratings.iter().sum::<f32>() / ratings.len() as f32;
        assert!(
            (0.99..=1.01).contains(&mean),
            "{mean} over {} lines",
            ratings.len()
        );
    }
}
