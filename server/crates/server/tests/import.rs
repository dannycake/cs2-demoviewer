//! Importing a demo corpus: each demo of its index once, parsed and kept, the corpus untouched.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use demoviewer_server::config::Config;
use demoviewer_server::import::{import_once, spawn_importer, ImportLog};
use demoviewer_server::jobs::{spawn_runner_with, Hooks};
use demoviewer_server::store::{DemoRecord, Source, Status, Store};

use common::{fake_demo, sha_hex, tiny_match};

const DEMO: &str = "hf/owner__set/iem-cologne-2026/a-vs-b-nuke.dem";
const GZIPPED: &str = "hf/owner__set/iem-cologne-2026/c-vs-d-ancient.dem.gz";

fn store() -> (tempfile::TempDir, Arc<Config>, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    (dir, cfg, store)
}

/// A corpus of `bytes` at `file` with its index; every directory read-only unless `writable`.
fn corpus(dir: &Path, file: &str, bytes: &[u8], writable: bool) -> PathBuf {
    let root = dir.join("corpus");
    let path = root.join(file);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, bytes).unwrap();
    let line = serde_json::json!({
        "source": "hf", "dataset": "owner/set", "path": file, "file": file,
        "sha256": sha_hex(bytes), "bytes": bytes.len(), "map": "de_nuke",
        "event": "IEM Cologne 2026", "fetched_unix": 1792729209u64,
    });
    fs::write(root.join("index.jsonl"), format!("{line}\n")).unwrap();
    if !writable {
        set_mode(&root, 0o555);
    }
    root
}

/// Sets the mode of every directory of the corpus at `root`.
fn set_mode(root: &Path, mode: u32) {
    let mut dir = root.join(DEMO).parent().unwrap().to_owned();
    loop {
        fs::set_permissions(&dir, fs::Permissions::from_mode(mode)).unwrap();
        if dir == root {
            break;
        }
        dir = dir.parent().unwrap().to_owned();
    }
}

fn imports(store: &Store) -> Vec<DemoRecord> {
    store
        .records()
        .into_iter()
        .filter(|r| r.source == Source::Import)
        .collect()
}

async fn wait_for_import(store: &Store) -> DemoRecord {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(r) = imports(store)
            .into_iter()
            .find(|r| matches!(r.status, Status::Done | Status::Error))
        {
            return r;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for the import"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn counting_hooks() -> (Hooks, Arc<Mutex<usize>>) {
    let parsed = Arc::new(Mutex::new(0));
    let count = parsed.clone();
    let hooks = Hooks {
        parse: Arc::new(move |_: &Path| {
            *count.lock().unwrap() += 1;
            Ok(tiny_match("de_nuke"))
        }),
        ..Hooks::default()
    };
    (hooks, parsed)
}

#[tokio::test]
async fn an_imported_demo_is_parsed_kept_and_never_deleted_from_the_corpus() {
    let (dir, cfg, store) = store();
    let demo = fake_demo(5000);
    let root = corpus(dir.path(), DEMO, &demo, false);
    let (hooks, _) = counting_hooks();
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    spawn_importer(store.clone(), jobs, root.clone());
    let rec = wait_for_import(&store).await;
    assert_eq!((rec.status, rec.error.as_deref()), (Status::Done, None));
    assert_eq!(rec.event.as_deref(), Some("IEM Cologne 2026"));
    assert_eq!(
        fs::read(root.join(DEMO)).unwrap(),
        demo,
        "the corpus file is untouched"
    );
    let sha = sha_hex(&demo);
    assert!(store.has_original(&sha));
    let summary = store.matches().get(&sha).unwrap();
    assert_eq!(summary.event.as_deref(), Some("IEM Cologne 2026"));
    assert!(
        store.tmp_dir().read_dir().unwrap().next().is_none(),
        "tmp/ is empty"
    );
    set_mode(&root, 0o755);
}

/// In a corpus the server could write to, a compressed demo is still left where it is.
#[tokio::test]
async fn a_second_scan_imports_nothing_twice() {
    let (dir, cfg, store) = store();
    let demo = fake_demo(5000);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    std::io::Write::write_all(&mut gz, &demo).unwrap();
    let gz = gz.finish().unwrap();
    let root = corpus(dir.path(), GZIPPED, &gz, true);
    let (hooks, parsed) = counting_hooks();
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    spawn_importer(store.clone(), jobs.clone(), root.clone());
    assert_eq!(wait_for_import(&store).await.status, Status::Done);
    assert_eq!(
        fs::read(root.join(GZIPPED)).unwrap(),
        gz,
        "the corpus file is untouched"
    );
    assert!(store.has_original(&sha_hex(&demo)));
    // As after a restart: another importer over the same index and data.
    spawn_importer(store.clone(), jobs, root.clone());
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(imports(&store).len(), 1);
    assert_eq!(*parsed.lock().unwrap(), 1);
    assert!(ImportLog::open(&cfg.data_dir)
        .unwrap()
        .contains(&sha_hex(&gz)));
}

#[tokio::test]
async fn a_rescan_marks_a_match_imported_before_the_mark_existed() {
    let (dir, cfg, store) = store();
    let demo = fake_demo(5000);
    let root = corpus(dir.path(), DEMO, &demo, true);
    let (hooks, parsed) = counting_hooks();
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    spawn_importer(store.clone(), jobs.clone(), root.clone());
    let rec = wait_for_import(&store).await;
    assert_eq!(rec.status, Status::Done);
    let sha = sha_hex(&demo);
    // Imported today, a match says so from the start.
    assert!(store.matches().get(&sha).unwrap().imported);

    // A summary from before the mark.
    let path = store.summary_path(&sha);
    let mut old: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    old.as_object_mut().unwrap().remove("imported");
    fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let mut summary = (*store.matches().get(&sha).unwrap()).clone();
    summary.imported = false;
    store.matches().insert(summary);

    let log = Arc::new(ImportLog::open(&cfg.data_dir).unwrap());
    let queued = import_once(&store, &jobs, &root, &log).await;
    assert_eq!(queued, 0);
    assert!(store.matches().get(&sha).unwrap().imported);
    let on_disk: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(on_disk["imported"], true);
    assert_eq!(*parsed.lock().unwrap(), 1, "nothing was parsed again");
}

#[tokio::test]
async fn a_rescan_backfills_teams_onto_an_imported_match() {
    let (dir, cfg, store) = store();
    let demo = fake_demo(5000);
    let root = corpus(dir.path(), DEMO, &demo, true);
    let (hooks, parsed) = counting_hooks();
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    spawn_importer(store.clone(), jobs.clone(), root.clone());
    let rec = wait_for_import(&store).await;
    assert_eq!(rec.status, Status::Done);
    assert_eq!(rec.teams, None);
    let sha = sha_hex(&demo);
    assert_eq!(store.matches().get(&sha).unwrap().teams, None);

    // The index now names the teams of the same demo.
    let line = serde_json::json!({
        "source": "hf", "dataset": "owner/set", "path": DEMO, "file": DEMO,
        "sha256": sha, "bytes": demo.len(), "map": "de_nuke",
        "event": "IEM Cologne 2026", "teams": ["Spirit", "Falcons"],
        "fetched_unix": 1792729209u64,
    });
    fs::write(root.join("index.jsonl"), format!("{line}\n")).unwrap();
    let log = Arc::new(ImportLog::open(&cfg.data_dir).unwrap());
    let queued = import_once(&store, &jobs, &root, &log).await;
    assert_eq!(queued, 0);

    let teams = Some(["Spirit".to_owned(), "Falcons".to_owned()]);
    assert_eq!(store.get(&rec.id).unwrap().teams, teams);
    assert_eq!(store.matches().get(&sha).unwrap().teams, teams);
    let on_disk: serde_json::Value =
        serde_json::from_slice(&fs::read(store.summary_path(&sha)).unwrap()).unwrap();
    assert_eq!(on_disk["teams"], serde_json::json!(["Spirit", "Falcons"]));
    assert_eq!(*parsed.lock().unwrap(), 1, "nothing was parsed again");
    assert!(
        store.tmp_dir().read_dir().unwrap().next().is_none(),
        "tmp/ is empty"
    );
}
