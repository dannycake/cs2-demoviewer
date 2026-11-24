//! Tournaments: `/api/events`, `/api/events/{slug}`, `/api/home`, and the pages `/events` and
//! `/events/{slug}` with their matches in the body.

mod common;

use axum::http::StatusCode;
use common::{
    call, demo, link_rel, meta, page, pre_body, sha, site, summary, Server, CREATED, PLAYED,
};
use demoviewer_server::hidden;
use demoviewer_server::matches::MatchSummary;
use demoviewer_server::store::Status;
use serde_json::Value;

/// Stores a done match of `event` played at `at`; returns its demo id.
fn stored(s: &Server, tag: u8, event: &str, at: u64) -> String {
    let sha = sha(tag);
    let mut m: MatchSummary = summary(&sha);
    m.event = Some(event.into());
    m.played_unix = Some(at);
    demo(&s.store, Status::Done, &sha, Some(m))
}

async fn json(s: &Server, uri: &str) -> (StatusCode, Value) {
    let (status, _, body) = call(&s.app, uri).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn events_are_listed_newest_first_with_counts() {
    let s = site(|c| c);
    stored(&s, 1, "old_cup", PLAYED);
    stored(&s, 2, "new_cup", PLAYED + 10 * 86_400);
    stored(&s, 3, "old_cup", PLAYED + 86_400);
    let (status, v) = json(&s, "/api/events").await;
    assert_eq!(status, StatusCode::OK);
    let v = v.as_array().unwrap();
    assert_eq!(v.len(), 2);
    assert_eq!(v[0]["slug"], "new_cup");
    assert_eq!(v[0]["name"], "New Cup");
    assert_eq!(v[0]["matches"], 1);
    assert_eq!(v[1]["slug"], "old_cup");
    assert_eq!(v[1]["matches"], 2);
    assert_eq!(v[1]["firstUnix"], PLAYED);
    assert_eq!(v[1]["lastUnix"], PLAYED + 86_400);
}

#[tokio::test]
async fn an_events_matches_are_one_per_sha_newest_first() {
    let s = site(|c| c);
    stored(&s, 1, "cup", PLAYED);
    // A second copy of the same pack: still one match, under the first done id.
    demo(&s.store, Status::Done, &sha(1), None);
    // The id profiles link to: the pack's oldest done one.
    let first = s.store.find_by_sha(&sha(1)).unwrap().id;
    let newest = stored(&s, 2, "cup", PLAYED + 86_400);
    stored(&s, 3, "other", PLAYED);
    // A match with no done demo is not listed.
    let pending = sha(4);
    let mut m = summary(&pending);
    m.event = Some("cup".into());
    demo(&s.store, Status::Parsing, &pending, Some(m));
    let (status, v) = json(&s, "/api/events/cup").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["event"]["slug"], "cup");
    let m = v["matches"].as_array().unwrap();
    let ids: Vec<&str> = m.iter().map(|x| x["demoId"].as_str().unwrap()).collect();
    assert_eq!(ids, [newest.as_str(), first.as_str()]);
    assert_eq!(m[0]["map"], "de_mirage");
    assert_eq!(m[0]["title"], "Mirage 13–9");
    assert_eq!(m[0]["score"], serde_json::json!([13, 9]));
    assert_eq!(m[0]["top"], "alpha");
    assert_eq!(m[0]["playedUnix"], PLAYED + 86_400);
}

#[tokio::test]
async fn bad_slugs_are_404() {
    let s = site(|c| c);
    stored(&s, 1, "cup", PLAYED);
    let long = "a".repeat(200);
    for slug in ["../etc", "IEM%20Cologne", long.as_str(), "%60", "nope"] {
        let (status, v) = json(&s, &format!("/api/events/{slug}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{slug}");
        assert!(v["error"].is_string(), "{slug}");
        if slug.contains('/') {
            continue; // not a route of its own: the app's fallback answers
        }
        let (status, headers, body) = call(&s.app, &format!("/events/{slug}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{slug}");
        let body = String::from_utf8(body).unwrap();
        assert!(body.contains(r#"<meta name="robots" content="noindex">"#));
        assert!(
            !body.contains("Cologne") && !body.contains("aaaaaaaa"),
            "{slug}"
        );
        assert!(headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
    }
}

#[tokio::test]
async fn a_hidden_top_fragger_is_named_dash() {
    let s = site(|c| {
        // alpha, the top fragger of `summary`.
        std::fs::create_dir_all(&c.data_dir).unwrap();
        hidden::edit(&c.data_dir, 76_561_198_000_000_000, true).unwrap();
        c
    });
    stored(&s, 1, "cup", PLAYED);
    let (_, v) = json(&s, "/api/events/cup").await;
    assert_eq!(v["matches"][0]["top"], "—");
    let html = page(&s.app, "/events/cup").await;
    assert!(!html.contains("alpha"));
}

/// `/api/home` holds the newest five events and no players, so a hidden player (the fixture
/// hides alpha) is trivially absent.
#[tokio::test]
async fn home_links_are_the_newest_events_only_and_empty_on_an_empty_server() {
    let empty = site(|c| c);
    let (status, v) = json(&empty, "/api/home").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, serde_json::json!({ "events": [] }));
    let (_, v) = json(&empty, "/api/events").await;
    assert_eq!(v, serde_json::json!([]));
    let page = page(&empty.app, "/events").await;
    assert!(page.contains("CS2 tournament demos"));

    let s = site(|c| {
        std::fs::create_dir_all(&c.data_dir).unwrap();
        hidden::edit(&c.data_dir, 76_561_198_000_000_000, true).unwrap();
        c
    });
    for i in 0..7u8 {
        stored(&s, i + 1, &format!("cup{i}"), PLAYED + u64::from(i));
    }
    let (_, v) = json(&s, "/api/home").await;
    assert_eq!(v["events"].as_array().unwrap().len(), 5);
    assert_eq!(v["events"][0]["slug"], "cup6");
    // No players are listed, so a hidden one cannot be in the answer.
    assert!(v.get("players").is_none());
    assert!(!v.to_string().contains("alpha"));
}

/// The home page carries its links for crawlers, as `/api/home` gives them: the newest
/// tournaments and no players, so a hidden player is trivially absent. On an empty server, the
/// link to all of them alone.
#[tokio::test]
async fn the_home_page_carries_its_links_in_the_body() {
    let empty = site(|c| c);
    let html = page(&empty.app, "/").await;
    assert!(
        pre_body(&html).contains(
            r#"<h2>Tournaments</h2><ul class="pre-list"><li><a href="/events">All tournaments</a></li></ul>"#
        ),
        "{html}"
    );

    let s = site(|c| {
        // alpha, the first player of `summary`.
        std::fs::create_dir_all(&c.data_dir).unwrap();
        hidden::edit(&c.data_dir, 76_561_198_000_000_000, true).unwrap();
        c
    });
    stored(&s, 1, "iem_cologne", PLAYED);
    let html = page(&s.app, "/").await;
    let body = pre_body(&html);
    assert!(
        body.contains(
            r#"<h2>Tournaments</h2><ul class="pre-list"><li><a href="/events/iem_cologne">"#
        ),
        "{body}"
    );
    assert!(
        body.contains(r#"<li><a href="/events/iem_cologne">IEM Cologne</a></li>"#),
        "{body}"
    );
    assert!(
        body.contains(r#"<li><a href="/events">All tournaments</a></li></ul>"#),
        "{body}"
    );
    assert!(!body.contains("Players"), "{body}");
    assert!(!body.contains("/profiles/"), "{body}");
    assert!(!html.contains("76561198000000000"), "{body}");
    assert!(!html.contains("alpha"), "{body}");
}

#[tokio::test]
async fn the_event_page_carries_its_matches_in_the_body() {
    let s = site(|c| c);
    let id = stored(&s, 1, "iem_cologne", PLAYED);
    stored(&s, 2, "iem_cologne", CREATED);
    let html = page(&s.app, "/events/iem_cologne").await;
    assert!(
        html.contains("<title>IEM Cologne CS2 demos · skunk.club</title>"),
        "{html}"
    );
    assert_eq!(
        meta(&html, "description").unwrap(),
        "Watch IEM Cologne demos in 3D in your browser: 2 matches, Oct 22, 2025 to Oct 24, 2025, with every player&#39;s stats."
    );
    assert!(html.contains(r#"<h1 class="pre-h">IEM Cologne</h1>"#));
    assert!(html.contains(r#"<p class="pre-sub">2 matches · Oct 22, 2025 – Oct 24, 2025</p>"#));
    assert!(html.contains(&format!(r#"<a href="/d/{id}">Replay</a>"#)));
    assert!(html.contains("Mirage 13–9") || html.contains("Mirage"));
    assert!(html.contains("<td>alpha</td>"));
    let list = page(&s.app, "/events").await;
    assert!(list.contains(r#"<ul class="pre-list">"#));
    assert!(list.contains(
        r#"<a href="/events/iem_cologne">IEM Cologne</a> · 2 matches · Oct 22, 2025 – Oct 24, 2025"#
    ));
}

/// An event played on one day names the day once, in the description and in the body.
#[tokio::test]
async fn a_one_day_event_names_its_day_once() {
    let s = site(|c| c);
    stored(&s, 1, "cup", PLAYED);
    stored(&s, 2, "cup", PLAYED + 3600);
    let html = page(&s.app, "/events/cup").await;
    assert_eq!(
        meta(&html, "description").unwrap(),
        "Watch Cup demos in 3D in your browser: 2 matches, Oct 22, 2025, with every player&#39;s stats."
    );
    assert!(
        html.contains(r#"<p class="pre-sub">2 matches · Oct 22, 2025</p>"#),
        "{html}"
    );
    let list = page(&s.app, "/events").await;
    assert!(
        list.contains(r#"<a href="/events/cup">Cup</a> · 2 matches · Oct 22, 2025</li>"#),
        "{list}"
    );
}

#[tokio::test]
async fn events_pages_are_indexable_with_canonicals() {
    let s = site(|c| c);
    stored(&s, 1, "cup", PLAYED);
    for (path, canon) in [
        ("/events", "https://skunk.club/events"),
        ("/events/cup", "https://skunk.club/events/cup"),
    ] {
        let html = page(&s.app, path).await;
        assert_eq!(link_rel(&html, "canonical").unwrap(), canon, "{path}");
        assert!(!html.contains("noindex"), "{path}");
        assert_eq!(meta(&html, "og:type").unwrap(), "website", "{path}");
        assert_eq!(meta(&html, "og:url").unwrap(), canon, "{path}");
    }
    let html = page(&s.app, "/events").await;
    assert!(html.contains("<title>CS2 tournament demos · skunk.club</title>"));
    assert_eq!(
        meta(&html, "description").unwrap(),
        "Watch pro CS2 tournament demos in 3D in your browser: 1 match from 1 tournament, each \
         with every player&#39;s stats."
    );
}

#[tokio::test]
async fn only_matches_with_a_done_demo_are_counted_or_listed() {
    let s = site(|c| c);
    stored(&s, 1, "mixed", PLAYED);
    let parsing = sha(2);
    let mut m = summary(&parsing);
    m.event = Some("mixed".into());
    m.played_unix = Some(PLAYED + 86_400);
    demo(&s.store, Status::Parsing, &parsing, Some(m));
    let lone = sha(3);
    let mut m = summary(&lone);
    m.event = Some("lone".into());
    demo(&s.store, Status::Parsing, &lone, Some(m));

    let (_, v) = json(&s, "/api/events").await;
    let v = v.as_array().unwrap();
    assert_eq!(v.len(), 1, "{v:?}");
    assert_eq!(v[0]["slug"], "mixed");
    assert_eq!(v[0]["matches"], 1);
    assert_eq!(
        v[0]["lastUnix"], PLAYED,
        "the unfinished match is not a date"
    );
    let (_, v) = json(&s, "/api/events/mixed").await;
    assert_eq!(v["event"]["matches"], 1);
    assert_eq!(v["matches"].as_array().unwrap().len(), 1);
    let (status, _) = json(&s, "/api/events/lone").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(&s.app, "/events/lone").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, v) = json(&s, "/api/home").await;
    assert_eq!(v["events"].as_array().unwrap().len(), 1);
}

/// IEM Cologne Major 2026's first and last day (`event_dates`).
const COLOGNE: [u64; 2] = [1780358400, 1782000000];

/// Stores a done demo from the corpus: nothing says when it was played, and the day it was stored
/// is only the day it was imported. Returns its demo id.
fn imported(s: &Server, tag: u8, event: Option<&str>) -> String {
    let sha = sha(tag);
    let mut m: MatchSummary = summary(&sha);
    m.event = event.map(str::to_owned);
    m.played_unix = None;
    m.imported = true;
    demo(&s.store, Status::Done, &sha, Some(m))
}

#[tokio::test]
async fn a_tournament_has_its_own_dates_not_the_day_it_was_imported() {
    let s = site(|c| c);
    imported(&s, 1, Some("iem_cologne_major_2026"));
    let (_, v) = json(&s, "/api/events").await;
    assert_eq!(v[0]["firstUnix"], COLOGNE[0]);
    assert_eq!(v[0]["lastUnix"], COLOGNE[1]);
    let html = page(&s.app, "/events/iem_cologne_major_2026").await;
    assert_eq!(
        meta(&html, "description").as_deref(),
        Some("Watch IEM Cologne Major 2026 demos in 3D in your browser: 1 match, Jun 2, 2026 to Jun 21, 2026, with every player&#39;s stats.")
    );
    assert!(pre_body(&html).contains("Jun 2, 2026 – Jun 21, 2026"));
}

#[tokio::test]
async fn a_match_with_no_day_of_its_own_has_none_and_its_table_no_date_column() {
    let s = site(|c| c);
    imported(&s, 1, Some("iem_cologne_major_2026"));
    let (_, v) = json(&s, "/api/events/iem_cologne_major_2026").await;
    assert_eq!(v["matches"][0]["playedUnix"], Value::Null);
    let html = page(&s.app, "/events/iem_cologne_major_2026").await;
    let body = pre_body(&html);
    assert!(!body.contains("<th>Date</th>"), "{body}");
    assert!(body.contains("<th>Map</th>"), "{body}");
}

#[tokio::test]
async fn a_match_of_a_tournament_keeps_a_day_it_does_have() {
    let s = site(|c| c);
    stored(&s, 1, "iem_cologne_major_2026", PLAYED);
    imported(&s, 2, Some("iem_cologne_major_2026"));
    let html = page(&s.app, "/events/iem_cologne_major_2026").await;
    assert!(pre_body(&html).contains("<th>Date</th>"));
    let (_, v) = json(&s, "/api/events/iem_cologne_major_2026").await;
    // The one with a day first; the other says none.
    assert_eq!(v["matches"][0]["playedUnix"], PLAYED);
    assert_eq!(v["matches"][1]["playedUnix"], Value::Null);
}

#[tokio::test]
async fn a_tournament_no_dates_are_known_for_claims_none() {
    let s = site(|c| c);
    imported(&s, 1, Some("some_cup"));
    let (_, v) = json(&s, "/api/events").await;
    assert_eq!(v[0]["firstUnix"], Value::Null);
    assert_eq!(v[0]["lastUnix"], Value::Null);
    let html = page(&s.app, "/events/some_cup").await;
    assert_eq!(
        meta(&html, "description").as_deref(),
        Some("Watch Some Cup demos in 3D in your browser: 1 match, with every player&#39;s stats.")
    );
    let event = &common::json_ld(&html)[0];
    assert_eq!(event["@type"], "SportsEvent");
    assert!(event.get("startDate").is_none(), "{event}");
    assert!(event.get("endDate").is_none(), "{event}");
}

#[tokio::test]
async fn tournaments_stand_by_when_they_were_played_those_without_dates_last() {
    let s = site(|c| c);
    imported(&s, 1, Some("some_cup"));
    stored(&s, 2, "old_cup", COLOGNE[0] - 86_400);
    imported(&s, 3, Some("iem_cologne_major_2026"));
    let (_, v) = json(&s, "/api/events").await;
    let slugs: Vec<&str> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["slug"].as_str().unwrap())
        .collect();
    assert_eq!(slugs, ["iem_cologne_major_2026", "old_cup", "some_cup"]);
}

#[tokio::test]
async fn a_corpus_match_page_claims_no_day() {
    let s = site(|c| c);
    let id = imported(&s, 1, Some("iem_cologne_major_2026"));
    let html = page(&s.app, &format!("/d/{id}")).await;
    let stored_day = demoviewer_server::pages::date_of(CREATED);
    let description = meta(&html, "description").unwrap();
    assert!(!description.contains(&stored_day), "{description}");
    assert!(
        description.ends_with("IEM Cologne Major 2026. Watch this CS2 demo in 3D."),
        "{description}"
    );
    assert!(!pre_body(&html).contains(&stored_day));
    let event = &common::json_ld(&html)[0];
    assert!(event.get("startDate").is_none(), "{event}");
}

#[tokio::test]
async fn an_upload_keeps_the_day_it_was_stored_when_nothing_better_is_known() {
    let s = site(|c| c);
    let sha = sha(1);
    let mut m: MatchSummary = summary(&sha);
    m.played_unix = None;
    let id = demo(&s.store, Status::Done, &sha, Some(m));
    let html = page(&s.app, &format!("/d/{id}")).await;
    let description = meta(&html, "description").unwrap();
    assert!(
        description.contains(&demoviewer_server::pages::date_of(CREATED)),
        "{description}"
    );
}
