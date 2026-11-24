//! Sign in through Steam (OpenID 2.0) and the session it starts ([`crate::sessions`]).
//!
//! `GET /auth/steam` sets a random state in a short-lived cookie and sends the browser to Steam;
//! Steam sends it back to `/auth/steam/return?state=<state>&openid.*`, which is believed only when
//! the state matches the cookie and is one this server made in the last ten minutes and has not
//! seen come back yet ([`SignIns`]: a return that leaked cannot be replayed), the answer names our own return address and Steam's endpoint,
//! Steam signed every field we read, the claimed id is a Steam account, and Steam itself confirms
//! the signature (`check_authentication`, asked of the configured endpoint, never of one named in
//! the answer, with exactly the fields checked: a return with any parameter given twice is
//! refused). Then a session cookie is set and the browser goes to `/track`; any failure goes
//! there too, as `/track?signin=failed`. A state-changing request with a session must come from
//! this site ([`same_origin`]).

use std::collections::HashMap;
use std::fmt;
use std::net::SocketAddr;
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, FromRequestParts, RawQuery, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::json;
use url::Url;

use crate::api::{ApiError, AppState};
use crate::errors::blocking;
use crate::identity::{classify, Input};
use crate::ratelimit::client_ip;
use crate::sessions::SESSION_TTL;

pub const SESSION_COOKIE: &str = "__Host-skunk";
pub const STATE_COOKIE: &str = "__Host-skunk-state";
pub const STEAM_OPENID: &str = "https://steamcommunity.com/openid/login";
/// How long a sign-in may take at Steam.
const STATE_TTL: Duration = Duration::from_secs(600);
/// The most states kept as come back (each for the rest of its ten minutes); past it a return
/// is refused rather than one forgotten, so a flood can delay sign-ins but never replay one.
const MAX_RETURNED: usize = 100_000;
const OPENID_NS: &str = "http://specs.openid.net/auth/2.0";
const IDENTIFIER_SELECT: &str = "http://specs.openid.net/auth/2.0/identifier_select";
const STEAM_ID_PREFIX: &str = "https://steamcommunity.com/openid/id/";
/// The fields Steam must have signed for the answer to be believed.
const MUST_SIGN: [&str; 5] = [
    "op_endpoint",
    "claimed_id",
    "identity",
    "return_to",
    "response_nonce",
];
/// Where a sign-in ends either way.
const DONE: &str = "/track";
const FAILED: &str = "/track?signin=failed";

/// `/auth/…`: start, return and sign out.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/auth/steam", get(start))
        .route("/auth/steam/return", get(finish))
        .route("/auth/signout", post(sign_out))
}

/// `/api/me`, nested under `/api`.
pub fn api_routes() -> Router<AppState> {
    Router::new().route("/me", get(me))
}

/// Why Steam's answer was not believed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// A parameter came more than once: this server and Steam could read different copies.
    Duplicate,
    /// A parameter's name is not `state` or `openid.` and lowercase letters and underscores: Steam
    /// could read it as another (PHP turns `.` and spaces in names into `_`).
    Name,
    NotIdRes,
    ReturnTo,
    Endpoint,
    ClaimedId,
    Unsigned,
    Unavailable(String),
    NotConfirmed,
    /// The client has used its lookups: a return would cost a call to Steam.
    TooMany,
}

impl fmt::Display for AuthError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AuthError::Duplicate => f.write_str("a parameter came twice"),
            AuthError::Name => f.write_str("a parameter has an unexpected name"),
            AuthError::NotIdRes => f.write_str("not a positive assertion"),
            AuthError::ReturnTo => f.write_str("the return address is not ours"),
            AuthError::Endpoint => f.write_str("the provider is not Steam's"),
            AuthError::ClaimedId => f.write_str("the claimed id is not a Steam account"),
            AuthError::Unsigned => f.write_str("a field we read was not signed"),
            AuthError::Unavailable(why) => write!(f, "Steam did not answer: {why}"),
            AuthError::NotConfirmed => f.write_str("Steam did not confirm the signature"),
            AuthError::TooMany => f.write_str("too many sign-ins from this client"),
        }
    }
}

fn return_to(public_url: &Url, state: &str) -> String {
    format!("{public_url}auth/steam/return?state={state}")
}

/// Sign-in states: each says when it ends and carries this server's MAC (a key made at start, so
/// a restart fails the sign-ins under way, which start again), so nothing is kept for a sign-in
/// that has not come back, and a flood of starts pushes out nobody's. A state that came back is
/// kept until it ends, so it is believed once.
pub struct SignIns {
    key: [u8; 32],
    /// State → when it ends (unix seconds).
    returned: Mutex<HashMap<String, u64>>,
}

type Mac = hmac::Hmac<sha2::Sha256>;
/// A state's bytes: when it ends (8), random (16), the MAC of those (16).
const STATE_LEN: usize = 40;

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Default for SignIns {
    fn default() -> Self {
        SignIns {
            key: rand::random(),
            returned: Mutex::default(),
        }
    }
}

impl SignIns {
    fn mac(&self) -> Mac {
        use hmac::Mac as _;
        Mac::new_from_slice(&self.key).expect("HMAC takes any key length")
    }

    /// A new state, good for [`STATE_TTL`].
    fn issue(&self) -> String {
        use hmac::Mac as _;
        let mut bytes = Vec::with_capacity(STATE_LEN);
        bytes.extend_from_slice(&(unix_now() + STATE_TTL.as_secs()).to_be_bytes());
        bytes.extend_from_slice(&rand::random::<[u8; 16]>());
        let mut mac = self.mac();
        mac.update(&bytes);
        bytes.extend_from_slice(&mac.finalize().into_bytes()[..16]);
        bs58::encode(bytes).into_string()
    }

    /// Whether `state` is one this server made, has not ended, and has not come back before; it
    /// counts as come back from now on.
    fn take(&self, state: &str) -> bool {
        use hmac::Mac as _;
        let Ok(bytes) = bs58::decode(state).into_vec() else {
            return false;
        };
        if bytes.len() != STATE_LEN {
            return false;
        }
        let (body, tag) = bytes.split_at(24);
        let mut mac = self.mac();
        mac.update(body);
        if mac.verify_truncated_left(tag).is_err() {
            return false;
        }
        let ends = u64::from_be_bytes(body[..8].try_into().expect("8 bytes"));
        let now = unix_now();
        if ends <= now {
            return false;
        }
        let mut returned = self.returned.lock().unwrap_or_else(PoisonError::into_inner);
        returned.retain(|_, end| *end > now);
        if returned.len() >= MAX_RETURNED || returned.contains_key(state) {
            return false;
        }
        returned.insert(state.to_owned(), ends);
        true
    }
}

/// Steam's sign-in page for a sign-in with `state`, coming back to this site.
pub fn login_url(endpoint: &Url, public_url: &Url, state: &str) -> Url {
    let mut url = endpoint.clone();
    url.query_pairs_mut()
        .append_pair("openid.ns", OPENID_NS)
        .append_pair("openid.mode", "checkid_setup")
        .append_pair("openid.return_to", &return_to(public_url, state))
        .append_pair("openid.realm", public_url.as_str())
        .append_pair("openid.identity", IDENTIFIER_SELECT)
        .append_pair("openid.claimed_id", IDENTIFIER_SELECT);
    url
}

/// The steamid Steam vouches for in `query` (the return's), or why not (see the module).
pub async fn verify(
    http: &reqwest::Client,
    endpoint: &Url,
    public_url: &Url,
    state: &str,
    query: &[(String, String)],
) -> Result<u64, AuthError> {
    // Every field once: what is checked here is then exactly what Steam is asked to confirm.
    let mut seen = std::collections::HashSet::new();
    if !query.iter().all(|(k, _)| seen.insert(k.as_str())) {
        return Err(AuthError::Duplicate);
    }
    let plain = |k: &str| {
        k == "state"
            || k.strip_prefix("openid.").is_some_and(|f| {
                !f.is_empty() && f.bytes().all(|b| b.is_ascii_lowercase() || b == b'_')
            })
    };
    if !query.iter().all(|(k, _)| plain(k)) {
        return Err(AuthError::Name);
    }
    let field = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    if field("openid.mode") != Some("id_res") {
        return Err(AuthError::NotIdRes);
    }
    if field("openid.return_to") != Some(return_to(public_url, state).as_str()) {
        return Err(AuthError::ReturnTo);
    }
    if field("openid.op_endpoint") != Some(endpoint.as_str()) {
        return Err(AuthError::Endpoint);
    }
    let claimed = field("openid.claimed_id").ok_or(AuthError::ClaimedId)?;
    if field("openid.identity") != Some(claimed) {
        return Err(AuthError::ClaimedId);
    }
    let digits = claimed
        .strip_prefix(STEAM_ID_PREFIX)
        .ok_or(AuthError::ClaimedId)?;
    let steamid = match classify(digits) {
        Input::SteamId(id) if digits.len() == 17 && digits.bytes().all(|b| b.is_ascii_digit()) => {
            id
        }
        _ => return Err(AuthError::ClaimedId),
    };
    let signed: Vec<&str> = field("openid.signed").unwrap_or("").split(',').collect();
    if !MUST_SIGN.iter().all(|f| signed.contains(f)) {
        return Err(AuthError::Unsigned);
    }
    let unavailable = |e: reqwest::Error| AuthError::Unavailable(e.without_url().to_string());
    let answer = http
        .post(endpoint.clone())
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(check_form(query))
        .send()
        .await
        .map_err(unavailable)?;
    if !answer.status().is_success() {
        return Err(AuthError::Unavailable(format!(
            "status {}",
            answer.status()
        )));
    }
    let body = answer.text().await.map_err(unavailable)?;
    if body.lines().any(|l| l.trim() == "is_valid:true") {
        Ok(steamid)
    } else {
        Err(AuthError::NotConfirmed)
    }
}

/// The form that asks Steam to confirm `query`, with the mode `check_authentication`: only
/// `openid.ns`, `openid.signed`, `openid.sig`, `openid.assoc_handle` and the fields `openid.signed`
/// lists, each with the one value `verify` checked (names already plain and unique). Built apart:
/// the serializer is not `Send`, and `verify` is awaited.
fn check_form(query: &[(String, String)]) -> String {
    let field = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    let signed = field("openid.signed").unwrap_or("");
    let mut names: Vec<&str> = vec!["ns", "signed", "sig", "assoc_handle"];
    for f in signed.split(',') {
        if !names.contains(&f) && f != "mode" {
            names.push(f);
        }
    }
    let mut form = url::form_urlencoded::Serializer::new(String::new());
    form.append_pair("openid.mode", "check_authentication");
    for name in names {
        let key = format!("openid.{name}");
        if let Some(v) = field(&key) {
            form.append_pair(&key, v);
        }
    }
    form.finish()
}

/// The value of cookie `name` in `headers`.
pub fn cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(n, _)| *n == name)
        .map(|(_, v)| v)
        .filter(|v| !v.is_empty())
}

fn set_cookie(name: &str, value: &str, max_age: u64) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{name}={value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age={max_age}"
    ))
    .expect("a cookie of base58 and ASCII")
}

/// Whether a request comes from this site: its `Origin` is the public URL's, or (without one)
/// the browser says it is same-origin. Every state-changing request with a session must.
pub fn same_origin(headers: &HeaderMap, public_url: &Url) -> bool {
    match headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        Some(origin) => origin == public_url.origin().ascii_serialization(),
        None => headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "same-origin"),
    }
}

/// The signed-in visitor's steamid: from the session cookie, else `401`.
pub struct SignedIn(pub u64);

impl FromRequestParts<AppState> for SignedIn {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, s: &AppState) -> Result<Self, Self::Rejection> {
        cookie(&parts.headers, SESSION_COOKIE)
            .and_then(|token| s.sessions.steamid(token))
            .map(SignedIn)
            .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "sign in through Steam first"))
    }
}

fn no_public_url() -> Response {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "sign-in needs DEMOVIEWER_PUBLIC_URL",
    )
    .into_response()
}

async fn start(State(s): State<AppState>) -> Response {
    let Some(public_url) = s.cfg.public_url.as_ref() else {
        return no_public_url();
    };
    let state = s.sign_ins.issue();
    let to = login_url(&s.cfg.openid_endpoint, public_url, &state);
    (
        StatusCode::FOUND,
        [
            (
                header::SET_COOKIE,
                set_cookie(STATE_COOKIE, &state, STATE_TTL.as_secs()),
            ),
            (
                header::LOCATION,
                HeaderValue::from_str(to.as_str()).expect("a URL"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response()
}

async fn finish(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    RawQuery(q): RawQuery,
) -> Response {
    let Some(public_url) = s.cfg.public_url.clone() else {
        return no_public_url();
    };
    let query: Vec<(String, String)> =
        url::form_urlencoded::parse(q.unwrap_or_default().as_bytes())
            .into_owned()
            .collect();
    let state = query
        .iter()
        .find(|(k, _)| k == "state")
        .map(|(_, v)| v.as_str())
        .unwrap_or("");
    // Only with the cookie (a state is used up only by the browser it was given to), and then
    // once, whatever the rest of the return says. A return that may ask Steam to confirm it
    // costs one of the client's lookups: made-up returns cannot have the server call Steam for
    // them without end.
    let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
    let verified = if state.is_empty()
        || cookie(&headers, STATE_COOKIE) != Some(state)
        || !s.sign_ins.take(state)
    {
        Err(AuthError::ReturnTo)
    } else if !s.lookups.check(ip, std::time::Instant::now()) {
        Err(AuthError::TooMany)
    } else {
        verify(&s.http, &s.cfg.openid_endpoint, &public_url, state, &query).await
    };
    let clear_state = set_cookie(STATE_COOKIE, "", 0);
    let steamid = match verified {
        Ok(id) => id,
        Err(e) => {
            tracing::warn!(error = %e, "a sign-in was refused");
            return redirect(FAILED, vec![clear_state]);
        }
    };
    let sessions = s.sessions.clone();
    match blocking(move || sessions.create(steamid)).await {
        Ok(token) => {
            tracing::info!(steamid, "signed in");
            let session = set_cookie(SESSION_COOKIE, &token, SESSION_TTL.as_secs());
            redirect(DONE, vec![clear_state, session])
        }
        Err(e) => {
            tracing::error!(error = %e, "cannot start a session");
            redirect(FAILED, vec![clear_state])
        }
    }
}

fn redirect(to: &'static str, cookies: Vec<HeaderValue>) -> Response {
    let mut res = (
        StatusCode::FOUND,
        [
            (header::LOCATION, HeaderValue::from_static(to)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
    )
        .into_response();
    for c in cookies {
        res.headers_mut().append(header::SET_COOKIE, c);
    }
    res
}

async fn sign_out(State(s): State<AppState>, headers: HeaderMap) -> Result<Response, ApiError> {
    let Some(public_url) = s.cfg.public_url.as_ref() else {
        return Ok(no_public_url());
    };
    if !same_origin(&headers, public_url) {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "not from this site"));
    }
    if let Some(token) = cookie(&headers, SESSION_COOKIE).map(str::to_owned) {
        let sessions = s.sessions.clone();
        blocking(move || sessions.remove(&token)).await?;
    }
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, set_cookie(SESSION_COOKIE, "", 0))],
    )
        .into_response())
}

/// Who is signed in; `{"signedIn": false}` for nobody, an answer rather than an error (every
/// page asks, and a 401 would be a console error on each for every visitor).
async fn me(
    State(s): State<AppState>,
    signed_in: Result<SignedIn, ApiError>,
) -> Json<serde_json::Value> {
    let Ok(SignedIn(steamid)) = signed_in else {
        return Json(json!({ "signedIn": false }));
    };
    // At once, with the kept profile; one missing or stale is fetched in the background (the
    // player's own, one at a time), and the answer says so, so the page asks again.
    let kept = s.profiles.peek_with_age(steamid).await;
    let pending = kept.as_ref().is_none_or(|(_, stale)| *stale)
        && (s.profiles.fetching(steamid) || s.profiles.fetch_in_background(steamid));
    let profile = kept.map(|(p, _)| p);
    Json(json!({
        "signedIn": true,
        "steamid": steamid.to_string(),
        "name": profile.as_ref().map(|p| p.name.clone()),
        "avatar": profile.and_then(|p| p.avatar),
        "tracking": s.tracking.state(steamid),
        "steamPending": pending,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A state with this server's MAC that ends at `ends`.
    fn state_ending(s: &SignIns, ends: u64) -> String {
        use hmac::Mac as _;
        let mut bytes = ends.to_be_bytes().to_vec();
        bytes.extend_from_slice(&[7; 16]);
        let mut mac = s.mac();
        mac.update(&bytes);
        bytes.extend_from_slice(&mac.finalize().into_bytes()[..16]);
        bs58::encode(bytes).into_string()
    }

    #[test]
    fn many_starts_push_out_no_sign_in_under_way() {
        let s = SignIns::default();
        let mine = s.issue();
        for _ in 0..50_000 {
            s.issue();
        }
        assert!(s.take(&mine));
        assert!(!s.take(&mine), "once");
    }

    #[test]
    fn a_state_another_key_made_or_one_changed_is_refused() {
        let s = SignIns::default();
        assert!(!s.take(&SignIns::default().issue()));
        let mut bytes = bs58::decode(s.issue()).into_vec().unwrap();
        bytes[10] ^= 1;
        assert!(!s.take(&bs58::encode(bytes).into_string()));
        assert!(!s.take("not-base58-0OIl"));
        assert!(!s.take(""));
    }

    #[test]
    fn a_state_that_ended_is_refused() {
        let s = SignIns::default();
        assert!(!s.take(&state_ending(&s, unix_now() - 1)));
        assert!(s.take(&state_ending(&s, unix_now() + 60)));
    }
}
