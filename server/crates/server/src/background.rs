//! Background work queued at startup, behind user work ([`Jobs::enqueue_background`]): a match
//! summarized before ranks is parsed again from its kept original, and a share-code match kept
//! without its original is fetched again while Valve still keeps the replay
//! ([`REPLAY_WINDOW`]), so its original is kept too.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::errors::blocking;
use crate::jobs::{Job, Jobs};
use crate::sharecode;
use crate::store::{Source, Status, Store};

/// How long Valve keeps a match's replay after the match: 30 days (its storage's custom time,
/// `x-goog-custom-time`, is the upload plus 30 days).
pub const REPLAY_WINDOW: Duration = Duration::from_secs(30 * 24 * 3600);

/// Queues the background work the store needs, then returns. Share-code matches come first,
/// oldest first, as their replays go; then the re-parses. Each sha is queued once.
pub async fn schedule_background(store: Arc<Store>, jobs: Jobs) {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let planning = store.clone();
    let planned = match blocking(move || plan(&planning, now)).await {
        Ok(planned) => planned,
        Err(e) => {
            tracing::error!(error = %e, "cannot plan the background work");
            return;
        }
    };
    if !planned.is_empty() {
        tracing::info!(jobs = planned.len(), "background work queued");
    }
    for job in planned {
        jobs.enqueue_background(job).await;
    }
}

/// What [`schedule_background`] queues, as of `now` (unix seconds). Reads the disk (whether
/// each original is kept).
fn plan(store: &Store, now: u64) -> Vec<Job> {
    let mut fetched: Vec<_> = store
        .records()
        .into_iter()
        .filter(|r| {
            r.status == Status::Done && matches!(r.source, Source::Sharecode | Source::Tracked)
        })
        .filter_map(|r| {
            let at = r.played_unix.unwrap_or(r.created_unix);
            let code = sharecode::decode(r.sharecode.as_deref()?).ok()?;
            Some((at, r.sha256?, code))
        })
        .filter(|(at, _, _)| now.saturating_sub(*at) < REPLAY_WINDOW.as_secs())
        .collect();
    fetched.sort_by_key(|(at, _, _)| *at);
    let mut seen = HashSet::new();
    let mut planned: Vec<Job> = fetched
        .into_iter()
        .filter(|(_, sha, _)| !store.has_original(sha) && seen.insert(sha.clone()))
        .map(|(_, sha, code)| Job::Refetch { sha, code })
        .collect();
    planned.extend(
        store
            .matches()
            .all()
            .into_iter()
            .filter(|s| s.mode.is_none() && store.has_original(&s.sha256))
            .map(|s| Job::Reparse {
                sha: s.sha256.clone(),
            }),
    );
    planned
}
