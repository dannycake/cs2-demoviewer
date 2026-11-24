//! The pages' content as plain HTML, for `<div id="pre">` after the app's root
//! ([`crate::pages::into_pre`]): what a crawler, or a browser without scripts, reads before (or
//! instead of) the app's view, which removes it once it has its own content. Pure functions from
//! the server's types to strings; every string that came from a demo is escaped.

use crate::events::{valid_slug, EventMatch, EventSummary, HomeLinks};
use crate::matches::{MatchResult, MatchSummary, SummaryPlayer};
use crate::pages::{
    as_sent, date_of, escape, event_days, event_name, final_score, fixed, map_name, match_date,
    matches_count, opening_pct, page_title, thousands, venue,
};
use crate::profile::{FaceitRow, MatchRow, ProfileView, Totals};

/// What the home page says of the site, the words its visitors read too (HomeView.tsx).
const ABOUT: &str = include_str!("../guides/home.html");

/// How many of the newest matches the table lists.
const MATCH_ROWS: usize = 20;

/// A string of HTML built from escaped text and the builder's own tags.
struct Html(String);

impl Html {
    /// Appends markup written in this file (never text from a demo).
    fn raw(&mut self, markup: &str) -> &mut Self {
        self.0.push_str(markup);
        self
    }

    /// Appends `text`, escaped.
    fn text(&mut self, text: &str) -> &mut Self {
        self.0.push_str(&escape(text));
        self
    }

    /// Appends `<tag>text</tag>` with `text` escaped.
    fn element(&mut self, tag: &str, text: &str) -> &mut Self {
        self.raw(&format!("<{tag}>"))
            .text(text)
            .raw(&format!("</{tag}>"))
    }
}

/// The profile of `name` as the page's pre-rendered content: a heading, the ranks, the stat
/// strip over the counted matches, the maps, the newest matches linking to their pages, and a
/// tracked player's FACEIT matches linking to their replays or their rooms.
pub fn profile_html(view: &ProfileView, name: &str) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">"#)
        .text(name)
        .raw("</h1>");
    let mut ranks = Vec::new();
    if let Some(p) = view.premier.as_ref().filter(|p| p.rating > 0) {
        ranks.push(format!("Premier {}", thousands(p.rating)));
    }
    if let Some(c) = &view.competitive {
        ranks.push(format!("Competitive {} rank {}", map_name(&c.map), c.rank));
    }
    if !ranks.is_empty() {
        h.raw(r#"<p class="pre-sub">"#)
            .text(&ranks.join(" · "))
            .raw("</p>");
    }
    strip(&mut h, view);
    maps(&mut h, view);
    matches(&mut h, view);
    faceit(&mut h, view);
    h.raw("</main>");
    h.0
}

/// The match as the page's pre-rendered content: its title, a line of where and when, and a
/// table of players for each side, the winning side's first. `hidden` is the steamids of the
/// players who asked not to be shown (their names already replaced): their rows carry
/// `data-hidden` and no link, as a bot's (steamid `0`) have none.
pub fn match_html(m: &MatchSummary, hidden: &[String]) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">"#)
        .text(&page_title(m))
        .raw("</h1>");
    let rounds = if m.rounds == 1 {
        "1 round".to_owned()
    } else {
        format!("{} rounds", m.rounds)
    };
    let sub: Vec<String> = [venue(m), match_date(m), rounds]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect();
    h.raw(r#"<p class="pre-sub">"#)
        .text(&sub.join(" · "))
        .raw("</p>");
    // Its tournament, in words a reader and a search engine can follow.
    if let Some(slug) = m.event.as_deref().filter(|s| valid_slug(s)) {
        h.raw(r#"<p class="pre-sub"><a href="/events/"#)
            .text(slug)
            .raw(r#"">All "#)
            .text(&event_name(slug))
            .raw(" demos</a></p>");
    }
    for (score, side) in final_score(m) {
        let mut players: Vec<&SummaryPlayer> =
            m.players.iter().filter(|p| p.team == side).collect();
        players.sort_by_key(|p| std::cmp::Reverse(p.kills));
        let name = if side == 3 { "CT" } else { "T" };
        h.raw(r#"<table class="pre-table"><caption>"#)
            .text(&format!("{name} {score}"))
            .raw("</caption><thead><tr><th>Player</th><th>K</th><th>A</th><th>D</th><th>ADR</th><th>HS%</th></tr></thead><tbody>");
        for p in players {
            player_row(&mut h, p, m.rounds, hidden.contains(&p.steamid));
        }
        h.raw("</tbody></table>");
    }
    h.raw("</main>");
    h.0
}

/// "{n} matches · {first} – {last}": how much of an event is held and when it was played; the
/// day once when the first and the last fall on it (as the web app's `range()`), and only the
/// matches when its dates are not known.
fn event_span(e: &EventSummary) -> String {
    let matches = matches_count(e.matches);
    match event_days(e, " – ") {
        Some(days) => format!("{matches} · {days}"),
        None => matches,
    }
}

/// The tournaments as the page's pre-rendered content: a heading and a list linking each to its
/// page with its match count and dates.
pub fn events_html(events: &[EventSummary]) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">CS2 tournament demos</h1><p>Pro CS2 tournaments, every match a 3D replay you can watch in your browser with each player's stats.</p><ul class="pre-list">"#);
    for e in events {
        h.raw(r#"<li><a href="/events/"#)
            .text(&e.slug)
            .raw(r#"">"#)
            .text(&e.name)
            .raw("</a> · ")
            .text(&event_span(e))
            .raw("</li>");
    }
    h.raw("</ul></main>");
    h.0
}

/// The home page as its pre-rendered content: what the site is, the newest tournaments, each
/// linking to its page, then all of them (`/events`), and the guides. The list is
/// [`crate::events::home_links`]'s; the home page names no players. With no events the
/// tournaments are the link to `/events` alone.
pub fn home_html(links: &HomeLinks) -> String {
    let mut h = Html(String::new());
    h.raw(
        r#"<main class="pre"><h1 class="pre-h">Watch CS2 demos in 3D, right in your browser.</h1>"#,
    )
    .raw(ABOUT)
    .raw("<h2>Tournaments</h2>");
    h.raw(r#"<ul class="pre-list">"#);
    for e in &links.events {
        h.raw(r#"<li><a href="/events/"#)
            .text(&e.slug)
            .raw(r#"">"#)
            .text(&e.name)
            .raw("</a></li>");
    }
    h.raw(r#"<li><a href="/events">All tournaments</a></li></ul>"#);
    h.raw(r#"<h2>Guides</h2><ul class="pre-list">"#);
    for g in &crate::guides::GUIDES {
        h.raw(r#"<li><a href="/guides/"#)
            .text(g.slug)
            .raw(r#"">"#)
            .text(g.title)
            .raw("</a></li>");
    }
    h.raw("</ul></main>");
    h.0
}

/// A guide as the page's pre-rendered content: its title, then its HTML fragment (first-party,
/// static: [`crate::guides`]).
pub fn guide_html(title: &str, body: &str) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">"#)
        .text(title)
        .raw("</h1>")
        .raw(body)
        .raw("</main>");
    h.0
}

/// The guides as the page's pre-rendered content: a heading and a link to each.
pub fn guides_html(title: &str) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">"#)
        .text(title)
        .raw(r#"</h1><ul class="pre-list">"#);
    for g in &crate::guides::GUIDES {
        h.raw(r#"<li><a href="/guides/"#)
            .text(g.slug)
            .raw(r#"">"#)
            .text(g.title)
            .raw("</a></li>");
    }
    h.raw("</ul></main>");
    h.0
}

/// One tournament as the page's pre-rendered content: its name, how much of it is held, and a
/// table of its matches (date, map, score, top fragger, a link to the replay).
pub fn event_html(event: &EventSummary, matches: &[EventMatch]) -> String {
    let mut h = Html(String::new());
    h.raw(r#"<main class="pre"><h1 class="pre-h">"#)
        .text(&event.name)
        .raw(r#"</h1><p class="pre-sub">"#)
        .text(&event_span(event))
        .raw(r#"</p><table class="pre-table"><thead><tr>"#);
    // A Date column only when some match has a day of its own: the corpus's have none.
    let dated = matches.iter().any(|m| m.played_unix.is_some());
    if dated {
        h.raw("<th>Date</th>");
    }
    h.raw("<th>Map</th>");
    // A Teams column only when the corpus named the teams of some match.
    let teams = matches.iter().any(|m| m.teams.is_some());
    if teams {
        h.raw("<th>Teams</th>");
    }
    h.raw("<th>Score</th><th>Top</th><th>Replay</th></tr></thead><tbody>");
    for m in matches {
        h.raw("<tr>");
        if dated {
            h.element("td", &m.played_unix.map_or_else(|| "—".to_owned(), date_of));
        }
        h.raw(r#"<td><a href="/d/"#)
            .text(&m.demo_id)
            .raw(r#"">"#)
            .text(&map_name(&m.map))
            .raw("</a></td>");
        if teams {
            let versus = m.teams.as_ref().map(|[a, b]| format!("{a} vs {b}"));
            h.element("td", versus.as_deref().unwrap_or("—"));
        }
        h.element("td", &format!("{}–{}", m.score[0], m.score[1]))
            .element("td", m.top.as_deref().unwrap_or("—"))
            .raw(r#"<td><a href="/d/"#)
            .text(&m.demo_id)
            .raw(r#"">Replay</a></td></tr>"#);
    }
    h.raw("</tbody></table></main>");
    h.0
}

/// One player's row: linked to their profile unless hidden or a bot; ADR over the match's
/// `rounds`, HS% over their kills (a dash without any).
fn player_row(h: &mut Html, p: &SummaryPlayer, rounds: u16, hidden: bool) {
    let adr = f64::from(p.damage) / f64::from(rounds.max(1));
    let hs = if p.kills == 0 {
        "—".to_owned()
    } else {
        fixed(f64::from(p.headshots) / f64::from(p.kills) * 100.0, 0)
    };
    h.raw(if hidden { "<tr data-hidden>" } else { "<tr>" });
    if hidden || p.steamid == "0" {
        h.element("td", &p.name);
    } else {
        h.raw(r#"<td><a href="/profiles/"#)
            .text(&p.steamid)
            .raw(r#"">"#)
            .text(&p.name)
            .raw("</a></td>");
    }
    h.element("td", &p.kills.to_string())
        .element("td", &p.assists.to_string())
        .element("td", &p.deaths.to_string())
        .element("td", &fixed(adr, 0))
        .element("td", &hs)
        .raw("</tr>");
}

/// The six strip figures over `t`, in the app's order, each with its label; a dash for what the
/// counted matches do not give. The top strip and each map's sub-row both read from here.
fn strip_cells(t: &Totals) -> [(String, &'static str); 6] {
    let dash = || "—".to_owned();
    [
        (
            t.rating.map_or_else(dash, |r| fixed(as_sent(r), 2)),
            "rating",
        ),
        (
            opening_pct(t.opening_won, t.opening_lost)
                .map_or_else(dash, |p| format!("{}%", fixed(p, 0))),
            "opening",
        ),
        (t.kd.map_or_else(dash, |k| fixed(as_sent(k), 2)), "K/D"),
        (t.adr.map_or_else(dash, |a| fixed(as_sent(a), 0)), "ADR"),
        (t.hs_pct.map_or_else(dash, |x| fixed(as_sent(x), 0)), "HS%"),
        (
            t.matches.to_string(),
            if t.matches == 1 { "match" } else { "matches" },
        ),
    ]
}

/// The figures strip over the counted matches.
fn strip(h: &mut Html, view: &ProfileView) {
    h.raw(r#"<ul class="pre-strip">"#);
    for (figure, label) in strip_cells(&view.totals) {
        h.raw("<li>")
            .element("b", &figure)
            .raw(" ")
            .text(label)
            .raw("</li>");
    }
    h.raw("</ul>");
}

/// The per-map table, each map's row followed by one spanning row of its strip figures as a
/// line of text ("1.31 rating · 52% opening · ..."); nothing without a map.
fn maps(h: &mut Html, view: &ProfileView) {
    if view.maps.is_empty() {
        return;
    }
    h.raw(r#"<table class="pre-table"><caption>Maps</caption><thead><tr><th>Map</th><th>Matches</th><th>Win %</th><th>Rating</th></tr></thead><tbody>"#);
    for m in &view.maps {
        let win = m
            .win_pct
            .map_or("—".to_owned(), |w| format!("{}%", fixed(as_sent(w), 0)));
        let rating = m.rating.map_or("—".to_owned(), |r| fixed(as_sent(r), 2));
        h.raw("<tr>")
            .element("td", &map_name(&m.map))
            .element("td", &m.matches.to_string())
            .element("td", &win)
            .element("td", &rating)
            .raw("</tr>");
        let line: Vec<String> = strip_cells(&m.totals)
            .into_iter()
            .map(|(figure, label)| format!("{figure} {label}"))
            .collect();
        h.raw(r#"<tr class="pre-sub-row"><td colspan="4">"#)
            .text(&line.join(" · "))
            .raw("</td></tr>");
    }
    h.raw("</tbody></table>");
}

/// The newest matches, each linking to its page; nothing without a match.
fn matches(h: &mut Html, view: &ProfileView) {
    if view.matches.is_empty() {
        return;
    }
    h.raw(r#"<table class="pre-table"><caption>Matches</caption><thead><tr><th>Result</th><th>Map</th><th>Score</th><th>K–D</th><th>Rating</th></tr></thead><tbody>"#);
    for m in view.matches.iter().take(MATCH_ROWS) {
        row(h, m);
    }
    h.raw("</tbody></table>");
}

/// One match's row.
fn row(h: &mut Html, m: &MatchRow) {
    let result = match m.result {
        Some(MatchResult::Win) => "W",
        Some(MatchResult::Loss) => "L",
        Some(MatchResult::Tie) => "T",
        None => "—",
    };
    let score = m.score.map_or("—".to_owned(), |[a, b]| format!("{a}–{b}"));
    let rating = m.rating.map_or("—".to_owned(), |r| fixed(as_sent(r), 2));
    h.raw("<tr>")
        .element("td", result)
        .raw(r#"<td><a href="/d/"#)
        .text(&m.demo_id)
        .raw(r#"">"#)
        .text(&map_name(&m.map))
        .raw("</a></td>")
        .element("td", &score)
        .element("td", &format!("{}–{}", m.kills, m.deaths))
        .element("td", &rating)
        .raw("</tr>");
}

/// The player's FACEIT matches, as FACEIT gave them, each linking to its replay when the site
/// holds its demo, else to its room on FACEIT; nothing without one.
fn faceit(h: &mut Html, view: &ProfileView) {
    if view.faceit_history.is_empty() {
        return;
    }
    h.raw(r#"<table class="pre-table"><caption>On FACEIT</caption><thead><tr><th>Date</th><th>Map</th><th>Score</th><th>Result</th><th>Competition</th><th>Watch</th></tr></thead><tbody>"#);
    for m in &view.faceit_history {
        faceit_row(h, m);
    }
    h.raw("</tbody></table>");
}

/// One FACEIT match's row; a dash for what FACEIT did not say.
fn faceit_row(h: &mut Html, m: &FaceitRow) {
    let result = match m.won {
        Some(true) => "W",
        Some(false) => "L",
        None => "—",
    };
    let score = m.score.map_or("—".to_owned(), |[a, b]| format!("{a}–{b}"));
    h.raw("<tr>")
        .element("td", &date_of(m.finished_unix))
        .element("td", &m.map.as_deref().map_or("—".to_owned(), map_name))
        .element("td", &score)
        .element("td", result)
        .element("td", m.competition.as_deref().unwrap_or("—"));
    match &m.replay {
        Some(id) => h
            .raw(r#"<td><a href="/d/"#)
            .text(id)
            .raw(r#"">Replay</a></td>"#),
        None => h
            .raw(r#"<td><a href=""#)
            .text(&m.room_url)
            .raw(r#"" target="_blank" rel="noopener noreferrer">Watch on FACEIT</a></td>"#),
    };
    h.raw("</tr>");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matches::{GameMode, MatchSummary, SummaryPlayer};
    use crate::profile::{
        build_profile, FaceitRow, MapLine, MatchRef, ReplayTotals, TrackingState,
    };
    use demoviewer_pack::PlayerRank;
    use std::sync::Arc;

    const ME: u64 = 76561198000000001;

    /// One Wingman match of two a side, the player in it on a Wingman rank.
    fn wingman() -> MatchRef {
        let line = |i: u64, team: u8| SummaryPlayer {
            steamid: (ME + i).to_string(),
            name: format!("p{i}"),
            team,
            kills: 12,
            deaths: 8,
            rounds: 16,
            rank: Some(PlayerRank {
                kind: 7,
                value: 5,
                wins: 10,
                if_win: 0,
                if_loss: 0,
                if_tie: 0,
            }),
            ..SummaryPlayer::default()
        };
        MatchRef {
            summary: Arc::new(MatchSummary {
                sha256: "w".into(),
                map: "de_inferno".into(),
                rounds: 16,
                score_t: 9,
                score_ct: 7,
                players: vec![line(0, 2), line(1, 2), line(2, 3), line(3, 3)],
                created_unix: 10,
                played_unix: Some(10),
                mode: Some(GameMode::Wingman),
                ..MatchSummary::default()
            }),
            demo_id: "id-w".into(),
        }
    }

    #[test]
    fn a_profile_with_no_counted_matches_shows_dashes() {
        let view = build_profile(ME, &[wingman()], None, TrackingState::Off, |_| false);
        let html = profile_html(&view, "skunk");
        for dash in ["rating", "opening", "K/D", "ADR", "HS%"] {
            assert!(html.contains(&format!("<b>—</b> {dash}")), "{dash}: {html}");
        }
        assert!(html.contains("<b>0</b> matches"), "{html}");
        assert!(html.contains(r#"<a href="/d/id-w">"#), "{html}");
    }

    /// A 13–9 match the CTs won: `(steamid, name, team, kills)` for each player given.
    fn scoreboard(players: &[(&str, &str, u8, u16)]) -> MatchSummary {
        MatchSummary {
            map: "de_mirage".into(),
            rounds: 22,
            score_t: 9,
            score_ct: 13,
            players: players
                .iter()
                .map(|&(steamid, name, team, kills)| SummaryPlayer {
                    steamid: steamid.into(),
                    name: name.into(),
                    team,
                    kills,
                    deaths: 10,
                    assists: 3,
                    damage: 2200,
                    headshots: 5,
                    ..SummaryPlayer::default()
                })
                .collect(),
            ..MatchSummary::default()
        }
    }

    #[test]
    fn the_winning_side_is_listed_first() {
        let m = scoreboard(&[
            ("1", "tee", 2, 30),
            ("2", "low", 3, 5),
            ("3", "high", 3, 15),
        ]);
        let html = match_html(&m, &[]);
        let ct = html.find("<caption>CT 13</caption>").expect(&html);
        let t = html.find("<caption>T 9</caption>").expect(&html);
        assert!(ct < t, "{html}");
        assert!(
            html.find("high").unwrap() < html.find("low").unwrap(),
            "{html}"
        );
        assert!(html.contains(r#"<a href="/profiles/1">tee</a>"#), "{html}");
        assert!(html.contains("<td>100</td><td>33</td>"), "{html}");
        assert!(html.contains("22 rounds"), "{html}");
    }

    #[test]
    fn hidden_and_bot_players_have_no_link() {
        let m = scoreboard(&[("5", "—", 3, 4), ("0", "Bot Ed", 3, 3), ("7", "ok", 3, 0)]);
        let html = match_html(&m, &["5".to_owned()]);
        assert!(html.contains("<tr data-hidden><td>—</td>"), "{html}");
        assert!(html.contains("<td>Bot Ed</td>"), "{html}");
        assert!(!html.contains("/profiles/5"), "{html}");
        assert!(!html.contains("/profiles/0"), "{html}");
        assert!(html.contains(r#"<a href="/profiles/7">ok</a>"#), "{html}");
        assert!(html.contains("<td>—</td></tr>"), "no kills, no HS%: {html}");
    }

    #[test]
    fn a_hostile_player_name_is_escaped() {
        let m = scoreboard(&[("9", "<script>x</script>", 2, 1)]);
        let html = match_html(&m, &[]);
        assert!(html.contains("&lt;script&gt;"), "{html}");
        assert!(!html.contains("<script>"), "{html}");
    }

    /// An event's dates as the web app's `range()` writes them: one day when the first and the
    /// last match fall on it, else both.
    #[test]
    fn an_events_span_names_one_day_once() {
        let event = |first_unix, last_unix| EventSummary {
            slug: "cup".into(),
            name: "Cup".into(),
            matches: 2,
            first_unix: Some(first_unix),
            last_unix: Some(last_unix),
        };
        // 2025-10-22 20:00 UTC, the same day at 23:59:59, and two days on.
        assert_eq!(
            event_span(&event(1_761_163_200, 1_761_177_599)),
            "2 matches · Oct 22, 2025"
        );
        assert_eq!(
            event_span(&event(1_761_163_200, 1_761_300_000)),
            "2 matches · Oct 22, 2025 – Oct 24, 2025"
        );
        let unknown = EventSummary {
            first_unix: None,
            last_unix: None,
            ..event(0, 0)
        };
        assert_eq!(event_span(&unknown), "2 matches");
    }

    #[test]
    fn names_are_escaped() {
        let view = build_profile(ME, &[], None, TrackingState::Off, |_| false);
        let html = profile_html(&view, "</div><script>x</script>");
        assert!(html.contains("&lt;/div&gt;&lt;script&gt;"), "{html}");
        assert!(!html.contains("<script>"), "{html}");
    }

    /// A profile over no matches whose maps are `maps`.
    fn view_with(maps: Vec<MapLine>) -> ProfileView {
        let mut view = build_profile(ME, &[], None, TrackingState::Off, |_| false);
        view.maps = maps;
        view
    }

    /// Totals over no matches: every figure unknown.
    fn no_totals() -> Totals {
        build_profile(ME, &[], None, TrackingState::Off, |_| false).totals
    }

    fn map_line(map: &str, totals: Totals) -> MapLine {
        MapLine {
            map: map.into(),
            matches: totals.matches,
            win_pct: None,
            rating: None,
            rank: None,
            totals,
            replay: ReplayTotals::default(),
        }
    }

    #[test]
    fn map_rows_carry_the_strip_under_them() {
        let known = Totals {
            rating: Some(1.31),
            opening_won: 13,
            opening_lost: 12,
            kd: Some(1.2),
            adr: Some(84.0),
            hs_pct: Some(41.0),
            matches: 12,
            ..no_totals()
        };
        let single = Totals {
            matches: 1,
            ..no_totals()
        };
        let view = view_with(vec![
            map_line("de_mirage", known),
            map_line("de_inferno", single),
        ]);
        let html = profile_html(&view, "skunk");
        let row = r#"<tr class="pre-sub-row"><td colspan="4">"#;
        assert!(
            html.contains(&format!(
                "{row}1.31 rating · 52% opening · 1.20 K/D · 84 ADR · 41 HS% · 12 matches</td></tr>"
            )),
            "{html}"
        );
        assert!(
            html.contains(&format!(
                "{row}— rating · — opening · — K/D · — ADR · — HS% · 1 match</td></tr>"
            )),
            "{html}"
        );
        let mirage = html.find("Mirage").expect(&html);
        let sub = html.find(row).expect(&html);
        let inferno = html.find("Inferno").expect(&html);
        assert!(mirage < sub && sub < inferno, "{html}");
    }

    /// A row of the player's FACEIT history, of FACEIT match `id`, its replay `replay`.
    fn faceit_line(id: &str, replay: Option<&str>) -> FaceitRow {
        FaceitRow {
            match_id: id.into(),
            // 2025-10-22.
            finished_unix: 1_761_163_200,
            map: Some("de_mirage".into()),
            score: Some([13, 9]),
            won: Some(true),
            competition: Some("CS2 5v5".into()),
            replay: replay.map(str::to_owned),
            room_url: format!("https://www.faceit.com/en/cs2/room/{id}"),
        }
    }

    #[test]
    fn faceit_rows_link_their_replay_or_else_their_room() {
        let mut view = view_with(vec![]);
        view.faceit_history = vec![
            faceit_line("1-a", Some("id-a")),
            FaceitRow {
                map: None,
                score: None,
                won: None,
                competition: Some("<b>hub</b>".into()),
                ..faceit_line("1-b", None)
            },
            FaceitRow {
                won: Some(false),
                score: Some([7, 13]),
                ..faceit_line("1-c", None)
            },
        ];
        let html = profile_html(&view, "skunk");
        assert!(
            html.contains(
                r#"<table class="pre-table"><caption>On FACEIT</caption><thead><tr><th>Date</th><th>Map</th><th>Score</th><th>Result</th><th>Competition</th><th>Watch</th></tr></thead>"#
            ),
            "{html}"
        );
        assert!(
            html.contains(
                r#"<tr><td>Oct 22, 2025</td><td>Mirage</td><td>13–9</td><td>W</td><td>CS2 5v5</td><td><a href="/d/id-a">Replay</a></td></tr>"#
            ),
            "{html}"
        );
        assert!(
            html.contains(
                r#"<tr><td>Oct 22, 2025</td><td>—</td><td>—</td><td>—</td><td>&lt;b&gt;hub&lt;/b&gt;</td><td><a href="https://www.faceit.com/en/cs2/room/1-b" target="_blank" rel="noopener noreferrer">Watch on FACEIT</a></td></tr>"#
            ),
            "{html}"
        );
        assert!(html.contains("<td>7–13</td><td>L</td>"), "{html}");
    }

    #[test]
    fn a_profile_with_no_faceit_history_has_no_faceit_table() {
        let html = profile_html(&view_with(vec![]), "skunk");
        assert!(!html.contains("FACEIT"), "{html}");
    }

    #[test]
    fn a_profile_with_no_maps_has_no_map_rows() {
        let html = profile_html(&view_with(vec![]), "skunk");
        assert!(!html.contains("<caption>Maps</caption>"), "{html}");
        assert!(!html.contains("pre-sub-row"), "{html}");
    }

    #[test]
    fn a_hostile_map_name_is_escaped_in_both_rows() {
        let view = view_with(vec![map_line("<script>x</script>", no_totals())]);
        let html = profile_html(&view, "skunk");
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("pre-sub-row"), "{html}");
    }
}
