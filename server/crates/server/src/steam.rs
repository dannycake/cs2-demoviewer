//! The Steam Web API, for the facts a profile shows that no demo holds (name, avatar, account
//! age, country, Steam level, bans, CS2 hours) and for custom URL names. Every call waits its
//! turn at one [`SteamGate`]: at most one call a second, a pause after Steam says 429, and
//! callers past [`MAX_GATE_WAITING`] turned away at once.
//!
//! The key travels in the query string, so no error carries a URL
//! (`reqwest::Error::without_url`) and nothing here logs one.

use std::fmt;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;
use url::Url;

/// Least time between the starts of two calls.
pub const STEAM_MIN_GAP: Duration = Duration::from_secs(1);
/// How long every call waits after Steam answers 429.
pub const STEAM_RATE_PAUSE: Duration = Duration::from_secs(5);
/// Callers that may wait for a turn; one more is turned away ([`SteamError::Busy`]).
pub const MAX_GATE_WAITING: usize = 30;
/// Where an avatar may be shown from: Steam's own image hosts, over https.
pub const AVATAR_HOSTS: [&str; 4] = [
    "avatars.steamstatic.com",
    "avatars.akamai.steamstatic.com",
    "avatars.fastly.steamstatic.com",
    "avatars.cloudflare.steamstatic.com",
];
const BASE: &str = "https://api.steampowered.com/";
const TIMEOUT: Duration = Duration::from_secs(10);
/// The most an avatar may weigh: Steam's full-size ones are a few tens of kilobytes.
const MAX_AVATAR_BYTES: usize = 512 * 1024;
/// How long an avatar may take: it holds up the profile's fetch.
const AVATAR_TIMEOUT: Duration = Duration::from_secs(5);

/// A Steam Web API key: 32 hex digits. Its `Debug` hides it, so a config printed whole does
/// not show it.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    pub fn new(key: &str) -> Option<ApiKey> {
        (key.len() == 32 && key.bytes().all(|b| b.is_ascii_hexdigit()))
            .then(|| ApiKey(key.to_owned()))
    }

    /// The key itself, for a request's query (never for a log or an error).
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(hidden)")
    }
}

/// Why a Steam call gave no answer. No variant holds the key, an auth code or a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SteamError {
    /// [`MAX_GATE_WAITING`] callers are already waiting.
    Busy,
    /// Steam answered 429; the gate is paused.
    RateLimited,
    /// No answer, or an error status.
    Unavailable(String),
    /// An answer that is not what Steam sends.
    BadAnswer,
}

impl fmt::Display for SteamError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SteamError::Busy => f.write_str("too many Steam lookups are waiting"),
            SteamError::RateLimited => f.write_str("Steam is rate limiting this server"),
            SteamError::Unavailable(why) => write!(f, "Steam did not answer: {why}"),
            SteamError::BadAnswer => f.write_str("Steam's answer was not understood"),
        }
    }
}

impl std::error::Error for SteamError {}

/// One queue for every Steam call ([`SteamGate::turn`]).
pub struct SteamGate {
    min_gap: Duration,
    /// When the next call may start; held while a caller waits for it, so callers go in turn.
    next: tokio::sync::Mutex<Instant>,
    paused_until: Mutex<Option<Instant>>,
    waiting: AtomicUsize,
}

impl SteamGate {
    pub fn new(min_gap: Duration) -> Arc<SteamGate> {
        Arc::new(SteamGate {
            min_gap,
            next: tokio::sync::Mutex::new(Instant::now()),
            paused_until: Mutex::new(None),
            waiting: AtomicUsize::new(0),
        })
    }

    /// Waits until a call may start: `min_gap` after the previous one started, and past any
    /// pause. Callers go in the order they came. `Err(Busy)` at once when
    /// [`MAX_GATE_WAITING`] are waiting already.
    pub async fn turn(&self) -> Result<(), SteamError> {
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= MAX_GATE_WAITING {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(SteamError::Busy);
        }
        let _waiting = Waiting(&self.waiting);
        let mut next = self.next.lock().await;
        loop {
            let paused = *self
                .paused_until
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let at = (*next).max(paused.unwrap_or(*next)).max(Instant::now());
            tokio::time::sleep_until(at).await;
            // A pause that came while this caller slept holds it too.
            let paused = *self
                .paused_until
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            if paused.is_none_or(|p| p <= Instant::now()) {
                *next = Instant::now() + self.min_gap;
                return Ok(());
            }
        }
    }

    /// Holds every caller for `d` from now (after a 429).
    pub fn pause(&self, d: Duration) {
        let until = Instant::now() + d;
        let mut paused = self
            .paused_until
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        *paused = Some(paused.map_or(until, |p| p.max(until)));
    }
}

/// Counts a caller out of [`SteamGate::turn`] however it leaves (a dropped future included).
struct Waiting<'a>(&'a AtomicUsize);

impl Drop for Waiting<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a profile shows of a Steam account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerSummary {
    pub name: String,
    /// The full-size avatar, only from [`AVATAR_HOSTS`].
    pub avatar: Option<String>,
    /// The year the account was made; none for a private profile.
    pub since_year: Option<u16>,
    /// ISO 3166 country code, when the profile shows one.
    pub country: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Bans {
    pub vac: u32,
    pub game: u32,
    /// Banned from Steam's community (profile comments, groups, the forums).
    pub community: bool,
    /// Kept from trading and the Community Market, or on probation before that.
    pub trade: Option<TradeBan>,
    /// Days since the last VAC or game ban; none without one.
    pub days_since_last: Option<u32>,
}

/// What Steam calls an economy ban: an account kept from trading, or on probation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TradeBan {
    Probation,
    Banned,
}

/// The CS2 an account has played.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Playtime {
    /// Whole hours, ever.
    pub hours: u32,
    /// Minutes in the last two weeks.
    pub recent_minutes: u32,
}

/// The Steam Web API client.
pub struct SteamApi {
    base: Url,
    key: ApiKey,
    gate: Arc<SteamGate>,
    http: reqwest::Client,
    /// Where avatars come from: `None`, their own addresses on [`AVATAR_HOSTS`]; a fake Steam
    /// serves them at their paths.
    images: Option<Url>,
}

impl SteamApi {
    pub fn new(key: ApiKey, gate: Arc<SteamGate>) -> SteamApi {
        let api = SteamApi::with_base(
            Url::parse(BASE).expect("the Steam API's address"),
            key,
            gate,
        );
        SteamApi {
            images: None,
            ..api
        }
    }

    /// [`SteamApi::new`] against another server (a test's fake Steam), avatars too.
    #[doc(hidden)]
    pub fn with_base(base: Url, key: ApiKey, gate: Arc<SteamGate>) -> SteamApi {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("an HTTP client");
        SteamApi {
            images: Some(base.clone()),
            base,
            key,
            gate,
            http,
        }
    }

    /// The image of the avatar at `url`, one of Steam's image hosts ([`steam_avatar`]); not
    /// the Web API, so not through the gate. [`SteamError::BadAnswer`] for an address off those
    /// hosts, an answer from elsewhere (a redirect), or one larger than an avatar.
    pub async fn avatar_image(&self, url: &str) -> Result<Vec<u8>, SteamError> {
        let url = steam_avatar(url).ok_or(SteamError::BadAnswer)?;
        let mut url = Url::parse(&url).map_err(|_| SteamError::BadAnswer)?;
        if let Some(fake) = &self.images {
            url = fake.join(url.path()).map_err(|_| SteamError::BadAnswer)?;
        }
        let unavailable = |e: reqwest::Error| SteamError::Unavailable(e.without_url().to_string());
        let answer = self
            .http
            .get(url)
            .timeout(AVATAR_TIMEOUT)
            .send()
            .await
            .map_err(unavailable)?;
        if self.images.is_none() && steam_avatar(answer.url().as_str()).is_none() {
            return Err(SteamError::BadAnswer);
        }
        let status = answer.status();
        if !status.is_success() {
            return Err(SteamError::Unavailable(format!("status {status}")));
        }
        crate::http::read_capped(answer, MAX_AVATAR_BYTES)
            .await
            .map_err(unavailable)?
            .ok_or(SteamError::BadAnswer)
    }

    /// The gate every Steam call of the server waits at.
    pub fn gate(&self) -> Arc<SteamGate> {
        self.gate.clone()
    }

    /// The account's public summary; `None` when Steam has no such account.
    pub async fn player_summary(&self, id: u64) -> Result<Option<PlayerSummary>, SteamError> {
        #[derive(Deserialize)]
        struct Answer {
            response: Players,
        }
        #[derive(Deserialize)]
        struct Players {
            players: Vec<Player>,
        }
        #[derive(Deserialize)]
        struct Player {
            personaname: String,
            #[serde(default)]
            avatarfull: Option<String>,
            #[serde(default)]
            timecreated: Option<u64>,
            #[serde(default)]
            loccountrycode: Option<String>,
        }
        let a: Answer = self
            .get(
                "ISteamUser/GetPlayerSummaries/v2/",
                &[("steamids", id.to_string())],
            )
            .await?;
        Ok(a.response
            .players
            .into_iter()
            .next()
            .map(|p| PlayerSummary {
                name: p.personaname,
                avatar: p.avatarfull.as_deref().and_then(steam_avatar),
                since_year: p.timecreated.map(year_of),
                country: p
                    .loccountrycode
                    .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase())),
            }))
    }

    /// The account's VAC, game, community and trade bans; `None` when Steam has no such
    /// account.
    pub async fn player_bans(&self, id: u64) -> Result<Option<Bans>, SteamError> {
        #[derive(Deserialize)]
        struct Answer {
            players: Vec<Player>,
        }
        #[derive(Deserialize)]
        struct Player {
            #[serde(rename = "NumberOfVACBans")]
            vac: u32,
            #[serde(rename = "NumberOfGameBans")]
            game: u32,
            #[serde(rename = "CommunityBanned", default)]
            community: bool,
            /// `none`, `probation` or `banned`.
            #[serde(rename = "EconomyBan", default)]
            economy: String,
            #[serde(rename = "DaysSinceLastBan", default)]
            days: u32,
        }
        let a: Answer = self
            .get(
                "ISteamUser/GetPlayerBans/v1/",
                &[("steamids", id.to_string())],
            )
            .await?;
        Ok(a.players.into_iter().next().map(|p| Bans {
            vac: p.vac,
            game: p.game,
            community: p.community,
            trade: match p.economy.as_str() {
                "probation" => Some(TradeBan::Probation),
                "banned" => Some(TradeBan::Banned),
                _ => None,
            },
            days_since_last: (p.vac > 0 || p.game > 0).then_some(p.days),
        }))
    }

    /// The account's Steam level; `None` when its profile is private.
    pub async fn steam_level(&self, id: u64) -> Result<Option<u32>, SteamError> {
        #[derive(Deserialize)]
        struct Answer {
            response: Level,
        }
        #[derive(Deserialize)]
        struct Level {
            #[serde(default)]
            player_level: Option<u32>,
        }
        let a: Answer = self
            .get(
                "IPlayerService/GetSteamLevel/v1/",
                &[("steamid", id.to_string())],
            )
            .await?;
        Ok(a.response.player_level)
    }

    /// The CS2 the account has played; `None` when its games are private (or it has no CS2).
    pub async fn cs2_playtime(&self, id: u64) -> Result<Option<Playtime>, SteamError> {
        #[derive(Deserialize)]
        struct Answer {
            response: Owned,
        }
        #[derive(Deserialize)]
        struct Owned {
            #[serde(default)]
            games: Vec<Game>,
        }
        #[derive(Deserialize)]
        struct Game {
            appid: u32,
            playtime_forever: u32,
            /// Left out for a game not played in the last two weeks.
            #[serde(default)]
            playtime_2weeks: u32,
        }
        let a: Answer = self
            .get(
                "IPlayerService/GetOwnedGames/v1/",
                &[
                    ("steamid", id.to_string()),
                    ("appids_filter[0]", "730".into()),
                    ("include_played_free_games", "1".into()),
                ],
            )
            .await?;
        let cs2 = a.response.games.into_iter().find(|g| g.appid == 730);
        Ok(cs2.map(|g| Playtime {
            hours: g.playtime_forever / 60,
            recent_minutes: g.playtime_2weeks,
        }))
    }

    /// The steamid of a custom URL name; `None` when no account has it.
    pub async fn resolve_vanity(&self, name: &str) -> Result<Option<u64>, SteamError> {
        #[derive(Deserialize)]
        struct Answer {
            response: Resolved,
        }
        #[derive(Deserialize)]
        struct Resolved {
            success: u32,
            #[serde(default)]
            steamid: Option<String>,
        }
        let a: Answer = self
            .get(
                "ISteamUser/ResolveVanityURL/v1/",
                &[("vanityurl", name.to_owned())],
            )
            .await?;
        match (a.response.success, a.response.steamid) {
            (1, Some(id)) => id.parse().map(Some).map_err(|_| SteamError::BadAnswer),
            (42, _) => Ok(None),
            _ => Err(SteamError::BadAnswer),
        }
    }

    /// One call, in its turn at the gate.
    async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<T, SteamError> {
        self.gate.turn().await?;
        let mut url = self.base.join(path).map_err(|_| SteamError::BadAnswer)?;
        {
            let mut q = url.query_pairs_mut();
            q.append_pair("key", &self.key.0);
            for (k, v) in query {
                q.append_pair(k, v);
            }
        }
        let unavailable = |e: reqwest::Error| SteamError::Unavailable(e.without_url().to_string());
        let answer = self.http.get(url).send().await.map_err(unavailable)?;
        let status = answer.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            self.gate.pause(STEAM_RATE_PAUSE);
            return Err(SteamError::RateLimited);
        }
        if !status.is_success() {
            return Err(SteamError::Unavailable(format!("status {status}")));
        }
        let body = answer.bytes().await.map_err(unavailable)?;
        serde_json::from_slice(&body).map_err(|_| SteamError::BadAnswer)
    }
}

/// `url` when it is an https image on one of [`AVATAR_HOSTS`].
pub fn steam_avatar(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let on_steam = parsed.scheme() == "https"
        && parsed.port().is_none()
        && parsed.host_str().is_some_and(|h| AVATAR_HOSTS.contains(&h));
    on_steam.then(|| url.to_owned())
}

/// The UTC year of a unix time.
fn year_of(unix: u64) -> u16 {
    // Howard Hinnant's civil-from-days.
    let days = i64::try_from(unix / 86_400).unwrap_or(i64::MAX / 2) + 719_468;
    let era = days.div_euclid(146_097);
    let doe = days.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    u16::try_from(year).unwrap_or(u16::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::StatusCode;
    use axum::routing::get;
    use axum::Router;
    use tokio::time::Instant;

    const KEY: &str = "0123456789abcdef0123456789abcdef";
    const ID: u64 = 76561198000000001;

    #[tokio::test(start_paused = true)]
    async fn calls_are_at_least_a_second_apart() {
        let gate = SteamGate::new(STEAM_MIN_GAP);
        let start = Instant::now();
        let mut at = Vec::new();
        for _ in 0..5 {
            gate.turn().await.unwrap();
            at.push(start.elapsed().as_secs());
        }
        assert_eq!(at, [0, 1, 2, 3, 4]);
    }

    #[tokio::test(start_paused = true)]
    async fn a_pause_holds_every_caller() {
        let gate = SteamGate::new(STEAM_MIN_GAP);
        let start = Instant::now();
        gate.turn().await.unwrap();
        gate.pause(STEAM_RATE_PAUSE);
        let (a, b) = tokio::join!(gate.turn(), gate.turn());
        a.unwrap();
        b.unwrap();
        assert_eq!(start.elapsed().as_secs(), 6, "5 s paused, then 1 s apart");
    }

    #[tokio::test]
    async fn the_thirty_first_waiter_is_turned_away() {
        let gate = SteamGate::new(Duration::from_secs(3600));
        gate.turn().await.unwrap();
        let waiting: Vec<_> = (0..MAX_GATE_WAITING)
            .map(|_| {
                let gate = gate.clone();
                tokio::spawn(async move { gate.turn().await })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(matches!(gate.turn().await, Err(SteamError::Busy)));
        for w in waiting {
            w.abort();
        }
    }

    /// A fake Steam answering `routes`, and a client of it with no gap between calls.
    async fn fake(routes: Router) -> SteamApi {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
        SteamApi::with_base(
            Url::parse(&base).unwrap(),
            ApiKey::new(KEY).unwrap(),
            SteamGate::new(Duration::ZERO),
        )
    }

    fn json(body: &'static str) -> axum::routing::MethodRouter {
        get(move || async move { ([("content-type", "application/json")], body) })
    }

    #[tokio::test]
    async fn a_public_profile_parses() {
        let api = fake(
            Router::new()
                .route(
                    "/ISteamUser/GetPlayerSummaries/v2/",
                    json(
                        r#"{"response":{"players":[{"steamid":"76561198000000001","personaname":"skunk",
                        "avatarfull":"https://avatars.steamstatic.com/abc_full.jpg","communityvisibilitystate":3,
                        "timecreated":1063407589,"loccountrycode":"US"}]}}"#,
                    ),
                )
                .route(
                    "/IPlayerService/GetOwnedGames/v1/",
                    json(
                        r#"{"response":{"game_count":1,"games":[{"appid":730,"playtime_forever":6059,
                        "playtime_2weeks":725}]}}"#,
                    ),
                )
                .route(
                    "/IPlayerService/GetSteamLevel/v1/",
                    json(r#"{"response":{"player_level":42}}"#),
                ),
        )
        .await;
        let s = api.player_summary(ID).await.unwrap().unwrap();
        assert_eq!(
            s,
            PlayerSummary {
                name: "skunk".into(),
                avatar: Some("https://avatars.steamstatic.com/abc_full.jpg".into()),
                since_year: Some(2003),
                country: Some("US".into()),
            }
        );
        assert_eq!(
            api.cs2_playtime(ID).await.unwrap(),
            Some(Playtime {
                hours: 100,
                recent_minutes: 725
            })
        );
        assert_eq!(api.steam_level(ID).await.unwrap(), Some(42));
    }

    /// Steam leaves out the last two weeks' playtime of a game not played in them.
    #[tokio::test]
    async fn cs2_not_played_lately_is_no_minutes_in_two_weeks() {
        let api = fake(Router::new().route(
            "/IPlayerService/GetOwnedGames/v1/",
            json(r#"{"response":{"game_count":1,"games":[{"appid":730,"playtime_forever":59}]}}"#),
        ))
        .await;
        assert_eq!(
            api.cs2_playtime(ID).await.unwrap(),
            Some(Playtime {
                hours: 0,
                recent_minutes: 0
            })
        );
    }

    #[tokio::test]
    async fn a_private_profile_parses_with_its_missing_facts_as_none() {
        let api = fake(
            Router::new()
                .route(
                    "/ISteamUser/GetPlayerSummaries/v2/",
                    json(
                        r#"{"response":{"players":[{"steamid":"76561198000000001","personaname":"x",
                        "avatarfull":"https://avatars.steamstatic.com/abc_full.jpg","communityvisibilitystate":1}]}}"#,
                    ),
                )
                .route("/IPlayerService/GetOwnedGames/v1/", json(r#"{"response":{}}"#))
                .route("/IPlayerService/GetSteamLevel/v1/", json(r#"{"response":{}}"#))
                .route(
                    "/ISteamUser/GetPlayerBans/v1/",
                    json(
                        r#"{"players":[{"SteamId":"76561198000000001","CommunityBanned":false,"VACBanned":true,
                        "NumberOfVACBans":1,"DaysSinceLastBan":40,"NumberOfGameBans":2,"EconomyBan":"none"}]}"#,
                    ),
                ),
        )
        .await;
        let s = api.player_summary(ID).await.unwrap().unwrap();
        assert_eq!((s.since_year, s.country), (None, None));
        assert_eq!(api.cs2_playtime(ID).await.unwrap(), None);
        assert_eq!(api.steam_level(ID).await.unwrap(), None);
        assert_eq!(
            api.player_bans(ID).await.unwrap(),
            Some(Bans {
                vac: 1,
                game: 2,
                community: false,
                trade: None,
                days_since_last: Some(40),
            })
        );
    }

    /// A community ban and a trade ban or probation are named; the days since the last ban are
    /// kept only with a VAC or game ban, which they count from (Steam says 0 without one).
    #[tokio::test]
    async fn community_and_trade_bans_are_named() {
        let api = fake(Router::new().route(
            "/ISteamUser/GetPlayerBans/v1/",
            get(
                |q: axum::extract::Query<std::collections::HashMap<String, String>>| async move {
                    let (community, economy) = match q.get("steamids").map(String::as_str) {
                        Some("76561198000000001") => ("true", "probation"),
                        _ => ("false", "banned"),
                    };
                    let body = format!(
                        r#"{{"players":[{{"SteamId":"x","CommunityBanned":{community},"VACBanned":false,
                        "NumberOfVACBans":0,"DaysSinceLastBan":0,"NumberOfGameBans":0,
                        "EconomyBan":"{economy}"}}]}}"#
                    );
                    ([("content-type", "application/json")], body)
                },
            ),
        ))
        .await;
        assert_eq!(
            api.player_bans(ID).await.unwrap(),
            Some(Bans {
                vac: 0,
                game: 0,
                community: true,
                trade: Some(TradeBan::Probation),
                days_since_last: None,
            })
        );
        let other = api.player_bans(ID + 1).await.unwrap().unwrap();
        assert_eq!(
            (other.community, other.trade),
            (false, Some(TradeBan::Banned))
        );
    }

    #[tokio::test]
    async fn an_unknown_account_is_none() {
        let api = fake(
            Router::new()
                .route(
                    "/ISteamUser/GetPlayerSummaries/v2/",
                    json(r#"{"response":{"players":[]}}"#),
                )
                .route("/ISteamUser/GetPlayerBans/v1/", json(r#"{"players":[]}"#)),
        )
        .await;
        assert_eq!(api.player_summary(ID).await.unwrap(), None);
        assert_eq!(api.player_bans(ID).await.unwrap(), None);
    }

    #[tokio::test]
    async fn an_unknown_vanity_resolves_to_none() {
        let api = fake(Router::new().route(
            "/ISteamUser/ResolveVanityURL/v1/",
            get(
                |q: axum::extract::Query<std::collections::HashMap<String, String>>| async move {
                    let body = if q.get("vanityurl").map(String::as_str) == Some("skunk") {
                        r#"{"response":{"steamid":"76561198000000001","success":1}}"#
                    } else {
                        r#"{"response":{"success":42,"message":"No match"}}"#
                    };
                    ([("content-type", "application/json")], body)
                },
            ),
        ))
        .await;
        assert_eq!(api.resolve_vanity("skunk").await.unwrap(), Some(ID));
        assert_eq!(api.resolve_vanity("nobody-here").await.unwrap(), None);
    }

    #[tokio::test]
    async fn a_429_pauses_the_gate_and_says_so() {
        let api = fake(Router::new().route(
            "/ISteamUser/GetPlayerBans/v1/",
            get(|| async { StatusCode::TOO_MANY_REQUESTS }),
        ))
        .await;
        assert!(matches!(
            api.player_bans(ID).await,
            Err(SteamError::RateLimited)
        ));
        let next = tokio::time::timeout(Duration::from_millis(500), api.gate.turn()).await;
        assert!(next.is_err(), "the gate is paused");
    }

    #[tokio::test]
    async fn errors_carry_no_key() {
        // A server that drops every connection.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let (conn, _) = listener.accept().await.unwrap();
                drop(conn);
            }
        });
        let api = SteamApi::with_base(
            Url::parse(&base).unwrap(),
            ApiKey::new(KEY).unwrap(),
            SteamGate::new(Duration::ZERO),
        );
        let err = api.player_summary(ID).await.unwrap_err();
        assert!(matches!(err, SteamError::Unavailable(_)), "{err:?}");
        for shown in [err.to_string(), format!("{err:?}")] {
            assert!(!shown.contains(KEY), "{shown}");
            assert!(!shown.contains("key="), "{shown}");
            assert!(!shown.contains("http"), "{shown}");
        }
        let key = ApiKey::new(KEY).unwrap();
        assert!(!format!("{key:?}").contains(KEY));
    }

    #[test]
    fn a_key_is_32_hex_digits() {
        assert!(ApiKey::new(KEY).is_some());
        assert!(ApiKey::new(&KEY[1..]).is_none());
        assert!(ApiKey::new("0123456789abcdef0123456789abcdeg").is_none());
    }

    #[test]
    fn an_avatar_off_steams_hosts_is_dropped() {
        for ok in AVATAR_HOSTS {
            let url = format!("https://{ok}/abc_full.jpg");
            assert_eq!(steam_avatar(&url), Some(url.clone()));
        }
        for bad in [
            "https://evil.example/abc_full.jpg",
            "http://avatars.steamstatic.com/abc_full.jpg",
            "https://avatars.steamstatic.com.evil.example/a.jpg",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(steam_avatar(bad), None, "{bad}");
        }
    }

    /// An avatar is fetched only from Steam's image hosts (a fake Steam serves it at its path),
    /// and one larger than an avatar is refused.
    #[tokio::test]
    async fn avatars_come_from_steams_image_hosts_and_are_small() {
        let api = fake(
            Router::new()
                .route("/abc_full.jpg", get(|| async { "jpeg" }))
                .route(
                    "/huge_full.jpg",
                    get(|| async { vec![0u8; MAX_AVATAR_BYTES + 1] }),
                ),
        )
        .await;
        let steam = |path: &str| format!("https://avatars.steamstatic.com/{path}");
        assert_eq!(
            api.avatar_image(&steam("abc_full.jpg")).await.unwrap(),
            b"jpeg"
        );
        for (url, why) in [
            ("https://evil.example/abc_full.jpg".to_owned(), "off Steam"),
            (steam("huge_full.jpg"), "too large"),
        ] {
            let err = api.avatar_image(&url).await.unwrap_err();
            assert!(matches!(err, SteamError::BadAnswer), "{why}: {err:?}");
        }
        let err = api.avatar_image(&steam("none.jpg")).await.unwrap_err();
        assert!(matches!(err, SteamError::Unavailable(_)), "{err:?}");
    }

    /// An avatar that never says its length and never ends is turned away once it passes the
    /// cap, not held whole until the timeout.
    #[tokio::test]
    async fn an_endless_avatar_is_turned_away_at_the_cap() {
        use std::convert::Infallible;

        use axum::body::{Body, Bytes};

        let api = fake(Router::new().route(
            "/endless_full.jpg",
            get(|| async {
                let chunk = Bytes::from(vec![0u8; 16 * 1024]);
                let endless =
                    futures_util::stream::repeat_with(move || Ok::<_, Infallible>(chunk.clone()));
                Body::from_stream(endless)
            }),
        ))
        .await;
        let t0 = Instant::now();
        let err = api
            .avatar_image("https://avatars.steamstatic.com/endless_full.jpg")
            .await
            .unwrap_err();
        assert!(matches!(err, SteamError::BadAnswer), "{err:?}");
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
    }

    #[test]
    fn years_come_from_unix_times() {
        assert_eq!(year_of(0), 1970);
        assert_eq!(year_of(1063407589), 2003);
        assert_eq!(year_of(1704067199), 2023); // 2023-12-31 23:59:59
        assert_eq!(year_of(1704067200), 2024);
    }
}
