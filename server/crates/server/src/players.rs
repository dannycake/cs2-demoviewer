//! Who played which match and what they are called, from the match summaries, in memory:
//! [`crate::matches::MatchIndex`] feeds it every summary it holds, so it is rebuilt at startup
//! with the matches. A profile lists a player's matches from it, and a name search finds
//! players by the name they had in their latest match.

use std::collections::HashMap;
use std::sync::{PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::matches::MatchSummary;

/// The most players a name search returns.
pub const NAME_HITS: usize = 10;

/// A player a name search found. Serialised with the steamid as a string, as the API writes it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct NameHit {
    #[serde(serialize_with = "steamid_string")]
    pub steamid: u64,
    /// Their name in their latest match.
    pub name: String,
    /// How many matches they played.
    pub matches: u32,
}

/// A steamid as the string JSON can carry whole.
fn steamid_string<S: serde::Serializer>(id: &u64, s: S) -> Result<S::Ok, S::Error> {
    s.collect_str(id)
}

/// A player in the index, for the sitemap.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlayerEntry {
    /// Their steamid64.
    pub steamid: u64,
    /// How many matches they played.
    pub matches: u32,
    /// When their latest match was played (or stored, without a played time).
    pub latest_unix: u64,
}

#[derive(Default)]
pub struct PlayerIndex {
    inner: RwLock<Inner>,
}

#[derive(Default)]
struct Inner {
    /// steamid → sha → when the match was played (or stored) and the player's name in it.
    by_player: HashMap<u64, HashMap<String, (u64, String)>>,
    /// sha → its players, so a summary inserted again replaces its entries.
    by_sha: HashMap<String, Vec<u64>>,
}

impl PlayerIndex {
    /// Adds the players of `s`, replacing what an earlier summary of its sha added. Bots
    /// (steamid 0) and a steamid that is not a number are left out.
    pub fn insert(&self, s: &MatchSummary) {
        let at = s.sort_unix();
        let mut inner = self.write();
        let Inner { by_player, by_sha } = &mut *inner;
        for id in by_sha.remove(&s.sha256).unwrap_or_default() {
            if let Some(played) = by_player.get_mut(&id) {
                played.remove(&s.sha256);
                if played.is_empty() {
                    by_player.remove(&id);
                }
            }
        }
        let mut ids = Vec::new();
        for p in &s.players {
            let Some(id) = p.steamid.parse::<u64>().ok().filter(|&id| id != 0) else {
                continue;
            };
            by_player
                .entry(id)
                .or_default()
                .insert(s.sha256.clone(), (at, p.name.clone()));
            ids.push(id);
        }
        by_sha.insert(s.sha256.clone(), ids);
    }

    /// Every player, by steamid.
    pub fn all_players(&self) -> Vec<PlayerEntry> {
        let mut out: Vec<PlayerEntry> = self
            .read()
            .by_player
            .iter()
            .map(|(&steamid, played)| PlayerEntry {
                steamid,
                matches: u32::try_from(played.len()).unwrap_or(u32::MAX),
                latest_unix: played.values().map(|(at, _)| *at).max().unwrap_or(0),
            })
            .collect();
        out.sort_unstable_by_key(|p| p.steamid);
        out
    }

    /// The shas of the matches `steamid` played, newest first.
    pub fn matches_of(&self, steamid: u64) -> Vec<String> {
        let inner = self.read();
        let Some(played) = inner.by_player.get(&steamid) else {
            return Vec::new();
        };
        let mut shas: Vec<(&u64, &String)> =
            played.iter().map(|(sha, (at, _))| (at, sha)).collect();
        shas.sort_unstable_by(|a, b| b.cmp(a));
        shas.into_iter().map(|(_, sha)| sha.clone()).collect()
    }

    /// At most `limit` players whose name (in their latest match) is `q` or starts with it,
    /// ignoring case and the spaces around `q`: whole names first, then those with more
    /// matches. Nothing for an empty `q`.
    pub fn find_by_name(&self, q: &str, limit: usize) -> Vec<NameHit> {
        let q = q.trim().to_lowercase();
        if q.is_empty() {
            return Vec::new();
        }
        let inner = self.read();
        let mut hits: Vec<(bool, NameHit)> = inner
            .by_player
            .iter()
            .filter_map(|(&steamid, played)| {
                let (_, (_, name)) = played.iter().max_by_key(|(sha, (at, _))| (*at, *sha))?;
                let lower = name.to_lowercase();
                let whole = lower == q;
                (whole || lower.starts_with(&q)).then(|| {
                    let hit = NameHit {
                        steamid,
                        name: name.clone(),
                        matches: u32::try_from(played.len()).unwrap_or(u32::MAX),
                    };
                    (!whole, hit)
                })
            })
            .collect();
        hits.sort_unstable_by(|(a_prefix, a), (b_prefix, b)| {
            a_prefix
                .cmp(b_prefix)
                .then(b.matches.cmp(&a.matches))
                .then_with(|| a.name.cmp(&b.name))
                .then(a.steamid.cmp(&b.steamid))
        });
        hits.into_iter().take(limit).map(|(_, hit)| hit).collect()
    }

    /// The name `steamid` had in their latest match, as [`PlayerIndex::find_by_name`] finds
    /// them by.
    pub fn name_of(&self, steamid: u64) -> Option<String> {
        let inner = self.read();
        let (_, (_, name)) = inner
            .by_player
            .get(&steamid)?
            .iter()
            .max_by_key(|(sha, (at, _))| (*at, *sha))?;
        Some(name.clone())
    }

    fn read(&self) -> RwLockReadGuard<'_, Inner> {
        self.inner.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, Inner> {
        self.inner.write().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;
    use crate::matches::{MatchIndex, SummaryPlayer};

    fn summary(sha: &str, played: u64, players: &[(u64, &str)]) -> MatchSummary {
        MatchSummary {
            sha256: sha.into(),
            played_unix: Some(played),
            players: players
                .iter()
                .map(|&(id, name)| SummaryPlayer {
                    steamid: id.to_string(),
                    name: name.into(),
                    ..SummaryPlayer::default()
                })
                .collect(),
            ..MatchSummary::default()
        }
    }

    #[test]
    fn a_player_finds_every_match_they_played() {
        let idx = PlayerIndex::default();
        idx.insert(&summary("a", 10, &[(1, "x"), (2, "y")]));
        idx.insert(&summary("b", 20, &[(1, "x")]));
        assert_eq!(idx.matches_of(1), ["b", "a"], "newest first");
        assert_eq!(idx.matches_of(2), ["a"]);
        assert!(idx.matches_of(3).is_empty());
    }

    #[test]
    fn reinserting_a_summary_does_not_duplicate_its_matches() {
        let idx = PlayerIndex::default();
        idx.insert(&summary("a", 10, &[(1, "x"), (2, "y")]));
        idx.insert(&summary("a", 10, &[(1, "x")]));
        assert_eq!(idx.matches_of(1), ["a"]);
        assert!(idx.matches_of(2).is_empty());
        assert!(idx.find_by_name("y", NAME_HITS).is_empty());
    }

    #[test]
    fn names_match_exactly_before_by_prefix_case_insensitively() {
        let idx = PlayerIndex::default();
        idx.insert(&summary(
            "a",
            10,
            &[(1, "Skunky"), (2, "skunk"), (3, "SKUNK"), (4, "notskunk")],
        ));
        let hits = idx.find_by_name(" Skunk ", NAME_HITS);
        let ids: Vec<u64> = hits.iter().map(|h| h.steamid).collect();
        assert_eq!(ids.len(), 3, "{ids:?}");
        assert_eq!(
            ids[..2].iter().collect::<BTreeSet<_>>(),
            [2, 3].iter().collect()
        );
        assert_eq!(
            hits[2],
            NameHit {
                steamid: 1,
                name: "Skunky".into(),
                matches: 1
            }
        );
        assert!(idx.find_by_name("  ", NAME_HITS).is_empty());
    }

    #[test]
    fn a_player_is_named_by_their_latest_match() {
        let idx = PlayerIndex::default();
        idx.insert(&summary("b", 20, &[(1, "new")]));
        idx.insert(&summary("a", 10, &[(1, "old")]));
        let hits = idx.find_by_name("new", NAME_HITS);
        assert_eq!((hits[0].steamid, hits[0].matches), (1, 2));
        assert!(idx.find_by_name("old", NAME_HITS).is_empty());
        // Without a played time, the time it was stored.
        let mut stored = summary("c", 0, &[(1, "newest")]);
        stored.played_unix = None;
        stored.created_unix = 30;
        idx.insert(&stored);
        assert_eq!(idx.find_by_name("new", NAME_HITS)[0].name, "newest");
    }

    #[test]
    fn hits_are_capped() {
        let idx = PlayerIndex::default();
        let players: Vec<(u64, String)> = (1..=15).map(|i| (i, format!("a{i}"))).collect();
        let players: Vec<(u64, &str)> = players.iter().map(|(i, n)| (*i, n.as_str())).collect();
        idx.insert(&summary("a", 10, &players));
        assert_eq!(idx.find_by_name("a", NAME_HITS).len(), 10);
        assert_eq!(idx.find_by_name("a", 3).len(), 3);
    }

    #[test]
    fn bots_are_not_players() {
        let idx = PlayerIndex::default();
        let mut s = summary("a", 10, &[(0, "BOT Kim")]);
        s.players.push(SummaryPlayer {
            steamid: "not a number".into(),
            name: "BOT Lee".into(),
            ..SummaryPlayer::default()
        });
        idx.insert(&s);
        assert!(idx.matches_of(0).is_empty());
        assert!(idx.find_by_name("bot", NAME_HITS).is_empty());
    }

    #[test]
    fn the_match_index_feeds_its_players() {
        let matches = MatchIndex::default();
        matches.insert(summary("a", 10, &[(7, "seven")]));
        assert_eq!(matches.players().matches_of(7), ["a"]);
    }
}
