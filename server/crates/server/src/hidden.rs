//! Profiles the owner has hidden (a person who asked to be taken off the site): `hidden.json`
//! in the data directory, a list of steamids, edited by `demoviewer-server hide <steamid>` and
//! `unhide <steamid>` ([`edit`]) and read again by the running server once it changes
//! ([`Hidden::is_hidden`]).

use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use crate::store;

/// The list's file name in the data directory.
pub const FILE: &str = "hidden.json";
/// How often the running server looks whether the file changed.
const CHECK_EVERY: Duration = Duration::from_secs(60);

pub struct Hidden {
    path: PathBuf,
    every: Duration,
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    ids: HashSet<u64>,
    /// The file's modification time and size when last read; `None` when it was missing.
    seen: Option<(SystemTime, u64)>,
    checked: Option<Instant>,
}

impl Hidden {
    /// The list at `path`, read now; a missing file hides nobody.
    pub fn open(path: &Path) -> Hidden {
        Hidden::open_checking_every(path, CHECK_EVERY)
    }

    /// [`Hidden::open`], looking for changes every `every` instead of every minute.
    #[doc(hidden)]
    pub fn open_checking_every(path: &Path, every: Duration) -> Hidden {
        let hidden = Hidden {
            path: path.to_owned(),
            every,
            state: Mutex::default(),
        };
        hidden.reload(&mut hidden.lock());
        hidden
    }

    /// Whether `id` is hidden. Reads the file again when it changed, looking at most once a
    /// minute.
    pub fn is_hidden(&self, id: u64) -> bool {
        let mut state = self.lock();
        if state.checked.is_none_or(|c| c.elapsed() >= self.every) {
            self.reload(&mut state);
        }
        state.ids.contains(&id)
    }

    /// Reads the file if it changed (its modification time or size) since it was last looked
    /// at. A file that cannot be read keeps the list as it was (logged).
    fn reload(&self, state: &mut State) {
        state.checked = Some(Instant::now());
        let now = fs::metadata(&self.path)
            .ok()
            .map(|m| (m.modified().unwrap_or(SystemTime::UNIX_EPOCH), m.len()));
        if now == state.seen {
            return;
        }
        // Seen either way: a broken file is warned about once, and read again once it changes.
        state.seen = now;
        match read(&self.path) {
            Ok(ids) => state.ids = ids.into_iter().collect(),
            Err(e) => {
                tracing::warn!(path = %self.path.display(), error = %e, "cannot read the hidden profiles")
            }
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// The steamids in the list at `path`; none when it is missing.
fn read(path: &Path) -> io::Result<BTreeSet<u64>> {
    let json = match fs::read(path) {
        Ok(json) => json,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(e) => return Err(e),
    };
    let ids: Vec<String> = serde_json::from_slice(&json)?;
    ids.iter()
        .map(|id| {
            id.parse()
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "not a steamid"))
        })
        .collect()
}

/// Hides `id` (or shows it again) in the list in `data_dir`, rewriting the file whole. A list
/// that cannot be read is left alone: the edit fails.
pub fn edit(data_dir: &Path, id: u64, hide: bool) -> io::Result<()> {
    let path = data_dir.join(FILE);
    let mut ids = read(&path)?;
    if hide {
        ids.insert(id);
    } else {
        ids.remove(&id);
    }
    let list: Vec<String> = ids.iter().map(u64::to_string).collect();
    store::write_file(
        &data_dir.join(format!("{FILE}.tmp")),
        &path,
        &serde_json::to_vec(&list)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: u64 = 76561198000000001;

    #[test]
    fn a_hidden_id_is_seen_after_the_file_changes() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = Hidden::open_checking_every(&dir.path().join(FILE), Duration::ZERO);
        assert!(!hidden.is_hidden(ID));
        edit(dir.path(), ID, true).unwrap();
        assert!(hidden.is_hidden(ID));
        assert!(!hidden.is_hidden(ID + 1));
        edit(dir.path(), ID, false).unwrap();
        assert!(!hidden.is_hidden(ID));
    }

    #[test]
    fn the_file_is_checked_at_most_every_interval() {
        let dir = tempfile::tempdir().unwrap();
        let hidden = Hidden::open_checking_every(&dir.path().join(FILE), Duration::from_secs(3600));
        assert!(!hidden.is_hidden(ID));
        edit(dir.path(), ID, true).unwrap();
        assert!(!hidden.is_hidden(ID), "not re-read within the interval");
        assert!(Hidden::open(&dir.path().join(FILE)).is_hidden(ID));
    }

    #[test]
    fn edit_hides_and_unhides() {
        let dir = tempfile::tempdir().unwrap();
        edit(dir.path(), ID, true).unwrap();
        edit(dir.path(), ID, true).unwrap();
        edit(dir.path(), ID + 1, true).unwrap();
        let read = || -> Vec<String> {
            serde_json::from_slice(&fs::read(dir.path().join(FILE)).unwrap()).unwrap()
        };
        assert_eq!(read(), [ID.to_string(), (ID + 1).to_string()]);
        edit(dir.path(), ID, false).unwrap();
        assert_eq!(read(), [(ID + 1).to_string()]);
    }

    #[test]
    fn a_broken_file_hides_nobody_and_is_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join(FILE), b"not json").unwrap();
        let hidden = Hidden::open(&dir.path().join(FILE));
        assert!(!hidden.is_hidden(ID));
        assert!(
            edit(dir.path(), ID, true).is_err(),
            "never overwrites what it cannot read"
        );
    }
}
