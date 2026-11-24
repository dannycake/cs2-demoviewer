//! The job runner against a local HTTP server (let through the SSRF guard by the runner's
//! test hooks), with the parser replaced by a stub, or run as a child process: the real
//! server binary, or `fixtures/fake-worker.sh`.

mod common;

use std::collections::HashSet;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use axum::routing::get;
use axum::Router;
use demoviewer_server::config::Config;
use demoviewer_server::gcbot::{ResolveError, Resolved};
use demoviewer_server::jobs::{spawn_runner_with, Hooks, Job, MAX_DOWNLOADS, NO_ROUNDS};
use demoviewer_server::matches::{summarize, GameMode, MatchSummary};
use demoviewer_server::sharecode::{decode, ShareCode};
use demoviewer_server::store::{DemoRecord, Source, Status, Store};

use common::{fake_demo, sha_hex, tiny_match, wait_until_finished, FakeResolver};
use demoviewer_server::originals::restore_original;

/// A store in a fresh temp dir (kept alive by the returned guard).
fn store() -> (tempfile::TempDir, Arc<Config>, Arc<Store>) {
    store_with(|_| {})
}

/// [`store`] with the config adjusted by `f`.
fn store_with(f: impl FnOnce(&mut Config)) -> (tempfile::TempDir, Arc<Config>, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    };
    f(&mut cfg);
    let cfg = Arc::new(cfg);
    let store = Arc::new(Store::open(&cfg).unwrap());
    (dir, cfg, store)
}

/// The server binary, which parses demos as `demoviewer-server parse-worker <demo> <pack>`.
const SERVER: &str = env!("CARGO_BIN_EXE_demoviewer-server");

/// A stand-in parse worker whose behaviour byte 16 of the demo picks (see the script).
fn fake_worker() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake-worker.sh")
}

fn varint(mut v: u64) -> Vec<u8> {
    let mut out = Vec::new();
    while v >= 0x80 {
        out.push(v as u8 | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
    out
}

/// A demo whose one frame (a compressed `DemFileHeader`) claims `claim` bytes once
/// decompressed and is large enough, 1/32 of that, for the parser to believe it: parsing it
/// allocates `claim` bytes before decompression fails. With `claim` = `u32::MAX` and a 6-byte
/// frame it is the review's 26-byte demo, refused before allocating.
fn frame_claiming(claim: u64, frame_len: usize) -> Vec<u8> {
    let mut frame = varint(claim);
    frame.resize(frame_len.max(frame.len()), 0);
    let mut v = b"PBDEMS2\0".to_vec();
    v.extend([0u8; 8]);
    v.extend([0x41, 0x00]);
    v.extend(varint(frame.len() as u64));
    v.extend(frame);
    // The parser reads a frame only when a byte follows it.
    v.push(0);
    v
}

/// Writes `demo` where an assembled upload would be, creates its record (with the sha, as
/// `complete` does) and queues it.
fn enqueue_upload(
    jobs: &demoviewer_server::jobs::Jobs,
    cfg: &Config,
    store: &Store,
    demo: &[u8],
) -> String {
    enqueue_upload_from(jobs, cfg, store, demo, Source::Upload, |_| {})
}

/// [`enqueue_upload`] for a record from `source`, adjusted by `f` before the job is queued.
fn enqueue_upload_from(
    jobs: &demoviewer_server::jobs::Jobs,
    cfg: &Config,
    store: &Store,
    demo: &[u8],
    source: Source,
    f: impl FnOnce(&mut DemoRecord),
) -> String {
    let id = Store::new_id();
    store.create_from(&id, source);
    store.update(&id, |r| {
        r.sha256 = Some(sha_hex(demo));
        f(r);
    });
    let path: PathBuf = cfg.data_dir.join("tmp").join(format!("{id}.upload"));
    std::fs::write(&path, demo).unwrap();
    jobs.enqueue(Job::Upload {
        demo_id: id.clone(),
        dem_path: path,
        slot: None,
    });
    id
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

fn gz(data: &[u8]) -> Vec<u8> {
    use std::io::Write;
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// A share code for Valve's match `match_id`.
fn match_code(match_id: u64) -> ShareCode {
    ShareCode {
        match_id,
        outcome_id: 1,
        token: 1,
    }
}

/// The match summary the runner wrote for `sha`.
fn summary(cfg: &Config, sha: &str) -> MatchSummary {
    let path = cfg.data_dir.join("matches").join(format!("{sha}.json"));
    serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap()
}

#[tokio::test]
async fn url_job_downloads_decompresses_parses_and_packs() {
    let demo = fake_demo(300_000);
    let body = gz(&demo);
    let addr = serve(
        Router::new()
            .route("/x.dem.gz", get(move || async move { body }))
            .route("/html.dem", get(|| async { "<html>not a demo</html>" })),
    )
    .await;

    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    let hooks = Hooks {
        parse: Arc::new(|p: &Path| {
            assert_eq!(std::fs::read(p).unwrap()[..8], *b"PBDEMS2\0");
            Ok(tiny_match("de_ancient"))
        }),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    let ok = Store::new_id();
    store.create(&ok);
    jobs.enqueue(Job::Url {
        demo_id: ok.clone(),
        url: format!("http://replay183.valve.net:{}/x.dem.gz", addr.port())
            .parse()
            .unwrap(),
        slot: None,
    });
    let bad = Store::new_id();
    store.create(&bad);
    jobs.enqueue(Job::Url {
        demo_id: bad.clone(),
        url: format!("http://replay183.valve.net:{}/html.dem", addr.port())
            .parse()
            .unwrap(),
        slot: None,
    });
    let missing = Store::new_id();
    store.create(&missing);
    jobs.enqueue(Job::Url {
        demo_id: missing.clone(),
        url: format!("http://replay183.valve.net:{}/gone.dem", addr.port())
            .parse()
            .unwrap(),
        slot: None,
    });

    let r = wait_until_finished(&store, &ok).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(r.map.as_deref(), Some("de_ancient"));
    assert_eq!(
        r.sha256,
        Some(sha_hex(&demo)),
        "the sha is of the decompressed demo"
    );
    let pack = std::fs::File::open(store.pack_path(&sha_hex(&demo))).unwrap();
    assert_eq!(
        demoviewer_pack::read(&mut std::io::BufReader::new(pack)).unwrap(),
        tiny_match("de_ancient")
    );

    let r = wait_until_finished(&store, &bad).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error.as_deref().unwrap().contains("not a CS2 demo"),
        "{r:?}"
    );
    let r = wait_until_finished(&store, &missing).await;
    assert_eq!(r.status, Status::Error);
    assert!(r.error.as_deref().unwrap().contains("404"), "{r:?}");

    assert_eq!(
        files_in(&cfg.data_dir.join("tmp")),
        Vec::<String>::new(),
        "work files left behind"
    );
}

#[tokio::test]
async fn a_failing_parse_is_an_error_and_a_panicking_one_does_not_stop_the_runner() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    let hooks = Hooks {
        parse: Arc::new(|p: &Path| {
            let bytes = std::fs::read(p).unwrap();
            match bytes[16] {
                0 => Err(demoviewer_server::parse::ParseError(
                    "demo parser: broken".into(),
                )),
                1 => panic!("parser blew up"),
                _ => Ok(tiny_match("de_vertigo")),
            }
        }),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    let mut ids = Vec::new();
    for kind in [0u8, 1, 2] {
        let mut demo = fake_demo(1000);
        demo[16] = kind;
        let id = Store::new_id();
        store.create(&id);
        let path = cfg.data_dir.join("tmp").join(format!("{id}.upload"));
        std::fs::write(&path, &demo).unwrap();
        jobs.enqueue(Job::Upload {
            demo_id: id.clone(),
            dem_path: path,
            slot: None,
        });
        ids.push(id);
    }
    let r = wait_until_finished(&store, &ids[0]).await;
    assert_eq!(
        (r.status, r.error.as_deref()),
        (Status::Error, Some("demo parser: broken"))
    );
    let r = wait_until_finished(&store, &ids[1]).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error.as_deref().unwrap().contains("internal error"),
        "{r:?}"
    );
    let r = wait_until_finished(&store, &ids[2]).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

#[tokio::test]
async fn a_demo_cut_short_is_refused_before_parsing() {
    let (_dir, cfg, store) = store();
    let parses = Arc::new(AtomicUsize::new(0));
    let counter = parses.clone();
    let hooks = Hooks {
        parse: Arc::new(move |_: &Path| {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(tiny_match("de_dust2"))
        }),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    // The first half of a 2,000-byte demo: its header still points at byte 1,982.
    let cut = fake_demo(2000)[..1000].to_vec();
    let cut_id = enqueue_upload(&jobs, &cfg, &store, &cut);
    // A demo whose recording never finished has 0 there and is parsed.
    let mut recording = fake_demo(1000);
    recording[8..16].fill(0);
    let recording_id = enqueue_upload(&jobs, &cfg, &store, &recording);

    let r = wait_until_finished(&store, &cut_id).await;
    assert_eq!(r.status, Status::Error);
    let msg = r.error.unwrap();
    assert!(msg.contains("truncated") && msg.contains("50%"), "{msg}");
    let r = wait_until_finished(&store, &recording_id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(
        parses.load(Ordering::SeqCst),
        1,
        "the cut demo reached the parser"
    );
    assert!(!store.pack_path(&sha_hex(&cut)).exists());
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

#[tokio::test]
async fn a_match_with_no_rounds_is_an_error_and_writes_no_pack() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| {
            let mut m = tiny_match("de_nuke");
            m.header.rounds.clear();
            m.rounds.clear();
            Ok(m)
        }),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let demo = fake_demo(1000);
    let id = enqueue_upload(&jobs, &cfg, &store, &demo);
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(
        (r.status, r.error.as_deref(), r.rounds),
        (Status::Error, Some(NO_ROUNDS), None)
    );
    assert_eq!(files_in(&cfg.data_dir.join("packs")), Vec::<String>::new());
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

#[tokio::test]
async fn a_parse_over_the_time_limit_fails_and_the_worker_moves_on() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|p: &Path| {
            if std::fs::read(p).unwrap()[16] == 1 {
                std::thread::sleep(Duration::from_millis(1500));
            }
            Ok(tiny_match("de_train"))
        }),
        parse_timeout: Duration::from_millis(300),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let mut slow = fake_demo(1000);
    slow[16] = 1;
    let mut quick = fake_demo(1000);
    quick[16] = 2;
    let slow_id = enqueue_upload(&jobs, &cfg, &store, &slow);
    let quick_id = enqueue_upload(&jobs, &cfg, &store, &quick);

    let r = wait_until_finished(&store, &slow_id).await;
    assert_eq!(r.status, Status::Error);
    assert!(r.error.as_deref().unwrap().contains("too long"), "{r:?}");
    let r = wait_until_finished(&store, &quick_id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");

    // The abandoned parse finishes later and must not write a pack.
    tokio::time::sleep(Duration::from_millis(1800)).await;
    assert_eq!(
        files_in(&cfg.data_dir.join("packs")),
        vec![format!("{}.dvpk.gz", sha_hex(&quick))]
    );
    assert_eq!(store.get(&slow_id).unwrap().status, Status::Error);
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

#[tokio::test]
async fn stalled_downloads_hold_only_their_own_slots_never_uploads() {
    let addr =
        serve(Router::new().route("/stall.dem", get(std::future::pending::<&'static str>))).await;
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_overpass"))),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    let stalled: Vec<String> = (0..=MAX_DOWNLOADS)
        .map(|_| {
            let id = Store::new_id();
            store.create(&id);
            jobs.enqueue(Job::Url {
                demo_id: id.clone(),
                url: format!("http://replay183.valve.net:{}/stall.dem", addr.port())
                    .parse()
                    .unwrap(),
                slot: None,
            });
            id
        })
        .collect();
    let upload = enqueue_upload(&jobs, &cfg, &store, &fake_demo(1000));

    let r = wait_until_finished(&store, &upload).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let mut statuses: Vec<Status> = stalled
        .iter()
        .map(|id| store.get(id).unwrap().status)
        .collect();
    statuses.sort_by_key(|s| format!("{s:?}"));
    let mut expected = vec![Status::Downloading; MAX_DOWNLOADS];
    expected.push(Status::Queued);
    assert_eq!(statuses, expected, "every slot busy, one URL job waiting");
}

/// A URL job that cannot start its download within the wait limit fails saying the server was
/// too busy, instead of waiting without end behind stalled downloads (security audit
/// 2026-10-23); the downloads in progress go on.
#[tokio::test]
async fn a_download_that_cannot_start_in_time_fails() {
    let addr =
        serve(Router::new().route("/stall.dem", get(std::future::pending::<&'static str>))).await;
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        download_wait: Duration::from_millis(300),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let enqueue = || {
        let id = Store::new_id();
        store.create_from(&id, Source::Url);
        jobs.enqueue(Job::Url {
            demo_id: id.clone(),
            url: format!("http://replay183.valve.net:{}/stall.dem", addr.port())
                .parse()
                .unwrap(),
            slot: None,
        });
        id
    };
    let stalled: Vec<String> = (0..MAX_DOWNLOADS).map(|_| enqueue()).collect();
    let downloading = |id: &String| store.get(id).unwrap().status == Status::Downloading;
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !stalled.iter().all(downloading) {
        assert!(
            std::time::Instant::now() < deadline,
            "the downloads never started"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let late = enqueue();
    let r = wait_until_finished(&store, &late).await;
    assert_eq!(r.status, Status::Error, "{r:?}");
    let error = r.error.unwrap();
    assert!(error.contains("too busy"), "{error}");
    assert!(stalled.iter().all(downloading));
}

/// Below the free-space floor a job stops before it writes: a URL job before it downloads
/// (nothing is asked of the server), and any job before the parse writes its pack (security
/// audit 2026-10-23: URL and share-code jobs downloaded, inflated and packed regardless).
#[tokio::test]
async fn jobs_stop_before_writing_when_the_disk_is_nearly_full() {
    let asked = Arc::new(AtomicUsize::new(0));
    let counted = asked.clone();
    let body = gz(&fake_demo(300_000));
    let addr = serve(Router::new().route(
        "/x.dem.gz",
        get(move || {
            counted.fetch_add(1, Ordering::SeqCst);
            let body = body.clone();
            async move { body }
        }),
    ))
    .await;
    let (_dir, cfg, store) = store_with(|c| c.min_free_bytes = u64::MAX / 4);
    let parsed = Arc::new(AtomicUsize::new(0));
    let parses = parsed.clone();
    let hooks = Hooks {
        parse: Arc::new(move |_: &Path| {
            parses.fetch_add(1, Ordering::SeqCst);
            Ok(tiny_match("de_vertigo"))
        }),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let url = Store::new_id();
    store.create_from(&url, Source::Url);
    jobs.enqueue(Job::Url {
        demo_id: url.clone(),
        url: format!("http://replay183.valve.net:{}/x.dem.gz", addr.port())
            .parse()
            .unwrap(),
        slot: None,
    });
    let upload = enqueue_upload(&jobs, &cfg, &store, &fake_demo(1000));
    for id in [&url, &upload] {
        let r = wait_until_finished(&store, id).await;
        assert_eq!(
            (r.status, r.error.as_deref()),
            (
                Status::Error,
                Some("the server is low on disk space; try again later")
            ),
            "{r:?}"
        );
    }
    assert_eq!(asked.load(Ordering::SeqCst), 0, "the URL was downloaded");
    assert_eq!(parsed.load(Ordering::SeqCst), 0, "a demo was parsed");
    assert_eq!(files_in(&cfg.data_dir.join("packs")), Vec::<String>::new());
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A demo that inflates many times over (within the ratio cap) on a disk with little room above
/// its floor is stopped when it reaches the floor, not after: the inflated file never grows past
/// the room, and the job fails with the low-disk copy; a demo that fits is parsed as usual
/// (review of the 2026-10-23 audit fix: twice the compressed size was reserved).
#[tokio::test]
async fn inflating_stops_at_the_free_space_floor() {
    const ROOM: u64 = 2 << 20;
    // 1 KiB blocks of 64 random bytes and 960 zeros: about 13 times smaller under gzip, so twice
    // the compressed file fits in the room and the inflated demo is four times the room.
    let mut demo = fake_demo(8 << 20);
    let random = common::payload(demo.len() / 16);
    for (block, random) in demo[16..].chunks_mut(1024).zip(random.chunks(64)) {
        let k = block.len().min(64);
        block[..k].copy_from_slice(&random[..k]);
        block[k..].fill(0);
    }
    let bomb = gz(&demo);
    assert!(2 * bomb.len() as u64 <= ROOM, "{}", bomb.len());
    assert!(demo.len() as u64 <= bomb.len() as u64 * 20);

    let (_dir, cfg, store) = store();
    let floor = cfg.min_free_bytes;
    let parsed = Arc::new(AtomicUsize::new(0));
    let parses = parsed.clone();
    let hooks = Hooks {
        parse: Arc::new(move |_: &Path| {
            parses.fetch_add(1, Ordering::SeqCst);
            Ok(tiny_match("de_train"))
        }),
        free_space: Some(Arc::new(move || floor + ROOM)),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    // The largest inflated demo in tmp/ while the job runs.
    let tmp = cfg.data_dir.join("tmp");
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let watcher = std::thread::spawn({
        let (tmp, done) = (tmp.clone(), done.clone());
        move || {
            let mut largest = 0;
            while !done.load(Ordering::SeqCst) {
                for e in std::fs::read_dir(&tmp).into_iter().flatten().flatten() {
                    if e.file_name().to_string_lossy().ends_with(".dem") {
                        largest = largest.max(e.metadata().map_or(0, |m| m.len()));
                    }
                }
                std::thread::sleep(Duration::from_millis(1));
            }
            largest
        }
    });
    let id = Store::new_id();
    store.create(&id);
    let path = tmp.join(format!("{id}.upload"));
    std::fs::write(&path, &bomb).unwrap();
    jobs.enqueue(Job::Upload {
        demo_id: id.clone(),
        dem_path: path,
        slot: None,
    });
    let r = wait_until_finished(&store, &id).await;
    done.store(true, Ordering::SeqCst);
    let largest = watcher.join().unwrap();
    assert_eq!(
        (r.status, r.error.as_deref()),
        (
            Status::Error,
            Some("the server is low on disk space; try again later")
        ),
        "{r:?}"
    );
    assert!(
        largest <= ROOM,
        "{largest} bytes were inflated into {ROOM} of room"
    );
    assert_eq!(parsed.load(Ordering::SeqCst), 0);
    assert_eq!(files_in(&tmp), Vec::<String>::new());

    // A demo that fits in the room goes through.
    let small = enqueue_upload(&jobs, &cfg, &store, &gz(&fake_demo(300_000)));
    let r = wait_until_finished(&store, &small).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
}

/// Production parses in a child process of the server binary: the parser's errors come back
/// as the job's, and nothing is left behind.
#[tokio::test]
async fn a_parse_child_reports_the_parsers_errors() {
    let (_dir, cfg, store) = store_with(|c| c.parse_worker = Some(SERVER.into()));
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), Hooks::default());
    let bomb = frame_claiming(u64::from(u32::MAX), 6);
    assert_eq!(bomb.len(), 26);
    let bomb = enqueue_upload(&jobs, &cfg, &store, &bomb);
    let junk = enqueue_upload(&jobs, &cfg, &store, &fake_demo(4000));

    let r = wait_until_finished(&store, &bomb).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error
            .as_deref()
            .unwrap()
            .contains("claims 4294967295 bytes"),
        "{r:?}"
    );
    let r = wait_until_finished(&store, &junk).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error.as_deref().unwrap().starts_with("demo parser"),
        "{r:?}"
    );
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
    assert_eq!(files_in(&cfg.data_dir.join("packs")), Vec::<String>::new());
}

/// A parse that wants more memory than its limit kills its child, not the server, and the
/// worker goes on to the next demo.
#[tokio::test]
async fn a_parse_child_over_its_memory_limit_dies_alone() {
    let (_dir, cfg, store) = store_with(|c| {
        c.parse_worker = Some(SERVER.into());
        c.parse_memory_bytes = 32 << 20;
    });
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), Hooks::default());
    let greedy = frame_claiming(60 << 20, (60 << 20) / 32);
    let greedy = enqueue_upload(&jobs, &cfg, &store, &greedy);
    let next = frame_claiming(u64::from(u32::MAX), 6);
    let next = enqueue_upload(&jobs, &cfg, &store, &next);

    let r = wait_until_finished(&store, &greedy).await;
    assert_eq!(r.status, Status::Error);
    let msg = r.error.as_deref().unwrap();
    assert!(msg.contains("crashed") && msg.contains("32 MiB"), "{msg}");
    let r = wait_until_finished(&store, &next).await;
    assert_eq!(r.status, Status::Error);
    assert!(r.error.as_deref().unwrap().contains("claims"), "{r:?}");
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// The parent's side of the child protocol, with a scripted worker: the outcome line (after
/// any other output) names the map and rounds of the pack it wrote, a `failed` outcome is the
/// job's error, and a crash or a missing outcome is an error too. An outcome line of 200 kB
/// (a summary with a long server name) is read whole.
#[tokio::test]
async fn a_parse_childs_outcome_decides_the_job() {
    let (_dir, cfg, store) = store_with(|c| c.parse_worker = Some(fake_worker()));
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), Hooks::default());
    let demo = |mode: u8| {
        let mut d = fake_demo(1000);
        d[16] = mode;
        d
    };
    let packed = demo(1);
    let long = demo(5);
    let ids: Vec<String> = [&packed, &demo(2), &demo(3), &demo(0), &long]
        .into_iter()
        .map(|d| enqueue_upload(&jobs, &cfg, &store, d))
        .collect();

    let r = wait_until_finished(&store, &ids[0]).await;
    assert_eq!(
        (r.status, r.map.as_deref(), r.rounds),
        (Status::Done, Some("de_script"), Some(3)),
        "{r:?}"
    );
    let pack = cfg
        .data_dir
        .join("packs")
        .join(format!("{}.dvpk.gz", sha_hex(&packed)));
    assert_eq!(std::fs::read(pack).unwrap(), b"pack bytes");
    let s = summary(&cfg, &sha_hex(&packed));
    assert_eq!(
        (s.map.as_str(), s.rounds, s.score_t, s.score_ct),
        ("de_script", 3, 2, 1)
    );
    assert_eq!(s.sha256, sha_hex(&packed));

    let r = wait_until_finished(&store, &ids[1]).await;
    assert_eq!(
        (r.status, r.error.as_deref()),
        (Status::Error, Some("scripted failure"))
    );
    let r = wait_until_finished(&store, &ids[2]).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error.as_deref().unwrap().contains("exit status 3"),
        "{r:?}"
    );
    let r = wait_until_finished(&store, &ids[3]).await;
    assert_eq!(r.status, Status::Error);
    assert!(
        r.error.as_deref().unwrap().contains("without a result"),
        "{r:?}"
    );
    let r = wait_until_finished(&store, &ids[4]).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(summary(&cfg, &sha_hex(&long)).server_name.len(), 200_000);
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A parse child still running at the time limit is killed, not left running.
#[tokio::test]
async fn a_parse_child_past_the_time_limit_is_killed() {
    let (_dir, cfg, store) = store_with(|c| c.parse_worker = Some(fake_worker()));
    let hooks = Hooks {
        parse_timeout: Duration::from_millis(500),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let mut slow = fake_demo(1000);
    slow[16] = 4;
    let id = enqueue_upload(&jobs, &cfg, &store, &slow);

    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Error);
    assert!(r.error.as_deref().unwrap().contains("too long"), "{r:?}");
    let pid = std::fs::read_to_string(cfg.data_dir.join("slow-worker.pid")).unwrap();
    let stat = format!("/proc/{}/stat", pid.trim());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        // Gone, or a zombie waiting to be reaped: either way, no longer running.
        match std::fs::read_to_string(&stat) {
            Err(_) => break,
            Ok(s) if s.rsplit(')').next().unwrap().trim_start().starts_with('Z') => break,
            Ok(s) => assert!(
                std::time::Instant::now() < deadline,
                "the worker is still running: {s}"
            ),
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A job that cannot write a file of its own fails with a fixed message; the path and the OS
/// error go to the log, not to the demo's link (code-health review 2026-10-26: it read
/// "writing the replay pack: Permission denied (os error 13)"). Its work files still go. A
/// directory where the pack goes makes its rename into place fail, as root too, which a
/// read-only `packs/` would not.
#[tokio::test]
async fn a_job_that_cannot_store_its_pack_names_no_os_error() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_anubis"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let demo = fake_demo(1000);
    std::fs::create_dir(store.pack_path(&sha_hex(&demo))).unwrap();
    let id = enqueue_upload(&jobs, &cfg, &store, &demo);
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Error);
    assert_eq!(
        r.error.as_deref(),
        Some("the server could not store the replay; try again later")
    );
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A parsed demo leaves its pack and its match summary, which the runner completes with what
/// the parse cannot know (the sha, when the demo was stored), and no work files. A second file
/// of the same demo is aliased and leaves the summary alone.
#[tokio::test]
async fn a_done_job_writes_the_match_summary_beside_the_pack() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_anubis"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let demo = fake_demo(1000);
    let sha = sha_hex(&demo);
    let id = enqueue_upload(&jobs, &cfg, &store, &demo);
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(r.source, Source::Upload);

    let path = cfg.data_dir.join("matches").join(format!("{sha}.json"));
    assert_eq!(store.summary_path(&sha), path);
    let s = summary(&cfg, &sha);
    assert_eq!(
        (
            s.sha256.as_str(),
            s.map.as_str(),
            s.rounds,
            s.score_t,
            s.score_ct
        ),
        (sha.as_str(), "de_anubis", 1, 1, 0)
    );
    assert_eq!(s.created_unix, r.created_unix);
    assert_eq!(
        store.matches().get(&sha).as_deref(),
        Some(&s),
        "the index has what the file has"
    );
    assert_eq!((s.played_unix, s.match_id), (None, None));

    let written = std::fs::metadata(&path).unwrap().modified().unwrap();
    let again = enqueue_upload(&jobs, &cfg, &store, &demo);
    assert_eq!(
        wait_until_finished(&store, &again).await.status,
        Status::Done
    );
    assert_eq!(
        std::fs::metadata(&path).unwrap().modified().unwrap(),
        written
    );
    assert_eq!(
        files_in(&cfg.data_dir.join("matches")),
        vec![format!("{sha}.json")]
    );
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// What the record knows and the parse cannot, Valve's match id, when the match was played and
/// the GC's game type (a share code's), goes into the summary. An alias gives a summary those it
/// lacks, so the page of a demo uploaded first and posted as a share code later still says when
/// it was played; one the summary has already is kept. The match index follows the files.
#[tokio::test]
async fn a_summary_takes_the_match_id_and_played_time_from_the_record() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_nuke"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let shared = |demo: &[u8], match_id: &str, played: u64| {
        let id = enqueue_upload_from(&jobs, &cfg, &store, demo, Source::Sharecode, |r| {
            r.match_id = Some(match_id.to_owned());
            r.played_unix = Some(played);
            r.gc_game_type = Some(8);
        });
        let store = store.clone();
        async move { wait_until_finished(&store, &id).await }
    };
    let ids = |s: &MatchSummary| (s.match_id.clone(), s.played_unix);
    let known = |match_id: &str, played: u64| (Some(match_id.to_owned()), Some(played));

    let demo = fake_demo(1000);
    let r = shared(&demo, "3712345678901234567", 1_760_000_000).await;
    assert_eq!(
        (r.status, r.source),
        (Status::Done, Source::Sharecode),
        "{r:?}"
    );
    let s = summary(&cfg, &sha_hex(&demo));
    assert_eq!(ids(&s), known("3712345678901234567", 1_760_000_000));

    let mut uploaded = fake_demo(1000);
    uploaded[16] ^= 1;
    let sha = sha_hex(&uploaded);
    let first = enqueue_upload(&jobs, &cfg, &store, &uploaded);
    let first = wait_until_finished(&store, &first).await;
    assert_eq!(first.status, Status::Done);
    assert_eq!(ids(&summary(&cfg, &sha)), (None, None));
    let r = shared(&uploaded, "3712345678901234568", 1_760_000_100).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let s = summary(&cfg, &sha);
    assert_eq!(ids(&s), known("3712345678901234568", 1_760_000_100));
    assert_eq!(s.gc_game_type, Some(8));
    assert_eq!(store.matches().get(&sha).as_deref(), Some(&s));
    assert_eq!(s.created_unix, first.created_unix);
    assert_eq!(s.map, "de_nuke");

    let r = shared(&uploaded, "1", 1).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(
        ids(&summary(&cfg, &sha)),
        known("3712345678901234568", 1_760_000_100)
    );
    assert_eq!(
        files_in(&cfg.data_dir.join("matches")).len(),
        2,
        "one summary per pack"
    );
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A FACEIT match's record gives its summary the FACEIT match id (`faceitMatchId`), and makes
/// the match FACEIT's though its server's name does not say so. An alias gives the id to the
/// summary of the same demo uploaded first, which lacked it, and with it the FACEIT mode, so
/// the match is under the FACEIT tab at once rather than at the next summary upgrade.
#[tokio::test]
async fn an_alias_carries_the_faceit_id_into_its_summary() {
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_inferno"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let faceit = |demo: &[u8], match_id: &str| {
        let match_id = match_id.to_owned();
        let id = enqueue_upload_from(&jobs, &cfg, &store, demo, Source::Faceit, |r| {
            r.faceit_match_id = Some(match_id);
        });
        let store = store.clone();
        async move { wait_until_finished(&store, &id).await }
    };

    let fetched = fake_demo(1000);
    let r = faceit(&fetched, "1-aaaa").await;
    assert_eq!(
        (r.status, r.source),
        (Status::Done, Source::Faceit),
        "{r:?}"
    );
    let s = summary(&cfg, &sha_hex(&fetched));
    assert_eq!(s.faceit_match_id.as_deref(), Some("1-aaaa"));
    assert_eq!(
        (s.server_name.as_str(), s.mode),
        ("test", Some(GameMode::Faceit))
    );
    assert!(
        store.has_original(&sha_hex(&fetched)),
        "kept before the parse"
    );

    let mut uploaded = fake_demo(1000);
    uploaded[16] ^= 1;
    let sha = sha_hex(&uploaded);
    let first = enqueue_upload(&jobs, &cfg, &store, &uploaded);
    assert_eq!(
        wait_until_finished(&store, &first).await.status,
        Status::Done
    );
    let s = summary(&cfg, &sha);
    assert_eq!((s.faceit_match_id, s.mode), (None, Some(GameMode::Other)));
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.summary_path(&sha)).unwrap()).unwrap();
    assert!(json.get("faceitMatchId").is_none(), "no id, no key: {json}");
    let r = faceit(&uploaded, "1-bbbb").await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let s = summary(&cfg, &sha);
    assert_eq!(s.faceit_match_id.as_deref(), Some("1-bbbb"));
    assert_eq!(s.mode, Some(GameMode::Faceit));
    assert_eq!(store.matches().get(&sha).as_deref(), Some(&s));
    let json: serde_json::Value =
        serde_json::from_slice(&std::fs::read(store.summary_path(&sha)).unwrap()).unwrap();
    assert_eq!(json["faceitMatchId"], "1-bbbb");
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// Packs are kept forever unless a cache limit is set (`DEMOVIEWER_CACHE_BYTES`): an old
/// 21 GiB pack (a sparse file) survives new packs by default, and goes first under a limit.
#[tokio::test]
async fn packs_are_kept_forever_unless_a_cache_limit_is_set() {
    assert_eq!(Config::default().cache_bytes, None);
    for limit in [None, Some(1 << 30)] {
        let (_dir, cfg, store) = store_with(|c| c.cache_bytes = limit);
        let old_sha = "ab".repeat(32);
        let big = store.pack_path(&old_sha);
        let file = std::fs::File::create(&big).unwrap();
        file.set_len(21 << 30).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(86_400))
            .unwrap();
        let old = Store::new_id();
        store.create(&old);
        store.update(&old, |r| {
            r.status = Status::Done;
            r.sha256 = Some(old_sha.clone());
        });

        let hooks = Hooks {
            parse: Arc::new(|_: &Path| Ok(tiny_match("de_dust2"))),
            ..Hooks::default()
        };
        let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
        // The worker takes one file at a time, so once the second is done the first one's
        // eviction step has run.
        let mut second = fake_demo(1000);
        second[16] ^= 1;
        enqueue_upload(&jobs, &cfg, &store, &fake_demo(1000));
        let last = enqueue_upload(&jobs, &cfg, &store, &second);
        assert_eq!(
            wait_until_finished(&store, &last).await.status,
            Status::Done
        );

        let kept = store.get(&old).unwrap();
        if limit.is_none() {
            assert!(big.is_file(), "the old pack was evicted");
            assert_eq!(kept.status, Status::Done);
        } else {
            assert!(!big.exists(), "the old pack was kept over the limit");
            assert_eq!(kept.status, Status::Error);
        }
        assert_eq!(files_in(&cfg.data_dir.join("matches")).len(), 2);
    }
}

/// akiver/csgo-sharecode's README vector: match 3230642215713767580, reservation (outcome) id
/// 3230647599455273103, token 55788.
const CODE: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

/// The GC's whole match info, which gcbot hands over with the replay URL, is kept beside the
/// match as `gc/<match id>.json`, and its game type goes on the record and into the summary.
#[tokio::test]
async fn a_share_code_job_stores_the_gc_info_beside_the_match() {
    const MATCH: u64 = 3230642215713767580;
    let demo = fake_demo(300_000);
    let body = gz(&demo);
    let addr = serve(Router::new().route(
        "/730/003230647599455273103_0000055788.dem.bz2",
        get(move || async move { body }),
    ))
    .await;
    let url: url::Url = format!(
        "http://replay183.valve.net:{}/730/003230647599455273103_0000055788.dem.bz2",
        addr.port()
    )
    .parse()
    .unwrap();
    let info = serde_json::json!({
        "matchid": MATCH.to_string(),
        "roundstatsall": [{"reservation": {"game_type": 8, "account_ids": [39734273]}}],
    });
    let answer = info.clone();
    let fake = FakeResolver::answering(move |_| {
        Ok(Resolved {
            match_id: MATCH,
            url: url.clone(),
            played_unix: None,
            info: Some(answer.clone()),
        })
    });
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_inferno"))),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        resolver: Some(fake),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let (rec, _) = store.claim_match(&decode(CODE).unwrap(), &Store::new_id());
    jobs.enqueue(Job::ShareCode {
        demo_id: rec.id.clone(),
        code: decode(CODE).unwrap(),
        slot: None,
    });
    let r = wait_until_finished(&store, &rec.id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    assert_eq!(r.gc_game_type, Some(8));
    let kept: serde_json::Value = serde_json::from_slice(
        &std::fs::read(cfg.data_dir.join(format!("gc/{MATCH}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(kept, info);
    let summary = store.matches().get(r.sha256.as_deref().unwrap()).unwrap();
    assert_eq!(summary.gc_game_type, Some(8));
}

/// A share code: `resolving` while gcbot is asked, then its replay URL goes the way of a URL
/// job, and the record (with its share code) and the match summary keep Valve's match id and
/// when the match was played. The replay host is served by a local server
/// (the runner's test hooks resolve it).
#[tokio::test]
async fn a_share_code_is_looked_up_then_ingested_from_its_replay_url() {
    const MATCH: u64 = 3230642215713767580;
    const PLAYED: u64 = 1_761_163_200;
    let demo = fake_demo(300_000);
    let body = gz(&demo);
    let addr = serve(Router::new().route(
        "/730/003230647599455273103_0000055788.dem.bz2",
        get(move || async move { body }),
    ))
    .await;
    let url: url::Url = format!(
        "http://replay183.valve.net:{}/730/003230647599455273103_0000055788.dem.bz2",
        addr.port()
    )
    .parse()
    .unwrap();
    let fake = FakeResolver::held(move |code| {
        assert_eq!(code, CODE);
        Ok(Resolved {
            match_id: MATCH,
            url: url.clone(),
            played_unix: Some(PLAYED),
            info: None,
        })
    });
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_inferno"))),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        resolver: Some(fake.clone()),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);

    let (rec, created) = store.claim_match(&decode(CODE).unwrap(), &Store::new_id());
    assert!(created);
    jobs.enqueue(Job::ShareCode {
        demo_id: rec.id.clone(),
        code: decode(CODE).unwrap(),
        slot: None,
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while fake.calls() == 0 {
        assert!(std::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(store.get(&rec.id).unwrap().status, Status::Resolving);
    fake.release();

    let r = wait_until_finished(&store, &rec.id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let ours = MATCH.to_string();
    assert_eq!(
        (
            r.source,
            r.match_id.as_deref(),
            r.sharecode.as_deref(),
            r.played_unix,
            r.map.as_deref()
        ),
        (
            Source::Sharecode,
            Some(ours.as_str()),
            Some(CODE),
            Some(PLAYED),
            Some("de_inferno")
        )
    );
    let sha = sha_hex(&demo);
    assert_eq!(r.sha256.as_deref(), Some(sha.as_str()));
    let s = summary(&cfg, &sha);
    assert_eq!(
        (s.match_id.as_deref(), s.played_unix),
        (Some(ours.as_str()), Some(PLAYED))
    );
    // The same code now finds this demo.
    let (again, created) = store.claim_match(&decode(CODE).unwrap(), &Store::new_id());
    assert_eq!((again.id, created), (rec.id, false));
    assert_eq!(fake.calls(), 1);
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A match ingested from its Valve replay URL does not answer for its share code, though the
/// URL's first number is the code's outcome id: that number alone is not the whole code, so a
/// code's post looks the match up and joins the pack by sha (security review 2026-10-22).
#[tokio::test]
async fn a_replay_url_ingest_does_not_answer_for_a_share_code() {
    const PATH: &str = "/730/003230647599455273103_0000055788.dem.bz2";
    let demo = fake_demo(300_000);
    let body = gz(&demo);
    let addr = serve(Router::new().route(PATH, get(move || async move { body }))).await;
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_anubis"))),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let replay = Store::new_id();
    store.create_from(&replay, Source::Url);
    jobs.enqueue(Job::Url {
        demo_id: replay.clone(),
        url: format!("http://replay183.valve.net:{}{PATH}", addr.port())
            .parse()
            .unwrap(),
        slot: None,
    });
    let r = wait_until_finished(&store, &replay).await;
    assert_eq!(
        (r.status, r.sharecode.as_deref()),
        (Status::Done, None),
        "{r:?}"
    );
    assert_eq!(store.find_match(&decode(CODE).unwrap()), None);
}

/// A failed lookup fails its job with the copy that says why, and lets go of nothing it never
/// had.
#[tokio::test]
async fn a_failed_lookup_fails_the_job() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::Timeout));
    let (_dir, cfg, store) = store();
    let hooks = Hooks {
        resolver: Some(fake.clone()),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let (rec, _) = store.claim_match(&match_code(5), &Store::new_id());
    jobs.enqueue(Job::ShareCode {
        demo_id: rec.id.clone(),
        code: match_code(5),
        slot: None,
    });
    let r = wait_until_finished(&store, &rec.id).await;
    assert_eq!(
        (r.status, r.error),
        (Status::Error, Some(ResolveError::Timeout.to_string()))
    );
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());

    // A runner with no share-code service fails a share-code job (the API never queues one).
    let (_dir, cfg, plain) = store_with(|_| {});
    let jobs = spawn_runner_with(plain.clone(), cfg.clone(), Hooks::default());
    let (rec, _) = plain.claim_match(&match_code(5), &Store::new_id());
    jobs.enqueue(Job::ShareCode {
        demo_id: rec.id.clone(),
        code: match_code(5),
        slot: None,
    });
    let r = wait_until_finished(&plain, &rec.id).await;
    assert_eq!(r.status, Status::Error);
}

/// One record per share code: of many claims at once only one creates its record, and a record
/// in error does not hold the code. A done upload whose summary has the match id (a share code
/// completed it) does not answer for the code; the code's own record does, while its pack is
/// there.
#[test]
fn a_match_is_claimed_once() {
    let (_dir, _cfg, store) = store();
    let (a, created) = store.claim_match(&match_code(7), &Store::new_id());
    assert!(created);
    assert_eq!(
        (a.status, a.source, a.match_id.as_deref()),
        (Status::Resolving, Source::Sharecode, Some("7"))
    );
    let loser = Store::new_id();
    let (b, created) = store.claim_match(&match_code(7), &loser);
    assert_eq!((b.id.as_str(), created), (a.id.as_str(), false));
    assert_eq!(store.get(&loser), None);

    store.update(&a.id, |r| r.status = Status::Error);
    let (c, created) = store.claim_match(&match_code(7), &Store::new_id());
    assert!(created && c.id != a.id);

    let claims: Vec<(String, bool)> = std::thread::scope(|scope| {
        let threads: Vec<_> = (0..16)
            .map(|_| {
                let store = &store;
                scope.spawn(move || {
                    let (r, created) = store.claim_match(&match_code(8), &Store::new_id());
                    (r.id, created)
                })
            })
            .collect();
        threads.into_iter().map(|t| t.join().unwrap()).collect()
    });
    let ids: HashSet<&String> = claims.iter().map(|(id, _)| id).collect();
    assert_eq!(ids.len(), 1, "{claims:?}");
    assert_eq!(claims.iter().filter(|(_, created)| *created).count(), 1);
    assert_eq!(
        store.find_match(&match_code(8)).map(|r| r.id),
        Some(claims[0].0.clone())
    );
    assert_eq!(store.find_match(&match_code(9)), None);

    let upload = Store::new_id();
    let sha = "ab".repeat(32);
    store.create(&upload);
    store.update(&upload, |r| {
        r.status = Status::Done;
        r.sha256 = Some(sha.clone());
    });
    std::fs::write(store.pack_path(&sha), b"pack").unwrap();
    store.matches().insert(MatchSummary {
        sha256: sha.clone(),
        match_id: Some("9".into()),
        ..summarize(&tiny_match("de_nuke"), false)
    });
    let (d, created) = store.claim_match(&match_code(9), &Store::new_id());
    assert!(created && d.id != upload);
    store.update(&d.id, |r| {
        r.status = Status::Done;
        r.sha256 = Some(sha.clone());
    });
    assert_eq!(
        store.find_match(&match_code(9)).map(|r| r.id),
        Some(d.id.clone())
    );
    std::fs::remove_file(store.pack_path(&sha)).unwrap();
    let (_, created) = store.claim_match(&match_code(9), &Store::new_id());
    assert!(
        created,
        "a done record without its pack answered for the match"
    );
}

/// A runner whose parse answers `tiny_match`, except for a demo whose byte 16 is 0.
fn originals_runner() -> (
    tempfile::TempDir,
    Arc<Config>,
    Arc<Store>,
    demoviewer_server::jobs::Jobs,
) {
    let (dir, cfg, store) = store();
    let hooks = Hooks {
        parse: Arc::new(|p: &Path| {
            if std::fs::read(p).unwrap()[16] == 0 {
                Err(demoviewer_server::parse::ParseError(
                    "demo parser: broken".into(),
                ))
            } else {
                Ok(tiny_match("de_vertigo"))
            }
        }),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    (dir, cfg, store, jobs)
}

#[tokio::test]
async fn a_parsed_upload_keeps_its_original_compressed() {
    let (_dir, cfg, store, jobs) = originals_runner();
    let mut demo = fake_demo(200_000);
    demo[16] = 1;
    let id = enqueue_upload(&jobs, &cfg, &store, &demo);
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let sha = sha_hex(&demo);
    assert!(store.has_original(&sha));
    let back = cfg.data_dir.join("restored.dem");
    restore_original(&store.original_path(&sha), &back, u64::MAX).unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), demo);
    assert_eq!(files_in(&cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// A demo Valve served (a replay link, a share code, a tracked match) is a real match: when the
/// parser fails on it, its original is kept for a re-parse by a fixed parser.
#[tokio::test]
async fn a_valve_demo_that_fails_to_parse_still_keeps_its_original() {
    let (_dir, cfg, store, jobs) = originals_runner();
    let mut demo = fake_demo(5_000);
    demo[16] = 0;
    let id = enqueue_upload_from(&jobs, &cfg, &store, &demo, Source::Url, |_| {});
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Error, "{r:?}");
    assert!(store.has_original(&sha_hex(&demo)));
}

/// An upload is anyone's bytes: one the parser fails on keeps no original, so junk shaped
/// like a demo cannot fill `originals/` (security review of 3f14b4f).
#[tokio::test]
async fn an_upload_that_fails_to_parse_keeps_no_original() {
    let (_dir, cfg, store, jobs) = originals_runner();
    let mut demo = fake_demo(5_000);
    demo[16] = 0;
    let id = enqueue_upload(&jobs, &cfg, &store, &demo);
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(r.status, Status::Error, "{r:?}");
    assert!(!store.has_original(&sha_hex(&demo)));
    assert_eq!(
        files_in(&cfg.data_dir.join("originals")),
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn an_alias_writes_no_second_original() {
    let (_dir, cfg, store, jobs) = originals_runner();
    let mut demo = fake_demo(5_000);
    demo[16] = 1;
    let first = enqueue_upload(&jobs, &cfg, &store, &demo);
    assert_eq!(
        wait_until_finished(&store, &first).await.status,
        Status::Done
    );
    let kept = store.original_path(&sha_hex(&demo));
    let when = std::fs::metadata(&kept).unwrap().modified().unwrap();
    let second = enqueue_upload(&jobs, &cfg, &store, &demo);
    assert_eq!(
        wait_until_finished(&store, &second).await.status,
        Status::Done
    );
    assert_eq!(files_in(&cfg.data_dir.join("originals")).len(), 1);
    assert_eq!(std::fs::metadata(&kept).unwrap().modified().unwrap(), when);
}

/// A match packed before originals were kept (a share code or a replay link of last month) has
/// none; an upload of the same demo is aliased to it and gives it one, so it can be parsed
/// again for what the old parse did not read.
#[tokio::test]
async fn an_upload_of_a_match_packed_without_an_original_gives_it_one() {
    let (_dir, cfg, store, jobs) = originals_runner();
    let mut demo = fake_demo(5_000);
    demo[16] = 1;
    let first = enqueue_upload_from(&jobs, &cfg, &store, &demo, Source::Url, |_| {});
    assert_eq!(
        wait_until_finished(&store, &first).await.status,
        Status::Done
    );
    let sha = sha_hex(&demo);
    // As if packed before originals were kept.
    std::fs::remove_file(store.original_path(&sha)).unwrap();
    let second = enqueue_upload(&jobs, &cfg, &store, &demo);
    assert_eq!(
        wait_until_finished(&store, &second).await.status,
        Status::Done
    );
    // Kept just after the alias is done (best effort: a failure costs only a re-parse), so it
    // may come a moment after the record says so.
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !store.has_original(&sha) {
        assert!(
            std::time::Instant::now() < deadline,
            "the original was never kept"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let back = cfg.data_dir.join("restored.dem");
    restore_original(&store.original_path(&sha), &back, u64::MAX).unwrap();
    assert_eq!(std::fs::read(&back).unwrap(), demo);
}

#[tokio::test]
async fn no_original_is_written_below_the_free_space_floor() {
    let (_dir, cfg, store) = store_with(|c| c.min_free_bytes = u64::MAX / 4);
    let jobs = spawn_runner_with(
        store.clone(),
        cfg.clone(),
        Hooks {
            parse: Arc::new(|_: &Path| Ok(tiny_match("de_vertigo"))),
            ..Hooks::default()
        },
    );
    let id = enqueue_upload(&jobs, &cfg, &store, &fake_demo(5_000));
    let r = wait_until_finished(&store, &id).await;
    assert_eq!(
        (r.status, r.error.as_deref()),
        (Status::Error, Some(demoviewer_server::store::LOW_DISK))
    );
    assert_eq!(
        files_in(&cfg.data_dir.join("originals")),
        Vec::<String>::new()
    );
}
