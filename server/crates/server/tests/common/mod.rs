//! Helpers shared by the API, job runner and share-code tests.
#![allow(dead_code)]

use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::task::{Context, Poll, Wake, Waker};
use std::time::{Duration, Instant};

use demoviewer_pack::{Match, MatchHeader, RoundInfo, RoundTracks, PACK_VERSION};
use demoviewer_server::gcbot::{BoxFuture, ResolveError, Resolved, Resolver};
use demoviewer_server::store::{DemoRecord, Status, Store};
use sha2::{Digest, Sha256};

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
