//! Sign-in through Steam (OpenID 2.0) and the server-side session: a fake provider on a local
//! port stands in for Steam, answering `check_authentication` as told.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::post;
use axum::Router;
use demoviewer_server::app::build_app_with;
use demoviewer_server::auth::{SESSION_COOKIE, STATE_COOKIE};
use demoviewer_server::config::Config;
use demoviewer_server::jobs::Jobs;
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::store::Store;
use serde_json::Value;
use tower::ServiceExt;
use url::Url;

const ME: &str = "76561198000000001";
const PUBLIC: &str = "https://skunk.club/";

/// A fake Steam OpenID endpoint: `check_authentication` answers `is_valid:<valid>`, counted in
/// `checks`.
async fn provider(valid: Arc<AtomicBool>, checks: Arc<AtomicUsize>) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/openid/login",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    let app = Router::new().route(
        "/openid/login",
        post(move |body: String| {
            let valid = valid.clone();
            checks.fetch_add(1, Ordering::SeqCst);
            async move {
                let form: HashMap<String, String> = url::form_urlencoded::parse(body.as_bytes())
                    .into_owned()
                    .collect();
                assert_eq!(form["openid.mode"], "check_authentication");
                let ok = valid.load(Ordering::SeqCst);
                format!("ns:http://specs.openid.net/auth/2.0\nis_valid:{ok}\n")
            }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

struct Site {
    app: Router,
    endpoint: Url,
    valid: Arc<AtomicBool>,
    /// The `check_authentication` calls the provider answered.
    checks: Arc<AtomicUsize>,
}

async fn site(data: &Path) -> Site {
    site_with(data, |c| c).await
}

async fn site_with(data: &Path, cfg: impl FnOnce(Config) -> Config) -> Site {
    let valid = Arc::new(AtomicBool::new(true));
    let checks = Arc::new(AtomicUsize::new(0));
    let endpoint = provider(valid.clone(), checks.clone()).await;
    let app = app_with(data, endpoint.clone(), cfg);
    Site {
        app,
        endpoint,
        valid,
        checks,
    }
}

fn app(data: &Path, endpoint: Url) -> Router {
    app_with(data, endpoint, |c| c)
}

fn app_with(data: &Path, endpoint: Url, cfg: impl FnOnce(Config) -> Config) -> Router {
    let cfg = Arc::new(cfg(Config {
        data_dir: data.to_owned(),
        public_url: Some(Url::parse(PUBLIC).unwrap()),
        openid_endpoint: endpoint,
        ..Config::default()
    }));
    let store = Arc::new(Store::open(&cfg).unwrap());
    let (jobs, _rx) = Jobs::channel();
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    build_app_with(cfg, store, jobs, limiter, None)
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 40000))))
}

async fn send(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let res = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8_lossy(&body).into_owned())
}

/// The value the response sets cookie `name` to, if it sets it.
fn set_cookie(headers: &HeaderMap, name: &str) -> Option<(String, String)> {
    headers.get_all(header::SET_COOKIE).iter().find_map(|v| {
        let v = v.to_str().unwrap();
        let (pair, attrs) = v.split_once(';').unwrap_or((v, ""));
        let (n, value) = pair.split_once('=')?;
        (n == name).then(|| (value.to_owned(), attrs.to_owned()))
    })
}

/// What the provider sends the browser back with for `claimed`, as Steam signs it.
fn provider_return(endpoint: &Url, state: &str, claimed: &str, signed: &str) -> String {
    let return_to = format!("{PUBLIC}auth/steam/return?state={state}");
    let mut q = url::form_urlencoded::Serializer::new(String::new());
    q.append_pair("state", state)
        .append_pair("openid.ns", "http://specs.openid.net/auth/2.0")
        .append_pair("openid.mode", "id_res")
        .append_pair("openid.op_endpoint", endpoint.as_str())
        .append_pair("openid.claimed_id", claimed)
        .append_pair("openid.identity", claimed)
        .append_pair("openid.return_to", &return_to)
        .append_pair("openid.response_nonce", "2026-10-27T00:00:00Zabc")
        .append_pair("openid.assoc_handle", "1234567890")
        .append_pair("openid.signed", signed)
        .append_pair("openid.sig", "c2lnbmF0dXJl");
    format!("/auth/steam/return?{}", q.finish())
}

const SIGNED: &str = "signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle";
const STEAM_ID_URL: &str = "https://steamcommunity.com/openid/id/76561198000000001";

/// Starts sign-in: the state cookie and where the browser is sent.
async fn start(s: &Site) -> (String, Url) {
    let (status, headers, _) = send(
        &s.app,
        Request::get("/auth/steam").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let (state, attrs) = set_cookie(&headers, STATE_COOKIE).expect("a state cookie");
    for a in [
        "HttpOnly",
        "Secure",
        "SameSite=Lax",
        "Path=/",
        "Max-Age=600",
    ] {
        assert!(attrs.contains(a), "{attrs}");
    }
    (
        state,
        Url::parse(headers[header::LOCATION].to_str().unwrap()).unwrap(),
    )
}

/// Comes back from the provider with `query`, with or without the state cookie.
async fn come_back(s: &Site, query: &str, state_cookie: Option<&str>) -> (StatusCode, HeaderMap) {
    let mut req = Request::get(query);
    if let Some(c) = state_cookie {
        req = req.header(header::COOKIE, format!("{STATE_COOKIE}={c}"));
    }
    let (status, headers, _) = send(&s.app, req.body(Body::empty()).unwrap()).await;
    (status, headers)
}

/// Signs in all the way; the session cookie's value.
async fn sign_in(s: &Site) -> String {
    let (state, _) = start(s).await;
    let (status, headers) = come_back(
        s,
        &provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED),
        Some(&state),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/track");
    set_cookie(&headers, SESSION_COOKIE)
        .expect("a session cookie")
        .0
}

async fn me(app: &Router, session: &str) -> (StatusCode, Value) {
    let req = Request::get("/api/me")
        .header(
            header::COOKIE,
            format!("other=1; {SESSION_COOKIE}={session}"),
        )
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(app, req).await;
    (status, serde_json::from_str(&body).unwrap_or(Value::Null))
}

fn refused(status: StatusCode, headers: &HeaderMap) {
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(headers[header::LOCATION], "/track?signin=failed");
    assert!(set_cookie(headers, SESSION_COOKIE).is_none());
}

#[tokio::test]
async fn sign_in_returns_to_skunk_club_with_a_session() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let (state, to) = start(&s).await;
    assert_eq!(to.origin(), s.endpoint.origin());
    let q: HashMap<String, String> = to.query_pairs().into_owned().collect();
    assert_eq!(q["openid.mode"], "checkid_setup");
    assert_eq!(q["openid.realm"], PUBLIC);
    assert_eq!(
        q["openid.return_to"],
        format!("{PUBLIC}auth/steam/return?state={state}")
    );
    assert_eq!(
        q["openid.identity"],
        "http://specs.openid.net/auth/2.0/identifier_select"
    );
    let session = sign_in(&s).await;
    let (status, v) = me(&s.app, &session).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["signedIn"], true);
    assert_eq!(v["steamid"], ME);
    assert_eq!(v["tracking"], "off");
}

/// A return URL that leaked (a log, a proxy, a shared browser's history) signs nobody in again,
/// even with its state set as a cookie: each state is good for one return, and only one this
/// server gave out.
#[tokio::test]
async fn a_return_works_once() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let (state, _) = start(&s).await;
    let back = provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED);
    let (status, headers) = come_back(&s, &back, Some(&state)).await;
    assert_eq!(headers[header::LOCATION], "/track", "{status}");
    let (status, headers) = come_back(&s, &back, Some(&state)).await;
    refused(status, &headers);
    // A state this server never gave out, with a matching cookie.
    let made_up = "3yQJbNZxYzkSpTN6wTnZ6n";
    let back = provider_return(&s.endpoint, made_up, STEAM_ID_URL, SIGNED);
    let (status, headers) = come_back(&s, &back, Some(made_up)).await;
    refused(status, &headers);
}

#[tokio::test]
async fn a_return_without_our_state_cookie_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let (state, _) = start(&s).await;
    let back = provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED);
    let (status, headers) = come_back(&s, &back, None).await;
    refused(status, &headers);
    let (status, headers) = come_back(&s, &back, Some("someone-elses-state")).await;
    refused(status, &headers);
}

#[tokio::test]
async fn a_claimed_id_that_is_not_steams_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    for claimed in [
        "https://evil.example/openid/id/76561198000000001",
        "https://steamcommunity.com/openid/id/123",
        "https://steamcommunity.com/openid/id/76561198000000001/x",
    ] {
        let (state, _) = start(&s).await;
        let (status, headers) = come_back(
            &s,
            &provider_return(&s.endpoint, &state, claimed, SIGNED),
            Some(&state),
        )
        .await;
        refused(status, &headers);
    }
    // Steam's id, but not among what the provider signed.
    let (state, _) = start(&s).await;
    let unsigned = "signed,op_endpoint,identity,return_to,response_nonce,assoc_handle";
    let (status, headers) = come_back(
        &s,
        &provider_return(&s.endpoint, &state, STEAM_ID_URL, unsigned),
        Some(&state),
    )
    .await;
    refused(status, &headers);
}

#[tokio::test]
async fn a_return_the_provider_does_not_confirm_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    s.valid.store(false, Ordering::SeqCst);
    let (state, _) = start(&s).await;
    let (status, headers) = come_back(
        &s,
        &provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED),
        Some(&state),
    )
    .await;
    refused(status, &headers);
}

#[tokio::test]
async fn sessions_survive_a_restart_and_signout_ends_them() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let session = sign_in(&s).await;
    let again = app(dir.path(), s.endpoint.clone());
    assert_eq!(me(&again, &session).await.0, StatusCode::OK);
    let req = Request::post("/auth/signout")
        .header(header::ORIGIN, "https://skunk.club")
        .header(header::COOKIE, format!("{SESSION_COOKIE}={session}"))
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = send(&again, req).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (cleared, attrs) = set_cookie(&headers, SESSION_COOKIE).unwrap();
    assert!(cleared.is_empty() && attrs.contains("Max-Age=0"), "{attrs}");
    // Signed out is an answer, not an error: a visitor's every page asks, and a 401 would be
    // a console error on each.
    let signed_out = (StatusCode::OK, serde_json::json!({ "signedIn": false }));
    assert_eq!(me(&again, &session).await, signed_out);
    assert_eq!(me(&again, "made-up").await, signed_out);
}

#[tokio::test]
async fn the_session_file_holds_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let session = sign_in(&s).await;
    let file = std::fs::read_to_string(dir.path().join("sessions.json")).unwrap();
    assert!(!file.contains(&session));
    assert!(file.contains(ME));
}

#[tokio::test]
async fn a_post_from_another_origin_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    let session = sign_in(&s).await;
    for origin in [Some("https://evil.example"), Some("null"), None] {
        let mut req = Request::post("/auth/signout")
            .header(header::COOKIE, format!("{SESSION_COOKIE}={session}"));
        if let Some(o) = origin {
            req = req.header(header::ORIGIN, o);
        }
        let (status, _, _) = send(&s.app, req.body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{origin:?}");
    }
    assert_eq!(me(&s.app, &session).await.0, StatusCode::OK);
}

#[tokio::test]
async fn without_a_public_url_sign_in_is_off() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().to_owned(),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    let (jobs, _rx) = Jobs::channel();
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    let app = build_app_with(cfg, store, jobs, limiter, None);
    let (status, _, body) = send(
        &app,
        Request::get("/auth/steam").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert!(body.contains("DEMOVIEWER_PUBLIC_URL"), "{body}");
}

/// A field given twice could be read one way here and another way by Steam: the victim's id
/// first (what we would check), the attacker's own signed one after (what Steam would confirm).
#[tokio::test]
async fn a_return_with_a_field_given_twice_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    for twice in [
        "openid.claimed_id",
        "openid.identity",
        "openid.signed",
        "state",
    ] {
        let (state, _) = start(&s).await;
        let back = provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED);
        let extra = match twice {
            "openid.signed" => SIGNED.to_owned(),
            "state" => state.clone(),
            _ => "https://steamcommunity.com/openid/id/76561198000000002".to_owned(),
        };
        let doubled = format!(
            "{back}&{}",
            url::form_urlencoded::Serializer::new(String::new())
                .append_pair(twice, &extra)
                .finish()
        );
        let (status, headers) = come_back(&s, &doubled, Some(&state)).await;
        refused(status, &headers);
    }
}

/// A name that Steam's side may read as another (PHP turns `.` and spaces in names into `_`) could
/// carry the attacker's own signed id past a check of the victim's: any name that is not `state`
/// or `openid.` and lowercase letters and underscores refuses the return.
#[tokio::test]
async fn a_return_with_a_look_alike_name_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let s = site(dir.path()).await;
    for name in [
        "openid_claimed_id",
        "openid.claimed id",
        "openid.claimed_id[]",
        "openid.Claimed_id",
        "x",
    ] {
        let (state, _) = start(&s).await;
        let back = provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED);
        let extra = url::form_urlencoded::Serializer::new(String::new())
            .append_pair(
                name,
                "https://steamcommunity.com/openid/id/76561198000000002",
            )
            .finish();
        let (status, headers) = come_back(&s, &format!("{back}&{extra}"), Some(&state)).await;
        refused(status, &headers);
    }
}

/// Every return that would make the server ask Steam to confirm it counts against the client's
/// lookups: anyone can start sign-ins and send made-up returns, and unlimited they would have
/// the server call Steam's OpenID endpoint for them until Steam turned this server away.
#[tokio::test]
async fn returns_that_ask_steam_are_limited_per_client() {
    let dir = tempfile::tempdir().unwrap();
    let s = site_with(dir.path(), |c| Config {
        lookups_per_hour: 2,
        ..c
    })
    .await;
    for _ in 0..2 {
        sign_in(&s).await;
    }
    assert_eq!(s.checks.load(Ordering::SeqCst), 2);
    let (state, _) = start(&s).await;
    let (status, headers) = come_back(
        &s,
        &provider_return(&s.endpoint, &state, STEAM_ID_URL, SIGNED),
        Some(&state),
    )
    .await;
    refused(status, &headers);
    assert_eq!(
        s.checks.load(Ordering::SeqCst),
        2,
        "the third never reached Steam"
    );
}
