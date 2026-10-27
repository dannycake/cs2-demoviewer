//! Chunked uploads on disk: `uploads/<id>/` directories, each with a `meta.json` and the
//! chunks received so far, the budget of declared bytes they hold, the chunk PUTs they may take,
//! and their assembly into one file.
//!
//! An upload start reserves its declared size against the client's share
//! ([`OPEN_UPLOADS_PER_CLIENT`]) and the server's budget ([`Uploads::reserve`], one step of
//! [`crate::admission`]), then makes the directory with its `meta.json` on a blocking task that
//! keeps the reservation once the directory is there ([`Reservation::keep`]). Each chunk PUT
//! streams to a private temp file ([`receive`]), is inflated if it came gzip-encoded (refusing
//! more than [`MAX_INFLATE_RATIO`] times what was sent), has its length checked against the
//! declared size, and is renamed over `<n>`, so a repeat or out-of-order PUT is harmless
//! ([`store_chunk`]).
//! [`Uploads::begin_put`] bounds how many PUTs one upload may take and how many one client may
//! have in progress, so one upload start cannot turn into unbounded disk writes. Completing an
//! upload claims its directory with one rename (a second completion finds nothing,
//! [`Uploads::claim`]) and concatenates the chunks while hashing ([`assemble`]).
//!
//! The open uploads' declared sizes are counted in memory, kept in step as uploads start, are
//! claimed and are swept, and read back from their `meta.json` files at startup
//! ([`Uploads::open`]), so starting an upload reads no other upload's files (code-health review
//! 2026-10-26: each start read every open upload's `meta.json` and swept the directory, all
//! behind one lock). An upload untouched for [`STALE_UPLOAD`] (no chunk PUT began or ended) is
//! deleted and leaves the budget: looked for at most once a minute, when an upload starts, and
//! by the directories' mtimes at startup.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime};

use axum::body::Body;
use axum::http::StatusCode;
use http_body_util::BodyExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::api::ApiError;
use crate::config::Config;
use crate::errors::blocking;
use crate::ingest::{copy_capped, MAX_INFLATE_RATIO};
use crate::store::{self, Store, WorkFiles};

/// An upload untouched for this long is abandoned and its chunks are deleted. Short, because
/// abandoned chunks hold disk and the upload budget; a 32 MiB chunk takes an hour only below
/// 10 KB/s.
pub const STALE_UPLOAD: Duration = Duration::from_secs(3600);
/// Declared bytes of unfinished uploads one client may hold, in units of `max_upload_bytes`.
pub const OPEN_UPLOADS_PER_CLIENT: u64 = 2;
/// Chunk PUTs one upload may take, per chunk it has, plus [`SPARE_PUTS`]: every chunk may be
/// sent twice. A PUT is not rate-limited and may write a whole chunk (from 1/20 of that in
/// gzip), so this is what bounds the disk writes one upload start can cause.
pub const PUTS_PER_CHUNK: u64 = 2;
/// Extra chunk PUTs every upload may take.
pub const SPARE_PUTS: u64 = 2;
/// Chunk PUTs one client (the address that started the upload) may have in progress at once.
/// Each holds up to two temp files of about a chunk outside the declared-size upload budget.
pub const PUTS_IN_FLIGHT_PER_CLIENT: usize = 4;
/// Chunk PUTs in progress at once from everyone: at most about 2 GiB of temp files.
pub const PUTS_IN_FLIGHT: usize = 32;
/// The most one chunk `PUT` may take in all, however steadily it trickles.
const PUT_DEADLINE: Duration = Duration::from_secs(15 * 60);
/// How often an upload start looks for abandoned uploads, a scan of the open uploads in memory.
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// Stored as `uploads/<id>/meta.json`.
#[derive(Serialize, Deserialize)]
pub struct UploadMeta {
    pub size: u64,
    /// The client's rate-limit bucket ([`crate::ratelimit::bucket`]), for its share of the
    /// upload budget.
    #[serde(default)]
    pub client: String,
}

/// How a declared size splits into chunks of `chunk` bytes, and who started the upload.
pub struct Layout {
    pub size: u64,
    pub chunk: u64,
    /// The uploader's rate-limit bucket ([`UploadMeta::client`]).
    pub client: String,
}

impl Layout {
    pub fn count(&self) -> u64 {
        self.size.div_ceil(self.chunk)
    }

    /// Length chunk `n` must have: `chunk`, except the last, which holds the remainder.
    pub fn len_of(&self, n: u64) -> u64 {
        self.chunk.min(self.size - n * self.chunk)
    }
}

/// The unfinished uploads: their directory, and in memory their declared sizes against the
/// budget and their chunk PUTs.
pub struct Uploads {
    dir: PathBuf,
    chunk: u64,
    /// Declared bytes one client's open uploads may hold.
    share: u64,
    /// Declared bytes all open uploads may hold (`Config::upload_budget_bytes`).
    budget: u64,
    open: Mutex<Open>,
}

#[derive(Default)]
struct Open {
    uploads: HashMap<String, OpenUpload>,
    /// Declared bytes per client, and in all.
    declared: HashMap<String, u64>,
    total: u64,
    /// Chunk PUTs in progress per client, and in all.
    in_flight: HashMap<String, usize>,
    in_flight_total: usize,
    /// When an upload start last looked for abandoned uploads.
    swept: Option<SystemTime>,
}

struct OpenUpload {
    client: String,
    size: u64,
    /// Chunk PUTs started.
    puts: u64,
    /// When the upload started or a chunk PUT last began or ended, as a chunk written or
    /// replaced updates the directory's mtime: what [`STALE_UPLOAD`] counts from.
    touched: SystemTime,
}

impl Open {
    fn insert(&mut self, id: String, upload: OpenUpload) {
        *self.declared.entry(upload.client.clone()).or_insert(0) += upload.size;
        self.total += upload.size;
        if let Some(old) = self.uploads.insert(id, upload) {
            self.uncount(&old);
        }
    }

    fn remove(&mut self, id: &str) -> Option<OpenUpload> {
        let gone = self.uploads.remove(id)?;
        self.uncount(&gone);
        Some(gone)
    }

    fn uncount(&mut self, upload: &OpenUpload) {
        self.total -= upload.size;
        if let Some(n) = self.declared.get_mut(&upload.client) {
            *n -= upload.size;
            if *n == 0 {
                self.declared.remove(&upload.client);
            }
        }
    }
}

impl Uploads {
    /// The uploads in `store`'s upload directory: deletes those whose directory is older than
    /// [`STALE_UPLOAD`], then counts the rest from their `meta.json` (one that cannot be read
    /// counts nothing, and is deleted when it goes stale).
    pub fn open(store: &Store, cfg: &Config) -> Uploads {
        let dir = store.uploads_dir();
        sweep_dir(&dir, STALE_UPLOAD);
        let mut open = Open::default();
        for entry in fs::read_dir(&dir).into_iter().flatten().flatten() {
            let name = entry.file_name();
            let (Ok(meta), Some(id)) = (entry.metadata(), name.to_str()) else {
                continue;
            };
            if !meta.is_dir() {
                continue;
            }
            let touched = meta.modified().unwrap_or_else(|_| SystemTime::now());
            let upload = fs::read(entry.path().join("meta.json"))
                .ok()
                .and_then(|json| serde_json::from_slice::<UploadMeta>(&json).ok())
                .unwrap_or(UploadMeta {
                    size: 0,
                    client: String::new(),
                });
            open.insert(
                id.to_owned(),
                OpenUpload {
                    client: upload.client,
                    size: upload.size,
                    puts: 0,
                    touched,
                },
            );
        }
        Uploads {
            dir,
            chunk: cfg.chunk_bytes,
            share: OPEN_UPLOADS_PER_CLIENT.saturating_mul(cfg.max_upload_bytes),
            budget: cfg.upload_budget_bytes,
            open: Mutex::new(open),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Open> {
        self.open.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn upload_dir(&self, id: &str) -> PathBuf {
        self.dir.join(id)
    }

    /// Reserves `size` declared bytes for the upload `id` by `client` (its rate-limit bucket):
    /// 429 past the client's share, 503 past the budget. The reservation is the upload's until
    /// it is claimed or swept once kept ([`Reservation::keep`]), and is given back if dropped
    /// before.
    pub fn reserve(
        self: &Arc<Self>,
        id: &str,
        client: &str,
        size: u64,
    ) -> Result<Reservation, ApiError> {
        let mut open = self.lock();
        let mine = open.declared.get(client).copied().unwrap_or(0);
        if mine.saturating_add(size) > self.share {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "you have too many unfinished uploads; finish them or wait an hour",
            ));
        }
        if open.total.saturating_add(size) > self.budget {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "the server is busy with other uploads; try again in a few minutes",
            ));
        }
        open.insert(
            id.to_owned(),
            OpenUpload {
                client: client.to_owned(),
                size,
                puts: 0,
                touched: SystemTime::now(),
            },
        );
        Ok(Reservation {
            uploads: self.clone(),
            id: id.to_owned(),
            kept: false,
        })
    }

    /// Makes the directory of the upload `id` with its `meta.json`; on failure, removes what it
    /// made. Blocking.
    pub fn create(&self, id: &str, meta: &UploadMeta) -> io::Result<()> {
        let dir = self.upload_dir(id);
        fs::create_dir(&dir)?;
        let written = serde_json::to_vec(meta)
            .map_err(io::Error::from)
            .and_then(|json| {
                store::write_file(&dir.join("meta.json.tmp"), &dir.join("meta.json"), &json)
            });
        if written.is_err() {
            let _ = fs::remove_dir_all(&dir);
        }
        written
    }

    /// The directory and layout of the live upload `id`, from its `meta.json`, or 404.
    pub async fn layout(&self, id: &str) -> Result<(PathBuf, Layout), ApiError> {
        let unknown = || ApiError::new(StatusCode::NOT_FOUND, "unknown upload");
        if !store::valid_id(id) {
            return Err(unknown());
        }
        let dir = self.upload_dir(id);
        let meta = match tokio::fs::read(dir.join("meta.json")).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == ErrorKind::NotFound => return Err(unknown()),
            Err(e) => return Err(ApiError::internal("cannot read the upload", e)),
        };
        let meta: UploadMeta = serde_json::from_slice(&meta)
            .map_err(|e| ApiError::internal("corrupt upload metadata", e))?;
        Ok((
            dir,
            Layout {
                size: meta.size,
                chunk: self.chunk,
                client: meta.client,
            },
        ))
    }

    /// Admits one chunk PUT to the upload `id`, which may take `allowed` in all, counted against
    /// the client that started it; the PUT is in progress until the returned slot drops.
    pub fn begin_put(self: &Arc<Self>, id: &str, allowed: u64) -> Result<PutSlot, ApiError> {
        let mut open = self.lock();
        let open = &mut *open;
        let Some(upload) = open.uploads.get_mut(id) else {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown upload"));
        };
        let in_flight = open.in_flight.get(&upload.client).copied().unwrap_or(0);
        if in_flight >= PUTS_IN_FLIGHT_PER_CLIENT {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                format!(
                    "too many chunks at once; send at most {PUTS_IN_FLIGHT_PER_CLIENT} at a time"
                ),
            ));
        }
        if open.in_flight_total >= PUTS_IN_FLIGHT {
            return Err(ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "the server is busy receiving other uploads; try again in a moment",
            ));
        }
        if upload.puts >= allowed {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "this upload's chunks were sent too many times; start the upload again",
            ));
        }
        upload.puts += 1;
        upload.touched = SystemTime::now();
        *open.in_flight.entry(upload.client.clone()).or_insert(0) += 1;
        open.in_flight_total += 1;
        Ok(PutSlot {
            uploads: self.clone(),
            id: id.to_owned(),
            client: upload.client.clone(),
        })
    }

    /// Claims the upload `id` for assembly by renaming its directory to `to`: only one claim
    /// can win, and chunks are never removed from a live upload, so every chunk seen before
    /// moves with it. The upload leaves the budget. 404 when it is gone (claimed or swept).
    /// Blocking: the claim and its bookkeeping are one step, which a request dropped meanwhile
    /// cannot split.
    pub fn claim(&self, id: &str, to: &Path) -> Result<(), ApiError> {
        match fs::rename(self.upload_dir(id), to) {
            Ok(()) => {
                self.lock().remove(id);
                Ok(())
            }
            Err(e) if e.kind() == ErrorKind::NotFound => {
                Err(ApiError::new(StatusCode::NOT_FOUND, "unknown upload"))
            }
            Err(e) => Err(ApiError::internal("cannot assemble the upload", e)),
        }
    }

    /// At most once every [`SWEEP_EVERY`], forgets the uploads untouched for [`STALE_UPLOAD`],
    /// so they leave the budget at once, and deletes their directories on a blocking thread
    /// that nothing waits for. For an upload start, on a tokio runtime.
    pub fn sweep(self: &Arc<Self>) {
        let stale = self.take_stale(SystemTime::now(), SWEEP_EVERY);
        if stale.is_empty() {
            return;
        }
        let uploads = self.clone();
        tokio::task::spawn_blocking(move || uploads.delete(&stale));
    }

    /// The ids of the uploads untouched for [`STALE_UPLOAD`] at `now`, forgotten; none when the
    /// last look was less than `every` before `now`.
    fn take_stale(&self, now: SystemTime, every: Duration) -> Vec<String> {
        let mut open = self.lock();
        let due = open
            .swept
            .is_none_or(|t| now.duration_since(t).is_ok_and(|since| since >= every));
        if !due {
            return Vec::new();
        }
        open.swept = Some(now);
        let stale: Vec<String> = open
            .uploads
            .iter()
            .filter(|(_, u)| {
                now.duration_since(u.touched)
                    .is_ok_and(|age| age > STALE_UPLOAD)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in &stale {
            open.remove(id);
        }
        stale
    }

    fn delete(&self, ids: &[String]) {
        let mut deleted = 0;
        for id in ids {
            match fs::remove_dir_all(self.upload_dir(id)) {
                Ok(()) => deleted += 1,
                // Completed meanwhile.
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => {
                    tracing::warn!(upload = %id, error = %e, "cannot delete an abandoned upload")
                }
            }
        }
        if deleted > 0 {
            tracing::info!(deleted, "abandoned uploads deleted");
        }
    }
}

/// An upload's declared bytes in the budget ([`Uploads::reserve`]): given back when dropped,
/// unless kept.
pub struct Reservation {
    uploads: Arc<Uploads>,
    id: String,
    kept: bool,
}

impl Reservation {
    /// Keeps the reservation for the upload, whose directory now exists.
    pub fn keep(mut self) {
        self.kept = true;
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        if !self.kept {
            self.uploads.lock().remove(&self.id);
        }
    }
}

/// A chunk PUT in progress; see [`Uploads::begin_put`].
pub struct PutSlot {
    uploads: Arc<Uploads>,
    id: String,
    client: String,
}

impl Drop for PutSlot {
    fn drop(&mut self) {
        let mut open = self.uploads.lock();
        open.in_flight_total -= 1;
        if let Some(n) = open.in_flight.get_mut(&self.client) {
            *n -= 1;
            if *n == 0 {
                open.in_flight.remove(&self.client);
            }
        }
        if let Some(upload) = open.uploads.get_mut(&self.id) {
            upload.touched = SystemTime::now();
        }
    }
}

/// Deletes the upload directories in `dir` untouched for `max_age` (a chunk written or replaced
/// updates the directory's mtime). Returns how many went.
fn sweep_dir(dir: &Path, max_age: Duration) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let now = SystemTime::now();
    let mut swept = 0;
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .is_ok_and(|t| now.duration_since(t).is_ok_and(|age| age > max_age));
        if stale && fs::remove_dir_all(entry.path()).is_ok() {
            swept += 1;
        }
    }
    if swept > 0 {
        tracing::info!(swept, "abandoned uploads deleted");
    }
    swept
}

/// Stores chunk `n` of the upload in `dir` from `body`, inflating it when `gzip`: into a
/// private temp file (two PUTs of one chunk never write one file), checked against the length
/// `layout` gives it, then renamed over `<n>`. `idle` is how long the body may stall. The PUT is
/// in progress ([`Uploads::begin_put`]) until `slot` drops.
pub async fn store_chunk(
    dir: &Path,
    layout: &Layout,
    n: u64,
    gzip: bool,
    body: Body,
    idle: Duration,
    slot: PutSlot,
) -> Result<(), ApiError> {
    let chunk = layout.chunk;
    let too_large = || {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!("a chunk may hold at most {chunk} bytes"),
        )
    };
    // Deleted however the PUT ends; the one renamed into place is gone by then.
    let mut work = WorkFiles::default();
    let nonce = Store::new_id();
    let part = dir.join(format!("{n}.{nonce}.part"));
    work.add(&part);
    // gzip of incompressible data is a little larger than its input.
    let raw_cap = if gzip {
        chunk + chunk / 64 + 4096
    } else {
        chunk
    };
    let Some(sent) = receive(body, &part, raw_cap, idle).await? else {
        return Err(too_large());
    };
    // The work files and the PUT's place, held to the end.
    let (data, _held) = if gzip {
        let dec = dir.join(format!("{n}.{nonce}.dec"));
        work.add(&dec);
        let (src, dst) = (part.clone(), dec.clone());
        // Demo data shrinks about 1.5 times under gzip; far more is a bomb, not a demo.
        let ratio_cap = sent.saturating_mul(MAX_INFLATE_RATIO);
        // The inflating goes on when the client goes away, so it holds the PUT's place and its
        // work files until it ends: a PUT dropped meanwhile neither frees its place while the
        // chunk is still being written nor deletes the files before the task makes them
        // (code-health review 2026-10-26).
        let held = (work, slot);
        let (inflated, held) = blocking(move || {
            let inflated = gunzip_capped(&src, &dst, chunk.min(ratio_cap));
            (inflated, held)
        })
        .await?;
        match inflated {
            Ok(()) => {}
            Err(Gunzip::TooLarge) if ratio_cap < chunk => {
                return Err(ApiError::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!(
                        "the chunk inflates to more than {MAX_INFLATE_RATIO} times its size, \
                         which no demo does; send it without gzip"
                    ),
                ))
            }
            Err(Gunzip::TooLarge) => return Err(too_large()),
            Err(Gunzip::Corrupt(e)) => {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    format!("the chunk is not valid gzip: {e}"),
                ))
            }
            Err(Gunzip::Disk(e)) => return Err(ApiError::internal("cannot store the chunk", e)),
        }
        (dec, held)
    } else {
        (part, (work, slot))
    };

    let len = tokio::fs::metadata(&data)
        .await
        .map_err(|e| ApiError::internal("cannot store the chunk", e))?
        .len();
    let expected = layout.len_of(n);
    if len != expected {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("chunk {n} must be {expected} bytes, got {len}"),
        ));
    }
    match tokio::fs::rename(&data, dir.join(n.to_string())).await {
        Ok(()) => Ok(()),
        // The upload was completed (or swept) while this chunk was arriving.
        Err(e) if e.kind() == ErrorKind::NotFound => {
            Err(ApiError::new(StatusCode::NOT_FOUND, "unknown upload"))
        }
        Err(e) => Err(ApiError::internal("cannot store the chunk", e)),
    }
}

/// Streams `body` into a new file at `path` and returns its length; `None` if it exceeds `cap`
/// (the caller deletes the file). Gives up with 408 when no byte arrives for `idle` or the
/// whole transfer passes [`PUT_DEADLINE`], so a stalled client cannot hold a PUT slot.
async fn receive(
    mut body: Body,
    path: &Path,
    cap: u64,
    idle: Duration,
) -> Result<Option<u64>, ApiError> {
    let disk = |e: io::Error| ApiError::internal("cannot store the chunk", e);
    let file = match tokio::fs::File::create(path).await {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(ApiError::new(StatusCode::NOT_FOUND, "unknown upload"))
        }
        Err(e) => return Err(disk(e)),
    };
    let mut file = tokio::io::BufWriter::with_capacity(1 << 20, file);
    let mut total: u64 = 0;
    let deadline = tokio::time::Instant::now() + PUT_DEADLINE;
    loop {
        let wait = deadline.min(tokio::time::Instant::now() + idle);
        let Ok(next) = tokio::time::timeout_at(wait, body.frame()).await else {
            return Err(ApiError::new(
                StatusCode::REQUEST_TIMEOUT,
                "the upload stalled; send this chunk again",
            ));
        };
        let Some(frame) = next else { break };
        let frame = frame.map_err(|e| {
            tracing::debug!(error = %e, "chunk body interrupted");
            ApiError::new(StatusCode::BAD_REQUEST, "the upload was interrupted")
        })?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        total += data.len() as u64;
        if total > cap {
            return Ok(None);
        }
        file.write_all(&data).await.map_err(disk)?;
    }
    file.flush().await.map_err(disk)?;
    Ok(Some(total))
}

enum Gunzip {
    TooLarge,
    Corrupt(io::Error),
    Disk(io::Error),
}

/// Inflates the gzip file `src` into `dest`, refusing more than `cap` bytes of output.
fn gunzip_capped(src: &Path, dest: &Path, cap: u64) -> Result<(), Gunzip> {
    let input = File::open(src).map_err(Gunzip::Disk)?;
    let mut dec = Reading {
        inner: flate2::read::MultiGzDecoder::new(BufReader::new(input)),
        failed: None,
    };
    let out = File::create(dest).map_err(Gunzip::Disk)?;
    let mut out = BufWriter::with_capacity(1 << 20, out);
    match copy_capped(&mut dec, &mut out, cap) {
        Ok(Some(_)) => out.flush().map_err(Gunzip::Disk),
        Ok(None) => Err(Gunzip::TooLarge),
        Err(e) => Err(match dec.failed {
            Some(read) => Gunzip::Corrupt(read),
            None => Gunzip::Disk(e),
        }),
    }
}

/// A reader that keeps a copy of its last error, so a copy that fails can tell the data's
/// fault (a read) from the disk's (a write).
struct Reading<R> {
    inner: R,
    failed: Option<io::Error>,
}

impl<R: Read> Read for Reading<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf).inspect_err(|e| {
            if e.kind() != ErrorKind::Interrupted {
                self.failed = Some(io::Error::new(e.kind(), e.to_string()));
            }
        })
    }
}

/// Concatenates `dir/0 .. dir/count-1` into `dest`; returns the SHA-256 and the length.
pub fn assemble(dir: &Path, count: u64, dest: &Path) -> io::Result<(String, u64)> {
    let mut out = Hashing {
        inner: BufWriter::with_capacity(1 << 20, File::create(dest)?),
        hasher: Sha256::new(),
    };
    let mut total = 0;
    for n in 0..count {
        let chunk = File::open(dir.join(n.to_string()))?;
        total += io::copy(&mut BufReader::with_capacity(1 << 20, chunk), &mut out)?;
    }
    out.inner.flush()?;
    Ok((store::hex(&out.hasher.finalize()), total))
}

/// A writer that hashes what goes through it.
struct Hashing<W> {
    inner: W,
    hasher: Sha256,
}

impl<W: Write> Write for Hashing<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uploads(budget: u64) -> (tempfile::TempDir, Arc<Uploads>) {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Config {
            data_dir: dir.path().join("data"),
            max_upload_bytes: 100,
            upload_budget_bytes: budget,
            ..Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let uploads = Arc::new(Uploads::open(&store, &cfg));
        (dir, uploads)
    }

    fn start(uploads: &Arc<Uploads>, id: &str, client: &str, size: u64) -> Result<(), StatusCode> {
        let r = uploads.reserve(id, client, size).map_err(|e| e.status())?;
        uploads
            .create(
                id,
                &UploadMeta {
                    size,
                    client: client.into(),
                },
            )
            .unwrap();
        r.keep();
        Ok(())
    }

    /// The declared sizes counted in memory are what the `meta.json` files say: read back at
    /// startup, so a restart neither frees nor double-counts the budget, and a claim after it
    /// gives the bytes back.
    #[test]
    fn the_budget_is_read_back_at_startup() {
        let (dir, uploads) = uploads(250);
        start(&uploads, "aaaaaaaaaaaaaaaaaaaaaa", "a", 100).unwrap();
        start(&uploads, "bbbbbbbbbbbbbbbbbbbbbb", "a", 100).unwrap();
        let share = Err(StatusCode::TOO_MANY_REQUESTS);
        let budget = Err(StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(start(&uploads, "cccccccccccccccccccccc", "a", 1), share);
        start(&uploads, "dddddddddddddddddddddd", "b", 50).unwrap();
        assert_eq!(start(&uploads, "eeeeeeeeeeeeeeeeeeeeee", "c", 1), budget);
        drop(uploads);

        let cfg = Config {
            data_dir: dir.path().join("data"),
            max_upload_bytes: 100,
            upload_budget_bytes: 250,
            ..Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let reopened = Arc::new(Uploads::open(&store, &cfg));
        assert_eq!(start(&reopened, "ffffffffffffffffffffff", "a", 1), share);
        assert_eq!(start(&reopened, "gggggggggggggggggggggg", "c", 1), budget);
        reopened
            .claim("dddddddddddddddddddddd", &dir.path().join("claimed"))
            .unwrap();
        start(&reopened, "gggggggggggggggggggggg", "c", 50).unwrap();
    }

    /// A reservation that is not kept (the directory could not be made, or the ingest limit
    /// refused the start after it) gives its bytes back; a claimed upload leaves the budget.
    #[test]
    fn bytes_come_back_when_a_start_fails_or_an_upload_is_claimed() {
        let (dir, uploads) = uploads(100);
        drop(uploads.reserve("aaaaaaaaaaaaaaaaaaaaaa", "a", 100).unwrap());
        start(&uploads, "bbbbbbbbbbbbbbbbbbbbbb", "a", 100).unwrap();
        assert!(uploads.reserve("cccccccccccccccccccccc", "b", 1).is_err());
        uploads
            .claim("bbbbbbbbbbbbbbbbbbbbbb", &dir.path().join("claimed"))
            .unwrap();
        assert!(uploads.reserve("cccccccccccccccccccccc", "b", 100).is_ok());
    }

    /// An upload untouched for [`STALE_UPLOAD`] leaves the budget and its directory goes; a
    /// chunk PUT, beginning or ending, touches it. Looked for at most once per interval.
    #[test]
    fn abandoned_uploads_are_swept_from_memory() {
        let (_dir, uploads) = uploads(200);
        start(&uploads, "aaaaaaaaaaaaaaaaaaaaaa", "a", 100).unwrap();
        start(&uploads, "bbbbbbbbbbbbbbbbbbbbbb", "b", 100).unwrap();
        let now = SystemTime::now();
        let later = now + STALE_UPLOAD + Duration::from_secs(1);
        assert!(uploads.take_stale(now, SWEEP_EVERY).is_empty());
        // Too soon after that look, even past the age.
        assert!(uploads.take_stale(later, STALE_UPLOAD * 2).is_empty());
        // A PUT to b ends an hour on.
        {
            let mut open = uploads.lock();
            open.uploads
                .get_mut("bbbbbbbbbbbbbbbbbbbbbb")
                .unwrap()
                .touched = now + STALE_UPLOAD;
        }
        assert_eq!(
            uploads.take_stale(later, SWEEP_EVERY),
            vec!["aaaaaaaaaaaaaaaaaaaaaa".to_owned()]
        );
        uploads.delete(&["aaaaaaaaaaaaaaaaaaaaaa".to_owned()]);
        assert!(!uploads.upload_dir("aaaaaaaaaaaaaaaaaaaaaa").exists());
        assert!(uploads.upload_dir("bbbbbbbbbbbbbbbbbbbbbb").exists());
        assert!(uploads.reserve("cccccccccccccccccccccc", "c", 100).is_ok());
        let put = uploads.begin_put("bbbbbbbbbbbbbbbbbbbbbb", 10).unwrap();
        assert!(uploads.lock().uploads["bbbbbbbbbbbbbbbbbbbbbb"].touched >= now);
        drop(put);
        assert!(uploads.begin_put("aaaaaaaaaaaaaaaaaaaaaa", 10).is_err());
    }

    /// Inflating a chunk that fails is the data's fault when a read failed (400, with the
    /// decoder's message) and the disk's when a write did (500), though one copy does both.
    #[test]
    fn a_failed_inflate_tells_corrupt_data_from_a_failed_write() {
        let dir = tempfile::tempdir().unwrap();
        let data = vec![7u8; 4 << 20];
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(&data).unwrap();
        let (good, bad, out) = (
            dir.path().join("good.gz"),
            dir.path().join("bad.gz"),
            dir.path().join("out"),
        );
        fs::write(&good, gz.finish().unwrap()).unwrap();
        fs::write(&bad, b"\x1f\x8b not gzip after all").unwrap();

        assert!(gunzip_capped(&good, &out, data.len() as u64).is_ok());
        assert_eq!(fs::read(&out).unwrap(), data);
        assert!(matches!(
            gunzip_capped(&good, &out, data.len() as u64 - 1),
            Err(Gunzip::TooLarge)
        ));
        match gunzip_capped(&bad, &out, 1 << 30) {
            Err(Gunzip::Corrupt(e)) => assert!(!e.to_string().is_empty()),
            _ => panic!("corrupt gzip is the data's fault"),
        }
        match gunzip_capped(&good, Path::new("/dev/full"), 1 << 30) {
            Err(Gunzip::Disk(e)) => assert_eq!(e.kind(), ErrorKind::StorageFull),
            _ => panic!("a failed write is the disk's fault"),
        }
    }

    /// At startup, an upload directory older than [`STALE_UPLOAD`] is deleted and counts
    /// nothing; a younger one counts, with its directory's mtime as when it was touched.
    #[test]
    fn stale_directories_are_swept_at_startup() {
        let (dir, uploads) = uploads(200);
        start(&uploads, "aaaaaaaaaaaaaaaaaaaaaa", "a", 100).unwrap();
        start(&uploads, "bbbbbbbbbbbbbbbbbbbbbb", "b", 100).unwrap();
        drop(uploads);
        let old = SystemTime::now() - STALE_UPLOAD - Duration::from_secs(60);
        let a = dir.path().join("data/uploads/aaaaaaaaaaaaaaaaaaaaaa");
        File::open(&a).unwrap().set_modified(old).unwrap();

        let cfg = Config {
            data_dir: dir.path().join("data"),
            max_upload_bytes: 100,
            upload_budget_bytes: 200,
            ..Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let reopened = Arc::new(Uploads::open(&store, &cfg));
        assert!(!a.exists());
        let _c = reopened
            .reserve("cccccccccccccccccccccc", "c", 100)
            .unwrap();
        assert!(reopened.reserve("dddddddddddddddddddddd", "d", 1).is_err());
    }
}
