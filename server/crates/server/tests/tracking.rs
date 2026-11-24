//! The tracker: one task walks each linked player's match history from their cursor, fetching
//! each new match through the ingest one at a time, behind users. Steam's history is a scripted
//! fake; the job queue is a stub whose settler marks each record done, so the tracker is tested
//! alone (the runner's own tests fetch and keep a tracked match).

mod common;

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use demoviewer_server::config::Config;
use demoviewer_server::gcbot::{BoxFuture, ResolveError};
use demoviewer_server::history::{HistoryError, MatchHistory, Next};
use demoviewer_server::jobs::Jobs;
use demoviewer_server::profile::TrackingState;
use demoviewer_server::seal::Key;
use demoviewer_server::sharecode::encode;
use demoviewer_server::sharecode::ShareCode;
use demoviewer_server::store::{Source, Status, Store};
use demoviewer_server::tracker::{spawn_tracker, TrackerHandle, CHECK_EVERY, MAX_BACKOFF};
use demoviewer_server::tracking::{AuthCode, Tracking};

use common::{settle, Failures};

const A: u64 = 76561198000000001;
const B: u64 = 76561198000000002;
const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

fn code_n(n: u64) -> String {
    encode(&ShareCode {
        match_id: 3_000_000_000_000_000_000 + n,
        outcome_id: 3_000_000_000_000_000_100 + n,
        token: n as u16,
    })
}

/// A scripted history: per player, the answers in order; `Latest` once they run out. Records
/// every call as (steamid, known code).
#[derive(Default)]
struct FakeHistory {
    script: Mutex<HashMap<u64, VecDeque<Result<Next, HistoryError>>>>,
    calls: Mutex<Vec<(u64, String)>>,
}

impl FakeHistory {
    fn script(&self, steamid: u64, answers: Vec<Result<Next, HistoryError>>) {
        self.script.lock().unwrap().insert(steamid, answers.into());
    }
    fn calls(&self) -> Vec<(u64, String)> {
        self.calls.lock().unwrap().clone()
    }
}

impl MatchHistory for FakeHistory {
    fn next_code<'a>(
        &'a self,
        steamid: u64,
        _code: &'a AuthCode,
        known: &'a str,
    ) -> BoxFuture<'a, Result<Next, HistoryError>> {
        Box::pin(async move {
            self.calls.lock().unwrap().push((steamid, known.to_owned()));
            self.script
                .lock()
                .unwrap()
                .get_mut(&steamid)
                .and_then(VecDeque::pop_front)
                .unwrap_or(Ok(Next::Latest))
        })
    }
}

struct World {
    _dir: tempfile::TempDir,
    data: std::path::PathBuf,
    store: Arc<Store>,
    tracking: Arc<Tracking>,
    history: Arc<FakeHistory>,
    tracker: TrackerHandle,
    /// Share-code jobs the stub queue received.
    jobs: Arc<Mutex<Vec<String>>>,
    /// The most jobs in flight at once.
    most: Arc<AtomicUsize>,
    /// Per share code, the errors its next fetches end with, one each.
    fail: Failures,
}

fn world_in(dir: tempfile::TempDir) -> World {
    let data = dir.path().join("data");
    let cfg = Config {
        data_dir: data.clone(),
        ..Config::default()
    };
    let store = Arc::new(Store::open(&cfg).unwrap());
    let tracking = Tracking::open(&data, Some(Key::from_hex(KEY).unwrap())).unwrap();
    let history = Arc::new(FakeHistory::default());
    let (jobs_tx, rx) = Jobs::channel();
    let fail = Failures::default();
    let (jobs, most) = settle(store.clone(), rx, fail.clone());
    let tracker = spawn_tracker(
        store.clone(),
        jobs_tx,
        tracking.clone(),
        history.clone() as Arc<dyn MatchHistory>,
    );
    World {
        _dir: dir,
        data,
        store,
        tracking,
        history,
        tracker,
        jobs,
        most,
        fail,
    }
}

fn world() -> World {
    world_in(tempfile::tempdir().unwrap())
}

fn auth() -> AuthCode {
    AuthCode::parse("ABCD-EFGHI-JKLM").unwrap()
}

/// Lets the tracker run for `d` of (paused) time.
async fn run_for(d: Duration) {
    let step = Duration::from_millis(500);
    let mut t = Duration::ZERO;
    while t < d {
        tokio::time::sleep(step).await;
        t += step;
    }
}

fn tracked(store: &Store) -> Vec<(String, Status)> {
    let mut r: Vec<_> = store
        .records()
        .into_iter()
        .filter(|r| r.source == Source::Tracked)
        .map(|r| (r.sharecode.unwrap_or_default(), r.status))
        .collect();
    r.sort_by(|a, b| a.0.cmp(&b.0));
    r
}

#[tokio::test(start_paused = true)]
async fn new_matches_are_fetched_one_at_a_time_and_kept() {
    let w = world();
    w.history.script(
        A,
        vec![
            Ok(Next::Code(code_n(1))),
            Ok(Next::Code(code_n(2))),
            Ok(Next::Latest),
        ],
    );
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(10)).await;
    let mut want = vec![(code_n(1), Status::Done), (code_n(2), Status::Done)];
    want.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(tracked(&w.store), want);
    assert_eq!(*w.jobs.lock().unwrap(), [code_n(1), code_n(2)]);
    assert_eq!(w.tracking.cursor(A), Some(code_n(2)));
    let known: Vec<String> = w.history.calls().into_iter().map(|(_, k)| k).collect();
    assert_eq!(known, [code_n(0), code_n(1), code_n(2)]);
}

#[tokio::test(start_paused = true)]
async fn the_tracker_holds_at_most_one_lookup_at_a_time() {
    let w = world();
    w.history
        .script(A, (1..=4).map(|n| Ok(Next::Code(code_n(n)))).collect());
    w.history
        .script(B, (5..=8).map(|n| Ok(Next::Code(code_n(n)))).collect());
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracking.link(B, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(30)).await;
    assert_eq!(w.jobs.lock().unwrap().len(), 8);
    assert_eq!(w.most.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn a_403_mid_walk_stops_tracking_and_deletes_the_code() {
    let w = world();
    w.history.script(
        A,
        vec![Ok(Next::Code(code_n(1))), Err(HistoryError::WrongCode)],
    );
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(10)).await;
    assert_eq!(tracked(&w.store), [(code_n(1), Status::Done)]);
    assert_eq!(w.tracking.state(A), TrackingState::Stopped);
    assert!(w.tracking.code(A).is_none());
    let file = std::fs::read_to_string(w.data.join("tracking.json")).unwrap();
    assert!(!file.contains("\"nonce\""), "{file}");
    let calls = w.history.calls().len();
    run_for(Duration::from_secs(2 * 3600)).await;
    assert_eq!(w.history.calls().len(), calls, "no call after the stop");
}

#[tokio::test(start_paused = true)]
async fn a_rejected_token_stops_tracking_too() {
    let w = world();
    w.history.script(A, vec![Err(HistoryError::BadToken)]);
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(5)).await;
    assert_eq!(w.tracking.state(A), TrackingState::Stopped);
    assert_eq!(w.tracking.reason(A).as_deref(), Some("token rejected"));
}

#[tokio::test(start_paused = true)]
async fn each_player_is_checked_about_every_fifteen_minutes() {
    let w = world();
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(5)).await;
    assert_eq!(w.history.calls().len(), 1);
    run_for(CHECK_EVERY - Duration::from_secs(60)).await;
    assert_eq!(w.history.calls().len(), 1, "not before fifteen minutes");
    run_for(Duration::from_secs(120)).await;
    assert_eq!(w.history.calls().len(), 2, "again after fifteen minutes");
}

#[tokio::test(start_paused = true)]
async fn an_unavailable_steam_backs_off_up_to_two_hours() {
    let w = world();
    w.history
        .script(A, vec![Err(HistoryError::Unavailable); 20]);
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(6 * 3600)).await;
    let n = w.history.calls().len();
    // Backing off by doubling to two hours: far fewer than one call every fifteen minutes.
    assert!((4..=10).contains(&n), "{n} calls in six hours");
    assert_eq!(w.tracking.state(A), TrackingState::On);
    assert!(MAX_BACKOFF >= Duration::from_secs(2 * 3600));
}

#[tokio::test(start_paused = true)]
async fn stopping_during_a_walk_ends_it_and_keeps_no_cursor() {
    let w = world();
    w.history
        .script(A, (1..=5).map(|n| Ok(Next::Code(code_n(n)))).collect());
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    // The walk is waiting for its first match (the stub settles it at 1 s, seen at 2 s).
    run_for(Duration::from_millis(1500)).await;
    w.tracking.unlink(A).unwrap();
    run_for(Duration::from_secs(60)).await;
    assert_eq!(w.history.calls().len(), 1, "no Steam call after the stop");
    assert_eq!(w.tracking.cursor(A), None);
    // The match already being fetched finishes.
    assert_eq!(tracked(&w.store), [(code_n(1), Status::Done)]);
}

#[tokio::test(start_paused = true)]
async fn a_new_link_during_a_walk_keeps_its_own_cursor() {
    let w = world();
    w.history
        .script(A, (1..=3).map(|n| Ok(Next::Code(code_n(n)))).collect());
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_millis(1500)).await;
    // The player links again with an older token while the first walk waits on a match.
    w.tracking.link(A, &auth(), &code_n(100)).unwrap();
    run_for(Duration::from_secs(30)).await;
    let known: Vec<String> = w.history.calls().into_iter().map(|(_, k)| k).collect();
    assert_eq!(known, [code_n(0), code_n(100), code_n(2), code_n(3)]);
    assert_eq!(w.tracking.cursor(A), Some(code_n(3)));
}

#[tokio::test(start_paused = true)]
async fn a_match_that_failed_to_fetch_is_asked_for_again() {
    let w = world();
    // gcbot was offline for the first try.
    w.fail
        .lock()
        .unwrap()
        .insert(code_n(1), [ResolveError::Offline.to_string()].into());
    w.history.script(
        A,
        vec![Ok(Next::Code(code_n(1))), Ok(Next::Code(code_n(1)))],
    );
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(10)).await;
    // The cursor stays before the match that failed.
    assert_eq!(w.tracking.cursor(A), Some(code_n(0)));
    run_for(Duration::from_secs(5 * 60)).await;
    let known: Vec<String> = w.history.calls().into_iter().map(|(_, k)| k).collect();
    assert_eq!(known, [code_n(0), code_n(0), code_n(1)]);
    assert_eq!(*w.jobs.lock().unwrap(), [code_n(1), code_n(1)]);
    assert_eq!(w.tracking.cursor(A), Some(code_n(1)));
    assert!(tracked(&w.store).contains(&(code_n(1), Status::Done)));
}

#[tokio::test(start_paused = true)]
async fn a_match_valve_refuses_is_passed() {
    let w = world();
    w.fail
        .lock()
        .unwrap()
        .insert(code_n(1), [ResolveError::Expired.to_string()].into());
    w.history.script(
        A,
        vec![Ok(Next::Code(code_n(1))), Ok(Next::Code(code_n(2)))],
    );
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(10)).await;
    assert_eq!(*w.jobs.lock().unwrap(), [code_n(1), code_n(2)]);
    assert_eq!(w.tracking.cursor(A), Some(code_n(2)));
}

#[tokio::test(start_paused = true)]
async fn a_match_that_keeps_failing_is_passed_after_eight_tries() {
    let w = world();
    w.fail.lock().unwrap().insert(
        code_n(1),
        vec!["download failed: connection reset".to_owned(); 20].into(),
    );
    let mut script: Vec<_> = (0..8).map(|_| Ok(Next::Code(code_n(1)))).collect();
    script.push(Ok(Next::Code(code_n(2))));
    w.history.script(A, script);
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(6 * 3600)).await;
    let jobs = w.jobs.lock().unwrap().clone();
    assert_eq!(
        jobs.iter().filter(|c| **c == code_n(1)).count(),
        8,
        "{jobs:?}"
    );
    assert_eq!(w.tracking.cursor(A), Some(code_n(2)));
}

#[tokio::test(start_paused = true)]
async fn a_link_is_checked_at_once() {
    let w = world();
    run_for(Duration::from_secs(60)).await;
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(2)).await;
    assert_eq!(w.history.calls().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_given_tokens_own_match_is_fetched() {
    let w = world();
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracker.queue_token(A, code_n(0));
    w.tracker.poke();
    run_for(Duration::from_secs(5)).await;
    assert_eq!(tracked(&w.store), [(code_n(0), Status::Done)]);
}

#[tokio::test(start_paused = true)]
async fn a_match_two_trackers_played_is_stored_once() {
    let w = world();
    w.history.script(A, vec![Ok(Next::Code(code_n(1)))]);
    w.history.script(B, vec![Ok(Next::Code(code_n(1)))]);
    w.tracking.link(A, &auth(), &code_n(0)).unwrap();
    w.tracking.link(B, &auth(), &code_n(0)).unwrap();
    w.tracker.poke();
    run_for(Duration::from_secs(10)).await;
    assert_eq!(tracked(&w.store), [(code_n(1), Status::Done)]);
    assert_eq!(w.jobs.lock().unwrap().len(), 1);
    assert_eq!(w.tracking.cursor(A), Some(code_n(1)));
    assert_eq!(w.tracking.cursor(B), Some(code_n(1)));
}

#[tokio::test]
async fn a_restart_resumes_from_the_stored_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    {
        let t = Tracking::open(&data, Some(Key::from_hex(KEY).unwrap())).unwrap();
        t.link(A, &auth(), &code_n(0)).unwrap();
        assert!(t.advance(A, &code_n(0), &code_n(7)).unwrap());
    }
    let w = world_in(dir);
    w.tracker.poke();
    for _ in 0..100 {
        if !w.history.calls().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(w.history.calls().first(), Some(&(A, code_n(7))));
    let _ = Path::new("");
}

// ---- the tracking API ----------------------------------------------------------------------

mod api {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::extract::connect_info::MockConnectInfo;
    use axum::http::{header, Request, StatusCode};
    use axum::Router;
    use demoviewer_server::app::build_app_with_history;
    use demoviewer_server::auth::SESSION_COOKIE;
    use demoviewer_server::ratelimit::RateLimiter;
    use demoviewer_server::sessions::Sessions;
    use serde_json::{json, Value};
    use std::net::SocketAddr;
    use tower::ServiceExt;
    use url::Url;

    struct Site {
        _dir: tempfile::TempDir,
        data: std::path::PathBuf,
        app: Router,
        history: Arc<FakeHistory>,
        session: String,
    }

    async fn site() -> Site {
        site_with(Config::default().lookups_per_hour).await
    }

    async fn site_with(lookups_per_hour: u32) -> Site {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        // Made before the app opens the sessions file.
        let session = Sessions::open(&data).unwrap().create(A);
        let cfg = Arc::new(Config {
            data_dir: data.clone(),
            public_url: Some(Url::parse("https://skunk.club/").unwrap()),
            tracking_key: Some(Key::from_hex(KEY).unwrap()),
            lookups_per_hour,
            ..Config::default()
        });
        let store = Arc::new(Store::open(&cfg).unwrap());
        let (jobs, rx) = Jobs::channel();
        settle(store.clone(), rx, Failures::default());
        let history = Arc::new(FakeHistory::default());
        let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
        let app = build_app_with_history(
            cfg,
            store,
            jobs,
            limiter,
            None,
            Some(history.clone() as Arc<dyn MatchHistory>),
        )
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 40000))));
        Site {
            _dir: dir,
            data,
            app,
            history,
            session,
        }
    }

    async fn post(
        s: &Site,
        body: Value,
        session: Option<&str>,
        origin: &str,
    ) -> (StatusCode, Value) {
        let mut req = Request::post("/api/me/tracking")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ORIGIN, origin);
        if let Some(t) = session {
            req = req.header(header::COOKIE, format!("{SESSION_COOKIE}={t}"));
        }
        let res = s
            .app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn link_body(token: &str) -> Value {
        json!({"authCode": "abcd-efghi-jklm", "token": token})
    }

    #[tokio::test]
    async fn a_good_code_and_token_start_tracking() {
        let s = site().await;
        s.history.script(A, vec![Ok(Next::Code(code_n(1)))]);
        let (status, v) = post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(
            (status, &v),
            (StatusCode::ACCEPTED, &json!({"tracking": "on"}))
        );
        let t = Tracking::open(&s.data, Some(Key::from_hex(KEY).unwrap())).unwrap();
        assert_eq!(t.state(A), TrackingState::On);
        assert_eq!(t.cursor(A), Some(code_n(0)));
    }

    #[tokio::test]
    async fn a_wrong_code_names_the_code_field_with_steams_403() {
        let s = site().await;
        s.history.script(A, vec![Err(HistoryError::WrongCode)]);
        let (status, v) = post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            v,
            json!({
                "field": "authCode",
                "error": "Steam rejected this code (403). Open the support page again, press Create Authentication Code and paste the new one.",
            })
        );
    }

    #[tokio::test]
    async fn a_bad_token_names_the_token_field_with_steams_412() {
        let s = site().await;
        s.history.script(A, vec![Err(HistoryError::BadToken)]);
        let (status, v) = post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(v["field"], "token");
        assert_eq!(v["error"], "Steam rejected this match token (412). Copy Your most recently completed match token from the same page again.");
        // Shapes are checked before Steam is asked.
        let calls = s.history.calls().len();
        let (status, v) = post(
            &s,
            json!({"authCode": "nope", "token": code_n(0)}),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(
            (status, v["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some("authCode"))
        );
        assert_eq!(
            v["error"],
            "That is not an authentication code (ABCD-EFGHI-JKLM)."
        );
        let (_, v) = post(
            &s,
            link_body("not a token"),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(
            v["error"],
            "That is not a match token (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)."
        );
        assert_eq!(s.history.calls().len(), calls);
    }

    #[tokio::test]
    async fn an_older_token_is_checked_and_becomes_the_start() {
        let s = site().await;
        s.history
            .script(A, vec![Ok(Next::Latest), Err(HistoryError::BadToken)]);
        let body =
            json!({"authCode": "ABCD-EFGHI-JKLM", "token": code_n(9), "olderToken": code_n(3)});
        let (status, v) = post(&s, body.clone(), Some(&s.session), "https://skunk.club").await;
        assert_eq!(
            (status, v["field"].as_str()),
            (StatusCode::BAD_REQUEST, Some("olderToken"))
        );
        assert_eq!(v["error"], "Steam does not know this match token (412). Copy it again from the match in CS2's match list.");
        s.history
            .script(A, vec![Ok(Next::Latest), Ok(Next::Code(code_n(4)))]);
        let (status, _) = post(&s, body, Some(&s.session), "https://skunk.club").await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let t = Tracking::open(&s.data, Some(Key::from_hex(KEY).unwrap())).unwrap();
        assert_eq!(t.cursor(A), Some(code_n(3)));
    }

    /// Each Steam call a link makes counts against the client's lookups, as a profile lookup
    /// does: one account cannot fill the Steam gate for everyone, or queue fetches at will.
    #[tokio::test]
    async fn links_count_against_the_clients_lookups() {
        let s = site_with(3).await;
        for n in 0..3 {
            let (status, _) = post(
                &s,
                link_body(&code_n(n)),
                Some(&s.session),
                "https://skunk.club",
            )
            .await;
            assert_eq!(status, StatusCode::ACCEPTED, "link {n}");
        }
        let (status, v) = post(
            &s,
            link_body(&code_n(9)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
        let t = Tracking::open(&s.data, Some(Key::from_hex(KEY).unwrap())).unwrap();
        assert_eq!(
            t.cursor(A),
            Some(code_n(2)),
            "the refused link changed nothing"
        );
    }

    #[tokio::test]
    async fn validating_costs_at_most_two_steam_calls() {
        let s = site().await;
        let body =
            json!({"authCode": "ABCD-EFGHI-JKLM", "token": code_n(9), "olderToken": code_n(3)});
        let (status, _) = post(&s, body, Some(&s.session), "https://skunk.club").await;
        assert_eq!(status, StatusCode::ACCEPTED);
        let calls = s.history.calls();
        assert_eq!(calls, [(A, code_n(9)), (A, code_n(3))]);
    }

    #[tokio::test]
    async fn stop_tracking_deletes_the_code_before_answering() {
        let s = site().await;
        post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        let req = Request::delete("/api/me/tracking")
            .header(header::ORIGIN, "https://skunk.club")
            .header(header::COOKIE, format!("{SESSION_COOKIE}={}", s.session))
            .body(Body::empty())
            .unwrap();
        let res = s.app.clone().oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let file = std::fs::read_to_string(s.data.join("tracking.json")).unwrap();
        assert!(!file.contains("\"nonce\""), "{file}");
    }

    #[tokio::test]
    async fn tracking_needs_a_session_and_our_origin() {
        let s = site().await;
        let (status, _) = post(&s, link_body(&code_n(0)), None, "https://skunk.club").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://evil.example",
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert!(s.history.calls().is_empty());
    }

    #[tokio::test]
    async fn the_profile_says_tracking_on() {
        let s = site().await;
        post(
            &s,
            link_body(&code_n(0)),
            Some(&s.session),
            "https://skunk.club",
        )
        .await;
        let res = s
            .app
            .clone()
            .oneshot(
                Request::get(format!("/api/players/{A}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let v: Value =
            serde_json::from_slice(&to_bytes(res.into_body(), usize::MAX).await.unwrap()).unwrap();
        assert_eq!(v["tracking"], "on");
    }
}
