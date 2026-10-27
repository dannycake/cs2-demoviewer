//! Match pages for crawlers: `/d/{id}` carries the match's title and preview tags in the web
//! app's page, and `/og/{id}.jpg` is its preview card (`/og/{id}.png` the same, for pages
//! Discord read before the card was a JPEG). The router runs in process over a temp
//! data dir with a stub job queue; matches are put straight into the store.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use demoviewer_server::app::build_app;
use demoviewer_server::config::{Config, Site};
use demoviewer_server::jobs::Jobs;
use demoviewer_server::matches::{MatchSummary, SummaryPlayer};
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::store::{Status, Store};
use tempfile::TempDir;
use tiny_skia::{Color, Pixmap};
use tower::ServiceExt;
use url::Url;

/// The web app's page, shaped like the build's.
const PAGE: &str = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    \
<title>cs.skunk.to</title>\n    <script type=\"module\" crossorigin src=\"/assets/index-abc.js\"></script>\n  \
</head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n";

/// 2025-10-22 20:00 UTC and 2025-10-24 10:00 UTC.
const PLAYED: u64 = 1_761_163_200;
const CREATED: u64 = 1_761_300_000;

const NAMES: [&str; 11] = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett",
    "kilo",
];

struct Server {
    dir: TempDir,
    store: Arc<Store>,
    app: Router,
}

/// A server with `index.html` in its web dir and `https://cs.skunk.to/` as its public URL.
fn site(cfg: impl FnOnce(Config) -> Config) -> Server {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("web")).unwrap();
    std::fs::write(dir.path().join("web/index.html"), PAGE).unwrap();
    let cfg = Arc::new(cfg(Config {
        data_dir: dir.path().join("data"),
        assets_dir: dir.path().join("assets"),
        web_dir: dir.path().join("web"),
        public_url: Some(Url::parse("https://cs.skunk.to/").unwrap()),
        ..Config::default()
    }));
    let store = Arc::new(Store::open(&cfg).unwrap());
    let (jobs, _rx) = Jobs::channel();
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    let app = build_app(cfg, store.clone(), jobs, limiter);
    Server { dir, store, app }
}

/// Mirage 13–9 (the CTs won, the sides swapped after 12 rounds), played 2025-10-22, eleven
/// players, the first with the most kills.
fn summary(sha: &str) -> MatchSummary {
    MatchSummary {
        sha256: sha.into(),
        map: "de_mirage".into(),
        rounds: 22,
        score_t: 9,
        score_ct: 13,
        duration_s: 2357,
        server_name: "Valve Counter-Strike 2 eu_west Server".into(),
        game_build: "14185".into(),
        players: NAMES
            .iter()
            .enumerate()
            .map(|(i, name)| SummaryPlayer {
                steamid: (76_561_198_000_000_000u64 + i as u64).to_string(),
                name: (*name).into(),
                team: if i % 2 == 0 { 2 } else { 3 },
                kills: 20 - i as u16,
                deaths: 10,
                assists: 3,
                damage: 2200 - 100 * i as u32,
                headshots: 5,
            })
            .collect(),
        created_unix: CREATED,
        played_unix: Some(PLAYED),
        match_id: None,
        round_winners: (0..22)
            .map(|r| if matches!(r % 5, 1 | 3) { 2 } else { 3 })
            .collect(),
        swaps: vec![12],
        version: demoviewer_server::matches::SUMMARY_VERSION,
    }
}

fn sha(tag: u8) -> String {
    format!("{tag:02x}").repeat(32)
}

/// A new demo id in `status` for the pack `sha`, whose summary (if any) is indexed.
fn demo(store: &Store, status: Status, sha: &str, summary: Option<MatchSummary>) -> String {
    let id = Store::new_id();
    store.create(&id);
    store.update(&id, |r| {
        r.status = status;
        r.sha256 = Some(sha.into());
    });
    if let Some(s) = summary {
        store.matches().insert(s);
    }
    id
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

async fn call(app: &Router, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(get(uri)).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

async fn page(app: &Router, uri: &str) -> String {
    let (status, headers, body) = call(app, uri).await;
    assert_eq!(status, StatusCode::OK, "{uri}");
    assert!(
        headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"),
        "{uri}: {headers:?}"
    );
    String::from_utf8(body).unwrap()
}

/// The `content` of the `<meta property=…>` or `<meta name=…>` called `key`.
fn meta(html: &str, key: &str) -> Option<String> {
    ["property", "name"].iter().find_map(|attr| {
        let start = format!("<meta {attr}=\"{key}\" content=\"");
        let at = html.find(&start)? + start.len();
        Some(html[at..at + html[at..].find('"')?].to_owned())
    })
}

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
                           Valve matchmaking, eu_west · 2025-10-22. Watch it in 3D.";

#[tokio::test]
async fn a_done_matchs_page_has_its_title_and_preview_tags() {
    let s = site(|c| c);
    let id = demo(&s.store, Status::Done, &sha(1), Some(summary(&sha(1))));
    let (_, headers, _) = call(&s.app, &format!("/d/{id}")).await;
    assert_eq!(headers[header::CACHE_CONTROL], "no-cache");
    let html = page(&s.app, &format!("/d/{id}?round=3")).await;

    assert_eq!(title(&html), "Mirage 13–9 · cs.skunk.to", "{html}");
    let expect = [
        ("og:site_name", "cs.skunk.to".to_owned()),
        ("og:type", "website".to_owned()),
        ("og:title", "Mirage 13–9".to_owned()),
        ("og:description", DESCRIPTION.to_owned()),
        ("og:url", format!("https://cs.skunk.to/d/{id}")),
        ("og:image", format!("https://cs.skunk.to/og/{id}.jpg")),
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
        // The CTs won: the embed's edge is their blue.
        ("theme-color", "#4da3ff".to_owned()),
        ("robots", "noindex".to_owned()),
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
    assert!(html.contains("<div id=\"root\"></div>"));
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
        Some("22 rounds in 39 min · Valve matchmaking, eu_west · 2025-10-24. Watch it in 3D.")
    );
    assert_eq!(meta(&html, "og:image"), None, "{html}");
    assert_eq!(meta(&html, "og:url"), None, "{html}");
    assert_eq!(meta(&html, "robots").as_deref(), Some("noindex"));
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
        "&lt;b&gt;&quot;x&#39;&amp; 13–9 · cs.skunk.to",
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
             &lt;i&gt;lan&lt;/i&gt; · 2025-10-22. Watch it in 3D."
        )
    );
    assert!(!html.contains("<script>"), "{html}");
    assert!(!html.contains("<b>"), "{html}");
}

/// An unknown, malformed, unfinished or failed id, or a done one with no summary (a pack
/// parsed before summaries existed), gets the app's page with its own title and no preview
/// tags; still `noindex`. Player pages do not exist: `/p/…` is the app's page as it is.
#[tokio::test]
async fn ids_without_a_match_get_the_plain_page() {
    let s = site(|c| c);
    let unknown = Store::new_id();
    let queued = demo(&s.store, Status::Queued, &sha(4), None);
    let failed = demo(&s.store, Status::Error, &sha(5), Some(summary(&sha(5))));
    let no_summary = demo(&s.store, Status::Done, &sha(6), None);
    for path in [
        format!("/d/{unknown}"),
        "/d/not-an-id".to_owned(),
        "/d/%FF%FE".to_owned(),
        format!("/d/{queued}"),
        format!("/d/{failed}"),
        format!("/d/{no_summary}"),
    ] {
        let html = page(&s.app, &path).await;
        assert_eq!(title(&html), "cs.skunk.to", "{path}");
        assert!(!html.contains("og:"), "{path}: {html}");
        assert!(!html.contains("twitter:"), "{path}: {html}");
        assert_eq!(meta(&html, "robots").as_deref(), Some("noindex"), "{path}");
        assert_eq!(
            html.replace("    <meta name=\"robots\" content=\"noindex\">\n", ""),
            PAGE,
            "{path}"
        );
    }
    let id = demo(&s.store, Status::Done, &sha(7), Some(summary(&sha(7))));
    let (status, _, body) = call(&s.app, "/p/76561198000000000").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, PAGE.as_bytes());
    // A path below a match is not its page.
    let (_, _, body) = call(&s.app, &format!("/d/{id}/x")).await;
    assert_eq!(body, PAGE.as_bytes());
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
    assert_eq!(title(&html), "Mirage 13–9 · cs.skunk.to");
    assert!(!html.contains("og:"), "{html}");
    assert!(!html.contains("twitter:"), "{html}");
    assert_eq!(meta(&html, "robots").as_deref(), Some("noindex"));
    for ext in ["jpg", "png"] {
        let (status, _, _) = call(&s.app, &format!("/og/{id}.{ext}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{ext}");
    }
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
    assert_eq!(title(&html), "東京🙂 13–9 · cs.skunk.to");
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
