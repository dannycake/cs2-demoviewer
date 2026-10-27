//! Admission: whether a request may start an ingest (an upload start, a URL or a new share
//! code) or complete an upload, checked in one order for every path.
//!
//! The steps, in order:
//! 1. the client's attempts ([`Admission::attempt`], `Config::attempts_per_hour`, 429): every
//!    post counts, refused or not, before any disk or index work;
//! 2. room on the disk above `Config::min_free_bytes` for what the ingest could write
//!    ([`Attempt::room`], 507);
//! 3. a place: among the jobs on their way to the parse worker for a URL or share code
//!    ([`Room::fetch_place`]), or the declared size in the upload budget for an upload start
//!    ([`Room::upload_place`]) (429 when the client holds its share, 503 when everyone's is
//!    full);
//! 4. one of the client's ingests ([`Placed::ingest`], `Config::ingests_per_hour`, 429), last,
//!    so a refusal above spends none.
//!
//! Each step consumes the token the one before it returns, so no path can take them in another
//! order (code-health review 2026-10-26: each handler kept it by hand, and three of the four
//! ingest findings of the security audits of 2026-10-22 and 23 were about it). A path checks
//! the request itself between the steps where it needs to: a share code is read after the
//! attempt, and one the site has is answered there without spending an ingest; a URL is checked
//! after the room. The [`Ticket`] the last step returns gives the ingest back if it is dropped
//! before [`Ticket::commit`] (a share code another post claimed a moment before). An upload
//! start hands its place to the blocking task that makes the directory, which goes on when the
//! client goes away, so it takes the place with [`Ticket::commit_until_failed`] and gives the
//! ingest back only if that task fails, never because the request was dropped. An upload's
//! completion, whose start spent the attempt and the ingest, takes only the room and a place
//! among completed uploads ([`Admission::complete`]).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Instant;

use axum::http::StatusCode;

use crate::api::ApiError;
use crate::config::Config;
use crate::ratelimit::{bucket, RateLimiter};
use crate::store::{self, Store};
use crate::uploads::{Reservation, Uploads};

/// Completed uploads one client may have waiting for or going through the parse worker: two,
/// so someone can drop a second demo while the first parses. The second place is given only
/// while more than half the queue is free, so a newcomer finds a place unless three or more
/// clients are busy at once.
pub const QUEUED_UPLOADS_PER_CLIENT: usize = 2;

/// URL and share-code jobs one client may have on their way to the parse worker (being looked
/// up, waiting for a download place or downloading) at once.
pub const FETCHES_PER_CLIENT: usize = 3;

/// The limits a request is admitted under, and what they have counted.
pub struct Admission {
    store: Arc<Store>,
    attempts: RateLimiter,
    ingests: Arc<RateLimiter>,
    uploads: Arc<Uploads>,
    /// Completed uploads waiting for or going through the parse worker
    /// (`Config::max_queued_uploads`, [`QUEUED_UPLOADS_PER_CLIENT`]); a place travels with the
    /// job and is released when it ends (security review 2026-10-22).
    completed: Queue,
    /// URL and share-code jobs on their way to the parse worker (`Config::max_fetches`,
    /// [`FETCHES_PER_CLIENT`]): a place is taken before the job's record is made and held until
    /// its file reaches the parse worker or it fails, so jobs waiting for a download place are
    /// bounded (security audit 2026-10-23: they used to wait without bound, each with a record
    /// and a task).
    fetches: Queue,
}

impl Admission {
    /// `ingests` counts upload starts, URLs and new share codes per client; `uploads` holds the
    /// upload budget.
    pub fn new(
        cfg: &Config,
        store: Arc<Store>,
        ingests: Arc<RateLimiter>,
        uploads: Arc<Uploads>,
    ) -> Admission {
        Admission {
            store,
            attempts: RateLimiter::new(cfg.attempts_per_hour),
            ingests,
            uploads,
            completed: Queue::new(cfg.max_queued_uploads, QUEUED_UPLOADS_PER_CLIENT, true),
            fetches: Queue::new(cfg.max_fetches, FETCHES_PER_CLIENT, false),
        }
    }

    /// Step 1: one of the attempts of the client at `ip`.
    pub fn attempt(&self, ip: IpAddr) -> Result<Attempt<'_>, ApiError> {
        if !self.attempts.check(ip, Instant::now()) {
            return Err(too_many());
        }
        Ok(Attempt {
            admission: self,
            ip,
        })
    }

    /// For the completion of an upload by `client` (its rate-limit bucket) that may write `need`
    /// bytes: room on the disk, then a place among the completed uploads, which the job holds
    /// until it ends. Without one the upload stays as it is for the client to complete again
    /// (security audit 2026-10-22: completed uploads used to leave the upload budget and queue
    /// without bound).
    pub fn complete(&self, client: &str, need: u64) -> Result<QueueSlot, ApiError> {
        self.room(need)?;
        take(&self.completed, client, COMPLETED_FULL)
    }

    fn room(&self, need: u64) -> Result<(), ApiError> {
        if self.store.has_room(need) {
            Ok(())
        } else {
            Err(ApiError::new(
                StatusCode::INSUFFICIENT_STORAGE,
                store::LOW_DISK,
            ))
        }
    }
}

/// What a completion is refused with when the client holds its places among the completed
/// uploads (429), and when every place is taken (503).
const COMPLETED_FULL: [&str; 2] = [
    "your other demos are still being processed; try again when one is ready",
    "the server is busy with other demos; try completing the upload again in a minute",
];
/// What a URL or share code is refused with when the client holds its places among the jobs on
/// their way (429), and when every place is taken (503).
const FETCHES_FULL: [&str; 2] = [
    "your other demos are still being fetched; try again when one is ready",
    "the server is busy fetching other demos; try again in a few minutes",
];

/// A place in `queue` for `client`, or a refusal with `[yours, everyone]`.
fn take(queue: &Queue, client: &str, [yours, everyone]: [&str; 2]) -> Result<QueueSlot, ApiError> {
    queue.try_take(client).map_err(|why| match why {
        QueueFull::Yours => ApiError::new(StatusCode::TOO_MANY_REQUESTS, yours),
        QueueFull::Everyone => ApiError::new(StatusCode::SERVICE_UNAVAILABLE, everyone),
    })
}

fn too_many() -> ApiError {
    ApiError::new(
        StatusCode::TOO_MANY_REQUESTS,
        "too many demos from your address this hour; try again later",
    )
}

/// Step 1 passed: a counted attempt.
pub struct Attempt<'a> {
    admission: &'a Admission,
    ip: IpAddr,
}

impl<'a> Attempt<'a> {
    /// The client the attempt counts against, as places and uploads name it.
    pub fn client(&self) -> String {
        bucket(self.ip).to_string()
    }

    /// Step 2: room on the disk for `need` bytes above the floor (507).
    pub fn room(self, need: u64) -> Result<Room<'a>, ApiError> {
        self.admission.room(need)?;
        Ok(Room { attempt: self })
    }
}

/// Step 2 passed.
pub struct Room<'a> {
    attempt: Attempt<'a>,
}

impl<'a> Room<'a> {
    /// Step 3 for a URL or share code: a place among the jobs on their way to the parse worker
    /// (429 when the client holds its share, 503 when every place is taken).
    pub fn fetch_place(self) -> Result<Placed<'a, QueueSlot>, ApiError> {
        let fetches = &self.attempt.admission.fetches;
        let place = take(fetches, &self.attempt.client(), FETCHES_FULL)?;
        Ok(Placed {
            attempt: self.attempt,
            place,
        })
    }

    /// Step 3 for an upload start: `size` declared bytes for the upload `id` in the client's
    /// share and the budget ([`Uploads::reserve`]).
    pub fn upload_place(self, id: &str, size: u64) -> Result<Placed<'a, Reservation>, ApiError> {
        let client = self.attempt.client();
        let place = self.attempt.admission.uploads.reserve(id, &client, size)?;
        Ok(Placed {
            attempt: self.attempt,
            place,
        })
    }
}

/// Step 3 passed: the place `P`, given back if dropped.
pub struct Placed<'a, P> {
    attempt: Attempt<'a>,
    place: P,
}

impl<'a, P> Placed<'a, P> {
    /// Step 4: one of the client's ingests (429; the place is given back).
    pub fn ingest(self) -> Result<Ticket<'a, P>, ApiError> {
        let Attempt { admission, ip } = self.attempt;
        let at = Instant::now();
        if !admission.ingests.check(ip, at) {
            return Err(too_many());
        }
        Ok(Ticket {
            admission,
            ip,
            at,
            place: Some(self.place),
        })
    }
}

/// An admitted ingest: its place, and the ingest it spent, which is given back when the ticket
/// is dropped without [`Ticket::commit`].
pub struct Ticket<'a, P> {
    admission: &'a Admission,
    ip: IpAddr,
    at: Instant,
    place: Option<P>,
}

impl<'a, P> Ticket<'a, P> {
    /// The place, for the job to hold; the ingest stays spent.
    pub fn commit(mut self) -> P {
        self.place.take().expect("a ticket is committed once")
    }

    /// The place, for work that goes on without the request (a blocking task, which a client
    /// going away does not stop), and a [`Refund`] that gives the ingest back only when called,
    /// once that work has failed. Dropped with the request, it leaves the ingest spent, as the
    /// work may yet succeed (code-health review 2026-10-26: an upload start dropped while its
    /// directory was being made gave its ingest and its share of the budget back, and the
    /// directory was made all the same).
    pub fn commit_until_failed(mut self) -> (P, Refund<'a>) {
        let place = self.place.take().expect("a ticket is committed once");
        let refund = Refund {
            admission: self.admission,
            ip: self.ip,
            at: self.at,
        };
        (place, refund)
    }
}

impl<P> Drop for Ticket<'_, P> {
    fn drop(&mut self) {
        if self.place.is_some() {
            self.admission.ingests.refund(self.ip, self.at);
        }
    }
}

/// An ingest spent on work that may yet fail; see [`Ticket::commit_until_failed`].
pub struct Refund<'a> {
    admission: &'a Admission,
    ip: IpAddr,
    at: Instant,
}

impl Refund<'_> {
    /// Gives the ingest back: the work failed on the server's side.
    pub fn refund(self) {
        self.admission.ingests.refund(self.ip, self.at);
    }
}

/// Why a [`Queue`] found no place.
#[derive(Debug, PartialEq, Eq)]
pub enum QueueFull {
    /// The client already holds as many places as it may.
    Yours,
    /// Every place is taken.
    Everyone,
}

/// Places shared out per client: `places` in all, `per_client` each.
pub struct Queue {
    places: usize,
    per_client: usize,
    /// A client's places past its first are given only while more than half the queue is free.
    halves: bool,
    taken: Arc<Mutex<Taken>>,
}

#[derive(Debug, Default)]
struct Taken {
    total: usize,
    by_client: HashMap<String, usize>,
}

impl Queue {
    pub fn new(places: usize, per_client: usize, halves: bool) -> Queue {
        Queue {
            places: places.max(1),
            per_client: per_client.max(1),
            halves,
            taken: Arc::default(),
        }
    }

    /// A place for `client` (its rate-limit bucket), if it has places left and one is free.
    /// Looked for and taken under one lock, so two takes by one client at once cannot both
    /// read that it holds none (code-health review 2026-10-26).
    pub fn try_take(&self, client: &str) -> Result<QueueSlot, QueueFull> {
        let mut taken = self.taken.lock().unwrap_or_else(PoisonError::into_inner);
        let mine = taken.by_client.get(client).copied().unwrap_or(0);
        let busy = (self.places - taken.total) * 2 <= self.places;
        if mine >= self.per_client || (self.halves && mine > 0 && busy) {
            return Err(QueueFull::Yours);
        }
        if taken.total >= self.places {
            return Err(QueueFull::Everyone);
        }
        taken.total += 1;
        *taken.by_client.entry(client.to_owned()).or_insert(0) += 1;
        Ok(QueueSlot {
            taken: self.taken.clone(),
            client: client.to_owned(),
        })
    }
}

/// A job's place in a [`Queue`], given back when the job ends or is dropped.
#[derive(Debug)]
pub struct QueueSlot {
    taken: Arc<Mutex<Taken>>,
    client: String,
}

impl Drop for QueueSlot {
    fn drop(&mut self) {
        let mut taken = self.taken.lock().unwrap_or_else(PoisonError::into_inner);
        taken.total -= 1;
        if let Some(n) = taken.by_client.get_mut(&self.client) {
            *n -= 1;
            if *n == 0 {
                taken.by_client.remove(&self.client);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_client_holds_at_most_its_share_of_places() {
        let q = Queue::new(4, 2, false);
        let a1 = q.try_take("198.51.100.1").expect("a free place");
        let _a2 = q.try_take("198.51.100.1").expect("a second place");
        assert_eq!(q.try_take("198.51.100.1").unwrap_err(), QueueFull::Yours);
        let _b = q.try_take("198.51.100.2").expect("another client's place");
        let _c = q.try_take("198.51.100.3").expect("the last place");
        assert_eq!(q.try_take("198.51.100.4").unwrap_err(), QueueFull::Everyone);
        drop(a1);
        let _a3 = q.try_take("198.51.100.1").expect("a place given back");
        assert_eq!(q.try_take("198.51.100.1").unwrap_err(), QueueFull::Yours);
        assert!(
            Queue::new(0, 0, false).try_take("x").is_ok(),
            "a queue has a place, and a client may take one"
        );
    }

    #[test]
    fn a_second_place_is_given_only_while_more_than_half_the_queue_is_free() {
        let q = Queue::new(4, 2, true);
        let _a1 = q.try_take("a").unwrap();
        let _a2 = q.try_take("a").expect("3 of 4 free");
        let _b1 = q.try_take("b").unwrap();
        assert_eq!(
            q.try_take("b").unwrap_err(),
            QueueFull::Yours,
            "1 of 4 free"
        );
        let _c1 = q.try_take("c").expect("a first place, while one is free");
        assert_eq!(q.try_take("d").unwrap_err(), QueueFull::Everyone);
    }

    /// A client holding no place may take a second one only while more than half the queue is
    /// free, also when it completes two uploads at the same moment: both takes used to read
    /// that it held none, and both got a place (code-health review 2026-10-26).
    #[test]
    fn two_takes_at_once_by_one_client_get_one_place_when_the_queue_is_half_full() {
        let mut both = 0;
        for _ in 0..2000 {
            let queue = Queue::new(4, QUEUED_UPLOADS_PER_CLIENT, true);
            let _others = [
                queue.try_take("198.51.100.1").unwrap(),
                queue.try_take("198.51.100.2").unwrap(),
            ];
            let start = std::sync::Barrier::new(2);
            let taken = std::thread::scope(|s| {
                let take = || {
                    start.wait();
                    queue.try_take("198.51.100.3").ok()
                };
                let (a, b) = (s.spawn(take), s.spawn(take));
                [a.join().unwrap(), b.join().unwrap()]
            });
            match taken.iter().flatten().count() {
                1 => {}
                2 => both += 1,
                n => panic!("{n} places taken"),
            }
        }
        assert_eq!(both, 0, "rounds in which both takes got a place");
    }
}
