//! Match pages for crawlers. `GET /d/{id}` is the web app's `index.html` with the match's title
//! and, when previews are on (`Config::site`), OpenGraph tags in its head, so a link pasted in
//! Discord previews as the match; `GET /og/{id}.jpg` is that preview's image
//! ([`crate::preview`]), drawn once per pack, one at a time, and kept as `og/<sha>.jpg`.
//! `/og/{id}.png`, the address before the card was a JPEG, answers the same image, for pages
//! Discord read then.
//!
//! Every match page is `noindex`, whatever its id: the site is link only (spec §13.2). An id
//! that is not a done match with a summary gets the app's page with no other tags; the app then
//! says what is wrong. There are no player pages: `/p/…` is the app's page as it is.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::rejection::PathRejection;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use url::Url;

use crate::api::AppState;
use crate::config::Config;
use crate::matches::{MatchSummary, MAX_NAME_CHARS};
use crate::preview;
use crate::store::{self, valid_id, Status, Store};

/// The site's name, as page titles and previews show it.
pub const SITE_NAME: &str = "cs.skunk.to";
const NOINDEX: &str = r#"<meta name="robots" content="noindex">"#;

/// `/d/{id}` and `/og/{file}` (anything deeper under `/og/` is a 404, not the app), before the
/// web app's fallback.
pub fn routes() -> Router<AppState> {
    let og = Router::new()
        .route("/{file}", get(preview_image))
        .fallback(|| async { not_found() });
    Router::new()
        .route("/d/{id}", get(match_page))
        .nest("/og", og)
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// The summary of the match demo `id` shows, when `id` is a done demo whose pack has one (as
/// `demos.json` has it, [`Store::get_saved`]).
async fn done_match(store: &Store, id: &str) -> Option<Arc<MatchSummary>> {
    if !valid_id(id) {
        return None;
    }
    let r = store
        .get_saved(id)
        .await
        .filter(|r| r.status == Status::Done)?;
    store.matches().get(r.sha256.as_deref()?)
}

/// `index.html` is read on every request, as the web app's fallback reads it: a web build
/// while the server runs changes the bundles it names.
async fn match_page(
    State(s): State<AppState>,
    id: Result<UrlPath<String>, PathRejection>,
) -> Response {
    let template = match tokio::fs::read_to_string(s.cfg.web_dir.join("index.html")).await {
        Ok(t) => t,
        Err(e) if e.kind() == ErrorKind::NotFound => return not_found(),
        Err(e) => {
            tracing::error!(error = %e, "reading index.html");
            return (StatusCode::INTERNAL_SERVER_ERROR, "cannot read the page").into_response();
        }
    };
    let id = id.map(|UrlPath(id)| id).unwrap_or_default();
    let summary = done_match(&s.store, &id).await;
    let html = page(&template, &id, summary.as_deref(), &s.cfg);
    (
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // Like the app's own page: revalidated, so a deploy's bundles and a match's tags
            // reach a returning visitor at once.
            (header::CACHE_CONTROL, "no-cache"),
        ],
        html,
    )
        .into_response()
}

/// The page for demo `id`: `noindex`, and for a match its title and, with previews on, the
/// preview tags; `og:url` and `og:image` only with a public URL (crawlers need absolute ones).
fn page(template: &str, id: &str, summary: Option<&MatchSummary>, cfg: &Config) -> String {
    let mut tags = vec![NOINDEX.to_owned()];
    if let Some(m) = summary.filter(|_| cfg.site.previews) {
        tags.extend(preview_tags(id, m, cfg.public_url.as_ref()));
    }
    let title = summary.map(|m| format!("{} · {SITE_NAME}", match_title(m)));
    into_head(template, title.as_deref(), &tags)
}

fn preview_tags(id: &str, m: &MatchSummary, public_url: Option<&Url>) -> Vec<String> {
    let property =
        |key: &str, value: &str| format!(r#"<meta property="{key}" content="{}">"#, escape(value));
    let mut tags = vec![
        property("og:site_name", SITE_NAME),
        property("og:type", "website"),
        property("og:title", &match_title(m)),
        property("og:description", &description(m)),
    ];
    // `id` is a valid id (base58), so both stay under the base.
    let links = public_url.and_then(|base| {
        Some((
            base.join(&format!("d/{id}")).ok()?,
            base.join(&format!("og/{id}.jpg")).ok()?,
        ))
    });
    if let Some((url, image)) = links {
        tags.extend([
            property("og:url", url.as_str()),
            property("og:image", image.as_str()),
            property("og:image:type", "image/jpeg"),
            property("og:image:width", &preview::WIDTH.to_string()),
            property("og:image:height", &preview::HEIGHT.to_string()),
            property("og:image:alt", &image_alt(m)),
        ]);
    }
    tags.push(r#"<meta name="twitter:card" content="summary_large_image">"#.to_owned());
    // The colour of the embed's edge in Discord: the winners' side's, the site's in a draw.
    tags.push(format!(
        r#"<meta name="theme-color" content="{}">"#,
        winner_colour(m)
    ));
    tags
}

/// The colour (`web/src/styles/tokens.css`) of the side the winners finished on, or the
/// site's violet in a draw.
fn winner_colour(m: &MatchSummary) -> &'static str {
    match m.score_t.cmp(&m.score_ct) {
        std::cmp::Ordering::Greater => "#f2a33a",
        std::cmp::Ordering::Less => "#4da3ff",
        std::cmp::Ordering::Equal => "#7c3aed",
    }
}

/// What the preview shows, for a reader that cannot see it.
fn image_alt(m: &MatchSummary) -> String {
    format!(
        "{}: the score, each round's winner and both teams' kills, deaths and ADR",
        match_title(m)
    )
}

/// `template` with `tags` at the end of its head, each on its own line, and with `title` (when
/// given) as its `<title>`. A template without `</head>` is returned as it is.
fn into_head(template: &str, title: Option<&str>, tags: &[String]) -> String {
    let Some(head_end) = template.find("</head>") else {
        return template.to_owned();
    };
    let mut head = template[..head_end].to_owned();
    let mut tags = tags.to_vec();
    if let Some(title) = title {
        let element = format!("<title>{}</title>", escape(title));
        let old = head.find("<title>").and_then(|start| {
            let len = head[start..].find("</title>")? + "</title>".len();
            Some(start..start + len)
        });
        match old {
            Some(range) => head.replace_range(range, &element),
            None => tags.insert(0, element),
        }
    }
    // `</head>` on a line of its own: the tags go on lines before it, indented one step more.
    let line_start = head.rfind('\n').map_or(0, |i| i + 1);
    let indent = head[line_start..].to_owned();
    let own_line = indent.chars().all(char::is_whitespace);
    let mut out = head;
    let at = if own_line { line_start } else { out.len() };
    let block: String = tags
        .iter()
        .map(|t| {
            if own_line {
                format!("{indent}  {t}\n")
            } else {
                t.clone()
            }
        })
        .collect();
    out.insert_str(at, &block);
    out.push_str(&template[head_end..]);
    out
}

/// `s` for an HTML attribute or element: `&<>"'` escaped; control characters and the bidi
/// embedding, override and isolate controls dropped (a name cannot reverse the text after it).
fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars().filter(|&c| !dropped(c)) {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// A character [`escape`] leaves out.
fn dropped(c: char) -> bool {
    matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') || c.is_control()
}

/// "Mirage 13–9": the map as players say it and the final score, the winner's first.
pub fn match_title(m: &MatchSummary) -> String {
    let [(a, _), (b, _)] = final_score(m);
    format!("{} {a}–{b}", map_name(&m.map))
}

/// The final score with each side (2 = T, 3 = CT), the higher first; T first in a draw.
pub fn final_score(m: &MatchSummary) -> [(u8, u8); 2] {
    let t = (m.score_t, 2);
    let ct = (m.score_ct, 3);
    if m.score_ct > m.score_t {
        [ct, t]
    } else {
        [t, ct]
    }
}

/// "alpha led with 31 kills and 104 ADR · 24 rounds in 39 min · Valve matchmaking, eu_west ·
/// 2025-10-22. Watch it in 3D.": the match's top fragger (most kills, then damage; not one whose
/// name escapes to nothing visible, and the ADR only when damage was counted), its length,
/// where it was played and the day.
fn description(m: &MatchSummary) -> String {
    let mut parts = Vec::new();
    let top = m
        .players
        .iter()
        .filter(|p| p.kills > 0 && matches!(p.team, 2 | 3))
        .filter(|p| p.name.chars().any(|c| !dropped(c) && !c.is_whitespace()))
        .max_by_key(|p| (p.kills, p.damage));
    if let Some(p) = top {
        let kills = if p.kills == 1 {
            "1 kill".to_owned()
        } else {
            format!("{} kills", p.kills)
        };
        let adr = p.damage as f64 / f64::from(m.rounds.max(1));
        parts.push(if p.damage > 0 {
            format!("{} led with {kills} and {adr:.0} ADR", p.name.trim())
        } else {
            format!("{} led with {kills}", p.name.trim())
        });
    }
    let rounds = if m.rounds == 1 {
        "1 round".to_owned()
    } else {
        format!("{} rounds", m.rounds)
    };
    parts.push(match m.duration_s / 60 {
        0 => rounds,
        min => format!("{rounds} in {min} min"),
    });
    let place = place(&m.server_name);
    if !place.is_empty() {
        parts.push(place);
    }
    parts.push(match_date(m));
    format!("{}. Watch it in 3D.", parts.join(" · "))
}

/// Where the match was played, as the viewer's HUD says it (`brandModel` in
/// `web/src/components/hud/models.ts`): "Valve matchmaking, eu_west" for Valve's servers, any
/// other server's name as it is.
pub fn place(server_name: &str) -> String {
    let valve = server_name
        .strip_prefix("Valve Counter-Strike 2 ")
        .and_then(|rest| rest.split_once(' '))
        .filter(|(region, rest)| !region.is_empty() && rest.starts_with("Server"))
        .map(|(region, _)| region);
    match valve {
        Some(region) => format!("Valve matchmaking, {region}"),
        None => server_name
            .chars()
            .filter(|&c| !dropped(c))
            .collect::<String>()
            .trim()
            .to_owned(),
    }
}

/// The day the match was played (UTC), or the day it was stored when that is not known.
pub fn match_date(m: &MatchSummary) -> String {
    let days = m.played_unix.unwrap_or(m.created_unix) / 86_400;
    let (y, mo, d) = civil_from_days(days);
    format!("{y:04}-{mo:02}-{d:02}")
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + u64::from(m <= 2);
    (y, m, d)
}

/// A map's name as players say it: `de_dust2` is Dust II, `de_some_map` is Some map. The web
/// app's `mapName` (`web/src/components/hud/models.ts`); at most [`MAX_NAME_CHARS`] characters.
pub fn map_name(map: &str) -> String {
    let known = match map {
        "de_ancient" => Some("Ancient"),
        "de_anubis" => Some("Anubis"),
        "de_dust2" => Some("Dust II"),
        "de_inferno" => Some("Inferno"),
        "de_mirage" => Some("Mirage"),
        "de_nuke" => Some("Nuke"),
        "de_overpass" => Some("Overpass"),
        "de_train" => Some("Train"),
        "de_vertigo" => Some("Vertigo"),
        "de_cbble" => Some("Cobblestone"),
        _ => None,
    };
    if let Some(name) = known {
        return name.to_owned();
    }
    // Without a `<lowercase letters>_` prefix, like the app's /^[a-z]+_/.
    let bare = match map.split_once('_') {
        Some((prefix, rest))
            if !prefix.is_empty() && prefix.bytes().all(|b| b.is_ascii_lowercase()) =>
        {
            rest
        }
        _ => map,
    };
    let mut chars = bare
        .chars()
        .take(MAX_NAME_CHARS)
        .map(|c| if c == '_' { ' ' } else { c });
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The preview image of the match demo `file` (`<id>.jpg`, or `<id>.png`, its address before
/// the card was a JPEG) shows; 404 when previews are off or the id is not a done match with a
/// summary.
async fn preview_image(
    State(s): State<AppState>,
    file: Result<UrlPath<String>, PathRejection>,
) -> Response {
    if !s.cfg.site.previews {
        return not_found();
    }
    let id = file.ok().and_then(|UrlPath(f)| {
        let id = f.strip_suffix(".jpg").or_else(|| f.strip_suffix(".png"))?;
        Some(id.to_owned())
    });
    let summary = match id {
        Some(id) => done_match(&s.store, &id).await,
        None => None,
    };
    let Some(summary) = summary else {
        return not_found();
    };
    match preview_jpeg(&s, summary).await {
        Ok(jpeg) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=86400"),
            ],
            jpeg,
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "drawing a preview");
            (StatusCode::INTERNAL_SERVER_ERROR, "cannot draw the preview").into_response()
        }
    }
}

/// The pack's preview: `og/<sha>.jpg` when drawn before, else drawn now and kept there. Drawing
/// holds [`AppState::drawing`] until the image is kept (also when the request is dropped
/// meanwhile), so a burst of requests for a new link draws it once.
async fn preview_jpeg(s: &AppState, summary: Arc<MatchSummary>) -> io::Result<Vec<u8>> {
    let path = s.store.og_path(&summary.sha256);
    let summary_path = s.store.summary_path(&summary.sha256);
    if let Some(jpeg) = kept(&path, &summary_path).await {
        return Ok(jpeg);
    }
    let drawing = s.drawing.clone().lock_owned().await;
    // Drawn while this request waited.
    if let Some(jpeg) = kept(&path, &summary_path).await {
        return Ok(jpeg);
    }
    let radar = map_file(&s.cfg, &summary.map, "radar.png");
    let hero = map_file(&s.cfg, &summary.map, "hero.png");
    let tmp = s.store.tmp_dir().join(format!("og-{}.jpg", summary.sha256));
    tokio::task::spawn_blocking(move || {
        let _drawing = drawing;
        let started = Instant::now();
        let read = |p: Option<PathBuf>| {
            p.and_then(|p| match fs::read(&p) {
                Ok(bytes) => Some(bytes),
                Err(e) if e.kind() == ErrorKind::NotFound => None,
                Err(e) => {
                    tracing::warn!(path = %p.display(), error = %e, "reading a map image");
                    None
                }
            })
        };
        let (hero, radar) = (read(hero), read(radar));
        let jpeg = preview::render(&summary, hero.as_deref(), radar.as_deref())
            .map_err(io::Error::other)?;
        // Whole or absent after a crash: a card cut short would be served from here for good.
        store::write_file(&tmp, &path, &jpeg)?;
        tracing::info!(
            map = %summary.map,
            bytes = jpeg.len(),
            secs = started.elapsed().as_secs_f64(),
            "drew a preview"
        );
        Ok(jpeg)
    })
    .await
    .map_err(io::Error::other)?
}

/// The image kept at `path`, unless the match summary at `summary_path` was rewritten after it
/// was drawn (an alias adding the date the match was played): that one is drawn again.
async fn kept(path: &Path, summary_path: &Path) -> Option<Vec<u8>> {
    let modified = |p: &Path| {
        let p = p.to_owned();
        async move { tokio::fs::metadata(p).await.and_then(|m| m.modified()).ok() }
    };
    let drawn = modified(path).await?;
    if modified(summary_path)
        .await
        .is_some_and(|written| written > drawn)
    {
        return None;
    }
    tokio::fs::read(path).await.ok()
}

/// `assets_dir/maps/<map>/<file>`, for a map name that is a plain directory name (the name
/// comes from the demo).
fn map_file(cfg: &Config, map: &str, file: &str) -> Option<PathBuf> {
    let plain = !map.is_empty()
        && map.len() <= 64
        && map
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    plain.then(|| cfg.assets_dir.join("maps").join(map).join(file))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_are_utc_days() {
        let date = |unix: u64| {
            let (y, m, d) = civil_from_days(unix / 86_400);
            format!("{y:04}-{m:02}-{d:02}")
        };
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(951_782_400), "2000-02-29");
        assert_eq!(date(1_761_163_200), "2025-10-22");
        assert_eq!(date(1_761_177_599), "2025-10-22");
        assert_eq!(date(1_761_177_600), "2025-10-23");
        assert_eq!(date(4_107_542_400), "2100-03-01");
    }

    #[test]
    fn maps_are_named_as_players_say_them() {
        for (map, name) in [
            ("de_dust2", "Dust II"),
            ("de_cbble", "Cobblestone"),
            ("de_some_map", "Some map"),
            ("cs_office", "Office"),
            ("ar_baggage", "Baggage"),
            ("Workshop_map", "Workshop map"),
            ("mirage", "Mirage"),
            ("_x", " x"),
            ("de_", ""),
            ("", ""),
            ("de_ßtraße", "SStraße"),
        ] {
            assert_eq!(map_name(map), name, "{map}");
        }
        assert_eq!(
            map_name(&format!("de_{}", "x".repeat(500))).chars().count(),
            MAX_NAME_CHARS
        );
    }

    #[test]
    fn the_winner_comes_first() {
        let m = |score_t, score_ct| MatchSummary {
            sha256: String::new(),
            map: "de_nuke".into(),
            rounds: 0,
            score_t,
            score_ct,
            duration_s: 0,
            server_name: String::new(),
            game_build: String::new(),
            players: vec![],
            created_unix: 0,
            played_unix: None,
            match_id: None,
            ..Default::default()
        };
        assert_eq!(match_title(&m(13, 9)), "Nuke 13–9");
        assert_eq!(match_title(&m(9, 13)), "Nuke 13–9");
        assert_eq!(final_score(&m(9, 13)), [(13, 3), (9, 2)]);
        assert_eq!(final_score(&m(12, 12)), [(12, 2), (12, 3)]);
    }

    #[test]
    fn tags_go_in_the_head() {
        let tags = ["<a>".to_owned(), "<b>".to_owned()];
        assert_eq!(
            into_head(
                "<head>\n  <title>x</title>\n</head>\n<body>",
                Some("y"),
                &tags
            ),
            "<head>\n  <title>y</title>\n  <a>\n  <b>\n</head>\n<body>"
        );
        assert_eq!(
            into_head("<head></head>", Some("<&>"), &tags),
            "<head><title>&lt;&amp;&gt;</title><a><b></head>"
        );
        assert_eq!(into_head("<p>no head", Some("y"), &tags), "<p>no head");
    }
}
