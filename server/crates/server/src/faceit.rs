//! FACEIT's account of a Steam account, for a profile's link to it: the nickname its address is
//! made of, the CS2 skill level and Elo, and with a key the lifetime win rate and match count.
//!
//! With a key ([`FaceitKey`]) FACEIT's Data API answers ([`FaceitDataApi`], behind
//! [`FaceitData`]): a player by steamid or nickname, their lifetime stats, their match history and
//! a match in detail. Every call waits its turn at a gate of its own ([`FACEIT_MIN_GAP`] apart, a
//! 429 pausing it), and the key travels only in the `Authorization` header, so no error carries
//! it. Without a key FACEIT's own site API is asked ([`FaceitApi`]), an unofficial endpoint, for
//! the nickname, level and Elo alone.
//!
//! Both fail soft: no answer in [`TIMEOUT`], an error status or an answer of another shape is an
//! error ([`FaceitError`]), which a profile shrugs off ([`crate::profiles`]). Asked with Steam's
//! facts and for the one input's nickname lookup, never for a page or a crawler.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

use crate::gcbot::BoxFuture;
use crate::http::read_capped;
use crate::identity::individual_steamid;
use crate::steam::SteamGate;

/// Where FACEIT's site API answers.
pub const FACEIT_API: &str = "https://api.faceit.com/";
/// Where FACEIT's Data API answers.
pub const FACEIT_DATA_API: &str = "https://open.faceit.com/data/v4/";
/// Least time between the starts of two Data API calls: FACEIT does not publish its limit, so
/// one a second until it is measured.
pub const FACEIT_MIN_GAP: Duration = Duration::from_secs(1);
/// How long every Data API call waits after FACEIT answers 429.
pub const FACEIT_RATE_PAUSE: Duration = Duration::from_secs(5);
/// The most matches one history call asks for: FACEIT's own cap.
pub const MAX_HISTORY_LIMIT: u32 = 100;
/// How long FACEIT may take: it is asked beside Steam's facts and holds up their fetch.
const TIMEOUT: Duration = Duration::from_secs(5);
/// The API answers browsers; a client that does not say it is one may be turned away.
const USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";
/// The most an answer may weigh: one account's is about 7 KB.
const MAX_ANSWER_BYTES: usize = 256 * 1024;
/// The most a Data API answer may weigh: a history of [`MAX_HISTORY_LIMIT`] matches is a few
/// hundred kilobytes.
const MAX_DATA_BYTES: usize = 2 * 1024 * 1024;
/// The longest nickname kept: FACEIT's are 3 to 12 characters.
const MAX_NICKNAME: usize = 32;
/// The longest FACEIT id kept (a player's is a UUID, a match's `1-` and one).
const MAX_ID: usize = 64;
/// The longest competition name kept.
const MAX_COMPETITION: usize = 100;
/// The longest map name kept (`de_mirage`).
const MAX_MAP: usize = 64;

/// A FACEIT account and its CS2 standing, kept with a profile (`profiles/<steamid>.json`) and
/// shown on it. `None` facts FACEIT did not give (an account that has not played CS2 there),
/// and those only the Data API gives when it was not asked (no key) or the profile was kept
/// before it was.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Faceit {
    /// The account's name, which its profile's address is made of.
    pub nickname: String,
    /// The CS2 skill level, 1 to 10.
    pub level: Option<u8>,
    /// The CS2 Elo.
    pub elo: Option<u32>,
    /// FACEIT's id of the player, which their history is asked by.
    #[serde(default)]
    pub player_id: Option<String>,
    /// The share of their CS2 matches won, in percent.
    #[serde(default)]
    pub wins_pct: Option<f32>,
    /// How many CS2 matches they have played there.
    #[serde(default)]
    pub matches: Option<u32>,
}

/// Why FACEIT gave no answer. No variant holds the key or a URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FaceitError {
    /// No answer in time, or an error status.
    Unavailable(String),
    /// An answer that is not what FACEIT sends.
    BadAnswer,
    /// FACEIT turned the key away (401 or 403): revoked, or never one.
    Unauthorized,
    /// FACEIT answered 429; the gate is paused for [`FACEIT_RATE_PAUSE`].
    RateLimited,
}

impl fmt::Display for FaceitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FaceitError::Unavailable(why) => write!(f, "FACEIT did not answer: {why}"),
            FaceitError::BadAnswer => f.write_str("FACEIT's answer was not understood"),
            FaceitError::Unauthorized => f.write_str("FACEIT turned this server's key away"),
            FaceitError::RateLimited => f.write_str("FACEIT is rate limiting this server"),
        }
    }
}

impl std::error::Error for FaceitError {}

/// Where a profile's FACEIT account comes from without a key: [`FaceitApi`], or a test's fake.
#[doc(hidden)]
pub trait FaceitSource: Send + Sync {
    /// [`FaceitApi::account`].
    fn account(&self, id: u64) -> BoxFuture<'_, Result<Option<Faceit>, FaceitError>>;
}

/// A FACEIT Data API key. FACEIT's are UUIDs; any 8 to 128 printable ASCII characters without
/// whitespace are taken as one. Its `Debug` hides it, so a config printed whole does not show
/// it.
#[derive(Clone, PartialEq, Eq)]
pub struct FaceitKey(String);

impl FaceitKey {
    /// `key` as a key; `None` when it is not shaped like one.
    pub fn new(key: &str) -> Option<FaceitKey> {
        ((8..=128).contains(&key.len()) && key.bytes().all(|b| b.is_ascii_graphic()))
            .then(|| FaceitKey(key.to_owned()))
    }

    /// The key itself, for a request's `Authorization` header (never for a log or an error).
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for FaceitKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("FaceitKey(hidden)")
    }
}

/// A FACEIT player, as the Data API gives them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceitPlayer {
    /// FACEIT's id of the player, which their stats and history are asked by.
    pub player_id: String,
    /// Their name, which their profile's address is made of.
    pub nickname: String,
    /// The Steam account they play CS2 on; `None` when FACEIT names none.
    pub steamid: Option<u64>,
    /// The CS2 skill level, 1 to 10.
    pub level: Option<u8>,
    /// The CS2 Elo.
    pub elo: Option<u32>,
}

/// A player's lifetime CS2 stats on FACEIT: only the two a profile shows.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceitLifetime {
    /// How many matches they have played.
    pub matches: Option<u32>,
    /// The share of them won, in percent.
    pub wins_pct: Option<f32>,
}

/// One match of a player's FACEIT history, told from their side.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceitHistoryItem {
    /// FACEIT's id of the match.
    pub match_id: String,
    /// When it finished, in unix seconds.
    pub finished_unix: u64,
    /// The competition it was played in (`CS2 5v5`, a hub's or a league's name).
    pub competition: Option<String>,
    /// Their team's score, then the other's; `None` with no result, or when they are on
    /// neither team.
    pub score: Option<[u8; 2]>,
    /// Whether their team won; `None` as for `score`.
    pub won: Option<bool>,
    /// The steamids of everyone in it FACEIT names one for, the first team's first.
    pub players: Vec<u64>,
}

/// A FACEIT match in detail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceitMatchDetail {
    /// The map picked (`de_mirage`).
    pub map: Option<String>,
    /// Where its demo may be downloaded: the http(s) addresses FACEIT gives, none before it
    /// has one.
    pub demo_urls: Vec<String>,
    /// The steamids of everyone in it FACEIT names one for, the first team's first.
    pub players: Vec<u64>,
    /// The first team's score, then the second's; `None` with no result.
    pub score: Option<[u8; 2]>,
    /// When it finished, in unix seconds; `None` before it has.
    pub finished_unix: Option<u64>,
}

/// What FACEIT's Data API answers: [`FaceitDataApi`], or a test's fake. Every `Option` is
/// `None` for a player or match FACEIT has none of.
pub trait FaceitData: Send + Sync {
    /// The player whose CS2 is played on Steam account `steamid`.
    fn player_by_steamid(
        &self,
        steamid: u64,
    ) -> BoxFuture<'_, Result<Option<FaceitPlayer>, FaceitError>>;
    /// The player called `name` (any case).
    fn player_by_nickname<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitPlayer>, FaceitError>>;
    /// The lifetime CS2 stats of the player `player_id`.
    fn lifetime_stats<'a>(
        &'a self,
        player_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitLifetime>, FaceitError>>;
    /// The CS2 matches of the player `player_id` since `from_unix`, newest first, at most
    /// `limit` (and [`MAX_HISTORY_LIMIT`]); none for a player FACEIT does not have.
    fn history<'a>(
        &'a self,
        player_id: &'a str,
        from_unix: u64,
        limit: u32,
    ) -> BoxFuture<'a, Result<Vec<FaceitHistoryItem>, FaceitError>>;
    /// The match `match_id` in detail.
    fn match_detail<'a>(
        &'a self,
        match_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitMatchDetail>, FaceitError>>;
}

/// FACEIT's site API, asked without a key.
pub struct FaceitApi {
    base: Url,
    http: reqwest::Client,
}

impl FaceitApi {
    /// The API at `base`: [`FACEIT_API`], or a test's fake FACEIT.
    pub fn new(base: Url) -> FaceitApi {
        FaceitApi::with_timeout(base, TIMEOUT)
    }

    fn with_timeout(base: Url, timeout: Duration) -> FaceitApi {
        let http = reqwest::Client::builder()
            .timeout(timeout)
            .user_agent(USER_AGENT)
            .build()
            .expect("an HTTP client");
        FaceitApi { base, http }
    }

    /// The FACEIT account of Steam account `id`; `None` when it has none.
    pub async fn account(&self, id: u64) -> Result<Option<Faceit>, FaceitError> {
        let mut url = self
            .base
            .join("users/v1/users")
            .map_err(|_| FaceitError::BadAnswer)?;
        // Without `game`, FACEIT leaves out `game_id` and lists anyone.
        url.query_pairs_mut()
            .append_pair("game_id", &id.to_string())
            .append_pair("game", "cs2");
        let unavailable = |e: reqwest::Error| FaceitError::Unavailable(e.without_url().to_string());
        let answer = self.http.get(url).send().await.map_err(unavailable)?;
        let status = answer.status();
        if !status.is_success() {
            return Err(FaceitError::Unavailable(format!("status {status}")));
        }
        let body = read_capped(answer, MAX_ANSWER_BYTES)
            .await
            .map_err(unavailable)?
            .ok_or(FaceitError::BadAnswer)?;
        let answer: Value = serde_json::from_slice(&body).map_err(|_| FaceitError::BadAnswer)?;
        account_of(id, &answer)
    }
}

/// The account of `id` in FACEIT's answer: `{"result":"OK"}` alone when it has none, else the
/// accounts in `payload`, of which only one whose CS2 id or Steam account is `id` counts.
fn account_of(id: u64, answer: &Value) -> Result<Option<Faceit>, FaceitError> {
    if answer.get("result").and_then(Value::as_str) != Some("OK") {
        return Err(FaceitError::BadAnswer);
    }
    let accounts = match answer.get("payload") {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Array(accounts)) => accounts,
        Some(_) => return Err(FaceitError::BadAnswer),
    };
    let is_id = |v: Option<&Value>| match v {
        Some(Value::String(s)) => s.parse() == Ok(id),
        Some(Value::Number(n)) => n.as_u64() == Some(id),
        _ => false,
    };
    let Some(account) = accounts.iter().find(|a| {
        is_id(a.pointer("/games/cs2/game_id")) || is_id(a.pointer("/platforms/steam/id64"))
    }) else {
        return Ok(None);
    };
    let nickname = account
        .get("nickname")
        .and_then(Value::as_str)
        .filter(|n| {
            !n.is_empty() && n.chars().count() <= MAX_NICKNAME && !n.chars().any(char::is_control)
        })
        .ok_or(FaceitError::BadAnswer)?;
    let cs2 = account.pointer("/games/cs2");
    let level = cs2
        .and_then(|g| g.get("skill_level"))
        .and_then(Value::as_u64)
        .and_then(|l| u8::try_from(l).ok())
        .filter(|l| (1..=10).contains(l));
    let elo = cs2
        .and_then(|g| g.get("faceit_elo"))
        .and_then(Value::as_u64)
        .and_then(|e| u32::try_from(e).ok())
        .filter(|&e| e > 0);
    Ok(Some(Faceit {
        nickname: nickname.to_owned(),
        level,
        elo,
        player_id: None,
        wins_pct: None,
        matches: None,
    }))
}

impl FaceitSource for FaceitApi {
    fn account(&self, id: u64) -> BoxFuture<'_, Result<Option<Faceit>, FaceitError>> {
        Box::pin(FaceitApi::account(self, id))
    }
}

/// FACEIT's Data API, asked with a key through a gate of its own.
pub struct FaceitDataApi {
    base: Url,
    /// `Bearer <key>`, marked sensitive so it is never printed.
    auth: HeaderValue,
    gate: Arc<SteamGate>,
    http: reqwest::Client,
}

impl FaceitDataApi {
    /// The API at `base` ([`FACEIT_DATA_API`], or a test's fake) with `key`, each call waiting
    /// its turn at `gate` (one of FACEIT's own, [`FACEIT_MIN_GAP`] apart).
    pub fn new(base: Url, key: FaceitKey, gate: Arc<SteamGate>) -> FaceitDataApi {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("an HTTP client");
        // A key is printable ASCII, which a header value always takes.
        let mut auth = HeaderValue::from_str(&format!("Bearer {}", key.expose()))
            .expect("a FACEIT key is printable ASCII");
        auth.set_sensitive(true);
        FaceitDataApi {
            base,
            auth,
            gate,
            http,
        }
    }

    /// The answer at `path` (with `query`) as JSON, after waiting a turn at the gate; `None`
    /// for a 404, FACEIT's answer for a player or match it does not have.
    async fn get(&self, path: &str, query: &[(&str, &str)]) -> Result<Option<Value>, FaceitError> {
        let mut url = self.base.join(path).map_err(|_| FaceitError::BadAnswer)?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query);
        }
        self.gate
            .turn()
            .await
            .map_err(|_| FaceitError::Unavailable("too many FACEIT calls are waiting".into()))?;
        let unavailable = |e: reqwest::Error| FaceitError::Unavailable(e.without_url().to_string());
        let answer = self
            .http
            .get(url)
            .header(AUTHORIZATION, self.auth.clone())
            .send()
            .await
            .map_err(unavailable)?;
        match answer.status().as_u16() {
            200..=299 => {}
            401 | 403 => return Err(FaceitError::Unauthorized),
            404 => return Ok(None),
            429 => {
                self.gate.pause(FACEIT_RATE_PAUSE);
                return Err(FaceitError::RateLimited);
            }
            status => return Err(FaceitError::Unavailable(format!("status {status}"))),
        }
        let body = read_capped(answer, MAX_DATA_BYTES)
            .await
            .map_err(unavailable)?
            .ok_or(FaceitError::BadAnswer)?;
        serde_json::from_slice(&body)
            .map(Some)
            .map_err(|_| FaceitError::BadAnswer)
    }

    /// [`FaceitData::player_by_steamid`]: only a player whose CS2 or Steam account is
    /// `steamid` counts.
    pub async fn player_by_steamid(
        &self,
        steamid: u64,
    ) -> Result<Option<FaceitPlayer>, FaceitError> {
        let id = steamid.to_string();
        let Some(answer) = self
            .get("players", &[("game", "cs2"), ("game_player_id", &id)])
            .await?
        else {
            return Ok(None);
        };
        let player = player_of(&answer)?;
        let theirs = [
            answer.pointer("/games/cs2/game_player_id"),
            answer.get("steam_id_64"),
        ]
        .into_iter()
        .any(|v| v.and_then(Value::as_str) == Some(id.as_str()));
        Ok(theirs.then_some(player))
    }

    /// [`FaceitData::player_by_nickname`]: only a player of that name (any case) counts.
    pub async fn player_by_nickname(
        &self,
        name: &str,
    ) -> Result<Option<FaceitPlayer>, FaceitError> {
        let Some(answer) = self.get("players", &[("nickname", name)]).await? else {
            return Ok(None);
        };
        let player = player_of(&answer)?;
        Ok(player.nickname.eq_ignore_ascii_case(name).then_some(player))
    }

    /// [`FaceitData::lifetime_stats`]; `None`, without a call, for an id not shaped like
    /// FACEIT's.
    pub async fn lifetime_stats(
        &self,
        player_id: &str,
    ) -> Result<Option<FaceitLifetime>, FaceitError> {
        if !faceit_id(player_id) {
            return Ok(None);
        }
        match self
            .get(&format!("players/{player_id}/stats/cs2"), &[])
            .await?
        {
            Some(answer) => lifetime_of(&answer).map(Some),
            None => Ok(None),
        }
    }

    /// [`FaceitData::history`]; none, without a call, for an id not shaped like FACEIT's. A
    /// match without an id or a time it finished is left out.
    pub async fn history(
        &self,
        player_id: &str,
        from_unix: u64,
        limit: u32,
    ) -> Result<Vec<FaceitHistoryItem>, FaceitError> {
        if !faceit_id(player_id) {
            return Ok(Vec::new());
        }
        let (from, limit) = (
            from_unix.to_string(),
            limit.clamp(1, MAX_HISTORY_LIMIT).to_string(),
        );
        let Some(answer) = self
            .get(
                &format!("players/{player_id}/history"),
                &[
                    ("game", "cs2"),
                    ("from", &from),
                    ("offset", "0"),
                    ("limit", &limit),
                ],
            )
            .await?
        else {
            return Ok(Vec::new());
        };
        let items = answer
            .get("items")
            .and_then(Value::as_array)
            .ok_or(FaceitError::BadAnswer)?;
        Ok(items
            .iter()
            .filter_map(|item| history_item_of(player_id, item))
            .collect())
    }

    /// [`FaceitData::match_detail`]; `None`, without a call, for an id not shaped like FACEIT's.
    pub async fn match_detail(
        &self,
        match_id: &str,
    ) -> Result<Option<FaceitMatchDetail>, FaceitError> {
        if !faceit_id(match_id) {
            return Ok(None);
        }
        let Some(answer) = self.get(&format!("matches/{match_id}"), &[]).await? else {
            return Ok(None);
        };
        if !answer.is_object() {
            return Err(FaceitError::BadAnswer);
        }
        let map = answer
            .pointer("/voting/map/pick/0")
            .and_then(Value::as_str)
            .filter(|m| {
                (1..=MAX_MAP).contains(&m.len())
                    && m.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
            })
            .map(str::to_owned);
        let demo_urls = answer
            .get("demo_url")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|u| Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "https" | "http")))
            .map(str::to_owned)
            .collect();
        Ok(Some(FaceitMatchDetail {
            map,
            demo_urls,
            players: steamids_of(&answer, "roster"),
            score: score_of(&answer),
            finished_unix: answer.get("finished_at").and_then(number),
        }))
    }
}

impl FaceitData for FaceitDataApi {
    fn player_by_steamid(
        &self,
        steamid: u64,
    ) -> BoxFuture<'_, Result<Option<FaceitPlayer>, FaceitError>> {
        Box::pin(FaceitDataApi::player_by_steamid(self, steamid))
    }
    fn player_by_nickname<'a>(
        &'a self,
        name: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitPlayer>, FaceitError>> {
        Box::pin(FaceitDataApi::player_by_nickname(self, name))
    }
    fn lifetime_stats<'a>(
        &'a self,
        player_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitLifetime>, FaceitError>> {
        Box::pin(FaceitDataApi::lifetime_stats(self, player_id))
    }
    fn history<'a>(
        &'a self,
        player_id: &'a str,
        from_unix: u64,
        limit: u32,
    ) -> BoxFuture<'a, Result<Vec<FaceitHistoryItem>, FaceitError>> {
        Box::pin(FaceitDataApi::history(self, player_id, from_unix, limit))
    }
    fn match_detail<'a>(
        &'a self,
        match_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitMatchDetail>, FaceitError>> {
        Box::pin(FaceitDataApi::match_detail(self, match_id))
    }
}

/// Whether `id` is shaped like FACEIT's ids of players and matches (letters, digits and `-`), so
/// it can go into a path as it is.
fn faceit_id(id: &str) -> bool {
    (1..=MAX_ID).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// A whole number FACEIT gives as a number or as its digits in a string.
fn number(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// A nickname fit to keep and link to: some characters, not too many, none of them control.
fn nickname_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|n| {
        !n.is_empty() && n.chars().count() <= MAX_NICKNAME && !n.chars().any(char::is_control)
    })
}

/// The player in a Data API answer for one: a FACEIT id and a nickname, or it is not one.
fn player_of(answer: &Value) -> Result<FaceitPlayer, FaceitError> {
    let player_id = answer
        .get("player_id")
        .and_then(Value::as_str)
        .filter(|id| faceit_id(id))
        .ok_or(FaceitError::BadAnswer)?;
    let nickname = nickname_of(answer.get("nickname")).ok_or(FaceitError::BadAnswer)?;
    let cs2 = answer.pointer("/games/cs2");
    let steamid = [
        cs2.and_then(|g| g.get("game_player_id")),
        answer.get("steam_id_64"),
    ]
    .into_iter()
    .find_map(|v| v.and_then(Value::as_str).and_then(individual_steamid));
    let level = cs2
        .and_then(|g| g.get("skill_level"))
        .and_then(Value::as_u64)
        .and_then(|l| u8::try_from(l).ok())
        .filter(|l| (1..=10).contains(l));
    let elo = cs2
        .and_then(|g| g.get("faceit_elo"))
        .and_then(Value::as_u64)
        .and_then(|e| u32::try_from(e).ok())
        .filter(|&e| e > 0);
    Ok(FaceitPlayer {
        player_id: player_id.to_owned(),
        nickname: nickname.to_owned(),
        steamid,
        level,
        elo,
    })
}

/// The match count and win rate of a lifetime stats answer (`Matches` and `Win Rate %`, given
/// as strings); a figure out of range is left out.
fn lifetime_of(answer: &Value) -> Result<FaceitLifetime, FaceitError> {
    let lifetime = answer
        .get("lifetime")
        .filter(|l| l.is_object())
        .ok_or(FaceitError::BadAnswer)?;
    let matches = lifetime
        .get("Matches")
        .and_then(number)
        .and_then(|m| u32::try_from(m).ok());
    let wins_pct = lifetime
        .get("Win Rate %")
        .and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse().ok(),
            _ => None,
        })
        .filter(|p| (0.0..=100.0).contains(p))
        .map(|p| p as f32);
    Ok(FaceitLifetime { matches, wins_pct })
}

/// The steamids of both teams of a match (`teams.faction1`, then `faction2`), from each one's
/// `list` of players (`players` in a history, `roster` in a match's detail).
fn steamids_of(answer: &Value, list: &str) -> Vec<u64> {
    ["faction1", "faction2"]
        .iter()
        .filter_map(|f| answer.pointer(&format!("/teams/{f}/{list}")))
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|p| p.get("game_player_id").and_then(Value::as_str))
        .filter_map(individual_steamid)
        .collect()
}

/// The score of a match, the first team's then the second's; `None` without both.
fn score_of(answer: &Value) -> Option<[u8; 2]> {
    let side = |f: &str| {
        answer
            .pointer(&format!("/results/score/{f}"))
            .and_then(number)
            .and_then(|n| u8::try_from(n).ok())
    };
    Some([side("faction1")?, side("faction2")?])
}

/// One match of `player_id`'s history; `None` for one without an id or a time it finished.
fn history_item_of(player_id: &str, item: &Value) -> Option<FaceitHistoryItem> {
    let match_id = item
        .get("match_id")
        .and_then(Value::as_str)
        .filter(|id| faceit_id(id))?;
    let finished_unix = item.get("finished_at").and_then(number)?;
    let competition = item
        .get("competition_name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| {
            !c.is_empty()
                && c.chars().count() <= MAX_COMPETITION
                && !c.chars().any(char::is_control)
        })
        .map(str::to_owned);
    let in_team = |f: &str| {
        item.pointer(&format!("/teams/{f}/players"))
            .and_then(Value::as_array)
            .is_some_and(|ps| {
                ps.iter()
                    .any(|p| p.get("player_id").and_then(Value::as_str) == Some(player_id))
            })
    };
    let (score, won) = match ["faction1", "faction2"].into_iter().find(|f| in_team(f)) {
        Some(theirs) => (
            score_of(item).map(|[first, second]| {
                if theirs == "faction1" {
                    [first, second]
                } else {
                    [second, first]
                }
            }),
            item.pointer("/results/winner")
                .and_then(Value::as_str)
                .filter(|w| matches!(*w, "faction1" | "faction2"))
                .map(|w| w == theirs),
        ),
        None => (None, None),
    };
    Some(FaceitHistoryItem {
        match_id: match_id.to_owned(),
        finished_unix,
        competition,
        score,
        won,
        players: steamids_of(item, "players"),
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::Router;

    use super::*;

    /// A made-up player's account.
    const ALPHA: u64 = 76561198000000007;

    /// FACEIT's answer for that player, cut to what is read and a little more.
    const ALPHA_ANSWER: &str = r#"{"result":"OK","size":1,"payload":[{"id":"a1b2c3d4",
        "nickname":"alphafaceit","country":"ua","games":{"cs2":{"game_id":"76561198000000007",
        "game_name":"akka","faceit_elo":3609,"region":"EU","skill_level":10,
        "skill_level_label":"10"},"csgo":{"game_id":"76561198000000007","skill_level":10}},
        "platforms":{"steam":{"id":"STEAM_0:1:36968273","nickname":"123",
        "id64":"76561198000000007"}}}]}"#;

    /// Users FACEIT lists when it is asked without `game`: anyone, never the one asked for.
    const RANDOM_USERS: &str = r#"{"result":"OK","size":2,"payload":[
        {"nickname":"someone","games":{"cs2":{"game_id":"76561198000000002","skill_level":3,
        "faceit_elo":900}},"platforms":{"steam":{"id64":"76561198000000002"}}},
        {"nickname":"else","games":{},"platforms":{}}]}"#;

    /// A fake FACEIT answering `body` to `/users/v1/users?game_id=…&game=cs2` from a browser,
    /// and the random users to a call without `game`; 403 to a client that is not a browser.
    async fn fake(body: &'static str) -> Url {
        fake_router(Router::new().route(
            "/users/v1/users",
            get(
                move |q: Query<HashMap<String, String>>, headers: HeaderMap| async move {
                    let browser = headers
                        .get("user-agent")
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|ua| ua.starts_with("Mozilla/5.0"));
                    let cs2 = q.contains_key("game_id")
                        && q.get("game").map(String::as_str) == Some("cs2");
                    let (status, body) = match (browser, cs2) {
                        (false, _) => (StatusCode::FORBIDDEN, ""),
                        (true, true) => (StatusCode::OK, body),
                        (true, false) => (StatusCode::OK, RANDOM_USERS),
                    };
                    (status, [("content-type", "application/json")], body)
                },
            ),
        ))
        .await
    }

    async fn fake_router(routes: Router) -> Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, routes).await.unwrap() });
        Url::parse(&base).unwrap()
    }

    #[tokio::test]
    async fn an_account_is_its_nickname_level_and_elo() {
        let api = FaceitApi::new(fake(ALPHA_ANSWER).await);
        assert_eq!(
            api.account(ALPHA).await,
            Ok(Some(Faceit {
                nickname: "alphafaceit".into(),
                level: Some(10),
                elo: Some(3609),
                player_id: None,
                wins_pct: None,
                matches: None,
            }))
        );
    }

    /// Found by the Steam account it is linked to, when its CS2 id is not given; one that has
    /// not played CS2 there has no level or Elo.
    #[tokio::test]
    async fn an_account_found_by_its_steam_account_alone_counts() {
        let api = FaceitApi::new(
            fake(
                r#"{"result":"OK","payload":[{"nickname":"quiet","games":{},
                "platforms":{"steam":{"id64":"76561198000000007"}}}]}"#,
            )
            .await,
        );
        assert_eq!(
            api.account(ALPHA).await,
            Ok(Some(Faceit {
                nickname: "quiet".into(),
                level: None,
                elo: None,
                player_id: None,
                wins_pct: None,
                matches: None,
            }))
        );
    }

    #[tokio::test]
    async fn no_payload_is_no_account() {
        let api = FaceitApi::new(fake(r#"{"result":"OK"}"#).await);
        assert_eq!(api.account(76561198000000008).await, Ok(None));
        let api = FaceitApi::new(fake(r#"{"result":"OK","size":0,"payload":[]}"#).await);
        assert_eq!(api.account(76561198000000008).await, Ok(None));
    }

    /// Accounts that are not the one asked for (FACEIT lists anyone when `game` is left out)
    /// are none of theirs.
    #[tokio::test]
    async fn an_answer_about_other_accounts_is_no_account() {
        let api = FaceitApi::new(fake(RANDOM_USERS).await);
        assert_eq!(api.account(ALPHA).await, Ok(None));
    }

    #[tokio::test]
    async fn an_answer_of_another_shape_is_an_error() {
        for body in [
            "",
            "<html>blocked</html>",
            "[]",
            r#"{"result":"error","payload":[]}"#,
            r#"{"result":"OK","payload":{"nickname":"alphafaceit"}}"#,
            // Theirs, but with no nickname to link to.
            r#"{"result":"OK","payload":[{"games":{"cs2":{"game_id":"76561198000000007"}}}]}"#,
            r#"{"result":"OK","payload":[{"nickname":"","platforms":{"steam":{"id64":"76561198000000007"}}}]}"#,
        ] {
            let api = FaceitApi::new(fake(body).await);
            assert_eq!(
                api.account(ALPHA).await,
                Err(FaceitError::BadAnswer),
                "{body}"
            );
        }
    }

    #[tokio::test]
    async fn an_error_status_or_no_answer_in_time_is_an_error() {
        let base = fake_router(
            Router::new()
                .route(
                    "/down/users/v1/users",
                    get(|| async { StatusCode::SERVICE_UNAVAILABLE }),
                )
                .route(
                    "/slow/users/v1/users",
                    get(|| async {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        ALPHA_ANSWER
                    }),
                ),
        )
        .await;
        let down = FaceitApi::new(base.join("down/").unwrap());
        assert!(matches!(
            down.account(ALPHA).await,
            Err(FaceitError::Unavailable(_))
        ));
        let slow = FaceitApi::with_timeout(base.join("slow/").unwrap(), Duration::from_millis(200));
        assert!(matches!(
            slow.account(ALPHA).await,
            Err(FaceitError::Unavailable(_))
        ));
    }

    /// An answer past [`MAX_ANSWER_BYTES`] is turned away as soon as it passes it, whether it
    /// says its length or not: an endless one is not read on to the timeout.
    #[tokio::test]
    async fn an_answer_past_the_cap_is_turned_away_without_reading_on() {
        use std::convert::Infallible;
        use std::sync::atomic::{AtomicUsize, Ordering};
        use std::sync::Arc;

        use axum::body::{Body, Bytes};

        let sent = Arc::new(AtomicUsize::new(0));
        let counting = sent.clone();
        let base = fake_router(
            Router::new()
                .route(
                    "/endless/users/v1/users",
                    get(move || {
                        let sent = counting.clone();
                        async move {
                            let chunk = Bytes::from(vec![b' '; 16 * 1024]);
                            let endless = futures_util::stream::repeat_with(move || {
                                sent.fetch_add(chunk.len(), Ordering::SeqCst);
                                Ok::<_, Infallible>(chunk.clone())
                            });
                            (
                                [("content-type", "application/json")],
                                Body::from_stream(endless),
                            )
                        }
                    }),
                )
                .route(
                    "/large/users/v1/users",
                    get(|| async {
                        (
                            [("content-type", "application/json")],
                            vec![b' '; MAX_ANSWER_BYTES + 1],
                        )
                    }),
                ),
        )
        .await;
        let t0 = std::time::Instant::now();
        let endless = FaceitApi::new(base.join("endless/").unwrap());
        assert_eq!(endless.account(ALPHA).await, Err(FaceitError::BadAnswer));
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
        // The connection is dropped: the fake stops sending once the socket's buffers are full.
        tokio::time::sleep(Duration::from_millis(300)).await;
        let stopped = sent.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(sent.load(Ordering::SeqCst), stopped, "still read");
        let large = FaceitApi::new(base.join("large/").unwrap());
        assert_eq!(large.account(ALPHA).await, Err(FaceitError::BadAnswer));
    }

    /// The key the Data API fakes take.
    const DATA_KEY: &str = "00000000-1111-4222-8333-444444444444";
    /// A made-up player's FACEIT player id.
    const ALPHA_ID: &str = "a1b2c3d4-0000-4000-8000-000000000001";

    /// The Data API's player for that player, cut to what is read and a little more.
    const ALPHA_PLAYER: &str = r#"{"player_id":"a1b2c3d4-0000-4000-8000-000000000001",
        "nickname":"alpha","country":"ua","steam_id_64":"76561198000000007",
        "games":{"cs2":{"region":"EU","game_player_id":"76561198000000007","skill_level":10,
        "faceit_elo":3609,"game_player_name":"alpha"}}}"#;

    /// Whether `headers` carry [`DATA_KEY`] as FACEIT's Data API asks.
    fn keyed(headers: &HeaderMap) -> bool {
        headers.get("authorization").and_then(|v| v.to_str().ok())
            == Some(&format!("Bearer {DATA_KEY}"))
    }

    /// A Data API client of the fake at `base`, with [`DATA_KEY`] and a gate that never waits.
    fn data_api(base: Url) -> FaceitDataApi {
        FaceitDataApi::new(
            base,
            FaceitKey::new(DATA_KEY).unwrap(),
            SteamGate::new(Duration::ZERO),
        )
    }

    /// A fake Data API: the player by their steamid or nickname, their lifetime stats, one page
    /// of their history and one match; a 404 for any other player or match, a 401 without the key.
    async fn fake_data() -> Url {
        let json = |status: StatusCode, body: String| {
            (status, [("content-type", "application/json")], body)
        };
        let not_found = move || json(StatusCode::NOT_FOUND, r#"{"errors":[]}"#.into());
        fake_router(
            Router::new()
                .route(
                    "/players",
                    get(
                        move |q: Query<HashMap<String, String>>, headers: HeaderMap| async move {
                            if !keyed(&headers) {
                                return json(StatusCode::UNAUTHORIZED, String::new());
                            }
                            let by_id = q.get("game").map(String::as_str) == Some("cs2")
                                && q.get("game_player_id") == Some(&ALPHA.to_string());
                            let by_name = q.get("nickname").map(String::as_str) == Some("alpha");
                            if by_id || by_name {
                                json(StatusCode::OK, ALPHA_PLAYER.into())
                            } else {
                                not_found()
                            }
                        },
                    ),
                )
                .route(
                    "/players/{id}/stats/cs2",
                    get(
                        move |axum::extract::Path(id): axum::extract::Path<String>,
                              headers: HeaderMap| async move {
                            if !keyed(&headers) || id != ALPHA_ID {
                                return not_found();
                            }
                            json(
                                StatusCode::OK,
                                r#"{"player_id":"a1b2c3d4-0000-4000-8000-000000000001",
                                "game_id":"cs2","lifetime":{"Matches":"1204","Win Rate %":"61",
                                "Wins":"734","K/D Ratio":"1.31","Recent Results":["1","0"]},
                                "segments":[]}"#
                                    .into(),
                            )
                        },
                    ),
                )
                .route(
                    "/players/{id}/history",
                    get(
                        move |axum::extract::Path(id): axum::extract::Path<String>,
                              q: Query<HashMap<String, String>>,
                              headers: HeaderMap| async move {
                            let asked = q.get("game").map(String::as_str) == Some("cs2")
                                && q.get("from").map(String::as_str) == Some("1761000000")
                                && q.get("limit").map(String::as_str) == Some("2");
                            if !keyed(&headers) || id != ALPHA_ID || !asked {
                                return not_found();
                            }
                            json(StatusCode::OK, HISTORY.into())
                        },
                    ),
                )
                .route(
                    "/matches/{id}",
                    get(
                        move |axum::extract::Path(id): axum::extract::Path<String>,
                              headers: HeaderMap| async move {
                            if !keyed(&headers) || id != "1-aaaa-bbbb" {
                                return not_found();
                            }
                            json(StatusCode::OK, MATCH.into())
                        },
                    ),
                ),
        )
        .await
    }

    /// Two matches of the player's history: one won on faction2's side, 13 to 9, and one with no
    /// result yet; and one that is not a match at all (no id), which is skipped.
    const HISTORY: &str = r#"{"items":[
        {"match_id":"1-aaaa-bbbb","game_id":"cs2","competition_name":"CS2 5v5",
         "finished_at":1761003600,"teams":{
           "faction1":{"players":[{"player_id":"x1","nickname":"a",
             "game_player_id":"76561198000000001"}]},
           "faction2":{"players":[{"player_id":"a1b2c3d4-0000-4000-8000-000000000001",
             "nickname":"alpha","game_player_id":"76561198000000007"}]}},
         "results":{"winner":"faction2","score":{"faction1":9,"faction2":13}}},
        {"match_id":"1-cccc-dddd","finished_at":1761001000,"teams":{
           "faction1":{"players":[{"player_id":"a1b2c3d4-0000-4000-8000-000000000001",
             "game_player_id":"76561198000000007"}]},"faction2":{"players":[]}}},
        {"finished_at":1761000500}],"start":0,"end":2}"#;

    /// The match `1-aaaa-bbbb` in detail: the map picked, its demo, both rosters.
    const MATCH: &str = r#"{"match_id":"1-aaaa-bbbb","game":"cs2",
        "teams":{"faction1":{"roster":[{"player_id":"x1","game_player_id":"76561198000000001"}]},
          "faction2":{"roster":[{"player_id":"a1b2c3d4-0000-4000-8000-000000000001",
            "game_player_id":"76561198000000007"}]}},
        "voting":{"map":{"pick":["de_mirage"]}},
        "results":{"winner":"faction2","score":{"faction1":9,"faction2":13}},
        "demo_url":["https://demos-us-east.backblaze.faceit-cdn.net/cs2/1-aaaa-bbbb-1-1.dem.gz",
          "not a url"],
        "finished_at":1761003600,"status":"FINISHED"}"#;

    fn alpha_player() -> FaceitPlayer {
        FaceitPlayer {
            player_id: ALPHA_ID.into(),
            nickname: "alpha".into(),
            steamid: Some(ALPHA),
            level: Some(10),
            elo: Some(3609),
        }
    }

    #[tokio::test]
    async fn the_data_api_finds_a_player_by_steamid() {
        let api = data_api(fake_data().await);
        assert_eq!(api.player_by_steamid(ALPHA).await, Ok(Some(alpha_player())));
        // A Steam account FACEIT has no player for.
        assert_eq!(api.player_by_steamid(76561198000000008).await, Ok(None));
    }

    /// A player found by nickname, which is theirs only in its own spelling (any case).
    #[tokio::test]
    async fn the_data_api_finds_a_player_by_nickname() {
        let api = data_api(fake_data().await);
        assert_eq!(
            api.player_by_nickname("alpha").await,
            Ok(Some(alpha_player()))
        );
        assert_eq!(api.player_by_nickname("nobody").await, Ok(None));
    }

    /// An answer about another account than the one asked for is no player of theirs; one with
    /// no player id or nickname is not understood.
    #[tokio::test]
    async fn a_player_answer_that_is_not_theirs_is_none_and_one_of_another_shape_an_error() {
        let base = fake_router(
            Router::new()
                .route(
                    "/other/players",
                    get(|| async {
                        (
                            [("content-type", "application/json")],
                            r#"{"player_id":"b1","nickname":"else","steam_id_64":"76561198000000002",
                            "games":{"cs2":{"game_player_id":"76561198000000002"}}}"#,
                        )
                    }),
                )
                .route(
                    "/odd/players",
                    get(|| async {
                        (
                            [("content-type", "application/json")],
                            r#"{"nickname":"alpha","steam_id_64":"76561198000000007"}"#,
                        )
                    }),
                ),
        )
        .await;
        let other = data_api(base.join("other/").unwrap());
        assert_eq!(other.player_by_steamid(ALPHA).await, Ok(None));
        assert_eq!(other.player_by_nickname("alpha").await, Ok(None));
        let odd = data_api(base.join("odd/").unwrap());
        assert_eq!(
            odd.player_by_steamid(ALPHA).await,
            Err(FaceitError::BadAnswer)
        );
    }

    #[tokio::test]
    async fn lifetime_stats_parse_matches_and_win_rate() {
        let api = data_api(fake_data().await);
        assert_eq!(
            api.lifetime_stats(ALPHA_ID).await,
            Ok(Some(FaceitLifetime {
                matches: Some(1204),
                wins_pct: Some(61.0),
            }))
        );
        // A player FACEIT has no CS2 stats for, and an id not shaped like FACEIT's, never asked.
        assert_eq!(api.lifetime_stats("b1").await, Ok(None));
        assert_eq!(api.lifetime_stats("../matches/x").await, Ok(None));
    }

    /// Figures given as numbers count as their strings do; a win rate past 100 is left out.
    #[test]
    fn lifetime_figures_as_numbers_count_and_out_of_range_ones_do_not() {
        let answer = serde_json::json!({"lifetime": {"Matches": 12, "Win Rate %": 50.5}});
        assert_eq!(
            lifetime_of(&answer),
            Ok(FaceitLifetime {
                matches: Some(12),
                wins_pct: Some(50.5),
            })
        );
        let answer = serde_json::json!({"lifetime": {"Matches": "-1", "Win Rate %": "101"}});
        assert_eq!(
            lifetime_of(&answer),
            Ok(FaceitLifetime {
                matches: None,
                wins_pct: None,
            })
        );
        assert_eq!(
            lifetime_of(&serde_json::json!({"segments": []})),
            Err(FaceitError::BadAnswer)
        );
    }

    /// Each match of a history: its id, when it finished, its competition, the score and the
    /// result from the player's side, and everyone's steamid; one without an id is skipped.
    #[tokio::test]
    async fn history_items_are_told_from_the_players_side() {
        let api = data_api(fake_data().await);
        assert_eq!(
            api.history(ALPHA_ID, 1761000000, 2).await,
            Ok(vec![
                FaceitHistoryItem {
                    match_id: "1-aaaa-bbbb".into(),
                    finished_unix: 1761003600,
                    competition: Some("CS2 5v5".into()),
                    score: Some([13, 9]),
                    won: Some(true),
                    players: vec![76561198000000001, ALPHA],
                },
                FaceitHistoryItem {
                    match_id: "1-cccc-dddd".into(),
                    finished_unix: 1761001000,
                    competition: None,
                    score: None,
                    won: None,
                    players: vec![ALPHA],
                },
            ])
        );
        assert_eq!(api.history("b1", 1761000000, 2).await, Ok(vec![]));
    }

    /// A match in detail: the map picked, the demo addresses that are addresses, both teams'
    /// steamids and the score in FACEIT's order of its teams.
    #[tokio::test]
    async fn a_match_detail_has_its_map_demo_players_and_score() {
        let api = data_api(fake_data().await);
        assert_eq!(
            api.match_detail("1-aaaa-bbbb").await,
            Ok(Some(FaceitMatchDetail {
                map: Some("de_mirage".into()),
                demo_urls: vec![
                    "https://demos-us-east.backblaze.faceit-cdn.net/cs2/1-aaaa-bbbb-1-1.dem.gz"
                        .into()
                ],
                players: vec![76561198000000001, ALPHA],
                score: Some([9, 13]),
                finished_unix: Some(1761003600),
            }))
        );
        assert_eq!(api.match_detail("1-eeee").await, Ok(None));
    }

    #[tokio::test]
    async fn a_401_is_unauthorized_and_never_echoes_the_key() {
        // FACEIT refusing the key, saying back what it was sent.
        let echo = |status: StatusCode| {
            move |headers: HeaderMap| async move {
                let sent = headers
                    .get("authorization")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                (
                    status,
                    format!(r#"{{"errors":[{{"message":"bad key {sent}"}}]}}"#),
                )
            }
        };
        let base = fake_router(
            Router::new()
                .route("/revoked/players", get(echo(StatusCode::UNAUTHORIZED)))
                .route("/forbidden/players", get(echo(StatusCode::FORBIDDEN))),
        )
        .await;
        for path in ["revoked/", "forbidden/"] {
            let api = data_api(base.join(path).unwrap());
            let e = api.player_by_steamid(ALPHA).await.unwrap_err();
            assert_eq!(e, FaceitError::Unauthorized, "{path}");
            assert!(!format!("{e} {e:?}").contains(DATA_KEY), "{path}");
        }
        // Nor does an error with no answer at all, nor the key's own Debug.
        let down = data_api(Url::parse("http://127.0.0.1:9/").unwrap());
        let e = down.player_by_steamid(ALPHA).await.unwrap_err();
        assert!(matches!(e, FaceitError::Unavailable(_)), "{e:?}");
        assert!(!format!("{e} {e:?}").contains(DATA_KEY));
        assert!(!format!("{:?}", FaceitKey::new(DATA_KEY).unwrap()).contains(DATA_KEY));
    }

    #[tokio::test]
    async fn a_429_pauses_the_gate() {
        let base = fake_router(
            Router::new().route("/players", get(|| async { StatusCode::TOO_MANY_REQUESTS })),
        )
        .await;
        let gate = SteamGate::new(Duration::ZERO);
        let api = FaceitDataApi::new(base, FaceitKey::new(DATA_KEY).unwrap(), gate.clone());
        assert_eq!(
            api.player_by_steamid(ALPHA).await,
            Err(FaceitError::RateLimited)
        );
        let next = tokio::time::timeout(Duration::from_millis(500), gate.turn()).await;
        assert!(next.is_err(), "the gate is paused");
    }

    /// Every call waits its turn at the gate: two calls through a gate of a second take one.
    #[tokio::test]
    async fn every_call_waits_its_turn_at_the_gate() {
        let api = FaceitDataApi::new(
            fake_data().await,
            FaceitKey::new(DATA_KEY).unwrap(),
            SteamGate::new(Duration::from_millis(400)),
        );
        let t0 = std::time::Instant::now();
        api.player_by_steamid(ALPHA).await.unwrap();
        api.lifetime_stats(ALPHA_ID).await.unwrap();
        assert!(
            t0.elapsed() >= Duration::from_millis(400),
            "{:?}",
            t0.elapsed()
        );
    }

    /// FACEIT's keys are UUIDs; anything of 8 to 128 printable characters without a space is
    /// taken as one.
    #[test]
    fn a_faceit_key_is_8_to_128_printable_characters() {
        assert!(FaceitKey::new(DATA_KEY).is_some());
        assert!(FaceitKey::new("abcdefgh").is_some());
        assert!(FaceitKey::new(&"a".repeat(128)).is_some());
        for bad in ["abcdefg", "", "abcd efgh", "abcdefgh\n", "abcdéfgh"] {
            assert!(FaceitKey::new(bad).is_none(), "{bad:?}");
        }
        assert!(FaceitKey::new(&"a".repeat(129)).is_none());
        assert_eq!(FaceitKey::new(DATA_KEY).unwrap().expose(), DATA_KEY);
    }

    /// A level outside FACEIT's ten or an Elo of nothing is not shown.
    #[tokio::test]
    async fn a_level_or_elo_out_of_range_is_left_out() {
        let api = FaceitApi::new(
            fake(
                r#"{"result":"OK","payload":[{"nickname":"odd","games":{"cs2":{
                "game_id":"76561198000000007","skill_level":0,"faceit_elo":-5}}}]}"#,
            )
            .await,
        );
        assert_eq!(
            api.account(ALPHA).await,
            Ok(Some(Faceit {
                nickname: "odd".into(),
                level: None,
                elo: None,
                player_id: None,
                wins_pct: None,
                matches: None,
            }))
        );
    }
}
