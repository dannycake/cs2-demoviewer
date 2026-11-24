//! The job runner: turns an uploaded file, a URL or a share code into a stored pack and match
//! summary.
//!
//! Every step that writes a file keeps the data volume at `Config::min_free_bytes` free or more
//! ([`store::LOW_DISK`] otherwise), as uploads are checked when they start and complete: a
//! download and the parse's pack are checked before they start, and inflating stops when it
//! has written what the disk can spare above the floor (a compressed file may inflate 20 times).
//!
//! Share-code jobs first ask the share-code service for the match's replay URL (one lookup at a
//! time, see [`crate::gcbot`]) while their record is `Resolving`, then go on as URL jobs. URL
//! jobs first download, at most [`MAX_DOWNLOADS`] at a time, beside the parse worker, so a slow
//! server holds up other downloads at worst, never uploads. Both hold a place in the fetch
//! queue ([`crate::admission`]), taken before their record is made, until their file reaches
//! the parse worker, and one that cannot start its download within [`DOWNLOAD_WAIT`] fails.
//! Every file then goes through the single parse worker: decompress unless the file already is
//! a raw demo → refuse a demo whose header says the file was cut short → SHA-256 → keep the
//! original, zstd-compressed, in `originals/` unless that sha's is kept already
//! ([`crate::originals`]; a copy, before the parse, so a demo the parser fails on is kept too)
//! → if another record with that sha is `Done`, give its summary the match id and played time it lacks,
//! alias it and stop → `Parsing` → parse (in a child process with capped memory, see
//! [`crate::worker`], killed after [`PARSE_TIMEOUT`]) → refuse a match with no complete round →
//! write the pack to `tmp/`, rename it into `packs/` → write the match summary
//! ([`crate::matches`]) to `tmp/`, rename it into `matches/`, add it to the match index → `Done`
//! with map and rounds → delete the work files, the demo among them (its original is kept) →
//! evict packs over the
//! cache limit, when one is set (packs are kept forever by default). Every rename into place
//! reaches the disk first ([`store::replace_file`]). Any failure sets `Error` with a message;
//! the work files go either way.
//!
//! One parse worker means files of the same demo are handled one after the other, so the
//! second always finds the first one's pack and aliases it: one demo is never parsed twice.
//!
//! Background work ([`Jobs::enqueue_background`], queued by [`crate::background`]) goes one job
//! at a time: a kept original restored into `tmp/`, or a share code's replay fetched again
//! (outside the download slots), reaches the same parse worker, which takes it only when no
//! user work is queued. Its pack and summary are replaced; no record changes, and a failure is
//! only logged.

use std::fs::{self, File};
use std::future::Future;
use std::io::{self, ErrorKind};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use demoviewer_pack::Match;
use tokio::sync::{mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use url::Url;

use crate::admission::QueueSlot;
use crate::config::Config;
use crate::errors::blocking;
use crate::gcbot::{GcbotClient, Resolver, ShareCodes};
use crate::import::ImportLog;
use crate::indexnow::IndexNow;
use crate::ingest;
use crate::matches::{GameMode, MatchSummary};
use crate::parse::{self, ParseError};
use crate::sharecode::ShareCode;
use crate::store::{self, Status, Store, WorkFiles};
use crate::worker;

/// URL downloads that may run at once, beside the parse worker.
pub const MAX_DOWNLOADS: usize = 2;
/// Downloaded demos waiting for the parse worker (plus the ones downloading) hold `tmp/` disk;
/// past this many, further URL jobs wait before they start downloading.
pub const MAX_QUEUED_DOWNLOADS: usize = 8;
/// Longest a parse may run before its job fails and the worker moves on. A release build
/// parses a 240 MB demo in under 2 s; this is for a parser that hangs. A parse child is
/// killed; an in-process parse (no `parse_worker`) cannot be stopped and runs on, but nothing
/// it produces is used.
pub const PARSE_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Longest a URL or share-code job may wait for its download to start (behind other downloads)
/// before it fails as too busy: two of the slowest downloads one after the other.
pub const DOWNLOAD_WAIT: Duration = Duration::from_secs(30 * 60);
/// How long a background refetch waits for gcbot to be seen online: background work is queued
/// as the server starts, before its first look at gcbot's health.
pub const GCBOT_WAIT: Duration = Duration::from_secs(120);
/// The error for a demo that parses but holds no complete round (a demo cut short inside the
/// first round, or one with only warmup).
pub const NO_ROUNDS: &str =
    "the demo has no complete rounds; it may be truncated or still recording";

#[derive(Debug)]
pub enum Job {
    /// An assembled upload in `tmp/`; the record's `sha256` is already that file's hash.
    /// `slot` is the upload's place among the completed uploads ([`crate::admission`]), held
    /// until the job ends so completed uploads cannot pile up on disk (None in tests that drive
    /// the runner).
    Upload {
        demo_id: String,
        dem_path: PathBuf,
        slot: Option<QueueSlot>,
    },
    /// A URL that passed `check_url`. `slot` is the job's place in the fetch queue, held
    /// until its file reaches the parse worker or it fails (None in tests that drive the
    /// runner).
    Url {
        demo_id: String,
        url: Url,
        slot: Option<QueueSlot>,
    },
    /// A share code, whose `Resolving` record is `demo_id`; `slot` as for [`Job::Url`].
    ShareCode {
        demo_id: String,
        code: ShareCode,
        slot: Option<QueueSlot>,
    },
    /// Background work ([`Jobs::enqueue_background`]): parse the kept original of `sha` again
    /// and rewrite its pack and summary (a summary from before ranks).
    Reparse { sha: String },
    /// Background work: fetch the demo of `sha` again through its share code while Valve still
    /// keeps it, keep it as the original, and parse it again as [`Job::Reparse`] does.
    Refetch { sha: String, code: ShareCode },
    /// Background work: a corpus demo at `path`, which is only read, for its new
    /// `Source::Import` record `demo_id`; once it is done, `index_sha` goes in `log`
    /// ([`crate::import`]).
    Import {
        demo_id: String,
        path: PathBuf,
        index_sha: String,
        log: Arc<ImportLog>,
    },
}

impl Job {
    /// The demo id of user work, the sha of background work: what the log names it by.
    fn demo_id(&self) -> &str {
        match self {
            Job::Upload { demo_id, .. }
            | Job::Url { demo_id, .. }
            | Job::ShareCode { demo_id, .. }
            | Job::Import { demo_id, .. } => demo_id,
            Job::Reparse { sha } | Job::Refetch { sha, .. } => sha,
        }
    }
}

/// The sending side of the job queue and of the background queue, and the share-code lookups
/// its runner makes (none without a share-code service), which the API asks too.
#[derive(Clone)]
pub struct Jobs {
    tx: mpsc::UnboundedSender<Job>,
    background: mpsc::Sender<Job>,
    sharecodes: Option<Arc<ShareCodes>>,
    /// Set once by the app, which builds it (the runner starts first): shared with the runner.
    indexnow: Arc<OnceLock<Arc<IndexNow>>>,
}

impl Jobs {
    /// A queue with no runner and no share-code service: the caller drains the receiver
    /// (tests).
    pub fn channel() -> (Jobs, mpsc::UnboundedReceiver<Job>) {
        let (jobs, rx, _background) = Jobs::channels();
        (jobs, rx)
    }

    /// [`Jobs::channel`] with the background queue's receiver too.
    pub fn channels() -> (Jobs, mpsc::UnboundedReceiver<Job>, mpsc::Receiver<Job>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (background, later) = mpsc::channel(1);
        let jobs = Jobs {
            tx,
            background,
            sharecodes: None,
            indexnow: Arc::default(),
        };
        (jobs, rx, later)
    }

    /// The runner's share-code lookups, when it has a share-code service.
    pub fn sharecodes(&self) -> Option<&Arc<ShareCodes>> {
        self.sharecodes.as_ref()
    }

    /// IndexNow, once the app built it (never without a key and a public URL).
    pub fn indexnow(&self) -> Option<&Arc<IndexNow>> {
        self.indexnow.get()
    }

    /// Hands the runner the app's IndexNow.
    pub fn set_indexnow(&self, indexnow: Arc<IndexNow>) {
        let _ = self.indexnow.set(indexnow);
    }

    pub fn enqueue(&self, job: Job) {
        if let Err(e) = self.tx.send(job) {
            tracing::error!(demo = e.0.demo_id(), "the job runner is gone; job dropped");
        }
    }

    /// Queues background work ([`Job::Reparse`], [`Job::Refetch`], [`Job::Import`]). The runner does it one job
    /// at a time, and its parse waits while any user work is queued for the parse worker. Waits
    /// while one background job is already waiting, so a long list is handed over as it goes.
    pub async fn enqueue_background(&self, job: Job) {
        if let Err(e) = self.background.send(job).await {
            tracing::error!(
                demo = e.0.demo_id(),
                "the job runner is gone; background job dropped"
            );
        }
    }
}

/// How the runner turns a raw demo into a [`Match`].
pub type ParseFn = Arc<dyn Fn(&Path) -> Result<Match, ParseError> + Send + Sync>;

/// Test seams for [`spawn_runner_with`]: the parser, socket addresses downloads may reach
/// despite the SSRF guard (a local test server), host names downloads resolve to given
/// addresses instead of by DNS (a Valve replay host served by that server), the parse time
/// limit, the longest wait for a download to start, the data volume's free space (instead of
/// asking the filesystem, set on the store: [`Store::set_free_space`]), and the share-code
/// service. Not for production use. `parse` is used only when `Config::parse_worker` is `None`;
/// `resolver`, when set, instead of `Config::gcbot_url`.
#[doc(hidden)]
#[derive(Clone)]
pub struct Hooks {
    pub parse: ParseFn,
    pub download_exempt: Vec<SocketAddr>,
    pub download_hosts: Vec<(String, SocketAddr)>,
    pub parse_timeout: Duration,
    pub download_wait: Duration,
    pub free_space: Option<store::FreeSpace>,
    pub resolver: Option<Arc<dyn Resolver>>,
}

impl Default for Hooks {
    fn default() -> Self {
        Hooks {
            parse: Arc::new(parse::parse_file),
            download_exempt: Vec::new(),
            download_hosts: Vec::new(),
            parse_timeout: PARSE_TIMEOUT,
            download_wait: DOWNLOAD_WAIT,
            free_space: None,
            resolver: None,
        }
    }
}

/// Starts the runner on the current tokio runtime (one parse worker, plus up to
/// [`MAX_DOWNLOADS`] URL downloads beside it, and share-code lookups through gcbot when
/// `Config::gcbot_url` is set) and returns its queue.
pub fn spawn_runner(store: Arc<Store>, cfg: Arc<Config>) -> Jobs {
    spawn_runner_with(store, cfg, Hooks::default())
}

/// [`spawn_runner`] with test hooks.
#[doc(hidden)]
pub fn spawn_runner_with(store: Arc<Store>, cfg: Arc<Config>, hooks: Hooks) -> Jobs {
    let resolver = hooks.resolver.clone().or_else(|| {
        let url = cfg.gcbot_url.clone()?;
        Some(GcbotClient::new(url) as Arc<dyn Resolver>)
    });
    if let Some(free) = &hooks.free_space {
        store.set_free_space(free.clone());
    }
    let (mut jobs, mut rx, mut later) = Jobs::channels();
    jobs.sharecodes = resolver.map(|r| Arc::new(ShareCodes::new(r)));
    let (to_worker, mut work) = mpsc::unbounded_channel::<Work>();
    let (to_worker_later, mut work_later) = mpsc::channel::<Work>(1);
    let runner = Arc::new(Runner {
        store,
        cfg,
        hooks,
        sharecodes: jobs.sharecodes.clone(),
        downloads: Semaphore::new(MAX_DOWNLOADS),
        queued: Arc::new(Semaphore::new(MAX_QUEUED_DOWNLOADS)),
        indexnow: jobs.indexnow.clone(),
    });
    let dispatcher = runner.clone();
    tokio::spawn(async move {
        while let Some(job) = rx.recv().await {
            match job {
                Job::Upload {
                    demo_id,
                    dem_path,
                    slot,
                } => {
                    let sha = dispatcher.store.get(&demo_id).and_then(|r| r.sha256);
                    dispatcher.hand_over(
                        &to_worker,
                        Work {
                            demo_id,
                            path: dem_path,
                            sha,
                            kind: WorkKind::New,
                            _upload: slot,
                            _download: None,
                            _done: None,
                        },
                    );
                }
                Job::Url { demo_id, url, slot } => {
                    let fetch = dispatcher
                        .clone()
                        .fetch(demo_id, url, slot, to_worker.clone());
                    tokio::spawn(fetch);
                }
                Job::ShareCode {
                    demo_id,
                    code,
                    slot,
                } => {
                    let look_up =
                        dispatcher
                            .clone()
                            .look_up(demo_id, code, slot, to_worker.clone());
                    tokio::spawn(look_up);
                }
                job @ (Job::Reparse { .. } | Job::Refetch { .. } | Job::Import { .. }) => {
                    tracing::error!(
                        demo = job.demo_id(),
                        "background work queued as user work; dropped"
                    );
                }
            }
        }
    });
    let lane = runner.clone();
    tokio::spawn(async move {
        while let Some(job) = later.recv().await {
            lane.clone().background(job, &to_worker_later).await;
        }
    });
    tokio::spawn(async move {
        loop {
            // User work first: background work waits while any is queued.
            let w = tokio::select! {
                biased;
                Some(w) = work.recv() => w,
                Some(w) = work_later.recv() => w,
                else => break,
            };
            runner.clone().run(w).await;
        }
    });
    jobs
}

/// A file for the parse worker: an assembled upload, a finished download, or background work's
/// demo.
struct Work {
    /// The record's id; for background work, the sha.
    demo_id: String,
    path: PathBuf,
    /// The SHA-256 of `path`, when the upload already computed it.
    sha: Option<String>,
    kind: WorkKind,
    /// The file's place in its queue, released when the worker is done with it (or the work
    /// is dropped): a completed upload's among the completed uploads, a download's among the
    /// [`MAX_QUEUED_DOWNLOADS`].
    _upload: Option<QueueSlot>,
    _download: Option<OwnedSemaphorePermit>,
    /// Dropped when the worker is done with background work: the next may start.
    _done: Option<oneshot::Sender<()>>,
}

/// What the parse worker makes of a file.
enum WorkKind {
    /// A demo for its record, which goes through `Parsing` to `Done` or `Error`.
    New,
    /// The demo of `sha` again, from its kept original or fetched from Valve again: its pack
    /// and summary are rewritten and no record changes ([`Runner::reparse`]).
    Reparse { sha: String },
    /// A corpus demo, as [`WorkKind::New`] but never deleted (the corpus is only read), and
    /// logged as imported once done.
    Import {
        index_sha: String,
        log: Arc<ImportLog>,
    },
}

struct Runner {
    store: Arc<Store>,
    cfg: Arc<Config>,
    hooks: Hooks,
    sharecodes: Option<Arc<ShareCodes>>,
    downloads: Semaphore,
    queued: Arc<Semaphore>,
    indexnow: Arc<OnceLock<Arc<IndexNow>>>,
}

impl Runner {
    /// Queues `w` for the parse worker; if the worker is gone, deletes the file and fails the
    /// job.
    fn hand_over(&self, to_worker: &mpsc::UnboundedSender<Work>, w: Work) {
        if let Err(mpsc::error::SendError(w)) = to_worker.send(w) {
            let _ = fs::remove_file(&w.path);
            self.fail(
                &w.demo_id,
                Instant::now(),
                "internal error: the parse worker is gone".into(),
            );
        }
    }

    /// A share-code job: the match's replay URL from the share-code service, then that URL's
    /// download as in a URL job. When the match was played goes on the record, for the summary.
    async fn look_up(
        self: Arc<Self>,
        demo_id: String,
        code: ShareCode,
        slot: Option<QueueSlot>,
        to_worker: mpsc::UnboundedSender<Work>,
    ) {
        let started = Instant::now();
        let this = self.clone();
        let id = demo_id.clone();
        let fetched = isolated(async move {
            let Some(sharecodes) = this.sharecodes.clone() else {
                return Err("share codes are not taken here".to_owned());
            };
            let replay = sharecodes
                .resolve(&code)
                .await
                .map_err(|e| e.to_string())?;
            tracing::info!(demo = %id, match_id = code.match_id, url = %replay.url, secs = started.elapsed().as_secs_f64(), "share code resolved");
            let game_type = replay.info.as_ref().and_then(crate::gcbot::gc_game_type);
            if let Some(info) = replay.info.clone() {
                this.keep_gc_info(&id, replay.match_id, info).await;
            }
            this.store.update(&id, |r| {
                r.status = Status::Queued;
                r.played_unix = replay.played_unix;
                r.gc_game_type = game_type;
            });
            this.download(id, replay.url, to_worker).await
        })
        .await;
        drop(slot);
        if let Err(msg) = fetched {
            self.fail(&demo_id, started, msg);
        }
    }

    /// A URL job's first half: download into `tmp/` in one of the [`MAX_DOWNLOADS`] slots,
    /// then hand the file to the parse worker. `slot`, the job's place in the fetch queue, is
    /// given back then.
    async fn fetch(
        self: Arc<Self>,
        demo_id: String,
        url: Url,
        slot: Option<QueueSlot>,
        to_worker: mpsc::UnboundedSender<Work>,
    ) {
        let started = Instant::now();
        let this = self.clone();
        let id = demo_id.clone();
        let fetched = isolated(async move { this.download(id, url, to_worker).await }).await;
        drop(slot);
        if let Err(msg) = fetched {
            self.fail(&demo_id, started, msg);
        }
    }

    /// Waits for a place among the downloaded files and a download slot, at most
    /// [`Hooks::download_wait`] ([`DOWNLOAD_WAIT`]), then downloads `url` into `tmp/` and hands
    /// the file to the parse worker.
    async fn download(
        &self,
        demo_id: String,
        url: Url,
        to_worker: mpsc::UnboundedSender<Work>,
    ) -> Result<(), String> {
        let limit = self.hooks.download_wait;
        let turn = async {
            let queued = self
                .queued
                .clone()
                .acquire_owned()
                .await
                .map_err(|_| "internal error: the download queue is closed".to_owned())?;
            let slot = self
                .downloads
                .acquire()
                .await
                .map_err(|_| "internal error: the download slots are closed".to_owned())?;
            Ok::<_, String>((queued, slot))
        };
        let Ok(turn) = tokio::time::timeout(limit, turn).await else {
            tracing::warn!(demo = %demo_id, limit = ?limit, "no download slot in time");
            return Err(format!(
                "the server was too busy to start this download (it waited {limit:?}); \
                 try again later"
            ));
        };
        let (queued, _slot) = turn?;
        self.check_room(self.cfg.max_upload_bytes)?;
        self.set_status(&demo_id, Status::Downloading);
        let dest = self.store.tmp_dir().join(format!("{demo_id}.download"));
        let mut work = WorkFiles::default();
        work.add(&dest);
        let started = Instant::now();
        let bytes = self.get(&url, &dest).await?;
        tracing::info!(demo = %demo_id, bytes, secs = started.elapsed().as_secs_f64(), "downloaded");
        // The file is the worker's now; it waits its turn as `Queued`.
        work.release();
        self.set_status(&demo_id, Status::Queued);
        self.hand_over(
            &to_worker,
            Work {
                demo_id,
                path: dest,
                sha: None,
                kind: WorkKind::New,
                _upload: None,
                _download: Some(queued),
                _done: None,
            },
        );
        Ok(())
    }

    /// Downloads `url` into `dest`, at most `Config::max_upload_bytes`; returns its size.
    async fn get(&self, url: &Url, dest: &Path) -> Result<u64, String> {
        let max = self.cfg.max_upload_bytes;
        let (exempt, hosts) = (&self.hooks.download_exempt, &self.hooks.download_hosts);
        if exempt.is_empty() && hosts.is_empty() {
            ingest::download(url, dest, max).await
        } else {
            ingest::download_testing(url, dest, max, exempt, hosts).await
        }
        .map_err(|e| format!("download failed: {e}"))
    }

    /// Background work's first half, one job at a time: the demo of the job's sha into `tmp/`
    /// (its original restored, or fetched again through its share code, without taking a
    /// download slot from user work), then to the parse worker, which takes it when no user
    /// work is queued. Returns once the worker is done with it. A failure is only logged: the
    /// replay stays as it was.
    async fn background(self: Arc<Self>, job: Job, to_worker: &mpsc::Sender<Work>) {
        let name = job.demo_id().to_owned();
        let this = self.clone();
        let prepared = isolated(async move {
            match job {
                Job::Reparse { sha } => Ok((this.restore(&sha).await?, WorkKind::Reparse { sha })),
                Job::Refetch { sha, code } => {
                    Ok((this.refetch(&sha, &code).await?, WorkKind::Reparse { sha }))
                }
                Job::Import {
                    path,
                    index_sha,
                    log,
                    ..
                } => Ok((path, WorkKind::Import { index_sha, log })),
                _ => Err("user work queued as background work".to_owned()),
            }
        })
        .await;
        let (path, kind) = match prepared {
            Ok(prepared) => prepared,
            Err(msg) => {
                tracing::warn!(demo = %name, error = %msg, "background work failed");
                return;
            }
        };
        let (done, finished) = oneshot::channel();
        let w = Work {
            demo_id: name,
            path,
            sha: None,
            kind,
            _upload: None,
            _download: None,
            _done: Some(done),
        };
        if let Err(mpsc::error::SendError(w)) = to_worker.send(w).await {
            if !matches!(w.kind, WorkKind::Import { .. }) {
                let _ = fs::remove_file(&w.path);
            }
            return;
        }
        let _ = finished.await;
    }

    /// The kept original of `sha`, inflated into `tmp/`.
    async fn restore(&self, sha: &str) -> Result<PathBuf, String> {
        let dest = self.store.tmp_dir().join(format!("{sha}.original.dem"));
        let (src, written, room) = (
            self.store.original_path(sha),
            dest.clone(),
            self.store.room(),
        );
        blocking(move || crate::originals::restore_original(&src, &written, room))
            .await?
            .map_err(|e| file_error("restore the original", &dest, &e))?;
        Ok(dest)
    }

    /// The demo of `sha` downloaded into `tmp/` again, from the replay URL its share code
    /// resolves to now (one lookup at a time, with user lookups: [`ShareCodes`]).
    async fn refetch(&self, sha: &str, code: &ShareCode) -> Result<PathBuf, String> {
        let Some(sharecodes) = self.sharecodes.clone() else {
            return Err("share codes are not taken here".to_owned());
        };
        let waited = Instant::now();
        while !sharecodes.online() && waited.elapsed() < GCBOT_WAIT {
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        let replay = sharecodes.resolve(code).await.map_err(|e| e.to_string())?;
        self.check_room(self.cfg.max_upload_bytes)?;
        let dest = self.store.tmp_dir().join(format!("{sha}.refetch"));
        let mut work = WorkFiles::default();
        work.add(&dest);
        let bytes = self.get(&replay.url, &dest).await?;
        tracing::info!(%sha, bytes, "fetched again");
        work.release();
        Ok(dest)
    }

    /// The parse worker's step for one file.
    async fn run(self: Arc<Self>, w: Work) {
        let id = w.demo_id.clone();
        let started = Instant::now();
        let this = self.clone();
        if let WorkKind::Reparse { sha } = &w.kind {
            let sha = sha.clone();
            match isolated(async move { this.reparse(w.path, sha).await }).await {
                Ok(()) => {
                    tracing::info!(sha = %id, secs = started.elapsed().as_secs_f64(), "re-parsed")
                }
                Err(msg) => tracing::warn!(sha = %id, error = %msg, "re-parse failed"),
            }
            return;
        }
        match isolated(async move { this.process(w).await }).await {
            Ok(()) => {
                tracing::info!(demo = %id, secs = started.elapsed().as_secs_f64(), "demo ready")
            }
            Err(msg) => self.fail(&id, started, msg),
        }
    }

    async fn process(&self, w: Work) -> Result<(), String> {
        let Work {
            demo_id: id,
            path: source,
            sha: known_sha,
            kind,
            ..
        } = w;
        let tmp = self.store.tmp_dir();
        let mut work = WorkFiles::default();
        // An imported demo lies in the corpus, which is only read.
        let borrowed = matches!(kind, WorkKind::Import { .. });
        if !borrowed {
            work.add(&source);
        }

        let (dem, inflated) = self.raw_demo(&id, source, borrowed, &mut work).await?;
        let sha = match known_sha.filter(|_| !inflated) {
            Some(sha) => sha,
            None => self.sha_of(&dem).await?,
        };
        self.store.update(&id, |r| r.sha256 = Some(sha.clone()));

        // The original is the data. A demo that came from a match rather than from someone's
        // disk (a replay link, a share code, a tracked, imported or FACEIT match) is a real
        // match, kept before the parse, so one the parser fails on waits for a fixed parser.
        // An upload is anyone's bytes: it is kept only once it parsed, so junk shaped like a
        // demo cannot fill `originals/`. An alias of a kept sha writes nothing; an upload
        // aliased to a pack with no original (one packed before originals were kept) gives it
        // one, as those bytes already parsed.
        let rec = self.store.get(&id);
        let from_valve = rec
            .as_ref()
            .is_some_and(|r| r.source != store::Source::Upload);
        let faceit_match = rec.is_some_and(|r| r.faceit_match_id.is_some());
        if from_valve {
            self.keep_original(&id, &sha, &dem, &mut work).await?;
        }

        let summary_tmp = tmp.join(format!("{id}.json"));
        work.add(&summary_tmp);
        if self.alias_existing(&id, &sha, &summary_tmp).await {
            // The upload is already the match's alias, done: a failure here only costs the
            // re-parse, so it is logged rather than failing the upload.
            if !from_valve {
                if let Err(e) = self.keep_original(&id, &sha, &dem, &mut work).await {
                    tracing::warn!(demo = %id, error = %e, "cannot keep an aliased upload's demo");
                }
            }
            self.log_imported(&id, &kind).await;
            return Ok(());
        }

        self.room_for_pack(&dem)?;
        self.set_status(&id, Status::Parsing);
        let started = Instant::now();
        // On the disk before a record says `Done`: a pack is served as immutable for a year.
        let mut summary = self
            .parse_and_pack(&id, &sha, &dem, faceit_match, &mut work)
            .await?;
        if !from_valve {
            self.keep_original(&id, &sha, &dem, &mut work).await?;
        }

        // What the parse cannot know comes from the record.
        if let Some(r) = self.store.get(&id) {
            summary.created_unix = r.created_unix;
            summary.take_known(&r);
        }
        summary.sha256 = sha.clone();
        self.write_summary(&summary, &summary_tmp).await?;
        self.store.matches().insert(summary.clone());
        // Before `Done`: an importer that sees the record done finds it in the log.
        self.log_imported(&id, &kind).await;

        let queued = self.indexnow.get().map(|_| summary.clone());
        let MatchSummary { map, rounds, .. } = summary;
        tracing::info!(demo = %id, %map, rounds, secs = started.elapsed().as_secs_f64(), "parsed and packed");
        self.store.update(&id, |r| {
            r.status = Status::Done;
            r.map = Some(map);
            r.rounds = Some(rounds);
            r.error = None;
        });
        if let (Some(ix), Some(queued)) = (self.indexnow.get(), &queued) {
            // The pages use the oldest done record of the sha.
            let canonical = self.store.find_by_sha(&sha).map_or(id.clone(), |r| r.id);
            ix.queue_match(&canonical, queued);
        }
        drop(work);

        let Some(limit) = self.cfg.cache_bytes else {
            return Ok(());
        };
        let store = self.store.clone();
        match blocking(move || store.evict_lru(limit)).await {
            Ok(Ok(evicted)) if !evicted.is_empty() => {
                tracing::info!(
                    evicted = evicted.len(),
                    "packs evicted over the cache limit"
                )
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => tracing::warn!(error = %e, "pack eviction failed"),
            Err(e) => tracing::warn!(error = %e, "pack eviction failed"),
        }
        Ok(())
    }

    /// Background work's parse ([`WorkKind::Reparse`]): `source`, the demo of `sha` again, must
    /// hash to `sha` (a demo Valve serves for the share code now may be another), is kept as
    /// the original unless one is, and is parsed; its pack and summary replace the old ones.
    /// The summary keeps what the old one knew and a parse cannot (the store date and the
    /// record's facts, [`MatchSummary::keep_known`]) and a FACEIT match's mode; with no old
    /// summary, it takes them from a record of the sha. No record changes: the replay stays
    /// `Done` throughout, and a browser's cached copy of the old pack still plays, as packs
    /// only gained header fields.
    async fn reparse(&self, source: PathBuf, sha: String) -> Result<(), String> {
        let id = format!("{sha}.reparse");
        let mut work = WorkFiles::default();
        work.add(&source);
        let (dem, _) = self.raw_demo(&id, source, false, &mut work).await?;
        let found = self.sha_of(&dem).await?;
        if found != sha {
            return Err(format!("the demo fetched again is another demo ({found})"));
        }
        self.keep_original(&id, &sha, &dem, &mut work).await?;
        self.room_for_pack(&dem)?;
        let old = self.store.matches().get(&sha);
        let rec = match old {
            Some(_) => None,
            None => self.store.find_by_sha(&sha),
        };
        let faceit_match = match (&old, &rec) {
            (Some(old), _) => old.known_faceit(),
            (None, Some(r)) => r.faceit_match_id.is_some(),
            (None, None) => false,
        };
        let mut summary = self
            .parse_and_pack(&id, &sha, &dem, faceit_match, &mut work)
            .await?;
        if let Some(old) = &old {
            summary.created_unix = old.created_unix;
            summary.keep_known(old);
        } else if let Some(r) = &rec {
            summary.created_unix = r.created_unix;
            summary.take_known(r);
        }
        summary.sha256 = sha;
        let summary_tmp = self.store.tmp_dir().join(format!("{id}.json"));
        work.add(&summary_tmp);
        self.write_summary(&summary, &summary_tmp).await?;
        drop(work);
        self.store.matches().insert(summary);
        Ok(())
    }

    /// `source` as a raw demo, with whether it was inflated: a raw demo is used where it lies
    /// (no 200 MB copy); anything else is inflated into `tmp/<id>.dem`, at most into the room
    /// the disk has above its floor, and `source` is deleted unless `borrowed`. A demo whose
    /// header says it was cut short is refused.
    async fn raw_demo(
        &self,
        id: &str,
        source: PathBuf,
        borrowed: bool,
        work: &mut WorkFiles,
    ) -> Result<(PathBuf, bool), String> {
        let inflated_path = self.store.tmp_dir().join(format!("{id}.dem"));
        work.add(&inflated_path);
        let (src, dst, room) = (source.clone(), inflated_path.clone(), self.store.room());
        let inflated = blocking(move || inflate_unless_raw(&src, &dst, room))
            .await?
            .map_err(|e| demo_error(&source, &e))?;
        let dem = if inflated {
            if !borrowed {
                let _ = fs::remove_file(&source);
            }
            inflated_path
        } else {
            source
        };
        let path = dem.clone();
        blocking(move || check_not_truncated(&path)).await??;
        Ok((dem, inflated))
    }

    async fn sha_of(&self, dem: &Path) -> Result<String, String> {
        let path = dem.to_owned();
        blocking(move || store::sha256_file(&path))
            .await?
            .map_err(|e| file_error("read the demo", dem, &e))
    }

    /// Parses `dem` and puts its pack in place as the pack of `sha`; returns the parse's
    /// summary, whose mode is `Other` when no player was ranked (the demo has no rank props: a
    /// match of no ranked mode, not one waiting for ranks; only a summary upgraded from a pack
    /// made before ranks were read has none, and is parsed again for them). `faceit_match`
    /// (the record, or the summary parsed again, knows the match is FACEIT's) makes the mode
    /// FACEIT, as [`crate::matches::summarize`] would given it: the worker that summarizes,
    /// often a child process, sees only the demo. The caller checks the room for the pack
    /// first ([`Runner::room_for_pack`]).
    async fn parse_and_pack(
        &self,
        id: &str,
        sha: &str,
        dem: &Path,
        faceit_match: bool,
        work: &mut WorkFiles,
    ) -> Result<MatchSummary, String> {
        let pack_tmp = self.store.tmp_dir().join(format!("{id}.dvpk.gz"));
        work.add(&pack_tmp);
        let mut summary = match &self.cfg.parse_worker {
            Some(exe) => self.parse_in_child(id, exe, dem, &pack_tmp).await?,
            None => {
                self.parse_in_process(id, dem.to_owned(), pack_tmp.clone())
                    .await?
            }
        };
        if faceit_match {
            summary.mode = Some(GameMode::Faceit);
        }
        let (written, pack_path) = (pack_tmp.clone(), self.store.pack_path(sha));
        blocking(move || store::replace_file(&written, &pack_path))
            .await?
            .map_err(|e| file_error("store the replay", &pack_tmp, &e))?;
        Ok(summary)
    }

    /// Writes `summary` as the summary of its sha, through `tmp`.
    async fn write_summary(&self, summary: &MatchSummary, tmp: &Path) -> Result<(), String> {
        let saving = |e: io::Error| file_error("store the match summary", tmp, &e);
        let json = serde_json::to_vec(summary).map_err(|e| saving(e.into()))?;
        let (written, path) = (tmp.to_owned(), self.store.summary_path(&summary.sha256));
        blocking(move || store::write_file(&written, &path, &json))
            .await?
            .map_err(saving)
    }

    /// Parses `dem` into `pack_tmp` in a child process, killed at the time limit.
    async fn parse_in_child(
        &self,
        id: &str,
        exe: &Path,
        dem: &Path,
        pack_tmp: &Path,
    ) -> Result<MatchSummary, String> {
        let limit = self.hooks.parse_timeout;
        let child = worker::parse_in_child(exe, dem, pack_tmp, self.cfg.parse_memory_bytes);
        match tokio::time::timeout(limit, child).await {
            Ok(outcome) => outcome,
            Err(_) => {
                tracing::error!(demo = %id, limit = ?limit, "parse timed out; the parser process was killed");
                Err(too_long(limit))
            }
        }
    }

    /// Parses `dem` into `pack_tmp` on a blocking thread of this process (no `parse_worker`).
    async fn parse_in_process(
        &self,
        id: &str,
        dem: PathBuf,
        pack_tmp: PathBuf,
    ) -> Result<MatchSummary, String> {
        let parse = self.hooks.parse.clone();
        // Set when the worker stops waiting, so a parse that finishes late writes nothing.
        let abandoned = Arc::new(AtomicBool::new(false));
        let late = abandoned.clone();
        let parsing =
            blocking(move || worker::parse_to_pack(&*parse, &dem, &pack_tmp, Some(&late)));
        let limit = self.hooks.parse_timeout;
        match tokio::time::timeout(limit, parsing).await {
            Ok(outcome) => outcome?,
            Err(_) => {
                abandoned.store(true, Ordering::SeqCst);
                tracing::error!(demo = %id, limit = ?limit, "parse timed out; its thread is abandoned and may still be running");
                Err(too_long(limit))
            }
        }
    }

    /// If another record with this sha is `Done` and its pack is still on disk, makes `id` an
    /// alias of it (same map and rounds, same pack) and returns true. The pack's summary is
    /// completed first ([`Runner::complete_summary`], through `summary_tmp`), so it is whole by
    /// the time `id` is `Done`.
    async fn alias_existing(&self, id: &str, sha: &str, summary_tmp: &Path) -> bool {
        let packed = self
            .store
            .find_by_sha(sha)
            .is_some_and(|r| r.id != id && r.status == Status::Done);
        if !packed || !self.store.pack_path(sha).is_file() {
            return false;
        }
        self.store.touch_pack(sha);
        self.complete_summary(id, sha, summary_tmp.to_owned()).await;
        // Made under the index lock, as the pack may have been evicted meanwhile; then the demo
        // is parsed again.
        let Some(done) = self.store.alias_packed(id, sha) else {
            return false;
        };
        tracing::info!(demo = %id, of = %done.id, "same demo already packed; aliased");
        true
    }

    /// Gives the summary of the pack `id` is aliased to what `id`'s record knows and the
    /// summary lacks ([`MatchSummary::take_known`]): Valve's match id, when the match was
    /// played and the GC's game type, which a share code brings and an upload does not, an
    /// imported demo's event, and a FACEIT match's id. A match uploaded first and posted as a
    /// share code later then shows when it was played (its page's description;
    /// `GET /api/demos/{id}`'s summary). A failure is only logged: the replay is ready either
    /// way.
    async fn complete_summary(&self, id: &str, sha: &str, tmp: PathBuf) {
        let Some(r) = self.store.get(id) else {
            return;
        };
        let path = self.store.summary_path(sha);
        let filling = move || fill_summary(&path, &tmp, &r);
        match blocking(filling).await {
            Ok(Ok(Some(summary))) => {
                self.store.matches().insert(summary);
                tracing::info!(demo = %id, "match summary completed by an alias")
            }
            Ok(Ok(None)) => {}
            Ok(Err(e)) => {
                tracing::warn!(demo = %id, error = %e, "cannot complete the match summary")
            }
            Err(e) => tracing::warn!(demo = %id, error = %e, "cannot complete the match summary"),
        }
    }

    /// Keeps the GC's match info for `match_id` beside the match (`gc/<match id>.json`). A
    /// failure is only logged: the replay does not need it.
    async fn keep_gc_info(&self, id: &str, match_id: u64, info: serde_json::Value) {
        let dest = self.store.gc_path(match_id);
        let tmp = self.store.tmp_dir().join(format!("{id}.gc.json"));
        let written = blocking(move || {
            if let Some(dir) = dest.parent() {
                fs::create_dir_all(dir)?;
            }
            store::write_file(&tmp, &dest, &serde_json::to_vec(&info)?)
        })
        .await;
        match written {
            Ok(Ok(())) => {}
            Ok(Err(e)) => tracing::warn!(demo = %id, error = %e, "cannot keep the GC's match info"),
            Err(e) => tracing::warn!(demo = %id, error = %e, "cannot keep the GC's match info"),
        }
    }

    /// Logs an import as done ([`ImportLog`]) so no later scan imports it again. A failure is
    /// only logged: the next scan imports the demo again, as an alias.
    async fn log_imported(&self, id: &str, kind: &WorkKind) {
        let WorkKind::Import { index_sha, log } = kind else {
            return;
        };
        let (log, index_sha, demo_id) = (log.clone(), index_sha.clone(), id.to_owned());
        let logged = blocking(move || log.insert(&index_sha, &demo_id)).await;
        if let Some(e) = match logged {
            Ok(Ok(())) => None,
            Ok(Err(e)) => Some(e.to_string()),
            Err(e) => Some(e.to_string()),
        } {
            tracing::warn!(demo = %id, error = %e, "cannot log the import");
        }
    }

    /// Keeps `dem` as the original of `sha` ([`crate::originals`]) unless one is kept already,
    /// refusing when the disk is below its floor.
    async fn keep_original(
        &self,
        id: &str,
        sha: &str,
        dem: &Path,
        work: &mut WorkFiles,
    ) -> Result<(), String> {
        if self.store.has_original(sha) {
            return Ok(());
        }
        self.check_room(fs::metadata(dem).map_or(0, |m| m.len()))?;
        let original_tmp = self.store.tmp_dir().join(format!("{id}.dem.zst"));
        work.add(&original_tmp);
        let (src, written, kept) = (
            dem.to_owned(),
            original_tmp.clone(),
            self.store.original_path(sha),
        );
        blocking(move || crate::originals::keep_original(&src, &written, &kept))
            .await?
            .map_err(|e| file_error("keep the demo", &original_tmp, &e))?;
        Ok(())
    }

    /// [`Runner::check_room`] for the pack of `dem`, which is smaller than its demo.
    fn room_for_pack(&self, dem: &Path) -> Result<(), String> {
        self.check_room(fs::metadata(dem).map_or(0, |m| m.len()))
    }

    /// Refuses a step that will write about `need` bytes when that could take the data volume
    /// below `Config::min_free_bytes`, the floor uploads keep ([`Store::has_room`]).
    fn check_room(&self, need: u64) -> Result<(), String> {
        if self.store.has_room(need) {
            Ok(())
        } else {
            Err(store::LOW_DISK.to_owned())
        }
    }

    fn set_status(&self, id: &str, status: Status) {
        self.store.update(id, |r| r.status = status);
    }

    fn fail(&self, id: &str, started: Instant, msg: String) {
        tracing::warn!(demo = %id, secs = started.elapsed().as_secs_f64(), error = %msg, "demo failed");
        self.store.update(id, |r| {
            r.status = Status::Error;
            r.error = Some(msg);
        });
    }
}

/// Gives the summary at `path` what `rec` knows and it lacks ([`MatchSummary::take_known`]),
/// writing it through `tmp`; returns the summary when it changed. A summary that now has a
/// FACEIT match id is a FACEIT match's, whatever its server's name made its mode, as a parse of
/// it would say ([`Runner::parse_and_pack`]): a demo uploaded first and fetched for its FACEIT
/// match later is under the FACEIT tab at once, not only after the next summary upgrade. A
/// missing summary (a pack parsed before summaries were written) stays missing.
pub(crate) fn fill_summary(
    path: &Path,
    tmp: &Path,
    rec: &store::DemoRecord,
) -> io::Result<Option<MatchSummary>> {
    let mut s: MatchSummary = match fs::read(path) {
        Ok(json) => serde_json::from_slice(&json)?,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    let before = s.clone();
    s.take_known(rec);
    if s.faceit_match_id.is_some() {
        s.mode = Some(GameMode::Faceit);
    }
    if s == before {
        return Ok(None);
    }
    store::write_file(tmp, path, &serde_json::to_vec(&s)?)?;
    Ok(Some(s))
}

/// Makes record `demo_id`, a done demo that names no FACEIT match (an upload says nothing of
/// which match it is), the demo of FACEIT match `faceit_match_id`, as the FACEIT poller found it
/// to be by its facts ([`crate::faceit_tracker`]'s attach pass). Its summary takes the id, and
/// with it the FACEIT mode, as an alias's does ([`fill_summary`]), on disk and in the match
/// index; then the record takes it, so the match's room link finds the demo
/// ([`Store::find_faceit`]). The summary goes first, as a parse's does: a summary that cannot be
/// written leaves both as they were, for the next pass to try again. An attach cut short after
/// the summary (the process stopped before the record was saved) is finished by the next: the
/// summary, the match's already, is left as it is, and the record takes the id. Returns whether
/// the record took the id: not when it is gone, not done, without a sha, or names a FACEIT match
/// already. Blocking.
pub fn attach_faceit(store: &Store, demo_id: &str, faceit_match_id: &str) -> io::Result<bool> {
    let Some(mut rec) = store
        .get(demo_id)
        .filter(|r| r.status == Status::Done && r.faceit_match_id.is_none())
    else {
        return Ok(false);
    };
    let Some(sha) = rec.sha256.clone() else {
        return Ok(false);
    };
    rec.faceit_match_id = Some(faceit_match_id.to_owned());
    let tmp = store.tmp_dir().join(format!("{demo_id}.faceit.json"));
    if let Some(summary) = fill_summary(&store.summary_path(&sha), &tmp, &rec)? {
        store.matches().insert(summary);
    }
    let mut took = false;
    store.update(demo_id, |r| {
        if r.faceit_match_id.is_none() {
            r.faceit_match_id = Some(faceit_match_id.to_owned());
            took = true;
        }
    });
    Ok(took)
}

/// Runs one step of a job in its own task, so a panic fails that job and not the runner.
async fn isolated<T: Send + 'static>(
    step: impl Future<Output = Result<T, String>> + Send + 'static,
) -> Result<T, String> {
    match tokio::spawn(step).await {
        Ok(outcome) => outcome,
        Err(e) if e.is_panic() => Err("internal error: the job panicked".to_owned()),
        Err(_) => Err("internal error: the job was cancelled".to_owned()),
    }
}

/// Leaves `src` alone and returns false when it already starts with the CS2 demo magic;
/// otherwise writes the demo inside it to `dest`, at most `room` bytes of it (see
/// [`ingest::decompress_to_dem_within`]), and returns true.
fn inflate_unless_raw(src: &Path, dest: &Path, room: u64) -> io::Result<bool> {
    if ingest::read_head(File::open(src)?, 8)? == b"PBDEMS2\0" {
        return Ok(false);
    }
    ingest::decompress_to_dem_within(src, dest, room)?;
    Ok(true)
}

/// Refuses a demo whose header says the file should be longer than it is.
///
/// A CS2 demo starts with its magic, then the offset of the `CDemoFileInfo` message the
/// recorder writes last, then the offset of the spawn groups (both 0 while still recording).
/// A file cut short by an interrupted download or copy still parses, to the rounds it holds,
/// so a partial replay would pass for the whole match; the header is the only sign of it.
fn check_not_truncated(dem: &Path) -> Result<(), String> {
    let reading = |e: io::Error| file_error("read the demo", dem, &e);
    let mut file = File::open(dem).map_err(reading)?;
    let len = file.metadata().map_err(reading)?.len();
    let head = ingest::read_head(&mut file, 16).map_err(reading)?;
    if head.len() < 16 {
        return Err("the demo is truncated inside its header".to_owned());
    }
    let file_info = u64::from(u32::from_le_bytes([head[8], head[9], head[10], head[11]]));
    if file_info != 0 && file_info >= len {
        let pct = (len * 100 / file_info).min(99);
        return Err(format!(
            "the demo is truncated: only {pct}% of the file is here (was the download or copy cut short?)"
        ));
    }
    Ok(())
}

/// A user-facing message for the file at `path` that could not be turned into a demo.
fn demo_error(path: &Path, e: &io::Error) -> String {
    match e.kind() {
        // decompress_to_dem_within's own messages: not a CS2 demo, a CS:GO demo, corrupt data.
        ErrorKind::InvalidData => e.to_string(),
        // Inflating reached the free-space floor.
        ErrorKind::StorageFull => store::LOW_DISK.to_owned(),
        _ => file_error("decompress the demo", path, e),
    }
}

/// What a job fails with when the server cannot read or write a file of its own: a fixed
/// message ([`store::LOW_DISK`] for a full disk), while the path and the OS error go to the
/// log, not to the demo's link (code-health review 2026-10-26).
fn file_error(what: &str, path: &Path, e: &io::Error) -> String {
    tracing::error!(path = %path.display(), error = %e, "cannot {what}");
    if e.kind() == ErrorKind::StorageFull {
        return store::LOW_DISK.to_owned();
    }
    format!("the server could not {what}; try again later")
}

fn too_long(limit: Duration) -> String {
    format!("the demo took too long to parse (more than {limit:?})")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn demo_with_file_info(len: usize, file_info: u32) -> tempfile::NamedTempFile {
        let mut bytes = b"PBDEMS2\0".to_vec();
        bytes.extend(file_info.to_le_bytes());
        bytes.resize(len, 0xAB);
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(&bytes).unwrap();
        f
    }

    #[test]
    fn truncation_is_read_from_the_file_info_offset() {
        // mirage.dem: 237,574,437 bytes, file info at 237,574,419 (18 bytes from the end).
        let whole = demo_with_file_info(1000, 982);
        assert_eq!(check_not_truncated(whole.path()), Ok(()));
        let recording = demo_with_file_info(1000, 0);
        assert_eq!(check_not_truncated(recording.path()), Ok(()));
        let cut = demo_with_file_info(1000, 4000);
        let err = check_not_truncated(cut.path()).unwrap_err();
        assert!(err.contains("truncated") && err.contains("25%"), "{err}");
        let at_end = demo_with_file_info(1000, 1000);
        assert!(check_not_truncated(at_end.path()).is_err());
        let header_only = demo_with_file_info(12, 0);
        assert!(check_not_truncated(header_only.path())
            .unwrap_err()
            .contains("header"));
    }
}
