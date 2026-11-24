//! `/api/players/{steamid}` (a player's profile from the matches we hold, with Steam's facts and
//! a tracked player's FACEIT history),
//! `/api/players/{steamid}/matches` (more of their matches) and `/api/lookup` (what the one
//! input names: a player, or a list of players by name). A hidden profile answers 410.

use std::net::SocketAddr;
use std::time::Instant;

use axum::extract::{ConnectInfo, Path as UrlPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::{ApiError, AppState};
use crate::identity::{classify, Input};
use crate::players::NAME_HITS;
use crate::profile::{build_profile, faceit_rows, match_rows, FaceitRow, MatchRef};
use crate::ratelimit::client_ip;
use crate::steam::SteamError;
use crate::store::Status;

/// The longest text the one input is read for.
const MAX_QUERY_CHARS: usize = 200;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/players/{steamid}", get(get_player))
        .route("/players/{steamid}/matches", get(get_player_matches))
        .route("/lookup", get(lookup))
}

/// The steamid64 of a path: 17 digits naming an individual's account, else a 404.
fn path_steamid(text: &str) -> Result<u64, ApiError> {
    let digits = text.len() == 17 && text.bytes().all(|b| b.is_ascii_digit());
    match classify(text) {
        Input::SteamId(id) if digits => Ok(id),
        _ => Err(ApiError::new(StatusCode::NOT_FOUND, "no such player")),
    }
}

fn hidden() -> Response {
    let body = json!({ "error": "This profile is hidden.", "hidden": true });
    (StatusCode::GONE, Json(body)).into_response()
}

/// The player's matches with a done demo (its oldest done record's id for the links).
pub(crate) fn player_matches(s: &AppState, steamid: u64) -> Vec<MatchRef> {
    let index = s.store.matches();
    index
        .players()
        .matches_of(steamid)
        .into_iter()
        .filter_map(|sha| {
            let summary = index.get(&sha)?;
            let done = s
                .store
                .find_by_sha(&sha)
                .filter(|r| r.status == Status::Done)?;
            Some(MatchRef {
                summary,
                demo_id: done.id,
            })
        })
        .collect()
}

/// The rows of `steamid`'s FACEIT history the FACEIT poller keeps ([`faceit_rows`]), a row's
/// replay while its record is done; none without a file, or when the file cannot be read (the
/// poller says why).
pub(crate) async fn faceit_history(s: &AppState, steamid: u64) -> Vec<FaceitRow> {
    let histories = s.faceit_histories.clone();
    let read = tokio::task::spawn_blocking(move || histories.get(steamid))
        .await
        .map_err(|e| e.to_string())
        .and_then(|got| got.map_err(|e| e.to_string()));
    let entry = read.unwrap_or_else(|e| {
        tracing::debug!(steamid, error = %e, "cannot read a FACEIT history for a profile");
        None
    });
    entry.map_or_else(Vec::new, |entry| {
        faceit_rows(&entry, |id| s.store.is_done(id))
    })
}

async fn get_player(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    UrlPath(steamid): UrlPath<String>,
) -> Result<Response, ApiError> {
    let id = path_steamid(&steamid)?;
    if s.hidden.is_hidden(id) {
        return Ok(hidden());
    }
    let matches = player_matches(&s, id);
    // The answer is at once, with what is kept (Steam's facts, however old). Facts not kept, or
    // stale, are fetched in the background, once however often the page asks, counted as one of
    // the client's lookups; past the limit there is no fetch. The answer says when one is under
    // way, so the page asks again.
    let kept = s.profiles.peek_with_age(id).await;
    let wanted = s.steam.is_some() && kept.as_ref().is_none_or(|(_, stale)| *stale);
    let pending = wanted
        && (s.profiles.fetching(id) || {
            let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
            s.lookups.check(ip, Instant::now()) && s.profiles.fetch_in_background(id)
        });
    let steam = kept.map(|(p, _)| p);
    let mut view = build_profile(
        id,
        &matches,
        steam.as_ref(),
        s.tracking.state(id),
        |other| s.hidden.is_hidden(other),
    );
    view.steam_pending = pending;
    view.faceit_history = faceit_history(&s, id).await;
    Ok(Json(view).into_response())
}

#[derive(Deserialize)]
struct Page {
    #[serde(default)]
    offset: usize,
}

async fn get_player_matches(
    State(s): State<AppState>,
    UrlPath(steamid): UrlPath<String>,
    Query(page): Query<Page>,
) -> Result<Response, ApiError> {
    let id = path_steamid(&steamid)?;
    if s.hidden.is_hidden(id) {
        return Ok(hidden());
    }
    let rows = match_rows(id, &player_matches(&s, id), page.offset);
    Ok(Json(rows).into_response())
}

#[derive(Deserialize)]
struct Lookup {
    #[serde(default)]
    q: String,
}

/// What the one input names. An id in any form answers at once, without Steam. A custom URL
/// name asks Steam (counted against the client's lookups); a bare word Steam does not know is
/// asked of FACEIT as a nickname (with a FACEIT key, in the same count), then looked for among
/// the names of the players we hold; neither ever answers a hidden player. A match is not a
/// player: the input opens it itself.
async fn lookup(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(Lookup { q }): Query<Lookup>,
) -> Result<Response, ApiError> {
    let text = q.trim();
    if text.chars().count() > MAX_QUERY_CHARS {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "That is too long to be a player",
        ));
    }
    let missing = || {
        ApiError::new(
            StatusCode::NOT_FOUND,
            format!("No Steam account or player called “{text}”"),
        )
    };
    let profile = |id: u64| Json(json!({ "kind": "profile", "steamid": id.to_string() }));
    let (name, bare) = match classify(text) {
        Input::SteamId(id) => return Ok(profile(id).into_response()),
        Input::Vanity { name, bare } => (name, bare),
        Input::ShareCode(_) | Input::ReplayUrl(_) | Input::Demo(_) | Input::FaceitMatch(_) => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "That is a match, not a player",
            ))
        }
        Input::Unrecognised => return Err(missing()),
    };
    if s.steam.is_some() || (bare && s.faceit.is_some()) {
        let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
        if !s.lookups.check(ip, Instant::now()) {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "Too many lookups from here; try again later",
            ));
        }
    }
    let unanswered = match s.profiles.resolve_vanity(&name).await {
        Ok(Some(id)) => return Ok(profile(id).into_response()),
        Ok(None) => None,
        Err(e) => Some(e),
    };
    if bare {
        // A hidden player is no match, as in the names below: the lookup must not name them.
        let found = faceit_nickname(&s, &name).await;
        if let Some(id) = found.filter(|id| !s.hidden.is_hidden(*id)) {
            return Ok(profile(id).into_response());
        }
        let players: Vec<_> = s
            .store
            .matches()
            .players()
            .find_by_name(&name, NAME_HITS * 2)
            .into_iter()
            .filter(|h| !s.hidden.is_hidden(h.steamid))
            .take(NAME_HITS)
            .map(|h| json!({ "steamid": h.steamid.to_string(), "name": h.name, "matches": h.matches }))
            .collect();
        if !players.is_empty() {
            return Ok(Json(json!({ "kind": "players", "players": players })).into_response());
        }
    }
    Err(match unanswered {
        None => missing(),
        Some(SteamError::Busy) => ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "Steam is busy; try again in a minute",
        ),
        Some(e) => {
            tracing::warn!(error = %e, "a custom URL lookup failed");
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "Steam is not answering; try again in a minute",
            )
        }
    })
}

/// The Steam account of the FACEIT player called `name`, asked of the Data API (one call) when
/// there is one; `None` when FACEIT has no such player, names no Steam account for them, or
/// fails (logged), so the lookup goes on to the names we hold.
async fn faceit_nickname(s: &AppState, name: &str) -> Option<u64> {
    let faceit = s.faceit.as_ref()?;
    match faceit.player_by_nickname(name).await {
        Ok(player) => player.and_then(|p| p.steamid),
        Err(e) => {
            tracing::warn!(error = %e, "a FACEIT nickname lookup failed");
            None
        }
    }
}
