//! The FACEIT poller: one task for every tracked player ([`Tracking::tracked`]), on a schedule of
//! its own kept in each player's file ([`crate::faceit_history`]). It visits them in turn, each
//! once they are due: it finds who they are on FACEIT (their kept profile names the account
//! when it can, else FACEIT is asked by steamid), asks for their matches since the cursor (the
//! newest time one finished; the last [`FIRST_WINDOW`] the first time, at most
//! [`HISTORY_LIMIT`]) and for the detail of each match it has no row for (the map, the
//! players, where the demo is), and keeps a row for each. A match whose detail gave a demo URL
//! is never asked about again. FACEIT posts the URL a little after a match ends, so a match
//! seen before then (or whose detail FACEIT did not give) is asked about again on each later
//! look, [`MAX_FETCH_TRIES`] times in all, before its demo is unavailable.
//! Then it fetches the demo of each pending row, newest first: a record the site has for the
//! match already (a room link someone posted, a match another tracked player played) holds it
//! without a fetch; else, when the ingest may fetch FACEIT's URL, the match is claimed as a
//! `Source::Faceit` record ([`Store::claim_faceit`]) and downloaded by the job runner like a
//! posted URL, with no place in the fetch queue (as a tracked share code has none). The poller
//! waits for it to finish before the next, so it holds one download at a time, and starts at
//! most [`FETCHES_PER_LOOK`] in a look, so one player's backlog does not hold up the others
//! (the rest wait for the next look). A done demo is held; one FACEIT refused or no longer has
//! ([`ingest::is_refusal`]) is unavailable; one that failed on the way stays pending and is
//! tried again on the next look, up to [`MAX_FETCH_TRIES`] times. A URL the ingest may not
//! fetch (FACEIT's demo hosts are not on the allowlist until the spike names them) leaves its
//! row pending, claimed by nobody, until it may.
//!
//! Before the fetches, the attach pass holds each pending or unavailable row whose demo the site
//! has already, so it is never downloaded: a done record that answers for the match (a room link
//! someone posted, another tracked player's upload), else a done upload of it. An upload names
//! no match and a demo carries no time it was played, so an upload is a row's by its facts
//! ([`attaches`]): FACEIT's mode, the same map, the same score either way round and the same ten
//! players. It takes the match's FACEIT id ([`crate::jobs::attach_faceit`]), so it is under the
//! FACEIT tab and the room link finds it. An unavailable row is rescued so: only an upload
//! brings its demo.
//!
//! A player is due again [`CHECK_EVERY`] after a look. A look that failed (FACEIT gave no
//! answer, an error status, a 429 or an answer not understood; a demo failed on the way) backs
//! them off instead, doubling from a minute up to [`MAX_BACKOFF`]; what it kept stays kept.
//! FACEIT turning the key away (revoked, or never one) stops the poller, logged once; the files
//! stay as they are. A look ends as soon as the player stops tracking: it checks before every
//! FACEIT call and every fetch. A restart picks up each player's schedule, cursor and pending
//! demos from their file; a player whose file cannot be read is passed over until it can.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use tokio::task::JoinHandle;

use crate::faceit::{
    FaceitData, FaceitError, FaceitHistoryItem, FaceitMatchDetail, MAX_HISTORY_LIMIT,
};
use crate::faceit_history::{DemoState, FaceitEntry, FaceitHistory, FaceitMatch};
use crate::ingest;
use crate::jobs::{Job, Jobs};
use crate::matches::{GameMode, MatchSummary};
use crate::profile::TrackingState;
use crate::profiles::ProfileCache;
use crate::store::{Status, Store};
use crate::tracker::{Clock, MAX_FETCH_TRIES, SETTLE_POLL};
use crate::tracking::Tracking;

/// How often a tracked player's FACEIT history is looked at.
pub const CHECK_EVERY: Duration = Duration::from_secs(15 * 60);
/// The longest a player whose look failed waits before the next.
pub const MAX_BACKOFF: Duration = Duration::from_secs(2 * 3600);
/// The first wait after a look failed.
const FIRST_BACKOFF: Duration = Duration::from_secs(60);
/// How far back the first look at a player goes.
pub const FIRST_WINDOW: Duration = Duration::from_secs(30 * 24 * 3600);
/// The most matches one look asks FACEIT for: FACEIT's cap.
pub const HISTORY_LIMIT: u32 = MAX_HISTORY_LIMIT;
/// The most downloads one look at a player starts.
pub const FETCHES_PER_LOOK: usize = 3;
/// How long the poller sleeps when nobody is due.
const IDLE: Duration = Duration::from_secs(30);
/// The players of a FACEIT match, which an upload of it is told by: all ten.
const MATCH_PLAYERS: usize = 10;

/// Why a look at a player ended early.
enum Halt {
    /// FACEIT turned the key away: the poller stops.
    Revoked,
    /// The player stopped tracking.
    Untracked,
    /// FACEIT did not answer as it should (no answer, an error status, a 429, an answer not
    /// understood): the player is backed off.
    Unanswered(String),
    /// A demo failed on the way: the player is backed off.
    NotFetched(String),
}

impl From<FaceitError> for Halt {
    fn from(e: FaceitError) -> Halt {
        match e {
            FaceitError::Unauthorized => Halt::Revoked,
            e => Halt::Unanswered(e.to_string()),
        }
    }
}

/// What became of a pending row's demo in a look.
enum Fetched {
    /// The site has it: the demo id.
    Held(String),
    /// FACEIT's host refused it or no longer has it: trying again cannot help.
    Refused,
    /// Its URL is not one the ingest may fetch: nothing was claimed.
    OffList,
    /// FACEIT has given no URL for it yet: nothing was claimed.
    NoUrl,
    /// The look started its [`FETCHES_PER_LOOK`] downloads already: it waits for the next.
    Later,
    /// It failed on the way (a download cut off, a parse that failed, a busy server): why.
    Failed(String),
}

/// The poller's state: what it asks and writes, and what it keeps between looks.
struct Poller {
    /// The demo records, which it claims FACEIT matches in and watches fetches through.
    store: Arc<Store>,
    /// The job queue its downloads go to.
    jobs: Jobs,
    /// Who is tracked.
    tracking: Arc<Tracking>,
    /// The players' files.
    histories: Arc<FaceitHistory>,
    /// FACEIT's Data API (behind its own gate).
    data: Arc<dyn FaceitData>,
    /// The kept profiles, which may name a player's FACEIT account.
    profiles: Arc<ProfileCache>,
    /// Its schedule's clock.
    clock: Clock,
    /// Each player's file as last written, read on first sight: the poller is its only writer.
    entries: HashMap<u64, FaceitEntry>,
    /// The players whose file could not be read, warned about once until it can be.
    unreadable: HashSet<u64>,
}

/// Starts the FACEIT poller on the current runtime, asking FACEIT through `data` and keeping
/// the players' files in `histories`. It runs until FACEIT turns the key away.
pub fn spawn_faceit_tracker(
    store: Arc<Store>,
    jobs: Jobs,
    tracking: Arc<Tracking>,
    histories: Arc<FaceitHistory>,
    data: Arc<dyn FaceitData>,
    profiles: Arc<ProfileCache>,
) -> JoinHandle<()> {
    let poller = Poller {
        store,
        jobs,
        tracking,
        histories,
        data,
        profiles,
        clock: Clock::new(),
        entries: HashMap::new(),
        unreadable: HashSet::new(),
    };
    tokio::spawn(poller.run())
}

/// The wait after the `tries`th failed look in a row (from 1): a minute, doubling up to
/// [`MAX_BACKOFF`].
fn backoff(tries: u32) -> Duration {
    FIRST_BACKOFF
        .saturating_mul(1 << tries.saturating_sub(1).min(31))
        .min(MAX_BACKOFF)
}

/// The row of `item`, a match of a player's history, told in full by `detail` (`None` when
/// FACEIT gave none): the map, the players and the demo's URL from the detail (the history's
/// players without one), the score and the result from the history, the player's side first
/// (`None` when the history does not say which side was theirs). Its demo is pending. Without a
/// URL, the ask that made the row is its first of [`MAX_FETCH_TRIES`] for one.
fn row_of(item: FaceitHistoryItem, detail: Option<FaceitMatchDetail>) -> FaceitMatch {
    let (map, players, demo_url) = match detail {
        Some(d) => (
            d.map,
            if d.players.is_empty() {
                item.players
            } else {
                d.players
            },
            d.demo_urls.into_iter().next(),
        ),
        None => (None, item.players, None),
    };
    FaceitMatch {
        match_id: item.match_id,
        finished_unix: item.finished_unix,
        map,
        score: item.score,
        won: item.won,
        competition: item.competition,
        players,
        demo: DemoState::Pending,
        detail_tries: u32::from(demo_url.is_none()),
        demo_url,
        fetch_tries: 0,
    }
}

/// Whether `s`, the summary of a done demo, is of `row`'s match as far as a demo can tell: a
/// FACEIT match's (its mode) that names no FACEIT match yet, or names this one (an attach cut
/// short after the summary took the id, which the pass finishes), on the row's map, its sides' score
/// the row's either way round (a demo scores the side each team ended on, the row the player's
/// team first), and its players the row's ten, in any order. A row short of its map, its score or
/// one of its ten steamids takes none, and so does a demo whose players are not those ten exactly
/// (one more, one fewer or one other): the ten together are what tells a match from another of
/// the same map and score.
pub(crate) fn attaches(row: &FaceitMatch, s: &MatchSummary) -> bool {
    let (Some(map), Some([a, b])) = (&row.map, row.score) else {
        return false;
    };
    let other_match = s
        .faceit_match_id
        .as_ref()
        .is_some_and(|id| *id != row.match_id);
    if s.mode != Some(GameMode::Faceit) || other_match || *map != s.map {
        return false;
    }
    if (a, b) != (s.score_t, s.score_ct) && (a, b) != (s.score_ct, s.score_t) {
        return false;
    }
    let ten: HashSet<u64> = row.players.iter().copied().collect();
    let theirs: Option<HashSet<u64>> = s.players.iter().map(|p| p.steamid.parse().ok()).collect();
    row.players.len() == MATCH_PLAYERS
        && s.players.len() == MATCH_PLAYERS
        && ten.len() == MATCH_PLAYERS
        && theirs == Some(ten)
}

impl Poller {
    /// Visits the tracked players in turn, each that is due, until FACEIT turns the key away;
    /// sleeps [`IDLE`] when nobody was.
    async fn run(mut self) {
        loop {
            let mut looked = false;
            for steamid in self.tracking.tracked() {
                let mut entry = match self.entries.remove(&steamid) {
                    Some(entry) => entry,
                    None => match self.histories.get(steamid) {
                        Ok(entry) => {
                            self.unreadable.remove(&steamid);
                            entry.unwrap_or_default()
                        }
                        // Passed over, not written over: the file is left as it is.
                        Err(e) => {
                            if self.unreadable.insert(steamid) {
                                tracing::warn!(steamid, error = %e, "cannot read a tracked player's FACEIT history; passed over until it can be");
                            }
                            continue;
                        }
                    },
                };
                if entry.next_unix > self.clock.now() {
                    self.entries.insert(steamid, entry);
                    continue;
                }
                looked = true;
                let halt = self.look(steamid, &mut entry).await.err();
                let now = self.clock.now();
                match &halt {
                    None => {
                        entry.tries = 0;
                        entry.next_unix = now + CHECK_EVERY.as_secs();
                    }
                    Some(Halt::Unanswered(why) | Halt::NotFetched(why)) => {
                        entry.tries = entry.tries.saturating_add(1);
                        let wait = backoff(entry.tries);
                        let what = if matches!(halt, Some(Halt::Unanswered(_))) {
                            "FACEIT did not answer for a tracked player; backing off"
                        } else {
                            "a tracked player's FACEIT demo failed on the way; backing off"
                        };
                        tracing::warn!(steamid, tries = entry.tries, wait = ?wait, error = %why, "{what}");
                        entry.next_unix = now + wait.as_secs();
                    }
                    // Not tracked any more (a new link is due at once), or the poller stops.
                    Some(Halt::Untracked | Halt::Revoked) => {}
                }
                self.save(steamid, &entry);
                self.entries.insert(steamid, entry);
                if matches!(halt, Some(Halt::Revoked)) {
                    tracing::error!(
                        "FACEIT turned this server's key away; the FACEIT poller stops until \
                         the server restarts with a key FACEIT takes"
                    );
                    return;
                }
            }
            if !looked {
                tokio::time::sleep(IDLE).await;
            }
        }
    }

    /// One look at `steamid`: who they are on FACEIT, their new matches, then the demos of the
    /// pending ones. A player FACEIT has no account for has nothing more to look at.
    async fn look(&self, steamid: u64, entry: &mut FaceitEntry) -> Result<(), Halt> {
        let Some(player_id) = self.player_id(steamid, entry).await? else {
            return Ok(());
        };
        let fresh = self.read_history(steamid, &player_id, entry).await?;
        self.release_lost(steamid, entry);
        self.attach(steamid, entry);
        // The rows are kept before the fetches, which may take minutes each.
        self.save(steamid, entry);
        self.fetch_demos(steamid, entry, &fresh).await
    }

    /// FACEIT's id of `steamid`'s account, and their nickname into `entry`: from their kept
    /// profile when it names the account (asking Steam for nothing, not even a refresh), else
    /// the one `entry` knows, else FACEIT's answer by steamid; `None` when FACEIT has no account
    /// for them.
    async fn player_id(
        &self,
        steamid: u64,
        entry: &mut FaceitEntry,
    ) -> Result<Option<String>, Halt> {
        if let Some(faceit) = self.profiles.peek(steamid).await.and_then(|p| p.faceit) {
            if let Some(id) = faceit.player_id {
                entry.player_id = Some(id.clone());
                entry.nickname = Some(faceit.nickname);
                return Ok(Some(id));
            }
        }
        if let Some(id) = &entry.player_id {
            return Ok(Some(id.clone()));
        }
        self.still(steamid)?;
        let Some(player) = self.data.player_by_steamid(steamid).await? else {
            return Ok(None);
        };
        entry.player_id = Some(player.player_id.clone());
        entry.nickname = Some(player.nickname);
        Ok(Some(player.player_id))
    }

    /// Keeps a row for each match of `player_id`'s since the cursor that has none, asking
    /// FACEIT for its detail, oldest first; returns the ids of the matches it made rows for. A
    /// detail FACEIT does not give (an error status, an answer not understood) leaves the row
    /// without it, for a later look to ask again. A 429 ends the look before that match: the
    /// cursor passes a match only once it has its row, so the next look asks for the rest.
    async fn read_history(
        &self,
        steamid: u64,
        player_id: &str,
        entry: &mut FaceitEntry,
    ) -> Result<HashSet<String>, Halt> {
        let from = entry
            .cursor_unix
            .unwrap_or_else(|| self.clock.now().saturating_sub(FIRST_WINDOW.as_secs()));
        self.still(steamid)?;
        let mut items = self.data.history(player_id, from, HISTORY_LIMIT).await?;
        items.sort_by_key(|i| i.finished_unix);
        let mut fresh = HashSet::new();
        for item in items {
            let finished = item.finished_unix;
            if !entry.has(&item.match_id) {
                self.still(steamid)?;
                let detail = match self.data.match_detail(&item.match_id).await {
                    Ok(detail) => detail,
                    Err(e @ (FaceitError::Unauthorized | FaceitError::RateLimited)) => {
                        return Err(e.into())
                    }
                    Err(e) => {
                        tracing::warn!(steamid, faceit_match = %item.match_id, error = %e, "a FACEIT match's detail was not read; it is asked for again later");
                        None
                    }
                };
                fresh.insert(item.match_id.clone());
                entry.keep(row_of(item, detail));
            }
            entry.cursor_unix = Some(entry.cursor_unix.map_or(finished, |c| c.max(finished)));
        }
        Ok(fresh)
    }

    /// Fetches the demo of each pending row, newest first, one at a time, starting at most
    /// [`FETCHES_PER_LOOK`] downloads; a row without a URL, unless `fresh` (made this look),
    /// asks FACEIT for one first. A download that failed on the way ends the look (the player
    /// is backed off), unless it was the row's last try.
    async fn fetch_demos(
        &self,
        steamid: u64,
        entry: &mut FaceitEntry,
        fresh: &HashSet<String>,
    ) -> Result<(), Halt> {
        let mut downloads = 0;
        for i in 0..entry.matches.len() {
            if entry.matches[i].demo != DemoState::Pending {
                continue;
            }
            self.still(steamid)?;
            let row = &mut entry.matches[i];
            let fetched = match self.store.find_faceit(&row.match_id) {
                // A record of the site's answers for the match: it holds the demo, or will.
                Some(rec) => self.settle(&rec.id).await,
                None => {
                    if row.demo_url.is_none() && !fresh.contains(&row.match_id) {
                        self.detail_again(steamid, row).await?;
                    }
                    if row.demo_url.is_none() {
                        Fetched::NoUrl
                    } else if downloads >= FETCHES_PER_LOOK {
                        Fetched::Later
                    } else {
                        match self.claim(row) {
                            Some(id) => {
                                downloads += 1;
                                self.settle(&id).await
                            }
                            None => Fetched::OffList,
                        }
                    }
                }
            };
            let settled = match fetched {
                Fetched::OffList | Fetched::NoUrl | Fetched::Later => continue,
                Fetched::Held(id) => DemoState::Held(id),
                Fetched::Refused => DemoState::Unavailable,
                Fetched::Failed(why) => {
                    row.fetch_tries += 1;
                    if row.fetch_tries < MAX_FETCH_TRIES {
                        return Err(Halt::NotFetched(why));
                    }
                    tracing::warn!(
                        steamid,
                        faceit_match = %row.match_id,
                        tries = row.fetch_tries,
                        "a FACEIT demo failed every try; it is unavailable"
                    );
                    DemoState::Unavailable
                }
            };
            row.demo = settled;
            row.demo_url = None;
            self.save(steamid, entry);
        }
        Ok(())
    }

    /// Turns each row held by a demo whose record is forgotten, or no longer done (its pack
    /// evicted), back into a pending one, so the attach pass and the fetches see it again; the
    /// row's URL, when it still has one, is kept. The profile has already stopped linking such a
    /// replay ([`crate::profile::faceit_rows`]).
    fn release_lost(&self, steamid: u64, entry: &mut FaceitEntry) {
        let mut changed = false;
        for row in &mut entry.matches {
            if matches!(&row.demo, DemoState::Held(id) if !self.store.is_done(id)) {
                row.demo = DemoState::Pending;
                changed = true;
            }
        }
        if changed {
            self.save(steamid, entry);
        }
    }

    /// The attach pass: holds each of `steamid`'s pending or unavailable rows whose demo the site
    /// has. A done record that answers for the match holds it; one under way is left to the
    /// fetches, which wait for it. Else a done upload of the match does ([`attaches`]), of those
    /// in `steamid`'s matches, after it takes the match's FACEIT id
    /// ([`crate::jobs::attach_faceit`]). Each upload goes to one row; of two that are a row's,
    /// the oldest (then the least id) is taken, warned about. The rows go oldest first, so of two
    /// matches alike in every fact the older takes the older upload. An attach that fails is
    /// logged, and tried again on the next look.
    fn attach(&self, steamid: u64, entry: &mut FaceitEntry) {
        let index = self.store.matches();
        // The done uploads that may be a row's, their records naming no FACEIT match (a summary
        // that names one while its record does not is an attach cut short, [`attaches`]): each
        // one's record's id, when it was made, and its summary; oldest first.
        let mut uploads: Vec<(String, u64, Arc<MatchSummary>)> = index
            .players()
            .matches_of(steamid)
            .into_iter()
            .filter_map(|sha| {
                let s = index
                    .get(&sha)
                    .filter(|s| s.mode == Some(GameMode::Faceit))?;
                let rec = self
                    .store
                    .find_by_sha(&sha)
                    .filter(|r| r.status == Status::Done && r.faceit_match_id.is_none())?;
                Some((rec.id, rec.created_unix, s))
            })
            .collect();
        uploads.sort_by(|a, b| (a.1, &a.0).cmp(&(b.1, &b.0)));
        for row in entry.matches.iter_mut().rev() {
            if row.demo != DemoState::Pending && row.demo != DemoState::Unavailable {
                continue;
            }
            match self.store.find_faceit(&row.match_id) {
                Some(rec) if rec.status == Status::Done => {
                    row.hold(rec.id);
                    continue;
                }
                Some(_) => continue,
                None => {}
            }
            let mut found = uploads
                .iter()
                .enumerate()
                .filter(|(_, u)| attaches(row, &u.2))
                .map(|(i, _)| i);
            let Some(i) = found.next() else {
                continue;
            };
            let others = found.count();
            if others > 0 {
                tracing::warn!(
                    steamid,
                    faceit_match = %row.match_id,
                    uploads = others + 1,
                    "more than one upload has a FACEIT match's facts; the oldest is taken"
                );
            }
            let (id, _, _) = uploads.remove(i);
            match crate::jobs::attach_faceit(&self.store, &id, &row.match_id) {
                Ok(true) => {
                    tracing::info!(demo = %id, faceit_match = %row.match_id, "an uploaded demo attached to a tracked player's FACEIT match");
                    row.hold(id);
                }
                Ok(false) => {}
                Err(e) => {
                    tracing::warn!(demo = %id, faceit_match = %row.match_id, error = %e, "cannot attach an uploaded demo to its FACEIT match; tried again on the next look");
                }
            }
        }
    }

    /// Asks FACEIT again for the detail of `row`'s match, which gave no demo URL before. A URL
    /// now goes on the row, with the map and the players when it had none (the score stays the
    /// history's, whose side is known). None counts a try, and at [`MAX_FETCH_TRIES`] the demo
    /// is unavailable: no look is failed for it, as FACEIT answered.
    async fn detail_again(&self, steamid: u64, row: &mut FaceitMatch) -> Result<(), Halt> {
        self.still(steamid)?;
        if let Some(d) = self.data.match_detail(&row.match_id).await? {
            if row.map.is_none() {
                row.map = d.map;
            }
            if row.players.is_empty() {
                row.players = d.players;
            }
            row.demo_url = d.demo_urls.into_iter().next();
        }
        if row.demo_url.is_some() {
            return Ok(());
        }
        row.detail_tries += 1;
        if row.detail_tries >= MAX_FETCH_TRIES {
            tracing::warn!(
                steamid,
                faceit_match = %row.match_id,
                tries = row.detail_tries,
                "FACEIT gave no demo for a match in every ask; it is unavailable"
            );
            row.demo = DemoState::Unavailable;
        }
        Ok(())
    }

    /// Claims `row`'s match for its demo URL and queues the download, when the ingest may fetch
    /// that URL; the record's id, also when someone claimed the match a moment before. `None`
    /// for a URL off the allowlist (or none): nothing is claimed.
    fn claim(&self, row: &FaceitMatch) -> Option<String> {
        let url = ingest::check_url(row.demo_url.as_deref()?).ok()?;
        let (rec, created) =
            self.store
                .claim_faceit(&row.match_id, &Store::new_id(), Some(row.finished_unix));
        if created {
            tracing::info!(demo = %rec.id, faceit_match = %row.match_id, "a tracked player's FACEIT demo queued");
            self.jobs.enqueue(Job::Url {
                demo_id: rec.id.clone(),
                url,
                slot: None,
            });
        }
        Some(rec.id)
    }

    /// Waits until record `id` is done or failed: what became of its demo.
    async fn settle(&self, id: &str) -> Fetched {
        loop {
            let Some(rec) = self.store.get(id) else {
                return Fetched::Failed("its record is gone".to_owned());
            };
            match rec.status {
                Status::Done => return Fetched::Held(rec.id),
                Status::Error => {
                    let error = rec.error.unwrap_or_default();
                    return if ingest::is_refusal(&error) {
                        Fetched::Refused
                    } else {
                        Fetched::Failed(error)
                    };
                }
                _ => tokio::time::sleep(SETTLE_POLL).await,
            }
        }
    }

    /// Whether `steamid` is still tracked; a look ends when not.
    fn still(&self, steamid: u64) -> Result<(), Halt> {
        if self.tracking.state(steamid) == TrackingState::On {
            Ok(())
        } else {
            Err(Halt::Untracked)
        }
    }

    /// Writes `steamid`'s file; a failure is logged (the next write tries again).
    fn save(&self, steamid: u64, entry: &FaceitEntry) {
        if let Err(e) = self.histories.put(steamid, entry) {
            tracing::error!(steamid, error = %e, "cannot write a FACEIT history");
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::matches::SummaryPlayer;

    use super::*;

    fn item(score: Option<[u8; 2]>) -> FaceitHistoryItem {
        FaceitHistoryItem {
            match_id: "1-a".to_owned(),
            finished_unix: 1_761_000_000,
            competition: Some("CS2 5v5".to_owned()),
            score,
            won: score.map(|[a, b]| a > b),
            players: vec![1, 2],
        }
    }

    fn detail(demo_urls: &[&str]) -> FaceitMatchDetail {
        FaceitMatchDetail {
            map: Some("de_nuke".to_owned()),
            demo_urls: demo_urls.iter().map(|u| (*u).to_owned()).collect(),
            players: (1..=10).collect(),
            score: Some([9, 13]),
            finished_unix: Some(1_761_000_000),
        }
    }

    /// A FACEIT match's row: its ten players, Nuke, the player's side 13–9.
    fn ten_row() -> FaceitMatch {
        FaceitMatch {
            score: Some([13, 9]),
            players: (1..=10).collect(),
            ..row_of(item(Some([13, 9])), Some(detail(&[])))
        }
    }

    /// An uploaded FACEIT demo's summary of the match [`ten_row`] is: the ten in another order,
    /// the sides' score as the demo ends (the Ts 9, the CTs 13).
    fn upload() -> MatchSummary {
        MatchSummary {
            sha256: "ab".repeat(32),
            map: "de_nuke".to_owned(),
            score_t: 9,
            score_ct: 13,
            players: (1..=10u64)
                .rev()
                .map(|id| SummaryPlayer {
                    steamid: id.to_string(),
                    team: if id % 2 == 0 { 2 } else { 3 },
                    ..SummaryPlayer::default()
                })
                .collect(),
            mode: Some(GameMode::Faceit),
            ..MatchSummary::default()
        }
    }

    #[test]
    fn an_upload_is_its_rows_by_its_ten_players_map_and_score_either_way() {
        let row = ten_row();
        assert!(attaches(&row, &upload()));
        let turned = MatchSummary {
            score_t: 13,
            score_ct: 9,
            ..upload()
        };
        assert!(attaches(&row, &turned), "the score in the other order");
        // Half attached (its summary took this match's id, its record not yet): still the row's,
        // so the attach can be finished.
        let half = MatchSummary {
            faceit_match_id: Some(row.match_id.clone()),
            ..upload()
        };
        assert!(attaches(&row, &half));
    }

    #[test]
    fn a_near_miss_is_not_its_rows() {
        let row = ten_row();
        let misses = [
            (
                "another score",
                MatchSummary {
                    score_t: 11,
                    ..upload()
                },
            ),
            (
                "another map",
                MatchSummary {
                    map: "de_mirage".to_owned(),
                    ..upload()
                },
            ),
            (
                "not a FACEIT match",
                MatchSummary {
                    mode: Some(GameMode::Competitive),
                    ..upload()
                },
            ),
            (
                "a mode from before ranks",
                MatchSummary {
                    mode: None,
                    ..upload()
                },
            ),
            (
                "another FACEIT match's already",
                MatchSummary {
                    faceit_match_id: Some("1-b".to_owned()),
                    ..upload()
                },
            ),
        ];
        for (why, s) in misses {
            assert!(!attaches(&row, &s), "{why}");
        }
        let mut nine = upload();
        nine.players.pop();
        assert!(!attaches(&row, &nine), "nine of the ten");
        let mut swapped = upload();
        swapped.players[0].steamid = "11".to_owned();
        assert!(!attaches(&row, &swapped), "another player for one of them");
        let mut eleven = upload();
        eleven.players.push(SummaryPlayer {
            steamid: "11".to_owned(),
            ..SummaryPlayer::default()
        });
        assert!(!attaches(&row, &eleven), "an eleventh player");
        let mut twice = upload();
        twice.players[0].steamid = twice.players[1].steamid.clone();
        assert!(!attaches(&row, &twice), "one of them twice, one missing");
    }

    #[test]
    fn a_row_short_of_its_facts_takes_no_upload() {
        let s = upload();
        let nine: Vec<u64> = (1..=9).collect();
        let mut short = MatchSummary {
            players: s.players.clone(),
            ..upload()
        };
        short.players.retain(|p| p.steamid != "10");
        for (why, row, s) in [
            (
                "no map",
                FaceitMatch {
                    map: None,
                    ..ten_row()
                },
                &s,
            ),
            (
                "no score",
                FaceitMatch {
                    score: None,
                    ..ten_row()
                },
                &s,
            ),
            (
                "nine players",
                FaceitMatch {
                    players: nine,
                    ..ten_row()
                },
                &short,
            ),
        ] {
            assert!(!attaches(&row, s), "{why}");
        }
    }

    #[test]
    fn the_wait_doubles_from_a_minute_to_two_hours() {
        let waits: Vec<u64> = (1..=9).map(|n| backoff(n).as_secs()).collect();
        assert_eq!(waits, [60, 120, 240, 480, 960, 1920, 3840, 7200, 7200]);
        assert_eq!(backoff(u32::MAX), MAX_BACKOFF);
    }

    #[test]
    fn a_row_takes_the_detail_and_the_players_side_of_the_score() {
        let row = row_of(
            item(Some([13, 9])),
            Some(detail(&["https://a/1.dem.gz", "https://b/1.dem.gz"])),
        );
        assert_eq!(row.map.as_deref(), Some("de_nuke"));
        assert_eq!(row.players, (1..=10).collect::<Vec<u64>>());
        assert_eq!((row.score, row.won), (Some([13, 9]), Some(true)));
        assert_eq!(row.competition.as_deref(), Some("CS2 5v5"));
        assert_eq!(row.demo, DemoState::Pending);
        assert_eq!(row.demo_url.as_deref(), Some("https://a/1.dem.gz"));
        assert_eq!(row.detail_tries, 0);
        // The history did not say whose side: no score, not the detail's teams' order. No URL
        // yet: pending, the ask that made the row its first try.
        let row = row_of(item(None), Some(detail(&[])));
        assert_eq!((row.score, row.won), (None, None));
        assert_eq!((row.demo, row.demo_url), (DemoState::Pending, None));
        assert_eq!(row.detail_tries, 1);
        // No detail: what the history gave, and pending without a URL.
        let row = row_of(item(Some([13, 9])), None);
        assert_eq!((row.map, row.players), (None, vec![1, 2]));
        assert_eq!((row.demo, row.demo_url), (DemoState::Pending, None));
        assert_eq!(row.detail_tries, 1);
    }
}
