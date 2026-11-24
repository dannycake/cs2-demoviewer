//! Tournaments: the events the match summaries were imported under, listed with their match
//! counts and date range, each event's matches newest first, and the links the home page shows
//! (the newest events, the players with the most matches). `/api/events`, `/api/events/{slug}`
//! and `/api/home` answer from here; the event pages are drawn from the same functions.

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path as UrlPath, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use serde::Serialize;

use crate::api::{ApiError, AppState};
use crate::event_dates;
use crate::matches::MatchSummary;
use crate::pages::{event_name, final_score, match_title, top_fragger, HIDDEN_NAME};
use crate::store::Status;

/// How many events the home links name.
const HOME_EVENTS: usize = 5;

/// The `/api` routes of this module.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/events", get(get_events))
        .route("/events/{slug}", get(get_event))
        .route("/home", get(get_home))
}

/// Whether `s` is a tournament slug: 1 to 64 of `a-z`, `0-9`, `_` and `-`, not starting with
/// `_` or `-`. A slug never reaches the file system, and is checked before any lookup.
pub fn valid_slug(s: &str) -> bool {
    let mut bytes = s.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.len() <= 64
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

/// A tournament and how much of it the site holds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventSummary {
    /// The tournament's slug, as its demos were imported under it.
    pub slug: String,
    /// The name the web app writes for the slug ([`event_name`]).
    pub name: String,
    /// How many distinct matches.
    pub matches: u32,
    /// The tournament's first day ([`event_dates`]), else when the first of its matches with a
    /// known day was played; none when nothing says.
    pub first_unix: Option<u64>,
    /// Its last day, likewise.
    pub last_unix: Option<u64>,
}

/// One match of a tournament.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventMatch {
    /// The id of the match's page (`/d/{demo_id}`).
    pub demo_id: String,
    /// The map's file name (`de_mirage`).
    pub map: String,
    /// "Mirage 13–9".
    pub title: String,
    /// The final score, the winner's first.
    pub score: [u8; 2],
    /// When the match was played ([`MatchSummary::played`]); none for a demo that does not say.
    pub played_unix: Option<u64>,
    /// The two teams' names, when the corpus named them.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teams: Option<[String; 2]>,
    /// The top fragger's name: a dash when they asked to be hidden, none when nobody qualifies.
    pub top: Option<String>,
}

/// What the home page links to: the newest events. It lists no players.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeLinks {
    /// The newest events.
    pub events: Vec<EventSummary>,
}

/// The indexed matches that have a done demo, each with the id of its page (the id profiles
/// link to): the one definition of which matches an event holds, shared by [`list_events`] and
/// [`event_matches`] so a count always equals the rows.
pub(crate) fn done_matches(s: &AppState) -> Vec<(Arc<MatchSummary>, String)> {
    s.store
        .matches()
        .all()
        .into_iter()
        .filter_map(|m| {
            let done = s
                .store
                .find_by_sha(&m.sha256)
                .filter(|r| r.status == Status::Done)?;
            Some((m, done.id))
        })
        .collect()
}

/// Every event with a valid slug that has a match with a done demo, the one played last first and
/// those with no dates at the end. Only those matches are counted, and they date the event when
/// its own dates are not known ([`event_dates`]).
pub fn list_events(s: &AppState) -> Vec<EventSummary> {
    // slug → (distinct shas, first, last)
    let mut events: HashMap<String, (u32, Option<u64>, Option<u64>)> = HashMap::new();
    for (m, _) in done_matches(s) {
        let Some(slug) = m.event.as_deref().filter(|s| valid_slug(s)) else {
            continue;
        };
        let e = events.entry(slug.to_owned()).or_default();
        e.0 += 1;
        if let Some(at) = m.played() {
            e.1 = Some(e.1.map_or(at, |first| first.min(at)));
            e.2 = Some(e.2.map_or(at, |last| last.max(at)));
        }
    }
    let mut out: Vec<EventSummary> = events
        .into_iter()
        .map(|(slug, (matches, first, last))| {
            let (first_unix, last_unix) = event_dates::of(&slug)
                .map_or((first, last), |(first, last)| (Some(first), Some(last)));
            EventSummary {
                name: event_name(&slug),
                slug,
                matches,
                first_unix,
                last_unix,
            }
        })
        .collect();
    out.sort_by(|a, b| b.last_unix.cmp(&a.last_unix).then(a.slug.cmp(&b.slug)));
    out
}

/// The matches of the event `slug` that have a done demo, one per pack (under the id profiles
/// link to), the one played last first and those with no day of their own at the end.
pub fn event_matches(s: &AppState, slug: &str) -> Vec<EventMatch> {
    if !valid_slug(slug) {
        return Vec::new();
    }
    let mut out: Vec<EventMatch> = done_matches(s)
        .into_iter()
        .filter(|(m, _)| m.event.as_deref() == Some(slug))
        .map(|(m, demo_id)| {
            let top = top_fragger(&m).map(|p| {
                if p.steamid.parse().is_ok_and(|id| s.hidden.is_hidden(id)) {
                    HIDDEN_NAME.to_owned()
                } else {
                    p.name.trim().to_owned()
                }
            });
            let [(winner, _), (loser, _)] = final_score(&m);
            EventMatch {
                demo_id,
                map: m.map.clone(),
                title: match_title(&m),
                score: [winner, loser],
                played_unix: m.played(),
                teams: m.teams.clone(),
                top,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        b.played_unix
            .cmp(&a.played_unix)
            .then_with(|| a.demo_id.cmp(&b.demo_id))
    });
    out
}

/// The home page's links: the newest events.
pub fn home_links(s: &AppState) -> HomeLinks {
    let mut events = list_events(s);
    events.truncate(HOME_EVENTS);
    HomeLinks { events }
}

/// `GET /api/events`: every event, the one played last first.
async fn get_events(State(s): State<AppState>) -> Json<Vec<EventSummary>> {
    Json(list_events(&s))
}

/// `GET /api/events/{slug}`: the event and its matches; a 404 for a slug that is not one or
/// that no match names.
async fn get_event(
    State(s): State<AppState>,
    UrlPath(slug): UrlPath<String>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let missing = || ApiError::new(StatusCode::NOT_FOUND, "no such event");
    if !valid_slug(&slug) {
        return Err(missing());
    }
    let event = list_events(&s)
        .into_iter()
        .find(|e| e.slug == slug)
        .ok_or_else(missing)?;
    Ok(Json(serde_json::json!({
        "event": event,
        "matches": event_matches(&s, &slug),
    })))
}

/// `GET /api/home`: [`HomeLinks`].
async fn get_home(State(s): State<AppState>) -> Json<HomeLinks> {
    Json(home_links(&s))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_lower_case_words_of_at_most_64_bytes() {
        for ok in ["cac2026", "iem_cologne-2026", "0", "a", &"a".repeat(64)] {
            assert!(valid_slug(ok), "{ok}");
        }
        for bad in [
            "",
            "_a",
            "-a",
            "A",
            "a b",
            "a/b",
            "../etc",
            "a.b",
            "é",
            "a\n",
            &"a".repeat(65),
        ] {
            assert!(!valid_slug(bad), "{bad:?}");
        }
    }
}
