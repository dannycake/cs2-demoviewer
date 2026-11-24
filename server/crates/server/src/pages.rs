//! Match pages for crawlers. `GET /d/{id}` is the web app's `index.html` with the match's title
//! and, when previews are on (`Config::site`), OpenGraph tags in its head, so a link pasted in
//! Discord previews as the match; `GET /og/{id}.jpg` is that preview's image
//! ([`crate::preview`]), drawn once per pack, one at a time, and kept as `og/<sha>.jpg`.
//! `/og/{id}.png`, the address before the card was a JPEG, answers the same image, for pages
//! Discord read then.
//!
//! What search engines may index (spec §13.2): a done match's page and the profile of a player
//! with a done match the server holds, each with a `<link rel="canonical">` under the public URL
//! (a match's names the id profiles link to, the first done one of its pack, so copies share one
//! address; a profile's names `/profiles/<steamid>`, `/id/<name>` too). Everything else is
//! `noindex`, so crawlers do not index a page with nothing in it: a match not done yet, a profile
//! the server knows nothing of (the app asks Steam) or only Steam's facts of (a thin page:
//! titled and previewed as the player, with no canonical link, JSON-LD or body), and `/track`, a
//! sign-in flow. `/`, `/legal`, `/events` and each tournament's page are indexable.
//!
//! The status codes say what the page is, as a crawler reads them: an unknown or malformed id,
//! a failed demo and a profile no account can have are 404, a hidden player's profile is 410,
//! the rest 200. The app's own page is the body of all of them, so it draws its "not found" view.
//! A done match has a summary in its pack; one without (parsed before summaries existed) gets the
//! plain page, `noindex`, as an unfinished one does. A hidden player ([`crate::hidden`]) is named
//! "—" in a match's description and on its card, which is kept apart from the card that named
//! them (inside the replay names stay).
//!
//! Profile pages (`/id/<name>`, `/profiles/<steamid>`, anything under them, as Steam's own
//! addresses are) are the app's page, previewing as the player when the server holds their
//! matches or Steam's profile: the name, the stat line and their card,
//! `GET /og/profile-<steamid>.jpg` ([`preview::render_profile`]), drawn once for what it shows
//! and kept as `og/profile-<steamid>-<key>.jpg` (without a public URL, the avatar). The card's
//! avatar is the image kept with their profile ([`crate::profiles::ProfileCache::avatar_path`]),
//! fetched with it, never for the card. Only
//! what is kept is read (a custom URL name the server has resolved, a kept profile, never
//! refreshed): a crawler never makes the server ask Steam. A hidden player's page previews as
//! nobody, and has no card. A page with no player to show is titled for what the server knows
//! ([`Shown`]): "Player not found", "Hidden profile", or "Player profile" when it cannot know.
//!
//! The site's own pages (`/`, `/track`, `/legal`) preview as the site: their title, what they
//! are for, and the homepage's still (`site/home/poster.jpg`, when the assets have it).
//!
//! What a page shows reaches a crawler as plain HTML ([`prerender`]) in `<div id="pre">` after
//! the app's root ([`into_pre`]): the home page's links, a profile, a match's scoreboard, the
//! tournaments and each one's matches. The app's view removes it once it has its own content.
//!
//! Every preview's edge in Discord (`theme-color`) is the site's crimson.

use std::fs;
use std::io::{self, ErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::rejection::PathRejection;
use axum::extract::{Path as UrlPath, State};
use axum::http::{header, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use sha2::{Digest, Sha256};
use url::Url;

use crate::api::AppState;
use crate::config::Config;
use crate::events::{self, EventSummary};
use crate::hidden::Hidden;
use crate::identity::{classify, Input};
use crate::matches::{MatchSummary, SummaryPlayer, MAX_NAME_CHARS};
use crate::players_api::{faceit_history, player_matches};
use crate::prerender;
use crate::preview;
use crate::profile::{build_profile, ProfileView};
use crate::store::{self, valid_id, Status, Store};
use crate::structured;

/// The site's name, as page titles and previews show it.
pub const SITE_NAME: &str = "skunk.club";
/// The home page's title (before ` · skunk.club`) and the description every search engine and
/// preview reads (`web/index.html` and `web/public/site.webmanifest` say the same).
pub const HOME_TITLE: &str = "CS2 demo viewer in your browser";
pub const HOME_DESCRIPTION: &str = "Watch any CS2 demo in 3D, right in your browser, no install. Pro tournament replays, your own matches and your friends' stats.";
pub(crate) const NOINDEX: &str = r#"<meta name="robots" content="noindex">"#;
/// On every page that can be indexed: search results may show its card at full size.
const LARGE_PREVIEWS: &str = r#"<meta name="googlebot" content="max-image-preview:large">"#;
/// What a hidden player is called on a match's page and card.
pub(crate) const HIDDEN_NAME: &str = "—";
/// The site's crimson (`web/src/site/tokens.css`): the edge of its previews in Discord.
const SITE_COLOUR: &str = "#e4163a";
/// The homepage's still, under the assets: the site pages' preview image.
const SITE_IMAGE: &str = "site/home/poster.jpg";
const POSTER_ALT: &str = "skunk.club: a CS2 match in the browser's 3D viewer";

/// `/d/{id}` and `/og/{file}` (anything deeper under `/og/` is a 404, not the app), before the
/// web app's fallback.
pub fn routes() -> Router<AppState> {
    let og = Router::new()
        .route("/{file}", get(preview_image))
        .fallback(|| async { not_found() });
    Router::new()
        .route("/", get(home_page))
        .route("/index.html", get(redirect_home))
        .route("/robots.txt", get(robots))
        .route("/track", get(track_page))
        .route("/track/", get(redirect_slashless))
        .route("/legal", get(contact_page))
        .route("/legal/", get(redirect_slashless))
        .route("/d/{id}", get(match_page))
        .route("/d/{id}/", get(redirect_slashless))
        .merge(crate::guides::routes())
        .route("/events", get(events_page))
        .route("/events/", get(redirect_slashless))
        .route("/events/{slug}", get(event_page))
        .route("/events/{slug}/", get(redirect_slashless))
        .route("/id/{name}", get(profile_page))
        .route("/id/{name}/", get(profile_page))
        .route("/id/{name}/{*rest}", get(profile_page))
        .route("/profiles/{id}", get(profile_page))
        .route("/profiles/{id}/", get(profile_page))
        .route("/profiles/{id}/{*rest}", get(profile_page))
        .nest("/og", og)
}

/// `/index.html`: the home page has one address. The file is what the server sends for it, so
/// the name would otherwise answer as a second copy of the page.
async fn redirect_home() -> Response {
    (
        StatusCode::MOVED_PERMANENTLY,
        [
            (header::LOCATION, "/"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
    )
        .into_response()
}

/// `/robots.txt`: every page and preview image (`/og/`, which `og:image` and the JSON-LD name)
/// is open to crawlers; the API and sign-in are not, so a crawler never costs a Steam call. The
/// sitemap is named when the site knows its own address (`public_url`).
async fn robots(State(s): State<AppState>) -> Response {
    let mut body = String::from("User-agent: *\nDisallow: /api/\nDisallow: /auth/\n");
    if let Some(sitemap) = s
        .cfg
        .public_url
        .as_ref()
        .and_then(|b| b.join("sitemap.xml").ok())
    {
        body.push_str(&format!("Sitemap: {sitemap}\n"));
    }
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        body,
    )
        .into_response()
}

/// A page address with a trailing `/`: a permanent redirect to the one without, query kept, so
/// each page has one address.
pub async fn redirect_slashless(uri: Uri) -> Response {
    let path = uri.path().trim_end_matches('/');
    let to = match uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path.to_owned(),
    };
    (
        StatusCode::MOVED_PERMANENTLY,
        [
            (header::LOCATION, to),
            (header::CACHE_CONTROL, "public, max-age=86400".to_owned()),
        ],
    )
        .into_response()
}

/// A path that is no file and no page: the app's page (it draws its "not found" view), `noindex`,
/// answering 404.
pub async fn not_found_page(State(s): State<AppState>) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let mut tags = vec![NOINDEX.to_owned()];
    tags.extend(site_scripts(&s.cfg));
    html(
        StatusCode::NOT_FOUND,
        into_head(
            &template,
            Some(&format!("Not found · {SITE_NAME}")),
            Some("This page does not exist."),
            &tags,
        ),
    )
}

fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// The summary of the match demo `id` shows, when `id` is a done demo whose pack has one (as
/// `demos.json` has it, [`Store::get_saved`]): what a preview image is drawn for.
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

/// `<link rel="canonical">` naming `path` under the public URL: the one address search engines
/// should index the page under. `None` without a public URL (links must be absolute).
pub fn canonical(public_url: Option<&Url>, path: &str) -> Option<String> {
    let url = public_url?.join(path).ok()?;
    Some(format!(
        r#"<link rel="canonical" href="{}">"#,
        escape(url.as_str())
    ))
}

/// `<link rel="alternate">` to the Atom feed at `path` under the public URL, titled `title`.
pub(crate) fn feed_link(public_url: Option<&Url>, title: &str, path: &str) -> Option<String> {
    let url = public_url?.join(path).ok()?;
    Some(format!(
        r#"<link rel="alternate" type="application/atom+xml" title="{}" href="{}">"#,
        escape(title),
        escape(url.as_str())
    ))
}

/// `<link rel="alternate">` to the oEmbed description of the page at `path` under the public
/// URL (what Discord reads for the provider and author lines of a link embed).
pub(crate) fn oembed_link(public_url: Option<&Url>, path: &str) -> Option<String> {
    let base = public_url?;
    let page = base.join(path).ok()?;
    let url = base
        .join(&format!(
            "oembed?url={}",
            structured::percent_encode(page.as_str())
        ))
        .ok()?;
    Some(format!(
        r#"<link rel="alternate" type="application/json+oembed" href="{}">"#,
        escape(url.as_str())
    ))
}

/// `summary` with each hidden player named "—", and, when any was, a tag naming which (the
/// first 8 bytes of the SHA-256 of their sorted steamids, hex): the key of its card.
pub(crate) fn without_hidden(
    summary: Arc<MatchSummary>,
    hidden: &Hidden,
) -> (Arc<MatchSummary>, Option<String>) {
    let hides = |p: &SummaryPlayer| p.steamid.parse().is_ok_and(|id| hidden.is_hidden(id));
    let mut ids: Vec<&str> = summary
        .players
        .iter()
        .filter(|p| hides(p))
        .map(|p| p.steamid.as_str())
        .collect();
    if ids.is_empty() {
        return (summary, None);
    }
    ids.sort_unstable();
    let tag = store::hex(&Sha256::digest(ids.join(",").as_bytes())[..8]);
    let mut m = (*summary).clone();
    for p in m.players.iter_mut().filter(|p| hides(p)) {
        p.name = HIDDEN_NAME.to_owned();
    }
    (Arc::new(m), Some(tag))
}

/// The web app's `index.html`, or what to answer when it cannot be read (logged). It is read
/// on every request, as the web app's fallback reads it: a web build while the server runs
/// changes the bundles it names.
pub(crate) async fn app_page(cfg: &Config) -> Result<String, Unreadable> {
    match tokio::fs::read_to_string(cfg.web_dir.join("index.html")).await {
        Ok(t) => Ok(t),
        Err(e) if e.kind() == ErrorKind::NotFound => Err(Unreadable::Missing),
        Err(e) => {
            tracing::error!(error = %e, "reading index.html");
            Err(Unreadable::Failed)
        }
    }
}

/// Why `index.html` could not be read.
pub(crate) enum Unreadable {
    Missing,
    Failed,
}

impl IntoResponse for Unreadable {
    fn into_response(self) -> Response {
        match self {
            Unreadable::Missing => not_found(),
            Unreadable::Failed => {
                (StatusCode::INTERNAL_SERVER_ERROR, "cannot read the page").into_response()
            }
        }
    }
}

/// An HTML page answering `status`: the app's own page is sent on 404 and 410 too, so it can
/// draw its "not found" view.
pub(crate) fn html(status: StatusCode, page: String) -> Response {
    (
        status,
        [
            (header::CONTENT_TYPE, "text/html; charset=utf-8"),
            // Like the app's own page (`crate::app::PAGE_CACHE`): revalidated, so a deploy's
            // bundles and a match's tags reach a returning visitor at once, and sent on as it is.
            (header::CACHE_CONTROL, crate::app::PAGE_CACHE),
        ],
        page,
    )
        .into_response()
}

/// What a profile page shows: a player, or why none, as far as the server knows without asking
/// Steam.
enum Shown {
    Player(Box<ProfileView>),
    Hidden,
    /// No account can have the address, or Steam has said none has the custom URL name.
    Missing,
    /// A name not resolved yet, or a player the server knows nothing of: the app asks.
    Unknown,
}

/// A profile page: the app's, previewing as the player when the server holds them, indexable
/// when it holds a match of theirs; titled with their name, or with why there is none
/// ([`Shown`]).
async fn profile_page(State(s): State<AppState>, uri: axum::http::Uri) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    // Without a player, the app's own description stands.
    let without = |what: &str, status: StatusCode| {
        let title = format!("{what} · {SITE_NAME}");
        let mut tags = vec![NOINDEX.to_owned()];
        tags.extend(site_scripts(&s.cfg));
        html(status, into_head(&template, Some(&title), None, &tags))
    };
    let view = match profile_view(&s, uri.path()).await {
        Shown::Player(view) => view,
        Shown::Hidden => return without("Hidden profile", StatusCode::GONE),
        Shown::Missing => return without("Player not found", StatusCode::NOT_FOUND),
        Shown::Unknown => return without("Player profile", StatusCode::OK),
    };
    let Some(name) = view.name.clone() else {
        return without("Player profile", StatusCode::OK);
    };
    // Indexable, under the one address however it was reached (`/id/<name>` too), when the
    // server holds a match of theirs: Steam's facts alone are a thin page, `noindex`, with no
    // canonical link, no JSON-LD and no body (still titled and previewed as the player).
    let thin = view.matches.is_empty();
    let mut tags: Vec<String> = if thin {
        vec![NOINDEX.to_owned()]
    } else {
        canonical(
            s.cfg.public_url.as_ref(),
            &format!("profiles/{}", view.steamid),
        )
        .into_iter()
        .collect()
    };
    tags.extend(site_scripts(&s.cfg));
    if !thin {
        tags.extend(oembed_link(
            s.cfg.public_url.as_ref(),
            &format!("profiles/{}", view.steamid),
        ));
    }
    let data: Vec<String> = s
        .cfg
        .public_url
        .as_ref()
        .filter(|_| !thin)
        .into_iter()
        .flat_map(|base| {
            [
                structured::json_ld_tag(&structured::profile(base, &view, &name)),
                structured::json_ld_tag(&structured::breadcrumbs(
                    base,
                    &[("Home", ""), (&name, &format!("profiles/{}", view.steamid))],
                )),
            ]
        })
        .collect();
    let title = format!("{} and demos · {SITE_NAME}", stats_title(&name));
    let description = profile_description(&view, &name);
    if s.cfg.site.previews {
        let avatar_kept = match avatar_file(&s, &view) {
            Some(path) => tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()),
            None => false,
        };
        tags.extend(profile_tags(
            &view,
            &name,
            avatar_kept,
            s.cfg.public_url.as_ref(),
        ));
    }
    tags.extend(data);
    let page = into_head(&template, Some(&title), Some(&description), &tags);
    html(
        StatusCode::OK,
        if thin {
            page
        } else {
            into_pre(page, &prerender::profile_html(&view, &name))
        },
    )
}

/// `page` with `body` in `<div id="pre">` just after the app's empty root element, for what
/// reads the page without running it, Google's renderer among them. The app mounts in the root,
/// so the body survives it, and draws its frame (the bar, a loading bar, one line when the live
/// page failed) over it. A view removes it once it has its own content (`web/src/site/pre.ts`),
/// never while loading or on an error, so a renderer that cannot reach the API (`/robots.txt`
/// keeps it out) still reads it. A page without the root element is returned as it is.
pub fn into_pre(page: String, body: &str) -> String {
    const ROOT: &str = r#"<div id="root"></div>"#;
    match page.find(ROOT) {
        Some(at) => {
            let end = at + ROOT.len();
            format!(
                r#"{}<div id="pre">{body}</div>{}"#,
                &page[..end],
                &page[end..]
            )
        }
        None => page,
    }
}

/// What the profile path shows, from what the server keeps (see the module), a tracked player's
/// FACEIT history with it for the page's copy.
async fn profile_view(s: &AppState, path: &str) -> Shown {
    let mut parts = path.trim_start_matches('/').split('/');
    let (kind, key) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let steamid = match kind {
        "profiles" => steamid(key),
        // As the app looks it up: a custom URL name of a shape Steam allows, else no one.
        "id" => match classify(&format!("skunk.club/id/{key}")) {
            Input::Vanity { name, .. } if s.profiles.vanity_missing(&name) => {
                return Shown::Missing
            }
            Input::Vanity { name, .. } => match s.profiles.resolved_vanity(&name) {
                Some(id) => Some(id),
                None => return Shown::Unknown,
            },
            _ => None,
        },
        _ => None,
    };
    let Some(steamid) = steamid else {
        return Shown::Missing;
    };
    if s.hidden.is_hidden(steamid) {
        return Shown::Hidden;
    }
    match known_profile(s, steamid).await {
        Some(mut view) => {
            // For the page's copy only: the player's card has no FACEIT rows.
            view.faceit_history = faceit_history(s, steamid).await;
            Shown::Player(Box::new(view))
        }
        None => Shown::Unknown,
    }
}

/// `key` as a SteamID64 written out in its 17 digits.
fn steamid(key: &str) -> Option<u64> {
    match classify(key) {
        Input::SteamId(id) if key.len() == 17 && key.bytes().all(|b| b.is_ascii_digit()) => {
            Some(id)
        }
        _ => None,
    }
}

/// `steamid`'s profile from what the server keeps; `None` for a hidden player or one the server
/// knows nothing of.
async fn known_profile(s: &AppState, steamid: u64) -> Option<ProfileView> {
    if s.hidden.is_hidden(steamid) {
        return None;
    }
    let matches = player_matches(s, steamid);
    let steam = s.profiles.peek(steamid).await;
    if matches.is_empty() && steam.is_none() {
        return None;
    }
    Some(build_profile(
        steamid,
        &matches,
        steam.as_ref(),
        s.tracking.state(steamid),
        |other| s.hidden.is_hidden(other),
    ))
}

/// Where the image of the player's avatar is kept, when Steam names one.
fn avatar_file(s: &AppState, view: &ProfileView) -> Option<PathBuf> {
    view.avatar.as_ref()?;
    Some(s.profiles.avatar_path(view.steamid.parse().ok()?))
}

/// What a profile is called in its preview and its tab: "‹name›'s CS2 stats" ("‹name›' CS2
/// stats" after a final s), so a link pasted in Discord reads as Counter-Strike at a glance.
pub fn stats_title(name: &str) -> String {
    let owner = if name.ends_with(['s', 'S']) {
        "'"
    } else {
        "'s"
    };
    format!("{name}{owner} CS2 stats")
}

/// A player's preview: their name, the stat line, their card (with their avatar when its image
/// is kept, `avatar_kept`; without a public URL, the avatar as a thumbnail), the site's colour.
fn profile_tags(
    view: &ProfileView,
    name: &str,
    avatar_kept: bool,
    public_url: Option<&Url>,
) -> Vec<String> {
    let mut tags = vec![
        property("og:site_name", SITE_NAME),
        property("og:type", "profile"),
        property("og:title", &stats_title(name)),
        property("og:description", &stat_line(view)),
    ];
    let id = &view.steamid;
    if let Some(url) = public_url.and_then(|b| b.join(&format!("profiles/{id}")).ok()) {
        tags.push(property("og:url", url.as_str()));
    }
    // The card's key in its link: Discord keeps an image by its address, and this one is new
    // when what the card shows is.
    let key = card_key(&preview::ProfileCard::of(view, name, avatar_kept));
    let card = public_url.and_then(|b| b.join(&format!("og/profile-{id}.jpg?v={key}")).ok());
    let large = match (card, &view.avatar) {
        (Some(card), _) => {
            tags.extend([
                property("og:image", card.as_str()),
                property("og:image:type", "image/jpeg"),
                property("og:image:width", &preview::WIDTH.to_string()),
                property("og:image:height", &preview::HEIGHT.to_string()),
                property(
                    "og:image:alt",
                    &format!(
                        "{}: rating, opening duels, K/D, ADR, HS% and matches",
                        stats_title(name)
                    ),
                ),
            ]);
            true
        }
        (None, Some(avatar)) => {
            tags.push(property("og:image", avatar));
            false
        }
        (None, None) => false,
    };
    let kind = if large {
        "summary_large_image"
    } else {
        "summary"
    };
    tags.push(format!(r#"<meta name="twitter:card" content="{kind}">"#));
    tags.push(theme_colour(SITE_COLOUR));
    tags
}

/// What tells one of a player's cards from another: a hash of what it shows and of how it is
/// drawn, so a new look is drawn again too.
fn card_key(card: &preview::ProfileCard) -> String {
    let shown = format!("{}{card:?}", preview::PROFILE_DESIGN);
    store::hex(&Sha256::digest(shown.as_bytes())[..8])
}

/// "Premier 18,450 · 1.28 rating · 44% opening · 1.47 K/D · 97 ADR · 58 HS% · 3 matches": the
/// profile's numbers first, in the stat strip's order and as the page writes them; what is
/// unknown is left out.
fn stat_line(view: &ProfileView) -> String {
    let t = &view.totals;
    let mut parts = Vec::new();
    if let Some(p) = view.premier.as_ref().filter(|p| p.rating > 0) {
        parts.push(format!("Premier {}", thousands(p.rating)));
    }
    if let Some(r) = t.rating {
        parts.push(format!("{} rating", fixed(as_sent(r), 2)));
    }
    if let Some(won) = opening_pct(t.opening_won, t.opening_lost) {
        parts.push(format!("{}% opening", fixed(won, 0)));
    }
    if let Some(kd) = t.kd {
        parts.push(format!("{} K/D", fixed(as_sent(kd), 2)));
    }
    if let Some(adr) = t.adr {
        parts.push(format!("{} ADR", fixed(as_sent(adr), 0)));
    }
    if let Some(hs) = t.hs_pct {
        parts.push(format!("{} HS%", fixed(as_sent(hs), 0)));
    }
    parts.push(match t.matches {
        1 => "1 match".to_owned(),
        n => format!("{n} matches"),
    });
    parts.join(" · ")
}

/// What a profile says in a search result, a sentence where the preview has a line of figures:
/// "FALLEN's CS2 stats from 79 matches: 0.85 rating, 0.79 K/D, 60 ADR and 53% headshots. Watch
/// every match as a 3D replay in your browser."
fn profile_description(view: &ProfileView, name: &str) -> String {
    let t = &view.totals;
    let mut figures = Vec::new();
    if let Some(p) = view.premier.as_ref().filter(|p| p.rating > 0) {
        figures.push(format!("Premier {}", thousands(p.rating)));
    }
    if let Some(r) = t.rating {
        figures.push(format!("{} rating", fixed(as_sent(r), 2)));
    }
    if let Some(kd) = t.kd {
        figures.push(format!("{} K/D", fixed(as_sent(kd), 2)));
    }
    if let Some(adr) = t.adr {
        figures.push(format!("{} ADR", fixed(as_sent(adr), 0)));
    }
    if let Some(hs) = t.hs_pct {
        figures.push(format!("{}% headshots", fixed(as_sent(hs), 0)));
    }
    let listed = match figures.split_last() {
        Some((last, [])) => format!(": {last}"),
        Some((last, rest)) => format!(": {} and {last}", rest.join(", ")),
        None => String::new(),
    };
    format!(
        "{} from {}{listed}. Watch every match as a 3D replay in your browser.",
        stats_title(name),
        matches_count(t.matches)
    )
}

/// The share of opening duels won, ×100, as the stat strip works it out; none without a duel.
pub fn opening_pct(won: u32, lost: u32) -> Option<f64> {
    let duels = won + lost;
    (duels > 0).then(|| 100.0 * f64::from(won) / f64::from(duels))
}

/// `x` to `places` decimals as the web app writes a figure (`toFixed`, `Math.round`): to the
/// nearest, a half away from zero (Rust's own `{:.2}` takes a half to the even digit, so 102.5
/// ADR would be "102" here and "103" on the page). A half is a value `2^(places+1)` times which
/// is an odd whole number: only those lie exactly halfway.
pub fn fixed(x: f64, places: usize) -> String {
    let p = i32::try_from(places).unwrap_or(i32::MAX);
    let halves = x * 2f64.powi(p.saturating_add(1));
    if halves.fract() == 0.0 && halves.rem_euclid(2.0) == 1.0 {
        let n = (x * 10f64.powi(p)).round();
        return format!("{:.places$}", n / 10f64.powi(p));
    }
    format!("{x:.places$}")
}

/// A figure the API sends as an `f32`, as the page reads it: its shortest decimal (what JSON
/// carries), read as a double.
pub fn as_sent(x: f32) -> f64 {
    x.to_string().parse().unwrap_or(f64::from(x))
}

/// `n` with a comma between thousands: 18,450.
pub fn thousands(n: u32) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// One of the site's own pages: the app's, previewing as the site, with `body` (when given) for
/// crawlers after the app's root ([`into_pre`]).
///
/// `noindex` pages (the sign-in flow) say so; every one names itself as its canonical address.
async fn site_page(
    s: &AppState,
    path: &str,
    page: Option<(&str, &str)>,
    noindex: bool,
    body: Option<&str>,
) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let (og_title, description) = page.unwrap_or((HOME_TITLE, HOME_DESCRIPTION));
    let title = format!("{og_title} · {SITE_NAME}");
    let mut tags = site_tags(s, path, og_title, description, noindex);
    // Only the home page declares the site and its search.
    if path.is_empty() {
        if let Some(base) = &s.cfg.public_url {
            tags.push(structured::json_ld_tag(&structured::website(base)));
            tags.push(structured::json_ld_tag(&structured::organization(base)));
            tags.push(structured::json_ld_tag(&structured::web_app(base)));
        }
    }
    if path.is_empty() {
        tags.extend(feed_link(
            s.cfg.public_url.as_ref(),
            "New replays",
            "feed.xml",
        ));
    }
    let head = into_head(&template, Some(&title), Some(description), &tags);
    html(
        StatusCode::OK,
        match body {
            Some(body) => into_pre(head, body),
            None => head,
        },
    )
}

/// The tags a site page ends its head with: `noindex` when asked, its canonical address, with
/// previews on the Open Graph and Twitter tags (`og_title`, `description`, the site's image
/// when the public URL and the file are there), and the config's analytics and verification
/// tags.
pub(crate) fn site_tags(
    s: &AppState,
    path: &str,
    og_title: &str,
    description: &str,
    noindex: bool,
) -> Vec<String> {
    let mut tags: Vec<String> = noindex.then(|| NOINDEX.to_owned()).into_iter().collect();
    tags.extend(canonical(s.cfg.public_url.as_ref(), path));
    if !s.cfg.site.previews {
        tags.extend(site_scripts(&s.cfg));
        return tags;
    }
    tags.extend([
        property("og:site_name", SITE_NAME),
        property("og:type", "website"),
        property("og:title", og_title),
        property("og:description", description),
        property("og:locale", "en_US"),
    ]);
    let base = s.cfg.public_url.as_ref();
    if let Some(url) = base.and_then(|b| b.join(path).ok()) {
        tags.push(property("og:url", url.as_str()));
    }
    let image = base
        .filter(|_| s.cfg.assets_dir.join(SITE_IMAGE).is_file())
        .and_then(|b| b.join(SITE_IMAGE).ok());
    let card = match &image {
        Some(image) => {
            tags.push(property("og:image", image.as_str()));
            tags.push(property("og:image:width", "1920"));
            tags.push(property("og:image:height", "1080"));
            tags.push(property("og:image:alt", POSTER_ALT));
            "summary_large_image"
        }
        None => "summary",
    };
    tags.push(format!(r#"<meta name="twitter:card" content="{card}">"#));
    tags.push(theme_colour(SITE_COLOUR));
    tags.extend(site_scripts(&s.cfg));
    tags
}

/// `/events`: the tournaments the site holds, each linking to its page.
async fn events_page(State(s): State<AppState>) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let listed = events::list_events(&s);
    let held: u32 = listed.iter().map(|e| e.matches).sum();
    let tournaments = match listed.len() {
        1 => "1 tournament".to_owned(),
        n => format!("{n} tournaments"),
    };
    let description = format!(
        "Watch pro CS2 tournament demos in 3D in your browser: {} from {tournaments}, each with \
         every player's stats.",
        matches_count(held)
    );
    let description = description.as_str();
    let title = format!("CS2 tournament demos · {SITE_NAME}");
    let mut tags = site_tags(&s, "events", "CS2 tournament demos", description, false);
    tags.extend(feed_link(
        s.cfg.public_url.as_ref(),
        "New replays",
        "feed.xml",
    ));
    let body = prerender::events_html(&events::list_events(&s));
    html(
        StatusCode::OK,
        into_pre(
            into_head(&template, Some(&title), Some(description), &tags),
            &body,
        ),
    )
}

/// `/events/{slug}`: a tournament's matches, newest first. A slug that is not one, or that no
/// match holds, is a 404 and `noindex` with the app's plain page (never naming the slug).
async fn event_page(
    State(s): State<AppState>,
    slug: Result<UrlPath<String>, PathRejection>,
) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let slug = slug.map(|UrlPath(slug)| slug).unwrap_or_default();
    let event = events::valid_slug(&slug)
        .then(|| events::list_events(&s).into_iter().find(|e| e.slug == slug))
        .flatten();
    let Some(event) = event else {
        let title = format!("Tournament not found · {SITE_NAME}");
        let mut tags = vec![NOINDEX.to_owned()];
        tags.extend(site_scripts(&s.cfg));
        return html(
            StatusCode::NOT_FOUND,
            into_head(&template, Some(&title), None, &tags),
        );
    };
    let days = event_days(&event, " to ").map_or_else(String::new, |days| format!(", {days}"));
    let description = format!(
        "Watch {} demos in 3D in your browser: {}{days}, with every player's stats.",
        event.name,
        matches_count(event.matches)
    );
    let title = format!("{} CS2 demos · {SITE_NAME}", event.name);
    let path = format!("events/{slug}");
    let mut tags = site_tags(&s, &path, &event.name, &description, false);
    tags.extend(feed_link(
        s.cfg.public_url.as_ref(),
        &format!("{}: new replays", event.name),
        &format!("{path}/feed.xml"),
    ));
    tags.extend(oembed_link(s.cfg.public_url.as_ref(), &path));
    if let Some(base) = s.cfg.public_url.as_ref() {
        tags.push(structured::json_ld_tag(&structured::event(base, &event)));
        tags.push(structured::json_ld_tag(&structured::breadcrumbs(
            base,
            &[
                ("Home", ""),
                ("Tournaments", "events"),
                (&event.name, &path),
            ],
        )));
    }
    let body = prerender::event_html(&event, &events::event_matches(&s, &slug));
    html(
        StatusCode::OK,
        into_pre(
            into_head(&template, Some(&title), Some(&description), &tags),
            &body,
        ),
    )
}

/// "1 match" or "{n} matches".
pub(crate) fn matches_count(n: u32) -> String {
    if n == 1 {
        "1 match".to_owned()
    } else {
        format!("{n} matches")
    }
}

/// `/`: the site's page, with the home page's links in the body ([`prerender::home_html`]).
async fn home_page(State(s): State<AppState>) -> Response {
    let body = prerender::home_html(&events::home_links(&s));
    site_page(&s, "", None, false, Some(&body)).await
}

/// `/track`: the sign-in flow's page, `noindex`.
async fn track_page(State(s): State<AppState>) -> Response {
    site_page(
        &s,
        "track",
        Some((
            "Track your matches",
            "Sign in through Steam and every CS2 match you finish is stored here with its 3D \
             replay, on your profile.",
        )),
        true,
        None,
    )
    .await
}

/// `/legal`: the contact page.
async fn contact_page(State(s): State<AppState>) -> Response {
    site_page(
        &s,
        "legal",
        Some((
            "Contact",
            "Legal requests, privacy, data and takedowns for skunk.club: contact@skunk.legal.",
        )),
        false,
        None,
    )
    .await
}

/// `<meta property="key" content="value">`, the value escaped.
fn property(key: &str, value: &str) -> String {
    format!(r#"<meta property="{key}" content="{}">"#, escape(value))
}

/// The colour of a preview's edge in Discord.
fn theme_colour(colour: &str) -> String {
    format!(r#"<meta name="theme-color" content="{colour}">"#)
}

/// A match page. By the demo's state: a done match with a summary is indexable (200, with its
/// canonical link); one still on its way is 200 and `noindex` with the app's plain page, which
/// shows its progress; a failed demo, an unknown or malformed id is 404 and `noindex`, the
/// app's page still sent so it can say so.
async fn match_page(
    State(s): State<AppState>,
    id: Result<UrlPath<String>, PathRejection>,
) -> Response {
    let template = match app_page(&s.cfg).await {
        Ok(t) => t,
        Err(why) => return why.into_response(),
    };
    let id = id.map(|UrlPath(id)| id).unwrap_or_default();
    let record = if valid_id(&id) {
        s.store.get_saved(&id).await
    } else {
        None
    };
    let (status, done) = match &record {
        None => (StatusCode::NOT_FOUND, None),
        Some(r) if r.status == Status::Error => (StatusCode::NOT_FOUND, None),
        Some(r) if r.status == Status::Done => {
            let summary = r
                .sha256
                .as_deref()
                .and_then(|sha| s.store.matches().get(sha).map(|m| (sha, m)));
            (StatusCode::OK, summary)
        }
        Some(_) => (StatusCode::OK, None),
    };
    let Some((sha, summary)) = done else {
        return html(status, page(&template, &id, None, &[], None, &s.cfg));
    };
    // The id profiles link to: the first done one of the pack, so copies share one address.
    let canonical_id = s
        .store
        .find_by_sha(sha)
        .map_or_else(|| id.clone(), |r| r.id);
    let hidden: Vec<String> = summary
        .players
        .iter()
        .filter(|p| p.steamid.parse().is_ok_and(|id| s.hidden.is_hidden(id)))
        .map(|p| p.steamid.clone())
        .collect();
    let summary = without_hidden(summary, &s.hidden).0;
    html(
        status,
        page(
            &template,
            &id,
            Some(&summary),
            &hidden,
            Some(&canonical_id),
            &s.cfg,
        ),
    )
}

/// The page for demo `id`. For a match (`summary`, with the id its canonical link names) its
/// title and, with previews on, the preview tags, `og:url` and `og:image` only with a public URL
/// (crawlers need absolute ones); indexable; its scoreboard after the root ([`into_pre`]),
/// `hidden` (steamids) as rows without a link. Every address the page gives for itself (the
/// canonical link, `og:url`, `og:image`, the JSON-LD's) is under the canonical id, so a copy's
/// agree. Without a match, the plain app page, `noindex`.
fn page(
    template: &str,
    id: &str,
    summary: Option<&MatchSummary>,
    hidden: &[String],
    canonical_id: Option<&str>,
    cfg: &Config,
) -> String {
    let mut tags = Vec::new();
    match (summary, canonical_id) {
        (Some(_), Some(canonical_id)) => tags.extend(canonical(
            cfg.public_url.as_ref(),
            &format!("d/{canonical_id}"),
        )),
        _ => tags.push(NOINDEX.to_owned()),
    }
    let own = canonical_id.unwrap_or(id);
    if let Some(m) = summary.filter(|_| cfg.site.previews) {
        tags.extend(preview_tags(own, m, cfg.public_url.as_ref()));
    }
    tags.extend(site_scripts(cfg));
    if let Some(canonical_id) = canonical_id.filter(|_| summary.is_some()) {
        tags.extend(oembed_link(
            cfg.public_url.as_ref(),
            &format!("d/{canonical_id}"),
        ));
    }
    // A match that can be indexed declares itself.
    if let (Some(m), Some(canonical_id), Some(base)) =
        (summary, canonical_id, cfg.public_url.as_ref())
    {
        tags.push(structured::json_ld_tag(&structured::match_event(
            base,
            canonical_id,
            m,
        )));
        tags.push(structured::json_ld_tag(&structured::match_breadcrumbs(
            base,
            canonical_id,
            m,
        )));
    }
    let title = summary.map(|m| format!("{} · {SITE_NAME}", match_page_title(m)));
    let words = summary.map(description);
    let head = into_head(template, title.as_deref(), words.as_deref(), &tags);
    match summary {
        Some(m) => into_pre(head, &prerender::match_html(m, hidden)),
        None => head,
    }
}

/// A match's preview: its title, the description, and with a public URL its page and its card
/// under `id`, the size and alt text of the card; a large card, the site's colour.
fn preview_tags(id: &str, m: &MatchSummary, public_url: Option<&Url>) -> Vec<String> {
    let mut tags = vec![
        property("og:site_name", SITE_NAME),
        property("og:type", "website"),
        property("og:title", &page_title(m)),
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
    tags.push(theme_colour(SITE_COLOUR));
    tags
}

/// What the preview shows, for a reader that cannot see it.
fn image_alt(m: &MatchSummary) -> String {
    format!(
        "{}: the score, each round's winner and both teams' kills, deaths and ADR",
        page_title(m)
    )
}

/// `template` with `tags` at the end of its head, each on its own line, with `title` (when
/// given) as its `<title>` and `description` (when given) as its `<meta name="description">`,
/// each in place of the template's own. A template without `</head>` is returned as it is.
pub(crate) fn into_head(
    template: &str,
    title: Option<&str>,
    description: Option<&str>,
    tags: &[String],
) -> String {
    let Some(head_end) = template.find("</head>") else {
        return template.to_owned();
    };
    let mut head = template[..head_end].to_owned();
    let mut tags = tags.to_vec();
    let canonical = tags
        .iter()
        .any(|t| t.starts_with(r#"<link rel="canonical""#));
    if canonical && !tags.iter().any(|t| t == NOINDEX) {
        tags.push(LARGE_PREVIEWS.to_owned());
    }
    let mut own = Vec::new();
    if let Some(title) = title {
        let old = head.find("<title>").and_then(|at| {
            let len = head[at..].find("</title>")? + "</title>".len();
            Some(at..at + len)
        });
        own.push((format!("<title>{}</title>", escape(title)), old));
    }
    if let Some(description) = description {
        // However the template writes it (a long one on several lines).
        let old = head.match_indices("<meta").find_map(|(at, _)| {
            let len = head[at..].find('>')? + 1;
            let tag = &head[at..at + len];
            tag.split_whitespace()
                .any(|a| a == r#"name="description""#)
                .then_some(at..at + len)
        });
        let element = format!(
            r#"<meta name="description" content="{}">"#,
            escape(description)
        );
        own.push((element, old));
    }
    // Those the template lacks go first among the tags, in this order. The title comes before
    // the description in the head, so replacing it first leaves the description where found.
    own.sort_by_key(|(_, old)| std::cmp::Reverse(old.as_ref().map(|r| r.start)));
    let mut first = 0;
    for (element, old) in own {
        match old {
            Some(range) => head.replace_range(range, &element),
            None => {
                tags.insert(first, element);
                first += 1;
            }
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

/// The tags every HTML page ends its head with, from the config: Cloudflare Web Analytics'
/// beacon when `cf_beacon_token` is set, Google Search Console's `google-site-verification`
/// tag when `gsc_token` is.
///
/// The beacon has no `integrity` attribute: Cloudflare serves `beacon.min.js` unversioned and
/// changes it, so a pinned hash would break analytics without a word. The guard is the CSP's
/// exact origin for it ([`crate::app::CSP`]), and the script is only ever named with a token
/// set. The beacon token is letters and digits (checked at startup), so it needs no escaping
/// inside its single quotes; the verification token is escaped.
pub(crate) fn site_scripts(cfg: &Config) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(token) = &cfg.cf_beacon_token {
        tags.push(format!(
            r#"<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{{"token": "{token}"}}'></script>"#
        ));
    }
    if let Some(token) = &cfg.gsc_token {
        tags.push(format!(
            r#"<meta name="google-site-verification" content="{}">"#,
            escape(token)
        ));
    }
    tags
}

/// `s` for an HTML attribute or element: `&<>"'` escaped; control characters and the bidi
/// embedding, override and isolate controls dropped (a name cannot reverse the text after it).
pub(crate) fn escape(s: &str) -> String {
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
pub(crate) fn dropped(c: char) -> bool {
    matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}') || c.is_control()
}

/// "Mirage 13–9": the map as players say it and the final score, the winner's first.
pub fn match_title(m: &MatchSummary) -> String {
    let [(a, _), (b, _)] = final_score(m);
    format!("{} {a}–{b}", map_name(&m.map))
}

/// What a match page is called to a crawler or a link preview: "Spirit vs Falcons · Dust II
/// 13–9" when the corpus named the teams, else [`match_title`].
pub fn page_title(m: &MatchSummary) -> String {
    match &m.teams {
        Some([a, b]) => format!("{a} vs {b} · {}", match_title(m)),
        None => match_title(m),
    }
}

/// A match page's `<title>` without the site's name: [`page_title`], then its tournament, else
/// "CS2 replay".
pub fn match_page_title(m: &MatchSummary) -> String {
    let place = m
        .event
        .as_deref()
        .map(event_name)
        .filter(|name| !name.is_empty())
        .map_or_else(|| "CS2 replay".to_owned(), |_| venue(m));
    format!("{} · {place}", page_title(m))
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

/// The match's top fragger: most kills, then damage, among the players on a side with a kill
/// and a name that does not escape to nothing visible.
pub(crate) fn top_fragger(m: &MatchSummary) -> Option<&SummaryPlayer> {
    m.players
        .iter()
        .filter(|p| p.kills > 0 && matches!(p.team, 2 | 3))
        .filter(|p| p.name.chars().any(|c| !dropped(c) && !c.is_whitespace()))
        .max_by_key(|p| (p.kills, p.damage))
}

/// "alpha led with 31 kills and 104 ADR · 24 rounds in 39 min · Valve matchmaking, EU West ·
/// Oct 22, 2025. Watch this CS2 demo in 3D.": the match's top fragger (most kills, then damage; not one
/// whose name escapes to nothing visible, and the ADR only when damage was counted), its length,
/// its tournament or where it was played, and the day.
pub(crate) fn description(m: &MatchSummary) -> String {
    let mut parts = Vec::new();
    if let Some([a, b]) = &m.teams {
        parts.push(format!("{a} vs {b} on {}", map_name(&m.map)));
    }
    if let Some(p) = top_fragger(m) {
        let kills = if p.kills == 1 {
            "1 kill".to_owned()
        } else {
            format!("{} kills", p.kills)
        };
        let adr = p.damage as f64 / f64::from(m.rounds.max(1));
        parts.push(if p.damage > 0 {
            format!(
                "{} led with {kills} and {} ADR",
                p.name.trim(),
                fixed(adr, 0)
            )
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
    let place = venue(m);
    if !place.is_empty() {
        parts.push(place);
    }
    let day = match_date(m);
    if !day.is_empty() {
        parts.push(day);
    }
    format!("{}. Watch this CS2 demo in 3D.", parts.join(" · "))
}

/// Where the match belongs: its tournament's name, else [`place`] of its server (empty when
/// neither is known).
pub fn venue(m: &MatchSummary) -> String {
    match m.event.as_deref().map(event_name) {
        Some(event) if !event.is_empty() => event,
        _ => place(&m.server_name),
    }
}

/// Where the match was played, as the viewer's HUD finds it (`brandModel` in
/// `web/src/components/hud/models.ts`) but with Valve's region in words: "Valve matchmaking, EU
/// West" for Valve's servers, any other server's name as it is.
pub fn place(server_name: &str) -> String {
    let valve = server_name
        .strip_prefix("Valve Counter-Strike 2 ")
        .and_then(|rest| rest.split_once(' '))
        .filter(|(region, rest)| !region.is_empty() && rest.starts_with("Server"))
        .map(|(region, _)| region);
    match valve {
        Some(region) => format!("Valve matchmaking, {}", region_name(region)),
        None => server_name
            .chars()
            .filter(|&c| !dropped(c))
            .collect::<String>()
            .trim()
            .to_owned(),
    }
}

/// A Valve region as a name: "us_south_central" is US South Central, "helsinki" Helsinki; the
/// letters of a country or a continent in capitals.
fn region_name(region: &str) -> String {
    region
        .split('_')
        .filter(|w| !w.is_empty())
        .map(|w| match w {
            "us" | "eu" | "sa" | "na" | "uk" | "hk" | "uae" => w.to_ascii_uppercase(),
            _ => capitalised(w),
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `w` with its first letter a capital.
fn capitalised(w: &str) -> String {
    let mut chars = w.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}

/// The months as the site writes a day (`formatDay` in `web/src/site/format.ts`, en-US).
const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// The day the match was played (UTC), or the day it was stored when that is not known, as the
/// site writes a day, with its year: "Oct 22, 2025".
pub fn match_date(m: &MatchSummary) -> String {
    m.played().map_or_else(String::new, date_of)
}

/// The days a tournament ran, its first and last joined by `to`, the day once when they are the
/// same one; none when they are not known.
pub(crate) fn event_days(e: &EventSummary, to: &str) -> Option<String> {
    let (first, last) = (date_of(e.first_unix?), date_of(e.last_unix?));
    Some(if first == last {
        first
    } else {
        format!("{first}{to}{last}")
    })
}

/// The day (UTC) of the Unix time `unix`, written as [`match_date`] writes it.
pub fn date_of(unix: u64) -> String {
    let (y, mo, d) = civil_from_days(unix / 86_400);
    let month = usize::try_from(mo - 1).map_or("", |i| MONTHS[i % 12]);
    format!("{month} {d}, {y}")
}

/// Words of a tournament's name written otherwise than capitalised, by their lower case
/// (`EVENT_WORDS` in `web/src/site/format.ts`).
const EVENT_WORDS: [(&str, &str); 22] = [
    ("betboom", "BetBoom"),
    ("blast", "BLAST"),
    ("cac2026", "CS Asia Championships 2026"),
    ("cct", "CCT"),
    ("cs", "CS"),
    ("cs2", "CS2"),
    ("csgo", "CS:GO"),
    ("dreamhack", "DreamHack"),
    ("eleague", "ELEAGUE"),
    ("epl", "EPL"),
    ("esea", "ESEA"),
    ("esl", "ESL"),
    ("ewc", "EWC"),
    ("faceit", "FACEIT"),
    ("fissure", "FISSURE"),
    ("iem", "IEM"),
    ("krakow", "Kraków"),
    ("mlg", "MLG"),
    ("pgl", "PGL"),
    ("rmr", "RMR"),
    ("starladder", "StarLadder"),
    ("tv", "TV"),
];

/// A tournament's name from the slug its demos came under (`iem_cologne_major_2026` → `IEM
/// Cologne Major 2026`), exactly as the web app's `eventName` writes it (both are held to
/// `tests/fixtures/events.json`): words split at runs of `_`, `-` and JavaScript's spaces; a
/// word holding a capital A to Z left as it is; a known organiser's or league's word as it
/// writes it; any other word with its first letter a capital (JavaScript's `charAt(0)`: a
/// letter past the Basic Multilingual Plane stays as it is).
pub fn event_name(slug: &str) -> String {
    slug.split(|c: char| js_space(c) || c == '_' || c == '-')
        .filter(|w| !w.is_empty())
        .map(|w| {
            if w.bytes().any(|b| b.is_ascii_uppercase()) {
                return w.to_owned();
            }
            if let Some((_, name)) = EVENT_WORDS.iter().find(|(lower, _)| *lower == w) {
                return (*name).to_owned();
            }
            match w.chars().next() {
                Some(first) if u32::from(first) <= 0xffff => capitalised(w),
                _ => w.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// What JavaScript's `\s` matches: Unicode's white space but U+0085, and U+FEFF.
fn js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// The days from 1970-01-01 to the proleptic Gregorian date `(y, m, d)`, the inverse of
/// [`civil_from_days`] (Howard Hinnant's `days_from_civil`).
pub(crate) fn civil_days((y, m, d): (u64, u64, u64)) -> u64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y / 400;
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
    era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
}

/// The proleptic Gregorian date `days` after 1970-01-01 (Howard Hinnant's `civil_from_days`).
pub(crate) fn civil_from_days(days: u64) -> (u64, u64, u64) {
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
/// the card was a JPEG) shows, or a player's card (`profile-<steamid>.jpg`); 404 when previews
/// are off, or the id is not a done match with a summary or a player the server holds.
async fn preview_image(
    State(s): State<AppState>,
    file: Result<UrlPath<String>, PathRejection>,
) -> Response {
    if !s.cfg.site.previews {
        return not_found();
    }
    let file = file.map(|UrlPath(f)| f).unwrap_or_default();
    if let Some(key) = file.strip_prefix("profile-") {
        return player_card(&s, key).await;
    }
    let id = file
        .strip_suffix(".jpg")
        .or_else(|| file.strip_suffix(".png"))
        .map(str::to_owned);
    let summary = match id {
        Some(id) => done_match(&s.store, &id).await,
        None => None,
    };
    let Some(summary) = summary else {
        return not_found();
    };
    let (summary, redacted) = without_hidden(summary, &s.hidden);
    match preview_jpeg(&s, summary, redacted.as_deref()).await {
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

/// The card of the player `key` (`<steamid>.jpg`) names: 404 for one hidden or the server
/// does not hold. Kept an hour: a new match makes a new one.
async fn player_card(s: &AppState, key: &str) -> Response {
    let view = match key.strip_suffix(".jpg").and_then(steamid) {
        Some(id) => known_profile(s, id).await,
        None => None,
    };
    let Some((view, name)) = view.and_then(|v| v.name.clone().map(|name| (v, name))) else {
        return not_found();
    };
    match profile_jpeg(s, &view, &name).await {
        Ok(jpeg) => (
            [
                (header::CONTENT_TYPE, "image/jpeg"),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            jpeg,
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "drawing a player's card");
            (StatusCode::INTERNAL_SERVER_ERROR, "cannot draw the card").into_response()
        }
    }
}

/// The player's card: `og/profile-<steamid>-<key>.jpg` ([`card_key`]) when drawn before, else
/// drawn now, kept there, and the player's older cards deleted. Drawn under
/// [`AppState::drawing`], as a match's.
async fn profile_jpeg(s: &AppState, view: &ProfileView, name: &str) -> io::Result<Vec<u8>> {
    let avatar = match avatar_file(s, view) {
        Some(path) => tokio::fs::read(path).await.ok(),
        None => None,
    };
    let card = preview::ProfileCard::of(view, name, avatar.is_some());
    let prefix = format!("profile-{}-", view.steamid);
    let path = s.store.og_path(&format!("{prefix}{}", card_key(&card)));
    if let Ok(jpeg) = tokio::fs::read(&path).await {
        return Ok(jpeg);
    }
    let drawing = s.drawing.clone().lock_owned().await;
    // Drawn while this request waited.
    if let Ok(jpeg) = tokio::fs::read(&path).await {
        return Ok(jpeg);
    }
    let hero = card
        .map
        .as_deref()
        .and_then(|map| map_file(&s.cfg, map, "hero.png"));
    let tmp = s.store.tmp_dir().join(format!("og-{prefix}card.jpg"));
    tokio::task::spawn_blocking(move || {
        let _drawing = drawing;
        let started = Instant::now();
        let hero = hero.and_then(|p| read_image(&p));
        let jpeg = preview::render_profile(&card, hero.as_deref(), avatar.as_deref())
            .map_err(io::Error::other)?;
        store::write_file(&tmp, &path, &jpeg)?;
        // The cards of what the player had before.
        if let Some(og) = path.parent() {
            for entry in fs::read_dir(og)?.flatten() {
                let old = entry.path();
                let theirs = entry.file_name().to_string_lossy().starts_with(&prefix);
                if theirs && old != path {
                    if let Err(e) = fs::remove_file(&old) {
                        tracing::warn!(path = %old.display(), error = %e, "deleting an old card");
                    }
                }
            }
        }
        tracing::info!(
            bytes = jpeg.len(),
            secs = started.elapsed().as_secs_f64(),
            "drew a player's card"
        );
        Ok(jpeg)
    })
    .await
    .map_err(io::Error::other)?
}

/// The map image at `p`; `None` when it is missing or unreadable (the card is drawn without it).
fn read_image(p: &Path) -> Option<Vec<u8>> {
    match fs::read(p) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!(path = %p.display(), error = %e, "reading a map image");
            None
        }
    }
}

/// The pack's preview: `og/<sha>.jpg` when drawn before, else drawn now and kept there. A card
/// with hidden players (`redacted`, the tag [`without_hidden`] gives) is kept apart, as
/// `og/<sha>-<tag>.jpg`, and drawing it deletes the card that named them. Drawing holds
/// [`AppState::drawing`] until the image is kept (also when the request is dropped
/// meanwhile), so a burst of requests for a new link draws it once.
async fn preview_jpeg(
    s: &AppState,
    summary: Arc<MatchSummary>,
    redacted: Option<&str>,
) -> io::Result<Vec<u8>> {
    let sha = summary.sha256.clone();
    let named = s.store.og_path(&sha);
    let name = match redacted {
        Some(tag) => format!("{sha}-{tag}.jpg"),
        None => format!("{sha}.jpg"),
    };
    let path = named.with_file_name(&name);
    let summary_path = s.store.summary_path(&sha);
    if let Some(jpeg) = kept(&path, &summary_path).await {
        return Ok(jpeg);
    }
    let drawing = s.drawing.clone().lock_owned().await;
    // Drawn while this request waited.
    if let Some(jpeg) = kept(&path, &summary_path).await {
        return Ok(jpeg);
    }
    let drop_named = redacted.is_some();
    let radar = map_file(&s.cfg, &summary.map, "radar.png");
    let hero = map_file(&s.cfg, &summary.map, "hero.png");
    let tmp = s.store.tmp_dir().join(format!("og-{name}"));
    tokio::task::spawn_blocking(move || {
        let _drawing = drawing;
        let started = Instant::now();
        let read = |p: Option<PathBuf>| p.and_then(|p| read_image(&p));
        let (hero, radar) = (read(hero), read(radar));
        let jpeg = preview::render(&summary, hero.as_deref(), radar.as_deref())
            .map_err(io::Error::other)?;
        // Whole or absent after a crash: a card cut short would be served from here for good.
        store::write_file(&tmp, &path, &jpeg)?;
        if drop_named {
            match fs::remove_file(&named) {
                Ok(()) => tracing::info!(%sha, "deleted a card naming a hidden player"),
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(%sha, error = %e, "cannot delete a card naming a hidden player")
                }
            }
        }
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
/// was drawn (an alias adding the date the match was played), or it was drawn in an older look
/// (without [`preview::MATCH_DESIGN`]): that one is drawn again.
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
    let design = preview::MATCH_DESIGN;
    tokio::fs::read(path)
        .await
        .ok()
        .filter(|jpeg| jpeg.windows(design.len()).any(|w| w == design))
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
    fn a_profile_is_titled_as_its_players_cs2_stats() {
        assert_eq!(stats_title("skunk"), "skunk's CS2 stats");
        assert_eq!(stats_title("Mats"), "Mats' CS2 stats");
        assert_eq!(stats_title("BOSS"), "BOSS' CS2 stats");
        assert_eq!(stats_title("гость"), "гость's CS2 stats");
    }

    /// The body goes just after the app's root, which stays empty for the app to mount in; a
    /// page without the root is left as it is.
    #[test]
    fn the_pre_rendered_body_goes_after_the_root() {
        let page = "<body>\n    <div id=\"root\"></div>\n  </body>".to_owned();
        assert_eq!(
            into_pre(page, "<main>x</main>"),
            "<body>\n    <div id=\"root\"></div><div id=\"pre\"><main>x</main></div>\n  </body>"
        );
        let other = "<body><div id=\"app\"></div></body>".to_owned();
        assert_eq!(into_pre(other.clone(), "<main>x</main>"), other);
    }

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

    /// The days as the site writes them: "Oct 22, 2025".
    #[test]
    fn a_match_is_dated_as_the_site_writes_days() {
        let on = |played: u64| MatchSummary {
            played_unix: Some(played),
            ..Default::default()
        };
        assert_eq!(match_date(&on(1_761_163_200)), "Oct 22, 2025");
        assert_eq!(match_date(&on(951_782_400)), "Feb 29, 2000");
        assert_eq!(match_date(&on(1_793_491_200)), "Nov 1, 2026");
        assert_eq!(match_date(&on(1_757_000_000)), "Sep 4, 2025");
        let stored = MatchSummary {
            created_unix: 1_761_300_000,
            ..Default::default()
        };
        assert_eq!(match_date(&stored), "Oct 24, 2025");
    }

    /// Valve's regions in words: "us_south_central" is US South Central.
    #[test]
    fn valves_regions_are_named_in_words() {
        for (server, place_name) in [
            (
                "Valve Counter-Strike 2 us_south_central Server (srcds8064-sto1.188.47)",
                "Valve matchmaking, US South Central",
            ),
            (
                "Valve Counter-Strike 2 eu_north Server (srcds7026-sto1.187.126)",
                "Valve matchmaking, EU North",
            ),
            (
                "Valve Counter-Strike 2 helsinki Server (srcds1029-hel1.380.15)",
                "Valve matchmaking, Helsinki",
            ),
            (
                "Valve Counter-Strike 2 sa_east Server",
                "Valve matchmaking, SA East",
            ),
            ("  my <lan> server ", "my <lan> server"),
            (
                "Valve Counter-Strike 2  Server",
                "Valve Counter-Strike 2  Server",
            ),
        ] {
            assert_eq!(place(server), place_name, "{server}");
        }
    }

    /// A tournament's name from its slug, as the web app's `eventName` writes it: both are held
    /// to `tests/fixtures/events.json`.
    #[test]
    fn events_are_named_as_the_web_app_names_them() {
        #[derive(serde::Deserialize)]
        struct Case {
            slug: String,
            name: String,
        }
        let cases: Vec<Case> =
            serde_json::from_str(include_str!("../tests/fixtures/events.json")).unwrap();
        assert!(cases.len() >= 20);
        for c in cases {
            assert_eq!(event_name(&c.slug), c.name, "{:?}", c.slug);
        }
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

    /// As the page writes them (`toFixed`, `Math.round`): a half away from zero, anything else
    /// to the nearest.
    #[test]
    fn figures_round_as_the_page_rounds_them() {
        for (x, places, written) in [
            (102.5, 0, "103"),
            (0.5, 0, "1"),
            (2.5, 0, "3"),
            (101.49, 0, "101"),
            (0.125, 2, "0.13"),
            (1.375, 2, "1.38"),
            (1.125, 2, "1.13"),
            // Below the half as stored, as `(1.005).toFixed(2)` is.
            (1.005, 2, "1.00"),
            (2.675, 2, "2.67"),
            (1.954_635, 2, "1.95"),
            (0.84, 1, "0.8"),
            (0.25, 1, "0.3"),
        ] {
            assert_eq!(fixed(x, places), written, "{x} to {places}");
        }
        // A figure the API sends as an f32 is read as the page reads its JSON.
        assert_eq!(fixed(as_sent(102.5), 0), "103");
        assert_eq!(fixed(as_sent(1.005), 2), "1.00");
        assert_eq!(as_sent(158.333_33), 158.333_33);
    }

    /// The profile's stat line: the strip's figures in the strip's order (rating, opening, K/D,
    /// ADR, HS%, matches), rounded as the page rounds them.
    #[test]
    fn the_stat_line_is_the_strip() {
        let mut view = build_profile(
            76_561_198_000_000_001,
            &[],
            None,
            crate::profile::TrackingState::Off,
            |_| false,
        );
        let t = &mut view.totals;
        (t.rating, t.kd, t.adr, t.hs_pct) = (Some(1.125), Some(1.1), Some(102.5), Some(61.5));
        (t.opening_won, t.opening_lost, t.matches) = (95, 51, 34);
        assert_eq!(
            stat_line(&view),
            "1.13 rating · 65% opening · 1.10 K/D · 103 ADR · 62 HS% · 34 matches"
        );
    }

    #[test]
    fn tags_go_in_the_head() {
        let tags = ["<a>".to_owned(), "<b>".to_owned()];
        assert_eq!(
            into_head(
                "<head>\n  <title>x</title>\n</head>\n<body>",
                Some("y"),
                None,
                &tags
            ),
            "<head>\n  <title>y</title>\n  <a>\n  <b>\n</head>\n<body>"
        );
        assert_eq!(
            into_head("<head></head>", Some("<&>"), None, &tags),
            "<head><title>&lt;&amp;&gt;</title><a><b></head>"
        );
        assert_eq!(
            into_head("<p>no head", Some("y"), None, &tags),
            "<p>no head"
        );
        // The page's own description, replaced; or, without one, the first of the tags.
        assert_eq!(
            into_head(
                "<head><meta name=\"description\" content=\"old\" /><title>x</title></head>",
                Some("y"),
                Some("\"new\""),
                &tags
            ),
            "<head><meta name=\"description\" content=\"&quot;new&quot;\"><title>y</title><a><b>\
             </head>"
        );
        assert_eq!(
            into_head("<head></head>", None, Some("d"), &tags),
            "<head><meta name=\"description\" content=\"d\"><a><b></head>"
        );
        // As the web build writes it: on several lines, after the title or before.
        for template in [
            "<head>\n<meta\n  name=\"description\"\n  content=\"old\"\n/>\n<title>x</title>\n</head>",
            "<head>\n<title>x</title>\n<meta\n  name=\"description\"\n  content=\"old\"\n/>\n</head>",
        ] {
            let out = into_head(template, Some("y"), Some("d"), &[]);
            assert_eq!(out.matches("description").count(), 1, "{out}");
            assert!(out.contains("<meta name=\"description\" content=\"d\">"), "{out}");
            assert!(out.contains("<title>y</title>") && !out.contains("old"), "{out}");
        }
    }
}
