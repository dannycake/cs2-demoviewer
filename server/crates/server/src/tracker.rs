//! The tracker: one task for every tracked player. It takes the player due longest
//! ([`Tracking::due`]) and walks their match history from their cursor
//! ([`MatchHistory::next_code`]) until Steam says the latest. Each new match is claimed as a
//! `Source::Tracked` record and fetched as a share code by the job runner, like any other; the
//! tracker waits for it to finish before it asks Steam for the next, so it holds at most one
//! lookup and one download at a time, behind users (the runner's share-code lookups are shared
//! with theirs). Then the player is due again in [`CHECK_EVERY`]. A refused code or token stops
//! their tracking (the code is deleted); Steam not answering backs that player off, doubling up
//! to [`MAX_BACKOFF`]. A match that could not be fetched (gcbot offline, a failed download) keeps
//! the cursor before it and backs the player off the same way, so it is asked for again, up to
//! [`MAX_FETCH_TRIES`] times; one Valve refuses (no replay any more, no such match) is passed.
//! A walk ends as soon as the player stops or links again: it checks before every Steam call,
//! and moves the cursor only from where it started. A restart resumes from each player's stored
//! cursor.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::gcbot::ResolveError;
use crate::history::{HistoryError, MatchHistory, Next};
use crate::jobs::{Job, Jobs};
use crate::sharecode;
use crate::steam::STEAM_RATE_PAUSE;
use crate::store::{Source, Status, Store};
use crate::tracking::Tracking;

/// How often a tracked player's history is looked at.
pub const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// How often a match being fetched is looked at, until it is done or failed.
pub const SETTLE_POLL: Duration = Duration::from_secs(2);
/// The longest a player whose history Steam does not answer waits before the next try.
pub const MAX_BACKOFF: Duration = Duration::from_secs(2 * 3600);
/// The first wait after Steam did not answer.
const FIRST_BACKOFF: Duration = Duration::from_secs(60);
/// How long the tracker sleeps when nobody is due, unless woken.
const IDLE: Duration = Duration::from_secs(30);
/// How many times a tracked match that fails to fetch is tried before the walk goes past it.
pub const MAX_FETCH_TRIES: u32 = 8;

/// What became of a match the tracker fetched.
#[derive(PartialEq, Eq)]
enum Fetched {
    /// Stored (or the site has it, or it is gone from the store).
    Kept,
    /// Valve refused it: trying again cannot help.
    Refused,
    /// It failed on the way (gcbot offline or busy, a download or a parse failed).
    Failed,
}

enum Wake {
    /// Look again now (a player linked).
    Poke,
    /// Fetch the match of a token a player gave (the history walks only past it).
    Token(u64, String),
}

/// What the rest of the server tells the tracker.
#[derive(Clone)]
pub struct TrackerHandle {
    tx: mpsc::UnboundedSender<Wake>,
}

impl TrackerHandle {
    /// Wakes the tracker now (after a link).
    pub fn poke(&self) {
        let _ = self.tx.send(Wake::Poke);
    }

    /// Fetches the match of share code `code`, a token `steamid` gave.
    pub fn queue_token(&self, steamid: u64, code: String) {
        let _ = self.tx.send(Wake::Token(steamid, code));
    }
}

/// Unix seconds by tokio's clock: the wall clock when the tracker started, plus the time since.
/// (Paused in tests, so its schedule is too.) The FACEIT poller keeps its schedule by one too.
pub(crate) struct Clock {
    unix: u64,
    at: Instant,
}

impl Clock {
    pub(crate) fn new() -> Clock {
        let unix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        Clock {
            unix,
            at: Instant::now(),
        }
    }

    pub(crate) fn now(&self) -> u64 {
        self.unix + self.at.elapsed().as_secs()
    }
}

struct Tracker {
    store: Arc<Store>,
    jobs: Jobs,
    tracking: Arc<Tracking>,
    history: Arc<dyn MatchHistory>,
    clock: Clock,
    backoff: HashMap<u64, Duration>,
    /// Per player, the match that failed to fetch and how many times it has.
    tries: HashMap<u64, (String, u32)>,
}

/// Starts the tracker on the current runtime.
pub fn spawn_tracker(
    store: Arc<Store>,
    jobs: Jobs,
    tracking: Arc<Tracking>,
    history: Arc<dyn MatchHistory>,
) -> TrackerHandle {
    let (tx, rx) = mpsc::unbounded_channel();
    let tracker = Tracker {
        store,
        jobs,
        tracking,
        history,
        clock: Clock::new(),
        backoff: HashMap::new(),
        tries: HashMap::new(),
    };
    tokio::spawn(tracker.run(rx));
    TrackerHandle { tx }
}

impl Tracker {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Wake>) {
        loop {
            while let Ok(wake) = rx.try_recv() {
                if let Wake::Token(steamid, code) = wake {
                    let _ = self.fetch(steamid, &code).await;
                }
            }
            if let Some(steamid) = self.tracking.due(self.clock.now()) {
                self.walk(steamid).await;
                continue;
            }
            tokio::select! {
                wake = rx.recv() => match wake {
                    Some(Wake::Token(steamid, code)) => {
                        let _ = self.fetch(steamid, &code).await;
                    }
                    Some(Wake::Poke) => {}
                    None => return,
                },
                () = tokio::time::sleep(IDLE) => {}
            }
        }
    }

    /// Walks `steamid`'s history from their cursor to the latest match.
    async fn walk(&mut self, steamid: u64) {
        let (Some(code), Some(mut cursor)) =
            (self.tracking.code(steamid), self.tracking.cursor(steamid))
        else {
            // Nothing to walk with: not due again until a new link.
            self.tracking.checked(steamid, u64::MAX);
            return;
        };
        loop {
            // Stopped or linked again since the last step: this walk is over (a new link is
            // due at once, and walks from its own cursor).
            if !self.tracking.still(steamid, &code, &cursor) {
                return;
            }
            let answer = self.history.next_code(steamid, &code, &cursor).await;
            if !self.tracking.still(steamid, &code, &cursor) {
                return;
            }
            match answer {
                Ok(Next::Code(next)) => {
                    if self.fetch(steamid, &next).await == Fetched::Failed
                        && self.try_again(steamid, &next)
                    {
                        // The cursor stays before it: Steam names the same match next time.
                        return self.back_off(steamid, "a tracked match could not be fetched");
                    }
                    self.tries.remove(&steamid);
                    match self.tracking.advance(steamid, &cursor, &next) {
                        Ok(true) => cursor = next,
                        Ok(false) => return,
                        Err(e) => {
                            tracing::error!(steamid, error = %e, "cannot keep a tracked player's place");
                            cursor = next;
                        }
                    }
                }
                Ok(Next::Latest) => {
                    self.backoff.remove(&steamid);
                    self.tracking
                        .checked(steamid, self.clock.now() + CHECK_EVERY.as_secs());
                    return;
                }
                Err(HistoryError::WrongCode) => return self.stop(steamid, "revoked"),
                Err(HistoryError::BadToken) => return self.stop(steamid, "token rejected"),
                Err(HistoryError::RateLimited) => {
                    // The Steam gate is paused; the same call waits its turn again.
                    tokio::time::sleep(STEAM_RATE_PAUSE).await;
                }
                Err(HistoryError::Unavailable) => {
                    return self.back_off(steamid, "Steam did not answer for a tracked player")
                }
            }
        }
    }

    /// Notes another failed fetch of `code` for `steamid`; whether it is worth another try
    /// ([`MAX_FETCH_TRIES`] in all).
    fn try_again(&mut self, steamid: u64, code: &str) -> bool {
        let tries = match self.tries.get(&steamid) {
            Some((c, n)) if c == code => n + 1,
            _ => 1,
        };
        if tries >= MAX_FETCH_TRIES {
            tracing::warn!(
                steamid,
                tries,
                "a tracked match failed every try; going past it"
            );
            self.tries.remove(&steamid);
            return false;
        }
        self.tries.insert(steamid, (code.to_owned(), tries));
        true
    }

    /// Looks at `steamid` again later, doubling the wait each time up to [`MAX_BACKOFF`].
    fn back_off(&mut self, steamid: u64, why: &str) {
        let wait = self
            .backoff
            .get(&steamid)
            .map_or(FIRST_BACKOFF, |b| (*b * 2).min(MAX_BACKOFF));
        self.backoff.insert(steamid, wait);
        tracing::warn!(steamid, wait = ?wait, "{why}");
        self.tracking
            .checked(steamid, self.clock.now() + wait.as_secs());
    }

    fn stop(&mut self, steamid: u64, reason: &str) {
        self.backoff.remove(&steamid);
        tracing::info!(steamid, reason, "tracking stopped");
        if let Err(e) = self.tracking.stop(steamid, reason) {
            tracing::error!(steamid, error = %e, "cannot stop tracking a player");
        }
    }

    /// Fetches the match of share code `code` as a tracked match (unless the site has it, or is
    /// fetching it) and waits until it is done or failed.
    async fn fetch(&self, steamid: u64, code: &str) -> Fetched {
        let Ok(decoded) = sharecode::decode(code) else {
            tracing::warn!(
                steamid,
                "a tracked player's history gave a share code that does not decode"
            );
            return Fetched::Refused;
        };
        let (rec, created) =
            self.store
                .claim_match_from(&decoded, &Store::new_id(), Source::Tracked);
        if created {
            self.jobs.enqueue(Job::ShareCode {
                demo_id: rec.id.clone(),
                code: decoded,
                slot: None,
            });
        }
        loop {
            let Some(rec) = self.store.get(&rec.id) else {
                return Fetched::Kept;
            };
            match rec.status {
                Status::Done => return Fetched::Kept,
                Status::Error => {
                    let refused = [ResolveError::Expired, ResolveError::NotFound]
                        .iter()
                        .any(|e| rec.error.as_deref() == Some(e.to_string().as_str()));
                    return if refused {
                        Fetched::Refused
                    } else {
                        Fetched::Failed
                    };
                }
                _ => tokio::time::sleep(SETTLE_POLL).await,
            }
        }
    }
}
