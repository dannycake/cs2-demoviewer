//! `POST /api/me/tracking` and `DELETE /api/me/tracking`: the signed-in player shares their match
//! history (their authentication code and a match token, from Steam's support page) or stops
//! sharing it. A link is checked against Steam once per token given (one call, two with an older
//! token), each call counted against the client's lookups as a profile lookup is, and Steam's own
//! refusal names the field to fix. The code is sealed at rest
//! ([`crate::tracking`]); stopping deletes it before the answer.

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::api::{ApiError, AppState};
use crate::auth::{same_origin, SignedIn};
use crate::errors::blocking;
use crate::history::{HistoryError, MatchHistory, Next};
use crate::ratelimit::client_ip;
use crate::sharecode;
use crate::tracking::AuthCode;

const NOT_SET_UP: &str = "tracking is not set up on this server";
const STEAM_DOWN: &str = "Steam did not answer; try again in a minute";
const TOO_MANY: &str = "Too many lookups from here; try again later";
const CODE_403: &str = "Steam rejected this code (403). Open the support page again, press Create Authentication Code and paste the new one.";
const TOKEN_412: &str = "Steam rejected this match token (412). Copy Your most recently completed match token from the same page again.";
const OLDER_412: &str =
    "Steam does not know this match token (412). Copy it again from the match in CS2's match list.";
const CODE_SHAPE: &str = "That is not an authentication code (ABCD-EFGHI-JKLM).";
const TOKEN_SHAPE: &str = "That is not a match token (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx).";
/// The longest a link waits for Steam before saying it did not answer.
const STEAM_WAIT: Duration = Duration::from_secs(30);

/// `/me/tracking`, nested under `/api`.
pub fn routes() -> Router<AppState> {
    Router::new().route("/me/tracking", post(link).delete(unlink))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    auth_code: String,
    token: String,
    #[serde(default)]
    older_token: Option<String>,
}

/// A `400` naming the field to fix.
fn field(name: &str, error: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({ "field": name, "error": error })),
    )
        .into_response()
}

/// The share code in `text` (CS2's share link works too), when it decodes.
fn token(text: &str) -> Option<String> {
    let code = sharecode::extract(text)?;
    sharecode::decode(&code).ok().map(|_| code)
}

/// The request must come from this site (a signed-in action changes state).
fn from_here(s: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    let public_url = s
        .cfg
        .public_url
        .as_ref()
        .ok_or_else(|| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, NOT_SET_UP))?;
    if same_origin(headers, public_url) {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, "not from this site"))
    }
}

async fn ask(
    history: &dyn MatchHistory,
    steamid: u64,
    code: &AuthCode,
    known: &str,
) -> Result<Next, HistoryError> {
    tokio::time::timeout(STEAM_WAIT, history.next_code(steamid, code, known))
        .await
        .unwrap_or(Err(HistoryError::Unavailable))
}

async fn link(
    State(s): State<AppState>,
    SignedIn(steamid): SignedIn,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<Link>, JsonRejection>,
) -> Result<Response, ApiError> {
    from_here(&s, &headers)?;
    let (Some(history), Some(tracker)) = (s.history.clone(), s.tracker.clone()) else {
        return Err(ApiError::new(StatusCode::SERVICE_UNAVAILABLE, NOT_SET_UP));
    };
    let Json(req) = body.map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.body_text()))?;
    let Some(code) = AuthCode::parse(&req.auth_code) else {
        return Ok(field("authCode", CODE_SHAPE));
    };
    let Some(latest) = token(&req.token) else {
        return Ok(field("token", TOKEN_SHAPE));
    };
    let older = match req.older_token.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(text) => match token(text) {
            Some(t) => Some(t),
            None => return Ok(field("olderToken", TOKEN_SHAPE)),
        },
    };
    let steam_down = || ApiError::new(StatusCode::SERVICE_UNAVAILABLE, STEAM_DOWN);
    let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
    let counted = || {
        s.lookups
            .check(ip, Instant::now())
            .then_some(())
            .ok_or_else(|| ApiError::new(StatusCode::TOO_MANY_REQUESTS, TOO_MANY))
    };
    counted()?;
    match ask(&*history, steamid, &code, &latest).await {
        Ok(_) => {}
        Err(HistoryError::WrongCode) => return Ok(field("authCode", CODE_403)),
        Err(HistoryError::BadToken) => return Ok(field("token", TOKEN_412)),
        Err(HistoryError::RateLimited | HistoryError::Unavailable) => return Err(steam_down()),
    }
    if let Some(older) = &older {
        counted()?;
        match ask(&*history, steamid, &code, older).await {
            Ok(_) => {}
            Err(HistoryError::WrongCode) => return Ok(field("authCode", CODE_403)),
            Err(HistoryError::BadToken) => return Ok(field("olderToken", OLDER_412)),
            Err(HistoryError::RateLimited | HistoryError::Unavailable) => return Err(steam_down()),
        }
    }
    // The walk starts at the oldest token given; the tokens' own matches are fetched too, as
    // the history only walks past them.
    let start = older.clone().unwrap_or_else(|| latest.clone());
    let tracking = s.tracking.clone();
    blocking(move || tracking.link(steamid, &code, &start))
        .await?
        .map_err(|e| ApiError::internal("cannot start tracking", e))?;
    for t in older.into_iter().chain([latest]) {
        tracker.queue_token(steamid, t);
    }
    tracker.poke();
    tracing::info!(steamid, "tracking linked");
    Ok((StatusCode::ACCEPTED, Json(json!({ "tracking": "on" }))).into_response())
}

async fn unlink(
    State(s): State<AppState>,
    SignedIn(steamid): SignedIn,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    from_here(&s, &headers)?;
    let tracking = s.tracking.clone();
    blocking(move || tracking.unlink(steamid))
        .await?
        .map_err(|e| ApiError::internal("cannot stop tracking", e))?;
    tracing::info!(steamid, "tracking unlinked");
    Ok(StatusCode::NO_CONTENT.into_response())
}
