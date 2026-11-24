//! Share-code lookups. gcbot (`gcbot/`), logged in to Steam as the user's alt, asks Valve's Game
//! Coordinator for the match a share code names and answers with its replay URL, which the job
//! runner then ingests like a pasted one. [`GcbotClient`] speaks gcbot's HTTP API; any
//! [`Resolver`] will do for [`ShareCodes`], the lookups the runner makes.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde::Deserialize;
use url::Url;

use crate::http::read_capped;
use crate::ingest::is_replay_host;
use crate::sharecode::{self, ShareCode};

/// A boxed future that can move between threads.
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// What turns a share code into its match's replay URL.
pub trait Resolver: Send + Sync {
    /// Asks for the match `code` names.
    fn resolve(&self, code: &str) -> BoxFuture<'_, Result<Resolved, ResolveError>>;
    /// Whether lookups can be answered now: Steam and the Game Coordinator are both connected.
    fn online(&self) -> bool;
}

/// A share code's match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub match_id: u64,
    /// Valve's replay of the match (`http://replayN.valve.net/730/….dem.bz2`).
    pub url: Url,
    /// When the match was played, when Valve said.
    pub played_unix: Option<u64>,
    /// The Game Coordinator's whole match info as gcbot passed it on (64-bit numbers as
    /// strings); none from a gcbot from before it did.
    pub info: Option<serde_json::Value>,
}

/// The game type of the match (`reservation.game_type` of the last round that has one) in the
/// GC's match info.
pub fn gc_game_type(info: &serde_json::Value) -> Option<u32> {
    info.get("roundstatsall")?
        .as_array()?
        .iter()
        .rev()
        .find_map(|r| r.get("reservation")?.get("game_type")?.as_u64())
        .and_then(|t| u32::try_from(t).ok())
}

/// Why a lookup gave no replay URL. Its text is what the user is shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResolveError {
    /// Not a share code.
    Invalid,
    /// Valve knows the match but no longer has its replay.
    Expired,
    /// Valve has no match for the code (what a crosshair code gets).
    NotFound,
    /// gcbot, Steam or the Game Coordinator is down.
    Offline,
    /// Too many lookups are waiting: [`MAX_WAITING`] here, or gcbot's own queue is full.
    Busy,
    /// No answer in time.
    Timeout,
    /// An answer that is not a Valve replay link for this very code: its match, reservation id
    /// and TV port.
    BadAnswer,
}

impl fmt::Display for ResolveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            ResolveError::Invalid => {
                "That is not a match share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)"
            }
            ResolveError::Expired => {
                "Valve no longer has this match's replay (they keep them about a month)"
            }
            ResolveError::NotFound => {
                "Valve has no match for this code (crosshair codes look the same)"
            }
            ResolveError::Offline => {
                "The share-code service is offline right now: paste the replay URL or upload the demo instead"
            }
            ResolveError::Busy => {
                "Too many share codes are being looked up: try again in a minute"
            }
            ResolveError::Timeout => "Valve did not answer: try again in a minute",
            ResolveError::BadAnswer => "The share-code service returned an unexpected link",
        })
    }
}

impl std::error::Error for ResolveError {}

impl ResolveError {
    /// Valve's answer about the match itself, which asking again soon will not change.
    fn is_valves_refusal(self) -> bool {
        matches!(self, ResolveError::Expired | ResolveError::NotFound)
    }
}

/// How long Valve's refusal of a share code ([`ResolveError::Expired`],
/// [`ResolveError::NotFound`]) is remembered: posting the same code again in this time gets the
/// same answer without a lookup.
pub const FAILURE_TTL: Duration = Duration::from_secs(10 * 60);

/// How many lookups may wait for their turn behind the one in progress; one more is refused at
/// once as [`ResolveError::Busy`]. gcbot keeps a queue as long, but it is sent one lookup at a
/// time, so this is the queue that fills.
pub const MAX_WAITING: usize = 20;

/// The lookups the job runner makes: one at a time, at most [`MAX_WAITING`] waiting, none while
/// the resolver is offline, every answer checked, Valve's refusals remembered for
/// [`FAILURE_TTL`].
pub struct ShareCodes {
    resolver: Arc<dyn Resolver>,
    failure_ttl: Duration,
    /// Valve's refusals by the whole code, with when they came: a code that names a real match
    /// with another outcome id or token (a forgery) is refused for itself, not for the match.
    failures: Mutex<HashMap<ShareCode, (ResolveError, Instant)>>,
    /// Held by the lookup in progress; waiters queue in order.
    turn: tokio::sync::Mutex<()>,
    /// Lookups waiting for `turn`.
    waiting: AtomicUsize,
}

impl ShareCodes {
    pub fn new(resolver: Arc<dyn Resolver>) -> Self {
        ShareCodes::with_failure_ttl(resolver, FAILURE_TTL)
    }

    /// [`ShareCodes::new`] remembering refusals for `ttl` (tests).
    #[doc(hidden)]
    pub fn with_failure_ttl(resolver: Arc<dyn Resolver>, ttl: Duration) -> Self {
        ShareCodes {
            resolver,
            failure_ttl: ttl,
            failures: Mutex::default(),
            turn: tokio::sync::Mutex::new(()),
            waiting: AtomicUsize::new(0),
        }
    }

    /// Whether the share-code service can answer now.
    pub fn online(&self) -> bool {
        self.resolver.online()
    }

    /// Whether [`MAX_WAITING`] lookups are waiting, so the next is refused.
    pub fn busy(&self) -> bool {
        self.waiting.load(Ordering::SeqCst) >= MAX_WAITING
    }

    /// Valve's refusal of `code`, if one came in the last [`FAILURE_TTL`].
    pub fn failed(&self, code: &ShareCode) -> Option<ResolveError> {
        let failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
        failures
            .get(code)
            .filter(|(_, at)| at.elapsed() < self.failure_ttl)
            .map(|(e, _)| *e)
    }

    /// Looks `code` up (sent as [`sharecode::encode`] writes it), after any lookup in progress,
    /// and returns its replay when the answer is a Valve replay link
    /// (`http(s)://replayN.valve.net/730/<reservation id>_<TV port>.dem.bz2`) for this very
    /// code: the match it names, the reservation id its outcome id, the TV port's low 16 bits
    /// its token ([`ids_named_by`]). The match id alone is not enough: the Game Coordinator's
    /// late answer to an earlier lookup can reach gcbot's next one, and a code naming the same
    /// match with another outcome id and token, which anyone can write, would be handed the
    /// real code's replay (security review 2026-10-23). Fails at once while the resolver is
    /// offline, also after waiting for its turn, and when [`MAX_WAITING`] lookups are waiting
    /// already.
    pub async fn resolve(&self, code: &ShareCode) -> Result<Resolved, ResolveError> {
        let match_id = code.match_id;
        if !self.resolver.online() {
            return Err(ResolveError::Offline);
        }
        let place = Waiting::join(&self.waiting).ok_or(ResolveError::Busy)?;
        let _turn = self.turn.lock().await;
        drop(place);
        if !self.resolver.online() {
            return Err(ResolveError::Offline);
        }
        let answer = self.resolver.resolve(&sharecode::encode(code)).await.and_then(|r| {
            let valve = matches!(r.url.scheme(), "http" | "https")
                && r.url.host_str().is_some_and(is_replay_host);
            let ours = ids_named_by(&r.url) == Some((code.outcome_id, code.token));
            if valve && r.match_id == match_id && ours {
                Ok(r)
            } else {
                tracing::warn!(match_id, answered = r.match_id, url = %r.url, "share-code service answered with an unexpected link");
                Err(ResolveError::BadAnswer)
            }
        });
        if let Some(e) = answer.as_ref().err().filter(|e| e.is_valves_refusal()) {
            let mut failures = self.failures.lock().unwrap_or_else(PoisonError::into_inner);
            failures.retain(|_, (_, at)| at.elapsed() < self.failure_ttl);
            failures.insert(*code, (*e, Instant::now()));
        }
        answer
    }
}

/// The outcome id and token of the share code whose replay is at `url`
/// (`/730/<reservation id>_<TV port>.dem.bz2`, both numbers zero-padded in Valve's links): the
/// reservation id, and the TV port's low 16 bits. None for any other path.
fn ids_named_by(url: &Url) -> Option<(u64, u16)> {
    let mut path = url.path_segments()?;
    let (Some("730"), Some(name), None) = (path.next(), path.next(), path.next()) else {
        return None;
    };
    let (reservation, port) = name.strip_suffix(".dem.bz2")?.split_once('_')?;
    // `parse` would also take a sign.
    let number = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if !number(reservation) || !number(port) {
        return None;
    }
    let port: u32 = port.parse().ok()?;
    Some((reservation.parse().ok()?, port as u16))
}

/// A lookup's place among those waiting for their turn, given up when dropped: when the lookup
/// gets its turn, or is dropped while it waits.
struct Waiting<'a>(&'a AtomicUsize);

impl<'a> Waiting<'a> {
    /// Takes a place, unless all [`MAX_WAITING`] are taken.
    fn join(waiting: &'a AtomicUsize) -> Option<Waiting<'a>> {
        waiting
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < MAX_WAITING).then_some(n + 1)
            })
            .ok()
            .map(|_| Waiting(waiting))
    }
}

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// How often [`GcbotClient`] asks gcbot's `/health`; its [`Resolver::online`] answers from the
/// last answer.
pub const HEALTH_EVERY: Duration = Duration::from_secs(30);
/// How long a `/health` request may take.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
/// How long a lookup may take: [`ShareCodes`] sends gcbot one at a time, so none waits in its
/// queue, and gcbot answers within its own 20 s timeout, after at most a 10 s pause when the
/// previous lookup timed out; this is for a gcbot that hangs.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// gcbot's answers carry the GC's match info, about 10 KiB (more for a long match); anything
/// this big is not one.
const MAX_ANSWER: usize = 256 * 1024;

/// gcbot's HTTP API at `DEMOVIEWER_GCBOT_URL` (`http://gcbot:8097/` in the stack): `POST
/// /resolve` for lookups, `GET /health`, asked every [`HEALTH_EVERY`], for [`Resolver::online`].
/// A lookup's outcome also says whether gcbot is up: an answer means online, no connection or
/// gcbot's `offline` means offline until the next health check says otherwise.
pub struct GcbotClient {
    base: Url,
    http: reqwest::Client,
    online: AtomicBool,
}

/// `POST /resolve`'s answer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Answer {
    match_id: String,
    url: String,
    played_at: Option<u64>,
    #[serde(default)]
    info: Option<serde_json::Value>,
}

/// gcbot's error answer.
#[derive(Deserialize)]
struct Refusal {
    error: String,
}

/// `GET /health`'s answer, as far as it matters here.
#[derive(Deserialize)]
struct Health {
    steam: String,
    gc: bool,
}

impl GcbotClient {
    /// A client for gcbot at `base` (which ends in `/`), checking its health from now on, on the
    /// current tokio runtime, for as long as the client lives.
    pub fn new(base: Url) -> Arc<GcbotClient> {
        GcbotClient::with_timeout(base, REQUEST_TIMEOUT)
    }

    /// [`GcbotClient::new`] with lookups given `timeout` instead of [`REQUEST_TIMEOUT`] (tests).
    #[doc(hidden)]
    pub fn with_timeout(base: Url, timeout: Duration) -> Arc<GcbotClient> {
        let http = reqwest::Client::builder()
            // gcbot is on the stack network; a proxy in the environment must not be asked.
            .no_proxy()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(timeout)
            .user_agent(concat!("demoviewer/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("building the gcbot HTTP client");
        let client = Arc::new(GcbotClient {
            base,
            http,
            online: AtomicBool::new(false),
        });
        let weak = Arc::downgrade(&client);
        tokio::spawn(async move {
            while let Some(client) = weak.upgrade() {
                let online = client.healthy().await;
                if client.online.swap(online, Ordering::SeqCst) != online {
                    tracing::info!(online, "gcbot health changed");
                }
                drop(client);
                tokio::time::sleep(HEALTH_EVERY).await;
            }
        });
        client
    }

    /// Whether gcbot says Steam and the Game Coordinator are both connected.
    async fn healthy(&self) -> bool {
        let Ok(url) = self.base.join("health") else {
            return false;
        };
        let asked = async {
            let res = self
                .http
                .get(url)
                .timeout(HEALTH_TIMEOUT)
                .send()
                .await
                .ok()?;
            let body = read_capped(res, MAX_ANSWER).await.ok()??;
            serde_json::from_slice::<Health>(&body).ok()
        };
        asked.await.is_some_and(|h| h.steam == "online" && h.gc)
    }

    async fn ask(&self, code: &str) -> Result<Resolved, ResolveError> {
        let url = self
            .base
            .join("resolve")
            .map_err(|_| ResolveError::Offline)?;
        let body = serde_json::to_vec(&serde_json::json!({ "sharecode": code }))
            .map_err(|_| ResolveError::Invalid)?;
        let unreachable = |e: reqwest::Error| {
            if e.is_timeout() {
                ResolveError::Timeout
            } else {
                self.online.store(false, Ordering::SeqCst);
                ResolveError::Offline
            }
        };
        let res = self
            .http
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(unreachable)?;
        let status = res.status();
        let body = read_capped(res, MAX_ANSWER)
            .await
            .map_err(unreachable)?
            .ok_or(ResolveError::BadAnswer)?;
        if status.is_success() {
            let a: Answer = serde_json::from_slice(&body).map_err(|_| ResolveError::BadAnswer)?;
            self.online.store(true, Ordering::SeqCst);
            return Ok(Resolved {
                match_id: a.match_id.parse().map_err(|_| ResolveError::BadAnswer)?,
                url: Url::parse(&a.url).map_err(|_| ResolveError::BadAnswer)?,
                played_unix: a.played_at,
                info: a.info.filter(|i| !i.is_null()),
            });
        }
        let error = serde_json::from_slice::<Refusal>(&body).map(|r| r.error);
        Err(match error.as_deref() {
            Ok("invalid") => ResolveError::Invalid,
            Ok("expired") => ResolveError::Expired,
            Ok("not_found") => ResolveError::NotFound,
            Ok("busy") => ResolveError::Busy,
            Ok("timeout") => ResolveError::Timeout,
            Ok("offline") => {
                self.online.store(false, Ordering::SeqCst);
                ResolveError::Offline
            }
            // gcbot failed (`internal`), or something else answered.
            _ => {
                tracing::warn!(%status, "gcbot answered a lookup with an unknown error");
                ResolveError::Offline
            }
        })
    }
}

impl Resolver for GcbotClient {
    fn resolve(&self, code: &str) -> BoxFuture<'_, Result<Resolved, ResolveError>> {
        let code = code.to_owned();
        Box::pin(async move { self.ask(&code).await })
    }

    fn online(&self) -> bool {
        self.online.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_game_type_is_read_from_the_last_rounds_reservation() {
        let info = json!({"roundstatsall": [
            {"reservation": {"game_type": 1}},
            {"reservation": {"game_type": 8}},
            {"map": "x"},
        ]});
        assert_eq!(gc_game_type(&info), Some(8));
        assert_eq!(gc_game_type(&json!({"roundstatsall": []})), None);
        assert_eq!(gc_game_type(&json!({})), None);
        assert_eq!(
            gc_game_type(&json!({"roundstatsall": [{"reservation": {"game_type": "8"}}]})),
            None
        );
    }
}
