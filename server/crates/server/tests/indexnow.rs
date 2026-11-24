//! IndexNow: new match, event and profile pages are submitted in batches to a fake endpoint,
//! only with a key and a public URL.

mod common;

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use axum::http::{header, StatusCode};
use axum::routing::post;
use axum::Router;
use demoviewer_server::app::build_app;
use demoviewer_server::config::Config;
use demoviewer_server::hidden::Hidden;
use demoviewer_server::indexnow::IndexNow;
use demoviewer_server::jobs::{spawn_runner_with, Hooks, Job, Jobs};
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::store::Store;
use serde_json::Value;
use url::Url;

use common::{call, fake_demo, sha_hex, site, summary, tiny_match, wait_until_finished};

const KEY: &str = "abcdefgh12345678";

/// A fake endpoint that answers each POST with the next of `statuses` (200 once they run out)
/// and records the bodies it gets.
async fn endpoint(statuses: Vec<u16>) -> (Url, Arc<Mutex<Vec<Value>>>) {
    let seen: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (record, mut statuses) = (seen.clone(), VecDeque::from(statuses));
    let statuses = Arc::new(Mutex::new(std::mem::take(&mut statuses)));
    let app = Router::new().route(
        "/indexnow",
        post(move |body: String| async move {
            record
                .lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap());
            let status = statuses.lock().unwrap().pop_front().unwrap_or(200);
            StatusCode::from_u16(status).unwrap()
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = Url::parse(&format!(
        "http://{}/indexnow",
        listener.local_addr().unwrap()
    ))
    .unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, seen)
}

fn indexnow(endpoint: Url, hidden: Arc<Hidden>) -> Arc<IndexNow> {
    IndexNow::new(
        reqwest::Client::new(),
        KEY.into(),
        Url::parse("https://skunk.club/").unwrap(),
        endpoint,
        hidden,
    )
}

fn hidden_in(dir: &Path, ids: &[u64]) -> Arc<Hidden> {
    let list: Vec<String> = ids.iter().map(u64::to_string).collect();
    std::fs::write(
        dir.join("hidden.json"),
        serde_json::to_string(&list).unwrap(),
    )
    .unwrap();
    Arc::new(Hidden::open(&dir.join("hidden.json")))
}

#[tokio::test]
async fn a_done_match_posts_its_page_event_and_profiles_once() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = endpoint(vec![]).await;
    let mut m = summary(&common::sha(1));
    m.event = Some("cac2026".into());
    m.players.truncate(3);
    m.players[2].steamid = "0".into(); // a bot
    let hidden_id: u64 = m.players[0].steamid.parse().unwrap();
    let visible = m.players[1].steamid.clone();
    let ix = indexnow(url, hidden_in(dir.path(), &[hidden_id]));

    ix.queue_match("abc123", &m);
    assert_eq!(ix.flush().await, Ok(3));
    let posts = seen.lock().unwrap().clone();
    assert_eq!(posts.len(), 1);
    assert_eq!(posts[0]["host"], "skunk.club");
    assert_eq!(posts[0]["key"], KEY);
    assert_eq!(
        posts[0]["keyLocation"],
        format!("https://skunk.club/{KEY}.txt")
    );
    let mut want = vec![
        "https://skunk.club/d/abc123".to_owned(),
        "https://skunk.club/events/cac2026".to_owned(),
        format!("https://skunk.club/profiles/{visible}"),
    ];
    want.sort();
    assert_eq!(posts[0]["urlList"], serde_json::json!(want));

    assert_eq!(ix.flush().await, Ok(0));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_4xx_drops_the_batch() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = endpoint(vec![422]).await;
    let ix = indexnow(url, hidden_in(dir.path(), &[]));
    ix.queue(["d/one".to_owned()]);
    assert!(ix.flush().await.is_err());
    assert_eq!(ix.flush().await, Ok(0));
    assert_eq!(seen.lock().unwrap().len(), 1);
    assert!(ix.pending().is_empty());
}

#[tokio::test]
async fn a_5xx_keeps_the_batch_once() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = endpoint(vec![503, 200]).await;
    let ix = indexnow(url, hidden_in(dir.path(), &[]));
    ix.queue(["d/one".to_owned()]);
    assert!(ix.flush().await.is_err());
    assert_eq!(ix.flush().await, Ok(1));
    {
        let posts = seen.lock().unwrap();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0]["urlList"], posts[1]["urlList"]);
    }

    let (url, seen) = endpoint(vec![503, 503]).await;
    let ix = indexnow(url, hidden_in(dir.path(), &[]));
    ix.queue(["d/one".to_owned()]);
    assert!(ix.flush().await.is_err());
    assert!(ix.flush().await.is_err());
    assert_eq!(ix.flush().await, Ok(0));
    assert_eq!(seen.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn the_key_file_is_served() {
    let s = site(|c| Config {
        indexnow_key: Some(KEY.into()),
        ..c
    });
    let (status, headers, body) = call(&s.app, &format!("/{KEY}.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .starts_with("text/plain"));
    assert_eq!(body, KEY.as_bytes());
    // Other .txt files are not the key's.
    let (status, _, body) = call(&s.app, "/other.txt").await;
    assert_ne!(body, KEY.as_bytes());
    assert_ne!(status, StatusCode::OK);

    // A key with no public URL still answers with the key.
    let s = site(|c| Config {
        indexnow_key: Some(KEY.into()),
        public_url: None,
        ..c
    });
    let (status, _, body) = call(&s.app, &format!("/{KEY}.txt")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, KEY.as_bytes());

    let s = site(|c| c);
    let (status, _, _) = call(&s.app, &format!("/{KEY}.txt")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn without_a_key_or_public_url_nothing_is_queued() {
    for (key, public) in [(None, true), (Some(KEY), false), (None, false)] {
        let dir = tempfile::tempdir().unwrap();
        let cfg = Arc::new(Config {
            data_dir: dir.path().join("data"),
            web_dir: dir.path().join("web"),
            indexnow_key: key.map(Into::into),
            public_url: public.then(|| Url::parse("https://skunk.club/").unwrap()),
            ..Config::default()
        });
        let store = Arc::new(Store::open(&cfg).unwrap());
        let (jobs, _rx) = Jobs::channel();
        let _app = build_app(
            cfg.clone(),
            store,
            jobs.clone(),
            Arc::new(RateLimiter::new(cfg.ingests_per_hour)),
        );
        assert!(jobs.indexnow().is_none(), "{key:?} {public}");
    }
    // The worker's Done path tolerates there being none.
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_ancient"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let id = upload(&store, &cfg, &jobs, &fake_demo(3000));
    wait_until_finished(&store, &id).await;
}

fn upload(store: &Store, cfg: &Config, jobs: &Jobs, demo: &[u8]) -> String {
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
}

#[tokio::test]
async fn the_worker_queues_a_parsed_demo() {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(Config {
        data_dir: dir.path().join("data"),
        web_dir: dir.path().join("web"),
        indexnow_key: Some(KEY.into()),
        public_url: Some(Url::parse("https://skunk.club/").unwrap()),
        ..Config::default()
    });
    let store = Arc::new(Store::open(&cfg).unwrap());
    let hooks = Hooks {
        parse: Arc::new(|_: &Path| Ok(tiny_match("de_ancient"))),
        ..Hooks::default()
    };
    let jobs = spawn_runner_with(store.clone(), cfg.clone(), hooks);
    let _app = build_app(
        cfg.clone(),
        store.clone(),
        jobs.clone(),
        Arc::new(RateLimiter::new(cfg.ingests_per_hour)),
    );
    let ix = jobs.indexnow().expect("indexnow is on").clone();
    // The guides are queued at startup.
    assert!(ix
        .pending()
        .iter()
        .any(|p| p.starts_with("guides/watch-faceit-demos")));

    let id = upload(&store, &cfg, &jobs, &fake_demo(3000));
    wait_until_finished(&store, &id).await;
    let want = format!("d/{id}");
    // Queued right after the record goes Done.
    for _ in 0..100 {
        if ix.pending().contains(&want) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    panic!("{want} not pending: {:?}", ix.pending());
}

#[tokio::test]
async fn urls_are_joined_under_a_public_url_with_a_path() {
    let dir = tempfile::tempdir().unwrap();
    let (url, seen) = endpoint(vec![]).await;
    let ix = IndexNow::new(
        reqwest::Client::new(),
        KEY.into(),
        Url::parse("https://skunk.club/site/").unwrap(),
        url,
        hidden_in(dir.path(), &[]),
    );
    ix.queue(["d/one".to_owned()]);
    assert_eq!(ix.flush().await, Ok(1));
    let post = seen.lock().unwrap()[0].clone();
    assert_eq!(
        post["urlList"],
        serde_json::json!(["https://skunk.club/site/d/one"])
    );
    assert_eq!(
        post["keyLocation"],
        format!("https://skunk.club/site/{KEY}.txt")
    );
}
