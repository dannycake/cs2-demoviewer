//! Each tournament's first and last day, by its slug. Nothing the site holds says when a pro demo
//! was played: the demos carry no date and the corpus's datasets give none, so these come from the
//! tournaments' Liquipedia pages (`sdate` and `edate`). A tournament not listed here shows no
//! dates, or those of matches that have a day of their own ([`crate::events::list_events`]).

use crate::pages::civil_days;

/// A day: year, month, day, UTC.
type Day = (u64, u64, u64);

/// Slug, first day, last day, by slug.
const DATES: &[(&str, Day, Day)] = &[
    (
        "betboom_dacha_belgrade_season_2",
        (2024, 8, 24),
        (2024, 9, 1),
    ),
    (
        "blast_bounty_2025_season_1_finals",
        (2025, 1, 23),
        (2025, 1, 26),
    ),
    (
        "blast_bounty_2025_season_2_finals",
        (2025, 8, 14),
        (2025, 8, 17),
    ),
    (
        "blast_bounty_2026_season_1_finals",
        (2026, 1, 22),
        (2026, 1, 25),
    ),
    ("blast_bounty_2026_season_2", (2026, 7, 21), (2026, 8, 2)),
    ("blast_open_lisbon_2025", (2025, 3, 19), (2025, 3, 30)),
    ("blast_open_london_2025_finals", (2025, 9, 5), (2025, 9, 7)),
    ("blast_open_rotterdam_2026", (2026, 3, 18), (2026, 3, 29)),
    (
        "blast_premier_fall_final_2023",
        (2023, 11, 22),
        (2023, 11, 26),
    ),
    (
        "blast_premier_fall_final_2024",
        (2024, 9, 25),
        (2024, 9, 29),
    ),
    (
        "blast_premier_spring_final_2024",
        (2024, 6, 12),
        (2024, 6, 16),
    ),
    (
        "blast_premier_world_final_2023",
        (2023, 12, 13),
        (2023, 12, 17),
    ),
    (
        "blast_premier_world_final_2024",
        (2024, 10, 30),
        (2024, 11, 3),
    ),
    ("blast_rivals_2025_season_1", (2025, 4, 30), (2025, 5, 4)),
    ("blast_rivals_2025_season_2", (2025, 11, 12), (2025, 11, 16)),
    ("blast_rivals_2026_season_1", (2026, 4, 29), (2026, 5, 3)),
    ("blast_tv_austin_major_2025", (2025, 6, 3), (2025, 6, 22)),
    ("cac2026", (2026, 5, 20), (2026, 5, 24)),
    ("cs_asia_championships_2023", (2023, 11, 8), (2023, 11, 12)),
    ("elisa_masters_espoo_2023", (2023, 11, 29), (2023, 12, 3)),
    ("esl_pro_league_season_19", (2024, 4, 23), (2024, 5, 12)),
    ("esl_pro_league_season_20", (2024, 9, 3), (2024, 9, 22)),
    ("esl_pro_league_season_21", (2025, 3, 1), (2025, 3, 16)),
    ("esl_pro_league_season_22", (2025, 9, 28), (2025, 10, 12)),
    (
        "esl_pro_league_season_23_finals",
        (2026, 3, 13),
        (2026, 3, 15),
    ),
    (
        "esl_pro_league_season_23_stage_2",
        (2026, 3, 6),
        (2026, 3, 10),
    ),
    ("esports_world_cup_2024", (2024, 7, 17), (2024, 7, 21)),
    ("esports_world_cup_2025", (2025, 8, 20), (2025, 8, 24)),
    ("fissure_playground_2", (2025, 9, 12), (2025, 9, 21)),
    ("iem_atlanta_2026", (2026, 5, 11), (2026, 5, 17)),
    ("iem_chengdu_2024", (2024, 4, 8), (2024, 4, 14)),
    ("iem_chengdu_2025", (2025, 11, 3), (2025, 11, 9)),
    ("iem_cologne_2024", (2024, 8, 7), (2024, 8, 18)),
    ("iem_cologne_2025", (2025, 7, 23), (2025, 8, 3)),
    ("iem_cologne_major_2026", (2026, 6, 2), (2026, 6, 21)),
    ("iem_dallas_2024", (2024, 5, 27), (2024, 6, 2)),
    ("iem_dallas_2025", (2025, 5, 19), (2025, 5, 25)),
    ("iem_katowice_2024", (2024, 1, 31), (2024, 2, 11)),
    ("iem_katowice_2025", (2025, 1, 29), (2025, 2, 9)),
    ("iem_krakow_2026", (2026, 1, 28), (2026, 2, 8)),
    ("iem_rio_2024", (2024, 10, 7), (2024, 10, 13)),
    ("iem_rio_2026", (2026, 4, 13), (2026, 4, 19)),
    ("iem_sydney_2023", (2023, 10, 16), (2023, 10, 22)),
    (
        "perfect_world_shanghai_major_2024",
        (2024, 11, 30),
        (2024, 12, 15),
    ),
    (
        "perfect_world_shanghai_major_2024_europe_rmr_a",
        (2024, 11, 17),
        (2024, 11, 20),
    ),
    (
        "perfect_world_shanghai_major_2024_europe_rmr_b",
        (2024, 11, 21),
        (2024, 11, 24),
    ),
    ("pgl_astana_2026", (2026, 5, 9), (2026, 5, 17)),
    ("pgl_bucharest_2026", (2026, 4, 4), (2026, 4, 11)),
    ("pgl_cluj_napoca_2026", (2026, 2, 14), (2026, 2, 22)),
    (
        "pgl_cs2_major_copenhagen_2024",
        (2024, 3, 17),
        (2024, 3, 31),
    ),
    (
        "pgl_cs2_major_copenhagen_2024_europe_rmr_a",
        (2024, 2, 14),
        (2024, 2, 17),
    ),
    (
        "pgl_cs2_major_copenhagen_2024_europe_rmr_b",
        (2024, 2, 19),
        (2024, 2, 22),
    ),
    (
        "starladder_budapest_major_2025",
        (2025, 11, 24),
        (2025, 12, 14),
    ),
    (
        "thunderpick_world_championship_2023",
        (2023, 10, 27),
        (2023, 11, 5),
    ),
];

/// The first and last day of the tournament `slug`, as Unix times at the start of those days.
pub fn of(slug: &str) -> Option<(u64, u64)> {
    let at = DATES.binary_search_by_key(&slug, |d| d.0).ok()?;
    let (_, first, last) = DATES[at];
    Some((civil_days(first) * 86_400, civil_days(last) * 86_400))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::valid_slug;
    use crate::pages::date_of;

    #[test]
    fn the_table_is_in_slug_order_of_valid_slugs_with_each_end_after_its_start() {
        for pair in DATES.windows(2) {
            assert!(pair[0].0 < pair[1].0, "{} before {}", pair[0].0, pair[1].0);
        }
        for (slug, first, last) in DATES {
            assert!(valid_slug(slug), "{slug}");
            assert!(first <= last, "{slug}");
        }
    }

    #[test]
    fn a_tournament_is_found_by_its_slug_and_its_days_read_back() {
        let (first, last) = of("iem_cologne_major_2026").unwrap();
        assert_eq!(date_of(first), "Jun 2, 2026");
        assert_eq!(date_of(last), "Jun 21, 2026");
        assert_eq!(of("some_cup"), None);
    }
}
