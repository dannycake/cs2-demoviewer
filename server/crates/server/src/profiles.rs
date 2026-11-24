//! Steam's facts about an account ([`crate::steam`]) and its FACEIT account ([`crate::faceit`],
//! asked beside them and never otherwise: of the Data API with a FACEIT key, of FACEIT's site
//! API without one), cached. A profile is kept on disk as
//! `profiles/<steamid>.json`, fresh for [`PROFILE_TTL`]; past that it still answers at once
//! while one background refresh per account asks Steam (and FACEIT) again. Custom URL names are
//! kept in memory and in `profiles/vanities.json`, so they outlast a restart: a day for a name
//! found and ten minutes for one that is not. Without a Steam
//! key nothing asks Steam or FACEIT: a profile kept earlier still answers, and names do not
//! resolve.

use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::errors::blocking;
use crate::faceit::{Faceit, FaceitApi, FaceitData, FaceitDataApi, FaceitSource};
use crate::gcbot::BoxFuture;
use crate::hidden::Hidden;
use crate::steam::{Bans, PlayerSummary, Playtime, SteamApi, SteamError, TradeBan};
use crate::store::{self, Store};

/// How long after startup the warmer first runs, so a restart settles before the Steam calls.
pub const WARM_AFTER: Duration = Duration::from_secs(120);

/// How long the warmer waits between runs.
pub const WARM_EVERY: Duration = Duration::from_secs(24 * 3600);

/// How long a fetched profile is fresh.
pub const PROFILE_TTL: Duration = Duration::from_secs(3600);
/// How long a custom URL name that was found is kept.
pub const VANITY_TTL: Duration = Duration::from_secs(24 * 3600);
/// How long a custom URL name that was not found is kept.
pub const VANITY_MISS_TTL: Duration = Duration::from_secs(10 * 60);
/// Past this many names kept, the expired ones are dropped.
const VANITIES_KEPT: usize = 10_000;

/// What a profile shows from Steam. `None` facts are hidden by the account's privacy (or
/// Steam did not say, or the profile was kept before they were asked for).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedProfile {
    pub steamid: u64,
    pub name: String,
    pub avatar: Option<String>,
    pub since_year: Option<u16>,
    pub country: Option<String>,
    pub cs2_hours: Option<u32>,
    /// Minutes of CS2 in the last two weeks.
    #[serde(default)]
    pub cs2_recent_minutes: Option<u32>,
    /// The Steam level.
    #[serde(default)]
    pub level: Option<u32>,
    pub vac_bans: Option<u32>,
    pub game_bans: Option<u32>,
    #[serde(default)]
    pub community_banned: Option<bool>,
    /// A trade ban or probation; none without one.
    #[serde(default)]
    pub trade_ban: Option<TradeBan>,
    /// Days since the last VAC or game ban; none without one.
    #[serde(default)]
    pub days_since_last_ban: Option<u32>,
    /// The FACEIT account linked to this one ([`crate::faceit`]); none without one, or kept
    /// before FACEIT was asked.
    #[serde(default)]
    pub faceit: Option<Faceit>,
    pub fetched_unix: u64,
}

/// Where the cache's answers come from: [`SteamApi`], or a test's fake.
#[doc(hidden)]
pub trait ProfileSource: Send + Sync {
    fn summary(&self, id: u64) -> BoxFuture<'_, Result<Option<PlayerSummary>, SteamError>>;
    fn bans(&self, id: u64) -> BoxFuture<'_, Result<Option<Bans>, SteamError>>;
    fn playtime(&self, id: u64) -> BoxFuture<'_, Result<Option<Playtime>, SteamError>>;
    fn level(&self, id: u64) -> BoxFuture<'_, Result<Option<u32>, SteamError>>;
    fn vanity<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<u64>, SteamError>>;
    fn avatar<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, SteamError>>;
}

impl ProfileSource for SteamApi {
    fn summary(&self, id: u64) -> BoxFuture<'_, Result<Option<PlayerSummary>, SteamError>> {
        Box::pin(self.player_summary(id))
    }
    fn bans(&self, id: u64) -> BoxFuture<'_, Result<Option<Bans>, SteamError>> {
        Box::pin(self.player_bans(id))
    }
    fn playtime(&self, id: u64) -> BoxFuture<'_, Result<Option<Playtime>, SteamError>> {
        Box::pin(self.cs2_playtime(id))
    }
    fn level(&self, id: u64) -> BoxFuture<'_, Result<Option<u32>, SteamError>> {
        Box::pin(self.steam_level(id))
    }
    fn vanity<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<u64>, SteamError>> {
        Box::pin(self.resolve_vanity(name))
    }
    fn avatar<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, SteamError>> {
        Box::pin(self.avatar_image(url))
    }
}

struct Entry {
    profile: CachedProfile,
    stale_at: Instant,
}

pub struct ProfileCache {
    dir: PathBuf,
    source: Option<Arc<dyn ProfileSource>>,
    /// FACEIT's site API, asked beside Steam (never without it) when there is no `faceit_data`.
    faceit: Option<Arc<dyn FaceitSource>>,
    /// FACEIT's Data API (with a FACEIT key), asked beside Steam in the site API's place.
    faceit_data: Option<Arc<dyn FaceitData>>,
    entries: Mutex<HashMap<u64, Entry>>,
    refreshing: Mutex<HashSet<u64>>,
    /// Lowercase name → its steamid (or none) and when that answer expires (unix seconds); kept
    /// in `vanities.json` beside the profiles.
    vanities: Mutex<HashMap<String, (Option<u64>, u64)>>,
    /// Held across taking the snapshot of `vanities` and writing it, so that writes of
    /// `vanities.json` never overlap (they share one tmp file) and the last to write is the
    /// newest snapshot.
    vanities_write: tokio::sync::Mutex<()>,
}

impl ProfileCache {
    /// The cache kept in `dir` (made if missing); `api` is `None` without a Steam key. FACEIT is
    /// asked beside Steam: `faceit_data` (the Data API, `None` without a FACEIT key) when there is
    /// one, else `faceit` (the site API, `None` without FACEIT).
    pub fn open(
        dir: &Path,
        api: Option<Arc<SteamApi>>,
        faceit: Option<Arc<FaceitApi>>,
        faceit_data: Option<Arc<FaceitDataApi>>,
    ) -> io::Result<Arc<ProfileCache>> {
        ProfileCache::open_with(
            dir,
            api.map(|a| a as Arc<dyn ProfileSource>),
            faceit.map(|f| f as Arc<dyn FaceitSource>),
            faceit_data.map(|f| f as Arc<dyn FaceitData>),
        )
    }

    /// [`ProfileCache::open`] asking `source` instead of Steam, and `faceit` and `faceit_data`
    /// instead of FACEIT's site and Data APIs.
    #[doc(hidden)]
    pub fn open_with(
        dir: &Path,
        source: Option<Arc<dyn ProfileSource>>,
        faceit: Option<Arc<dyn FaceitSource>>,
        faceit_data: Option<Arc<dyn FaceitData>>,
    ) -> io::Result<Arc<ProfileCache>> {
        std::fs::create_dir_all(dir)?;
        Ok(Arc::new(ProfileCache {
            dir: dir.to_owned(),
            source,
            faceit,
            faceit_data,
            entries: Mutex::default(),
            refreshing: Mutex::default(),
            vanities_write: tokio::sync::Mutex::new(()),
            vanities: Mutex::new(read_vanities(&dir.join(VANITIES_FILE))),
        }))
    }

    /// The account's profile: a fresh one as it is; a stale one as it is, refreshed in the
    /// background; none kept yet, fetched now (four calls through the Steam gate). `None`
    /// when there is none kept and fetching fails, or Steam has no such account.
    pub async fn get(self: &Arc<Self>, id: u64) -> Option<CachedProfile> {
        if let Some((profile, stale)) = self.kept(id).await {
            if stale && self.source.is_some() {
                self.refresh_in_background(id);
            }
            return Some(profile);
        }
        let source = self.source.clone()?;
        self.fetch(&*source, id).await
    }

    /// The kept profile of `id` without asking Steam for one not kept yet; a stale one is
    /// refreshed in the background as [`ProfileCache::get`] does.
    pub async fn get_kept(self: &Arc<Self>, id: u64) -> Option<CachedProfile> {
        let (profile, stale) = self.kept(id).await?;
        if stale && self.source.is_some() {
            self.refresh_in_background(id);
        }
        Some(profile)
    }

    /// The kept profile of `id`, stale or not, asking Steam for nothing (not even a refresh):
    /// for what a crawler reads, which must never cost a Steam call.
    pub async fn peek(&self, id: u64) -> Option<CachedProfile> {
        self.kept(id).await.map(|(profile, _)| profile)
    }

    /// The kept profile of `id` and whether it is stale, asking Steam for nothing.
    pub async fn peek_with_age(&self, id: u64) -> Option<(CachedProfile, bool)> {
        self.kept(id).await
    }

    /// Whether `id`'s profile is being fetched now.
    pub fn fetching(&self, id: u64) -> bool {
        lock(&self.refreshing).contains(&id)
    }

    /// Fetches `id`'s profile in the background (the next [`ProfileCache::peek`] has it), unless
    /// it is being fetched already; whether it started one. Without a Steam key it does nothing.
    pub fn fetch_in_background(self: &Arc<Self>, id: u64) -> bool {
        if self.source.is_none() {
            return false;
        }
        self.refresh_in_background(id)
    }

    /// The steamid a custom URL name (any case) resolved to, while that answer is kept; never
    /// asks Steam.
    pub fn resolved_vanity(&self, name: &str) -> Option<u64> {
        let key = name.to_ascii_lowercase();
        lock(&self.vanities)
            .get(&key)
            .filter(|(_, until)| *until > unix_now())
            .and_then(|(id, _)| *id)
    }

    /// Whether Steam said no account has the custom URL name (any case), while that answer is
    /// kept; never asks Steam.
    pub fn vanity_missing(&self, name: &str) -> bool {
        let key = name.to_ascii_lowercase();
        lock(&self.vanities)
            .get(&key)
            .is_some_and(|(id, until)| id.is_none() && *until > unix_now())
    }

    /// The steamid of a custom URL name (any case); `None` when no account has it, or without
    /// a Steam key.
    pub async fn resolve_vanity(&self, name: &str) -> Result<Option<u64>, SteamError> {
        let key = name.to_ascii_lowercase();
        if let Some(&(id, until)) = lock(&self.vanities).get(&key) {
            if until > unix_now() {
                return Ok(id);
            }
        }
        let Some(source) = &self.source else {
            return Ok(None);
        };
        let id = source.vanity(&key).await?;
        let ttl = if id.is_some() {
            VANITY_TTL
        } else {
            VANITY_MISS_TTL
        };
        let _writing = self.vanities_write.lock().await;
        let now = unix_now();
        let json = {
            let mut vanities = lock(&self.vanities);
            if vanities.len() >= VANITIES_KEPT {
                vanities.retain(|_, (_, until)| *until > now);
            }
            vanities.insert(key, (id, now + ttl.as_secs()));
            vanities_json(&vanities)
        };
        let (path, tmp) = (
            self.dir.join(VANITIES_FILE),
            self.dir.join(format!("{VANITIES_FILE}.tmp")),
        );
        match blocking(move || store::write_file(&tmp, &path, &json)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "cannot keep the custom URL names"),
            Err(e) => tracing::warn!(error = %e, "cannot keep the custom URL names"),
        }
        Ok(id)
    }

    /// The kept profile of `id` (from memory, else its file) and whether it is stale.
    async fn kept(&self, id: u64) -> Option<(CachedProfile, bool)> {
        if let Some(e) = lock(&self.entries).get(&id) {
            return Some((e.profile.clone(), e.stale_at <= Instant::now()));
        }
        let path = self.path(id);
        let read = blocking(move || std::fs::read(path)).await.ok()?.ok()?;
        let profile: CachedProfile = match serde_json::from_slice(&read) {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!(steamid = id, error = %e, "unreadable cached profile; ignored");
                return None;
            }
        };
        let age = Duration::from_secs(unix_now().saturating_sub(profile.fetched_unix));
        let stale_at = Instant::now() + PROFILE_TTL.saturating_sub(age);
        let stale = age >= PROFILE_TTL;
        lock(&self.entries).insert(
            id,
            Entry {
                profile: profile.clone(),
                stale_at,
            },
        );
        Some((profile, stale))
    }

    fn refresh_in_background(self: &Arc<Self>, id: u64) -> bool {
        if !lock(&self.refreshing).insert(id) {
            return false;
        }
        let this = self.clone();
        tokio::spawn(async move {
            if let Some(source) = this.source.clone() {
                this.fetch(&*source, id).await;
            }
            lock(&this.refreshing).remove(&id);
        });
        true
    }

    /// Asks Steam for `id`'s profile, and FACEIT beside it once Steam knows the account, and
    /// keeps it; `None` on any Steam error (logged) or when Steam has no such account. A kept
    /// profile stays as it was on a Steam error. On a FACEIT error the profile keeps the FACEIT
    /// account it had.
    async fn fetch(&self, source: &dyn ProfileSource, id: u64) -> Option<CachedProfile> {
        self.fetch_checked(source, id).await.ok().flatten()
    }

    /// [`ProfileCache::fetch`], telling a Steam error (`Err`, also logged) from Steam having no
    /// such account (`Ok(None)`).
    async fn fetch_checked(
        &self,
        source: &dyn ProfileSource,
        id: u64,
    ) -> Result<Option<CachedProfile>, SteamError> {
        let fetched = async {
            let Some(summary) = source.summary(id).await? else {
                return Ok(None);
            };
            let (steam, faceit) = tokio::join!(
                async {
                    let bans = source.bans(id).await?;
                    let playtime = source.playtime(id).await?;
                    let level = source.level(id).await?;
                    Ok::<_, SteamError>((bans, playtime, level))
                },
                self.ask_faceit(id),
            );
            let (bans, playtime, level) = steam?;
            Ok::<_, SteamError>(Some(CachedProfile {
                steamid: id,
                name: summary.name,
                avatar: summary.avatar,
                since_year: summary.since_year,
                country: summary.country,
                cs2_hours: playtime.map(|p| p.hours),
                cs2_recent_minutes: playtime.map(|p| p.recent_minutes),
                level,
                vac_bans: bans.map(|b| b.vac),
                game_bans: bans.map(|b| b.game),
                community_banned: bans.map(|b| b.community),
                trade_ban: bans.and_then(|b| b.trade),
                days_since_last_ban: bans.and_then(|b| b.days_since_last),
                faceit,
                fetched_unix: unix_now(),
            }))
        }
        .await;
        let profile = match fetched {
            Ok(Some(profile)) => profile,
            Ok(None) => return Ok(None),
            Err(e) => {
                tracing::warn!(steamid = id, error = %e, "cannot fetch a Steam profile");
                return Err(e);
            }
        };
        let was = lock(&self.entries)
            .get(&id)
            .and_then(|e| e.profile.avatar.clone());
        self.keep_avatar(source, id, was.as_deref(), profile.avatar.as_deref())
            .await;
        lock(&self.entries).insert(
            id,
            Entry {
                profile: profile.clone(),
                stale_at: Instant::now() + PROFILE_TTL,
            },
        );
        let (path, tmp) = (self.path(id), self.dir.join(format!("{id}.json.tmp")));
        let Ok(json) = serde_json::to_vec(&profile) else {
            return Ok(Some(profile));
        };
        match blocking(move || store::write_file(&tmp, &path, &json)).await {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(steamid = id, error = %e, "cannot keep a Steam profile"),
            Err(e) => tracing::warn!(steamid = id, error = %e, "cannot keep a Steam profile"),
        }
        Ok(Some(profile))
    }

    /// Fetches `id`'s profile now and waits for it, stale or not: what a caller pacing its own
    /// Steam calls needs, where [`ProfileCache::get`] answers a stale one at once and refreshes
    /// in the background. When a background refresh of `id` is already running, waits for that
    /// one instead and answers what it kept. `Ok(None)` when Steam has no such account or
    /// there is no Steam to ask; the kept profile stays as it was on an error.
    pub async fn refresh_now(
        self: &Arc<Self>,
        id: u64,
    ) -> Result<Option<CachedProfile>, SteamError> {
        let Some(source) = self.source.clone() else {
            return Ok(None);
        };
        if !lock(&self.refreshing).insert(id) {
            while self.fetching(id) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            return Ok(self.peek(id).await);
        }
        let result = self.fetch_checked(&*source, id).await;
        lock(&self.refreshing).remove(&id);
        result
    }

    /// `id`'s FACEIT account as FACEIT says now: of the Data API when there is one (the player,
    /// then their lifetime stats), else of the site API. The one kept with their profile when
    /// FACEIT fails (no answer in time, an error, an answer of another shape, the key turned
    /// away), which never fails the fetch; the stats kept when only they fail. None without
    /// FACEIT.
    async fn ask_faceit(&self, id: u64) -> Option<Faceit> {
        let asked = match (&self.faceit_data, &self.faceit) {
            (Some(data), _) => self.ask_faceit_data(&**data, id).await,
            (None, Some(site)) => site.account(id).await,
            (None, None) => return None,
        };
        match asked {
            Ok(account) => account,
            Err(e) => {
                tracing::warn!(steamid = id, error = %e, "cannot ask FACEIT; its last answer kept");
                self.kept(id).await.and_then(|(p, _)| p.faceit)
            }
        }
    }

    /// `id`'s FACEIT account as the Data API says now: their player, and the lifetime stats of
    /// it. When only the stats fail, those kept for the same player stand in.
    async fn ask_faceit_data(
        &self,
        data: &dyn FaceitData,
        id: u64,
    ) -> Result<Option<Faceit>, crate::faceit::FaceitError> {
        let Some(player) = data.player_by_steamid(id).await? else {
            return Ok(None);
        };
        let lifetime = match data.lifetime_stats(&player.player_id).await {
            Ok(lifetime) => lifetime.map(|l| (l.wins_pct, l.matches)),
            Err(e) => {
                tracing::warn!(steamid = id, error = %e, "cannot ask FACEIT for lifetime stats");
                self.kept(id)
                    .await
                    .and_then(|(p, _)| p.faceit)
                    .filter(|f| f.player_id.as_deref() == Some(player.player_id.as_str()))
                    .map(|f| (f.wins_pct, f.matches))
            }
        };
        let (wins_pct, matches) = lifetime.unwrap_or_default();
        Ok(Some(Faceit {
            nickname: player.nickname,
            level: player.level,
            elo: player.elo,
            player_id: Some(player.player_id),
            wins_pct,
            matches,
        }))
    }

    fn path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("{id}.json"))
    }

    /// Where `id`'s avatar is kept, beside their profile: the image their card shows.
    pub fn avatar_path(&self, id: u64) -> PathBuf {
        self.dir.join(format!("{id}.jpg"))
    }

    /// Keeps the image of `id`'s avatar `now` (Steam's address for it), fetched when it is not
    /// the one they had (`was`) or none is kept. When they have none, or it cannot be fetched,
    /// none is kept: their card never shows an avatar they have changed.
    async fn keep_avatar(
        &self,
        source: &dyn ProfileSource,
        id: u64,
        was: Option<&str>,
        now: Option<&str>,
    ) {
        let path = self.avatar_path(id);
        let kept = tokio::fs::metadata(&path).await.is_ok_and(|m| m.is_file());
        if kept && now.is_some() && was == now {
            return;
        }
        let image = match now {
            Some(url) => match source.avatar(url).await {
                Ok(image) => Some(image),
                Err(e) => {
                    tracing::warn!(steamid = id, error = %e, "cannot fetch an avatar");
                    None
                }
            },
            None => None,
        };
        let tmp = self.dir.join(format!("{id}.jpg.tmp"));
        let kept = blocking(move || match image {
            Some(image) => store::write_file(&tmp, &path, &image),
            None => match std::fs::remove_file(&path) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
                _ => Ok(()),
            },
        })
        .await;
        match kept {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(steamid = id, error = %e, "cannot keep an avatar"),
            Err(e) => tracing::warn!(steamid = id, error = %e, "cannot keep an avatar"),
        }
    }
}

/// The file in the cache's directory that keeps the custom URL names.
const VANITIES_FILE: &str = "vanities.json";

/// One custom URL name's answer as kept in [`VANITIES_FILE`].
#[derive(Serialize, Deserialize)]
struct KeptVanity {
    /// The steamid, or none when no account has the name.
    id: Option<u64>,
    /// When the answer expires, in unix seconds.
    until: u64,
}

/// The names in `vanities` as the bytes of [`VANITIES_FILE`].
fn vanities_json(vanities: &HashMap<String, (Option<u64>, u64)>) -> Vec<u8> {
    let kept: HashMap<&str, KeptVanity> = vanities
        .iter()
        .map(|(name, &(id, until))| (name.as_str(), KeptVanity { id, until }))
        .collect();
    serde_json::to_vec(&kept).unwrap_or_default()
}

/// The names kept in the file `path` whose answer has not expired. A file that is missing gives
/// none; one that cannot be read or understood is logged and gives none too.
fn read_vanities(path: &Path) -> HashMap<String, (Option<u64>, u64)> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return HashMap::new(),
        Err(e) => {
            tracing::warn!(error = %e, "unreadable custom URL names; ignored");
            return HashMap::new();
        }
    };
    let kept: HashMap<String, KeptVanity> = match serde_json::from_slice(&bytes) {
        Ok(kept) => kept,
        Err(e) => {
            tracing::warn!(error = %e, "malformed custom URL names; ignored");
            return HashMap::new();
        }
    };
    let now = unix_now();
    kept.into_iter()
        .filter(|(_, v)| v.until > now)
        .map(|(name, v)| (name, (v.id, v.until)))
        .collect()
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// What one warming run did.
#[derive(Debug, Default, PartialEq, Eq, Clone, Copy)]
pub struct WarmReport {
    /// Profiles fetched.
    pub fetched: usize,
    /// Fetches that failed, or whose account Steam does not have; not retried in the run.
    pub failed: usize,
    /// Players whose kept profile was fresh, so nothing was asked.
    pub fresh: usize,
    /// Players left unvisited because Steam rate limited or was too busy; the next run takes
    /// them.
    pub skipped: usize,
}

/// Fetches the profile of every indexed player that has none kept or a stale one, most matches
/// first, hidden players skipped, one at a time, each waited for before the next (so the Steam
/// gate paces the calls, and a stale profile is refreshed here, not in a background task per
/// player). Stops the run when Steam rate limits or is too busy, leaving the rest for the next.
/// Does nothing when the cache has no Steam to ask.
pub async fn warm_once(cache: &Arc<ProfileCache>, store: &Store, hidden: &Hidden) -> WarmReport {
    let mut report = WarmReport::default();
    if cache.source.is_none() {
        tracing::debug!("profile warmer: no Steam key, nothing to warm");
        return report;
    }
    let mut players = store.matches().players().all_players();
    players.sort_by(|a, b| b.matches.cmp(&a.matches).then(a.steamid.cmp(&b.steamid)));
    let mut todo = players.into_iter();
    while let Some(p) = todo.next() {
        if hidden.is_hidden(p.steamid) {
            continue;
        }
        if matches!(cache.peek_with_age(p.steamid).await, Some((_, false))) {
            report.fresh += 1;
            continue;
        }
        match cache.refresh_now(p.steamid).await {
            Ok(Some(_)) => report.fetched += 1,
            Ok(None) => report.failed += 1,
            Err(e @ (SteamError::RateLimited | SteamError::Busy)) => {
                report.failed += 1;
                report.skipped = todo.filter(|p| !hidden.is_hidden(p.steamid)).count();
                tracing::warn!(error = %e, "profile warmer: stopping, the next run takes the rest");
                break;
            }
            Err(_) => report.failed += 1,
        }
    }
    tracing::info!(
        fetched = report.fetched,
        failed = report.failed,
        fresh = report.fresh,
        skipped = report.skipped,
        "profile warmer: run done"
    );
    report
}

/// [`spawn_warmer_with`] at [`WARM_AFTER`] and [`WARM_EVERY`].
pub fn spawn_warmer(
    cache: Arc<ProfileCache>,
    store: Arc<Store>,
    hidden: Arc<Hidden>,
) -> JoinHandle<()> {
    spawn_warmer_with(WARM_AFTER, WARM_EVERY, cache, store, hidden)
}

/// Runs [`warm_once`] `after` from now, then every `every`, for as long as the server lives.
#[doc(hidden)]
pub fn spawn_warmer_with(
    after: Duration,
    every: Duration,
    cache: Arc<ProfileCache>,
    store: Arc<Store>,
    hidden: Arc<Hidden>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        tokio::time::sleep(after).await;
        loop {
            warm_once(&cache, &store, &hidden).await;
            tokio::time::sleep(every).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::faceit::{
        FaceitError, FaceitHistoryItem, FaceitLifetime, FaceitMatchDetail, FaceitPlayer,
    };
    use crate::steam::{Bans, PlayerSummary, Playtime, TradeBan};

    const ID: u64 = 76561198000000001;

    /// A Steam that counts its calls and answers from `fail` / `vanities`; the summary names
    /// `avatar`, whose image is its address's bytes (counted apart, failing with `avatar_fails`),
    /// and is called `name` (`skunk` without one). FACEIT's site API beside it answers
    /// `faceit`, or fails with `faceit_fails`, counted apart; its Data API answers
    /// `data_player` and `data_lifetime`, or fails with `data_fails` (the lifetime stats alone
    /// with `lifetime_fails`), counted apart too.
    #[derive(Default)]
    struct Fake {
        calls: AtomicUsize,
        fail: Mutex<bool>,
        vanities: Vec<(&'static str, u64)>,
        avatar: Mutex<Option<&'static str>>,
        avatars: AtomicUsize,
        avatar_fails: Mutex<bool>,
        name: Mutex<Option<&'static str>>,
        faceit: Mutex<Option<Faceit>>,
        faceits: AtomicUsize,
        faceit_fails: Mutex<bool>,
        data_player: Mutex<Option<FaceitPlayer>>,
        data_lifetime: Mutex<Option<FaceitLifetime>>,
        data_calls: AtomicUsize,
        data_fails: Mutex<bool>,
        lifetime_fails: Mutex<bool>,
        /// Fail every call as rate limited.
        rate_limited: Mutex<bool>,
        /// How long a summary takes, and how many are in flight now and at most.
        summary_delay: Mutex<Duration>,
        in_flight: AtomicUsize,
        most_in_flight: AtomicUsize,
    }

    impl Fake {
        fn calls(&self) -> usize {
            self.calls.load(Ordering::SeqCst)
        }
        fn call(&self) -> Result<(), SteamError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if *self.rate_limited.lock().unwrap() {
                return Err(SteamError::RateLimited);
            }
            if *self.fail.lock().unwrap() {
                Err(SteamError::Unavailable("down".into()))
            } else {
                Ok(())
            }
        }
    }

    impl ProfileSource for Fake {
        fn summary(&self, _: u64) -> BoxFuture<'_, Result<Option<PlayerSummary>, SteamError>> {
            Box::pin(async move {
                let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                self.most_in_flight.fetch_max(now, Ordering::SeqCst);
                let delay = *self.summary_delay.lock().unwrap();
                tokio::time::sleep(delay).await;
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                self.call()?;
                Ok(Some(PlayerSummary {
                    name: self.name.lock().unwrap().unwrap_or("skunk").into(),
                    avatar: self.avatar.lock().unwrap().map(str::to_owned),
                    since_year: Some(2009),
                    country: None,
                }))
            })
        }
        fn bans(&self, _: u64) -> BoxFuture<'_, Result<Option<Bans>, SteamError>> {
            Box::pin(async move {
                self.call()?;
                Ok(Some(Bans {
                    vac: 0,
                    game: 1,
                    community: true,
                    trade: Some(TradeBan::Probation),
                    days_since_last: Some(400),
                }))
            })
        }
        fn playtime(&self, _: u64) -> BoxFuture<'_, Result<Option<Playtime>, SteamError>> {
            Box::pin(async move {
                self.call()?;
                Ok(None)
            })
        }
        fn level(&self, _: u64) -> BoxFuture<'_, Result<Option<u32>, SteamError>> {
            Box::pin(async move {
                self.call()?;
                Ok(Some(42))
            })
        }
        fn vanity<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Option<u64>, SteamError>> {
            Box::pin(async move {
                self.call()?;
                Ok(self
                    .vanities
                    .iter()
                    .find(|(n, _)| *n == name)
                    .map(|(_, id)| *id))
            })
        }
        fn avatar<'a>(&'a self, url: &'a str) -> BoxFuture<'a, Result<Vec<u8>, SteamError>> {
            Box::pin(async move {
                self.avatars.fetch_add(1, Ordering::SeqCst);
                if *self.avatar_fails.lock().unwrap() {
                    return Err(SteamError::Unavailable("down".into()));
                }
                Ok(url.as_bytes().to_vec())
            })
        }
    }

    impl FaceitSource for Fake {
        fn account(&self, _: u64) -> BoxFuture<'_, Result<Option<Faceit>, FaceitError>> {
            Box::pin(async move {
                self.faceits.fetch_add(1, Ordering::SeqCst);
                if *self.faceit_fails.lock().unwrap() {
                    return Err(FaceitError::Unavailable("timed out".into()));
                }
                Ok(self.faceit.lock().unwrap().clone())
            })
        }
    }

    impl FaceitData for Fake {
        fn player_by_steamid(
            &self,
            _: u64,
        ) -> BoxFuture<'_, Result<Option<FaceitPlayer>, FaceitError>> {
            Box::pin(async move {
                self.data_calls.fetch_add(1, Ordering::SeqCst);
                if *self.data_fails.lock().unwrap() {
                    return Err(FaceitError::RateLimited);
                }
                Ok(self.data_player.lock().unwrap().clone())
            })
        }
        fn player_by_nickname<'a>(
            &'a self,
            _: &'a str,
        ) -> BoxFuture<'a, Result<Option<FaceitPlayer>, FaceitError>> {
            Box::pin(async { unreachable!("a profile never asks by nickname") })
        }
        fn lifetime_stats<'a>(
            &'a self,
            player_id: &'a str,
        ) -> BoxFuture<'a, Result<Option<FaceitLifetime>, FaceitError>> {
            Box::pin(async move {
                self.data_calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(player_id, DATA_ID);
                if *self.lifetime_fails.lock().unwrap() {
                    return Err(FaceitError::Unavailable("timed out".into()));
                }
                Ok(*self.data_lifetime.lock().unwrap())
            })
        }
        fn history<'a>(
            &'a self,
            _: &'a str,
            _: u64,
            _: u32,
        ) -> BoxFuture<'a, Result<Vec<FaceitHistoryItem>, FaceitError>> {
            Box::pin(async { unreachable!("a profile never asks for a history") })
        }
        fn match_detail<'a>(
            &'a self,
            _: &'a str,
        ) -> BoxFuture<'a, Result<Option<FaceitMatchDetail>, FaceitError>> {
            Box::pin(async { unreachable!("a profile never asks for a match") })
        }
    }

    fn alpha() -> Faceit {
        Faceit {
            nickname: "alphafaceit".into(),
            level: Some(10),
            elo: Some(3609),
            player_id: None,
            wins_pct: None,
            matches: None,
        }
    }

    /// A made-up player's FACEIT player id, as the Data API gives it.
    const DATA_ID: &str = "a1b2c3d4-0000-4000-8000-000000000001";

    /// The player as the Data API gives them.
    fn alpha_player() -> FaceitPlayer {
        FaceitPlayer {
            player_id: DATA_ID.into(),
            nickname: "alpha".into(),
            steamid: Some(ID),
            level: Some(10),
            elo: Some(3500),
        }
    }

    fn cache(fake: &Arc<Fake>) -> (tempfile::TempDir, Arc<ProfileCache>) {
        let dir = tempfile::tempdir().unwrap();
        let cache = ProfileCache::open_with(
            &dir.path().join("profiles"),
            Some(fake.clone() as Arc<dyn ProfileSource>),
            Some(fake.clone() as Arc<dyn FaceitSource>),
            None,
        )
        .unwrap();
        (dir, cache)
    }

    /// [`cache`] with FACEIT's Data API too, as with a FACEIT key.
    fn keyed_cache(fake: &Arc<Fake>) -> (tempfile::TempDir, Arc<ProfileCache>) {
        let dir = tempfile::tempdir().unwrap();
        let cache = ProfileCache::open_with(
            &dir.path().join("profiles"),
            Some(fake.clone() as Arc<dyn ProfileSource>),
            Some(fake.clone() as Arc<dyn FaceitSource>),
            Some(fake.clone() as Arc<dyn FaceitData>),
        )
        .unwrap();
        (dir, cache)
    }

    /// Moves every kept custom URL answer `by` closer to its expiry.
    fn age(cache: &ProfileCache, by: Duration) {
        for (_, until) in lock(&cache.vanities).values_mut() {
            *until -= by.as_secs();
        }
    }

    /// Runs the background refresh of a stale profile to its end.
    async fn refresh(cache: &Arc<ProfileCache>) {
        tokio::time::advance(PROFILE_TTL + Duration::from_secs(1)).await;
        cache.get(ID).await.unwrap();
        for _ in 0..50 {
            settle().await;
            if !cache.fetching(ID) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Lets the background refreshes run.
    async fn settle() {
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_fresh_profile_costs_no_call() {
        let fake = Arc::new(Fake::default());
        let (dir, cache) = cache(&fake);
        let p = cache.get(ID).await.unwrap();
        assert_eq!(
            (
                p.name.as_str(),
                p.since_year,
                p.vac_bans,
                p.game_bans,
                p.cs2_hours,
                p.cs2_recent_minutes,
                p.level
            ),
            ("skunk", Some(2009), Some(0), Some(1), None, None, Some(42))
        );
        assert_eq!(
            (p.community_banned, p.trade_ban, p.days_since_last_ban),
            (Some(true), Some(TradeBan::Probation), Some(400))
        );
        // A summary, the bans, the playtime and the level.
        assert_eq!(fake.calls(), 4);
        tokio::time::advance(PROFILE_TTL - Duration::from_secs(1)).await;
        assert_eq!(cache.get(ID).await.unwrap().name, "skunk");
        settle().await;
        assert_eq!(fake.calls(), 4);
        // Kept on disk, and read back by a new cache without a call.
        assert!(dir.path().join(format!("profiles/{ID}.json")).is_file());
        let again = ProfileCache::open_with(
            &dir.path().join("profiles"),
            Some(fake.clone() as Arc<dyn ProfileSource>),
            Some(fake.clone() as Arc<dyn FaceitSource>),
            None,
        )
        .unwrap();
        assert_eq!(again.get(ID).await.unwrap(), p);
        settle().await;
        assert_eq!(fake.calls(), 4);
    }

    /// A profile kept before Steam's level, recent playtime and every kind of ban were asked
    /// for reads back, those facts unknown, and is not fetched again while fresh.
    #[tokio::test(start_paused = true)]
    async fn a_profile_kept_before_the_newer_facts_reads_back() {
        let fake = Arc::new(Fake::default());
        let (dir, cache) = cache(&fake);
        let json = serde_json::json!({
            "steamid": ID, "name": "skunk", "avatar": null, "since_year": 2009,
            "country": "CA", "cs2_hours": 184, "vac_bans": 0, "game_bans": 0,
            "fetched_unix": unix_now(),
        });
        std::fs::write(
            dir.path().join(format!("profiles/{ID}.json")),
            json.to_string(),
        )
        .unwrap();
        let p = cache.get(ID).await.unwrap();
        assert_eq!((p.cs2_hours, p.vac_bans), (Some(184), Some(0)));
        assert_eq!(
            (
                p.cs2_recent_minutes,
                p.level,
                p.community_banned,
                p.trade_ban,
                p.days_since_last_ban
            ),
            (None, None, None, None, None)
        );
        assert_eq!(p.faceit, None);
        settle().await;
        assert_eq!(fake.calls(), 0);
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn a_stale_profile_is_served_then_refreshed_once() {
        let fake = Arc::new(Fake::default());
        let (_dir, cache) = cache(&fake);
        cache.get(ID).await.unwrap();
        tokio::time::advance(PROFILE_TTL + Duration::from_secs(1)).await;
        assert!(cache.get(ID).await.is_some());
        assert!(cache.get(ID).await.is_some());
        settle().await;
        assert_eq!(fake.calls(), 8, "one refresh of four calls");
        // Fresh again.
        assert!(cache.get(ID).await.is_some());
        settle().await;
        assert_eq!(fake.calls(), 8);
    }

    #[tokio::test]
    async fn a_failed_fetch_answers_none_and_is_not_cached() {
        let fake = Arc::new(Fake::default());
        *fake.fail.lock().unwrap() = true;
        let (dir, cache) = cache(&fake);
        assert!(cache.get(ID).await.is_none());
        let after_one = fake.calls();
        assert!(cache.get(ID).await.is_none());
        assert!(fake.calls() > after_one, "asked again");
        assert!(!dir.path().join(format!("profiles/{ID}.json")).exists());
    }

    /// Resolved names, misses included, are kept in `vanities.json` and answer again after the
    /// cache is opened anew, with no source to ask.
    #[tokio::test]
    async fn resolved_names_survive_a_reopen() {
        let fake = Arc::new(Fake {
            vanities: vec![("skunk", ID)],
            ..Fake::default()
        });
        let (dir, cache) = cache(&fake);
        assert_eq!(cache.resolve_vanity("Skunk").await, Ok(Some(ID)));
        assert_eq!(cache.resolve_vanity("nobody").await, Ok(None));
        let reopened =
            ProfileCache::open_with(&dir.path().join("profiles"), None, None, None).unwrap();
        assert_eq!(reopened.resolved_vanity("SKUNK"), Some(ID));
        assert!(reopened.vanity_missing("nobody"));
        assert_eq!(reopened.resolved_vanity("nobody"), None);
    }

    /// Resolves overlapping each other leave a whole `vanities.json` holding every name.
    #[tokio::test]
    async fn concurrent_resolves_leave_a_whole_file() {
        let fake = Arc::new(Fake {
            vanities: vec![("a", ID), ("b", ID + 1)],
            ..Fake::default()
        });
        let (dir, cache) = cache(&fake);
        let (a, b) = tokio::join!(cache.resolve_vanity("a"), cache.resolve_vanity("b"));
        assert_eq!((a, b), (Ok(Some(ID)), Ok(Some(ID + 1))));
        let bytes = std::fs::read(dir.path().join("profiles/vanities.json")).unwrap();
        let kept: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(kept["a"]["id"], ID);
        assert_eq!(kept["b"]["id"], ID + 1);
    }

    /// Opening drops the names whose answer has expired, and ignores an unreadable file.
    #[tokio::test]
    async fn expired_names_are_dropped_on_open() {
        let dir = tempfile::tempdir().unwrap();
        let profiles = dir.path().join("profiles");
        std::fs::create_dir_all(&profiles).unwrap();
        let json = format!(
            r#"{{"old": {{"id": {ID}, "until": {}}}, "live": {{"id": {ID}, "until": {}}}}}"#,
            unix_now() - 1,
            unix_now() + 600
        );
        std::fs::write(profiles.join("vanities.json"), json).unwrap();
        let cache = ProfileCache::open_with(&profiles, None, None, None).unwrap();
        assert_eq!(cache.resolved_vanity("live"), Some(ID));
        assert_eq!(cache.resolved_vanity("old"), None);
        assert!(!lock(&cache.vanities).contains_key("old"));
        std::fs::write(profiles.join("vanities.json"), "not json").unwrap();
        let cache = ProfileCache::open_with(&profiles, None, None, None).unwrap();
        assert_eq!(cache.resolved_vanity("live"), None);
    }

    /// Expiry is wall-clock time, so the test ages the kept answers by hand, by amounts that
    /// leave seconds of slack either way so that a second boundary cannot change the outcome.
    #[tokio::test]
    async fn a_vanity_miss_is_cached_for_ten_minutes() {
        let fake = Arc::new(Fake {
            vanities: vec![("skunk", ID)],
            ..Fake::default()
        });
        let (_dir, cache) = cache(&fake);
        assert_eq!(cache.resolve_vanity("nobody").await, Ok(None));
        assert_eq!(cache.resolve_vanity("NoBody").await, Ok(None));
        assert_eq!(fake.calls(), 1);
        age(&cache, VANITY_MISS_TTL + Duration::from_secs(2));
        assert_eq!(cache.resolve_vanity("nobody").await, Ok(None));
        assert_eq!(fake.calls(), 2);
        // A hit lasts a day.
        assert_eq!(cache.resolve_vanity("Skunk").await, Ok(Some(ID)));
        age(&cache, VANITY_TTL - Duration::from_secs(3));
        assert_eq!(cache.resolve_vanity("skunk").await, Ok(Some(ID)));
        assert_eq!(fake.calls(), 3);
    }

    /// The avatar is kept beside the profile (for the player's card) and fetched again only
    /// when Steam names another; one that cannot be fetched, or none, leaves no file, so a card
    /// never shows an avatar the player has changed.
    #[tokio::test(start_paused = true)]
    async fn the_avatar_is_kept_and_fetched_again_only_when_it_changes() {
        let fake = Arc::new(Fake::default());
        *fake.avatar.lock().unwrap() = Some("https://avatars.steamstatic.com/a_full.jpg");
        let (dir, cache) = cache(&fake);
        let file = dir.path().join(format!("profiles/{ID}.jpg"));
        assert_eq!(cache.avatar_path(ID), file);
        let kept = || std::fs::read(&file).ok();
        let refresh = || async {
            tokio::time::advance(PROFILE_TTL + Duration::from_secs(1)).await;
            cache.get(ID).await.unwrap();
            for _ in 0..50 {
                settle().await;
                if !cache.fetching(ID) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        cache.get(ID).await.unwrap();
        assert_eq!(
            kept().as_deref(),
            Some(&b"https://avatars.steamstatic.com/a_full.jpg"[..])
        );
        assert_eq!(fake.avatars.load(Ordering::SeqCst), 1);
        refresh().await;
        assert_eq!(fake.avatars.load(Ordering::SeqCst), 1, "the same avatar");
        *fake.avatar.lock().unwrap() = Some("https://avatars.steamstatic.com/b_full.jpg");
        refresh().await;
        assert_eq!(fake.avatars.load(Ordering::SeqCst), 2, "a new avatar");
        assert_eq!(
            kept().as_deref(),
            Some(&b"https://avatars.steamstatic.com/b_full.jpg"[..])
        );
        *fake.avatar.lock().unwrap() = Some("https://avatars.steamstatic.com/c_full.jpg");
        *fake.avatar_fails.lock().unwrap() = true;
        refresh().await;
        assert_eq!(kept(), None, "not the old one under the new address");
        *fake.avatar_fails.lock().unwrap() = false;
        refresh().await;
        assert_eq!(
            kept().as_deref(),
            Some(&b"https://avatars.steamstatic.com/c_full.jpg"[..])
        );
        *fake.avatar.lock().unwrap() = None;
        refresh().await;
        assert_eq!(kept(), None, "no avatar now");
    }

    /// FACEIT is asked with Steam's facts, once a fetch, and its account kept with them: read
    /// back from disk, and asked again only when Steam is.
    #[tokio::test(start_paused = true)]
    async fn the_faceit_account_is_asked_with_steams_facts_and_kept_with_them() {
        let fake = Arc::new(Fake::default());
        *fake.faceit.lock().unwrap() = Some(alpha());
        let (dir, cache) = cache(&fake);
        let p = cache.get(ID).await.unwrap();
        assert_eq!(p.faceit, Some(alpha()));
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 1);
        let kept: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(format!("profiles/{ID}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            kept["faceit"],
            serde_json::json!({
                "nickname": "alphafaceit", "level": 10, "elo": 3609,
                "playerId": null, "winsPct": null, "matches": null,
            })
        );
        // Fresh, peeked at or read back by a new cache: FACEIT is not asked.
        assert_eq!(cache.get(ID).await.unwrap().faceit, Some(alpha()));
        assert_eq!(cache.peek(ID).await.unwrap().faceit, Some(alpha()));
        let again = ProfileCache::open_with(
            &dir.path().join("profiles"),
            Some(fake.clone() as Arc<dyn ProfileSource>),
            Some(fake.clone() as Arc<dyn FaceitSource>),
            None,
        )
        .unwrap();
        assert_eq!(again.get(ID).await.unwrap().faceit, Some(alpha()));
        settle().await;
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 1);
        // A refresh asks again, and an account FACEIT no longer has is gone.
        *fake.faceit.lock().unwrap() = None;
        refresh(&cache).await;
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 2);
        assert_eq!(cache.peek(ID).await.unwrap().faceit, None);
    }

    /// FACEIT failing (no answer in time, an error, an answer of another shape) costs neither
    /// Steam's facts nor the account FACEIT gave last.
    #[tokio::test(start_paused = true)]
    async fn a_faceit_failure_keeps_steams_facts_and_the_last_faceit_answer() {
        let fake = Arc::new(Fake::default());
        *fake.faceit_fails.lock().unwrap() = true;
        let (_dir, cache) = cache(&fake);
        let p = cache.get(ID).await.unwrap();
        assert_eq!(
            (p.name.as_str(), p.level, p.faceit),
            ("skunk", Some(42), None)
        );
        *fake.faceit_fails.lock().unwrap() = false;
        *fake.faceit.lock().unwrap() = Some(alpha());
        refresh(&cache).await;
        assert_eq!(cache.peek(ID).await.unwrap().faceit, Some(alpha()));
        // Steam has news; FACEIT fails.
        *fake.name.lock().unwrap() = Some("skunk2");
        *fake.faceit_fails.lock().unwrap() = true;
        refresh(&cache).await;
        let p = cache.peek(ID).await.unwrap();
        assert_eq!(p.name, "skunk2");
        assert_eq!(p.faceit, Some(alpha()));
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 3);
    }

    /// The last FACEIT answer is kept through a failure even when the profile was read from
    /// disk, by a server started since.
    #[tokio::test(start_paused = true)]
    async fn a_faceit_failure_keeps_the_answer_kept_on_disk() {
        let fake = Arc::new(Fake::default());
        let (dir, _) = cache(&fake);
        let json = serde_json::json!({
            "steamid": ID, "name": "skunk", "avatar": null, "since_year": 2009,
            "country": null, "cs2_hours": null, "vac_bans": 0, "game_bans": 0,
            "faceit": {"nickname": "alphafaceit", "level": 10, "elo": 3609},
            "fetched_unix": unix_now() - PROFILE_TTL.as_secs() - 1,
        });
        std::fs::write(
            dir.path().join(format!("profiles/{ID}.json")),
            json.to_string(),
        )
        .unwrap();
        *fake.faceit_fails.lock().unwrap() = true;
        let cache = ProfileCache::open_with(
            &dir.path().join("profiles"),
            Some(fake.clone() as Arc<dyn ProfileSource>),
            Some(fake.clone() as Arc<dyn FaceitSource>),
            None,
        )
        .unwrap();
        cache.fetch_in_background(ID);
        for _ in 0..50 {
            settle().await;
            if !cache.fetching(ID) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 1);
        let p = cache.peek(ID).await.unwrap();
        assert_eq!((p.level, p.faceit), (Some(42), Some(alpha())));
    }

    /// A profile kept before FACEIT's player id, win rate and match count were asked for loads,
    /// its level and Elo as they were and those unknown, and is not fetched again while fresh.
    #[tokio::test(start_paused = true)]
    async fn a_kept_profile_without_the_new_faceit_fields_still_loads() {
        let fake = Arc::new(Fake::default());
        let (dir, cache) = keyed_cache(&fake);
        let json = serde_json::json!({
            "steamid": ID, "name": "skunk", "avatar": null, "since_year": 2009,
            "country": null, "cs2_hours": null, "vac_bans": 0, "game_bans": 0,
            "faceit": {"nickname": "alphafaceit", "level": 10, "elo": 3609},
            "fetched_unix": unix_now(),
        });
        std::fs::write(
            dir.path().join(format!("profiles/{ID}.json")),
            json.to_string(),
        )
        .unwrap();
        let faceit = cache.get(ID).await.unwrap().faceit.unwrap();
        assert_eq!(faceit, alpha());
        assert_eq!(
            (faceit.player_id, faceit.wins_pct, faceit.matches),
            (None, None, None)
        );
        settle().await;
        assert_eq!(fake.calls(), 0);
        assert_eq!(fake.data_calls.load(Ordering::SeqCst), 0);
    }

    /// With a FACEIT key the Data API is asked (the player, then their lifetime stats), never
    /// the site API: the account kept has FACEIT's player id, win rate and match count. A player
    /// it has none for is no account; a failure keeps the one kept, still not asking the site.
    #[tokio::test(start_paused = true)]
    async fn the_data_client_is_asked_before_the_site_api() {
        let fake = Arc::new(Fake::default());
        *fake.faceit.lock().unwrap() = Some(alpha());
        *fake.data_player.lock().unwrap() = Some(alpha_player());
        *fake.data_lifetime.lock().unwrap() = Some(FaceitLifetime {
            matches: Some(1204),
            wins_pct: Some(61.0),
        });
        let (dir, cache) = keyed_cache(&fake);
        let theirs = Faceit {
            nickname: "alpha".into(),
            level: Some(10),
            elo: Some(3500),
            player_id: Some(DATA_ID.into()),
            wins_pct: Some(61.0),
            matches: Some(1204),
        };
        assert_eq!(cache.get(ID).await.unwrap().faceit, Some(theirs.clone()));
        assert_eq!(fake.data_calls.load(Ordering::SeqCst), 2);
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 0);
        let kept: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join(format!("profiles/{ID}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            kept["faceit"],
            serde_json::json!({
                "nickname": "alpha", "level": 10, "elo": 3500, "playerId": DATA_ID,
                "winsPct": 61.0, "matches": 1204,
            })
        );
        // The Data API failing keeps what it said last.
        *fake.data_fails.lock().unwrap() = true;
        refresh(&cache).await;
        assert_eq!(cache.peek(ID).await.unwrap().faceit, Some(theirs));
        assert_eq!(fake.data_calls.load(Ordering::SeqCst), 3);
        // A player it has none for (no lifetime stats asked for) is no account.
        *fake.data_fails.lock().unwrap() = false;
        *fake.data_player.lock().unwrap() = None;
        refresh(&cache).await;
        assert_eq!(cache.peek(ID).await.unwrap().faceit, None);
        assert_eq!(fake.data_calls.load(Ordering::SeqCst), 4);
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 0);
    }

    /// When only the lifetime stats fail, the player's new level and Elo are kept with the stats
    /// kept for them before.
    #[tokio::test(start_paused = true)]
    async fn when_only_the_lifetime_stats_fail_the_kept_ones_stand_in() {
        let fake = Arc::new(Fake::default());
        *fake.data_player.lock().unwrap() = Some(alpha_player());
        *fake.data_lifetime.lock().unwrap() = Some(FaceitLifetime {
            matches: Some(1204),
            wins_pct: Some(61.0),
        });
        let (_dir, cache) = keyed_cache(&fake);
        cache.get(ID).await.unwrap();
        *fake.lifetime_fails.lock().unwrap() = true;
        *fake.data_player.lock().unwrap() = Some(FaceitPlayer {
            elo: Some(3520),
            ..alpha_player()
        });
        refresh(&cache).await;
        let faceit = cache.peek(ID).await.unwrap().faceit.unwrap();
        assert_eq!(
            (faceit.elo, faceit.wins_pct, faceit.matches),
            (Some(3520), Some(61.0), Some(1204))
        );
        assert_eq!(fake.data_calls.load(Ordering::SeqCst), 4);
    }

    /// A player without lifetime stats keeps their level and Elo, the stats unknown.
    #[tokio::test(start_paused = true)]
    async fn a_player_without_lifetime_stats_is_their_level_and_elo() {
        let fake = Arc::new(Fake::default());
        *fake.data_player.lock().unwrap() = Some(alpha_player());
        let (_dir, cache) = keyed_cache(&fake);
        let faceit = cache.get(ID).await.unwrap().faceit.unwrap();
        assert_eq!(
            (faceit.level, faceit.elo, faceit.wins_pct, faceit.matches),
            (Some(10), Some(3500), None, None)
        );
    }

    /// FACEIT is asked only when Steam is, and only for an account Steam has.
    #[tokio::test]
    async fn faceit_is_not_asked_when_steam_fails() {
        let fake = Arc::new(Fake::default());
        *fake.fail.lock().unwrap() = true;
        let (_dir, cache) = cache(&fake);
        assert!(cache.get(ID).await.is_none());
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn without_a_key_nothing_calls_steam() {
        let dir = tempfile::tempdir().unwrap();
        let cache = ProfileCache::open(&dir.path().join("profiles"), None, None, None).unwrap();
        assert!(cache.get(ID).await.is_none());
        assert_eq!(cache.resolve_vanity("skunk").await, Ok(None));
    }

    /// A store holding a match for each of `matches` (the steamids playing it), and the
    /// hidden list naming `hide`.
    fn store_with(dir: &Path, matches: &[&[u64]], hide: &[u64]) -> (Arc<Store>, Arc<Hidden>) {
        let cfg = crate::config::Config {
            data_dir: dir.join("data"),
            ..Default::default()
        };
        let store = Store::open(&cfg).unwrap();
        for (n, ids) in matches.iter().enumerate() {
            store.matches().insert(crate::matches::MatchSummary {
                sha256: format!("sha{n}"),
                played_unix: Some(10 + n as u64),
                players: ids
                    .iter()
                    .map(|id| crate::matches::SummaryPlayer {
                        steamid: id.to_string(),
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            });
        }
        let list = dir.join("hidden.json");
        std::fs::write(
            &list,
            serde_json::to_string(&hide.iter().map(u64::to_string).collect::<Vec<_>>()).unwrap(),
        )
        .unwrap();
        (Arc::new(store), Arc::new(Hidden::open(&list)))
    }

    #[tokio::test(start_paused = true)]
    async fn the_warmer_fetches_every_indexed_player_once() {
        let fake = Arc::new(Fake::default());
        let (dir, cache) = cache(&fake);
        let (a, b, hid) = (ID, ID + 1, ID + 2);
        let (store, hidden) = store_with(dir.path(), &[&[a, b, hid], &[b]], &[hid]);

        let first = warm_once(&cache, &store, &hidden).await;
        assert_eq!((first.fetched, first.failed), (2, 0));
        assert!(cache.peek(a).await.is_some() && cache.peek(b).await.is_some());
        assert!(
            cache.peek(hid).await.is_none(),
            "a hidden player is not fetched"
        );
        let calls = fake.calls();
        assert_eq!(
            calls,
            2 * 4,
            "four Steam calls for each of the two, none for the hidden"
        );
        assert_eq!(fake.faceits.load(Ordering::SeqCst), 2);

        let second = warm_once(&cache, &store, &hidden).await;
        assert_eq!((second.fetched, second.failed), (0, 0));
        assert_eq!(second.fresh, first.fetched);
        assert_eq!(fake.calls(), calls, "within the TTL nothing is asked");
    }

    #[tokio::test(start_paused = true)]
    async fn the_warmer_skips_a_failed_fetch_and_runs_on_its_own() {
        let fake = Arc::new(Fake::default());
        *fake.fail.lock().unwrap() = true;
        let (dir, cache) = cache(&fake);
        let (store, hidden) = store_with(dir.path(), &[&[ID, ID + 1]], &[]);
        let report = warm_once(&cache, &store, &hidden).await;
        assert_eq!((report.fetched, report.failed), (0, 2));

        *fake.fail.lock().unwrap() = false;
        spawn_warmer_with(
            Duration::ZERO,
            Duration::from_secs(3600),
            cache.clone(),
            store,
            hidden,
        );
        for _ in 0..50 {
            settle().await;
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(cache.peek(ID).await.is_some() && cache.peek(ID + 1).await.is_some());
    }

    #[tokio::test(start_paused = true)]
    async fn the_warmer_refreshes_stale_profiles_one_at_a_time_before_it_returns() {
        let fake = Arc::new(Fake::default());
        *fake.summary_delay.lock().unwrap() = Duration::from_secs(1);
        let (dir, cache) = cache(&fake);
        let (store, hidden) = store_with(dir.path(), &[&[ID, ID + 1]], &[]);
        warm_once(&cache, &store, &hidden).await;
        let before = fake.calls();
        let was = cache.peek(ID).await.unwrap().fetched_unix;

        tokio::time::advance(PROFILE_TTL + Duration::from_secs(1)).await;
        let report = warm_once(&cache, &store, &hidden).await;
        assert_eq!((report.fetched, report.failed, report.fresh), (2, 0, 0));
        assert_eq!(
            fake.calls() - before,
            2 * 4,
            "each refreshed, once, already"
        );
        assert_eq!(fake.most_in_flight.load(Ordering::SeqCst), 1);
        assert!(!cache.fetching(ID) && !cache.fetching(ID + 1));
        assert!(cache
            .peek_with_age(ID)
            .await
            .is_some_and(|(p, stale)| !stale && p.fetched_unix >= was));
    }

    #[tokio::test(start_paused = true)]
    async fn a_rate_limit_stops_the_warmer_and_leaves_the_rest_for_the_next_run() {
        let fake = Arc::new(Fake::default());
        *fake.rate_limited.lock().unwrap() = true;
        let (dir, cache) = cache(&fake);
        let (store, hidden) = store_with(dir.path(), &[&[ID, ID + 1, ID + 2], &[ID]], &[ID + 2]);
        let report = warm_once(&cache, &store, &hidden).await;
        assert_eq!((report.fetched, report.failed, report.skipped), (0, 1, 1));
        assert_eq!(fake.calls(), 1, "the second player was never asked");
        assert!(cache.peek(ID + 1).await.is_none());
    }
}
