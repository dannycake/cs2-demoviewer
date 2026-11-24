//! Demo records and on-disk layout under `data_dir`:
//! `uploads/<uploadId>/` (an unfinished upload's `meta.json` and chunks, kept by
//! [`crate::uploads`]), `tmp/` (work files), `packs/<sha256hex>.dvpk.gz`,
//! `matches/<sha256hex>.json` (each pack's match summary, all of them held in a
//! [`MatchIndex`]), `originals/<sha256hex>.dem.zst` (every demo's original, zstd-compressed,
//! [`crate::originals`]), `og/<sha256hex>.jpg` (match pages' preview cards), `demos.json` (every
//! record, rewritten behind the changes by the store's saver thread, and `demos.json.prev`, the
//! file before its last write). Beside them, kept by their own modules: `profiles/<steamid>.json`
//! (Steam's facts about an account, [`crate::profiles`]), `profiles/vanities.json` (the custom
//! URL names resolved, and those Steam said no account has, [`crate::profiles`]),
//! `gc/<match id>.json` (the Game Coordinator's match info for a share code's match),
//! `hidden.json` (hidden profiles, [`crate::hidden`]) and `imported.json` (the corpus demos
//! imported, [`crate::import`]). In memory the records are also indexed by the share code they
//! came from, by the FACEIT match they are of, and by sha.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufReader, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::error::Category;
use sha2::{Digest, Sha256};
use tokio::sync::watch;

use crate::config::Config;
use crate::matches::MatchIndex;
use crate::sharecode::{self, ShareCode};

/// Where a demo is in its life. Serialised lowercase (`"resolving"` … `"error"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// A share code's replay URL is being asked of Valve.
    Resolving,
    Queued,
    Downloading,
    Parsing,
    Done,
    Error,
}

/// How a demo reached the server. Serialised lowercase; records from before it existed are
/// uploads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    #[default]
    Upload,
    Url,
    Sharecode,
    /// Fetched for a tracked player from their match history.
    Tracked,
    /// Imported from a directory of demos the server reads (the pro corpus).
    Import,
    /// Fetched for a FACEIT match ([`DemoRecord::faceit_match_id`]), from the demo FACEIT
    /// links to it.
    Faceit,
}

/// One demo id. Several ids may share a `sha256` (the same demo uploaded twice); they then
/// share one pack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DemoRecord {
    pub id: String,
    pub sha256: Option<String>,
    pub status: Status,
    pub map: Option<String>,
    pub rounds: Option<u16>,
    pub error: Option<String>,
    pub created_unix: u64,
    #[serde(default)]
    pub source: Source,
    /// Valve's match id (decimal), when a share code named it.
    #[serde(default)]
    pub match_id: Option<String>,
    /// The share code the demo came from, as [`sharecode::encode`] writes it: what a later post
    /// of the same code finds it by ([`Store::find_match`]).
    #[serde(default)]
    pub sharecode: Option<String>,
    /// When the match was played, when Valve's match info said.
    #[serde(default)]
    pub played_unix: Option<u64>,
    /// When the record became an error (its job failed, the server restarted under it, or its
    /// pack was evicted or found gone): what [`FAILED_RECORD_TTL`] counts from. The index keeps
    /// it in step with the status ([`stamp_failure`]); an error from before it existed gets the
    /// time it is first loaded.
    #[serde(default)]
    pub failed_unix: Option<u64>,
    /// The tournament an imported demo came from, as its corpus names it
    /// ([`crate::import`]); copied into its match summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event: Option<String>,
    /// The two teams of a pro match, as the corpus names them ([`crate::import`]); copied into
    /// its match summary. Left out of the JSON when unknown, so existing records stay as they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teams: Option<[String; 2]>,
    /// The Game Coordinator's game type for a share code's match ([`crate::gcbot::gc_game_type`]);
    /// copied into its match summary.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gc_game_type: Option<u32>,
    /// FACEIT's id of the match the demo is of, for a demo fetched for a FACEIT match: what a
    /// later claim of that match finds it by ([`Store::find_faceit`]); copied into its match
    /// summary. Valve's id stays in `match_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faceit_match_id: Option<String>,
}

/// The error a demo shows once its pack was evicted.
pub const EXPIRED: &str = "this replay expired from the cache; upload the demo again";
/// What an ingest is refused with, and a job fails with, when writing more could take the data
/// volume below `Config::min_free_bytes` ([`Store::has_room`]).
pub const LOW_DISK: &str = "the server is low on disk space; try again later";
/// How long the record of a failed job, or of a replay that expired, is kept from then
/// ([`DemoRecord::failed_unix`]), so its link can still say what went wrong.
pub const FAILED_RECORD_TTL: Duration = Duration::from_secs(24 * 3600);
/// How often the server forgets failed records past [`FAILED_RECORD_TTL`]
/// ([`Store::forget_failed_every`]), besides at startup.
pub const FORGET_FAILED_EVERY: Duration = Duration::from_secs(10 * 60);
/// The record index, and the copy of it before its last write.
const INDEX: &str = "demos.json";
const INDEX_PREV: &str = "demos.json.prev";
const PACK_SUFFIX: &str = ".dvpk.gz";
const SUMMARY_SUFFIX: &str = ".json";
const BASE58: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/// How long the saver waits before writing `demos.json` again after a write failed (less in
/// this module's tests, which wait for it).
const SAVE_RETRY: Duration = if cfg!(test) {
    Duration::from_millis(50)
} else {
    Duration::from_secs(5)
};

/// The demo index (in memory, mirrored to `demos.json`), the match index (mirroring
/// `matches/`) and the paths of everything on disk.
///
/// The index in memory is the truth for this process. A change to it costs its caller no disk
/// I/O: it wakes the saver, a thread of the store's own that writes the whole index to
/// `demos.json` ([`write_file`]) once per round, so changes made while a write is under way go
/// out together in the next one. What a client is told about a record waits until that record
/// is on disk ([`Store::get_saved`], [`Store::saved`]), so a crash cannot take back a state
/// someone was shown, such as `done` (code-health review 2026-10-26: every change rewrote and
/// renamed the file under the index lock, on the tokio worker threads that answer polls).
pub struct Store {
    data_dir: PathBuf,
    records: Arc<Mutex<Records>>,
    matches: MatchIndex,
    /// Whether packs are evicted (`Config::cache_bytes` is set), the one use of their order of
    /// use ([`Store::touch_pack`]).
    lru: bool,
    /// `Config::min_free_bytes`: what [`Store::room`] leaves free on the data volume.
    floor: u64,
    /// Stands in for asking the filesystem how much is free ([`Store::set_free_space`]).
    free_space: OnceLock<FreeSpace>,
    saver: Arc<Saver>,
    /// The saver's thread ([`Saver::run`]), joined on drop after its last write.
    saving: Option<std::thread::JoinHandle<()>>,
}

/// Every record by id, and three indexes kept in step by [`Records::insert`],
/// [`Records::update`] and [`Records::retain`]: the ids of those a share code can find by that
/// code ([`DemoRecord::sharecode`]; records in error are left out, as [`Store::find_match`]
/// never takes one), the ids of those a FACEIT match can find by its id, under the same rule
/// ([`DemoRecord::faceit_match_id`], [`Store::find_faceit`]), and the ids of each sha. A post
/// of a share code reads only its own code's few records (security audit 2026-10-23: it scanned
/// every record under the lock), and a completed upload or parse only its sha's
/// ([`Store::find_by_sha`], [`Store::alias_packed`]; code-health review 2026-10-26: they
/// scanned every record).
#[derive(Default)]
struct Records {
    by_id: HashMap<String, Entry>,
    by_code: HashMap<String, BTreeSet<String>>,
    by_faceit: HashMap<String, BTreeSet<String>>,
    by_sha: HashMap<String, BTreeSet<String>>,
    /// Counts the changes: every insert, update and removal makes the next one.
    gen: u64,
}

/// A record and the change ([`Records::gen`]) that last touched it, so that a reader can wait
/// until that change is on disk ([`Store::get_saved`]).
struct Entry {
    rec: DemoRecord,
    changed: u64,
}

/// What a record is indexed by: the share code and the FACEIT match id that find it, and its
/// sha.
#[derive(Default, PartialEq)]
struct Keys {
    code: Option<String>,
    faceit: Option<String>,
    sha: Option<String>,
}

impl Records {
    /// The code `r` is found by, if any.
    fn code_of(r: &DemoRecord) -> Option<&str> {
        r.sharecode.as_deref().filter(|_| r.status != Status::Error)
    }

    /// The FACEIT match id `r` is found by, if any: none for a record in error, like its code
    /// ([`Records::code_of`]), so a failed fetch of the match can be claimed again.
    fn faceit_of(r: &DemoRecord) -> Option<&str> {
        r.faceit_match_id
            .as_deref()
            .filter(|_| r.status != Status::Error)
    }

    fn keys_of(r: &DemoRecord) -> Keys {
        Keys {
            code: Records::code_of(r).map(str::to_owned),
            faceit: Records::faceit_of(r).map(str::to_owned),
            sha: r.sha256.clone(),
        }
    }

    fn get(&self, id: &str) -> Option<&DemoRecord> {
        self.by_id.get(id).map(|e| &e.rec)
    }

    fn values(&self) -> impl Iterator<Item = &DemoRecord> {
        self.by_id.values().map(|e| &e.rec)
    }

    fn len(&self) -> usize {
        self.by_id.len()
    }

    /// Adds `r`, replacing any record with its id.
    fn insert(&mut self, mut r: DemoRecord) {
        stamp_failure(&mut r);
        self.gen += 1;
        let id = r.id.clone();
        let entry = Entry {
            rec: r,
            changed: self.gen,
        };
        let before = self.by_id.insert(id.clone(), entry);
        let before = before
            .as_ref()
            .map_or_else(Keys::default, |e| Records::keys_of(&e.rec));
        self.reindex(&id, before);
    }

    /// Applies `f` to the record for `id`, if there is one; returns whether there was.
    fn update(&mut self, id: &str, f: impl FnOnce(&mut DemoRecord)) -> bool {
        let Some(e) = self.by_id.get_mut(id) else {
            return false;
        };
        let before = Records::keys_of(&e.rec);
        f(&mut e.rec);
        stamp_failure(&mut e.rec);
        self.gen += 1;
        e.changed = self.gen;
        self.reindex(id, before);
        true
    }

    /// Keeps the records for which `keep` is true.
    fn retain(&mut self, mut keep: impl FnMut(&DemoRecord) -> bool) {
        let gone: Vec<String> = self
            .values()
            .filter(|r| !keep(r))
            .map(|r| r.id.clone())
            .collect();
        if !gone.is_empty() {
            self.gen += 1;
        }
        for id in gone {
            if let Some(e) = self.by_id.remove(&id) {
                let Keys { code, faceit, sha } = Records::keys_of(&e.rec);
                unindex(&mut self.by_code, &id, code);
                unindex(&mut self.by_faceit, &id, faceit);
                unindex(&mut self.by_sha, &id, sha);
            }
        }
    }

    /// The records found by share code `code` (as [`sharecode::encode`] writes it).
    fn with_code<'a>(&'a self, code: &str) -> impl Iterator<Item = &'a DemoRecord> {
        self.with(&self.by_code, code)
    }

    /// The records found by FACEIT match id `id`.
    fn with_faceit<'a>(&'a self, id: &str) -> impl Iterator<Item = &'a DemoRecord> {
        self.with(&self.by_faceit, id)
    }

    /// The records of the demo with this sha.
    fn with_sha<'a>(&'a self, sha: &str) -> impl Iterator<Item = &'a DemoRecord> {
        self.with(&self.by_sha, sha)
    }

    fn with<'a>(
        &'a self,
        index: &'a HashMap<String, BTreeSet<String>>,
        key: &str,
    ) -> impl Iterator<Item = &'a DemoRecord> {
        index
            .get(key)
            .into_iter()
            .flatten()
            .filter_map(|id| self.get(id))
    }

    /// Moves `id` in the indexes from what it was indexed by, `before`, to what its record is
    /// indexed by now.
    fn reindex(&mut self, id: &str, before: Keys) {
        let now = self.get(id).map_or_else(Keys::default, Records::keys_of);
        if before.code != now.code {
            unindex(&mut self.by_code, id, before.code);
            index(&mut self.by_code, id, now.code);
        }
        if before.faceit != now.faceit {
            unindex(&mut self.by_faceit, id, before.faceit);
            index(&mut self.by_faceit, id, now.faceit);
        }
        if before.sha != now.sha {
            unindex(&mut self.by_sha, id, before.sha);
            index(&mut self.by_sha, id, now.sha);
        }
    }
}

fn index(index: &mut HashMap<String, BTreeSet<String>>, id: &str, key: Option<String>) {
    if let Some(key) = key {
        index.entry(key).or_default().insert(id.to_owned());
    }
}

fn unindex(index: &mut HashMap<String, BTreeSet<String>>, id: &str, key: Option<String>) {
    let Some(key) = key else {
        return;
    };
    if let Some(ids) = index.get_mut(&key) {
        ids.remove(id);
        if ids.is_empty() {
            index.remove(&key);
        }
    }
}

impl Store {
    /// Creates the directory layout, loads `demos.json` and the match summaries, clears `tmp/`
    /// (abandoned uploads are [`crate::uploads::Uploads::open`]'s), turns records whose job was
    /// queued or running when the last process stopped into errors (the queue lived in memory
    /// and is gone), and forgets failed records past [`FAILED_RECORD_TTL`]. A torn `demos.json`
    /// does not stop the server, though one from a newer server does ([`load_index`]); nor does
    /// a corrupt summary, which is skipped ([`MatchIndex::load`]).
    pub fn open(cfg: &Config) -> io::Result<Store> {
        let data_dir = cfg.data_dir.clone();
        for sub in ["uploads", "tmp", "packs", "matches", "og", "originals"] {
            fs::create_dir_all(data_dir.join(sub))?;
        }
        clear_dir(&data_dir.join("tmp"))?;

        let (mut list, recovered) = load_index(&data_dir)?;
        let mut interrupted = 0;
        for r in &mut list {
            if !matches!(r.status, Status::Done | Status::Error) {
                r.status = Status::Error;
                r.error = Some(restarted(r.source).into());
                interrupted += 1;
            }
        }
        // The share-code, FACEIT and sha indexes are rebuilt as the records go in.
        let mut records = Records::default();
        for r in list {
            records.insert(r);
        }

        let matches = MatchIndex::load(&data_dir.join("matches"))?;
        // What was just read is on disk already.
        let saver = Arc::new(Saver::new(data_dir.clone(), records.gen));
        let records = Arc::new(Mutex::new(records));
        let saving = {
            let (saver, records) = (saver.clone(), records.clone());
            std::thread::Builder::new()
                .name("demos.json".into())
                .spawn(move || saver.run(&records))?
        };
        let store = Store {
            data_dir,
            records,
            matches,
            lru: cfg.cache_bytes.is_some(),
            floor: cfg.min_free_bytes,
            free_space: OnceLock::new(),
            saver,
            saving: Some(saving),
        };
        if interrupted > 0 {
            tracing::warn!(
                interrupted,
                "jobs lost with the previous process marked as errors"
            );
        }
        if interrupted > 0 || recovered {
            store.rewrite();
        }
        store.forget_failed(FAILED_RECORD_TTL);
        Ok(store)
    }

    /// A fresh id: base58 of 16 random bytes, always 21 or 22 characters (the rare draw that
    /// encodes shorter is redrawn, so ids have one shape and [`valid_id`] can be strict).
    pub fn new_id() -> String {
        loop {
            let id = bs58::encode(rand::random::<[u8; 16]>()).into_string();
            if id.len() >= 21 {
                return id;
            }
        }
    }

    /// Adds a `Queued` record for an uploaded demo `id` (replacing any record with that id)
    /// and returns it.
    pub fn create(&self, id: &str) -> DemoRecord {
        self.create_from(id, Source::Upload)
    }

    /// [`Store::create`] for a demo that came from `source`.
    pub fn create_from(&self, id: &str, source: Source) -> DemoRecord {
        let rec = new_record(id, source);
        let mut records = self.lock();
        records.insert(rec.clone());
        self.changed(&records);
        rec
    }

    /// The record that answers for share code `code`, if any: one made for this very code (match
    /// id, outcome id and token alike) that is not an error, so a code being looked up or the
    /// demo it brought. A `Done` record counts only while its pack is on disk; `Done` wins over
    /// one in progress, then the oldest.
    ///
    /// Only the whole code finds a record, as only the whole code gets Valve's answer: the match
    /// id alone, which anyone may put in a code of their own, would hand out a link-only
    /// replay without Valve's check, and would let a forged code take over (and fail) the
    /// lookup of the real one (security review 2026-10-22). A code for a match the site has
    /// from an upload or a pasted URL is looked up and downloaded, then joins that pack by sha.
    pub fn find_match(&self, code: &ShareCode) -> Option<DemoRecord> {
        self.match_record(&self.lock(), code)
    }

    /// The record that answers for `code` ([`Store::find_match`]), or else a new `Resolving`
    /// share-code record `new_id` for it; returns the record and whether it was
    /// created. Atomic under the index lock, so of many posts of one share code at once only
    /// one creates a record, and so only one lookup runs.
    pub fn claim_match(&self, code: &ShareCode, new_id: &str) -> (DemoRecord, bool) {
        self.claim_match_from(code, new_id, Source::Sharecode)
    }

    /// [`Store::claim_match`] for a record from `source` (a tracked player's match).
    pub fn claim_match_from(
        &self,
        code: &ShareCode,
        new_id: &str,
        source: Source,
    ) -> (DemoRecord, bool) {
        let mut records = self.lock();
        if let Some(r) = self.match_record(&records, code) {
            return (r, false);
        }
        let rec = DemoRecord {
            status: Status::Resolving,
            match_id: Some(code.match_id.to_string()),
            sharecode: Some(sharecode::encode(code)),
            ..new_record(new_id, source)
        };
        records.insert(rec.clone());
        self.changed(&records);
        (rec, true)
    }

    /// [`Store::find_match`] in `records`, through their share-code index.
    fn match_record(&self, records: &Records, code: &ShareCode) -> Option<DemoRecord> {
        self.answering(records.with_code(&sharecode::encode(code)))
    }

    /// The record that answers for FACEIT match `id` (FACEIT's id of it), if any, by the rule a
    /// share code's does ([`Store::find_match`]): one made for this match that is not an error,
    /// so a fetch under way or the demo it brought. A `Done` record counts only while its pack
    /// is on disk; `Done` wins over one in progress, then the oldest.
    pub fn find_faceit(&self, id: &str) -> Option<DemoRecord> {
        self.answering(self.lock().with_faceit(id))
    }

    /// The record that answers for FACEIT match `id` ([`Store::find_faceit`]), or else a new
    /// FACEIT record `new_id` for it, played at `played_unix` (FACEIT's match detail); returns
    /// the record and whether it was created. Atomic under the index lock, so of a match posted
    /// twice at once, or posted while the poller fetches it, only one fetch runs. The new record
    /// is `Queued`, not `Resolving`: the job that downloads it writes the record only once the
    /// download ends, so nothing would move it on from `Resolving`.
    pub fn claim_faceit(
        &self,
        id: &str,
        new_id: &str,
        played_unix: Option<u64>,
    ) -> (DemoRecord, bool) {
        let mut records = self.lock();
        if let Some(r) = self.answering(records.with_faceit(id)) {
            return (r, false);
        }
        let rec = DemoRecord {
            faceit_match_id: Some(id.to_owned()),
            played_unix,
            ..new_record(new_id, Source::Faceit)
        };
        records.insert(rec.clone());
        self.changed(&records);
        (rec, true)
    }

    /// Of `found`, the records of one match (one share code's, or one FACEIT match's), the one
    /// that answers for it: not an error, and `Done` only while its pack is on disk; `Done`
    /// first, then the oldest (then the least id, so the answer does not depend on the order).
    fn answering<'a>(&self, found: impl Iterator<Item = &'a DemoRecord>) -> Option<DemoRecord> {
        let packed = |r: &DemoRecord| {
            r.sha256
                .as_deref()
                .is_some_and(|sha| self.pack_path(sha).is_file())
        };
        found
            .filter(|r| match r.status {
                Status::Error => false,
                Status::Done => packed(r),
                _ => true,
            })
            .min_by(|a, b| {
                let rank = |r: &DemoRecord| (r.status != Status::Done, r.created_unix);
                (rank(a), &a.id).cmp(&(rank(b), &b.id))
            })
            .cloned()
    }

    /// The record for `id` as it is in memory, which may be ahead of `demos.json`: for the
    /// server's own work. What answers a client is [`Store::get_saved`].
    pub fn get(&self, id: &str) -> Option<DemoRecord> {
        self.lock().get(id).cloned()
    }

    /// Whether record `id` is done, so its replay can be opened: false for one forgotten, or
    /// not finished, or failed (a pack evicted makes its record fail).
    pub fn is_done(&self, id: &str) -> bool {
        self.lock()
            .get(id)
            .is_some_and(|r| r.status == Status::Done)
    }

    /// Where the Game Coordinator's match info for Valve match `match_id` is kept.
    pub fn gc_path(&self, match_id: u64) -> PathBuf {
        self.data_dir.join("gc").join(format!("{match_id}.json"))
    }

    /// The data directory (`Config::data_dir`).
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Every record, as it is in memory ([`Store::get`]).
    pub fn records(&self) -> Vec<DemoRecord> {
        self.lock().by_id.values().map(|e| e.rec.clone()).collect()
    }

    /// The record for `id` once its latest change is on disk (or writing it failed, which is
    /// logged): what a client may be shown, as a restart cannot take it back. Waits for at most
    /// the saver's current write and the next one, and not at all for a record unchanged since.
    pub async fn get_saved(&self, id: &str) -> Option<DemoRecord> {
        let (rec, changed) = {
            let records = self.lock();
            let e = records.by_id.get(id)?;
            (e.rec.clone(), e.changed)
        };
        self.saver.wait(changed).await;
        Some(rec)
    }

    /// Waits until every change made so far is on disk (or writing it failed, which is logged):
    /// before a client is given the id of a record just made, and at shutdown.
    pub async fn saved(&self) {
        let gen = self.lock().gen;
        self.saver.wait(gen).await;
    }

    /// Applies `f` to the record for `id`, if there is one, and has the index saved.
    pub fn update(&self, id: &str, f: impl FnOnce(&mut DemoRecord)) {
        let mut records = self.lock();
        if records.update(id, f) {
            self.changed(&records);
        }
    }

    pub fn pack_path(&self, sha: &str) -> PathBuf {
        self.data_dir
            .join("packs")
            .join(format!("{sha}{PACK_SUFFIX}"))
    }

    /// Where the original demo of `sha` is kept, zstd-compressed ([`crate::originals`]): the
    /// data every later re-parse starts from.
    pub fn original_path(&self, sha: &str) -> PathBuf {
        self.data_dir
            .join("originals")
            .join(format!("{sha}.dem.zst"))
    }

    /// Whether the original demo of `sha` is kept.
    pub fn has_original(&self, sha: &str) -> bool {
        self.original_path(sha).is_file()
    }

    /// Every match summary, by sha. Whoever writes a summary to
    /// [`Store::summary_path`] adds it here before a record that shows it is `Done`.
    pub fn matches(&self) -> &MatchIndex {
        &self.matches
    }

    /// Where the match summary of the pack for `sha` lives (see [`crate::matches`]).
    pub fn summary_path(&self, sha: &str) -> PathBuf {
        self.data_dir
            .join("matches")
            .join(format!("{sha}{SUMMARY_SUFFIX}"))
    }

    /// Where the preview image of the match page for `sha` is kept once drawn (see
    /// [`crate::pages`]). A JPEG since 2026-10-24; the PNGs of the card before it are left.
    pub fn og_path(&self, sha: &str) -> PathBuf {
        self.data_dir.join("og").join(format!("{sha}.jpg"))
    }

    /// A record with this sha, preferring one that is `Done`, then one being worked on; the
    /// oldest wins a tie.
    pub fn find_by_sha(&self, sha: &str) -> Option<DemoRecord> {
        let rank = |s: Status| match s {
            Status::Done => 0,
            Status::Parsing => 1,
            Status::Downloading => 2,
            Status::Queued => 3,
            Status::Resolving => 4,
            Status::Error => 5,
        };
        self.lock()
            .with_sha(sha)
            .min_by(|a, b| {
                (rank(a.status), a.created_unix, &a.id).cmp(&(
                    rank(b.status),
                    b.created_unix,
                    &b.id,
                ))
            })
            .cloned()
    }

    /// Makes `id`, a record of a demo with this `sha`, an alias of a `Done` record with the same
    /// sha whose pack is on disk, if there is one: `Done` too, with its map and rounds, sharing
    /// its pack. Returns the record it now aliases. Checked and made in one call under the index
    /// lock, which [`Store::evict_lru`] holds while it deletes packs, so no alias is made of a
    /// pack mid-eviction (code-health review 2026-10-26: the check and the alias were separate
    /// calls, and a record could end `Done` with its pack gone).
    pub fn alias_packed(&self, id: &str, sha: &str) -> Option<DemoRecord> {
        let mut records = self.lock();
        let done = records
            .with_sha(sha)
            .filter(|r| r.id != id && r.status == Status::Done)
            .min_by(|a, b| (a.created_unix, &a.id).cmp(&(b.created_unix, &b.id)))
            .filter(|_| self.pack_path(sha).is_file())?
            .clone();
        let aliased = records.update(id, |r| {
            r.sha256 = Some(sha.to_owned());
            r.status = Status::Done;
            r.map = done.map.clone();
            r.rounds = done.rounds;
            r.error = None;
        });
        if !aliased {
            return None;
        }
        self.changed(&records);
        Some(done)
    }

    /// Deletes packs, least recently used (oldest mtime) first, until their total size is at
    /// most `limit_bytes`; returns the deleted paths in deletion order. Records that pointed
    /// at a deleted pack become errors saying the replay expired; its match summary stays.
    /// Serving or reusing a pack refreshes its mtime ([`Store::touch_pack`]), which is what
    /// makes the order LRU. Used only under an explicit cache limit (`Config::cache_bytes`):
    /// by default packs are kept forever.
    pub fn evict_lru(&self, limit_bytes: u64) -> io::Result<Vec<PathBuf>> {
        let mut packs = Vec::new();
        for entry in fs::read_dir(self.data_dir.join("packs"))? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(sha) = name.to_str().and_then(|n| n.strip_suffix(PACK_SUFFIX)) else {
                continue;
            };
            let meta = entry.metadata()?;
            if meta.is_file() {
                packs.push((meta.modified()?, entry.path(), meta.len(), sha.to_owned()));
            }
        }
        let mut total: u64 = packs.iter().map(|p| p.2).sum();
        if total <= limit_bytes {
            return Ok(Vec::new());
        }
        packs.sort_by(|a, b| (a.0, &a.1).cmp(&(b.0, &b.1)));

        // Hold the index while deleting so a record cannot be pointed at a pack mid-removal
        // ([`Store::alias_packed`] checks the pack under it). The order was read before the
        // lock, so a pack served in between may still go first: the order is approximate, and
        // the outcome stays consistent (its records read as expired, and a download under way
        // keeps its open file). Reading the directory under the lock would hold every request
        // that needs the index for the length of a scan of `packs/`.
        let mut records = self.lock();
        let mut removed = Vec::new();
        let mut gone = HashSet::new();
        for (_, path, len, sha) in packs {
            if total <= limit_bytes {
                break;
            }
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "cannot evict pack");
                    continue;
                }
            }
            total -= len;
            removed.push(path);
            gone.insert(sha);
        }
        let expired: Vec<String> = records
            .values()
            .filter(|r| {
                r.status == Status::Done && r.sha256.as_ref().is_some_and(|s| gone.contains(s))
            })
            .map(|r| r.id.clone())
            .collect();
        for id in &expired {
            records.update(id, |r| {
                r.status = Status::Error;
                r.error = Some(EXPIRED.into());
            });
        }
        if !expired.is_empty() {
            self.changed(&records);
        }
        Ok(removed)
    }

    /// Marks the pack for `sha` as just used, for [`Store::evict_lru`]. Setting the mtime is a
    /// write to the disk (and to the array's parity), so it happens only under a cache limit,
    /// the one thing that reads the order; by default every pack read would write for nothing
    /// (code-health review 2026-10-26).
    pub fn touch_pack(&self, sha: &str) {
        if !self.lru {
            return;
        }
        let path = self.pack_path(sha);
        let touched = File::options()
            .write(true)
            .open(&path)
            .and_then(|f| f.set_modified(SystemTime::now()));
        if let Err(e) = touched {
            tracing::debug!(path = %path.display(), error = %e, "cannot touch pack");
        }
    }

    /// Whether the data volume has `need` bytes free and `Config::min_free_bytes` more to
    /// spare: what an ingest is admitted on and a job checks before it writes (security audit
    /// 2026-10-23). A volume whose free space cannot be read counts as having room (the floor is
    /// a guard, not the only limit).
    pub fn has_room(&self, need: u64) -> bool {
        self.free_bytes()
            .is_none_or(|free| free >= need.saturating_add(self.floor))
    }

    /// Bytes that may still be written before the data volume is down to
    /// `Config::min_free_bytes` free (`u64::MAX` when its free space cannot be read).
    pub fn room(&self) -> u64 {
        self.free_bytes()
            .map_or(u64::MAX, |free| free.saturating_sub(self.floor))
    }

    /// The data volume's free bytes: [`free_bytes`], or what [`Store::set_free_space`] gave.
    fn free_bytes(&self) -> Option<u64> {
        match self.free_space.get() {
            Some(free) => Some(free()),
            None => free_bytes(&self.data_dir).ok(),
        }
    }

    /// Test seam: from now on, the data volume's free bytes are what `free` says (once per
    /// store; a second call changes nothing). Not for production use.
    #[doc(hidden)]
    pub fn set_free_space(&self, free: FreeSpace) {
        let _ = self.free_space.set(free);
    }

    /// Removes records of jobs that failed (or whose replay expired) more than `max_age` ago
    /// and returns how many went, so cheap failing submissions cannot grow the index without
    /// bound (security audit 2026-10-22). Successful records stay. The age counts from the
    /// failure, not from the record's creation: a replay that expires months after it was made
    /// says so for all of `max_age` (code-health review 2026-10-26: it was forgotten at the
    /// next sweep).
    pub fn forget_failed(&self, max_age: Duration) -> usize {
        self.forget_failed_at(max_age, unix_now())
    }

    /// [`Store::forget_failed`] as of `now` (Unix seconds).
    fn forget_failed_at(&self, max_age: Duration, now: u64) -> usize {
        let cutoff = now.saturating_sub(max_age.as_secs());
        let mut records = self.lock();
        let before = records.len();
        records.retain(|r| {
            r.status != Status::Error || r.failed_unix.unwrap_or(r.created_unix) >= cutoff
        });
        let gone = before - records.len();
        if gone > 0 {
            self.changed(&records);
        }
        gone
    }

    /// From now on, every `every`, forgets the records of jobs that failed more than `max_age`
    /// ago ([`Store::forget_failed`]), on the current tokio runtime for as long as the store
    /// lives. Besides startup, this is what forgets them (security audit 2026-10-23: only upload
    /// starts and startup did, though URL and share-code posts leave failed records too; an
    /// upload start no longer scans the records, code-health review 2026-10-26).
    pub fn forget_failed_every(self: &Arc<Self>, every: Duration, max_age: Duration) {
        let store = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut ticks = tokio::time::interval(every);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // The first tick is now, and opening the store has just forgotten them.
            ticks.tick().await;
            loop {
                ticks.tick().await;
                let Some(store) = store.upgrade() else {
                    break;
                };
                // It scans every record under the index lock.
                match tokio::task::spawn_blocking(move || store.forget_failed(max_age)).await {
                    Ok(0) => {}
                    Ok(gone) => tracing::info!(gone, "failed records forgotten"),
                    Err(e) => tracing::error!(error = %e, "forgetting failed records failed"),
                }
            }
        });
    }

    /// Work files for jobs and upload assembly; emptied on [`Store::open`].
    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    /// Where unfinished uploads live, one directory each.
    pub fn uploads_dir(&self) -> PathBuf {
        self.data_dir.join("uploads")
    }

    /// The chunk directory of an upload (it need not exist).
    pub fn upload_dir(&self, upload_id: &str) -> PathBuf {
        self.uploads_dir().join(upload_id)
    }

    fn lock(&self) -> MutexGuard<'_, Records> {
        self.records.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Has the saver write `records`, which the caller has just changed and still holds.
    fn changed(&self, records: &Records) {
        self.saver.want(records.gen);
    }

    /// Has the saver write the index although no record changed since it was read: it was
    /// changed on the way in ([`Store::open`]).
    fn rewrite(&self) {
        let mut records = self.lock();
        records.gen += 1;
        self.changed(&records);
    }

    /// [`Store::saved`], blocking: for tests that open a second store on the same directory.
    #[cfg(test)]
    fn flush(&self) {
        let gen = self.lock().gen;
        let mut state = self.saver.lock();
        while state.settled < gen {
            state = self
                .saver
                .wake
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }
}

impl Drop for Store {
    /// Writes what is not written yet, then stops the saver.
    fn drop(&mut self) {
        self.saver.stop();
        if let Some(saving) = self.saving.take() {
            if saving.join().is_err() {
                tracing::error!("the demos.json saver panicked");
            }
        }
    }
}

/// What the saver's thread and the store share: which change is the latest
/// ([`SaveState::wanted`]) and which is written ([`SaveState::settled`], also sent on
/// [`Saver::saved`] for async waiters).
struct Saver {
    data_dir: PathBuf,
    state: Mutex<SaveState>,
    wake: Condvar,
    saved: watch::Sender<u64>,
}

struct SaveState {
    /// The latest change made ([`Records::gen`]).
    wanted: u64,
    /// The latest change written, or whose write failed: so a failing disk delays nobody, and
    /// the index in memory stays the truth until a write succeeds again.
    settled: u64,
    /// Set when the store is dropped: write what is wanted, then end.
    stop: bool,
}

impl Saver {
    /// A saver for an index whose changes up to `gen` are on disk.
    fn new(data_dir: PathBuf, gen: u64) -> Saver {
        Saver {
            data_dir,
            state: Mutex::new(SaveState {
                wanted: gen,
                settled: gen,
                stop: false,
            }),
            wake: Condvar::new(),
            saved: watch::Sender::new(gen),
        }
    }

    fn lock(&self) -> MutexGuard<'_, SaveState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Asks for change `gen` to be written. Called under the index lock, so `wanted` only grows.
    fn want(&self, gen: u64) {
        let mut state = self.lock();
        if gen > state.wanted {
            state.wanted = gen;
            self.wake.notify_all();
        }
    }

    fn stop(&self) {
        self.lock().stop = true;
        self.wake.notify_all();
    }

    /// Waits until change `gen` is written, or its write failed.
    async fn wait(&self, gen: u64) {
        let mut saved = self.saved.subscribe();
        // An error means the saver is gone, and nothing is left to wait for.
        let _ = saved.wait_for(|&settled| settled >= gen).await;
    }

    /// The saver's thread: whenever a change is wanted, writes the whole index as it is then
    /// (which covers every change made meanwhile), oldest record first; after a failed write,
    /// writes again every [`SAVE_RETRY`] until one succeeds. Ends after the write that follows
    /// [`Saver::stop`].
    fn run(&self, records: &Mutex<Records>) {
        /// Lets every waiter go if the thread ends, by a panic or otherwise.
        struct Done<'a>(&'a Saver);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.lock().settled = u64::MAX;
                self.0.wake.notify_all();
                self.0.saved.send_replace(u64::MAX);
            }
        }
        let _done = Done(self);
        let mut failing = false;
        loop {
            let mut state = self.lock();
            while state.wanted <= state.settled && !state.stop {
                if failing {
                    let (next, waited) = self
                        .wake
                        .wait_timeout(state, SAVE_RETRY)
                        .unwrap_or_else(PoisonError::into_inner);
                    state = next;
                    if waited.timed_out() {
                        break;
                    }
                } else {
                    state = self
                        .wake
                        .wait(state)
                        .unwrap_or_else(PoisonError::into_inner);
                }
            }
            let stopping = state.stop;
            if stopping && state.wanted <= state.settled && !failing {
                return;
            }
            drop(state);

            // Only the copy is made under the index lock; sorting, serialising and writing are
            // not.
            let (gen, mut list) = {
                let records = records.lock().unwrap_or_else(PoisonError::into_inner);
                (records.gen, records.values().cloned().collect::<Vec<_>>())
            };
            list.sort_by(|a, b| (a.created_unix, &a.id).cmp(&(b.created_unix, &b.id)));
            let written = serde_json::to_vec(&list)
                .map_err(io::Error::from)
                .and_then(|json| write_index(&self.data_dir, &json));
            match &written {
                Ok(()) if failing => tracing::info!("demos.json written again"),
                Ok(()) => {}
                Err(e) => tracing::error!(
                    error = %e,
                    "cannot write demos.json; the index in memory stays authoritative and the \
                     write is tried again every {SAVE_RETRY:?}"
                ),
            }
            failing = written.is_err();

            let mut state = self.lock();
            state.settled = state.settled.max(gen);
            drop(state);
            self.wake.notify_all();
            self.saved
                .send_modify(|settled| *settled = (*settled).max(gen));
            if stopping {
                return;
            }
        }
    }
}

/// Writes `json` as `demos.json` in `data_dir` as [`write_file`] does, keeping the file it
/// replaces as `demos.json.prev`: the last good copy, which [`load_index`] falls back on. The
/// file replaced was read whole at startup or written whole since. A copy that cannot be kept
/// is logged, and the write goes on.
fn write_index(data_dir: &Path, json: &[u8]) -> io::Result<()> {
    let tmp = data_dir.join("demos.json.tmp");
    let mut file = File::create(&tmp)?;
    file.write_all(json)?;
    file.sync_all()?;
    drop(file);
    if let Err(e) = keep_previous(data_dir) {
        tracing::warn!(error = %e, "cannot keep the last demos.json as demos.json.prev");
    }
    // One sync of the directory covers both renames.
    rename_synced(&tmp, &data_dir.join(INDEX))
}

/// Makes `demos.json.prev` the current `demos.json`: a hard link (no copy), renamed over the
/// old one, so once there is a `demos.json.prev` there always is one. Nothing to keep before
/// the first write.
fn keep_previous(data_dir: &Path) -> io::Result<()> {
    let link = data_dir.join("demos.json.prev.tmp");
    match fs::remove_file(&link) {
        Err(e) if e.kind() != ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    match fs::hard_link(data_dir.join(INDEX), &link) {
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        linked => linked.and_then(|()| fs::rename(&link, data_dir.join(INDEX_PREV))),
    }
}

/// The records of `demos.json` in `data_dir`, and whether they came from elsewhere (and so
/// must be written back). A torn `demos.json` (cut short, emptied, not JSON) does not stop the
/// server, as `restart: unless-stopped` would only restart it into the same failure
/// (code-health review 2026-10-26): it is set aside as `demos.json.corrupt-<unix time>`, never
/// deleted, and the records are read from `demos.json.prev`, the file before the last write,
/// whose changes are lost. When that is torn too (set aside likewise) or missing, the index
/// starts empty. Each case is logged as an error. The packs and match summaries stay either
/// way, but they cannot rebuild a lost record: a demo's id, which its link names, is only in
/// `demos.json`.
///
/// Two failures still stop the server, as the file itself may be fine: a read error other than
/// a missing file, and either file holding JSON this binary cannot read as the records (a
/// status it does not know, say). This server only ever writes whole records, so the second is
/// a file from a newer server after a rollback; starting from the copy or empty would answer
/// 404 for every demo while looking healthy ([`check_version`]). Both files are read and
/// checked before either is set aside, so a refusal leaves the data directory as it was
/// (fix-server review: a torn `demos.json` over a newer server's copy was set aside before the
/// copy refused, and the older server, finding no `demos.json`, would start empty and write
/// one that the next run kept over the copy).
fn load_index(data_dir: &Path) -> io::Result<(Vec<DemoRecord>, bool)> {
    let (index, prev) = (data_dir.join(INDEX), data_dir.join(INDEX_PREV));
    // Why `demos.json` cannot be used; `None` when it is missing.
    let torn = match check_version(&index, read_records(&index)?)? {
        Some(Ok(list)) => return Ok((list, false)),
        Some(Err(e)) => Some(e),
        None => None,
    };
    let copy = check_version(&prev, read_records(&prev)?)?;
    match torn {
        // A new data directory.
        None if copy.is_none() => return Ok((Vec::new(), false)),
        None => tracing::error!(
            path = %index.display(),
            "demos.json is missing but demos.json.prev is not; reading that"
        ),
        Some(e) => {
            let aside = set_aside(&index)?;
            tracing::error!(
                path = %index.display(),
                error = %e,
                kept = %aside.display(),
                "demos.json is unreadable; it is kept aside and demos.json.prev is read instead"
            );
        }
    }
    match copy {
        Some(Ok(list)) => {
            tracing::error!(
                records = list.len(),
                "records read from demos.json.prev: the changes of the last write before the \
                 stop are lost"
            );
            Ok((list, true))
        }
        None => {
            tracing::error!(
                "no demos.json.prev: starting with no records, so earlier demo links answer 404"
            );
            Ok((Vec::new(), true))
        }
        Some(Err(e)) => {
            let aside = set_aside(&prev)?;
            tracing::error!(
                error = %e,
                kept = %aside.display(),
                "demos.json.prev is unreadable too and is kept aside: starting with no records, \
                 so earlier demo links answer 404"
            );
            Ok((Vec::new(), true))
        }
    }
}

/// The records in the file at `path`, or why they cannot be read from it; `None` when there is
/// no file.
fn read_records(path: &Path) -> io::Result<Option<serde_json::Result<Vec<DemoRecord>>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes))),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Passes on what [`read_records`] read from `path`, unless it is JSON that is not records this
/// binary knows (serde's [`Category::Data`]): that is an error naming the file. A torn file
/// (cut short, emptied, zeroes) fails as a syntax error or an early end instead.
fn check_version(
    path: &Path,
    read: Option<serde_json::Result<Vec<DemoRecord>>>,
) -> io::Result<Option<serde_json::Result<Vec<DemoRecord>>>> {
    match read {
        Some(Err(e)) if e.classify() == Category::Data => Err(io::Error::new(
            ErrorKind::InvalidData,
            format!(
                "{} is JSON this server cannot read as demo records ({e}); was it written by a \
                 newer server? Refusing to start rather than hide every demo: run the newer \
                 server again, or move the file aside by hand",
                path.display()
            ),
        )),
        read => Ok(read),
    }
}

/// Renames the file at `path` to `<path>.corrupt-<unix time>` (`-2`, `-3`… after it should
/// that name be taken) and returns the new path.
pub(crate) fn set_aside(path: &Path) -> io::Result<PathBuf> {
    let now = unix_now();
    let aside = (1u32..)
        .map(|n| {
            let mut name = path.as_os_str().to_owned();
            name.push(format!(".corrupt-{now}"));
            if n > 1 {
                name.push(format!("-{n}"));
            }
            PathBuf::from(name)
        })
        .find(|p| !p.exists())
        .expect("a free name");
    fs::rename(path, &aside)?;
    sync_dir(path.parent().unwrap_or(Path::new(".")))?;
    Ok(aside)
}

/// A `Queued` record for `id`, created now.
pub(crate) fn new_record(id: &str, source: Source) -> DemoRecord {
    DemoRecord {
        id: id.to_owned(),
        sha256: None,
        status: Status::Queued,
        map: None,
        rounds: None,
        error: None,
        created_unix: unix_now(),
        source,
        match_id: None,
        sharecode: None,
        played_unix: None,
        failed_unix: None,
        event: None,
        teams: None,
        gc_game_type: None,
        faceit_match_id: None,
    }
}

/// Keeps [`DemoRecord::failed_unix`] in step with the status: the time a record becomes an
/// error, unless whoever made it one set it; none for a record that is not one.
fn stamp_failure(r: &mut DemoRecord) {
    if r.status != Status::Error {
        r.failed_unix = None;
    } else if r.failed_unix.is_none() {
        r.failed_unix = Some(unix_now());
    }
}

/// Seconds since the Unix epoch.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The error a demo shows when the server stopped before its job ended: how to send it again
/// depends on how it came.
fn restarted(source: Source) -> &'static str {
    match source {
        Source::Upload => "the server restarted before this demo was processed; upload it again",
        Source::Url => {
            "the server restarted before this demo was processed; paste its replay URL again"
        }
        Source::Sharecode => {
            "the server restarted before this demo was processed; paste its share code again"
        }
        Source::Faceit => {
            "the server restarted before this demo was processed; paste its FACEIT match link again"
        }
        Source::Tracked | Source::Import => "the server restarted before this demo was processed",
    }
}

/// True for strings shaped like the ids [`Store::new_id`] makes: 21 or 22 base58 characters.
/// Path parameters go through this before they become part of a file path.
pub fn valid_id(s: &str) -> bool {
    (21..=22).contains(&s.len()) && s.bytes().all(|b| BASE58.contains(&b))
}

/// Lowercase hex of `bytes`.
pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes
        .iter()
        .fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
            let _ = write!(s, "{b:02x}");
            s
        })
}

/// SHA-256 of a file's contents, as lowercase hex.
pub fn sha256_file(path: &Path) -> io::Result<String> {
    let mut hasher = Sha256::new();
    io::copy(
        &mut BufReader::with_capacity(1 << 20, File::open(path)?),
        &mut hasher,
    )?;
    Ok(hex(&hasher.finalize()))
}

/// Files deleted when this drops, however the work that made them ends (a panic or a dropped
/// request included): a job's work files, a chunk PUT's temp files. One renamed away meanwhile
/// is simply gone.
#[derive(Default)]
pub struct WorkFiles(Vec<PathBuf>);

impl WorkFiles {
    pub fn add(&mut self, path: &Path) {
        self.0.push(path.to_owned());
    }

    /// Lets go of every file: another step owns them now.
    pub fn release(&mut self) {
        self.0.clear();
    }
}

impl Drop for WorkFiles {
    fn drop(&mut self) {
        for path in &self.0 {
            if let Err(e) = fs::remove_file(path) {
                if e.kind() != ErrorKind::NotFound {
                    tracing::warn!(path = %path.display(), error = %e, "cannot delete work file");
                }
            }
        }
    }
}

/// How many bytes are free on the data volume, for [`Store::set_free_space`].
pub type FreeSpace = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Writes `bytes` to `dest` through `tmp` as [`replace_file`] does, so that `dest` is whole
/// whatever happens.
pub fn write_file(tmp: &Path, dest: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = File::create(tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    rename_synced(tmp, dest)
}

/// Moves the finished file `tmp` over `dest` (on the same filesystem) so that, after a crash or
/// a power cut, `dest` holds its old contents or all of the new ones: `tmp`'s data reaches the
/// disk before the rename, and the rename before this returns. A plain rename does not promise
/// that: on XFS (the production data disk's filesystem), a power cut after renaming over a file
/// whose data was still in memory can leave it empty, as ext4's flush on rename does not exist
/// there.
/// Every file the server renames into place to keep goes through this (`demos.json`, packs,
/// match summaries, preview cards, upload metadata). Chunks do not, as a chunk lost or cut
/// short by a crash costs at most its upload: one cut short fails the assembly, whose total
/// falls short of the declared size, but one left at its full length with a range of zeroes
/// inside (XFS's writeback may finish out of order) is assembled, and its job fails or parses
/// it wrong. Nor do work files, as `tmp/` is emptied at startup.
pub fn replace_file(tmp: &Path, dest: &Path) -> io::Result<()> {
    File::open(tmp)?.sync_all()?;
    rename_synced(tmp, dest)
}

fn rename_synced(tmp: &Path, dest: &Path) -> io::Result<()> {
    fs::rename(tmp, dest)?;
    sync_dir(dest.parent().unwrap_or(Path::new(".")))
}

/// Flushes a directory's entries (a rename into it) to the disk.
fn sync_dir(dir: &Path) -> io::Result<()> {
    File::open(dir)?.sync_all()
}

fn clear_dir(dir: &Path) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        let removed = if path.is_dir() {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        if let Err(e) = removed {
            tracing::warn!(path = %path.display(), error = %e, "cannot clear work file");
        }
    }
    Ok(())
}

/// Bytes free for an unprivileged user on the volume holding `path` (`statvfs`).
pub fn free_bytes(path: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| io::Error::new(ErrorKind::InvalidInput, e))?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is a NUL-terminated path and `st` a valid out-pointer for the call.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(dir: &Path) -> Config {
        Config {
            data_dir: dir.join("data"),
            ..Config::default()
        }
    }

    #[test]
    fn new_id_is_base58_of_16_bytes_and_unique() {
        let mut seen = HashSet::new();
        for _ in 0..5000 {
            let id = Store::new_id();
            assert!((21..=22).contains(&id.len()), "{id}");
            assert_eq!(bs58::decode(&id).into_vec().unwrap().len(), 16, "{id}");
            assert!(valid_id(&id), "{id}");
            assert!(seen.insert(id));
        }
        for bad in [
            "",
            "../../etc",
            "0OIl0OIl0OIl0OIl0OIl0",
            "abc/def",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert!(!valid_id(bad), "{bad:?}");
        }
    }

    /// A failed record is kept for the whole TTL from when it failed, however old the record
    /// itself, then forgotten; successful records stay. The clock is `forget_failed_at`'s `now`.
    #[test]
    fn failed_records_are_forgotten_a_ttl_after_they_failed() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let (ttl, now) = (Duration::from_secs(86_400), unix_now());
        for (id, status) in [
            ("oldErrorOldErrorOldErr", Status::Error),
            ("oldDoneOldDoneOldDoneA", Status::Done),
        ] {
            store.create(id);
            store.update(id, |r| {
                r.status = status;
                r.created_unix = now - 30 * 86_400;
            });
        }
        // One that says it failed longer ago than the TTL.
        store.create("dayOldErrorDayOldError");
        store.update("dayOldErrorDayOldError", |r| {
            r.status = Status::Error;
            r.failed_unix = Some(now - 86_400 - 1);
        });
        assert_eq!(store.forget_failed_at(ttl, now), 1);
        assert_eq!(store.get("dayOldErrorDayOldError"), None);
        assert!(store.get("oldErrorOldErrorOldErr").unwrap().failed_unix >= Some(now));

        assert_eq!(store.forget_failed_at(ttl, now + 86_400 - 60), 0);
        assert_eq!(store.forget_failed_at(ttl, now + 86_400 + 60), 1);
        assert_eq!(store.get("oldErrorOldErrorOldErr"), None);
        assert!(store.get("oldDoneOldDoneOldDoneA").is_some());
        // And on disk.
        store.flush();
        let reopened = Store::open(&config(dir.path())).unwrap();
        assert_eq!(reopened.get("oldErrorOldErrorOldErr"), None);
        assert!(reopened.get("oldDoneOldDoneOldDoneA").is_some());
    }

    /// A replay that expires (its pack evicted) months after its record was made says so for
    /// the whole TTL from then (code-health review 2026-10-26: it was forgotten at the next
    /// sweep, as the TTL counted from the record's creation, and its link answered 404).
    #[test]
    fn an_expired_replay_says_so_for_the_whole_ttl() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let sha = "ab".repeat(32);
        pack(&store, &sha, 100, 0);
        let id = "expiredExpiredExpired1";
        store.create(id);
        store.update(id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
            r.created_unix = unix_now() - 90 * 86_400;
        });
        assert_eq!(store.forget_failed(FAILED_RECORD_TTL), 0);
        store.evict_lru(0).unwrap();
        let now = unix_now();
        assert_eq!(store.get(id).unwrap().error.as_deref(), Some(EXPIRED));

        let ttl = FAILED_RECORD_TTL.as_secs();
        assert_eq!(store.forget_failed(FAILED_RECORD_TTL), 0);
        assert_eq!(store.forget_failed_at(FAILED_RECORD_TTL, now + ttl - 60), 0);
        assert_eq!(store.get(id).unwrap().error.as_deref(), Some(EXPIRED));
        assert_eq!(store.forget_failed_at(FAILED_RECORD_TTL, now + ttl + 60), 1);
        assert_eq!(store.get(id), None);
    }

    /// An error record from before `failed_unix` existed is kept for the TTL from the first
    /// start that reads it, rather than forgotten at once for its age.
    #[test]
    fn errors_from_before_failed_unix_get_a_ttl_from_now() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        fs::create_dir_all(&cfg.data_dir).unwrap();
        fs::write(
            cfg.data_dir.join("demos.json"),
            br#"[{"id":"aaaaaaaaaaaaaaaaaaaaaa","sha256":null,"status":"error","map":null,"rounds":null,"error":"this replay expired from the cache; upload the demo again","created_unix":1761100000}]"#,
        )
        .unwrap();
        let store = Store::open(&cfg).unwrap();
        let r = store.get("aaaaaaaaaaaaaaaaaaaaaa").unwrap();
        assert!(r.failed_unix >= Some(unix_now() - 60), "{r:?}");
    }

    /// Failed records are forgotten on a timer too, not only at startup: URL and share-code
    /// posts leave failed records as well (security audit 2026-10-23), and an upload start no
    /// longer looks. Done records stay; the timer keeps going.
    #[tokio::test]
    async fn failed_records_are_forgotten_on_a_timer() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(&config(dir.path())).unwrap());
        let old = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 2 * 86_400;
        let add = |id: &str, status: Status| {
            store.create_from(id, Source::Url);
            store.update(id, |r| {
                r.status = status;
                r.created_unix = old;
                r.failed_unix = Some(old);
            });
        };
        let gone = |id: &'static str| {
            let store = store.clone();
            async move {
                let deadline = std::time::Instant::now() + Duration::from_secs(5);
                while store.get(id).is_some() {
                    assert!(std::time::Instant::now() < deadline, "{id} stayed");
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            }
        };
        store.forget_failed_every(Duration::from_millis(50), FAILED_RECORD_TTL);
        add("oldErrorOldErrorOldErr", Status::Error);
        add("oldDoneOldDoneOldDoneA", Status::Done);
        gone("oldErrorOldErrorOldErr").await;
        add("nextErrorNextErrorNext", Status::Error);
        gone("nextErrorNextErrorNext").await;
        assert!(store.get("oldDoneOldDoneOldDoneA").is_some());
    }

    #[test]
    fn records_survive_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        let (done, queued) = {
            let store = Store::open(&cfg).unwrap();
            let a = store.create("aaaaaaaaaaaaaaaaaaaaaa");
            assert_eq!(a.status, Status::Queued);
            assert!(a.created_unix > 1_700_000_000);
            store.create("bbbbbbbbbbbbbbbbbbbbbb");
            store.update("aaaaaaaaaaaaaaaaaaaaaa", |r| {
                r.status = Status::Done;
                r.sha256 = Some("ab".repeat(32));
                r.map = Some("de_mirage".into());
                r.rounds = Some(24);
            });
            (
                store.get("aaaaaaaaaaaaaaaaaaaaaa").unwrap(),
                store.get("bbbbbbbbbbbbbbbbbbbbbb").unwrap(),
            )
        };
        assert!(cfg.data_dir.join("demos.json").is_file());

        let store = Store::open(&cfg).unwrap();
        assert_eq!(store.get("aaaaaaaaaaaaaaaaaaaaaa"), Some(done));
        // A job that was queued or running when the server stopped is lost with the queue.
        let b = store.get("bbbbbbbbbbbbbbbbbbbbbb").unwrap();
        assert_eq!(b.status, Status::Error);
        assert!(b.error.unwrap().contains("restarted"));
        assert_eq!(b.created_unix, queued.created_unix);
        assert_eq!(store.get("cccccccccccccccccccccc"), None);
    }

    /// A job lost with the previous process says how to send its demo again, which depends on
    /// how it came: a share code still being looked up has nothing to upload.
    #[test]
    fn an_interrupted_job_says_how_to_send_its_demo_again() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        {
            let store = Store::open(&cfg).unwrap();
            store.create("aaaaaaaaaaaaaaaaaaaaaa");
            store.create_from("bbbbbbbbbbbbbbbbbbbbbb", Source::Url);
            let code = ShareCode {
                match_id: 7,
                outcome_id: 8,
                token: 9,
            };
            let (r, _) = store.claim_match(&code, "cccccccccccccccccccccc");
            assert_eq!(r.status, Status::Resolving);
        }
        let store = Store::open(&cfg).unwrap();
        let error = |id: &str| {
            let r = store.get(id).unwrap();
            assert_eq!(r.status, Status::Error);
            r.error.unwrap()
        };
        assert!(error("aaaaaaaaaaaaaaaaaaaaaa").ends_with("; upload it again"));
        assert!(error("bbbbbbbbbbbbbbbbbbbbbb").ends_with("; paste its replay URL again"));
        assert!(error("cccccccccccccccccccccc").ends_with("; paste its share code again"));
    }

    /// Only the whole share code finds its demo: a code with the match id and another outcome
    /// id or token, which anyone can write, neither joins the lookup in progress nor finds the
    /// done demo, and its own failed lookup is found by nothing.
    #[test]
    fn only_the_whole_share_code_finds_its_demo() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        let store = Store::open(&cfg).unwrap();
        let real = ShareCode {
            match_id: 7,
            outcome_id: 8,
            token: 9,
        };
        let forged = [
            ShareCode {
                outcome_id: 0,
                ..real
            },
            ShareCode { token: 0, ..real },
            ShareCode {
                outcome_id: 0,
                token: 0,
                ..real
            },
        ];
        let found = |store: &Store, code: &ShareCode| store.find_match(code).map(|r| r.id);
        let (r, created) = store.claim_match(&real, "aaaaaaaaaaaaaaaaaaaaaa");
        assert!(created);
        assert_eq!(found(&store, &real), Some(r.id.clone()));
        assert_eq!(
            store.claim_match(&real, "bbbbbbbbbbbbbbbbbbbbbb"),
            (r.clone(), false)
        );
        for f in &forged {
            assert_eq!(found(&store, f), None, "{f:?}");
        }
        let (fake, created) = store.claim_match(&forged[0], "cccccccccccccccccccccc");
        assert!(created);
        store.update(&fake.id, |r| r.status = Status::Error);
        assert_eq!(found(&store, &forged[0]), None);

        let sha = "ab".repeat(32);
        fs::write(store.pack_path(&sha), b"pack").unwrap();
        store.update(&r.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        store.flush();
        let reopened = Store::open(&cfg).unwrap();
        for store in [&store, &reopened] {
            assert_eq!(found(store, &real), Some(r.id.clone()));
            for f in &forged {
                assert_eq!(found(store, f), None, "{f:?}");
            }
        }
    }

    /// The share-code index answers like a scan of every record would, and holds what a
    /// rebuild from the records would hold, through inserts, updates (status and code), errors,
    /// evictions, forgetting and reopening (security audit 2026-10-23: a post scanned every
    /// record under the lock).
    #[test]
    fn the_share_code_index_follows_every_change() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        let store = Store::open(&cfg).unwrap();
        let code = |n: u64| ShareCode {
            match_id: n,
            outcome_id: n + 1,
            token: n as u16,
        };
        // What a scan of every record finds, with find_match's rules.
        let scanned = |store: &Store, c: &ShareCode| {
            let records = store.lock();
            let encoded = sharecode::encode(c);
            records
                .values()
                .filter(|r| r.sharecode.as_deref() == Some(encoded.as_str()))
                .filter(|r| match r.status {
                    Status::Error => false,
                    Status::Done => r
                        .sha256
                        .as_deref()
                        .is_some_and(|sha| store.pack_path(sha).is_file()),
                    _ => true,
                })
                .min_by_key(|r| (r.status != Status::Done, r.created_unix, r.id.clone()))
                .map(|r| r.id.clone())
        };
        let check = |store: &Store| {
            assert_indexes_rebuilt(store);
            for n in 1..=4 {
                assert_eq!(
                    store.find_match(&code(n)).map(|r| r.id),
                    scanned(store, &code(n)),
                    "{n}"
                );
            }
        };
        let at = |store: &Store, id: &str, created: u64| {
            store.update(id, |r| r.created_unix = created);
        };

        // Two records for one code (the first failed, so a second was claimed), then a third.
        let (a, _) = store.claim_match(&code(1), "aaaaaaaaaaaaaaaaaaaaaa");
        at(&store, &a.id, 100);
        store.update(&a.id, |r| r.status = Status::Error);
        let (b, created) = store.claim_match(&code(1), "bbbbbbbbbbbbbbbbbbbbbb");
        assert!(created);
        at(&store, &b.id, 200);
        check(&store);
        assert_eq!(store.find_match(&code(1)).map(|r| r.id), Some(b.id.clone()));

        // An upload that gains code 1 later, older than b: the oldest in progress wins.
        store.create("cccccccccccccccccccccc");
        at(&store, "cccccccccccccccccccccc", 150);
        store.update("cccccccccccccccccccccc", |r| {
            r.sharecode = Some(sharecode::encode(&code(1)))
        });
        check(&store);
        assert_eq!(
            store.find_match(&code(1)).map(|r| r.id).as_deref(),
            Some("cccccccccccccccccccccc")
        );

        // Done wins over older ones in progress, while its pack is there.
        let sha = "ab".repeat(32);
        fs::write(store.pack_path(&sha), b"pack").unwrap();
        store.update(&b.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        check(&store);
        assert_eq!(store.find_match(&code(1)).map(|r| r.id), Some(b.id.clone()));
        fs::remove_file(store.pack_path(&sha)).unwrap();
        check(&store);

        // A record moved to another code, and one whose code is taken away.
        store.update("cccccccccccccccccccccc", |r| {
            r.sharecode = Some(sharecode::encode(&code(2)))
        });
        let (d, _) = store.claim_match(&code(3), "dddddddddddddddddddddd");
        store.update(&d.id, |r| r.sharecode = None);
        check(&store);
        assert_eq!(store.find_match(&code(3)), None);

        // Eviction turns a done record into an error, which leaves the index.
        let (e, _) = store.claim_match(&code(4), "eeeeeeeeeeeeeeeeeeeeee");
        let evicted = "cd".repeat(32);
        fs::write(store.pack_path(&evicted), b"pack").unwrap();
        store.update(&e.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(evicted.clone());
        });
        check(&store);
        assert_eq!(store.find_match(&code(4)).map(|r| r.id), Some(e.id.clone()));
        store.evict_lru(0).unwrap();
        check(&store);
        assert_eq!(store.find_match(&code(4)), None);

        // Forgetting old errors, and reopening (which fails the jobs in progress).
        assert!(store.forget_failed_at(Duration::ZERO, unix_now() + 1) >= 1);
        check(&store);
        drop(store);
        let reopened = Store::open(&cfg).unwrap();
        check(&reopened);
    }

    /// The store's indexes hold what a rebuild from its records would: the share codes and the
    /// FACEIT match ids of the records not in error, and every record's sha.
    fn assert_indexes_rebuilt(store: &Store) {
        let records = store.lock();
        let mut by_code: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut by_faceit: HashMap<String, BTreeSet<String>> = HashMap::new();
        let mut by_sha: HashMap<String, BTreeSet<String>> = HashMap::new();
        for r in records.values() {
            let usable = r.status != Status::Error;
            for (index, key) in [
                (&mut by_code, r.sharecode.clone().filter(|_| usable)),
                (&mut by_faceit, r.faceit_match_id.clone().filter(|_| usable)),
                (&mut by_sha, r.sha256.clone()),
            ] {
                if let Some(key) = key {
                    index.entry(key).or_default().insert(r.id.clone());
                }
            }
        }
        assert_eq!(records.by_code, by_code);
        assert_eq!(records.by_faceit, by_faceit);
        assert_eq!(records.by_sha, by_sha);
    }

    /// FACEIT room ids, as FACEIT writes them.
    const FACEIT_A: &str = "1-0e5a6c4f-1b2d-4c3e-9f8a-7b6c5d4e3f21";
    const FACEIT_B: &str = "1-9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a";

    /// Of two claims of one FACEIT match, the first makes a `Queued` FACEIT record with the
    /// match id and when it was played, and the second gets that record back, so a match posted
    /// twice (or posted while the poller fetches it) is fetched once. Valve's ids stay Valve's.
    /// A done record answers while its pack is there, as a share code's does.
    #[test]
    fn a_faceit_match_is_claimed_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        assert_eq!(store.find_faceit(FACEIT_A), None);
        let (r, created) =
            store.claim_faceit(FACEIT_A, "aaaaaaaaaaaaaaaaaaaaaa", Some(1_761_000_000));
        assert!(created);
        assert_eq!(
            (
                r.id.as_str(),
                r.status,
                r.source,
                r.faceit_match_id.as_deref(),
                r.played_unix
            ),
            (
                "aaaaaaaaaaaaaaaaaaaaaa",
                Status::Queued,
                Source::Faceit,
                Some(FACEIT_A),
                Some(1_761_000_000)
            )
        );
        assert_eq!((&r.match_id, &r.sharecode), (&None, &None));
        assert_eq!(store.get(&r.id), Some(r.clone()));
        assert_eq!(
            store.claim_faceit(FACEIT_A, "bbbbbbbbbbbbbbbbbbbbbb", None),
            (r.clone(), false)
        );
        assert_eq!(store.get("bbbbbbbbbbbbbbbbbbbbbb"), None);
        assert_eq!(store.find_faceit(FACEIT_A), Some(r.clone()));
        assert_eq!(store.find_faceit(FACEIT_B), None);
        assert_indexes_rebuilt(&store);

        let sha = "ab".repeat(32);
        store.update(&r.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        assert_eq!(
            store.find_faceit(FACEIT_A),
            None,
            "done, but its pack is not there"
        );
        fs::write(store.pack_path(&sha), b"pack").unwrap();
        assert_eq!(
            store.find_faceit(FACEIT_A).map(|r| r.id),
            Some(r.id.clone())
        );
        assert!(
            !store
                .claim_faceit(FACEIT_A, "cccccccccccccccccccccc", None)
                .1
        );
        assert_indexes_rebuilt(&store);
    }

    /// The FACEIT index is rebuilt from `demos.json` when the store opens: a done FACEIT match is
    /// found again by its id. One whose fetch the restart cut short is an error that says so and
    /// leaves the index, so its match can be claimed again. The source is written `"faceit"`,
    /// and a record with no FACEIT id is written without the field.
    #[test]
    fn faceit_records_are_reindexed_after_a_reload() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        let store = Store::open(&cfg).unwrap();
        let (done, _) = store.claim_faceit(FACEIT_A, "aaaaaaaaaaaaaaaaaaaaaa", Some(1));
        let sha = "cd".repeat(32);
        fs::write(store.pack_path(&sha), b"pack").unwrap();
        store.update(&done.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        let (cut, _) = store.claim_faceit(FACEIT_B, "bbbbbbbbbbbbbbbbbbbbbb", None);
        store.update(&cut.id, |r| r.status = Status::Downloading);
        store.create("cccccccccccccccccccccc");
        assert_indexes_rebuilt(&store);
        store.flush();
        let saved: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(cfg.data_dir.join(INDEX)).unwrap()).unwrap();
        let saved = |id: &str| saved.iter().find(|r| r["id"] == id).unwrap().clone();
        assert_eq!(saved(&done.id)["source"], "faceit");
        assert_eq!(saved(&done.id)["faceit_match_id"], FACEIT_A);
        assert!(saved("cccccccccccccccccccccc")
            .get("faceit_match_id")
            .is_none());
        drop(store);

        let reopened = Store::open(&cfg).unwrap();
        assert_indexes_rebuilt(&reopened);
        assert_eq!(reopened.find_faceit(FACEIT_A), reopened.get(&done.id));
        assert!(reopened.find_faceit(FACEIT_A).is_some());
        let r = reopened.get(&cut.id).unwrap();
        assert_eq!(r.status, Status::Error);
        assert_eq!(r.error.as_deref(), Some(restarted(Source::Faceit)));
        assert!(restarted(Source::Faceit).contains("FACEIT"));
        assert_eq!(reopened.find_faceit(FACEIT_B), None);
        let (again, created) = reopened.claim_faceit(FACEIT_B, "dddddddddddddddddddddd", None);
        assert!(created);
        assert_eq!(again.id, "dddddddddddddddddddddd");
        assert_indexes_rebuilt(&reopened);
    }

    /// A FACEIT record in error (its fetch failed, or its pack was evicted) leaves the index, so
    /// the next claim of its match makes a new record, as a share code's does; the failed one
    /// stays for its TTL to say what went wrong, then is forgotten.
    #[test]
    fn an_error_record_leaves_the_faceit_index() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let (first, _) = store.claim_faceit(FACEIT_A, "aaaaaaaaaaaaaaaaaaaaaa", Some(5));
        store.update(&first.id, |r| {
            r.status = Status::Error;
            r.error = Some("the demo is gone".into());
        });
        assert_eq!(store.find_faceit(FACEIT_A), None);
        assert_indexes_rebuilt(&store);
        let (second, created) = store.claim_faceit(FACEIT_A, "bbbbbbbbbbbbbbbbbbbbbb", Some(5));
        assert!(created);
        assert_eq!(
            (second.id.as_str(), second.status),
            ("bbbbbbbbbbbbbbbbbbbbbb", Status::Queued)
        );
        assert_eq!(store.find_faceit(FACEIT_A), Some(second.clone()));
        assert_eq!(store.get(&first.id).unwrap().status, Status::Error);
        assert_indexes_rebuilt(&store);

        let sha = "ef".repeat(32);
        pack(&store, &sha, 100, 0);
        store.update(&second.id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        assert!(store.find_faceit(FACEIT_A).is_some());
        store.evict_lru(0).unwrap();
        assert_eq!(store.get(&second.id).unwrap().status, Status::Error);
        assert_eq!(store.find_faceit(FACEIT_A), None);
        assert_indexes_rebuilt(&store);
        assert_eq!(store.forget_failed_at(Duration::ZERO, unix_now() + 1), 2);
        assert_indexes_rebuilt(&store);
        assert!(
            store
                .claim_faceit(FACEIT_A, "cccccccccccccccccccccc", None)
                .1
        );
    }

    #[test]
    fn records_from_before_the_source_fields_load_as_uploads() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        fs::create_dir_all(&cfg.data_dir).unwrap();
        fs::write(
            cfg.data_dir.join("demos.json"),
            r#"[{"id":"aaaaaaaaaaaaaaaaaaaaaa","sha256":null,"status":"done","map":"de_mirage","rounds":24,"error":null,"created_unix":1761100000}]"#,
        )
        .unwrap();
        let store = Store::open(&cfg).unwrap();
        assert!(cfg.data_dir.join("matches").is_dir());
        let old = store.get("aaaaaaaaaaaaaaaaaaaaaa").unwrap();
        assert_eq!(
            (old.source, old.match_id, old.sharecode, old.played_unix),
            (Source::Upload, None, None, None)
        );
        let url = store.create_from("bbbbbbbbbbbbbbbbbbbbbb", Source::Url);
        assert_eq!(url.source, Source::Url);
        store.flush();
        let reopened = Store::open(&cfg).unwrap();
        assert_eq!(
            reopened.get("bbbbbbbbbbbbbbbbbbbbbb").unwrap().source,
            Source::Url
        );
        assert_eq!(
            store.summary_path(&"ab".repeat(32)),
            cfg.data_dir
                .join("matches")
                .join(format!("{}.json", "ab".repeat(32)))
        );
    }

    #[test]
    fn find_by_sha_prefers_a_done_record() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let sha = "cd".repeat(32);
        for (id, status) in [
            ("a1", Status::Error),
            ("a2", Status::Done),
            ("a3", Status::Queued),
        ] {
            store.create(id);
            store.update(id, |r| {
                r.status = status;
                r.sha256 = Some(sha.clone());
            });
        }
        assert_eq!(store.find_by_sha(&sha).unwrap().id, "a2");
        assert_eq!(store.find_by_sha(&"00".repeat(32)), None);
    }

    fn pack(store: &Store, sha: &str, len: usize, age_secs: u64) -> PathBuf {
        let p = store.pack_path(sha);
        std::fs::write(&p, vec![0u8; len]).unwrap();
        File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(age_secs))
            .unwrap();
        p
    }

    #[test]
    fn evict_lru_removes_oldest_first_until_under_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let (s1, s2, s3, s4) = (
            "11".repeat(32),
            "22".repeat(32),
            "33".repeat(32),
            "44".repeat(32),
        );
        let middle = pack(&store, &s2, 100, 200);
        let newest = pack(&store, &s3, 100, 100);
        let oldest = pack(&store, &s1, 100, 300);
        let newest2 = pack(&store, &s4, 100, 10);
        // Work files that are not packs are not counted or touched.
        std::fs::write(store.pack_path(&s1).with_extension("tmp"), vec![0u8; 1000]).unwrap();
        for (id, sha) in [("r1", &s1), ("r2", &s2), ("r4", &s4)] {
            store.create(id);
            store.update(id, |r| {
                r.status = Status::Done;
                r.sha256 = Some(sha.clone());
            });
        }

        assert_eq!(store.evict_lru(400).unwrap(), Vec::<PathBuf>::new());
        assert_eq!(
            store.evict_lru(250).unwrap(),
            vec![oldest.clone(), middle.clone()]
        );
        assert!(!oldest.exists() && !middle.exists());
        assert!(newest.exists() && newest2.exists());
        assert_eq!(store.evict_lru(200).unwrap(), Vec::<PathBuf>::new());

        // Records whose pack went are no longer Done; the rest are untouched.
        for id in ["r1", "r2"] {
            let r = store.get(id).unwrap();
            assert_eq!(r.status, Status::Error, "{id}");
            assert!(r.error.unwrap().contains("expired"), "{id}");
        }
        assert_eq!(store.get("r4").unwrap().status, Status::Done);
    }

    /// A file written in place through `write_file` or `replace_file` is the new one, whole,
    /// and the temporary file is gone. (That the data and the rename reach the disk in that
    /// order is checked by tracing the system calls; see `replace_file`.)
    #[test]
    fn files_are_replaced_whole() {
        let dir = tempfile::tempdir().unwrap();
        let (tmp, dest) = (dir.path().join("x.tmp"), dir.path().join("x"));
        fs::write(&dest, b"old").unwrap();
        write_file(&tmp, &dest, b"new").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"new");
        assert!(!tmp.exists());

        fs::write(&tmp, b"newer").unwrap();
        replace_file(&tmp, &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"newer");
        assert!(!tmp.exists());
        assert_eq!(
            replace_file(&tmp, &dest).unwrap_err().kind(),
            ErrorKind::NotFound
        );
        assert_eq!(fs::read(&dest).unwrap(), b"newer");
    }

    /// The record `id` as `demos.json` has it.
    fn on_disk(dir: &Path, id: &str) -> Option<DemoRecord> {
        let list: Vec<DemoRecord> =
            serde_json::from_slice(&fs::read(dir.join("data/demos.json")).ok()?).unwrap();
        list.into_iter().find(|r| r.id == id)
    }

    /// A change costs its caller no write: the saver writes `demos.json` behind it. What a
    /// client is shown of a record ([`Store::get_saved`]) and the record a client is given the
    /// id of ([`Store::saved`]) are on disk by then, so a crash cannot take them back.
    #[tokio::test]
    async fn what_a_client_is_shown_is_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let id = "aaaaaaaaaaaaaaaaaaaaaa";
        store.create(id);
        store.saved().await;
        assert_eq!(on_disk(dir.path(), id).unwrap().status, Status::Queued);
        for n in 1..=50u16 {
            store.update(id, |r| {
                r.status = Status::Done;
                r.rounds = Some(n);
            });
            assert_eq!(store.get_saved(id).await.unwrap().rounds, Some(n));
            assert_eq!(on_disk(dir.path(), id).unwrap().rounds, Some(n), "{n}");
        }
        assert_eq!(store.get_saved("bbbbbbbbbbbbbbbbbbbbbb").await, None);
    }

    /// A write of `demos.json` that fails holds up neither the change nor its readers (the index
    /// in memory stays the truth, as before the saver), and is tried again until it succeeds.
    #[tokio::test]
    async fn a_failing_save_delays_no_one_and_is_tried_again() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let id = "aaaaaaaaaaaaaaaaaaaaaa";
        store.create(id);
        store.saved().await;
        // The temporary file cannot be created while a directory has its name.
        let blocker = dir.path().join("data/demos.json.tmp");
        fs::create_dir(&blocker).unwrap();
        store.update(id, |r| r.status = Status::Parsing);
        assert_eq!(store.get(id).unwrap().status, Status::Parsing);
        assert_eq!(store.get_saved(id).await.unwrap().status, Status::Parsing);
        store.saved().await;
        assert_eq!(on_disk(dir.path(), id).unwrap().status, Status::Queued);

        fs::remove_dir(&blocker).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while on_disk(dir.path(), id).unwrap().status != Status::Parsing {
            assert!(std::time::Instant::now() < deadline, "never written again");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Dropping the store (the process ending) writes the changes not written yet.
    #[test]
    fn the_last_changes_are_written_when_the_store_goes() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let id = "aaaaaaaaaaaaaaaaaaaaaa";
        store.create(id);
        for n in 1..=200u16 {
            store.update(id, |r| r.rounds = Some(n));
        }
        drop(store);
        assert_eq!(on_disk(dir.path(), id).unwrap().rounds, Some(200));
        let reopened = Store::open(&config(dir.path())).unwrap();
        assert_eq!(reopened.get(id).unwrap().rounds, Some(200));
    }

    /// The contents of the files the store set aside as `<name>.corrupt-*` in `data_dir`.
    fn kept_aside(data_dir: &Path, name: &str) -> Vec<Vec<u8>> {
        let mut kept: Vec<(String, Vec<u8>)> = fs::read_dir(data_dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter_map(|p| {
                let n = p.file_name()?.to_str()?.to_owned();
                n.starts_with(&format!("{name}.corrupt-"))
                    .then(|| (n, fs::read(&p).unwrap()))
            })
            .collect();
        kept.sort();
        kept.into_iter().map(|(_, bytes)| bytes).collect()
    }

    /// Two records, each written by its own write: `demos.json` then has both, and
    /// `demos.json.prev` the first.
    fn two_writes(cfg: &Config) {
        let store = Store::open(cfg).unwrap();
        store.create("aaaaaaaaaaaaaaaaaaaaaa");
        store.flush();
        store.create("bbbbbbbbbbbbbbbbbbbbbb");
    }

    /// A `demos.json` cut short, emptied, zeroed, not JSON, or gone does not stop the server
    /// (it used to, and `restart: unless-stopped` restarted it into the same failure): the bad
    /// file is kept aside as it was, the records come from `demos.json.prev` (the file before
    /// the last write, whose record is lost), and `demos.json` is written again.
    #[test]
    fn a_corrupt_index_is_kept_aside_and_the_copy_before_it_read() {
        type Damage = fn(&[u8]) -> Option<Vec<u8>>;
        let damages: [(&str, Damage); 5] = [
            ("cut short", |b| Some(b[..b.len() / 2].to_vec())),
            ("emptied", |_| Some(Vec::new())),
            ("zeroed", |b| Some(vec![0; b.len()])),
            ("not JSON", |_| Some(b"nonsense".to_vec())),
            ("deleted", |_| None),
        ];
        for (what, damage) in damages {
            let dir = tempfile::tempdir().unwrap();
            let cfg = config(dir.path());
            two_writes(&cfg);
            let index = cfg.data_dir.join("demos.json");
            let bad = damage(&fs::read(&index).unwrap());
            match &bad {
                Some(bytes) => fs::write(&index, bytes).unwrap(),
                None => fs::remove_file(&index).unwrap(),
            }

            let store = Store::open(&cfg).unwrap();
            assert!(store.get("aaaaaaaaaaaaaaaaaaaaaa").is_some(), "{what}");
            assert_eq!(store.get("bbbbbbbbbbbbbbbbbbbbbb"), None, "{what}");
            let kept = kept_aside(&cfg.data_dir, "demos.json");
            assert_eq!(kept, bad.into_iter().collect::<Vec<_>>(), "{what}");
            store.flush();
            assert!(
                on_disk(dir.path(), "aaaaaaaaaaaaaaaaaaaaaa").is_some(),
                "{what}"
            );
        }
    }

    /// With `demos.json.prev` unreadable too, the server starts with no records and keeps both
    /// files aside; a file set aside later does not replace one set aside before.
    #[test]
    fn with_both_copies_unreadable_the_index_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path());
        two_writes(&cfg);
        fs::write(cfg.data_dir.join("demos.json"), b"[{").unwrap();
        fs::write(cfg.data_dir.join("demos.json.prev"), b"").unwrap();

        let store = Store::open(&cfg).unwrap();
        assert_eq!(store.get("aaaaaaaaaaaaaaaaaaaaaa"), None);
        assert_eq!(
            kept_aside(&cfg.data_dir, "demos.json"),
            vec![b"[{".to_vec()]
        );
        assert_eq!(
            kept_aside(&cfg.data_dir, "demos.json.prev"),
            vec![Vec::<u8>::new()]
        );
        store.create("cccccccccccccccccccccc");
        drop(store);

        fs::write(cfg.data_dir.join("demos.json"), b"nonsense").unwrap();
        let store = Store::open(&cfg).unwrap();
        // No copy from before the last write has the record.
        assert_eq!(store.get("cccccccccccccccccccccc"), None);
        let mut kept = kept_aside(&cfg.data_dir, "demos.json");
        kept.sort();
        assert_eq!(kept, vec![b"[{".to_vec(), b"nonsense".to_vec()]);
    }

    /// A `demos.json` that is whole JSON but not records this binary knows (here a status a
    /// newer server added) stops the server with an error naming the file, as before the
    /// recovery above: it is a rollback, not a torn write, and starting from the copy or empty
    /// would hide every demo. Nothing is set aside or rewritten. The same holds for the copy
    /// when it is the one read, and the torn `demos.json` above it stays in place too.
    #[test]
    fn an_index_from_a_newer_server_stops_the_server() {
        let newer = |bytes: &[u8]| {
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .replace(r#""status":"queued""#, r#""status":"archived""#)
                .into_bytes()
        };
        for damaged in ["demos.json", "demos.json.prev"] {
            let dir = tempfile::tempdir().unwrap();
            let cfg = config(dir.path());
            two_writes(&cfg);
            let (index, prev) = (
                cfg.data_dir.join("demos.json"),
                cfg.data_dir.join("demos.json.prev"),
            );
            let skewed = newer(&fs::read(&prev).unwrap());
            assert_ne!(skewed, fs::read(&prev).unwrap());
            fs::write(&prev, &skewed).unwrap();
            if damaged == "demos.json" {
                fs::write(&index, &skewed).unwrap();
            } else {
                // Torn, so the copy is read.
                fs::write(&index, b"[{").unwrap();
            }

            let before = fs::read(&index).unwrap();

            let err = Store::open(&cfg).err().expect(damaged);
            assert_eq!(err.kind(), ErrorKind::InvalidData, "{damaged}");
            let message = err.to_string();
            let path = cfg.data_dir.join(damaged);
            assert!(message.contains(&*path.to_string_lossy()), "{message}");
            assert!(message.contains("newer server"), "{message}");
            assert_eq!(fs::read(&path).unwrap(), skewed, "{damaged}");
            // A torn demos.json stays too: set aside, it would leave an older server no index
            // to start from but an empty one.
            assert_eq!(fs::read(&index).unwrap(), before, "{damaged}");
            assert!(kept_aside(&cfg.data_dir, "demos.json").is_empty());
            assert!(kept_aside(&cfg.data_dir, "demos.json.prev").is_empty());
        }
    }

    /// Serving or reusing a pack refreshes its mtime, which orders eviction, only under a cache
    /// limit: without one nothing reads the order, so a pack read writes nothing.
    #[test]
    fn packs_are_touched_only_under_a_cache_limit() {
        for (cache_bytes, refreshed) in [(None, false), (Some(1 << 30), true)] {
            let dir = tempfile::tempdir().unwrap();
            let cfg = Config {
                cache_bytes,
                ..config(dir.path())
            };
            let store = Store::open(&cfg).unwrap();
            let sha = "ab".repeat(32);
            let path = pack(&store, &sha, 10, 3600);
            let before = fs::metadata(&path).unwrap().modified().unwrap();
            store.touch_pack(&sha);
            let after = fs::metadata(&path).unwrap().modified().unwrap();
            assert_eq!(after > before, refreshed, "{cache_bytes:?}");
        }
    }

    /// An alias is made only of a pack on disk, checked under the index lock: a pack evicted
    /// between a caller's look and the alias leaves the record as it was (to be parsed again),
    /// and an alias made before an eviction expires with the rest (code-health review
    /// 2026-10-26: the look and the alias were separate calls, so a cached upload could end
    /// `Done` with its pack gone).
    #[test]
    fn an_alias_is_made_only_of_a_pack_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&config(dir.path())).unwrap();
        let sha = "ab".repeat(32);
        pack(&store, &sha, 100, 0);
        let first = "firstFirstFirstFirst12";
        store.create(first);
        store.update(first, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
            r.map = Some("de_mirage".into());
            r.rounds = Some(24);
        });

        let (alias, later) = ("aliasAliasAliasAlias12", "laterLaterLaterLater12");
        store.create(alias);
        let of = store.alias_packed(alias, &sha).map(|r| r.id);
        assert_eq!(of.as_deref(), Some(first));
        let r = store.get(alias).unwrap();
        assert_eq!(
            (r.status, r.map.as_deref(), r.rounds, r.sha256.as_deref()),
            (
                Status::Done,
                Some("de_mirage"),
                Some(24),
                Some(sha.as_str())
            )
        );
        assert_eq!(store.alias_packed("unknownUnknownUnknown1", &sha), None);

        // The look a caller makes first finds the pack; it is evicted before the alias.
        store.create(later);
        let looked = store.find_by_sha(&sha).unwrap();
        assert!(looked.status == Status::Done && store.pack_path(&sha).is_file());
        store.evict_lru(0).unwrap();
        assert_eq!(store.alias_packed(later, &sha), None);
        assert_eq!(store.get(later).unwrap().status, Status::Queued);
        assert_eq!(store.get(alias).unwrap().error.as_deref(), Some(EXPIRED));
    }
}
