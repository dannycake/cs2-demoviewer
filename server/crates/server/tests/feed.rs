//! The Atom feeds and `/oembed`, and the head tags that announce them.

mod common;

use axum::http::{header, StatusCode};
use common::{call, demo, link_rels, page, sha, site, summary, Server, PLAYED};
use demoviewer_server::matches::MatchSummary;
use demoviewer_server::store::Status;
use serde_json::Value;

const ME: u64 = 76_561_198_000_000_000;

/// Stores a done match of `event` (when given) played at `at`; returns its demo id.
fn stored(s: &Server, tag: u8, event: Option<&str>, at: u64) -> String {
    let sha = sha(tag);
    let mut m: MatchSummary = summary(&sha);
    m.event = event.map(Into::into);
    m.played_unix = Some(at);
    demo(&s.store, Status::Done, &sha, Some(m))
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}

async fn oembed(s: &Server, url: &str) -> (StatusCode, axum::http::HeaderMap, Value) {
    let (status, headers, body) = call(&s.app, &format!("/oembed?url={}", enc(url))).await;
    (
        status,
        headers,
        serde_json::from_slice(&body).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn a_match_oembed_names_the_site_and_its_event() {
    let s = site(|c| c);
    let id = stored(&s, 1, Some("cac2026"), PLAYED);
    let (status, headers, v) = oembed(&s, &format!("https://skunk.club/d/{id}/?utm=x")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "application/json; charset=utf-8"
    );
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600");
    assert_eq!(v["version"], "1.0");
    assert_eq!(v["type"], "link");
    assert_eq!(v["provider_name"], "skunk.club");
    assert_eq!(v["provider_url"], "https://skunk.club/");
    assert_eq!(v["title"], "Mirage 13–9");
    assert_eq!(v["author_name"], "CS Asia Championships 2026");
    // No event: no author.
    let plain = stored(&s, 2, None, PLAYED);
    let (_, _, v) = oembed(&s, &format!("https://skunk.club/d/{plain}")).await;
    assert!(v.get("author_name").is_none(), "{v}");
    // An event page.
    let (status, _, v) = oembed(&s, "https://skunk.club/events/cac2026").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["title"], "CS Asia Championships 2026 CS2 demos");
    assert_eq!(v["author_name"], "CS Asia Championships 2026");
}

#[tokio::test]
async fn a_profile_oembed_names_the_player() {
    let s = site(|c| c);
    stored(&s, 1, None, PLAYED);
    let (status, _, v) = oembed(&s, &format!("https://skunk.club/profiles/{ME}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["title"], "alpha's CS2 stats");
    assert_eq!(v["author_name"], "alpha");
    // A player no match holds.
    let (status, _, _) = oembed(&s, "https://skunk.club/profiles/76561198999999999").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn oembed_refuses_other_hosts_and_unknown_pages() {
    let s = site(|c| c);
    let id = stored(&s, 1, None, PLAYED);
    let (status, _, _) = oembed(&s, &format!("https://evil.example/d/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = oembed(&s, &format!("http://skunk.club/d/{id}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for path in ["nope", "d/nope", "events/none", "events/..", ""] {
        let (status, _, _) = oembed(&s, &format!("https://skunk.club/{path}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    let pending = demo(&s.store, Status::Parsing, &sha(9), None);
    let (status, _, _) = oembed(&s, &format!("https://skunk.club/d/{pending}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _, _) = call(
        &s.app,
        &format!(
            "/oembed?format=xml&url={}",
            enc(&format!("https://skunk.club/d/{id}"))
        ),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, _, _) = call(
        &s.app,
        &format!(
            "/oembed?format=json&url={}",
            enc(&format!("https://skunk.club/d/{id}"))
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // No public URL: nothing is served.
    let bare = site(|mut c| {
        c.public_url = None;
        c
    });
    for uri in [
        "/oembed?url=https%3A%2F%2Fskunk.club%2F",
        "/feed.xml",
        "/events/x/feed.xml",
    ] {
        assert_eq!(call(&bare.app, uri).await.0, StatusCode::NOT_FOUND, "{uri}");
    }
}

async fn feed(s: &Server, uri: &str) -> String {
    let (status, headers, body) = call(&s.app, uri).await;
    assert_eq!(status, StatusCode::OK, "{uri}");
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "application/atom+xml; charset=utf-8"
    );
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600");
    String::from_utf8(body).unwrap()
}

fn child_text<'a>(n: roxmltree::Node<'a, 'a>, name: &str) -> &'a str {
    n.children()
        .find(|c| c.has_tag_name(name))
        .and_then(|c| c.text())
        .unwrap_or_default()
}

#[tokio::test]
async fn the_site_feed_lists_done_matches_newest_first_capped_at_fifty() {
    let s = site(|c| c);
    let mut newest = String::new();
    for i in 0..60u8 {
        let id = stored(&s, i + 1, None, PLAYED + u64::from(i) * 60);
        if i == 59 {
            newest = id;
        }
    }
    let xml = feed(&s, "/feed.xml").await;
    let doc = roxmltree::Document::parse(&xml).unwrap();
    let root = doc.root_element();
    assert_eq!(child_text(root, "title"), "skunk.club: new CS2 replays");
    assert_eq!(child_text(root, "id"), "https://skunk.club/feed.xml");
    let author = root
        .children()
        .find(|c| c.has_tag_name("author"))
        .expect("a feed-level author");
    assert_eq!(child_text(author, "name"), "skunk.club");
    let entries: Vec<_> = root
        .children()
        .filter(|c| c.has_tag_name("entry"))
        .collect();
    assert_eq!(entries.len(), 50);
    assert_eq!(
        child_text(entries[0], "id"),
        format!("https://skunk.club/d/{newest}")
    );
    assert_eq!(child_text(entries[0], "title"), "Mirage 13–9");
    assert_eq!(
        child_text(entries[0], "updated"),
        child_text(root, "updated")
    );
    assert!(child_text(entries[0], "summary").ends_with("Watch this CS2 demo in 3D."));
    let times: Vec<&str> = entries.iter().map(|e| child_text(*e, "updated")).collect();
    assert!(times.windows(2).all(|w| w[0] >= w[1]), "{times:?}");
    // Not done: not listed. Empty: still valid.
    let empty = site(|c| c);
    let xml = feed(&empty, "/feed.xml").await;
    assert!(roxmltree::Document::parse(&xml).is_ok());
}

#[tokio::test]
async fn an_event_feed_holds_only_its_matches() {
    let s = site(|c| c);
    let a = stored(&s, 1, Some("cup"), PLAYED);
    let b = stored(&s, 2, Some("cup"), PLAYED + 60);
    stored(&s, 3, Some("other"), PLAYED);
    stored(&s, 4, None, PLAYED);
    let xml = feed(&s, "/events/cup/feed.xml").await;
    let doc = roxmltree::Document::parse(&xml).unwrap();
    let root = doc.root_element();
    assert_eq!(child_text(root, "title"), "Cup: CS2 demos on skunk.club");
    assert_eq!(
        child_text(root, "id"),
        "https://skunk.club/events/cup/feed.xml"
    );
    let ids: Vec<&str> = root
        .children()
        .filter(|c| c.has_tag_name("entry"))
        .map(|e| child_text(e, "id"))
        .collect();
    assert_eq!(
        ids,
        [
            format!("https://skunk.club/d/{b}"),
            format!("https://skunk.club/d/{a}")
        ]
    );
    for uri in ["/events/none/feed.xml", "/events/A_B/feed.xml"] {
        assert_eq!(call(&s.app, uri).await.0, StatusCode::NOT_FOUND, "{uri}");
    }
    // The event page's slash redirect still stands beside the feed route.
    let (status, headers, _) = call(&s.app, "/events/cup/").await;
    assert_eq!(status, StatusCode::MOVED_PERMANENTLY);
    assert_eq!(headers[header::LOCATION], "/events/cup");
}

#[tokio::test]
async fn the_feed_escapes_names() {
    let s = site(|c| c);
    let sh = sha(1);
    let mut m = summary(&sh);
    m.players[0].name = "a<b&c".into();
    m.teams = Some(["d\"e".into(), "f'g".into()]);
    demo(&s.store, Status::Done, &sh, Some(m));
    let xml = feed(&s, "/feed.xml").await;
    let doc = roxmltree::Document::parse(&xml).unwrap();
    let entry = doc
        .root_element()
        .children()
        .find(|c| c.has_tag_name("entry"))
        .unwrap();
    assert!(child_text(entry, "title").starts_with("d\"e vs f'g"));
    assert!(child_text(entry, "summary").contains("a<b&c"), "{xml}");
}

#[tokio::test]
async fn pages_link_their_feed_and_oembed() {
    let s = site(|c| c);
    let id = stored(&s, 1, Some("cup"), PLAYED);
    let atom = |_: &str, path: &str| {
        (
            "application/atom+xml".to_owned(),
            format!("https://skunk.club/{path}"),
        )
    };
    let oe = |path: &str| {
        (
            "application/json+oembed".to_owned(),
            format!(
                "https://skunk.club/oembed?url={}",
                enc(&format!("https://skunk.club/{path}"))
            ),
        )
    };
    for uri in ["/", "/events"] {
        let html = page(&s.app, uri).await;
        assert_eq!(
            link_rels(&html, "alternate"),
            [atom("", "feed.xml")],
            "{uri}"
        );
    }
    assert!(page(&s.app, "/").await.contains(r#"title="New replays""#));
    let html = page(&s.app, "/events/cup").await;
    assert_eq!(
        link_rels(&html, "alternate"),
        [atom("", "events/cup/feed.xml"), oe("events/cup")]
    );
    assert!(html.contains(r#"title="Cup: new replays""#));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(link_rels(&html, "alternate"), [oe(&format!("d/{id}"))]);
    let html = page(&s.app, &format!("/profiles/{ME}")).await;
    assert_eq!(
        link_rels(&html, "alternate"),
        [oe(&format!("profiles/{ME}"))]
    );
}

#[tokio::test]
async fn bidi_overrides_and_non_characters_are_dropped_from_feed_and_oembed() {
    let s = site(|c| c);
    let sh = sha(1);
    let mut m = summary(&sh);
    m.players[0].name = "al\u{202e}pha\u{ffff}".into();
    m.teams = Some(["x\u{202e}y\u{fffe}".into(), "z".into()]);
    let id = demo(&s.store, Status::Done, &sh, Some(m));
    let xml = feed(&s, "/feed.xml").await;
    assert!(!xml.contains('\u{202e}') && !xml.contains('\u{ffff}') && !xml.contains('\u{fffe}'));
    assert!(roxmltree::Document::parse(&xml).is_ok());
    assert!(xml.contains("xy vs z"), "{xml}");
    let (_, _, v) = oembed(&s, &format!("https://skunk.club/d/{id}")).await;
    assert_eq!(v["title"], "xy vs z · Mirage 13–9");
    let (status, _, v) = oembed(&s, &format!("https://skunk.club/profiles/{ME}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["title"], "alpha's CS2 stats");
    assert_eq!(v["author_name"], "alpha");
}

#[tokio::test]
async fn a_profile_name_that_filters_to_nothing_is_a_404() {
    let s = site(|c| c);
    let sh = sha(1);
    let mut m = summary(&sh);
    m.players[0].name = "\u{202e}\u{ffff}".into();
    demo(&s.store, Status::Done, &sh, Some(m));
    let (status, _, _) = oembed(&s, &format!("https://skunk.club/profiles/{ME}")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn a_hidden_player_is_redacted_in_feed_summaries() {
    let s = site(|c| {
        // alpha, the top fragger of `summary`.
        std::fs::create_dir_all(&c.data_dir).unwrap();
        demoviewer_server::hidden::edit(&c.data_dir, ME, true).unwrap();
        c
    });
    stored(&s, 1, None, PLAYED);
    let xml = feed(&s, "/feed.xml").await;
    assert!(!xml.contains("alpha"), "{xml}");
    let doc = roxmltree::Document::parse(&xml).unwrap();
    let entry = doc
        .root_element()
        .children()
        .find(|c| c.has_tag_name("entry"))
        .unwrap();
    assert!(child_text(entry, "summary").contains("—"));
}
