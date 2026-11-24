//! The sitemaps (<https://www.sitemaps.org>): `/sitemap.xml` indexes `sitemap-pages.xml`,
//! `sitemap-events.xml` and the numbered `sitemap-profiles-{n}.xml` and `sitemap-matches-{n}.xml`,
//! each holding at most [`PAGE`] addresses. They are built from the store and the player index,
//! kept for [`TTL`] and written only when the site knows its own address
//! ([`crate::config::Config::public_url`]): without it every route is a 404.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use url::Url;

use crate::api::AppState;
use crate::events;
use crate::pages::{civil_from_days, escape};
use crate::store::Status;

/// The most addresses in one sitemap file (the protocol allows 50 000).
pub const PAGE: usize = 10_000;

/// How long a built set of sitemaps is kept (and the `max-age` it is served with).
pub const TTL: Duration = Duration::from_secs(600);

/// The opening of every sitemap document.
const XML: &str = r#"<?xml version="1.0" encoding="UTF-8"?>"#;

/// The namespace of the sitemap protocol.
const NS: &str = "http://www.sitemaps.org/schemas/sitemap/0.9";

/// A page and when it last changed (a Unix time), its path relative to the public URL.
pub type Entry = (String, Option<u64>);

/// Every sitemap, as built at one time; each a complete XML document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
    /// `/sitemap.xml`.
    pub index: String,
    /// `sitemap-pages.xml`.
    pub pages: String,
    /// `sitemap-events.xml`.
    pub events: String,
    /// `sitemap-profiles-{n}.xml`, for n from 1.
    pub profiles: Vec<String>,
    /// `sitemap-matches-{n}.xml`, for n from 1.
    pub matches: Vec<String>,
}

/// The sitemaps last built, and when.
#[derive(Default)]
pub struct SitemapCache {
    inner: Arc<Inner>,
}

/// What a rebuild task shares with the requests.
#[derive(Default)]
struct Inner {
    /// What was built last, and when (`None` once expired). Held only to read or replace it.
    built: Mutex<Option<(Option<Instant>, Arc<Built>)>>,
    /// Held by the one rebuild under way (a detached task, so a request that goes away neither
    /// releases it nor loses the build), so the requests serve what is kept meanwhile.
    rebuilding: Arc<tokio::sync::Mutex<()>>,
    /// Woken when a rebuild ends, however it ends.
    ended: tokio::sync::Notify,
}

/// Wakes the requests waiting on a rebuild when dropped (also when the task panics).
struct Ends(Arc<Inner>);

impl Drop for Ends {
    fn drop(&mut self) {
        self.0.ended.notify_waiters();
    }
}

impl Inner {
    /// What is kept: whether it is fresh, and the build.
    fn kept(&self) -> Option<(bool, Arc<Built>)> {
        let slot = self.built.lock().unwrap_or_else(PoisonError::into_inner);
        let (at, built) = slot.as_ref()?;
        Some((at.is_some_and(|at| at.elapsed() < TTL), built.clone()))
    }
}

impl SitemapCache {
    /// The sitemaps of `s`, built again (off the runtime) when there are none or they are older
    /// than [`TTL`]. While a rebuild is under way, a request that finds a stale build gets it;
    /// one that finds none waits for the rebuild. `None` without a public URL.
    pub async fn get(&self, s: &AppState) -> Option<Arc<Built>> {
        let base = s.cfg.public_url.clone()?;
        let s = s.clone();
        Some(
            self.get_with(move || async move {
                tokio::task::spawn_blocking(move || collect(&s, &base))
                    .await
                    .expect("the sitemap scan panicked")
            })
            .await,
        )
    }

    /// [`SitemapCache::get`] building with `build`, which runs in a task of its own with no
    /// lock on what is kept.
    async fn get_with<F, Fut>(&self, build: F) -> Arc<Built>
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Built> + Send + 'static,
    {
        let inner = &self.inner;
        let mut build = Some(build);
        let mut started = false;
        loop {
            let kept = inner.kept();
            if let Some((true, built)) = &kept {
                return built.clone();
            }
            if let Ok(guard) = inner.rebuilding.clone().try_lock_owned() {
                let Some(build) = build.take() else {
                    // Our own rebuild ended without a build.
                    return kept.map(|(_, b)| b).expect("the sitemap build failed");
                };
                started = true;
                let task = inner.clone();
                tokio::spawn(async move {
                    let _ends = Ends(task.clone());
                    let _guard = guard;
                    let built = Arc::new(build().await);
                    *task.built.lock().unwrap_or_else(PoisonError::into_inner) =
                        Some((Some(Instant::now()), built));
                });
            } else if let Some((_, stale)) = kept {
                return stale;
            }
            // Wait for the rebuild to end (registered before looking again, so it is not missed).
            let ended = inner.ended.notified();
            tokio::pin!(ended);
            ended.as_mut().enable();
            if matches!(inner.kept(), Some((true, _))) || inner.rebuilding.try_lock().is_ok() {
                continue;
            }
            ended.await;
            if started && inner.rebuilding.try_lock().is_ok() && inner.kept().is_none() {
                panic!("the sitemap build failed");
            }
        }
    }

    /// Makes what is kept stale, so the next [`SitemapCache::get`] builds again.
    #[doc(hidden)]
    pub fn expire(&self) {
        if let Some((at, _)) = self
            .inner
            .built
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            *at = None;
        }
    }
}

/// The sitemaps of what the store holds: the fixed pages, the events with a done match, the
/// players not hidden with a done match, and every done match once (under its oldest done id,
/// the one the match page uses).
fn collect(s: &AppState, base: &Url) -> Built {
    let mut pages = vec![
        (String::new(), None),
        ("events".to_owned(), None),
        ("legal".to_owned(), None),
        ("guides".to_owned(), None),
    ];
    pages.extend(
        crate::guides::GUIDES
            .iter()
            .map(|g| (format!("guides/{}", g.slug), None)),
    );
    let events: Vec<Entry> = events::list_events(s)
        .into_iter()
        .map(|e| (format!("events/{}", e.slug), e.last_unix))
        .collect();
    let index = s.store.matches();
    let at = |sha: &str| {
        index
            .get(sha)
            .map(|m| m.played_unix.unwrap_or(m.created_unix))
    };
    // sha → the id of its done record, asked of the store once per sha.
    let ids: HashMap<String, String> = index
        .all()
        .into_iter()
        .filter_map(|m| {
            let done = s
                .store
                .find_by_sha(&m.sha256)
                .filter(|r| r.status == Status::Done)?;
            Some((m.sha256.clone(), done.id))
        })
        .collect();
    let mut matches: Vec<Entry> = ids
        .iter()
        .map(|(sha, id)| (format!("d/{id}"), at(sha)))
        .collect();
    matches.sort_unstable();
    let profiles: Vec<Entry> = index
        .players()
        .all_players()
        .into_iter()
        .filter(|p| !s.hidden.is_hidden(p.steamid))
        .filter_map(|p| {
            // The latest of their matches that has a done record.
            let latest = index
                .players()
                .matches_of(p.steamid)
                .into_iter()
                .filter(|sha| ids.contains_key(sha))
                .filter_map(|sha| at(&sha))
                .max()?;
            Some((format!("profiles/{}", p.steamid), Some(latest)))
        })
        .collect();
    build(base, &pages, &events, &profiles, &matches)
}

/// The sitemaps of the given pages, split into files of at most [`PAGE`] addresses, and the
/// index of those that are not empty (the pages always).
pub fn build(
    base: &Url,
    pages: &[Entry],
    events: &[Entry],
    profiles: &[Entry],
    matches: &[Entry],
) -> Built {
    let files = |entries: &[Entry]| -> Vec<String> {
        entries.chunks(PAGE).map(|c| urlset(base, c)).collect()
    };
    let (profiles, matches) = (files(profiles), files(matches));
    let mut names = vec!["sitemap-pages.xml".to_owned()];
    if !events.is_empty() {
        names.push("sitemap-events.xml".into());
    }
    names.extend((1..=profiles.len()).map(|n| format!("sitemap-profiles-{n}.xml")));
    names.extend((1..=matches.len()).map(|n| format!("sitemap-matches-{n}.xml")));
    let mut index = format!("{XML}\n<sitemapindex xmlns=\"{NS}\">\n");
    for name in names {
        if let Ok(loc) = base.join(&name) {
            index.push_str(&format!(
                "<sitemap><loc>{}</loc></sitemap>\n",
                escape(loc.as_str())
            ));
        }
    }
    index.push_str("</sitemapindex>\n");
    Built {
        index,
        pages: urlset(base, pages),
        events: urlset(base, events),
        profiles,
        matches,
    }
}

/// A `<urlset>` of `entries` under `base`.
fn urlset(base: &Url, entries: &[Entry]) -> String {
    let mut out = format!("{XML}\n<urlset xmlns=\"{NS}\">\n");
    for (path, at) in entries {
        let Ok(loc) = base.join(path) else { continue };
        out.push_str(&format!("<url><loc>{}</loc>", escape(loc.as_str())));
        if let Some(at) = at {
            out.push_str(&format!("<lastmod>{}</lastmod>", ymd(*at)));
        }
        out.push_str("</url>\n");
    }
    out.push_str("</urlset>\n");
    out
}

/// The day (UTC) of the Unix time `unix`, as `YYYY-MM-DD`.
fn ymd(unix: u64) -> String {
    let (y, m, d) = civil_from_days(unix / 86_400);
    format!("{y:04}-{m:02}-{d:02}")
}

/// The sitemap routes.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/sitemap.xml", get(index))
        .route("/sitemap-pages.xml", get(pages))
        .route("/sitemap-events.xml", get(events_file))
        .route("/sitemap-profiles-{n}", get(profiles))
        .route("/sitemap-matches-{n}", get(matches))
}

/// `body` as XML, kept by caches as long as the sitemaps are.
fn xml(body: String) -> Response {
    (
        [
            (header::CONTENT_TYPE, "application/xml; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=600"),
        ],
        body,
    )
        .into_response()
}

/// A plain 404.
fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "not found").into_response()
}

/// The answer for the file `pick` takes from the sitemaps, a 404 without one.
async fn serve(s: &AppState, pick: impl FnOnce(&Built) -> Option<&String>) -> Response {
    match s.sitemaps.get(s).await {
        Some(built) => pick(&built).map_or_else(not_found, |f| xml(f.clone())),
        None => not_found(),
    }
}

/// `/sitemap.xml`.
async fn index(State(s): State<AppState>) -> Response {
    serve(&s, |b| Some(&b.index)).await
}

/// `/sitemap-pages.xml`.
async fn pages(State(s): State<AppState>) -> Response {
    serve(&s, |b| Some(&b.pages)).await
}

/// `/sitemap-events.xml`.
async fn events_file(State(s): State<AppState>) -> Response {
    serve(&s, |b| Some(&b.events)).await
}

/// The file number in `sitemap-<kind>-{n}.xml`'s last segment `name`, counted from 1.
fn number(name: &str) -> Option<usize> {
    let n: usize = name.strip_suffix(".xml")?.parse().ok()?;
    n.checked_sub(1)
}

/// `/sitemap-profiles-{n}.xml`.
async fn profiles(State(s): State<AppState>, Path(n): Path<String>) -> Response {
    serve(&s, |b| b.profiles.get(number(&n)?)).await
}

/// `/sitemap-matches-{n}.xml`.
async fn matches(State(s): State<AppState>, Path(n): Path<String>) -> Response {
    serve(&s, |b| b.matches.get(number(&n)?)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Url {
        Url::parse("https://skunk.club/").unwrap()
    }

    fn entries(n: usize) -> Vec<Entry> {
        (0..n).map(|i| (format!("d/{i}"), Some(0))).collect()
    }

    #[test]
    fn files_split_at_ten_thousand() {
        let built = build(&base(), &[], &[], &entries(PAGE + 1), &entries(PAGE));
        assert_eq!(built.profiles.len(), 2);
        assert_eq!(built.profiles[0].matches("<url>").count(), PAGE);
        assert_eq!(built.profiles[1].matches("<url>").count(), 1);
        assert_eq!(built.matches.len(), 1);
        assert!(built
            .index
            .contains("<loc>https://skunk.club/sitemap-profiles-2.xml</loc>"));
        assert!(!built.index.contains("sitemap-profiles-3"));
        assert!(built.index.contains("sitemap-matches-1.xml"));
        assert!(!built.index.contains("sitemap-events.xml"));
        assert!(built.events.contains("<urlset") && !built.events.contains("<url>"));
    }

    #[test]
    fn text_is_escaped_and_the_day_is_utc() {
        let built = build(
            &base(),
            &[("a&b".into(), Some(1_761_163_200))],
            &[],
            &[],
            &[],
        );
        assert!(built
            .pages
            .contains("<loc>https://skunk.club/a&amp;b</loc><lastmod>2025-10-22</lastmod>"));
        assert_eq!(ymd(0), "1970-01-01");
    }

    #[tokio::test]
    async fn a_build_is_kept_until_it_expires_and_stale_is_served_meanwhile() {
        let cache = Arc::new(SitemapCache::default());
        let made =
            |tag: &'static str| async move { build(&base(), &[(tag.into(), None)], &[], &[], &[]) };
        let first = cache.get_with(move || made("one")).await;
        let again = cache.get_with(move || made("two")).await;
        assert!(Arc::ptr_eq(&first, &again));
        cache.expire();
        // A slow rebuild is under way; another request gets the stale build at once.
        let gate = Arc::new(tokio::sync::Notify::new());
        let slow = {
            let (cache, gate) = (cache.clone(), gate.clone());
            tokio::spawn(async move {
                cache
                    .get_with(|| async move {
                        gate.notified().await;
                        build(&base(), &[("three".into(), None)], &[], &[], &[])
                    })
                    .await
            })
        };
        tokio::task::yield_now().await;
        let stale = cache.get_with(move || made("never")).await;
        assert!(Arc::ptr_eq(&stale, &first));
        gate.notify_one();
        let third = slow.await.unwrap();
        assert!(third.pages.contains("three"));
        assert!(Arc::ptr_eq(
            &cache.get_with(move || made("x")).await,
            &third
        ));
    }

    #[tokio::test]
    async fn a_request_that_goes_away_neither_frees_the_rebuild_nor_loses_it() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = Arc::new(SitemapCache::default());
        let first = cache
            .get_with(|| async { build(&base(), &[("one".into(), None)], &[], &[], &[]) })
            .await;
        cache.expire();
        let (gate, runs) = (
            Arc::new(tokio::sync::Notify::new()),
            Arc::new(AtomicUsize::new(0)),
        );
        let slow = |gate: Arc<tokio::sync::Notify>, runs: Arc<AtomicUsize>| {
            move || async move {
                runs.fetch_add(1, Ordering::SeqCst);
                gate.notified().await;
                build(&base(), &[("two".into(), None)], &[], &[], &[])
            }
        };
        // A request starts the rebuild and goes away before it ends.
        let request = {
            let (cache, build) = (cache.clone(), slow(gate.clone(), runs.clone()));
            tokio::spawn(async move { cache.get_with(build).await })
        };
        tokio::task::yield_now().await;
        request.abort();
        let _ = request.await;
        // Another finds the stale build and starts no second rebuild.
        let stale = cache.get_with(slow(gate.clone(), runs.clone())).await;
        assert!(Arc::ptr_eq(&stale, &first));
        gate.notify_one();
        while !matches!(cache.inner.kept(), Some((true, _))) {
            tokio::task::yield_now().await;
        }
        let fresh = cache.get_with(slow(gate.clone(), runs.clone())).await;
        assert!(fresh.pages.contains("two"));
        assert_eq!(runs.load(Ordering::SeqCst), 1);
        assert!(Arc::ptr_eq(&cache.get_with(slow(gate, runs)).await, &fresh));
    }
}
