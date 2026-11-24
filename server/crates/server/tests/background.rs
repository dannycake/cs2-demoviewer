//! Background work: re-parses from kept originals and re-fetches of share codes still inside
//! Valve's 30 days, queued behind user work and never touching a record's status.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::routing::get;
use axum::Router;
use demoviewer_pack::PlayerRank;
use demoviewer_server::background::{schedule_background, REPLAY_WINDOW};
use demoviewer_server::config::Config;
use demoviewer_server::gcbot::{ResolveError, Resolved};
use demoviewer_server::jobs::{spawn_runner_with, Hooks, Job, Jobs};
use demoviewer_server::matches::{summarize, MatchSummary};
use demoviewer_server::originals::keep_original;
use demoviewer_server::sharecode::{encode, ShareCode};
use demoviewer_server::store::{Source, Status, Store};

use common::{fake_demo, sha_hex, tiny_match, wait_until_finished, FakeResolver};

fn store() -> (tempfile::TempDir, Arc<Config>, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    (dir, cfg, store)
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// `tiny_match` with one Premier-ranked player, so a re-parse brings a mode.
fn ranked_match() -> demoviewer_pack::Match {
    let mut m = tiny_match("de_ancient");
    m.header.players = vec![demoviewer_pack::PlayerInfo {
        steamid: 76561198000000001,
        name: "a".into(),
        team_by_round: vec![2],
        crosshair: None,
        rank: Some(PlayerRank {
            kind: 11,
            value: 9000,
            wins: 12,
            if_win: 9100,
            if_loss: 8900,
            if_tie: 9000,
        }),
    }];
    m.rounds[0].players = vec![demoviewer_pack::PlayerTrack {
        x: vec![0; 101],
        y: vec![0; 101],
        z: vec![0; 101],
        yaw: vec![0; 101],
        pitch: vec![0; 101],
        health: vec![100; 101],
        armor: vec![0; 101],
        flags: vec![0; 101],
        duck: vec![0; 101],
        weapon: vec![0; 101],
        ..Default::default()
    }];
    m
}

/// `demo` kept as the original of its sha, with a pack of [`tiny_match`] and no summary;
/// returns the sha.
fn packed_match(store: &Store, demo: &[u8]) -> String {
    let sha = sha_hex(demo);
    let dem = store.tmp_dir().join("seed.dem");
    std::fs::write(&dem, demo).unwrap();
    keep_original(
        &dem,
        &store.tmp_dir().join("seed.zst"),
        &store.original_path(&sha),
    )
    .unwrap();
    std::fs::remove_file(&dem).unwrap();
    let mut pack = Vec::new();
    demoviewer_pack::write(&tiny_match("de_ancient"), &mut pack).unwrap();
    std::fs::write(store.pack_path(&sha), pack).unwrap();
    sha
}

/// A done match of `demo`: its original kept, a pack and a summary without a mode (written by
/// a summarize before ranks).
fn stored_match(store: &Store, demo: &[u8]) -> String {
    let sha = packed_match(store, demo);
    let m = tiny_match("de_ancient");
    let summary = MatchSummary {
        sha256: sha.clone(),
        played_unix: Some(1_700_000_000),
        match_id: Some("42".into()),
        created_unix: 5,
        mode: None,
        version: 1,
        ..summarize(&m, false)
    };
    std::fs::write(
        store.summary_path(&sha),
        serde_json::to_vec(&summary).unwrap(),
    )
    .unwrap();
    store.matches().insert(summary);
    sha
}

async fn wait_for(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !ok() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn user_work_goes_before_waiting_background_work() {
    let (_dir, cfg, store) = store();
    let sha = stored_match(&store, &fake_demo(5000));
    let order: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let gate = Arc::new(std::sync::Barrier::new(2));
    let (seen, held) = (order.clone(), gate.clone());
    let hooks = Hooks {
        parse: Arc::new(move |p: &Path| {
            let first = seen.lock().unwrap().is_empty();
            seen.lock().unwrap().push(p.to_owned());
            if first {
                held.wait(); // the first parse waits for the test
            }
            Ok(ranked_match())
        }),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let upload = |demo: &[u8]| {
        let id = Store::new_id();
        store.create(&id);
        store.update(&id, |r| r.sha256 = Some(sha_hex(demo)));
        let path = cfg.data_dir.join("tmp").join(format!("{id}.upload"));
        std::fs::write(&path, demo).unwrap();
        jobs.enqueue(Job::Upload {
            demo_id: id.clone(),
            dem_path: path,
            slot: None,
        });
        id
    };
    let mut a = fake_demo(3000);
    a[100] = 1;
    let first = upload(&a);
    wait_for("the first parse", || !order.lock().unwrap().is_empty()).await;
    jobs.enqueue_background(Job::Reparse { sha: sha.clone() })
        .await;
    let mut b = fake_demo(3000);
    b[100] = 2;
    let second = upload(&b);
    // Give the background job time to be ready and waiting before the worker is free.
    tokio::time::sleep(Duration::from_millis(300)).await;
    gate.wait();
    assert_eq!(
        wait_until_finished(&store, &first).await.status,
        Status::Done
    );
    assert_eq!(
        wait_until_finished(&store, &second).await.status,
        Status::Done
    );
    wait_for("the reparse", || order.lock().unwrap().len() == 3).await;
    let names: Vec<String> = order
        .lock()
        .unwrap()
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert!(names[1].starts_with(&second), "{names:?}");
    assert!(names[2].contains(&sha), "{names:?}");
}

#[tokio::test]
async fn a_reparse_rewrites_the_pack_and_summary_and_keeps_what_the_record_knew() {
    let (_dir, cfg, store) = store();
    let sha = stored_match(&store, &fake_demo(5000));
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(ranked_match())),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    jobs.enqueue_background(Job::Reparse { sha: sha.clone() })
        .await;
    wait_for("the new summary", || {
        store.matches().get(&sha).is_some_and(|s| s.mode.is_some())
    })
    .await;
    let s = store.matches().get(&sha).unwrap();
    assert_eq!(s.mode, Some(demoviewer_server::matches::GameMode::Premier));
    assert_eq!(
        (s.played_unix, s.match_id.as_deref(), s.created_unix),
        (Some(1_700_000_000), Some("42"), 5)
    );
    assert_eq!(s.version, demoviewer_server::matches::SUMMARY_VERSION);
    let on_disk: MatchSummary =
        serde_json::from_slice(&std::fs::read(store.summary_path(&sha)).unwrap()).unwrap();
    assert_eq!(on_disk, *s);
    let pack = demoviewer_pack::read(&mut std::io::BufReader::new(
        std::fs::File::open(store.pack_path(&sha)).unwrap(),
    ))
    .unwrap();
    assert_eq!(pack.header.players.len(), 1, "the pack is the re-parse's");
    let left: Vec<_> = store
        .tmp_dir()
        .read_dir()
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "tmp/ is empty: {left:?}");
}

/// A demo that ranks nobody (a server that never set the rank props) is a match of another mode
/// once parsed, not one waiting for ranks: it is not parsed again at every start.
#[tokio::test]
async fn a_reparse_that_finds_no_ranks_is_other_and_not_queued_again() {
    let (_dir, cfg, store) = store();
    let sha = stored_match(&store, &fake_demo(5000));
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_nuke"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    jobs.enqueue_background(Job::Reparse { sha: sha.clone() })
        .await;
    wait_for("the new summary", || {
        store
            .matches()
            .get(&sha)
            .is_some_and(|s| s.map == "de_nuke")
    })
    .await;
    let s = store.matches().get(&sha).unwrap();
    assert_eq!(s.mode, Some(demoviewer_server::matches::GameMode::Other));
    let again = scheduled(store.clone()).await;
    assert!(
        !again
            .iter()
            .any(|j| matches!(j, Job::Reparse { sha: s } if *s == sha)),
        "{again:?}"
    );
}

/// A FACEIT match parsed again stays a FACEIT match, though its server's name does not say so
/// and nobody in it is ranked, and keeps its FACEIT id: from its summary, or from its record
/// when no summary is indexed.
#[tokio::test]
async fn a_reparse_keeps_a_faceit_matchs_mode() {
    let (_dir, cfg, store) = store();
    let summarized = stored_match(&store, &fake_demo(5000));
    let old = MatchSummary {
        faceit_match_id: Some("1-aaaa".into()),
        ..(*store.matches().get(&summarized).unwrap()).clone()
    };
    store.matches().insert(old);
    let mut demo = fake_demo(5000);
    demo[100] = 1;
    let recorded = packed_match(&store, &demo);
    let id = Store::new_id();
    store.create_from(&id, Source::Faceit);
    store.update(&id, |r| {
        r.status = Status::Done;
        r.sha256 = Some(recorded.clone());
        r.faceit_match_id = Some("1-bbbb".into());
        r.created_unix = 9;
    });

    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_nuke"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    for sha in [&summarized, &recorded] {
        jobs.enqueue_background(Job::Reparse { sha: sha.clone() })
            .await;
    }
    let reparsed = |sha: &str| store.matches().get(sha).is_some_and(|s| s.map == "de_nuke");
    wait_for("both summaries", || {
        reparsed(&summarized) && reparsed(&recorded)
    })
    .await;
    for (sha, faceit_id, created) in [(&summarized, "1-aaaa", 5), (&recorded, "1-bbbb", 9)] {
        let s = store.matches().get(sha).unwrap();
        assert_eq!(
            (s.server_name.as_str(), s.mode),
            ("test", Some(demoviewer_server::matches::GameMode::Faceit)),
            "{sha}"
        );
        assert_eq!(
            (s.faceit_match_id.as_deref(), s.created_unix),
            (Some(faceit_id), created)
        );
        let on_disk: MatchSummary =
            serde_json::from_slice(&std::fs::read(store.summary_path(sha)).unwrap()).unwrap();
        assert_eq!(on_disk, *s);
    }
}

/// Collects what `schedule_background` queues.
async fn scheduled(store: Arc<Store>) -> Vec<Job> {
    let (jobs, _rx, mut background) = Jobs::channels();
    let scheduling = tokio::spawn(schedule_background(store, jobs));
    let mut out = Vec::new();
    while let Some(job) = background.recv().await {
        out.push(job);
    }
    scheduling.await.unwrap();
    out
}

#[tokio::test]
async fn only_summaries_without_ranks_and_with_an_original_are_reparsed() {
    let (_dir, _cfg, store) = store();
    let wanted = stored_match(&store, &fake_demo(4000));
    let mut ranked = fake_demo(4000);
    ranked[50] = 9;
    let has_mode = stored_match(&store, &ranked);
    let mut s = (*store.matches().get(&has_mode).unwrap()).clone();
    s.mode = Some(demoviewer_server::matches::GameMode::Competitive);
    store.matches().insert(s);
    let mut lost = fake_demo(4000);
    lost[50] = 8;
    let no_original = stored_match(&store, &lost);
    std::fs::remove_file(store.original_path(&no_original)).unwrap();
    let jobs = scheduled(store.clone()).await;
    let reparsed: Vec<&str> = jobs
        .iter()
        .filter_map(|j| match j {
            Job::Reparse { sha } => Some(sha.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(reparsed, [wanted.as_str()]);
}

#[tokio::test]
async fn share_codes_older_than_thirty_days_are_never_refetched() {
    let (_dir, _cfg, store) = store();
    let day = 24 * 3600;
    for (age, n) in [(29 * day, 1u64), (31 * day, 2)] {
        let id = Store::new_id();
        store.create_from(&id, Source::Sharecode);
        let code = ShareCode {
            match_id: 3_000_000_000_000_000_000 + n,
            outcome_id: 7,
            token: 9,
        };
        store.update(&id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(format!("{n:02}").repeat(32));
            r.sharecode = Some(encode(&code));
            r.created_unix = now() - age;
        });
    }
    assert!(REPLAY_WINDOW >= Duration::from_secs(30 * day));
    let jobs = scheduled(store.clone()).await;
    let refetched: Vec<u64> = jobs
        .iter()
        .filter_map(|j| match j {
            Job::Refetch { code, .. } => Some(code.match_id),
            _ => None,
        })
        .collect();
    assert_eq!(refetched, [3_000_000_000_000_000_001]);
}

/// Background work is queued as the server starts, before its first look at gcbot's health
/// (seen in production: both refetches failed "offline" half a millisecond before gcbot was
/// seen online). A refetch waits a while for gcbot instead of failing at once.
#[tokio::test]
async fn a_refetch_waits_for_gcbot_to_come_online() {
    let (_dir, cfg, store) = store();
    let sha = stored_match(&store, &fake_demo(5000));
    let resolver = FakeResolver::answering(|_| Err(ResolveError::Expired));
    resolver.set_online(false);
    let hooks = Hooks {
        resolver: Some(resolver.clone()),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    jobs.enqueue_background(Job::Refetch {
        sha,
        code: ShareCode {
            match_id: 1,
            outcome_id: 2,
            token: 3,
        },
    })
    .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    resolver.set_online(true);
    wait_for("the lookup once gcbot is online", || resolver.calls() == 1).await;
}

#[tokio::test]
async fn a_refetched_demo_of_another_sha_is_discarded() {
    let (_dir, cfg, store) = store();
    let sha = stored_match(&store, &fake_demo(5000));
    std::fs::remove_file(store.original_path(&sha)).unwrap();
    let before = std::fs::read(store.pack_path(&sha)).unwrap();
    // The replay host serves some other demo.
    let other = fake_demo(6000);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let body = other.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route(
                "/730/x.dem",
                get(move || {
                    let b = body.clone();
                    async move { b }
                }),
            ),
        )
        .await
        .unwrap()
    });
    let url = format!("http://replay183.valve.net:{}/730/x.dem", addr.port());
    let resolver = FakeResolver::answering(move |_| {
        Ok(Resolved {
            match_id: 1,
            url: url.parse().unwrap(),
            played_unix: None,
            info: None,
        })
    });
    let parsed = Arc::new(Mutex::new(0));
    let count = parsed.clone();
    let hooks = Hooks {
        parse: Arc::new(move |_: &Path| {
            *count.lock().unwrap() += 1;
            Ok(ranked_match())
        }),
        download_exempt: vec![addr],
        download_hosts: vec![("replay183.valve.net".into(), addr)],
        resolver: Some(resolver.clone()),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let code = ShareCode {
        match_id: 1,
        outcome_id: 2,
        token: 3,
    };
    jobs.enqueue_background(Job::Refetch {
        sha: sha.clone(),
        code,
    })
    .await;
    wait_for("the lookup", || resolver.calls() == 1).await;
    // Let the download and the check finish.
    wait_for("tmp/ to empty", || {
        store.tmp_dir().read_dir().unwrap().next().is_none()
    })
    .await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(*parsed.lock().unwrap(), 0);
    assert_eq!(std::fs::read(store.pack_path(&sha)).unwrap(), before);
    assert!(!store.has_original(&sha));
    assert!(!store.has_original(&sha_hex(&other)));
}
