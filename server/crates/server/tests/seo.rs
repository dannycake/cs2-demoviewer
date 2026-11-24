//! What the site tells search engines and its own analytics: Cloudflare's beacon and Google's
//! verification tag on every HTML page, and the CSP that lets the beacon load. The router runs
//! in process over a temp data dir, as in `pages.rs`.

use axum::http::{header, StatusCode};
use demoviewer_server::config::Config;
use demoviewer_server::store::{Status, Store};

mod common;
use common::{call, demo, json_ld, link_rel, meta, page, pre_body, property, sha, site, summary};
use demoviewer_server::hidden;
use demoviewer_server::pages::{HOME_DESCRIPTION, HOME_TITLE};

#[tokio::test]
async fn the_beacon_and_verification_tags_follow_the_config() {
    let s = site(|c| Config {
        cf_beacon_token: Some("abc123".into()),
        gsc_token: Some("gsc-token".into()),
        ..c
    });
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    for uri in [
        "/",
        "/legal",
        &format!("/d/{id}"),
        "/profiles/76561198000000000",
    ] {
        let html = page(&s.app, uri).await;
        assert!(
            html.contains(
                r#"<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "abc123"}'></script>"#
            ),
            "{uri}: {html}"
        );
        assert_eq!(
            meta(&html, "google-site-verification").as_deref(),
            Some("gsc-token"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn without_the_tokens_no_script_and_no_verification_tag() {
    let s = site(|c| c);
    let html = page(&s.app, "/").await;
    assert!(!html.contains("cloudflareinsights"));
    assert_eq!(meta(&html, "google-site-verification"), None);
}

#[test]
fn the_csp_names_the_beacon_origins() {
    assert!(demoviewer_server::app::CSP
        .contains("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;"));
    assert!(demoviewer_server::app::CSP
        .contains("connect-src 'self' blob: data: https://cloudflareinsights.com;"));
}

#[tokio::test]
async fn robots_txt_allows_pages_and_names_the_sitemap() {
    let s = site(|c| c);
    let (status, headers, body) = call(&s.app, "/robots.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "text/plain; charset=utf-8");
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=3600");
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "User-agent: *\nDisallow: /api/\nDisallow: /auth/\n\
         Sitemap: https://skunk.club/sitemap.xml\n"
    );
}

#[tokio::test]
async fn robots_txt_without_a_public_url_has_no_sitemap_line() {
    let s = site(|c| Config {
        public_url: None,
        ..c
    });
    let (status, _, body) = call(&s.app, "/robots.txt").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        String::from_utf8(body).unwrap(),
        "User-agent: *\nDisallow: /api/\nDisallow: /auth/\n"
    );
}

/// The first player of [`summary`].
const PLAYER: u64 = 76_561_198_000_000_000;

/// `uri`'s status, its robots tag and its canonical link.
async fn seen(s: &common::Server, uri: &str) -> (StatusCode, Option<String>, Option<String>) {
    let (status, _, body) = call(&s.app, uri).await;
    let html = String::from_utf8(body).unwrap();
    assert!(html.contains("<div id=\"root\">"), "{uri}: the app's page");
    (status, meta(&html, "robots"), link_rel(&html, "canonical"))
}

#[tokio::test]
async fn a_known_profile_is_indexable_with_its_canonical() {
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let want = Some(format!("https://skunk.club/profiles/{PLAYER}"));
    let (status, robots, canonical) = seen(&s, &format!("/profiles/{PLAYER}")).await;
    assert_eq!((status, robots, canonical), (StatusCode::OK, None, want));
}

#[tokio::test]
async fn an_unknown_profile_is_200_noindex_without_a_canonical() {
    let s = site(|c| c);
    let (status, robots, canonical) = seen(&s, "/profiles/76561198000000099").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(robots.as_deref(), Some("noindex"));
    assert_eq!(canonical, None);
}

#[tokio::test]
async fn a_missing_profile_is_404_noindex() {
    let s = site(|c| c);
    for uri in ["/profiles/123", "/id/a"] {
        let (status, robots, canonical) = seen(&s, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(robots.as_deref(), Some("noindex"), "{uri}");
        assert_eq!(canonical, None, "{uri}");
    }
}

#[tokio::test]
async fn a_hidden_profile_is_410() {
    let s = site(|c| {
        std::fs::create_dir_all(&c.data_dir).unwrap();
        hidden::edit(&c.data_dir, PLAYER, true).unwrap();
        c
    });
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let (status, robots, canonical) = seen(&s, &format!("/profiles/{PLAYER}")).await;
    assert_eq!(status, StatusCode::GONE);
    assert_eq!(robots.as_deref(), Some("noindex"));
    assert_eq!(canonical, None);
}

#[tokio::test]
async fn a_done_match_is_indexable_with_the_oldest_id_as_canonical() {
    let s = site(|c| c);
    let first = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let second = demo(&s.store, Status::Done, &sha(1), None);
    s.store.update(&first, |r| r.created_unix = 1000);
    s.store.update(&second, |r| r.created_unix = 2000);
    for id in [&first, &second] {
        let (status, robots, canonical) = seen(&s, &format!("/d/{id}")).await;
        assert_eq!(status, StatusCode::OK, "{id}");
        assert_eq!(robots, None, "{id}");
        assert_eq!(
            canonical,
            Some(format!("https://skunk.club/d/{first}")),
            "{id}"
        );
    }
}

#[tokio::test]
async fn an_in_progress_match_is_noindex_200() {
    let s = site(|c| c);
    for status in [
        Status::Resolving,
        Status::Queued,
        Status::Downloading,
        Status::Parsing,
    ] {
        let id = demo(&s.store, status, &sha(2), None);
        let (code, robots, canonical) = seen(&s, &format!("/d/{id}")).await;
        assert_eq!(code, StatusCode::OK, "{status:?}");
        assert_eq!(robots.as_deref(), Some("noindex"), "{status:?}");
        assert_eq!(canonical, None, "{status:?}");
    }
}

#[tokio::test]
async fn an_unknown_match_id_is_404() {
    let s = site(|c| c);
    let failed = demo(&s.store, Status::Error, &sha(3), Some(summary(&sha(3))));
    for id in [Store::new_id(), "not-an-id".to_owned(), failed] {
        let (status, robots, canonical) = seen(&s, &format!("/d/{id}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{id}");
        assert_eq!(robots.as_deref(), Some("noindex"), "{id}");
        assert_eq!(canonical, None, "{id}");
    }
}

#[tokio::test]
async fn track_is_noindex() {
    let s = site(|c| c);
    let (status, robots, canonical) = seen(&s, "/track").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(robots.as_deref(), Some("noindex"));
    assert_eq!(canonical.as_deref(), Some("https://skunk.club/track"));
    for (uri, want) in [
        ("/", "https://skunk.club/"),
        ("/legal", "https://skunk.club/legal"),
    ] {
        let (status, robots, canonical) = seen(&s, uri).await;
        assert_eq!((status, robots), (StatusCode::OK, None), "{uri}");
        assert_eq!(canonical.as_deref(), Some(want), "{uri}");
    }
}

#[tokio::test]
async fn a_known_profiles_page_carries_its_stats_in_the_body() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let html = page(&s.app, &format!("/profiles/{PLAYER}")).await;
    let body = pre_body(&html);
    let name = summary(&sha(1)).players[0].name.clone();
    assert!(body.contains(&name), "{body}");
    assert!(body.contains("rating"), "{body}");
    assert!(
        body.contains(r#"<tr class="pre-sub-row"><td colspan="4">"#),
        "{body}"
    );
    assert!(body.contains(&format!("/d/{id}")), "{body}");
}

#[tokio::test]
async fn a_matchs_page_carries_its_scoreboard_in_the_body() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let html = page(&s.app, &format!("/d/{id}")).await;
    let root = pre_body(&html);
    assert!(
        root.contains(r#"<a href="/profiles/76561198000000000">alpha</a>"#),
        "{root}"
    );
    let ct = root.find("<caption>CT 13</caption>").expect("the CT table");
    let t = root.find("<caption>T 9</caption>").expect("the T table");
    assert!(ct < t, "{root}");
}

#[tokio::test]
async fn the_home_page_declares_the_search_action() {
    let s = site(|c| c);
    let v = json_ld(&page(&s.app, "/").await);
    assert_eq!(v.len(), 3, "{v:?}");
    assert_eq!(v[0]["@type"], "WebSite");
    assert_eq!(v[0]["url"], "https://skunk.club/");
    assert_eq!(v[0]["name"], "skunk.club");
    let action = &v[0]["potentialAction"];
    assert_eq!(action["@type"], "SearchAction");
    assert_eq!(
        action["target"]["urlTemplate"],
        "https://skunk.club/?q={search_term_string}"
    );
    assert_eq!(action["query-input"], "required name=search_term_string");
    for uri in ["/events", "/track", "/legal"] {
        assert!(json_ld(&page(&s.app, uri).await).is_empty(), "{uri}");
    }
}

#[tokio::test]
async fn a_profile_page_declares_the_person() {
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let v = json_ld(&page(&s.app, &format!("/profiles/{PLAYER}")).await);
    assert_eq!(v.len(), 2, "{v:?}");
    assert_eq!(v[0]["@type"], "ProfilePage");
    let person = &v[0]["mainEntity"];
    assert_eq!(person["@type"], "Person");
    assert_eq!(person["name"], "alpha");
    assert_eq!(person["identifier"], PLAYER.to_string());
    assert_eq!(
        person["url"],
        format!("https://skunk.club/profiles/{PLAYER}")
    );
    let (_, _, body) = call(&s.app, "/profiles/76561198000000099").await;
    assert!(json_ld(&String::from_utf8(body).unwrap()).is_empty());
}

#[tokio::test]
async fn a_match_page_declares_the_sports_event() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let v = json_ld(&page(&s.app, &format!("/d/{id}")).await);
    assert_eq!(v.len(), 2, "{v:?}");
    assert_eq!(v[0]["@type"], "SportsEvent");
    assert_eq!(v[0]["name"], "Mirage 13–9");
    assert_eq!(v[0]["startDate"], "2025-10-22T20:00:00Z");
    assert_eq!(v[0]["location"]["@type"], "Place");
    assert_eq!(v[0]["location"]["name"], "Valve matchmaking, EU West");
    assert_eq!(v[0]["url"], format!("https://skunk.club/d/{id}"));
    assert_eq!(v[0]["image"], format!("https://skunk.club/og/{id}.jpg"));
}

/// A copy of a pack (a second id for one sha) names the oldest id as its own address
/// everywhere: the canonical link, `og:url` and the JSON-LD `url` agree, and the card is the
/// one image under the oldest id too.
#[tokio::test]
async fn a_copys_page_names_the_oldest_id_as_its_address() {
    let s = site(|c| c);
    let first = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let second = demo(&s.store, Status::Done, &sha(1), None);
    s.store.update(&first, |r| r.created_unix = 1000);
    s.store.update(&second, |r| r.created_unix = 2000);
    let want = format!("https://skunk.club/d/{first}");
    let html = page(&s.app, &format!("/d/{second}")).await;
    assert_eq!(link_rel(&html, "canonical").as_deref(), Some(want.as_str()));
    assert_eq!(meta(&html, "og:url").as_deref(), Some(want.as_str()));
    let card = format!("https://skunk.club/og/{first}.jpg");
    assert_eq!(meta(&html, "og:image").as_deref(), Some(card.as_str()));
    let v = json_ld(&html);
    assert_eq!(v.len(), 2, "{v:?}");
    assert_eq!(v[0]["url"], want);
    assert_eq!(v[0]["image"], card);
}

#[tokio::test]
async fn an_event_page_declares_the_sports_event() {
    let s = site(|c| c);
    let mut m = summary(&sha(1));
    m.event = Some("blast_2025".into());
    demo(&s.store, Status::Done, &sha(1), Some(m));
    let v = json_ld(&page(&s.app, "/events/blast_2025").await);
    assert_eq!(v.len(), 2, "{v:?}");
    assert_eq!(v[0]["@type"], "SportsEvent");
    assert_eq!(v[0]["name"], "BLAST 2025");
    assert_eq!(v[0]["startDate"], "2025-10-22T20:00:00Z");
    assert_eq!(v[0]["endDate"], "2025-10-22T20:00:00Z");
    assert_eq!(v[0]["url"], "https://skunk.club/events/blast_2025");
    let (status, _, body) = call(&s.app, "/events/nothing").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(json_ld(&String::from_utf8(body).unwrap()).is_empty());
}

#[tokio::test]
async fn without_a_public_url_there_is_no_json_ld() {
    let s = site(|c| Config {
        public_url: None,
        ..c
    });
    let mut m = summary(&sha(1));
    m.event = Some("blast_2025".into());
    let id = demo(&s.store, Status::Done, &sha(1), Some(m));
    for uri in [
        "/".to_owned(),
        format!("/profiles/{PLAYER}"),
        format!("/d/{id}"),
        "/events/blast_2025".to_owned(),
    ] {
        let html = page(&s.app, &uri).await;
        assert!(!html.contains("ld+json"), "{uri}");
    }
}

#[tokio::test]
async fn the_home_page_names_what_the_site_is() {
    let s = site(|c| c);
    let html = page(&s.app, "/").await;
    assert!(html.contains("<title>CS2 demo viewer in your browser · skunk.club</title>"));
    assert_eq!(HOME_TITLE, "CS2 demo viewer in your browser");
    assert_eq!(
        meta(&html, "description").as_deref(),
        Some(HOME_DESCRIPTION.replace('\'', "&#39;").as_str())
    );
    assert_eq!(
        property(&html, "og:title").as_deref(),
        Some("CS2 demo viewer in your browser")
    );
    assert_eq!(property(&html, "og:locale").as_deref(), Some("en_US"));
    let body = pre_body(&html);
    assert!(body.contains("<h1 class=\"pre-h\">Watch CS2 demos in 3D, right in your browser.</h1>"));
    assert!(body.contains("share code") && body.contains("FACEIT") && body.contains(".dem"));
    for (href, text) in [
        (
            "/guides/watch-cs2-demos-in-your-browser",
            "How to watch a CS2 demo in your browser",
        ),
        (
            "/guides/track-your-cs2-matches",
            "How to get your CS2 match history tracked automatically",
        ),
        (
            "/guides/watch-faceit-demos",
            "How to watch a FACEIT demo in 3D",
        ),
    ] {
        assert!(
            body.contains(&format!(r#"<a href="{href}">{text}</a>"#)),
            "{href}"
        );
    }
    assert!(body.contains(r#"href="/events""#));
}

#[tokio::test]
async fn the_poster_card_has_its_size_and_alt() {
    let s = site(|c| c);
    std::fs::create_dir_all(s.dir.path().join("assets/site/home")).unwrap();
    std::fs::write(s.dir.path().join("assets/site/home/poster.jpg"), b"jpeg").unwrap();
    for uri in ["/", "/legal"] {
        let html = page(&s.app, uri).await;
        assert_eq!(
            property(&html, "og:image:width").as_deref(),
            Some("1920"),
            "{uri}"
        );
        assert_eq!(
            property(&html, "og:image:height").as_deref(),
            Some("1080"),
            "{uri}"
        );
        assert_eq!(
            property(&html, "og:image:alt").as_deref(),
            Some("skunk.club: a CS2 match in the browser&#39;s 3D viewer"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn the_home_page_declares_the_organization() {
    let s = site(|c| c);
    let html = page(&s.app, "/").await;
    let blocks = json_ld(&html);
    let org = blocks
        .iter()
        .find(|v| v["@type"] == "Organization")
        .expect("an Organization");
    assert_eq!(org["logo"], "https://skunk.club/icon-512.png");
    assert_eq!(org["url"], "https://skunk.club/");
    assert!(blocks.iter().any(|v| v["@type"] == "WebSite"));
}

#[tokio::test]
async fn a_trailing_slash_redirects_keeping_the_query() {
    let s = site(|c| c);
    for (from, to) in [
        ("/legal/", "/legal"),
        ("/track/", "/track"),
        ("/events/cac2026/", "/events/cac2026"),
        ("/guides/watch-faceit-demos/", "/guides/watch-faceit-demos"),
        ("/d/abc/?r=3&t=120", "/d/abc?r=3&t=120"),
    ] {
        let (status, headers, _) = call(&s.app, from).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{from}");
        assert_eq!(headers[header::LOCATION], to, "{from}");
        assert_eq!(
            headers[header::CACHE_CONTROL],
            "public, max-age=86400",
            "{from}"
        );
    }
}

#[tokio::test]
async fn an_unknown_path_is_404_noindex_with_the_app() {
    let s = site(|c| c);
    std::fs::write(s.dir.path().join("web/site.webmanifest"), b"{}").unwrap();
    std::fs::write(s.dir.path().join("web/favicon.ico"), b"ico").unwrap();
    for uri in ["/nope", "/nope/deeper"] {
        let (status, _, body) = call(&s.app, uri).await;
        let html = String::from_utf8(body).unwrap();
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert!(html.contains("<div id=\"root\">"), "{uri}");
        assert_eq!(meta(&html, "robots").as_deref(), Some("noindex"), "{uri}");
        assert_eq!(link_rel(&html, "canonical"), None, "{uri}");
        assert!(
            html.contains("<title>Not found · skunk.club</title>"),
            "{uri}"
        );
        assert_eq!(
            meta(&html, "description").as_deref(),
            Some("This page does not exist."),
            "{uri}"
        );
    }
    for uri in ["/site.webmanifest", "/favicon.ico"] {
        let (status, _, _) = call(&s.app, uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
    }
}

/// Spirit v Falcons on Dust II, 13–9, at PGL Astana 2026.
fn spirit(tag: u8) -> demoviewer_server::matches::MatchSummary {
    let mut m = summary(&sha(tag));
    m.map = "de_dust2".into();
    m.teams = Some(["Spirit".into(), "Falcons".into()]);
    m.event = Some("pgl_astana_2026".into());
    m
}

fn title_of(html: &str) -> &str {
    let at = html.find("<title>").expect("a title") + "<title>".len();
    &html[at..at + html[at..].find("</title>").unwrap()]
}

#[tokio::test]
async fn a_match_with_teams_is_titled_by_them() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(spirit(1)));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(
        title_of(&html),
        "Spirit vs Falcons · Dust II 13–9 · PGL Astana 2026 · skunk.club"
    );
    assert_eq!(
        property(&html, "og:title").as_deref(),
        Some("Spirit vs Falcons · Dust II 13–9")
    );
    assert!(
        pre_body(&html).contains("<h1 class=\"pre-h\">Spirit vs Falcons · Dust II 13–9</h1>"),
        "{}",
        pre_body(&html)
    );
    assert!(
        meta(&html, "description")
            .unwrap()
            .contains("Spirit vs Falcons on Dust II"),
        "{html}"
    );
    let v = json_ld(&html);
    assert_eq!(v[0]["name"], "Spirit vs Falcons · Dust II 13–9");
    assert_eq!(
        v[0]["competitor"],
        serde_json::json!([
            {"@type": "SportsTeam", "name": "Spirit"},
            {"@type": "SportsTeam", "name": "Falcons"},
        ])
    );
    assert_eq!(
        v[0]["superEvent"],
        serde_json::json!({
            "@type": "SportsEvent",
            "name": "PGL Astana 2026",
            "url": "https://skunk.club/events/pgl_astana_2026",
        })
    );
}

#[tokio::test]
async fn a_match_without_teams_or_event_is_a_cs2_replay() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(title_of(&html), "Mirage 13–9 · CS2 replay · skunk.club");
    let v = json_ld(&html);
    assert!(v[0].get("competitor").is_none() && v[0].get("superEvent").is_none());
}

#[tokio::test]
async fn a_team_name_is_escaped_everywhere() {
    let s = site(|c| c);
    let mut m = spirit(1);
    m.teams = Some(["a<b\"c".into(), "d&e".into()]);
    let id = demo(&s.store, Status::Done, &sha(1), Some(m));
    let html = page(&s.app, &format!("/d/{id}")).await;
    let want = "a&lt;b&quot;c vs d&amp;e · Dust II 13–9";
    assert!(title_of(&html).starts_with(want), "{}", title_of(&html));
    assert_eq!(property(&html, "og:title").as_deref(), Some(want));
    assert!(pre_body(&html).contains(&format!("{want}</h1>")));
    assert!(!html.contains("a<b"), "{html}");
    let v = json_ld(&html);
    assert_eq!(v[0]["competitor"][0]["name"], "a<b\"c");
    assert_eq!(v[0]["competitor"][1]["name"], "d&e");
}

#[tokio::test]
async fn event_pages_say_cs2_demos() {
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(spirit(1)));
    let html = page(&s.app, "/events").await;
    assert_eq!(title_of(&html), "CS2 tournament demos · skunk.club");
    assert_eq!(
        property(&html, "og:title").as_deref(),
        Some("CS2 tournament demos")
    );
    let html = page(&s.app, "/events/pgl_astana_2026").await;
    assert_eq!(title_of(&html), "PGL Astana 2026 CS2 demos · skunk.club");
    assert_eq!(
        property(&html, "og:title").as_deref(),
        Some("PGL Astana 2026")
    );
}

fn trail(v: &serde_json::Value) -> Vec<(u64, String, String)> {
    assert_eq!(v["@type"], "BreadcrumbList", "{v}");
    v["itemListElement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            assert_eq!(i["@type"], "ListItem");
            (
                i["position"].as_u64().unwrap(),
                i["name"].as_str().unwrap().to_owned(),
                i["item"].as_str().unwrap().to_owned(),
            )
        })
        .collect()
}

fn crumbs(items: &[(&str, &str)]) -> Vec<(u64, String, String)> {
    items
        .iter()
        .enumerate()
        .map(|(i, (n, u))| (i as u64 + 1, (*n).to_owned(), (*u).to_owned()))
        .collect()
}

#[tokio::test]
async fn pages_carry_breadcrumbs() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(spirit(1)));
    let v = json_ld(&page(&s.app, &format!("/d/{id}")).await);
    assert_eq!(
        trail(&v[1]),
        crumbs(&[
            ("Home", "https://skunk.club/"),
            ("Tournaments", "https://skunk.club/events"),
            (
                "PGL Astana 2026",
                "https://skunk.club/events/pgl_astana_2026"
            ),
            (
                "Spirit vs Falcons · Dust II 13–9",
                &format!("https://skunk.club/d/{id}")
            ),
        ])
    );
    let v = json_ld(&page(&s.app, &format!("/profiles/{PLAYER}")).await);
    assert_eq!(
        trail(&v[1]),
        crumbs(&[
            ("Home", "https://skunk.club/"),
            ("alpha", &format!("https://skunk.club/profiles/{PLAYER}")),
        ])
    );
    let v = json_ld(&page(&s.app, "/events/pgl_astana_2026").await);
    assert_eq!(
        trail(&v[1]),
        crumbs(&[
            ("Home", "https://skunk.club/"),
            ("Tournaments", "https://skunk.club/events"),
            (
                "PGL Astana 2026",
                "https://skunk.club/events/pgl_astana_2026"
            ),
        ])
    );
    // A match without an event has no event step.
    let id = demo(&s.store, Status::Done, &sha(2), Some(summary(&sha(2))));
    let v = json_ld(&page(&s.app, &format!("/d/{id}")).await);
    assert_eq!(
        trail(&v[1]),
        crumbs(&[
            ("Home", "https://skunk.club/"),
            ("Mirage 13–9", &format!("https://skunk.club/d/{id}")),
        ])
    );
}

#[tokio::test]
async fn a_profile_person_has_same_as_links() {
    let s = common::site_before(
        |c| c,
        |data| {
            let dir = data.join("profiles");
            std::fs::create_dir_all(&dir).unwrap();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            let json = serde_json::json!({
                "steamid": PLAYER, "name": "alpha", "avatar": null, "since_year": null,
                "country": null, "cs2_hours": null, "vac_bans": 0, "game_bans": 0,
                "faceit": {"nickname": "nick", "level": 7, "elo": 1500},
                "fetched_unix": now,
            });
            std::fs::write(dir.join(format!("{PLAYER}.json")), json.to_string()).unwrap();
        },
    );
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let v = json_ld(&page(&s.app, &format!("/profiles/{PLAYER}")).await);
    assert_eq!(
        v[0]["mainEntity"]["sameAs"],
        serde_json::json!([
            format!("https://steamcommunity.com/profiles/{PLAYER}"),
            "https://www.faceit.com/en/players/nick",
        ])
    );
    // Without FACEIT, Steam alone.
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let v = json_ld(&page(&s.app, &format!("/profiles/{PLAYER}")).await);
    assert_eq!(
        v[0]["mainEntity"]["sameAs"],
        serde_json::json!([format!("https://steamcommunity.com/profiles/{PLAYER}")])
    );
}

#[tokio::test]
async fn an_event_table_has_a_teams_column_only_when_a_match_has_teams() {
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(spirit(1)));
    let body = page(&s.app, "/events/pgl_astana_2026").await;
    let root = pre_body(&body);
    assert!(root.contains("<th>Teams</th>"), "{root}");
    assert!(root.contains("<td>Spirit vs Falcons</td>"), "{root}");
    let s = site(|c| c);
    let mut m = summary(&sha(1));
    m.event = Some("blast_2025".into());
    demo(&s.store, Status::Done, &sha(1), Some(m));
    let body = page(&s.app, "/events/blast_2025").await;
    assert!(!pre_body(&body).contains("Teams"));
}

#[tokio::test]
async fn a_guide_page_carries_its_body_title_and_article() {
    let s = site(|c| c);
    let g = &demoviewer_server::guides::GUIDES[0];
    let uri = format!("/guides/{}", g.slug);
    let html = page(&s.app, &uri).await;
    assert!(
        html.contains("<title>How to watch a CS2 demo in your browser · skunk.club</title>"),
        "{html}"
    );
    assert_eq!(
        link_rel(&html, "canonical").as_deref(),
        Some("https://skunk.club/guides/watch-cs2-demos-in-your-browser")
    );
    assert_eq!(property(&html, "og:type").as_deref(), Some("article"));
    let body = pre_body(&html);
    assert!(
        body.contains(r#"<h1 class="pre-h">How to watch a CS2 demo in your browser</h1>"#),
        "{body}"
    );
    let first = g.body.lines().next().unwrap();
    assert!(body.contains(first), "{body}");
    let v = json_ld(&html);
    assert_eq!(v.len(), 2, "{v:?}");
    assert_eq!(v[0]["@type"], "Article");
    assert_eq!(v[0]["headline"], g.title);
    assert_eq!(v[0]["datePublished"], "2026-10-31");
    assert_eq!(v[0]["dateModified"], "2026-10-31");
    assert_eq!(v[0]["author"]["@type"], "Organization");
    assert_eq!(v[0]["publisher"]["name"], "skunk.club");
    assert_eq!(
        v[0]["url"],
        "https://skunk.club/guides/watch-cs2-demos-in-your-browser"
    );
    assert_eq!(v[1]["@type"], "BreadcrumbList");
    let names: Vec<&str> = v[1]["itemListElement"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Home", "Guides", g.title]);
}

#[tokio::test]
async fn an_unknown_guide_is_404_noindex() {
    let s = site(|c| c);
    let (status, robots, canonical) = seen(&s, "/guides/no-such-guide").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(robots.as_deref(), Some("noindex"));
    assert_eq!(canonical, None);
}

#[tokio::test]
async fn the_home_page_links_every_guide() {
    let s = site(|c| c);
    let body = page(&s.app, "/").await;
    for g in &demoviewer_server::guides::GUIDES {
        assert!(
            body.contains(&format!(r#"<a href="/guides/{}">{}</a>"#, g.slug, g.title)),
            "{}",
            g.slug
        );
    }
}

#[test]
fn guide_bodies_are_short_and_plain() {
    const SITE: [&str; 4] = ["/", "/track", "/legal", "/events"];
    for g in &demoviewer_server::guides::GUIDES {
        let mut text = String::new();
        let mut in_tag = false;
        for c in g.body.chars() {
            match c {
                '<' => in_tag = true,
                '>' => {
                    in_tag = false;
                    text.push(' ');
                }
                c if !in_tag => text.push(c),
                _ => {}
            }
        }
        let words = text.split_whitespace().count();
        assert!(words < 400, "{}: {words} words", g.slug);
        let lower = text.to_lowercase();
        for banned in ["ultimate", "best ", "!"] {
            assert!(!lower.contains(banned), "{}: {banned:?}", g.slug);
        }
        for part in g.body.split(r#"href=""#).skip(1) {
            let href = part.split('"').next().unwrap();
            let ok = SITE.contains(&href)
                || href.starts_with("/guides/")
                || href.starts_with("https://help.steampowered.com/")
                || href.starts_with("https://www.faceit.com/");
            assert!(ok, "{}: href {href}", g.slug);
        }
    }
}

#[tokio::test]
async fn a_profiles_description_is_a_sentence_with_its_keywords() {
    let s = site(|c| c);
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let html = page(&s.app, "/profiles/76561198000000000").await;
    assert!(
        html.contains("CS2 stats and demos · skunk.club</title>"),
        "{html}"
    );
    let d = meta(&html, "description").unwrap();
    assert!(d.contains("CS2 stats from 1 match: "), "{d}");
    assert!(d.contains(" K/D, "), "{d}");
    assert!(
        d.ends_with("Watch every match as a 3D replay in your browser."),
        "{d}"
    );
    assert!(d.len() <= 170, "{}: {d}", d.len());
}

#[tokio::test]
async fn the_tournaments_page_counts_what_it_holds() {
    let s = site(|c| c);
    let mut m = summary(&sha(1));
    m.event = Some("some_cup".into());
    demo(&s.store, Status::Done, &sha(1), Some(m));
    let html = page(&s.app, "/events").await;
    assert_eq!(
        meta(&html, "description").as_deref(),
        Some("Watch pro CS2 tournament demos in 3D in your browser: 1 match from 1 tournament, each with every player&#39;s stats.")
    );
    assert!(pre_body(&html).contains(r#"<h1 class="pre-h">CS2 tournament demos</h1>"#));
}

#[tokio::test]
async fn a_match_links_its_tournament_and_a_tournament_names_its_matches() {
    let s = site(|c| c);
    let mut m = summary(&sha(1));
    m.event = Some("some_cup".into());
    let id = demo(&s.store, Status::Done, &sha(1), Some(m));
    let body = page(&s.app, &format!("/d/{id}")).await;
    assert!(
        pre_body(&body).contains(r#"<a href="/events/some_cup">All Some Cup demos</a>"#),
        "{body}"
    );
    let event = page(&s.app, "/events/some_cup").await;
    assert!(
        pre_body(&event).contains(&format!(r#"<td><a href="/d/{id}">Mirage</a></td>"#)),
        "{event}"
    );
}

#[tokio::test]
async fn one_address_for_the_home_page_and_the_tournaments() {
    let s = site(|c| c);
    for (from, to) in [
        ("/index.html", "/"),
        ("/events/", "/events"),
        ("/guides/", "/guides"),
    ] {
        let (status, headers, _) = call(&s.app, from).await;
        assert_eq!(status, StatusCode::MOVED_PERMANENTLY, "{from}");
        assert_eq!(headers[header::LOCATION], to, "{from}");
    }
}

#[tokio::test]
async fn pages_that_can_be_indexed_allow_large_previews_and_others_do_not() {
    let s = site(|c| c);
    let html = page(&s.app, "/").await;
    assert_eq!(
        meta(&html, "googlebot").as_deref(),
        Some("max-image-preview:large")
    );
    let (_, _, body) = call(&s.app, "/nope").await;
    assert_eq!(meta(&String::from_utf8(body).unwrap(), "googlebot"), None);
}

#[tokio::test]
async fn the_home_page_says_what_kind_of_thing_it_is_and_every_match_its_sport() {
    let s = site(|c| c);
    let data = json_ld(&page(&s.app, "/").await);
    let app = data
        .iter()
        .find(|v| v["@type"] == "WebApplication")
        .unwrap();
    assert_eq!(app["offers"]["price"], "0");
    assert_eq!(app["applicationCategory"], "GameApplication");
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let data = json_ld(&page(&s.app, &format!("/d/{id}")).await);
    assert_eq!(data[0]["sport"], "Counter-Strike 2");
}

#[tokio::test]
async fn the_guides_page_lists_every_guide_and_the_sitemap_names_it() {
    let s = site(|c| c);
    let html = page(&s.app, "/guides").await;
    assert!(
        html.contains("<title>CS2 demo guides · skunk.club</title>"),
        "{html}"
    );
    assert_eq!(
        link_rel(&html, "canonical").as_deref(),
        Some("https://skunk.club/guides")
    );
    for g in &demoviewer_server::guides::GUIDES {
        assert!(
            pre_body(&html).contains(&format!(r#"href="/guides/{}""#, g.slug)),
            "{}",
            g.slug
        );
    }
    let (_, _, map) = call(&s.app, "/sitemap-pages.xml").await;
    assert!(String::from_utf8(map)
        .unwrap()
        .contains("<loc>https://skunk.club/guides</loc>"));
}
