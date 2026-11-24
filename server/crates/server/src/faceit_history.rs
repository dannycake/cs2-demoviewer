//! Tracked players' FACEIT histories: `faceit/<steamid>.json` in the data directory, one file a
//! player, written by the FACEIT poller alone ([`crate::faceit_tracker`]) and read by whatever
//! shows them (never asking FACEIT for a page). A file holds who the player is on FACEIT, where
//! the poller is in their history and when it looks again, and their newest [`MAX_MATCHES`]
//! matches as FACEIT gave them, each with what became of its demo ([`DemoState`]). Every write
//! goes through [`store::write_file`], so a file is whole whatever happens.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::store;

/// The directory of the files, in the data directory.
pub const DIR: &str = "faceit";
/// The most matches a file keeps: the newest.
pub const MAX_MATCHES: usize = 100;

/// What became of a FACEIT match's demo. Kept as `"pending"`, `{"held": "<demo id>"}` or
/// `"unavailable"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DemoState {
    /// Not fetched yet: its demo may still be (once FACEIT posts its URL, which it does a little
    /// after the match ends; once FACEIT's demo hosts are allowed; after a fetch that failed on
    /// the way), or be uploaded.
    Pending,
    /// The site has it: the demo id of the record that holds it.
    Held(String),
    /// It cannot be fetched: FACEIT refused it or no longer has it, never gave a URL for it in
    /// [`crate::tracker::MAX_FETCH_TRIES`] asks, or every fetch failed. Only an upload brings
    /// it.
    Unavailable,
}

/// One match of a player's FACEIT history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceitMatch {
    /// FACEIT's id of the match.
    pub match_id: String,
    /// When it finished, in unix seconds.
    pub finished_unix: u64,
    /// The map picked (`de_mirage`), when FACEIT's detail of the match said.
    #[serde(default)]
    pub map: Option<String>,
    /// The player's team's score, then the other's; `None` without a result, or when FACEIT's
    /// history did not say which team was theirs.
    #[serde(default)]
    pub score: Option<[u8; 2]>,
    /// Whether the player's team won; `None` without a result.
    #[serde(default)]
    pub won: Option<bool>,
    /// The competition it was played in (`CS2 5v5`, a hub's or a league's name).
    #[serde(default)]
    pub competition: Option<String>,
    /// The steamids of everyone in it FACEIT names one for, the first team's first: what an
    /// uploaded demo of it is told by.
    #[serde(default)]
    pub players: Vec<u64>,
    /// What became of its demo.
    pub demo: DemoState,
    /// Where FACEIT said its demo is, kept while the demo is pending (for the next try, so a
    /// match that gave a URL is never asked about again) and dropped once it is held or
    /// unavailable; `None` while FACEIT has given none. Only the poller reads it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demo_url: Option<String>,
    /// How many downloads of its demo failed on the way (not refused); at
    /// [`crate::tracker::MAX_FETCH_TRIES`] it is unavailable.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub fetch_tries: u32,
    /// How many times FACEIT's detail of the match was asked for and gave no demo URL (the ask
    /// that made the row included); at [`crate::tracker::MAX_FETCH_TRIES`] it is unavailable.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub detail_tries: u32,
}

impl FaceitMatch {
    /// Its demo is held by record `demo_id`: the URL, kept only while the demo is pending, goes
    /// (the tries stay, as what was tried).
    pub fn hold(&mut self, demo_id: String) {
        self.demo = DemoState::Held(demo_id);
        self.demo_url = None;
    }
}

/// Whether a count is 0, which a file leaves out.
fn is_zero(n: &u32) -> bool {
    *n == 0
}

/// A tracked player's FACEIT history file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceitEntry {
    /// FACEIT's id of the player, which their history is asked by; `None` before it is known,
    /// or while FACEIT has no account for them.
    #[serde(default)]
    pub player_id: Option<String>,
    /// Their FACEIT nickname.
    #[serde(default)]
    pub nickname: Option<String>,
    /// The newest time a match in their history finished, of those seen: where the next look
    /// starts from. `None` before one is seen.
    #[serde(default)]
    pub cursor_unix: Option<u64>,
    /// When the poller looks again (unix seconds); 0 at once.
    #[serde(default)]
    pub next_unix: u64,
    /// Looks in a row that failed (FACEIT did not answer, a demo failed on the way): the wait
    /// before the next look doubles with each. 0 after one that did not fail.
    #[serde(default)]
    pub tries: u32,
    /// Their matches, newest first, at most [`MAX_MATCHES`].
    #[serde(default)]
    pub matches: Vec<FaceitMatch>,
}

impl FaceitEntry {
    /// Whether match `match_id` has its row.
    pub fn has(&self, match_id: &str) -> bool {
        self.matches.iter().any(|m| m.match_id == match_id)
    }

    /// Adds `row` in its place (newest first), unless its match has one; past [`MAX_MATCHES`]
    /// the oldest go.
    pub fn keep(&mut self, row: FaceitMatch) {
        if self.has(&row.match_id) {
            return;
        }
        let at = self
            .matches
            .iter()
            .position(|m| m.finished_unix < row.finished_unix)
            .unwrap_or(self.matches.len());
        self.matches.insert(at, row);
        self.matches.truncate(MAX_MATCHES);
    }
}

/// The files, in `faceit/` in the data directory.
pub struct FaceitHistory {
    dir: PathBuf,
}

impl FaceitHistory {
    /// The files in `data_dir` (their directory is made if missing).
    pub fn open(data_dir: &Path) -> io::Result<Arc<FaceitHistory>> {
        let dir = data_dir.join(DIR);
        std::fs::create_dir_all(&dir)?;
        Ok(Arc::new(FaceitHistory { dir }))
    }

    /// The files in `data_dir` for a reader (a profile), whose directory is not made: a server
    /// without the poller (no FACEIT key) reads what an earlier run left, or finds none. The
    /// poller's are [`FaceitHistory::open`]'s.
    pub fn at(data_dir: &Path) -> Arc<FaceitHistory> {
        Arc::new(FaceitHistory {
            dir: data_dir.join(DIR),
        })
    }

    /// `steamid`'s file; `None` without one. One that is not a history (corrupt) is set aside
    /// as `<steamid>.json.corrupt-<unix time>` ([`store::set_aside`]), logged, and taken as
    /// none, so the player's history starts afresh. One that cannot be read at all is the
    /// error, and stays where it is.
    pub fn get(&self, steamid: u64) -> io::Result<Option<FaceitEntry>> {
        let path = self.path(steamid);
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        match serde_json::from_slice(&bytes) {
            Ok(entry) => Ok(Some(entry)),
            Err(e) => {
                let aside = store::set_aside(&path)?;
                tracing::warn!(steamid, error = %e, aside = %aside.display(), "a corrupt FACEIT history was set aside");
                Ok(None)
            }
        }
    }

    /// Writes `steamid`'s file as `entry`.
    pub fn put(&self, steamid: u64, entry: &FaceitEntry) -> io::Result<()> {
        let json = serde_json::to_vec(entry).map_err(io::Error::other)?;
        let tmp = self.dir.join(format!("{steamid}.json.tmp"));
        store::write_file(&tmp, &self.path(steamid), &json)
    }

    /// Where `steamid`'s file is.
    pub fn path(&self, steamid: u64) -> PathBuf {
        self.dir.join(format!("{steamid}.json"))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const A: u64 = 76561198000000001;

    fn row(id: &str, finished_unix: u64) -> FaceitMatch {
        FaceitMatch {
            match_id: id.to_owned(),
            finished_unix,
            map: Some("de_mirage".to_owned()),
            score: Some([13, 9]),
            won: Some(true),
            competition: None,
            players: vec![A],
            demo: DemoState::Pending,
            demo_url: None,
            fetch_tries: 0,
            detail_tries: 0,
        }
    }

    #[test]
    fn a_demo_state_is_kept_as_a_word_or_the_demo_id_it_is_held_by() {
        let states = [
            DemoState::Pending,
            DemoState::Held("4kH2pQx9".to_owned()),
            DemoState::Unavailable,
        ];
        let json = serde_json::to_value(&states).unwrap();
        assert_eq!(
            json,
            json!(["pending", {"held": "4kH2pQx9"}, "unavailable"])
        );
        let back: Vec<DemoState> = serde_json::from_value(json).unwrap();
        assert_eq!(back, states);
    }

    #[test]
    fn a_file_is_camel_case_and_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let h = FaceitHistory::open(dir.path()).unwrap();
        assert_eq!(h.get(A).unwrap(), None);
        let mut entry = FaceitEntry {
            player_id: Some("p-1".to_owned()),
            nickname: Some("nick".to_owned()),
            cursor_unix: Some(1_761_000_000),
            next_unix: 1_761_000_900,
            tries: 2,
            matches: vec![],
        };
        entry.keep(FaceitMatch {
            demo_url: Some("https://replay183.valve.net/730/a.dem.bz2".to_owned()),
            fetch_tries: 3,
            detail_tries: 2,
            ..row("1-a", 1_761_000_000)
        });
        h.put(A, &entry).unwrap();
        assert_eq!(h.get(A).unwrap(), Some(entry));
        let file: serde_json::Value = serde_json::from_slice(
            &std::fs::read(dir.path().join("faceit").join(format!("{A}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            file,
            json!({
                "playerId": "p-1", "nickname": "nick", "cursorUnix": 1_761_000_000u64,
                "nextUnix": 1_761_000_900u64, "tries": 2,
                "matches": [{
                    "matchId": "1-a", "finishedUnix": 1_761_000_000u64, "map": "de_mirage",
                    "score": [13, 9], "won": true, "competition": null, "players": [A],
                    "demo": "pending",
                    "demoUrl": "https://replay183.valve.net/730/a.dem.bz2", "fetchTries": 3,
                    "detailTries": 2
                }]
            })
        );
        // Without a URL or a failed try, none is written.
        let mut held = row("1-b", 1);
        held.demo = DemoState::Held("x".to_owned());
        let v = serde_json::to_value(&held).unwrap();
        for key in ["demoUrl", "fetchTries", "detailTries"] {
            assert!(v.get(key).is_none(), "{v}");
        }
    }

    #[test]
    fn a_corrupt_file_is_set_aside_and_one_that_cannot_be_read_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let h = FaceitHistory::open(dir.path()).unwrap();
        std::fs::write(h.path(A), b"{not json").unwrap();
        assert_eq!(h.get(A).unwrap(), None);
        assert!(!h.path(A).exists());
        let aside: Vec<_> = std::fs::read_dir(dir.path().join(DIR))
            .unwrap()
            .map(|e| e.unwrap().path())
            .collect();
        assert_eq!(aside.len(), 1);
        let name = aside[0].file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(&format!("{A}.json.corrupt-")), "{name}");
        assert_eq!(std::fs::read(&aside[0]).unwrap(), b"{not json");
        // A directory in the file's place cannot be read: an error, and left there.
        std::fs::create_dir(h.path(A)).unwrap();
        assert!(h.get(A).is_err());
        assert!(h.path(A).is_dir());
    }

    #[test]
    fn a_reader_makes_no_directory_and_reads_what_the_poller_writes() {
        let dir = tempfile::tempdir().unwrap();
        let reader = FaceitHistory::at(dir.path());
        assert_eq!(reader.get(A).unwrap(), None);
        assert!(!dir.path().join(DIR).exists());
        let entry = FaceitEntry {
            nickname: Some("nick".to_owned()),
            ..FaceitEntry::default()
        };
        FaceitHistory::open(dir.path())
            .unwrap()
            .put(A, &entry)
            .unwrap();
        assert_eq!(reader.get(A).unwrap(), Some(entry));
    }

    #[test]
    fn a_held_row_keeps_no_url() {
        for demo in [DemoState::Pending, DemoState::Unavailable] {
            let mut r = FaceitMatch {
                demo,
                demo_url: Some("https://replay183.valve.net/730/a.dem.bz2".to_owned()),
                fetch_tries: 2,
                ..row("1-a", 1)
            };
            r.hold("4kH2pQx9".to_owned());
            assert_eq!(r.demo, DemoState::Held("4kH2pQx9".to_owned()));
            assert_eq!(r.demo_url, None);
            assert_eq!(r.fetch_tries, 2, "the tries stay");
        }
    }

    #[test]
    fn rows_are_kept_newest_first_once_each_and_at_most_a_hundred() {
        let mut entry = FaceitEntry::default();
        entry.keep(row("b", 20));
        entry.keep(row("c", 30));
        entry.keep(row("a", 10));
        entry.keep(FaceitMatch {
            demo: DemoState::Unavailable,
            ..row("b", 20)
        });
        let ids: Vec<&str> = entry.matches.iter().map(|m| m.match_id.as_str()).collect();
        assert_eq!(ids, ["c", "b", "a"]);
        assert_eq!(
            entry.matches[1].demo,
            DemoState::Pending,
            "the first row stays"
        );
        for n in 0..MAX_MATCHES as u64 {
            entry.keep(row(&format!("new{n}"), 100 + n));
        }
        assert_eq!(entry.matches.len(), MAX_MATCHES);
        assert_eq!(entry.matches[0].match_id, format!("new{}", MAX_MATCHES - 1));
        assert!(!entry.has("a") && !entry.has("c"), "the oldest went");
        // One older than every row kept is not kept.
        entry.keep(row("old", 1));
        assert!(!entry.has("old"));
    }
}
