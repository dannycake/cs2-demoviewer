//! The sitemaps: `/sitemap.xml` and the files it lists, built from the store. The router runs
//! in process over a temp data dir, as in `pages.rs`.

use axum::http::{header, StatusCode};
use demoviewer_server::store::Status;

mod common;
use common::{call, demo, sha, site, summary, Server};

const ME: u64 = 76_561_198_000_000_000;

async fn text(s: &Server, uri: &str) -> (StatusCode, String) {
    let (status, _, body) = call(&s.app, uri).await;
    (status, String::from_utf8(body).unwrap())
}

#[tokio::test]
async fn without_a_public_url_sitemaps_are_404() {
    let s = site(|mut c| {
        c.public_url = None;
        c
    });
    for uri in [
        "/sitemap.xml",
        "/sitemap-pages.xml",
        "/sitemap-events.xml",
        "/sitemap-profiles-1.xml",
        "/sitemap-matches-1.xml",
    ] {
        let (status, body) = text(&s, uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body, "not found", "{uri}");
    }
}

#[tokio::test]
async fn an_empty_server_has_a_valid_index_with_only_pages() {
    let s = site(|c| c);
    let (status, headers, body) = call(&s.app, "/sitemap.xml").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers[header::CONTENT_TYPE],
        "application/xml; charset=utf-8"
    );
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=600");
    let body = String::from_utf8(body).unwrap();
    assert!(
        body.starts_with(r#"<?xml version="1.0" encoding="UTF-8"?>"#),
        "{body}"
    );
    assert!(body.contains(r#"<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">"#));
    assert!(body.contains("<loc>https://skunk.club/sitemap-pages.xml</loc>"));
    assert_eq!(body.matches("<sitemap>").count(), 1, "{body}");

    let (status, pages) = text(&s, "/sitemap-pages.xml").await;
    assert_eq!(status, StatusCode::OK);
    for path in ["", "events", "legal"] {
        assert!(
            pages.contains(&format!("<loc>https://skunk.club/{path}</loc>")),
            "{pages}"
        );
    }
    assert!(!pages.contains("/track</loc>"), "{pages}");
    for g in &demoviewer_server::guides::GUIDES {
        assert!(
            pages.contains(&format!(
                "<loc>https://skunk.club/guides/{}</loc></url>",
                g.slug
            )),
            "{pages}"
        );
    }

    let (status, events) = text(&s, "/sitemap-events.xml").await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        events.contains("<urlset") && !events.contains("<url>"),
        "{events}"
    );
    for uri in [
        "/sitemap-profiles-1.xml",
        "/sitemap-matches-1.xml",
        "/sitemap-matches-0.xml",
    ] {
        assert_eq!(text(&s, uri).await.0, StatusCode::NOT_FOUND, "{uri}");
    }
}

#[tokio::test]
async fn profiles_and_matches_are_listed_once_with_lastmod() {
    let dir_hidden = |data: &std::path::Path| {
        demoviewer_server::hidden::edit(data, ME + 1, true).unwrap();
    };
    let s = common::site_before(|c| c, dir_hidden);
    let mut sum = summary(&sha(1));
    sum.event = Some("blast-2025".into());
    // Two ids, one sha: the oldest id is the match's.
    demo(&s.store, Status::Done, &sha(1), Some(sum));
    demo(&s.store, Status::Done, &sha(1), None);
    // A match not done is not listed, nor is a player who only played it.
    let mut other = summary(&sha(2));
    other.players.truncate(1);
    other.players[0].steamid = (ME + 500).to_string();
    other.played_unix = None;
    demo(&s.store, Status::Parsing, &sha(2), Some(other));
    let mut third = summary(&sha(3));
    third.played_unix = None;
    third.players.truncate(1);
    let third_id = demo(&s.store, Status::Done, &sha(3), Some(third));

    let (_, index) = text(&s, "/sitemap.xml").await;
    for f in ["pages", "events"] {
        assert!(
            index.contains(&format!("<loc>https://skunk.club/sitemap-{f}.xml</loc>")),
            "{index}"
        );
    }
    assert!(
        index.contains("<loc>https://skunk.club/sitemap-profiles-1.xml</loc>"),
        "{index}"
    );
    assert!(
        index.contains("<loc>https://skunk.club/sitemap-matches-1.xml</loc>"),
        "{index}"
    );

    let (_, matches) = text(&s, "/sitemap-matches-1.xml").await;
    let rec = s.store.find_by_sha(&sha(1)).unwrap();
    assert_eq!(matches.matches("<url>").count(), 2, "{matches}");
    assert_eq!(
        matches.matches(&format!("/d/{}<", rec.id)).count(),
        1,
        "{matches}"
    );
    assert!(
        matches.contains(&format!(
            "<loc>https://skunk.club/d/{}</loc><lastmod>2025-10-22</lastmod>",
            rec.id
        )),
        "{matches}"
    );
    assert!(
        matches.contains(&format!(
            "<loc>https://skunk.club/d/{third_id}</loc><lastmod>2025-10-24</lastmod>"
        )),
        "{matches}"
    );

    let (_, profiles) = text(&s, "/sitemap-profiles-1.xml").await;
    assert!(
        profiles.contains(&format!(
            "<loc>https://skunk.club/profiles/{ME}</loc><lastmod>2025-10-24</lastmod>"
        )),
        "{profiles}"
    );
    assert!(
        profiles.contains(&format!("profiles/{}<", ME + 2)),
        "{profiles}"
    );
    assert!(
        !profiles.contains(&format!("profiles/{}<", ME + 1)),
        "hidden: {profiles}"
    );
    assert!(
        !profiles.contains(&format!("profiles/{}<", ME + 500)),
        "not done: {profiles}"
    );

    let (_, events) = text(&s, "/sitemap-events.xml").await;
    assert!(
        events.contains(
            "<loc>https://skunk.club/events/blast-2025</loc><lastmod>2025-10-22</lastmod>"
        ),
        "{events}"
    );
}

#[tokio::test]
async fn the_built_sitemap_is_reused_within_the_ttl() {
    let s = site(|c| c);
    let (_, before) = text(&s, "/sitemap-matches-1.xml").await;
    assert_eq!(before, "not found");
    demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let (status, _) = text(&s, "/sitemap-matches-1.xml").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "still the cached build");
}
