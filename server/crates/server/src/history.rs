//! A tracked player's match history: Steam's `GetNextMatchSharingCode`, which, given the
//! player's authentication code and a match's share code, answers the share code of their next
//! match, or that the given one is their latest. Every call waits its turn at the Steam gate
//! ([`SteamGate`]); a 429 pauses it. The key and the code travel in the query, so no error
//! carries a URL and nothing here logs one.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use url::Url;

use crate::gcbot::BoxFuture;
use crate::sharecode;
use crate::steam::{ApiKey, SteamGate, STEAM_RATE_PAUSE};
use crate::tracking::AuthCode;

const BASE: &str = "https://api.steampowered.com/";
const PATH: &str = "ICSGOPlayers_730/GetNextMatchSharingCode/v1";
const TIMEOUT: Duration = Duration::from_secs(10);

/// What follows a known match in a player's history.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Next {
    /// The share code of the next match.
    Code(String),
    /// The known match is the latest.
    Latest,
}

/// Why the history gave no answer. Each says so plainly, and none holds a secret.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryError {
    /// Steam refused the authentication code (403): wrong, or changed since.
    WrongCode,
    /// Steam does not know the match token (412).
    BadToken,
    /// Steam is rate limiting, or too many lookups are waiting.
    RateLimited,
    /// No answer, or one that is not Steam's.
    Unavailable,
}

impl fmt::Display for HistoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            HistoryError::WrongCode => {
                "Steam refused the authentication code; it may have been changed"
            }
            HistoryError::BadToken => "Steam does not know that match token",
            HistoryError::RateLimited => "Steam is busy; try again in a minute",
            HistoryError::Unavailable => "Steam did not answer; try again later",
        })
    }
}

impl std::error::Error for HistoryError {}

/// Where the next match comes from: Steam, or a test's fake.
pub trait MatchHistory: Send + Sync {
    fn next_code<'a>(
        &'a self,
        steamid: u64,
        code: &'a AuthCode,
        known: &'a str,
    ) -> BoxFuture<'a, Result<Next, HistoryError>>;
}

pub struct SteamHistory {
    base: Url,
    key: ApiKey,
    gate: Arc<SteamGate>,
    http: reqwest::Client,
}

impl SteamHistory {
    pub fn new(key: ApiKey, gate: Arc<SteamGate>) -> SteamHistory {
        SteamHistory::with_base(
            Url::parse(BASE).expect("the Steam API's address"),
            key,
            gate,
        )
    }

    /// [`SteamHistory::new`] against another server (a test's fake Steam).
    #[doc(hidden)]
    pub fn with_base(base: Url, key: ApiKey, gate: Arc<SteamGate>) -> SteamHistory {
        let http = reqwest::Client::builder()
            .timeout(TIMEOUT)
            .build()
            .expect("an HTTP client");
        SteamHistory {
            base,
            key,
            gate,
            http,
        }
    }

    async fn ask(&self, steamid: u64, code: &AuthCode, known: &str) -> Result<Next, HistoryError> {
        self.gate
            .turn()
            .await
            .map_err(|_| HistoryError::RateLimited)?;
        let mut url = self
            .base
            .join(PATH)
            .map_err(|_| HistoryError::Unavailable)?;
        url.query_pairs_mut()
            .append_pair("key", self.key.expose())
            .append_pair("steamid", &steamid.to_string())
            .append_pair("steamidkey", code.as_str())
            .append_pair("knowncode", known);
        let answer = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        match answer.status().as_u16() {
            200 => {}
            202 => return Ok(Next::Latest),
            403 => return Err(HistoryError::WrongCode),
            412 => return Err(HistoryError::BadToken),
            429 => {
                self.gate.pause(STEAM_RATE_PAUSE);
                return Err(HistoryError::RateLimited);
            }
            _ => return Err(HistoryError::Unavailable),
        }
        #[derive(Deserialize)]
        struct Answer {
            result: Found,
        }
        #[derive(Deserialize)]
        struct Found {
            nextcode: String,
        }
        let body = answer
            .bytes()
            .await
            .map_err(|_| HistoryError::Unavailable)?;
        let found: Answer = serde_json::from_slice(&body).map_err(|_| HistoryError::Unavailable)?;
        let next = found.result.nextcode;
        if sharecode::decode(&next).is_err() {
            return Err(HistoryError::Unavailable);
        }
        Ok(Next::Code(next))
    }
}

impl MatchHistory for SteamHistory {
    fn next_code<'a>(
        &'a self,
        steamid: u64,
        code: &'a AuthCode,
        known: &'a str,
    ) -> BoxFuture<'a, Result<Next, HistoryError>> {
        Box::pin(self.ask(steamid, code, known))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Duration;

    use axum::extract::Query;
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    use super::*;
    use crate::steam::SteamGate;

    const KEY: &str = "0123456789abcdef0123456789abcdef";
    const KNOWN: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
    const NEXT: &str = "CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB";

    /// A fake Steam: the answer depends on `knowncode`; `steamidkey` must be the code.
    async fn fake() -> (SteamHistory, Arc<SteamGate>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new().route(
            "/ICSGOPlayers_730/GetNextMatchSharingCode/v1",
            get(|q: Query<HashMap<String, String>>| async move {
                assert_eq!(q["key"], KEY);
                assert_eq!(q["steamid"], "76561198000000001");
                let json = |s: StatusCode, b: &str| {
                    (s, [("content-type", "application/json")], b.to_owned()).into_response()
                };
                match (q["steamidkey"].as_str(), q["knowncode"].as_str()) {
                    ("ABCD-EFGHI-JKLM", KNOWN) => json(
                        StatusCode::OK,
                        &format!(r#"{{"result":{{"nextcode":"{NEXT}"}}}}"#),
                    ),
                    ("ABCD-EFGHI-JKLM", NEXT) => {
                        json(StatusCode::ACCEPTED, r#"{"result":{"nextcode":"n/a"}}"#)
                    }
                    ("ABCD-EFGHI-JKLM", "CSGO-hLbCn-69VT6-Bok83-9MOqW-SWzwQ") => {
                        json(StatusCode::OK, r#"{"result":{"nextcode":"nonsense"}}"#)
                    }
                    ("ABCD-EFGHI-JKLM", "CSGO-LibdP-VCVEd-ESayK-rSivi-2UBtG") => {
                        StatusCode::TOO_MANY_REQUESTS.into_response()
                    }
                    ("ABCD-EFGHI-JKLM", _) => StatusCode::PRECONDITION_FAILED.into_response(),
                    _ => StatusCode::FORBIDDEN.into_response(),
                }
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let gate = SteamGate::new(Duration::ZERO);
        let key = ApiKey::new(KEY).unwrap();
        (SteamHistory::with_base(base, key, gate.clone()), gate)
    }

    const ME: u64 = 76561198000000001;
    fn code() -> AuthCode {
        AuthCode::parse("ABCD-EFGHI-JKLM").unwrap()
    }

    #[tokio::test]
    async fn a_new_code_a_latest_token_a_wrong_code_and_a_bad_token() {
        let (h, _) = fake().await;
        assert_eq!(
            h.next_code(ME, &code(), KNOWN).await,
            Ok(Next::Code(NEXT.into()))
        );
        assert_eq!(h.next_code(ME, &code(), NEXT).await, Ok(Next::Latest));
        let wrong = AuthCode::parse("ZZZZ-EFGHI-JKLM").unwrap();
        assert_eq!(
            h.next_code(ME, &wrong, KNOWN).await,
            Err(HistoryError::WrongCode)
        );
        assert_eq!(
            h.next_code(ME, &code(), "CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx")
                .await,
            Err(HistoryError::BadToken)
        );
    }

    #[tokio::test]
    async fn a_200_without_a_share_code_is_unavailable() {
        let (h, _) = fake().await;
        assert_eq!(
            h.next_code(ME, &code(), "CSGO-hLbCn-69VT6-Bok83-9MOqW-SWzwQ")
                .await,
            Err(HistoryError::Unavailable)
        );
    }

    #[tokio::test]
    async fn a_429_pauses_every_steam_call() {
        let (h, gate) = fake().await;
        assert_eq!(
            h.next_code(ME, &code(), "CSGO-LibdP-VCVEd-ESayK-rSivi-2UBtG")
                .await,
            Err(HistoryError::RateLimited)
        );
        let next = tokio::time::timeout(Duration::from_millis(500), gate.turn()).await;
        assert!(next.is_err(), "the gate is paused");
    }

    #[tokio::test]
    async fn errors_carry_neither_key_nor_code() {
        // Nothing listens there.
        let base = Url::parse("http://127.0.0.1:9/").unwrap();
        let h = SteamHistory::with_base(
            base,
            ApiKey::new(KEY).unwrap(),
            SteamGate::new(Duration::ZERO),
        );
        let err = h.next_code(ME, &code(), KNOWN).await.unwrap_err();
        assert_eq!(err, HistoryError::Unavailable);
        for e in [
            HistoryError::WrongCode,
            HistoryError::BadToken,
            HistoryError::RateLimited,
            HistoryError::Unavailable,
        ] {
            let shown = format!("{e} {e:?}");
            assert!(
                !shown.contains(KEY)
                    && !shown.contains("ABCD-EFGHI-JKLM")
                    && !shown.contains("http"),
                "{shown}"
            );
        }
    }
}
