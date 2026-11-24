//! Match pages for crawlers: `/d/{id}` carries the match's title and preview tags in the web
//! app's page, and `/og/{id}.jpg` is its preview card (`/og/{id}.png` the same, for pages
//! Discord read before the card was a JPEG). The router runs in process over a temp
//! data dir with a stub job queue; matches are put straight into the store.

use std::path::Path;
use std::time::Duration;

use axum::http::{header, StatusCode};
use axum::Router;
use demoviewer_server::config::{Config, Site};
use demoviewer_server::matches::MatchSummary;
use demoviewer_server::pages::{HOME_DESCRIPTION, HOME_TITLE};
use demoviewer_server::preview;
use demoviewer_server::store::{Status, Store};
use tiny_skia::{Color, Pixmap};

mod common;
use common::{call, demo, link_rel, meta, page, sha, site, summary, Server, PAGE};

fn title(html: &str) -> &str {
    assert_eq!(html.matches("<title>").count(), 1, "{html}");
    let at = html.find("<title>").unwrap() + "<title>".len();
    &html[at..at + html[at..].find("</title>").unwrap()]
}

/// The preview card's JPEG, checked to be one of 1200×630.
async fn preview(app: &Router, id: &str) -> Vec<u8> {
    let (status, headers, body) = call(app, &format!("/og/{id}.jpg")).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=86400");
    assert_eq!(Card::decode(&body).size(), (1200, 630));
    body
}

/// A decoded card, to read its colours.
struct Card {
    width: usize,
    height: usize,
    rgb: Vec<u8>,
}

impl Card {
    fn decode(jpeg: &[u8]) -> Card {
        let mut d = jpeg_decoder::Decoder::new(jpeg);
        let rgb = d.decode().unwrap();
        let info = d.info().unwrap();
        assert_eq!(info.pixel_format, jpeg_decoder::PixelFormat::RGB24);
        Card {
            width: usize::from(info.width),
            height: usize::from(info.height),
            rgb,
        }
    }

    fn size(&self) -> (usize, usize) {
        (self.width, self.height)
    }

    fn at(&self, x: usize, y: usize) -> (u8, u8, u8) {
        let i = (y * self.width + x) * 3;
        (self.rgb[i], self.rgb[i + 1], self.rgb[i + 2])
    }
}

/// A `width`×`height` opaque PNG of one colour.
fn image(path: &Path, width: u32, height: u32, color: Color) {
    let mut p = Pixmap::new(width, height).unwrap();
    p.fill(color);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    p.save_png(path).unwrap();
}

/// The description of [`summary`]: alpha has the most kills (20) and 2200 damage in 22 rounds.
const DESCRIPTION: &str = "alpha led with 20 kills and 100 ADR · 22 rounds in 39 min · \
                           Valve matchmaking, EU West · Oct 22, 2025. Watch this CS2 demo in 3D.";

#[tokio::test]
async fn a_done_matchs_page_has_its_title_and_preview_tags() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let (_, headers, _) = call(&s.app, &format!("/d/{id}")).await;
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    let html = page(&s.app, &format!("/d/{id}?round=3")).await;

    assert_eq!(
        title(&html),
        "Mirage 13–9 · CS2 replay · skunk.club",
        "{html}"
    );
    let expect = [
        ("og:site_name", "skunk.club".to_owned()),
        ("og:type", "website".to_owned()),
        ("og:title", "Mirage 13–9".to_owned()),
        ("og:description", DESCRIPTION.to_owned()),
        ("og:url", format!("https://skunk.club/d/{id}")),
        ("og:image", format!("https://skunk.club/og/{id}.jpg")),
        ("og:image:type", "image/jpeg".to_owned()),
        ("og:image:width", "1200".to_owned()),
        ("og:image:height", "630".to_owned()),
        (
            "og:image:alt",
            "Mirage 13–9: the score, each round&#39;s winner and both teams&#39; kills, deaths \
             and ADR"
                .to_owned(),
        ),
        ("twitter:card", "summary_large_image".to_owned()),
        // The embed's edge is the site's crimson, whoever won.
        ("theme-color", "#e4163a".to_owned()),
    ];
    for (key, value) in expect {
        assert_eq!(
            meta(&html, key).as_deref(),
            Some(value.as_str()),
            "{key}: {html}"
        );
    }
    // In the head, and the rest of the page is the app's.
    let head_end = html.find("</head>").unwrap();
    assert!(html.find("og:title").unwrap() < head_end);
    assert!(
        html.contains("<script type=\"module\" crossorigin src=\"/assets/index-abc.js\"></script>")
    );
    // The scoreboard just after the app's root, which stays empty for the app to mount in.
    assert!(
        html.contains("<div id=\"root\"></div><div id=\"pre\"><main class=\"pre\">"),
        "{html}"
    );
    assert!(html.starts_with("<!doctype html>"));
}

/// Without a public URL the tags have no absolute links; a match whose played date is unknown
/// is dated by when it was stored.
#[tokio::test]
async fn without_a_public_url_there_are_no_links_and_the_date_falls_back() {
    let s = site(|c| Config {
        public_url: None,
        ..c
    });
    let id = demo(
        &s.store,
        Status::Done,
        &sha(2),
        Some(MatchSummary {
            played_unix: None,
            players: vec![],
            ..summary(&sha(2))
        }),
    );
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(meta(&html, "og:title").as_deref(), Some("Mirage 13–9"));
    assert_eq!(
        meta(&html, "og:description").as_deref(),
        Some("22 rounds in 39 min · Valve matchmaking, EU West · Oct 24, 2025. Watch this CS2 demo in 3D.")
    );
    assert_eq!(meta(&html, "og:image"), None, "{html}");
    assert_eq!(meta(&html, "og:url"), None, "{html}");
    assert_eq!(meta(&html, "robots"), None, "{html}");
    assert_eq!(link_rel(&html, "canonical"), None, "{html}");
}

/// A tournament's match names its event as the site does ("IEM Cologne Major 2026", never its
/// slug), in place of the server it was played on.
#[tokio::test]
async fn a_tournaments_match_names_its_event() {
    let s = site(|c| c);
    let m = MatchSummary {
        event: Some("iem_cologne_major_2026".into()),
        server_name: "HLTV // IEM Cologne".into(),
        ..summary(&sha(9))
    };
    let id = demo(&s.store, Status::Done, &sha(9), Some(m));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(
        meta(&html, "og:description").as_deref(),
        Some(
            "alpha led with 20 kills and 100 ADR · 22 rounds in 39 min · IEM Cologne Major 2026 \
             · Oct 22, 2025. Watch this CS2 demo in 3D."
        )
    );
}

#[tokio::test]
async fn names_and_maps_are_escaped() {
    let s = site(|c| c);
    let mut m = summary(&sha(3));
    m.map = "de_<b>\"x'&".into();
    m.server_name = "<i>lan</i>".into();
    // The top fragger's name escapes to nothing: the next one leads the description.
    m.players[0].name = " \u{0}\u{2066}\u{202e} ".into();
    m.players[1].name = "<script>\"&\nx".into();
    let id = demo(&s.store, Status::Done, &sha(3), Some(m));
    let html = page(&s.app, &format!("/d/{id}")).await;

    assert_eq!(
        title(&html),
        "&lt;b&gt;&quot;x&#39;&amp; 13–9 · CS2 replay · skunk.club",
        "{html}"
    );
    assert_eq!(
        meta(&html, "og:title").as_deref(),
        Some("&lt;b&gt;&quot;x&#39;&amp; 13–9")
    );
    assert_eq!(
        meta(&html, "og:description").as_deref(),
        Some(
            "&lt;script&gt;&quot;&amp;x led with 19 kills and 95 ADR · 22 rounds in 39 min · \
             &lt;i&gt;lan&lt;/i&gt; · Oct 22, 2025. Watch this CS2 demo in 3D."
        )
    );
    assert!(!html.contains("<script>"), "{html}");
    assert!(!html.contains("<b>"), "{html}");
}

/// An unknown, malformed or failed id is a 404, and an unfinished one or a done one with no
/// summary (a pack parsed before summaries existed) a 200: either way the app's page with its
/// own title and no preview tags, `noindex`. Player pages do not exist: `/p/…` is the app's
/// page as it is.
#[tokio::test]
async fn ids_without_a_match_get_the_plain_page() {
    let s = site(|c| c);
    let unknown = Store::new_id();
    let queued = demo(&s.store, Status::Queued, &sha(4), None);
    let failed = demo(&s.store, Status::Error, &sha(5), Some(summary(&sha(5))));
    let no_summary = demo(&s.store, Status::Done, &sha(6), None);
    for (path, want) in [
        (format!("/d/{unknown}"), StatusCode::NOT_FOUND),
        ("/d/not-an-id".to_owned(), StatusCode::NOT_FOUND),
        ("/d/%FF%FE".to_owned(), StatusCode::NOT_FOUND),
        (format!("/d/{queued}"), StatusCode::OK),
        (format!("/d/{failed}"), StatusCode::NOT_FOUND),
        (format!("/d/{no_summary}"), StatusCode::OK),
    ] {
        let (status, _, body) = call(&s.app, &path).await;
        assert_eq!(status, want, "{path}");
        let html = String::from_utf8(body).unwrap();
        assert_eq!(title(&html), "skunk.club", "{path}");
        assert!(!html.contains("og:"), "{path}: {html}");
        assert!(!html.contains("twitter:"), "{path}: {html}");
        assert_eq!(meta(&html, "robots").as_deref(), Some("noindex"), "{path}");
        assert_eq!(link_rel(&html, "canonical"), None, "{path}");
        assert_eq!(
            html.replace("    <meta name=\"robots\" content=\"noindex\">\n", ""),
            PAGE,
            "{path}"
        );
    }
    let id = demo(&s.store, Status::Done, &sha(7), Some(summary(&sha(7))));
    let (status, _, body) = call(&s.app, "/p/76561198000000000").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let plain = |body: Vec<u8>| {
        String::from_utf8(body)
            .unwrap()
            .replace("    <meta name=\"robots\" content=\"noindex\">\n", "")
    };
    // Paths no route owns get the not-found page: the app's, with its own title and description.
    let not_found = PAGE
        .replace(
            "<title>skunk.club</title>",
            "<title>Not found · skunk.club</title>",
        )
        .replace(
            "  </head>",
            "    <meta name=\"description\" content=\"This page does not exist.\">\n  </head>",
        );
    assert_eq!(plain(body), not_found);
    // A path below a match is not its page.
    let (status, _, body) = call(&s.app, &format!("/d/{id}/x")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(plain(body), not_found);
}

/// `DEMOVIEWER_PREVIEWS=off`: the page keeps its title, carries no preview tags, and there is
/// no preview image.
#[tokio::test]
async fn previews_off_means_no_preview_tags_and_no_image() {
    let s = site(|c| Config {
        site: Site { previews: false },
        ..c
    });
    let id = demo(&s.store, Status::Done, &sha(8), Some(summary(&sha(8))));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(title(&html), "Mirage 13–9 · CS2 replay · skunk.club");
    assert!(!html.contains("og:"), "{html}");
    assert!(!html.contains("twitter:"), "{html}");
    assert_eq!(meta(&html, "robots"), None, "a done match is indexable");
    for ext in ["jpg", "png"] {
        let (status, _, _) = call(&s.app, &format!("/og/{id}.{ext}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{ext}");
    }
}

/// A card kept from before the card's look last changed (the day as the site writes it,
/// Valve's region in words) is drawn again, in its place; the new one is kept.
#[tokio::test]
async fn a_card_drawn_in_an_older_look_is_drawn_again() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(8), Some(summary(&sha(8))));
    let kept = s.dir.path().join(format!("data/og/{}.jpg", sha(8)));
    std::fs::create_dir_all(kept.parent().unwrap()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    std::fs::write(&kept, b"a card drawn as 2026-10-24").unwrap();
    let drawn = preview(&s.app, &id).await;
    assert_ne!(drawn, b"a card drawn as 2026-10-24");
    assert!(drawn
        .windows(preview::MATCH_DESIGN.len())
        .any(|w| w == preview::MATCH_DESIGN));
    assert_eq!(std::fs::read(&kept).unwrap(), drawn, "kept in its place");
    assert_eq!(preview(&s.app, &id).await, drawn);
}

/// The image is drawn once per pack and kept in `og/<sha>.jpg`: a second request, and a
/// second id of the same pack, are answered from the file; so is the `.png` address.
#[tokio::test]
async fn the_preview_is_1200_by_630_and_drawn_once_per_pack() {
    let s = site(|c| c);
    let first = demo(&s.store, Status::Done, &sha(9), Some(summary(&sha(9))));
    let png = preview(&s.app, &first).await;
    let kept = s.dir.path().join(format!("data/og/{}.jpg", sha(9)));
    let mtime = std::fs::metadata(&kept).unwrap().modified().unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;

    let second = demo(&s.store, Status::Done, &sha(9), None);
    for id in [&first, &second] {
        assert_eq!(preview(&s.app, id).await, png);
    }
    let (status, headers, old_address) = call(&s.app, &format!("/og/{first}.png")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(old_address, png);
    assert_eq!(std::fs::metadata(&kept).unwrap().modified().unwrap(), mtime);
}

/// A summary rewritten after its image was drawn (an alias adding the played date) gets the
/// image drawn again.
#[tokio::test]
async fn a_rewritten_summary_gets_its_preview_drawn_again() {
    let s = site(|c| c);
    let unplayed = MatchSummary {
        played_unix: None,
        ..summary(&sha(20))
    };
    let id = demo(&s.store, Status::Done, &sha(20), Some(unplayed.clone()));
    let summary_path = s.store.summary_path(&sha(20));
    std::fs::write(&summary_path, serde_json::to_vec(&unplayed).unwrap()).unwrap();
    tokio::time::sleep(Duration::from_millis(20)).await;
    let before = preview(&s.app, &id).await;
    assert_eq!(preview(&s.app, &id).await, before);

    tokio::time::sleep(Duration::from_millis(20)).await;
    let played = summary(&sha(20));
    std::fs::write(&summary_path, serde_json::to_vec(&played).unwrap()).unwrap();
    s.store.matches().insert(played);
    let after = preview(&s.app, &id).await;
    assert_ne!(after, before, "the date changed");
    assert_eq!(preview(&s.app, &id).await, after);
}

/// Requests for a preview that is not drawn yet, all at once, get the same image.
#[tokio::test]
async fn simultaneous_requests_get_one_image() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(10), Some(summary(&sha(10))));
    let all = futures_util::future::join_all((0..6).map(|_| preview(&s.app, &id))).await;
    assert!(all.windows(2).all(|w| w[0] == w[1]));
    let og = std::fs::read_dir(s.dir.path().join("data/og"))
        .unwrap()
        .count();
    assert_eq!(og, 1);
}

/// The card of a match like [`summary`] on `map`.
async fn card(s: &Server, map: &str, tag: u8) -> Card {
    let m = MatchSummary {
        map: map.into(),
        ..summary(&sha(tag))
    };
    let id = demo(&s.store, Status::Done, &sha(tag), Some(m));
    Card::decode(&preview(&s.app, &id).await)
}

/// The map's screenshot (`hero.png`) fills the card, darkened, more so at the bottom. A map
/// without one gets its radar, faint, on the right; one with neither, or with images that are
/// not PNGs, still has a card; a map name that climbs out of the maps dir picks up nothing.
#[tokio::test]
async fn the_screenshot_fills_the_card_or_the_radar_shows_on_the_right() {
    let s = site(|c| c);
    let assets = s.dir.path().join("assets/maps");
    let red = Color::from_rgba8(255, 0, 0, 255);
    let green = Color::from_rgba8(0, 255, 0, 255);
    image(&assets.join("de_mirage/hero.png"), 1200, 630, red);
    image(&assets.join("de_mirage/radar.png"), 64, 64, green);
    // A hero that is not a PNG: the radar instead.
    image(&assets.join("de_nuke/radar.png"), 64, 64, green);
    std::fs::write(assets.join("de_nuke/hero.png"), b"not a png").unwrap();
    std::fs::create_dir_all(assets.join("de_train")).unwrap();
    std::fs::write(assets.join("de_train/radar.png"), b"not a png").unwrap();
    // Where `assets/maps/../../web/hero.png` leads.
    image(&s.dir.path().join("web/hero.png"), 1200, 630, red);
    image(&s.dir.path().join("web/radar.png"), 64, 64, green);

    // Points clear of any text: right of the title, and below the right column.
    let (upper, lower) = ((1150, 250), (1190, 622));
    let mirage = card(&s, "de_mirage", 11).await;
    let (r, g, b) = mirage.at(upper.0, upper.1);
    assert!(
        (100..160).contains(&r) && g < 24 && b < 24,
        "{:?}",
        (r, g, b)
    );
    let (r_low, g, b) = mirage.at(lower.0, lower.1);
    assert!(
        r_low < r - 40 && r_low > 15 && g < 24 && b < 24,
        "{:?}",
        (r_low, g, b)
    );

    let nuke = card(&s, "de_nuke", 12).await;
    let (r, g, b) = nuke.at(upper.0, upper.1);
    assert!(
        r < 24 && (60..120).contains(&g) && b < 24,
        "{:?}",
        (r, g, b)
    );
    assert!(
        nuke.at(20, 250).1 < 16,
        "the radar is on the right: {:?}",
        nuke.at(20, 250)
    );

    for (map, tag) in [("de_train", 13), ("de_cache", 14), ("../../web", 21)] {
        let (r, g, b) = card(&s, map, tag).await.at(upper.0, upper.1);
        assert!(r < 16 && g < 16 && b < 16, "{map}: {:?}", (r, g, b));
    }
}

/// Names and maps in scripts the font does not cover, emoji and right-to-left text end up in
/// the tags as they are, and in the image as far as the font goes: a missing glyph is skipped.
#[tokio::test]
async fn names_in_any_script_render_without_panicking() {
    let s = site(|c| c);
    let mut m = summary(&sha(15));
    m.map = "de_東京🙂".into();
    m.players[0].name = "日本語の名前".into();
    m.players[1].name = "لاعب محترف".into();
    m.players[2].name = "🔥🔥 игрок".into();
    let id = demo(&s.store, Status::Done, &sha(15), Some(m));
    let html = page(&s.app, &format!("/d/{id}")).await;
    assert_eq!(title(&html), "東京🙂 13–9 · CS2 replay · skunk.club");
    let description = meta(&html, "og:description").unwrap();
    assert!(
        description.starts_with("日本語の名前 led with 20 kills"),
        "{description}"
    );
    preview(&s.app, &id).await;

    // A map name far wider than the panel.
    let mut long = summary(&sha(16));
    long.map = format!("de_{}", "w".repeat(5000));
    let id = demo(&s.store, Status::Done, &sha(16), Some(long));
    preview(&s.app, &id).await;
}

#[tokio::test]
async fn preview_paths_without_a_done_match_are_404() {
    let s = site(|c| c);
    let done = demo(&s.store, Status::Done, &sha(17), Some(summary(&sha(17))));
    let queued = demo(&s.store, Status::Queued, &sha(18), Some(summary(&sha(18))));
    let no_summary = demo(&s.store, Status::Done, &sha(19), None);
    for path in [
        format!("/og/{}.png", Store::new_id()),
        format!("/og/{done}"),
        format!("/og/{done}.jpeg"),
        format!("/og/{done}.gif"),
        format!("/og/{done}.jpg/x"),
        format!("/og/{done}.png/x"),
        format!("/og/{queued}.jpg"),
        format!("/og/{queued}.png"),
        format!("/og/{no_summary}.jpg"),
        format!("/og/{no_summary}.png"),
        "/og/..%2Fdemos.json.png".to_owned(),
    ] {
        let (status, _, _) = call(&s.app, &path).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
    assert_eq!(
        std::fs::read_dir(s.dir.path().join("data/og"))
            .unwrap()
            .count(),
        0
    );
}

/// The site's own pages preview in Discord as the site: their title and what they are for, the
/// homepage's still (when the assets have it) as a large image, and the site's crimson as the
/// embed's edge. They stay indexable, and the rest of the page is the app's.
#[tokio::test]
async fn the_site_pages_preview_as_the_site() {
    let s = site(|c| c);
    std::fs::create_dir_all(s.dir.path().join("assets/site/home")).unwrap();
    std::fs::write(s.dir.path().join("assets/site/home/poster.jpg"), b"jpeg").unwrap();
    for (uri, url, og_title) in [
        ("/", "https://skunk.club/", HOME_TITLE),
        (
            "/track?signin=failed",
            "https://skunk.club/track",
            "Track your matches",
        ),
        ("/legal", "https://skunk.club/legal", "Contact"),
    ] {
        let (_, headers, _) = call(&s.app, uri).await;
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{uri}");
        let html = page(&s.app, uri).await;
        for (key, value) in [
            ("og:site_name", "skunk.club"),
            ("og:type", "website"),
            ("og:title", og_title),
            ("og:url", url),
            ("og:image", "https://skunk.club/site/home/poster.jpg"),
            ("twitter:card", "summary_large_image"),
            ("theme-color", "#e4163a"),
        ] {
            assert_eq!(
                meta(&html, key).as_deref(),
                Some(value),
                "{uri} {key}: {html}"
            );
        }
        assert!(
            meta(&html, "og:description").is_some_and(|d| !d.is_empty()),
            "{uri}"
        );
        // Everything but the sign-in flow is indexable.
        assert_eq!(
            meta(&html, "robots").is_some(),
            uri.starts_with("/track"),
            "{uri}"
        );
        assert!(html.contains("<div id=\"root\"></div>"), "{uri}");
    }
    let home = page(&s.app, "/").await;
    assert_eq!(
        meta(&home, "og:description").as_deref(),
        Some(HOME_DESCRIPTION.replace('\'', "&#39;").as_str())
    );
}

/// Every page has a description for search engines and link previews that read no OpenGraph
/// (`<meta name="description">`): the one it previews with, in place of the app's own (the
/// homepage's words), which a page with nothing of its own keeps. Never two.
#[tokio::test]
async fn every_page_has_one_description() {
    let s = site(|c| c);
    let default = "Watch CS2 demos in 3D.";
    std::fs::write(
        s.dir.path().join("web/index.html"),
        PAGE.replace(
            "<title>",
            &format!("<meta name=\"description\" content=\"{default}\" />\n    <title>"),
        ),
    )
    .unwrap();
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let legal = "Legal requests, privacy, data and takedowns for skunk.club: contact@skunk.legal.";
    for (uri, want) in [
        (format!("/d/{id}"), DESCRIPTION),
        ("/legal".to_owned(), legal),
        (format!("/d/{}", Store::new_id()), default),
        ("/profiles/76561198000000099".to_owned(), default),
        ("/some/route".to_owned(), "This page does not exist."),
    ] {
        let (status, _, body) = call(&s.app, &uri).await;
        if uri == "/some/route" {
            assert_eq!(status, StatusCode::NOT_FOUND);
        }
        let html = String::from_utf8(body).unwrap();
        assert_eq!(
            html.matches("<meta name=\"description\"").count(),
            1,
            "{uri}: {html}"
        );
        assert_eq!(meta(&html, "description").as_deref(), Some(want), "{uri}");
    }
}

/// Without the homepage's still in the assets the site pages have no image, and say so to
/// Discord with the small card.
#[tokio::test]
async fn without_the_still_the_site_pages_have_no_image() {
    let s = site(|c| c);
    let html = page(&s.app, "/").await;
    assert_eq!(meta(&html, "og:image"), None);
    assert_eq!(meta(&html, "twitter:card").as_deref(), Some("summary"));
    assert_eq!(meta(&html, "theme-color").as_deref(), Some("#e4163a"));
}
