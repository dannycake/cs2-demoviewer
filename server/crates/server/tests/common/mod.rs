//! Helpers shared by the API, job runner, share-code, page, SEO, tracker and FACEIT poller
//! tests.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use axum::body::{to_bytes, Body};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use demoviewer_pack::{Match, MatchHeader, RoundInfo, RoundTracks, PACK_VERSION};
use demoviewer_server::app::build_app;
use demoviewer_server::config::Config;
use demoviewer_server::gcbot::{BoxFuture, ResolveError, Resolved, Resolver};
use demoviewer_server::jobs::{Job, Jobs};
use demoviewer_server::matches::{MatchSummary, SummaryPlayer};
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::sharecode::encode;
use demoviewer_server::store::{DemoRecord, Status, Store};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

/// Deterministic incompressible bytes.
pub fn payload(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 8);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

/// Bytes with a CS2 demo header laid out like a whole demo's (the file info offset 18 bytes
/// before the end): they pass `decompress_to_dem_within` and the runner's truncation check, not
/// the real parser. Bytes from 16 on are free for tests to vary.
pub fn fake_demo(len: usize) -> Vec<u8> {
    let mut v = b"PBDEMS2\0".to_vec();
    v.extend(u32::try_from(len - 18).unwrap().to_le_bytes());
    v.extend(u32::try_from(len - 23).unwrap().to_le_bytes());
    v.extend(payload(len - v.len()));
    v
}

pub fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A valid one-round match with no players.
pub fn tiny_match(map: &str) -> Match {
    Match {
        header: MatchHeader {
            version: PACK_VERSION,
            map: map.into(),
            server_name: "test".into(),
            game_build: "0".into(),
            tick_rate: 64,
            sample_hz: 32,
            tick_step: 2,
            players: vec![],
            rounds: vec![RoundInfo {
                number: 1,
                start_tick: 100,
                freeze_end_tick: 200,
                end_tick: 300,
                winner: 2,
                reason: "t_win".into(),
                score_t: 1,
                score_ct: 0,
                samples: 101,
                post_end_tick: None,
            }],
            weapons: vec!["none".into()],
        },
        rounds: vec![RoundTracks::default()],
        events: vec![],
        grenades: vec![],
        inventory: vec![],
        map_entities: vec![],
        map_changes: vec![],
        ground: vec![],
    }
}

/// Polls until the record is `Done` or `Error` (20 s at most).
pub async fn wait_until_finished(store: &Store, id: &str) -> DemoRecord {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(r) = store.get(id) {
            if matches!(r.status, Status::Done | Status::Error) {
                return r;
            }
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {id}: {:?}",
            store.get(id)
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Per fetch, by its key (a share code as [`encode`] writes it, a URL as it prints), the errors
/// its next fetches end with, one each: what [`settle`] fails them with.
pub type Failures = Arc<Mutex<HashMap<String, VecDeque<String>>>>;

/// A stub job runner for the trackers' tests: each share-code or URL job's record goes `Done`
/// a second later, with a pack on disk as the runner leaves it, or `Error` with the next of
/// `fail`'s errors for its key. Other jobs are dropped. Returns the keys of the jobs it got, in
/// order, and the most it had in flight at once.
pub fn settle(
    store: Arc<Store>,
    mut rx: tokio::sync::mpsc::UnboundedReceiver<Job>,
    fail: Failures,
) -> (Arc<Mutex<Vec<String>>>, Arc<AtomicUsize>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let most = Arc::new(AtomicUsize::new(0));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let (seen2, most2) = (seen.clone(), most.clone());
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            let (demo_id, key) = match job {
                Job::ShareCode { demo_id, code, .. } => (demo_id, encode(&code)),
                Job::Url { demo_id, url, .. } => (demo_id, url.to_string()),
                _ => continue,
            };
            seen2.lock().unwrap().push(key.clone());
            let error = fail
                .lock()
                .unwrap()
                .get_mut(&key)
                .and_then(VecDeque::pop_front);
            let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            most2.fetch_max(now, Ordering::SeqCst);
            let (store, in_flight) = (store.clone(), in_flight.clone());
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(1)).await;
                if let Some(error) = error {
                    store.update(&demo_id, |r| {
                        r.status = Status::Error;
                        r.error = Some(error);
                    });
                    in_flight.fetch_sub(1, Ordering::SeqCst);
                    return;
                }
                // Done as the runner leaves it: a pack on disk (what counts a match as held).
                let sha = demoviewer_server::store::hex(demo_id.as_bytes())
                    .chars()
                    .chain(std::iter::repeat('0'))
                    .take(64)
                    .collect::<String>();
                std::fs::write(store.pack_path(&sha), b"pack").unwrap();
                store.update(&demo_id, |r| {
                    r.status = Status::Done;
                    r.sha256 = Some(sha);
                });
                in_flight.fetch_sub(1, Ordering::SeqCst);
            });
        }
    });
    (seen, most)
}

type Answer = Box<dyn Fn(&str) -> Result<Resolved, ResolveError> + Send + Sync>;

/// A share-code resolver that answers every code with its `answer`, counting the lookups and
/// how many ran at once. A `held` one keeps every lookup waiting until [`FakeResolver::release`];
/// a `slow` one takes its delay over each. It is online until told otherwise.
pub struct FakeResolver {
    answer: Answer,
    delay: Duration,
    /// Closed once released: lookups wait for a permit that never comes until then.
    gate: tokio::sync::Semaphore,
    online: AtomicBool,
    calls: AtomicUsize,
    running: AtomicUsize,
    most: AtomicUsize,
}

impl FakeResolver {
    fn build(
        delay: Duration,
        held: bool,
        answer: impl Fn(&str) -> Result<Resolved, ResolveError> + Send + Sync + 'static,
    ) -> Arc<FakeResolver> {
        let fake = FakeResolver {
            answer: Box::new(answer),
            delay,
            gate: tokio::sync::Semaphore::new(0),
            online: AtomicBool::new(true),
            calls: AtomicUsize::new(0),
            running: AtomicUsize::new(0),
            most: AtomicUsize::new(0),
        };
        if !held {
            fake.release();
        }
        Arc::new(fake)
    }

    pub fn answering(
        answer: impl Fn(&str) -> Result<Resolved, ResolveError> + Send + Sync + 'static,
    ) -> Arc<FakeResolver> {
        FakeResolver::build(Duration::ZERO, false, answer)
    }

    pub fn held(
        answer: impl Fn(&str) -> Result<Resolved, ResolveError> + Send + Sync + 'static,
    ) -> Arc<FakeResolver> {
        FakeResolver::build(Duration::ZERO, true, answer)
    }

    pub fn slow(
        delay: Duration,
        answer: impl Fn(&str) -> Result<Resolved, ResolveError> + Send + Sync + 'static,
    ) -> Arc<FakeResolver> {
        FakeResolver::build(delay, false, answer)
    }

    /// Lets every held lookup, and every later one, answer.
    pub fn release(&self) {
        self.gate.close();
    }

    pub fn set_online(&self, online: bool) {
        self.online.store(online, Ordering::SeqCst);
    }

    /// Lookups asked so far.
    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    /// The most lookups that were running at once.
    pub fn most_at_once(&self) -> usize {
        self.most.load(Ordering::SeqCst)
    }
}

impl Resolver for FakeResolver {
    fn resolve(&self, code: &str) -> BoxFuture<'_, Result<Resolved, ResolveError>> {
        let code = code.to_owned();
        Box::pin(async move {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
            self.most.fetch_max(now, Ordering::SeqCst);
            // An error: the gate is closed, so the lookup may answer.
            let _ = self.gate.acquire().await;
            tokio::time::sleep(self.delay).await;
            self.running.fetch_sub(1, Ordering::SeqCst);
            (self.answer)(&code)
        })
    }

    fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
}

/// A runtime on this thread with one blocking thread, for [`drop_at`].
pub fn one_blocking_thread() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap()
}

/// Runs `fut` on a runtime from [`one_blocking_thread`] as a request whose client goes away:
/// drops it when it waits for the `k`th time (from 1), before the blocking work it waits on has
/// begun, then returns once that work has ended and its result has been dropped unread. A gate
/// holds the one blocking thread at each poll, so whatever the poll hands the blocking pool waits
/// behind it; `gated` runs after the drop with the gate still shut. Returns `fut`'s output
/// instead when it finishes before waiting `k` times.
pub async fn drop_at<F: Future>(fut: F, k: usize, gated: impl FnOnce()) -> Option<F::Output> {
    let mut fut = Box::pin(fut);
    let woken = Arc::new(Woken::default());
    let waker = Waker::from(woken.clone());
    for waits in 1.. {
        let (open, shut) = std::sync::mpsc::channel::<()>();
        let gate = tokio::task::spawn_blocking(move || {
            let _ = shut.recv();
        });
        let polled = fut.as_mut().poll(&mut Context::from_waker(&waker));
        if let Poll::Ready(out) = polled {
            drop(open);
            gate.await.unwrap();
            return Some(out);
        }
        if waits == k {
            drop(fut);
            gated();
            drop(open);
            gate.await.unwrap();
            // The one blocking thread takes its queue in order, so this runs after what the
            // dropped future left there, whose results are dropped as each ends.
            tokio::task::spawn_blocking(|| ()).await.unwrap();
            return None;
        }
        drop(open);
        gate.await.unwrap();
        woken.0.notified().await;
    }
    unreachable!()
}

/// A waker that lets [`drop_at`] wait for its future to be woken.
#[derive(Default)]
struct Woken(tokio::sync::Notify);

impl Wake for Woken {
    fn wake(self: Arc<Self>) {
        self.0.notify_one();
    }
}

/// The web app's page, shaped like the build's.
pub const PAGE: &str = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    \
<title>skunk.club</title>\n    <script type=\"module\" crossorigin src=\"/assets/index-abc.js\"></script>\n  \
</head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n";

/// 2025-10-22 20:00 UTC and 2025-10-24 10:00 UTC.
pub const PLAYED: u64 = 1_761_163_200;
pub const CREATED: u64 = 1_761_300_000;

pub const NAMES: [&str; 11] = [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliett",
    "kilo",
];

pub struct Server {
    pub dir: TempDir,
    pub store: Arc<Store>,
    pub app: Router,
}

/// A server with `index.html` in its web dir and `https://skunk.club/` as its public URL.
pub fn site(cfg: impl FnOnce(Config) -> Config) -> Server {
    site_before(cfg, |_| ())
}

/// [`site`], with `before` run on the data dir (made first) ahead of the server's start.
pub fn site_before(
    cfg: impl FnOnce(Config) -> Config,
    before: impl FnOnce(&std::path::Path),
) -> Server {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    before(&dir.path().join("data"));
    std::fs::create_dir_all(dir.path().join("web")).unwrap();
    std::fs::write(dir.path().join("web/index.html"), PAGE).unwrap();
    let cfg = Arc::new(cfg(Config {
        data_dir: dir.path().join("data"),
        assets_dir: dir.path().join("assets"),
        web_dir: dir.path().join("web"),
        public_url: Some(Url::parse("https://skunk.club/").unwrap()),
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
pub fn summary(sha: &str) -> MatchSummary {
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
                ..SummaryPlayer::default()
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
        ..MatchSummary::default()
    }
}

pub fn sha(tag: u8) -> String {
    format!("{tag:02x}").repeat(32)
}

/// A new demo id in `status` for the pack `sha`, whose summary (if any) is indexed.
pub fn demo(store: &Store, status: Status, sha: &str, summary: Option<MatchSummary>) -> String {
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

pub fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

pub async fn call(app: &Router, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(get(uri)).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

pub async fn page(app: &Router, uri: &str) -> String {
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
pub fn meta(html: &str, key: &str) -> Option<String> {
    ["property", "name"].iter().find_map(|attr| {
        let start = format!("<meta {attr}=\"{key}\" content=\"");
        let at = html.find(&start)? + start.len();
        Some(html[at..at + html[at..].find('"')?].to_owned())
    })
}

/// The `content` of the `<meta property=…>` called `key`.
pub fn property(html: &str, key: &str) -> Option<String> {
    let start = format!("<meta property=\"{key}\" content=\"");
    let at = html.find(&start)? + start.len();
    Some(html[at..at + html[at..].find('"')?].to_owned())
}

/// The `href` of the `<link rel=…>` called `rel`.
pub fn link_rel(html: &str, rel: &str) -> Option<String> {
    let start = format!("<link rel=\"{rel}\" href=\"");
    let at = html.find(&start)? + start.len();
    Some(html[at..at + html[at..].find('"')?].to_owned())
}

/// The `(type, href)` of every `<link rel=…>` called `rel`, in page order.
pub fn link_rels(html: &str, rel: &str) -> Vec<(String, String)> {
    let start = format!("<link rel=\"{rel}\" ");
    let attr = |tag: &str, name: &str| {
        let key = format!(" {name}=\"");
        let at = tag.find(&key)? + key.len();
        Some(tag[at..at + tag[at..].find('"')?].to_owned())
    };
    html.match_indices(&start)
        .filter_map(|(at, _)| {
            let tag = &html[at..at + html[at..].find('>')?];
            Some((attr(tag, "type")?, attr(tag, "href")?))
        })
        .collect()
}

/// What `html` carries for crawlers: the content of `<div id="pre">`, which must come just
/// after the app's empty root (the app mounts in the root and draws its frame over the body).
/// The body has no `div` of its own, so the first `</div>` closes it.
pub fn pre_body(html: &str) -> &str {
    const OPEN: &str = "<div id=\"root\"></div><div id=\"pre\">";
    let start = html
        .find(OPEN)
        .expect("the pre-rendered body just after the empty root")
        + OPEN.len();
    let end = start + html[start..].find("</div>").expect("the body closes");
    let body = &html[start..end];
    assert!(!body.contains("<div"), "{body}");
    body
}

/// Every `<script type="application/ld+json">` block of `html`, parsed.
pub fn json_ld(html: &str) -> Vec<serde_json::Value> {
    let (open, close) = (r#"<script type="application/ld+json">"#, "</script>");
    let mut found = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find(open) {
        rest = &rest[at + open.len()..];
        let end = rest.find(close).expect("the block ends");
        found.push(serde_json::from_str(&rest[..end]).expect("the block is JSON"));
        rest = &rest[end..];
    }
    found
}
