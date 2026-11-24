//! Atom feeds of new replays (`/feed.xml` for the site, `/events/{slug}/feed.xml` for a
//! tournament) and `/oembed`, which Discord reads for the provider and author lines above a
//! link embed. All read-only, and all 404 without a public URL
//! ([`crate::config::Config::public_url`]): their links must be absolute.

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::{Path as UrlPath, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use serde_json::json;
use url::Url;

use crate::api::AppState;
use crate::events::{self, valid_slug};
use crate::matches::MatchSummary;
use crate::pages::{description, dropped, page_title, stats_title, venue, without_hidden};
use crate::store::{valid_id, Status};
use crate::structured::iso_8601;

/// The most entries a feed lists.
const ENTRIES: usize = 50;

/// What the feeds and oEmbed answers are kept for by caches.
const CACHE: &str = "public, max-age=600";

/// The name oEmbed gives the site.
const PROVIDER: &str = "skunk.club";

/// `/oembed`, `/feed.xml` and `/events/{slug}/feed.xml`.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/oembed", get(oembed))
        .route("/feed.xml", get(site_feed))
        .route("/events/{slug}/feed.xml", get(event_feed))
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// `s` as XML text or an attribute value.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // Bidi overrides and controls, as the pages drop them, and the XML non-characters;
            // the whitespace controls stay.
            c if (dropped(c) && !matches!(c, '\t' | '\n' | '\r')) || is_nonchar(c) => {}
            c => out.push(c),
        }
    }
    out
}

/// U+FFFE and U+FFFF, which XML cannot carry.
fn is_nonchar(c: char) -> bool {
    matches!(c, '\u{fffe}' | '\u{ffff}')
}

/// `s` as oEmbed text: without what the pages drop and the XML non-characters, trimmed.
fn clean(s: &str) -> String {
    s.chars()
        .filter(|&c| !dropped(c) && !is_nonchar(c))
        .collect::<String>()
        .trim()
        .to_owned()
}

/// One feed entry: a match, as the feed lists it.
struct Entry {
    id: String,
    title: String,
    summary: String,
    at: u64,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The Atom document of `entries` (newest first), named by `title` and `url`, about the page
/// `alternate`.
fn atom(title: &str, url: &str, alternate: &str, entries: &[Entry], base: &Url) -> String {
    let updated = entries.first().map_or_else(now, |e| e.at);
    let mut out = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<feed xmlns=\"http://www.w3.org/2005/Atom\">\n",
    );
    out.push_str(&format!(
        "<title>{}</title>\n<id>{}</id>\n<link rel=\"self\" href=\"{}\"/>\n<link rel=\"alternate\" href=\"{}\"/>\n<updated>{}</updated>\n<author><name>skunk.club</name></author>\n",
        xml_escape(title),
        xml_escape(url),
        xml_escape(url),
        xml_escape(alternate),
        iso_8601(updated),
    ));
    for e in entries {
        let href = base
            .join(&format!("d/{}", e.id))
            .map_or_else(|_| String::new(), String::from);
        out.push_str(&format!(
            "<entry>\n<title>{}</title>\n<link href=\"{}\"/>\n<id>{}</id>\n<updated>{}</updated>\n<summary>{}</summary>\n</entry>\n",
            xml_escape(&e.title),
            xml_escape(&href),
            xml_escape(&href),
            iso_8601(e.at),
            xml_escape(&e.summary),
        ));
    }
    out.push_str("</feed>\n");
    out
}

fn atom_response(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/atom+xml; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE),
        ],
        body,
    )
        .into_response()
}

fn entry(s: &AppState, m: Arc<MatchSummary>, id: String) -> Entry {
    let m = without_hidden(m, &s.hidden).0;
    Entry {
        id,
        title: page_title(&m),
        summary: description(&m),
        at: m.played_unix.unwrap_or(m.created_unix),
    }
}

/// `GET /feed.xml`: the 50 newest done matches.
async fn site_feed(State(s): State<AppState>) -> Response {
    let Some(base) = s.cfg.public_url.clone() else {
        return not_found();
    };
    let mut all = events::done_matches(&s);
    all.sort_by(|(a, ai), (b, bi)| {
        let at = |m: &MatchSummary| m.played_unix.unwrap_or(m.created_unix);
        at(b).cmp(&at(a)).then_with(|| ai.cmp(bi))
    });
    let entries: Vec<Entry> = all
        .into_iter()
        .take(ENTRIES)
        .map(|(m, id)| entry(&s, m, id))
        .collect();
    let url = base
        .join("feed.xml")
        .map_or_else(|_| String::new(), String::from);
    atom_response(atom(
        "skunk.club: new CS2 replays",
        &url,
        base.as_str(),
        &entries,
        &base,
    ))
}

/// `GET /events/{slug}/feed.xml`: the 50 newest done matches of the tournament; a 404 for a
/// slug that is not one or that no match names.
async fn event_feed(State(s): State<AppState>, UrlPath(slug): UrlPath<String>) -> Response {
    let Some(base) = s.cfg.public_url.clone() else {
        return not_found();
    };
    let Some(event) = valid_slug(&slug)
        .then(|| events::list_events(&s).into_iter().find(|e| e.slug == slug))
        .flatten()
    else {
        return not_found();
    };
    let entries: Vec<Entry> = events::event_matches(&s, &slug)
        .into_iter()
        .take(ENTRIES)
        .filter_map(|em| {
            let sha = s.store.get(&em.demo_id)?.sha256?;
            Some(entry(&s, s.store.matches().get(&sha)?, em.demo_id))
        })
        .collect();
    let path = format!("events/{slug}");
    let url = base
        .join(&format!("{path}/feed.xml"))
        .map_or_else(|_| String::new(), String::from);
    let page = base
        .join(&path)
        .map_or_else(|_| String::new(), String::from);
    atom_response(atom(
        &format!("{}: CS2 demos on skunk.club", event.name),
        &url,
        &page,
        &entries,
        &base,
    ))
}

/// What `/oembed` is asked.
#[derive(Debug, Deserialize)]
pub struct OembedQuery {
    /// The page to describe.
    pub url: String,
    /// `json` (or absent): the only format served.
    pub format: Option<String>,
}

/// `GET /oembed?url=…`: the link-type oEmbed answer for a match, tournament or profile page of
/// this site.
async fn oembed(State(s): State<AppState>, Query(q): Query<OembedQuery>) -> Response {
    if q.format.as_deref().is_some_and(|f| f != "json") {
        return StatusCode::NOT_IMPLEMENTED.into_response();
    }
    let Some(base) = s.cfg.public_url.clone() else {
        return not_found();
    };
    let Some(path) = own_path(&base, &q.url) else {
        return not_found();
    };
    let Some((title, author)) = describe(&s, &path) else {
        return not_found();
    };
    let (title, author) = (clean(&title), author.map(|a| clean(&a)));
    if title.is_empty() {
        return not_found();
    }
    let mut body = json!({
        "version": "1.0",
        "type": "link",
        "provider_name": PROVIDER,
        "provider_url": base.as_str(),
        "title": title,
    });
    if let Some(author) = author.filter(|a| !a.is_empty()) {
        body["author_name"] = author.into();
    }
    (
        [
            (header::CONTENT_TYPE, "application/json; charset=utf-8"),
            (header::CACHE_CONTROL, CACHE),
        ],
        body.to_string(),
    )
        .into_response()
}

/// The path of `url` under `base` with no slashes around it, when `url` is on the same scheme,
/// host and port.
fn own_path(base: &Url, url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    if url.scheme() != base.scheme()
        || url.host_str() != base.host_str()
        || url.port_or_known_default() != base.port_or_known_default()
    {
        return None;
    }
    let rest = url.path().strip_prefix(base.path())?;
    Some(rest.trim_matches('/').to_owned())
}

/// The title and author of the page at `path` (under the site), when there is one to describe.
fn describe(s: &AppState, path: &str) -> Option<(String, Option<String>)> {
    let (kind, key) = path.split_once('/')?;
    match kind {
        "d" if valid_id(key) => {
            let r = s.store.get(key).filter(|r| r.status == Status::Done)?;
            let m = s.store.matches().get(r.sha256.as_deref()?)?;
            let author = m
                .event
                .as_deref()
                .filter(|e| valid_slug(e))
                .map(|_| venue(&m));
            Some((page_title(&m), author))
        }
        "events" if valid_slug(key) => {
            let e = events::list_events(s).into_iter().find(|e| e.slug == key)?;
            Some((format!("{} CS2 demos", e.name), Some(e.name)))
        }
        "profiles" if key.len() == 17 && key.bytes().all(|b| b.is_ascii_digit()) => {
            let id: u64 = key.parse().ok()?;
            if s.hidden.is_hidden(id) {
                return None;
            }
            let players = s.store.matches().players();
            let held = players.matches_of(id).iter().any(|sha| {
                s.store
                    .find_by_sha(sha)
                    .is_some_and(|r| r.status == Status::Done)
            });
            // A name that filters to nothing leaves no profile to describe: a 404.
            let name = players
                .name_of(id)
                .filter(|n| held && !clean(n).is_empty())?;
            Some((stats_title(&name), Some(name)))
        }
        _ => None,
    }
}
