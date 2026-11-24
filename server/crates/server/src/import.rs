//! Importing a demo corpus (a folder of pro demos, `DEMOVIEWER_IMPORT_DIR`): every demo its
//! index lists becomes a `Source::Import` record, parsed in the background behind user work
//! ([`Job::Import`]) and kept like any match Valve served, original included. The corpus is
//! only read. Each demo is imported once: what is done is logged in `imported.json` in the
//! data directory ([`ImportLog`]); a demo that failed is tried again at the next scan.

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;

use crate::errors::blocking;
use crate::jobs::{self, Job, Jobs};
use crate::store::{self, Source, Store};

/// The corpus's index: one JSON object per line.
pub const INDEX: &str = "index.jsonl";
/// How often the corpus is scanned again: it grows nightly.
pub const IMPORT_EVERY: Duration = Duration::from_secs(24 * 3600);
/// What a corpus file may be named: a raw demo, or one compressed as Valve or a host serves it.
const DEMO_SUFFIXES: [&str; 3] = [".dem", ".dem.bz2", ".dem.gz"];
const LOG: &str = "imported.json";

/// One demo of the corpus.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportEntry {
    pub path: PathBuf,
    /// The SHA-256 the index gives the file: what the log knows it by. The demo's own sha is
    /// computed when it is parsed.
    pub index_sha: String,
    /// The tournament, as the index names it (`cac2026`).
    pub event: Option<String>,
    /// The two teams, when the index names them (`["Spirit", "Falcons"]`).
    pub teams: Option<[String; 2]>,
}

/// The fields of an index line this server reads; the others (`source`, `dataset`, `path`,
/// `bytes`, `map`, `fetched_unix`) are the fetcher's.
#[derive(Deserialize)]
struct IndexLine {
    file: String,
    sha256: String,
    #[serde(default)]
    event: Option<String>,
    /// Anything: only an array of two non-blank strings counts ([`teams_of`]).
    #[serde(default)]
    teams: serde_json::Value,
}

/// The two team names of an index line's `teams`, trimmed; `None` for anything but an array of
/// exactly two strings that are not blank.
fn teams_of(v: &serde_json::Value) -> Option<[String; 2]> {
    let [a, b] = v.as_array()?.as_slice() else {
        return None;
    };
    let (a, b) = (a.as_str()?.trim(), b.as_str()?.trim());
    (!a.is_empty() && !b.is_empty()).then(|| [a.to_owned(), b.to_owned()])
}

/// The demos `dir`'s [`INDEX`] lists, in its order. A line's `file` is the demo's path
/// relative to `dir` (`hf/<owner>__<dataset>/<path>`, as `demoviewer-corpus.sh` writes it). A
/// line is skipped with a warning when it is not an index line, its sha is not 64 hex digits,
/// its `file` leaves `dir` (an absolute path or a `..`), or names no file ending in `.dem`,
/// `.dem.bz2` or `.dem.gz`. Fails only when the index cannot be read.
pub fn read_index(dir: &Path) -> io::Result<Vec<ImportEntry>> {
    let mut entries = Vec::new();
    for (n, line) in BufReader::new(fs::File::open(dir.join(INDEX))?)
        .lines()
        .enumerate()
    {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match entry(dir, &line) {
            Ok(e) => entries.push(e),
            Err(why) => tracing::warn!(line = n + 1, why, "corpus index line skipped"),
        }
    }
    Ok(entries)
}

fn entry(dir: &Path, line: &str) -> Result<ImportEntry, &'static str> {
    let l: IndexLine = serde_json::from_str(line).map_err(|_| "not an index line")?;
    if l.sha256.len() != 64 || !l.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("not a sha256");
    }
    let rel = Path::new(&l.file);
    if !rel.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err("the file is outside the corpus");
    }
    if !DEMO_SUFFIXES.iter().any(|s| l.file.ends_with(s)) {
        return Err("not a demo");
    }
    let path = dir.join(rel);
    if !path.is_file() {
        return Err("no such file");
    }
    Ok(ImportEntry {
        path,
        index_sha: l.sha256.to_ascii_lowercase(),
        event: l.event,
        teams: teams_of(&l.teams),
    })
}

/// The demos imported so far (`imported.json` in the data directory: index sha → demo id),
/// rewritten whole through `tmp/` on each insert.
#[derive(Debug)]
pub struct ImportLog {
    path: PathBuf,
    tmp: PathBuf,
    done: Mutex<BTreeMap<String, String>>,
}

impl ImportLog {
    /// The log in `data_dir`; empty when there is none yet.
    pub fn open(data_dir: &Path) -> io::Result<ImportLog> {
        let path = data_dir.join(LOG);
        let done = match fs::read(&path) {
            Ok(json) => serde_json::from_slice(&json)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Err(e) => return Err(e),
        };
        Ok(ImportLog {
            tmp: data_dir.join("tmp").join(format!("{LOG}.tmp")),
            path,
            done: Mutex::new(done),
        })
    }

    pub fn contains(&self, index_sha: &str) -> bool {
        self.lock().contains_key(index_sha)
    }

    /// The demo id `index_sha` was imported as.
    pub fn get(&self, index_sha: &str) -> Option<String> {
        self.lock().get(index_sha).cloned()
    }

    /// Logs `index_sha` as imported as `demo_id` and writes the log.
    pub fn insert(&self, index_sha: &str, demo_id: &str) -> io::Result<()> {
        let mut done = self.lock();
        done.insert(index_sha.to_owned(), demo_id.to_owned());
        store::write_file(&self.tmp, &self.path, &serde_json::to_vec(&*done)?)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<String, String>> {
        self.done.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Imports the corpus in `dir` now and every [`IMPORT_EVERY`] ([`import_once`]). A log that
/// cannot be read stops the importer, with an error, and nothing is imported.
pub fn spawn_importer(store: Arc<Store>, jobs: Jobs, dir: PathBuf) {
    tokio::spawn(async move {
        let data = store.data_dir().to_owned();
        let log = match blocking(move || ImportLog::open(&data)).await {
            Ok(Ok(log)) => Arc::new(log),
            Ok(Err(e)) => {
                tracing::error!(error = %e, "cannot read the import log; nothing is imported");
                return;
            }
            Err(e) => {
                tracing::error!(error = %e, "cannot read the import log; nothing is imported");
                return;
            }
        };
        loop {
            import_once(&store, &jobs, &dir, &log).await;
            tokio::time::sleep(IMPORT_EVERY).await;
        }
    });
}

/// Queues every demo of the corpus in `dir` that the log does not have, as background work:
/// a `Source::Import` record made just before its job is queued, so at most one waits. Returns
/// how many were queued.
pub async fn import_once(store: &Store, jobs: &Jobs, dir: &Path, log: &Arc<ImportLog>) -> usize {
    let index = dir.to_owned();
    let entries = match blocking(move || read_index(&index)).await {
        Ok(Ok(entries)) => entries,
        Ok(Err(e)) => {
            tracing::warn!(dir = %dir.display(), error = %e, "cannot read the corpus index");
            return 0;
        }
        Err(e) => {
            tracing::warn!(dir = %dir.display(), error = %e, "cannot read the corpus index");
            return 0;
        }
    };
    let mut seen = HashSet::new();
    let mut queued = 0;
    let mut backfilled = 0;
    for e in entries {
        if !seen.insert(e.index_sha.clone()) {
            continue;
        }
        if log.contains(&e.index_sha) {
            if backfill(store, log, &e).await {
                backfilled += 1;
            }
            continue;
        }
        let id = Store::new_id();
        store.create_from(&id, Source::Import);
        store.update(&id, |r| {
            r.event = e.event.clone();
            r.teams = e.teams.clone();
        });
        jobs.enqueue_background(Job::Import {
            demo_id: id,
            path: e.path,
            index_sha: e.index_sha,
            log: log.clone(),
        })
        .await;
        queued += 1;
    }
    if queued > 0 || backfilled > 0 {
        tracing::info!(
            demos = queued,
            brought_up_to_date = backfilled,
            "corpus demos queued for import"
        );
    }
    queued
}

/// Brings an already imported demo up to date: the teams the index now names go on its record,
/// and its summary (disk and match index) takes what the record knows, which marks one from
/// before the mark as the corpus's ([`crate::matches::MatchSummary::imported`]). Nothing for a record with no sha
/// or no summary yet. Whether the summary changed; one that could not be written is tried again
/// at the next scan.
async fn backfill(store: &Store, log: &ImportLog, e: &ImportEntry) -> bool {
    let Some(id) = log.get(&e.index_sha) else {
        return false;
    };
    if let Some(teams) = &e.teams {
        if store.get(&id).is_some_and(|r| r.teams.is_none()) {
            store.update(&id, |r| r.teams = Some(teams.clone()));
        }
    }
    let Some(rec) = store.get(&id) else {
        return false;
    };
    let Some(sha) = rec.sha256.clone() else {
        return false;
    };
    let path = store.summary_path(&sha);
    let tmp = store.tmp_dir().join(format!("{id}.known.json"));
    match blocking(move || jobs::fill_summary(&path, &tmp, &rec)).await {
        Ok(Ok(Some(s))) => {
            store.matches().insert(s);
            true
        }
        Ok(Ok(None)) => false,
        Ok(Err(e)) => {
            tracing::warn!(demo = id, error = %e, "cannot bring a summary up to date");
            false
        }
        Err(e) => {
            tracing::warn!(demo = id, error = %e, "cannot bring a summary up to date");
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHA_A: &str = "3add9222a1dd3cce551e3786c8f60de902b9bceddaa5af5265cdb2efc8a81b86";
    const SHA_B: &str = "1388e119fe8773c20b5ac1dda497c0b9e5e2403f67b93eb80dea1eb44aae9dfd";

    fn line(file: &str, sha: &str, event: Option<&str>) -> String {
        serde_json::json!({
            "source": "hf",
            "dataset": "owner/set",
            "path": file,
            "file": file,
            "sha256": sha,
            "bytes": 4,
            "map": "de_nuke",
            "event": event,
            "fetched_unix": 1792729209u64,
        })
        .to_string()
    }

    fn corpus(lines: &[String], files: &[&str]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for f in files {
            let path = dir.path().join(f);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"demo").unwrap();
        }
        fs::write(dir.path().join(INDEX), lines.join("\n") + "\n").unwrap();
        dir
    }

    #[test]
    fn index_lines_become_entries_with_their_event() {
        let a = "hf/owner__set/cac2026/a-vs-b-nuke.dem";
        let b = "hf/owner__set/cac2026/c-vs-d-inferno.dem.bz2";
        let dir = corpus(
            &[line(a, SHA_A, Some("cac2026")), line(b, SHA_B, None)],
            &[a, b],
        );
        let entries = read_index(dir.path()).unwrap();
        assert_eq!(
            entries,
            [
                ImportEntry {
                    path: dir.path().join(a),
                    index_sha: SHA_A.into(),
                    event: Some("cac2026".into()),
                    teams: None,
                },
                ImportEntry {
                    path: dir.path().join(b),
                    index_sha: SHA_B.into(),
                    event: None,
                    teams: None,
                },
            ]
        );
    }

    fn line_with_teams(file: &str, teams: serde_json::Value) -> String {
        let mut v: serde_json::Value = serde_json::from_str(&line(file, SHA_A, None)).unwrap();
        v["teams"] = teams;
        v.to_string()
    }

    #[test]
    fn a_line_with_two_team_names_carries_them() {
        let a = "hf/x/a.dem";
        let dir = corpus(
            &[line_with_teams(
                a,
                serde_json::json!(["Spirit", " Falcons "]),
            )],
            &[a],
        );
        let entries = read_index(dir.path()).unwrap();
        assert_eq!(entries[0].teams, Some(["Spirit".into(), "Falcons".into()]));
    }

    #[test]
    fn teams_that_are_not_two_non_empty_names_are_none() {
        let a = "hf/x/a.dem";
        for teams in [
            serde_json::json!(["Spirit"]),
            serde_json::json!(["", "x"]),
            serde_json::json!(["  ", "x"]),
            serde_json::json!(["a", "b", "c"]),
            serde_json::json!(["a", 3]),
            serde_json::json!("Spirit vs Falcons"),
            serde_json::json!(null),
            serde_json::json!([]),
        ] {
            let dir = corpus(&[line_with_teams(a, teams.clone())], &[a]);
            let entries = read_index(dir.path()).unwrap();
            assert_eq!(entries.len(), 1, "{teams}: the line is still read");
            assert_eq!(entries[0].teams, None, "{teams}");
        }
        let dir = corpus(&[line(a, SHA_A, None)], &[a]);
        assert_eq!(read_index(dir.path()).unwrap()[0].teams, None);
    }

    #[test]
    fn a_line_whose_file_is_missing_or_not_a_demo_is_skipped() {
        let kept = "hf/x/a.dem.gz";
        let dir = corpus(
            &[
                line("hf/x/missing.dem", SHA_A, None),
                line("hf/x/notes.txt", SHA_A, None),
                line("hf/x", SHA_A, None),
                line("../outside.dem", SHA_A, None),
                line("/etc/passwd.dem", SHA_A, None),
                line(kept, SHA_B, None),
            ],
            &["hf/x/notes.txt", kept],
        );
        fs::write(dir.path().parent().unwrap().join("outside.dem"), b"x").ok();
        let entries = read_index(dir.path()).unwrap();
        let paths: Vec<_> = entries.iter().map(|e| e.path.clone()).collect();
        assert_eq!(paths, [dir.path().join(kept)]);
    }

    #[test]
    fn a_malformed_line_is_skipped_not_fatal() {
        let ok = "hf/x/a.dem";
        let dir = corpus(
            &[
                "not json".into(),
                "{}".into(),
                line(ok, "not-a-sha", None),
                String::new(),
                line(ok, SHA_A, Some("cac2026")),
            ],
            &[ok],
        );
        let entries = read_index(dir.path()).unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].index_sha, SHA_A);
    }

    #[test]
    fn the_import_log_survives_a_reopen() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("tmp")).unwrap();
        let log = ImportLog::open(dir.path()).unwrap();
        assert!(!log.contains(SHA_A));
        log.insert(SHA_A, "Jnv7rxggBidutAQ2kv4DRv").unwrap();
        assert!(log.contains(SHA_A));
        let again = ImportLog::open(dir.path()).unwrap();
        assert!(again.contains(SHA_A) && !again.contains(SHA_B));
    }
}
