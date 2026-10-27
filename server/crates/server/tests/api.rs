//! HTTP API tests: the router runs in process (`tower::ServiceExt::oneshot`) over a temp data
//! dir, with either a stub job queue the test drains or the real job runner. The healthcheck
//! tests instead serve over TCP on 127.0.0.1 (a free port) and run the built
//! `demoviewer-server healthcheck` against it.

mod common;

use std::collections::HashSet;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body, Bytes};
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::Router;
use demoviewer_server::admission::FETCHES_PER_CLIENT;
use demoviewer_server::app::build_app;
use demoviewer_server::config::Config;
use demoviewer_server::gcbot::{ResolveError, Resolved, ShareCodes, MAX_WAITING};
use demoviewer_server::jobs::{self, Hooks, Job, Jobs};
use demoviewer_server::matches::{summarize, MatchSummary};
use demoviewer_server::ratelimit::{parse_cidrs, RateLimiter};
use demoviewer_server::sharecode::{decode, encode, ShareCode};
use demoviewer_server::store::{Source, Status, Store};
use demoviewer_server::uploads::{
    self, Layout, UploadMeta, Uploads, PUTS_IN_FLIGHT_PER_CLIENT, PUTS_PER_CHUNK, SPARE_PUTS,
};
use serde_json::{json, Value};
use tempfile::TempDir;
use tokio::sync::mpsc::UnboundedReceiver;
use tower::ServiceExt;

use common::{
    drop_at, fake_demo, one_blocking_thread, payload, sha_hex, tiny_match, wait_until_finished,
    FakeResolver,
};

const KB: usize = 1024;
const MB: usize = 1024 * 1024;

struct Harness {
    dir: TempDir,
    cfg: Arc<Config>,
    store: Arc<Store>,
    app: Router,
}

fn config(dir: &Path, chunk_bytes: u64) -> Config {
    Config {
        data_dir: dir.join("data"),
        assets_dir: dir.join("assets"),
        web_dir: dir.join("web"),
        chunk_bytes,
        // The mock peer is 10.0.0.2, so its X-Forwarded-For header is believed.
        trusted_proxies: parse_cidrs("10.0.0.0/8").unwrap(),
        ..Config::default()
    }
}

#[tokio::test]
async fn forwarding_headers_from_an_untrusted_peer_are_ignored() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            ingests_per_hour: 1,
            trusted_proxies: vec![],
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    // Two "different" clients by header are one peer without a trusted proxy in front.
    let (first, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.50"),
    )
    .await;
    assert_eq!(first, StatusCode::CREATED);
    let (second, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.51"),
    )
    .await;
    assert_eq!(second, StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn a_stalled_chunk_body_times_out() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            put_idle: Duration::from_millis(200),
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let (id, _) = start_upload(&h.app, 100 * KB).await;
    let body = Body::from_stream(futures_util::stream::pending::<Result<Bytes, std::io::Error>>());
    let req = Request::put(format!("/api/uploads/{id}/0"))
        .body(body)
        .unwrap();
    let resp = h.app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::REQUEST_TIMEOUT);
}

fn harness(
    cfg: impl FnOnce(&Path) -> Config,
    jobs: impl FnOnce(Arc<Store>, Arc<Config>) -> Jobs,
) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let cfg = Arc::new(cfg(dir.path()));
    let store = Arc::new(Store::open(&cfg).unwrap());
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    let app = build_app(
        cfg.clone(),
        store.clone(),
        jobs(store.clone(), cfg.clone()),
        limiter,
    )
    .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 40000))));
    Harness {
        dir,
        cfg,
        store,
        app,
    }
}

/// A harness whose jobs go to a channel the test drains instead of a runner.
fn stub(chunk_bytes: u64) -> (Harness, UnboundedReceiver<Job>) {
    let (jobs, rx) = Jobs::channel();
    (harness(|d| config(d, chunk_bytes), |_, _| jobs), rx)
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

async fn call_json(app: &Router, req: Request<Body>) -> (StatusCode, Value) {
    let (status, _, body) = call(app, req).await;
    let v = serde_json::from_slice(&body).unwrap_or_else(|e| {
        panic!(
            "{status}: body is not JSON ({e}): {:?}",
            String::from_utf8_lossy(&body)
        )
    });
    (status, v)
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

fn post_json(uri: &str, v: Value, ip: &str) -> Request<Body> {
    Request::post(uri)
        .header(header::CONTENT_TYPE, "application/json")
        .header("x-forwarded-for", ip)
        .body(Body::from(v.to_string()))
        .unwrap()
}

fn put(uri: &str, body: Vec<u8>) -> Request<Body> {
    Request::put(uri).body(Body::from(body)).unwrap()
}

async fn start_upload(app: &Router, size: usize) -> (String, usize) {
    start_upload_from(app, size, "198.51.100.1").await
}

async fn start_upload_from(app: &Router, size: usize, ip: &str) -> (String, usize) {
    let (status, v) = call_json(
        app,
        post_json("/api/uploads", json!({"size": size, "name": "x.dem"}), ip),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
    (
        v["uploadId"].as_str().unwrap().to_owned(),
        v["chunkSize"].as_u64().unwrap() as usize,
    )
}

async fn put_chunk(app: &Router, upload: &str, n: usize, bytes: &[u8]) -> StatusCode {
    call(
        app,
        put(&format!("/api/uploads/{upload}/{n}"), bytes.to_vec()),
    )
    .await
    .0
}

async fn complete(app: &Router, upload: &str) -> (StatusCode, Value) {
    call_json(
        app,
        Request::post(format!("/api/uploads/{upload}/complete"))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

/// Starts an upload, PUTs every chunk in order and completes it.
async fn upload(app: &Router, data: &[u8]) -> (StatusCode, Value) {
    let (id, chunk) = start_upload(app, data.len()).await;
    for (n, part) in data.chunks(chunk).enumerate() {
        assert_eq!(put_chunk(app, &id, n, part).await, StatusCode::NO_CONTENT);
    }
    complete(app, &id).await
}

fn gz(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn files_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|rd| {
            rd.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

#[tokio::test]
async fn healthz_answers_ok() {
    let (h, _rx) = stub(40 * KB as u64);
    let (status, _, body) = call(&h.app, get("/healthz")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"ok");
}

/// The server binary, whose `healthcheck` subcommand is the image's Docker health check.
const SERVER: &str = env!("CARGO_BIN_EXE_demoviewer-server");

/// Runs `demoviewer-server healthcheck` against `127.0.0.1:port`: its exit code and how long
/// it took.
async fn healthcheck(port: u16) -> (Option<i32>, Duration) {
    let started = std::time::Instant::now();
    let run = tokio::process::Command::new(SERVER)
        .arg("healthcheck")
        .env("DEMOVIEWER_PORT", port.to_string())
        .kill_on_drop(true)
        .output();
    let out = tokio::time::timeout(Duration::from_secs(20), run)
        .await
        .expect("the healthcheck still running after 20 s")
        .unwrap();
    (out.status.code(), started.elapsed())
}

/// Serves `app` on a free port of 127.0.0.1 (never the user's 8095) until the test ends.
async fn serve(app: Router) -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await });
    port
}

#[tokio::test]
async fn the_healthcheck_passes_against_a_live_server() {
    let (h, _rx) = stub(40 * KB as u64);
    let port = serve(h.app.clone()).await;
    assert_eq!(healthcheck(port).await.0, Some(0));
}

#[tokio::test]
async fn the_healthcheck_fails_on_a_closed_port() {
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    assert_eq!(healthcheck(port).await.0, Some(1));
}

#[tokio::test]
async fn the_healthcheck_fails_when_something_else_answers() {
    // Another service on the port: `/healthz` is a 404 there, or a 200 that is not `ok`.
    let port = serve(Router::new()).await;
    assert_eq!(healthcheck(port).await.0, Some(1));
    let other = Router::new().route("/healthz", axum::routing::get(|| async { "okay" }));
    let port = serve(other).await;
    assert_eq!(healthcheck(port).await.0, Some(1));
}

#[tokio::test]
async fn the_healthcheck_gives_up_on_a_silent_server_after_3_s() {
    // A server that accepts the connection and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let held = tokio::spawn(async move {
        let mut conns = Vec::new();
        while let Ok((conn, _)) = listener.accept().await {
            conns.push(conn);
        }
    });
    let (code, took) = healthcheck(port).await;
    held.abort();
    assert_eq!(code, Some(1));
    assert!(took >= Duration::from_millis(2900), "{took:?}");
    assert!(took < Duration::from_secs(10), "{took:?}");
}

/// The refusal states the limit in the unit it is set in: 524,288,000 bytes is 500 MiB (it
/// said "524 MB", dividing by a million, while the README and `Config` said 500 MB).
#[tokio::test]
async fn upload_over_the_size_limit_is_413() {
    let (h, _rx) = stub(40 * KB as u64);
    assert_eq!(h.cfg.max_upload_bytes, Config::default().max_upload_bytes);
    let (status, v) = call_json(
        &h.app,
        post_json(
            "/api/uploads",
            json!({"size": h.cfg.max_upload_bytes + 1}),
            "198.51.100.1",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        v["error"], "the file is larger than the 500 MiB limit",
        "{v}"
    );
}

#[tokio::test]
async fn eleventh_upload_from_one_address_is_429() {
    let (h, _rx) = stub(40 * KB as u64);
    for i in 0..10 {
        let (status, v) = call_json(
            &h.app,
            post_json("/api/uploads", json!({"size": 1000}), "203.0.113.9"),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "upload {}: {v}", i + 1);
    }
    let (status, v) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.9"),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(v["error"].is_string(), "{v}");
    let (status, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.10"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn bad_upload_requests_are_400_with_a_json_error() {
    let (h, _rx) = stub(40 * KB as u64);
    for body in [
        json!({"name": "x.dem"}),
        json!({"size": 0}),
        json!({"size": "big"}),
    ] {
        let (status, v) = call_json(
            &h.app,
            post_json("/api/uploads", body.clone(), "198.51.100.1"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {v}");
        assert!(v["error"].is_string(), "{v}");
    }
}

#[tokio::test]
async fn chunk_flow_rejects_a_gap_then_assembles_in_order() {
    let (h, mut rx) = stub(40 * KB as u64);
    let data = payload(100 * KB);
    let (upload_id, chunk) = start_upload(&h.app, data.len()).await;
    assert_eq!(chunk, 40 * KB);
    let parts: Vec<&[u8]> = data.chunks(chunk).collect();
    assert_eq!(parts.len(), 3);

    assert_eq!(
        put_chunk(&h.app, &upload_id, 0, parts[0]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_chunk(&h.app, &upload_id, 2, parts[2]).await,
        StatusCode::NO_CONTENT
    );
    let (status, v) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"], "missing chunk 1");
    assert!(
        rx.try_recv().is_err(),
        "nothing may be enqueued for an incomplete upload"
    );

    // A repeated PUT overwrites: the second, correct body wins.
    assert_eq!(
        put_chunk(&h.app, &upload_id, 1, &vec![0xEE; chunk]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_chunk(&h.app, &upload_id, 1, parts[1]).await,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        put_chunk(&h.app, &upload_id, 1, parts[1]).await,
        StatusCode::NO_CONTENT
    );
    let (status, v) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let demo_id = v["demoId"].as_str().unwrap().to_owned();

    let Ok(Job::Upload {
        demo_id: job_id,
        dem_path,
        ..
    }) = rx.try_recv()
    else {
        panic!("expected one upload job");
    };
    assert_eq!(job_id, demo_id);
    assert_eq!(
        std::fs::read(&dem_path).unwrap(),
        data,
        "assembled file differs from the input"
    );
    assert!(
        !h.cfg.data_dir.join("uploads").join(&upload_id).exists(),
        "upload dir left behind"
    );
    assert!(rx.try_recv().is_err());
    assert_eq!(h.store.get(&demo_id).unwrap().sha256, Some(sha_hex(&data)));

    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{demo_id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        v,
        json!({"id": demo_id, "status": "queued", "map": null, "rounds": null, "error": null, "summary": null})
    );

    // The upload is used up.
    let (status, _) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        put_chunk(&h.app, &upload_id, 0, parts[0]).await,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn complete_without_the_last_chunk_is_409() {
    let (h, mut rx) = stub(40 * KB as u64);
    let data = payload(100 * KB);
    let (upload_id, chunk) = start_upload(&h.app, data.len()).await;
    for (n, part) in data.chunks(chunk).take(2).enumerate() {
        assert_eq!(
            put_chunk(&h.app, &upload_id, n, part).await,
            StatusCode::NO_CONTENT
        );
    }
    let (status, v) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"], "missing chunk 2");
    assert!(rx.try_recv().is_err());
    assert!(
        h.cfg.data_dir.join("uploads").join(&upload_id).is_dir(),
        "the upload must stay resumable"
    );
}

#[tokio::test]
async fn chunk_put_rules() {
    let (h, _rx) = stub(40 * KB as u64);
    let data = payload(100 * KB);
    let (upload_id, chunk) = start_upload(&h.app, data.len()).await;

    // Unknown or malformed upload ids.
    assert_eq!(
        put_chunk(&h.app, "4vJ9JU1bJJE96FWSJKvHsm", 0, &data[..chunk]).await,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        put_chunk(&h.app, "..%2F..%2Fdemos.json", 0, &data[..chunk]).await,
        StatusCode::NOT_FOUND
    );
    // Larger than a chunk.
    assert_eq!(
        put_chunk(&h.app, &upload_id, 0, &payload(chunk + 1)).await,
        StatusCode::PAYLOAD_TOO_LARGE
    );
    // Not the length this chunk must have, or past the last chunk.
    assert_eq!(
        put_chunk(&h.app, &upload_id, 0, &data[..chunk - 1]).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put_chunk(&h.app, &upload_id, 2, &data[..chunk]).await,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        put_chunk(&h.app, &upload_id, 3, &data[..10]).await,
        StatusCode::BAD_REQUEST
    );
    // A gzip body that is not gzip.
    let req = Request::put(format!("/api/uploads/{upload_id}/0"))
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(data[..chunk].to_vec()))
        .unwrap();
    let (status, v) = call_json(&h.app, req).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(v["error"].is_string());
    // An encoding the server does not speak.
    let req = Request::put(format!("/api/uploads/{upload_id}/0"))
        .header(header::CONTENT_ENCODING, "br")
        .body(Body::from(data[..chunk].to_vec()))
        .unwrap();
    assert_eq!(
        call(&h.app, req).await.0,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    // A gzip body that inflates past a chunk.
    let req = Request::put(format!("/api/uploads/{upload_id}/0"))
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(gz(&vec![0u8; 10 * chunk])))
        .unwrap();
    assert_eq!(call(&h.app, req).await.0, StatusCode::PAYLOAD_TOO_LARGE);

    // No half-written chunk files remain from the refused requests.
    assert_eq!(
        files_in(&h.cfg.data_dir.join("uploads").join(&upload_id)),
        vec!["meta.json".to_string()]
    );
}

#[tokio::test]
async fn gzip_encoded_chunks_are_stored_decoded() {
    let (h, mut rx) = stub(40 * KB as u64);
    let data = fake_demo(100 * KB);
    let (upload_id, chunk) = start_upload(&h.app, data.len()).await;
    for (n, part) in data.chunks(chunk).enumerate() {
        let req = Request::put(format!("/api/uploads/{upload_id}/{n}"))
            .header(header::CONTENT_ENCODING, "gzip")
            .body(Body::from(gz(part)))
            .unwrap();
        assert_eq!(call(&h.app, req).await.0, StatusCode::NO_CONTENT);
    }
    let (status, _) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let Ok(Job::Upload { dem_path, .. }) = rx.try_recv() else {
        panic!("no job")
    };
    assert_eq!(std::fs::read(dem_path).unwrap(), data);
}

/// axum limits extracted bodies to 2 MB unless told otherwise; a real chunk is 32 MiB.
#[tokio::test]
async fn chunks_above_axums_default_body_limit_are_accepted() {
    let (h, mut rx) = stub(Config::default().chunk_bytes);
    let data = payload(3 * MB);
    let (status, v) = upload(&h.app, &data).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let Ok(Job::Upload { dem_path, .. }) = rx.try_recv() else {
        panic!("no job")
    };
    assert_eq!(std::fs::read(dem_path).unwrap(), data);
}

#[tokio::test]
async fn reupload_of_a_done_demo_is_answered_from_the_cache() {
    let (h, mut rx) = stub(40 * KB as u64);
    let data = fake_demo(100 * KB);
    let (status, v) = upload(&h.app, &data).await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let first = v["demoId"].as_str().unwrap().to_owned();

    // Stand in for the runner: the demo consumed, a pack on disk, the record marked Done.
    let Ok(Job::Upload { dem_path, .. }) = rx.try_recv() else {
        panic!("no job")
    };
    std::fs::remove_file(dem_path).unwrap();
    let sha = sha_hex(&data);
    std::fs::write(h.store.pack_path(&sha), b"pack bytes").unwrap();
    h.store.update(&first, |r| {
        r.status = Status::Done;
        r.map = Some("de_mirage".into());
        r.rounds = Some(24);
    });

    let (status, v) = upload(&h.app, &data).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["cached"], true);
    let second = v["demoId"].as_str().unwrap().to_owned();
    assert_ne!(second, first);
    assert!(
        rx.try_recv().is_err(),
        "a cached demo must not be parsed again"
    );
    let rec = h.store.get(&second).unwrap();
    assert_eq!(rec.sha256, Some(sha));
    assert_eq!(rec.status, Status::Done);

    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{second}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        v,
        json!({"id": second, "status": "done", "map": "de_mirage", "rounds": 24, "error": null, "summary": null})
    );
    let (status, _, body) = call(&h.app, get(&format!("/api/demos/{second}/pack"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"pack bytes");
    // The second upload's assembled file went as soon as the cache answered.
    assert_eq!(files_in(&h.cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// The plan's case: the same bytes completed twice before either is done, with the real
/// runner and a file that is not a demo. Both records carry one sha and both end in error.
#[tokio::test]
async fn two_uploads_of_the_same_non_demo_share_a_sha_and_both_fail() {
    let h = harness(|d| config(d, 40 * KB as u64), jobs::spawn_runner);
    let data = payload(100 * KB);
    let (s1, v1) = upload(&h.app, &data).await;
    let (s2, v2) = upload(&h.app, &data).await;
    assert_eq!((s1, s2), (StatusCode::ACCEPTED, StatusCode::ACCEPTED));
    let (a, b) = (
        v1["demoId"].as_str().unwrap(),
        v2["demoId"].as_str().unwrap(),
    );
    assert_ne!(a, b);

    let ra = wait_until_finished(&h.store, a).await;
    let rb = wait_until_finished(&h.store, b).await;
    for r in [&ra, &rb] {
        assert_eq!(r.status, Status::Error, "{r:?}");
        assert!(
            r.error.as_deref().unwrap().contains("not a CS2 demo"),
            "{r:?}"
        );
        assert_eq!(r.sha256, Some(sha_hex(&data)));
    }
    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{a}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["status"], "error");
    assert!(v["error"].is_string());
    assert_eq!(
        files_in(&h.cfg.data_dir.join("tmp")),
        Vec::<String>::new(),
        "work files left behind"
    );
    assert_eq!(
        files_in(&h.cfg.data_dir.join("packs")),
        Vec::<String>::new()
    );
}

/// Review focus 4: two concurrent uploads of one demo give one parse, one pack, and two ids
/// that both resolve to it. The parser is replaced by a counting stub.
#[tokio::test]
async fn two_uploads_of_the_same_demo_parse_once_and_share_one_pack() {
    let parses = Arc::new(AtomicUsize::new(0));
    let counter = parses.clone();
    let h = harness(
        |d| config(d, 40 * KB as u64),
        move |store, cfg| {
            let hooks = Hooks {
                parse: Arc::new(move |path: &Path| {
                    counter.fetch_add(1, Ordering::SeqCst);
                    assert!(std::fs::read(path).unwrap().starts_with(b"PBDEMS2\0"));
                    Ok(tiny_match("de_inferno"))
                }),
                ..Hooks::default()
            };
            jobs::spawn_runner_with(store, cfg, hooks)
        },
    );
    let data = fake_demo(100 * KB);
    let (s1, v1) = upload(&h.app, &data).await;
    let (s2, v2) = upload(&h.app, &data).await;
    let (a, b) = (
        v1["demoId"].as_str().unwrap(),
        v2["demoId"].as_str().unwrap(),
    );
    // The second may be answered from the cache if the runner was quick enough.
    assert_eq!(s1, StatusCode::ACCEPTED);
    assert!(s2 == StatusCode::ACCEPTED || s2 == StatusCode::OK, "{s2}");

    for id in [a, b] {
        let r = wait_until_finished(&h.store, id).await;
        assert_eq!(r.status, Status::Done, "{r:?}");
        assert_eq!(r.map.as_deref(), Some("de_inferno"));
        assert_eq!(r.rounds, Some(1));
        assert_eq!(r.sha256, Some(sha_hex(&data)));
    }
    assert_eq!(
        parses.load(Ordering::SeqCst),
        1,
        "the demo was parsed more than once"
    );
    assert_eq!(
        files_in(&h.cfg.data_dir.join("packs")),
        vec![format!("{}.dvpk.gz", sha_hex(&data))]
    );
    let (_, _, pa) = call(&h.app, get(&format!("/api/demos/{a}/pack"))).await;
    let (_, _, pb) = call(&h.app, get(&format!("/api/demos/{b}/pack"))).await;
    assert_eq!(pa, pb);
    let m = demoviewer_pack::read(&mut &pa[..]).unwrap();
    assert_eq!(m, tiny_match("de_inferno"));
    assert_eq!(
        files_in(&h.cfg.data_dir.join("matches")),
        vec![format!("{}.json", sha_hex(&data))]
    );
    for id in [a, b] {
        assert_eq!(h.store.get(id).unwrap().source, Source::Upload);
    }
    assert_eq!(files_in(&h.cfg.data_dir.join("tmp")), Vec::<String>::new());
}

#[tokio::test]
async fn url_ingest_checks_the_url_then_enqueues() {
    let (h, mut rx) = stub(40 * KB as u64);
    let (status, v) = call_json(
        &h.app,
        post_json(
            "/api/demos",
            json!({"url": "http://127.0.0.1/x.dem"}),
            "198.51.100.1",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("only Valve replay links"),
        "{v}"
    );
    let (status, v) = call_json(
        &h.app,
        post_json(
            "/api/demos",
            json!({"url": "https://example.com/file.zip"}),
            "198.51.100.1",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
    let (status, v) = call_json(
        &h.app,
        post_json("/api/demos", json!({"link": "x"}), "198.51.100.1"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
    assert!(rx.try_recv().is_err());

    let url = "https://replay123.valve.net/730/a.dem.bz2";
    let (status, v) = call_json(
        &h.app,
        post_json("/api/demos", json!({"url": url}), "198.51.100.1"),
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let demo_id = v["demoId"].as_str().unwrap().to_owned();
    let Ok(Job::Url {
        demo_id: job_id,
        url: job_url,
        ..
    }) = rx.try_recv()
    else {
        panic!("no url job")
    };
    assert_eq!(job_id, demo_id);
    assert_eq!(job_url.as_str(), url);
    assert_eq!(h.store.get(&demo_id).unwrap().source, Source::Url);
    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{demo_id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["status"], "queued");
}

/// A posted URL is checked without DNS (scheme, host, the allowlist), so a replay host that
/// does not resolve is taken, several at once from one client, and its job is what fails: the
/// download resolves and checks every hop (code-health review 2026-10-26: the post resolved it,
/// one lookup per client at a time, answering 400 or 429 "still being checked").
#[tokio::test]
async fn a_posted_url_is_resolved_by_its_download_only() {
    let h = harness(|d| config(d, 40 * KB as u64), jobs::spawn_runner);
    let host = "replay987654321987.valve.net";
    let url = format!("https://{host}/730/a.dem.bz2");
    let posts = (0..FETCHES_PER_CLIENT).map(|_| {
        call_json(
            &h.app,
            post_json("/api/demos", json!({ "url": url }), "198.51.100.1"),
        )
    });
    let mut ids = Vec::new();
    for (status, v) in futures_util::future::join_all(posts).await {
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        ids.push(v["demoId"].as_str().unwrap().to_owned());
    }
    for id in ids {
        let r = wait_until_finished(&h.store, &id).await;
        assert_eq!(r.status, Status::Error);
        let error = r.error.unwrap();
        assert!(error.starts_with("download failed: "), "{error}");
        assert!(error.contains(host), "{error}");
    }
}

/// URL jobs on their way to the parse queue (waiting for a download place or downloading) are
/// bounded: a client may have [`FETCHES_PER_CLIENT`] at once (429), everyone `max_fetches`
/// (503); a refused post gets no record and spends none of the client's ingests, and a place
/// comes back when its job ends (security audit 2026-10-23: URL jobs waited for a download place
/// without bound).
#[tokio::test]
async fn url_jobs_on_their_way_are_bounded_per_client_and_in_total() {
    let (jobs, mut rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            max_fetches: 4,
            ingests_per_hour: 4,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let url = json!({"url": "https://replay123.valve.net/730/a.dem.bz2"});
    let post = |ip: &str| post_json("/api/demos", url.clone(), ip);
    let records = |h: &Harness| {
        let list: Vec<Value> =
            serde_json::from_slice(&std::fs::read(h.cfg.data_dir.join("demos.json")).unwrap())
                .unwrap();
        list.len()
    };
    let (a, b, c) = ("198.51.100.1", "198.51.100.2", "198.51.100.3");
    for _ in 0..FETCHES_PER_CLIENT {
        let (status, v) = call_json(&h.app, post(a)).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    }
    let (status, v) = call_json(&h.app, post(a)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert!(
        v["error"].as_str().unwrap().contains("still being fetched"),
        "{v}"
    );
    let (status, v) = call_json(&h.app, post(b)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    // Every place is taken: refused, as often as asked, without a record or an ingest spent.
    for _ in 0..5 {
        let (status, v) = call_json(&h.app, post(c)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
        assert!(v["error"].as_str().unwrap().contains("busy"), "{v}");
    }
    assert_eq!(records(&h), 4);

    // A job that ends gives its place back.
    drop(rx.try_recv().expect("the first job"));
    let (status, v) = call_json(&h.app, post(c)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    assert_eq!(records(&h), 5);
}

#[tokio::test]
async fn uploads_and_url_ingests_share_one_budget() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            ingests_per_hour: 1,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let (status, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.20"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, v) = call_json(
        &h.app,
        post_json(
            "/api/demos",
            json!({"url": "https://replay123.valve.net/730/a.dem.bz2"}),
            "203.0.113.20",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
    // A refused URL does not spend the budget of another address.
    let (status, _) = call_json(
        &h.app,
        post_json("/api/demos", json!({"url": "ftp://x.dem"}), "203.0.113.21"),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.21"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

#[tokio::test]
async fn pack_is_409_until_done_then_served_with_cache_headers() {
    let (h, _rx) = stub(40 * KB as u64);
    let (status, _) = call_json(&h.app, get("/api/demos/4vJ9JU1bJJE96FWSJKvHsm")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = call_json(&h.app, get("/api/demos/4vJ9JU1bJJE96FWSJKvHsm/pack")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let id = Store::new_id();
    h.store.create(&id);
    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{id}/pack"))).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(v["error"], "not ready");

    let sha = "ab".repeat(32);
    let mut packed = Vec::new();
    demoviewer_pack::write(&tiny_match("de_nuke"), &mut packed).unwrap();
    std::fs::write(h.store.pack_path(&sha), &packed).unwrap();
    h.store.update(&id, |r| {
        r.status = Status::Done;
        r.sha256 = Some(sha.clone());
    });
    let (status, headers, body) = call(&h.app, get(&format!("/api/demos/{id}/pack"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "application/octet-stream");
    assert_eq!(headers[header::CONTENT_ENCODING], "gzip");
    assert_eq!(
        headers[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        headers[header::CONTENT_LENGTH],
        packed.len().to_string().as_str()
    );
    assert_eq!(body, packed);
}

#[tokio::test]
async fn a_done_demo_whose_pack_was_evicted_reports_expired() {
    let (h, _rx) = stub(40 * KB as u64);
    let id = Store::new_id();
    h.store.create(&id);
    h.store.update(&id, |r| {
        r.status = Status::Done;
        r.sha256 = Some("ef".repeat(32));
    });
    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{id}/pack"))).await;
    assert_eq!(status, StatusCode::GONE);
    assert!(v["error"].as_str().unwrap().contains("expired"), "{v}");
    let (_, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
    assert_eq!(v["status"], "error");
}

/// Under a cache limit, packs are evicted least recently used first, and serving one is a use:
/// a pack read just now outlives one stored after it and not read since. (The eviction test in
/// store.rs sets the order by hand; without a limit, serving writes nothing.)
#[tokio::test]
async fn serving_a_pack_keeps_it_from_eviction() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            cache_bytes: Some(u64::MAX),
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let mut packed = Vec::new();
    demoviewer_pack::write(&tiny_match("de_nuke"), &mut packed).unwrap();
    let now = std::time::SystemTime::now();
    let mut demos = Vec::new();
    for (sha, hours) in [("aa".repeat(32), 2), ("bb".repeat(32), 1)] {
        let path = h.store.pack_path(&sha);
        std::fs::write(&path, &packed).unwrap();
        std::fs::File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(now - Duration::from_secs(hours * 3600))
            .unwrap();
        let id = Store::new_id();
        h.store.create(&id);
        h.store.update(&id, |r| {
            r.status = Status::Done;
            r.sha256 = Some(sha.clone());
        });
        demos.push((id, sha));
    }
    let [(older, older_sha), (newer, newer_sha)] = <[_; 2]>::try_from(demos).unwrap();
    let (status, _, _) = call(&h.app, get(&format!("/api/demos/{older}/pack"))).await;
    assert_eq!(status, StatusCode::OK);

    let evicted = h.store.evict_lru(packed.len() as u64).unwrap();
    assert_eq!(evicted, vec![h.store.pack_path(&newer_sha)]);
    assert!(h.store.pack_path(&older_sha).is_file());
    let (status, _, _) = call(&h.app, get(&format!("/api/demos/{older}/pack"))).await;
    assert_eq!(status, StatusCode::OK);
    let (_, v) = call_json(&h.app, get(&format!("/api/demos/{newer}"))).await;
    assert_eq!(v["status"], "error");
    assert!(v["error"].as_str().unwrap().contains("expired"), "{v}");
}

/// Link only: the site lists nothing, and tells the web app whether it takes share codes (not
/// without a share-code service).
#[tokio::test]
async fn the_site_says_what_it_offers_and_lists_nothing() {
    let (h, _rx) = stub(40 * KB as u64);
    let (status, v) = call_json(&h.app, get("/api/site")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v, json!({"sharecodes": false}));
    for path in ["/api/matches/recent", "/api/players/76561198000000001"] {
        let (status, _) = call_json(&h.app, get(path)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    }
}

/// A done demo's status carries its match summary, without the sha; so does a second upload of
/// the same demo, answered from the cache. A demo still in the queue has none.
#[tokio::test]
async fn a_done_demo_carries_its_match_summary() {
    let h = harness(
        |d| config(d, 40 * KB as u64),
        |store, cfg| {
            let hooks = Hooks {
                parse: Arc::new(|_: &Path| Ok(tiny_match("de_mirage"))),
                ..Hooks::default()
            };
            jobs::spawn_runner_with(store, cfg, hooks)
        },
    );
    let queued = Store::new_id();
    h.store.create(&queued);
    let (_, v) = call_json(&h.app, get(&format!("/api/demos/{queued}"))).await;
    assert_eq!(
        (&v["status"], &v["summary"]),
        (&json!("queued"), &Value::Null)
    );

    let data = fake_demo(100 * KB);
    let (status, v) = upload(&h.app, &data).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let first = v["demoId"].as_str().unwrap().to_owned();
    let r = wait_until_finished(&h.store, &first).await;
    assert_eq!(r.status, Status::Done, "{r:?}");
    let (status, v) = upload(&h.app, &data).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let second = v["demoId"].as_str().unwrap().to_owned();

    for id in [&first, &second] {
        let (status, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
        assert_eq!(status, StatusCode::OK);
        let s = &v["summary"];
        assert_eq!(
            (&s["map"], &s["rounds"], &s["scoreT"], &s["scoreCt"]),
            (&json!("de_mirage"), &json!(1), &json!(1), &json!(0)),
            "{v}"
        );
        assert_eq!(s["createdUnix"], r.created_unix, "{s}");
        assert_eq!(
            (&s["matchId"], &s["playedUnix"]),
            (&Value::Null, &Value::Null)
        );
        assert_eq!(s["players"], json!([]));
        assert!(
            s.get("sha256").is_none(),
            "the sha stays on the server: {s}"
        );
    }
}

/// A 500 answers what failed and nothing more: the cause (here serde's complaint about the
/// upload's metadata, elsewhere a path or an OS error) goes to the log (code-health review
/// 2026-10-26).
#[tokio::test]
async fn an_internal_error_answers_without_its_cause() {
    let (h, _rx) = stub(40 * KB as u64);
    let (status, v) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "198.51.100.1"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
    let upload = v["uploadId"].as_str().unwrap();
    std::fs::write(h.store.upload_dir(upload).join("meta.json"), b"not json").unwrap();
    let (status, v) = call_json(
        &h.app,
        put(&format!("/api/uploads/{upload}/0"), vec![0; 1000]),
    )
    .await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(v, json!({"error": "corrupt upload metadata"}));
}

/// The match index is rebuilt from `matches/` at startup: a demo done before a restart still
/// has its summary.
#[tokio::test]
async fn match_summaries_are_read_back_at_startup() {
    let id = Store::new_id();
    let sha = "cd".repeat(32);
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| {
            // What an earlier process left: a done record and its pack's summary.
            let cfg = config(d, 40 * KB as u64);
            let earlier = Store::open(&cfg).unwrap();
            earlier.create(&id);
            earlier.update(&id, |r| {
                r.status = Status::Done;
                r.sha256 = Some(sha.clone());
            });
            let summary = MatchSummary {
                sha256: sha.clone(),
                created_unix: 1_761_000_000,
                match_id: Some("3712345678901234567".into()),
                ..summarize(&tiny_match("de_ancient"))
            };
            std::fs::write(
                earlier.summary_path(&sha),
                serde_json::to_vec(&summary).unwrap(),
            )
            .unwrap();
            cfg
        },
        |_, _| jobs,
    );
    let (status, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["summary"]["map"], "de_ancient", "{v}");
    assert_eq!(v["summary"]["matchId"], "3712345678901234567");
    assert_eq!(
        h.store
            .matches()
            .get(&sha)
            .map(|s| s.map.clone())
            .as_deref(),
        Some("de_ancient")
    );
}

#[tokio::test]
async fn static_files_and_assets() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("assets/maps/de_mirage")).unwrap();
    std::fs::create_dir_all(root.join("assets/players")).unwrap();
    std::fs::create_dir_all(root.join("web/js")).unwrap();
    std::fs::write(
        root.join("assets/maps/de_mirage/overview.json"),
        br#"{"scale":5}"#,
    )
    .unwrap();
    std::fs::write(root.join("assets/players/ct.glb"), b"glTF").unwrap();
    std::fs::write(root.join("web/index.html"), b"<title>demoviewer</title>").unwrap();
    std::fs::write(root.join("web/js/app.js"), b"console.log(1)").unwrap();

    let (status, _, body) = call(&h.app, get("/maps/de_mirage/overview.json")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, br#"{"scale":5}"#);
    let (status, _, body) = call(&h.app, get("/players/ct.glb")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"glTF");
    assert_eq!(
        call(&h.app, get("/maps/de_dust2/overview.json")).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&h.app, get("/maps/../web/index.html")).await.0,
        StatusCode::NOT_FOUND
    );

    let (status, _, body) = call(&h.app, get("/")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"<title>demoviewer</title>");
    let (status, _, body) = call(&h.app, get("/js/app.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"console.log(1)");
    // Client-side routes get the app.
    let (status, _, body) = call(&h.app, get("/d/4vJ9JU1bJJE96FWSJKvHsm")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"<title>demoviewer</title>");
    // Unknown API paths stay JSON 404s.
    let (status, v) = call_json(&h.app, get("/api/nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(v["error"].is_string());
}

#[tokio::test]
async fn a_demo_with_no_rounds_ends_in_error_and_is_never_served_from_the_cache() {
    let h = harness(
        |d| config(d, 40 * KB as u64),
        |store, cfg| {
            let hooks = Hooks {
                parse: Arc::new(|_: &Path| {
                    let mut m = tiny_match("de_nuke");
                    m.header.rounds.clear();
                    m.rounds.clear();
                    Ok(m)
                }),
                ..Hooks::default()
            };
            jobs::spawn_runner_with(store, cfg, hooks)
        },
    );
    let data = fake_demo(100 * KB);
    for attempt in 1..=2 {
        let (status, v) = upload(&h.app, &data).await;
        assert_eq!(status, StatusCode::ACCEPTED, "attempt {attempt}: {v}");
        let id = v["demoId"].as_str().unwrap();
        wait_until_finished(&h.store, id).await;
        let (status, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(v["status"], "error", "attempt {attempt}: {v}");
        assert_eq!(v["error"], jobs::NO_ROUNDS);
        assert_eq!(v["rounds"], Value::Null);
    }
    assert_eq!(
        files_in(&h.cfg.data_dir.join("packs")),
        Vec::<String>::new()
    );
}

#[tokio::test]
async fn unfinished_uploads_are_capped_per_client_and_in_total() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            max_upload_bytes: 100_000,
            upload_budget_bytes: 500_000,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let start = |size: u64, ip: &str| {
        let app = h.app.clone();
        let req = post_json("/api/uploads", json!({ "size": size }), ip);
        async move { call_json(&app, req).await }
    };

    // One client may hold twice the upload limit in unfinished uploads; an IPv6 /64 is one
    // client.
    let (status, first) = start(60_000, "2001:db8:5:6::1").await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        start(100_000, "2001:db8:5:6::2").await.0,
        StatusCode::CREATED
    );
    let (status, v) = start(50_000, "2001:db8:5:6:ffff::9").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert!(v["error"].as_str().unwrap().contains("unfinished"), "{v}");

    // All clients together stay within the budget: 160,000 + 200,000 + 140,000 = 500,000.
    for (size, ip) in [
        (100_000, "203.0.113.2"),
        (100_000, "203.0.113.2"),
        (100_000, "203.0.113.3"),
    ] {
        assert_eq!(start(size, ip).await.0, StatusCode::CREATED);
    }
    let (status, v) = start(50_000, "203.0.113.3").await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert!(v["error"].is_string(), "{v}");
    assert_eq!(start(40_000, "203.0.113.3").await.0, StatusCode::CREATED);

    // A completed upload no longer counts.
    let id = first["uploadId"].as_str().unwrap();
    let data = payload(60_000);
    for (n, part) in data.chunks(40 * KB).enumerate() {
        assert_eq!(put_chunk(&h.app, id, n, part).await, StatusCode::NO_CONTENT);
    }
    assert_eq!(complete(&h.app, id).await.0, StatusCode::ACCEPTED);
    assert_eq!(
        start(50_000, "2001:db8:5:6::1").await.0,
        StatusCode::CREATED
    );
}

/// An upload start reads no other upload's files: the declared sizes of open uploads are
/// counted in memory, so one whose `meta.json` is gone still holds its share of the budget
/// until it is completed or swept (code-health review 2026-10-26: every start read every open
/// upload's `meta.json`, skipping one it could not read).
#[tokio::test]
async fn unfinished_uploads_are_counted_without_reading_them() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            max_upload_bytes: 100_000,
            upload_budget_bytes: 100_000,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let (status, v) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 100_000}), "203.0.113.2"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{v}");
    let first = v["uploadId"].as_str().unwrap();
    std::fs::remove_file(h.store.upload_dir(first).join("meta.json")).unwrap();
    let (status, v) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "203.0.113.3"),
    )
    .await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
}

/// An upload start whose client goes away while its directory is being made (hyper drops the
/// handler; the blocking task making the directory goes on) counts as one that was answered:
/// the upload is in the budget, its ingest stays spent, and a restart, which counts the uploads
/// from their `meta.json`, finds the same (code-health review 2026-10-26: the dropped handler
/// gave the ingest and the reservation back while the directory was still made, so one address
/// could leave uploads of 500 MiB that no limit counted until a restart counted them all and
/// refused every upload for an hour).
#[test]
fn an_upload_start_dropped_while_its_directory_is_made_is_counted() {
    one_blocking_thread().block_on(async {
        let (jobs, _rx) = Jobs::channel();
        let h = harness(
            |d| Config {
                max_upload_bytes: 100_000,
                upload_budget_bytes: 150_000,
                ingests_per_hour: 1,
                ..config(d, 40 * KB as u64)
            },
            |_, _| jobs,
        );
        let start = |size: u64| post_json("/api/uploads", json!({ "size": size }), "203.0.113.20");
        let dropped = drop_at(h.app.clone().oneshot(start(100_000)), 1, || {}).await;
        assert!(dropped.is_none(), "the start waits for its directory");
        assert_eq!(
            files_in(&h.store.uploads_dir()).len(),
            1,
            "made all the same"
        );

        // 100,000 bytes are counted: 50,001 more are past the budget, and 50,000 fit it but the
        // client's one ingest of the hour is spent.
        let (status, v) = call_json(&h.app, start(50_001)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
        let (status, v) = call_json(&h.app, start(50_000)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
        assert!(v["error"].as_str().unwrap().contains("this hour"), "{v}");

        // A restart counts the same 100,000 bytes (and starts its ingest counts afresh).
        let Harness {
            dir: _dir,
            cfg,
            store,
            app,
        } = h;
        drop((app, store));
        let (jobs, _rx) = Jobs::channel();
        let store = Arc::new(Store::open(&cfg).unwrap());
        let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
        let app = build_app(cfg.clone(), store, jobs, limiter)
            .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 40000))));
        let (status, v) = call_json(&app, start(50_001)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
        let (status, v) = call_json(&app, start(50_000)).await;
        assert_eq!(status, StatusCode::CREATED, "{v}");
    });
}

/// A completion whose client goes away at any point, while the upload is claimed and its chunks
/// assembled on a blocking task included, leaves nothing in `tmp/`: the task deletes the claimed
/// chunks, and the assembled file goes when its result is dropped unread. The upload is either
/// still there and counted, or gone from the budget too (code-health review 2026-10-26: a
/// completion dropped while the claim's rename waited left the chunks in `tmp/` and the upload in
/// the budget for an hour; one dropped during the assembly left the assembled file, up to
/// 500 MiB, until a restart).
#[test]
fn a_completion_dropped_at_any_point_leaves_no_file_behind() {
    one_blocking_thread().block_on(async {
        let data = payload(60_000);
        let mut claimed = 0;
        for k in 1.. {
            let (jobs, mut rx) = Jobs::channel();
            let h = harness(
                |d| Config {
                    max_upload_bytes: 60_000,
                    upload_budget_bytes: 60_000,
                    ..config(d, 40 * KB as u64)
                },
                |_, _| jobs,
            );
            let (id, chunk) = start_upload(&h.app, data.len()).await;
            for (n, part) in data.chunks(chunk).enumerate() {
                assert_eq!(
                    put_chunk(&h.app, &id, n, part).await,
                    StatusCode::NO_CONTENT
                );
            }
            let req = Request::post(format!("/api/uploads/{id}/complete"))
                .body(Body::empty())
                .unwrap();
            let finished = drop_at(h.app.clone().oneshot(req), k, || {}).await;
            // Once queued, the assembled file is the job's.
            let queued = match rx.try_recv() {
                Ok(Job::Upload { dem_path, .. }) => {
                    Some(dem_path.file_name().unwrap().to_string_lossy().into_owned())
                }
                Ok(_) => panic!("an upload makes an upload job"),
                Err(_) => None,
            };
            let left: Vec<String> = files_in(&h.store.tmp_dir())
                .into_iter()
                .filter(|f| Some(f) != queued.as_ref())
                .collect();
            assert_eq!(left, Vec::<String>::new(), "dropped at wait {k}");
            // The budget counts the upload exactly while its directory is there.
            let open = h.store.upload_dir(&id).exists();
            let (status, v) = call_json(
                &h.app,
                post_json("/api/uploads", json!({"size": 60_000}), "203.0.113.30"),
            )
            .await;
            let counted = status == StatusCode::SERVICE_UNAVAILABLE;
            assert_eq!(counted, open, "dropped at wait {k}: {status} {v}");
            if let Some(res) = finished {
                assert_eq!(res.unwrap().status(), StatusCode::ACCEPTED);
                break;
            }
            claimed += usize::from(!open && queued.is_none());
        }
        assert!(claimed > 0, "no drop came after the claim");
    });
}

/// A chunk PUT whose client goes away while its chunk is inflated (on a blocking task, which
/// goes on) still counts among the client's PUTs in progress until the inflating ends, and its
/// work files go when it does (code-health review 2026-10-26: the dropped request gave its place
/// back at once, so a client sending gzip chunks and going away could have any number inflating
/// at once). A file whose creation the drop came before is left empty until the upload goes.
#[test]
fn a_chunk_put_dropped_while_inflating_holds_its_place_until_it_ends() {
    one_blocking_thread().block_on(async {
        let dir = tempfile::tempdir().unwrap();
        let cfg = config(dir.path(), 40 * KB as u64);
        let store = Store::open(&cfg).unwrap();
        let uploads = Arc::new(Uploads::open(&store, &cfg));
        let (id, client, size) = (Store::new_id(), "203.0.113.40", 40 * KB as u64);
        let reservation = uploads.reserve(&id, client, size).unwrap();
        let meta = UploadMeta {
            size,
            client: client.into(),
        };
        uploads.create(&id, &meta).unwrap();
        reservation.keep();
        let layout = Layout {
            size,
            chunk: size,
            client: client.into(),
        };
        let (upload_dir, chunk) = (store.upload_dir(&id), gz(&payload(40 * KB)));
        let begin = || uploads.begin_put(&id, u64::MAX);
        let mut held = 0;
        for k in 1.. {
            let others: Vec<_> = (1..PUTS_IN_FLIGHT_PER_CLIENT)
                .map(|_| begin().unwrap())
                .collect();
            let body = Body::from(chunk.clone());
            let idle = Duration::from_secs(60);
            let put =
                uploads::store_chunk(&upload_dir, &layout, 0, true, body, idle, begin().unwrap());
            let mut still_in_progress = false;
            let finished = drop_at(put, k, || still_in_progress = begin().is_err()).await;
            drop(others);
            held += usize::from(still_in_progress);
            // Once what it started has ended, its place is free and nothing it wrote is left.
            let all: Vec<_> = (0..PUTS_IN_FLIGHT_PER_CLIENT)
                .map(|_| begin().unwrap())
                .collect();
            drop(all);
            for name in files_in(&upload_dir) {
                let len = std::fs::metadata(upload_dir.join(&name)).unwrap().len();
                let kept = name == "meta.json" || name == "0";
                assert!(
                    kept || len == 0,
                    "dropped at wait {k}: {name} holds {len} bytes"
                );
            }
            if let Some(stored) = finished {
                stored.unwrap();
                break;
            }
        }
        assert!(held > 0, "no drop came while the chunk was inflated");
    });
}

/// One upload start allows only so many chunk PUTs (each may write a whole chunk), so it
/// cannot be turned into unbounded disk writes; what was stored still completes.
#[tokio::test]
async fn an_upload_takes_a_bounded_number_of_chunk_puts() {
    let (h, mut rx) = stub(40 * KB as u64);
    let data = payload(30 * KB);
    let (upload_id, _) = start_upload(&h.app, data.len()).await;
    let allowed = PUTS_PER_CHUNK + SPARE_PUTS;
    // Refused PUTs count too: the body was received and written either way.
    assert_eq!(
        put_chunk(&h.app, &upload_id, 0, &data[1..]).await,
        StatusCode::BAD_REQUEST
    );
    for _ in 1..allowed {
        assert_eq!(
            put_chunk(&h.app, &upload_id, 0, &data).await,
            StatusCode::NO_CONTENT
        );
    }
    let (status, v) = call_json(
        &h.app,
        put(&format!("/api/uploads/{upload_id}/0"), data.clone()),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert!(
        v["error"]
            .as_str()
            .unwrap()
            .contains("start the upload again"),
        "{v}"
    );
    let (status, v) = complete(&h.app, &upload_id).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let Ok(Job::Upload { dem_path, .. }) = rx.try_recv() else {
        panic!("no job")
    };
    assert_eq!(std::fs::read(dem_path).unwrap(), data);
}

/// Demo data shrinks about 1.5 times under gzip; a chunk that inflates far more is refused
/// before it is written out in full.
#[tokio::test]
async fn a_gzip_chunk_that_inflates_implausibly_is_refused() {
    let (h, _rx) = stub(64 * KB as u64);
    let (upload_id, chunk) = start_upload(&h.app, 100 * KB).await;
    let bomb = gz(&vec![0u8; chunk]);
    assert!(bomb.len() * 20 < chunk);
    let req = Request::put(format!("/api/uploads/{upload_id}/0"))
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(bomb))
        .unwrap();
    let (status, v) = call_json(&h.app, req).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert!(v["error"].as_str().unwrap().contains("20 times"), "{v}");
    // Data that compresses like a demo is fine.
    let req = Request::put(format!("/api/uploads/{upload_id}/0"))
        .header(header::CONTENT_ENCODING, "gzip")
        .body(Body::from(gz(&payload(chunk))))
        .unwrap();
    assert_eq!(call(&h.app, req).await.0, StatusCode::NO_CONTENT);
    assert_eq!(
        files_in(&h.cfg.data_dir.join("uploads").join(&upload_id)),
        vec!["0".to_string(), "meta.json".to_string()]
    );
}

/// A client may have only a few chunk PUTs in progress at once (each holds temp files outside
/// the upload budget); once one ends, the next is let in.
#[tokio::test]
async fn a_client_may_send_only_a_few_chunks_at_once() {
    let (h, _rx) = stub(40 * KB as u64);
    let (upload_id, chunk) = start_upload(&h.app, 20 * 40 * KB).await;
    let uri = |n: usize| format!("/api/uploads/{upload_id}/{n}");
    // PUTs whose bodies never end.
    let send_stuck = |n: usize| {
        let first = futures_util::stream::once(async {
            Ok::<_, std::io::Error>(axum::body::Bytes::from(vec![1u8; 100]))
        });
        let body = Body::from_stream(futures_util::StreamExt::chain(
            first,
            futures_util::stream::pending(),
        ));
        let req = Request::put(uri(n)).body(body).unwrap();
        tokio::spawn(h.app.clone().oneshot(req))
    };
    let mut stuck: Vec<_> = (0..PUTS_IN_FLIGHT_PER_CLIENT).map(send_stuck).collect();

    // Until they are all in progress, a short body is just the wrong length. The probe runs
    // inline, so it gets ahead of a stuck PUT spawned just before it and can take the last
    // place: the stuck PUT is refused, sent again, and given time to start (10 ms doubling to
    // 200 ms) before the next probe. Every PUT spends one of the upload's 42.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let backoff = |attempt: u32| std::time::Duration::from_millis((10 << attempt.min(5)).min(200));
    for attempt in 0.. {
        for (n, t) in stuck.iter_mut().enumerate() {
            if t.is_finished() {
                let refused = std::mem::replace(t, send_stuck(n)).await.unwrap().unwrap();
                assert_eq!(refused.status(), StatusCode::TOO_MANY_REQUESTS);
            }
        }
        tokio::time::sleep(backoff(attempt)).await;
        let (status, v) = call_json(&h.app, put(&uri(19), vec![1u8; 10])).await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            assert!(v["error"].as_str().unwrap().contains("at once"), "{v}");
            break;
        }
        assert_eq!(status, StatusCode::BAD_REQUEST, "{v}");
        assert!(std::time::Instant::now() < deadline, "never refused");
    }

    // A client that gives up frees its slots.
    for t in &stuck {
        t.abort();
    }
    let part = payload(chunk);
    for attempt in 0.. {
        match put_chunk(&h.app, &upload_id, 5, &part).await {
            StatusCode::NO_CONTENT => break,
            StatusCode::TOO_MANY_REQUESTS => {
                assert!(std::time::Instant::now() < deadline, "slots never freed");
                tokio::time::sleep(backoff(attempt)).await;
            }
            other => panic!("{other}"),
        }
    }
}

/// The page itself is revalidated on every visit, so a deploy reaches a returning visitor at
/// once; the build's hashed bundles never change and are kept for a year.
#[tokio::test]
async fn the_page_is_revalidated_and_hashed_bundles_are_kept_for_a_year() {
    let (h, _rx) = stub(40 * KB as u64);
    let web = h.dir.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), b"<title>demoviewer</title>").unwrap();
    std::fs::write(web.join("assets/index-abc123.js"), b"console.log(1)").unwrap();
    for (uri, want) in [
        ("/", "no-cache"),
        ("/d/someDemo", "no-cache"),
        (
            "/assets/index-abc123.js",
            "public, max-age=31536000, immutable",
        ),
    ] {
        let (status, headers, _) = call(&h.app, get(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        let got = headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap());
        assert_eq!(got, Some(want), "{uri}");
    }
}

/// A tab left open across a deploy asks for the previous build's chunks, which this build does
/// not have. Each is a 404: answered with index.html (200) under `/assets/`, the browser would
/// keep the page as that script for a year. The page itself, at any path, is never immutable.
#[tokio::test]
async fn a_bundle_missing_from_this_build_is_a_404_and_the_page_is_never_immutable() {
    let (h, _rx) = stub(40 * KB as u64);
    let web = h.dir.path().join("web");
    std::fs::create_dir_all(web.join("assets")).unwrap();
    std::fs::write(web.join("index.html"), b"<title>demoviewer</title>").unwrap();
    std::fs::write(web.join("assets/index-new.js"), b"console.log(1)").unwrap();
    for uri in [
        "/assets/index-old.js",
        "/assets/worker-old.js",
        "/assets/nested/index-old.css",
        "/assets/",
    ] {
        let (status, headers, body) = call(&h.app, get(uri)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(headers.get(header::CACHE_CONTROL), None, "{uri}");
        assert!(!body.starts_with(b"<title>"), "{uri}");
    }
    // Every path that falls back to the page gets the page's header, whatever it looks like.
    for uri in ["/", "/some/route", "/assets.js", "/d/someDemo/assets/x.js"] {
        let (status, headers, body) = call(&h.app, get(uri)).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert_eq!(body, b"<title>demoviewer</title>", "{uri}");
        assert_eq!(headers[header::CACHE_CONTROL], "no-cache", "{uri}");
    }
}

#[tokio::test]
async fn assets_send_precompressed_gzip_and_cache_headers_keyed_by_the_version_query() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("assets/weapons")).unwrap();
    std::fs::create_dir_all(root.join("assets/maps/de_x")).unwrap();
    std::fs::create_dir_all(root.join("web")).unwrap();
    std::fs::write(root.join("assets/weapons/ak47.glb"), b"glTF-ak").unwrap();
    let packed = gz(b"glTF-ak");
    std::fs::write(root.join("assets/weapons/ak47.glb.gz"), &packed).unwrap();
    std::fs::write(root.join("assets/maps/de_x/world.glb"), b"glTF-world").unwrap();
    std::fs::write(root.join("web/index.html"), b"<title>demoviewer</title>").unwrap();
    let cache = |headers: &HeaderMap| {
        headers
            .get(header::CACHE_CONTROL)
            .map(|v| v.to_str().unwrap().to_string())
    };
    let encoding = |headers: &HeaderMap| {
        headers
            .get(header::CONTENT_ENCODING)
            .map(|v| v.to_str().unwrap().to_string())
    };
    let gzip_get = |uri: &str| {
        Request::get(uri)
            .header(header::ACCEPT_ENCODING, "gzip, br")
            .body(Body::empty())
            .unwrap()
    };

    // A `.gz` sibling is sent as is to a client that accepts gzip.
    let (status, headers, body) = call(&h.app, gzip_get("/weapons/ak47.glb")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers).as_deref(), Some("gzip"));
    assert_eq!(body, packed);
    // The plain file otherwise.
    let (status, headers, body) = call(&h.app, get("/weapons/ak47.glb")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers), None);
    assert_eq!(body, b"glTF-ak");
    // No sibling: the plain file even to a gzip client.
    let (status, headers, body) = call(&h.app, gzip_get("/maps/de_x/world.glb")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers), None);
    assert_eq!(body, b"glTF-world");

    // A `v` query marks the request as content-addressed: cache it for a year.
    let (status, headers, _) = call(&h.app, get("/maps/de_x/world.glb?v=abcd1234")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        cache(&headers).as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    let (_, headers, _) = call(&h.app, gzip_get("/weapons/ak47.glb?v=1")).await;
    assert_eq!(
        cache(&headers).as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    // Without it the client must revalidate (manifests, and a stale app).
    let (_, headers, _) = call(&h.app, get("/maps/de_x/world.glb")).await;
    assert_eq!(cache(&headers).as_deref(), Some("no-cache"));
    // An empty `v` is not a version.
    let (_, headers, _) = call(&h.app, get("/maps/de_x/world.glb?v=")).await;
    assert_eq!(cache(&headers).as_deref(), Some("no-cache"));
    // A miss carries no cache header, and the web app's page is not an asset: a version query
    // does not make it immutable.
    let (status, headers, _) = call(&h.app, get("/weapons/nope.glb?v=1")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(cache(&headers), None);
    let (status, headers, _) = call(&h.app, get("/?v=1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cache(&headers).as_deref(), Some("no-cache"));
}

#[tokio::test]
async fn viewmodels_are_served_like_the_weapons() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("assets/viewmodels")).unwrap();
    std::fs::write(root.join("assets/viewmodels/arms_ct.glb"), b"glTF-arms").unwrap();
    let packed = gz(b"glTF-arms");
    std::fs::write(root.join("assets/viewmodels/arms_ct.glb.gz"), &packed).unwrap();
    std::fs::write(root.join("assets/viewmodels/manifest.json"), b"{}").unwrap();
    let header_of = |headers: &HeaderMap, name: header::HeaderName| {
        headers.get(name).map(|v| v.to_str().unwrap().to_string())
    };
    let gzip_get = |uri: &str| {
        Request::get(uri)
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap()
    };

    // The `.gz` sibling to a gzip client, for a year when versioned.
    let (status, headers, body) =
        call(&h.app, gzip_get("/viewmodels/arms_ct.glb?v=a19e70a2")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_of(&headers, header::CONTENT_ENCODING).as_deref(),
        Some("gzip")
    );
    assert_eq!(body, packed);
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    // The plain file otherwise; the manifest is revalidated.
    let (status, headers, body) = call(&h.app, get("/viewmodels/arms_ct.glb")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_of(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(body, b"glTF-arms");
    let (status, headers, body) = call(&h.app, get("/viewmodels/manifest.json")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"{}");
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("no-cache")
    );
    // A missing clip file is a 404, not the web app's index.html.
    let (status, _, _) = call(&h.app, get("/viewmodels/nope.glb?v=1")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn effects_are_served_like_the_weapons() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("assets/effects")).unwrap();
    std::fs::write(root.join("assets/effects/fire.webp"), b"RIFF-fire-WEBP").unwrap();
    std::fs::write(root.join("assets/effects/manifest.json"), b"{}").unwrap();
    let header_of = |headers: &HeaderMap, name: header::HeaderName| {
        headers.get(name).map(|v| v.to_str().unwrap().to_string())
    };

    // An atlas, for a year when versioned.
    let (status, headers, body) = call(&h.app, get("/effects/fire.webp?v=eb345930")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"RIFF-fire-WEBP");
    assert_eq!(
        header_of(&headers, header::CONTENT_TYPE).as_deref(),
        Some("image/webp")
    );
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    // The manifest is revalidated.
    let (status, headers, body) = call(&h.app, get("/effects/manifest.json")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"{}");
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("no-cache")
    );
    // A missing atlas is a 404, not the web app's index.html.
    let (status, _, _) = call(&h.app, get("/effects/nope.webp?v=1")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn sounds_are_served_like_the_weapons() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("assets/sounds")).unwrap();
    std::fs::write(root.join("assets/sounds/weapon_ak47.webm"), b"webm-ak47").unwrap();
    let manifest = br#"{"schema":1,"banks":{}}"#.repeat(20);
    std::fs::write(root.join("assets/sounds/manifest.json"), &manifest).unwrap();
    let packed = gz(&manifest);
    std::fs::write(root.join("assets/sounds/manifest.json.gz"), &packed).unwrap();
    let header_of = |headers: &HeaderMap, name: header::HeaderName| {
        headers.get(name).map(|v| v.to_str().unwrap().to_string())
    };
    let gzip_get = |uri: &str| {
        Request::get(uri)
            .header(header::ACCEPT_ENCODING, "gzip")
            .body(Body::empty())
            .unwrap()
    };

    // A bank, for a year when versioned.
    let (status, headers, body) = call(&h.app, get("/sounds/weapon_ak47.webm?v=63a1c0de")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, b"webm-ak47");
    assert_eq!(
        header_of(&headers, header::CONTENT_TYPE).as_deref(),
        Some("video/webm")
    );
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("public, max-age=31536000, immutable")
    );
    // The manifest's `.gz` sibling to a gzip client, revalidated every time.
    let (status, headers, body) = call(&h.app, gzip_get("/sounds/manifest.json")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        header_of(&headers, header::CONTENT_ENCODING).as_deref(),
        Some("gzip")
    );
    assert_eq!(body, packed);
    assert_eq!(
        header_of(&headers, header::CACHE_CONTROL).as_deref(),
        Some("no-cache")
    );
    // The plain manifest otherwise.
    let (status, headers, body) = call(&h.app, get("/sounds/manifest.json")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(header_of(&headers, header::CONTENT_ENCODING), None);
    assert_eq!(body, manifest);
    // A missing bank is a 404, not the web app's index.html.
    let (status, _, _) = call(&h.app, get("/sounds/nope.webm?v=1")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn the_web_app_sends_its_gzip_siblings_to_gzip_clients() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("web/assets")).unwrap();
    let script = b"console.log('demoviewer')".repeat(50);
    std::fs::write(root.join("web/assets/index-abc.js"), &script).unwrap();
    let packed = gz(&script);
    std::fs::write(root.join("web/assets/index-abc.js.gz"), &packed).unwrap();
    let page = b"<title>demoviewer</title>".repeat(50);
    std::fs::write(root.join("web/index.html"), &page).unwrap();
    std::fs::write(root.join("web/index.html.gz"), gz(&page)).unwrap();
    let encoding = |headers: &HeaderMap| {
        headers
            .get(header::CONTENT_ENCODING)
            .map(|v| v.to_str().unwrap().to_string())
    };
    let gzip_get = |uri: &str| {
        Request::get(uri)
            .header(header::ACCEPT_ENCODING, "gzip, br")
            .body(Body::empty())
            .unwrap()
    };

    let (status, headers, body) = call(&h.app, gzip_get("/assets/index-abc.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers).as_deref(), Some("gzip"));
    assert_eq!(body, packed);
    let (status, headers, body) = call(&h.app, get("/assets/index-abc.js")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers), None);
    assert_eq!(body, script);
    // A path that is not a file falls back to index.html, compressed the same way. (A match
    // page, `/d/{id}`, is index.html with its tags added: tests/pages.rs.)
    let (status, headers, body) = call(&h.app, gzip_get("/some/route")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(encoding(&headers).as_deref(), Some("gzip"));
    assert_eq!(body, gz(&page));
}

#[tokio::test]
async fn every_response_carries_the_security_headers() {
    let (h, _rx) = stub(40 * KB as u64);
    let root = h.dir.path();
    std::fs::create_dir_all(root.join("web")).unwrap();
    std::fs::write(root.join("web/index.html"), b"<title>demoviewer</title>").unwrap();
    for uri in [
        "/",
        "/d/someDemo",
        "/og/someDemo.png",
        "/api/demos/nope",
        "/healthz",
        "/maps/de_x/world.glb",
    ] {
        let (_, headers, _) = call(&h.app, get(uri)).await;
        let value = |name: &str| {
            headers
                .get(name)
                .map(|v| v.to_str().unwrap().to_string())
                .unwrap_or_default()
        };
        assert_eq!(value("x-content-type-options"), "nosniff", "{uri}");
        assert_eq!(value("x-frame-options"), "DENY", "{uri}");
        let csp = value("content-security-policy");
        assert!(csp.contains("frame-ancestors 'none'"), "{uri}: {csp}");
        assert!(csp.contains("default-src 'self'"), "{uri}: {csp}");
        // The meshopt decoder compiles WebAssembly; GLTF textures load through blob: URLs.
        assert!(csp.contains("'wasm-unsafe-eval'"), "{uri}: {csp}");
        assert!(csp.contains("blob:"), "{uri}: {csp}");
        assert!(!csp.contains("'unsafe-eval'"), "{uri}: {csp}");
        assert_eq!(
            value("referrer-policy"),
            "strict-origin-when-cross-origin",
            "{uri}"
        );
    }
}

/// A small demo-shaped body (uploads are checked for their contents only by the job runner).
fn small_demo(tag: u8) -> Vec<u8> {
    let mut d = b"PBDEMS2\0".to_vec();
    d.extend(std::iter::repeat_n(tag, 1000));
    d
}

#[tokio::test]
async fn a_completed_upload_holds_its_slot_until_its_job_ends() {
    let (jobs, mut rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            max_queued_uploads: 1,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let first = send_small(&h.app, 1, "198.51.100.1").await;
    let second = send_small(&h.app, 2, "198.51.100.2").await;
    let (status, v) = complete(&h.app, &first).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    // The first job is still queued (held by the receiver): no slot for the second.
    let (status, v) = complete(&h.app, &second).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert!(v["error"].as_str().unwrap().contains("busy"), "{v}");
    // Its chunks are untouched, so completing again works once the first job is done.
    let job = rx.try_recv().expect("the first job");
    drop(job);
    let (status, v) = complete(&h.app, &second).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
}

/// Starts an upload of `small_demo(n)` from `ip` and sends its one chunk.
async fn send_small(app: &Router, n: u8, ip: &str) -> String {
    let body = small_demo(n);
    let (id, _) = start_upload_from(app, body.len(), ip).await;
    assert_eq!(put_chunk(app, &id, 0, &body).await, StatusCode::NO_CONTENT);
    id
}

#[tokio::test]
async fn a_client_holds_at_most_two_completed_uploads_at_a_time() {
    let (jobs, mut rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            max_queued_uploads: 4,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let (a, b, c) = ("198.51.100.1", "198.51.100.2", "198.51.100.3");
    let mut sent = Vec::new();
    for (n, ip) in [(1, a), (2, a), (3, a), (4, b), (5, b), (6, c)] {
        sent.push(send_small(&h.app, n, ip).await);
    }
    let complete_is = |id: String, want: StatusCode| {
        let app = h.app.clone();
        async move {
            let (status, v) = complete(&app, &id).await;
            assert_eq!(status, want, "{v}");
            if want == StatusCode::TOO_MANY_REQUESTS {
                let error = v["error"].as_str().unwrap();
                assert!(error.contains("still being processed"), "{v}");
            }
        }
    };
    // A second demo while the first is processing is fine; a third is not.
    complete_is(sent[0].clone(), StatusCode::ACCEPTED).await;
    complete_is(sent[1].clone(), StatusCode::ACCEPTED).await;
    complete_is(sent[2].clone(), StatusCode::TOO_MANY_REQUESTS).await;
    // Another client gets a place, but no second one while half the queue is taken...
    complete_is(sent[3].clone(), StatusCode::ACCEPTED).await;
    complete_is(sent[4].clone(), StatusCode::TOO_MANY_REQUESTS).await;
    // ...so a third client still finds the last place.
    complete_is(sent[5].clone(), StatusCode::ACCEPTED).await;
    // Once the first client's jobs are done, its third upload completes.
    drop(rx.try_recv().expect("the first job"));
    drop(rx.try_recv().expect("the second job"));
    complete_is(sent[2].clone(), StatusCode::ACCEPTED).await;
}

#[tokio::test]
async fn uploads_are_refused_when_the_disk_is_nearly_full() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            // More free space than any disk has.
            min_free_bytes: u64::MAX / 4,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let (status, v) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "198.51.100.1"),
    )
    .await;
    assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{v}");
    assert!(v["error"].as_str().unwrap().contains("disk"), "{v}");
}

/// URL and share-code ingests keep the same free-space floor as uploads: below it they are
/// refused with 507 before any DNS, record, place or ingest (security audit 2026-10-23: they
/// skipped it), while a share code the site already has still answers with its demo.
#[tokio::test]
async fn url_and_share_code_ingests_are_refused_when_the_disk_is_nearly_full() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        // More free space than any disk has.
        min_free_bytes: u64::MAX / 4,
        ..config(d, 40 * KB as u64)
    });
    let (known, _) = h.store.claim_match(&ids_for(7), &Store::new_id());
    std::fs::write(h.store.pack_path(&"ab".repeat(32)), b"pack").unwrap();
    h.store.update(&known.id, |r| {
        r.status = Status::Done;
        r.sha256 = Some("ab".repeat(32));
    });
    for body in [
        // Refused before its host is resolved: this one does not exist.
        json!({"url": "https://nowhere.invalid/a.dem"}),
        json!({"url": "https://replay123.valve.net/730/a.dem.bz2"}),
        json!({"sharecode": code_for(8)}),
    ] {
        let (status, v) = call_json(
            &h.app,
            post_json("/api/demos", body.clone(), "198.51.100.1"),
        )
        .await;
        assert_eq!(status, StatusCode::INSUFFICIENT_STORAGE, "{body}: {v}");
        assert_eq!(
            v["error"], "the server is low on disk space; try again later",
            "{body}"
        );
    }
    assert_eq!(fake.calls(), 0);
    // The known record was made here, not by a post, so nothing waited for it to be written.
    h.store.saved().await;
    let records: Vec<Value> =
        serde_json::from_slice(&std::fs::read(h.cfg.data_dir.join("demos.json")).unwrap()).unwrap();
    assert_eq!(records.len(), 1, "{records:?}");
    let (status, v) = call_json(&h.app, post_code(&code_for(7), "198.51.100.1")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v, json!({"demoId": known.id, "cached": true}));
}

#[tokio::test]
async fn attempts_are_limited_before_any_dns_or_disk_work() {
    let (jobs, _rx) = Jobs::channel();
    let h = harness(
        |d| Config {
            attempts_per_hour: 2,
            ..config(d, 40 * KB as u64)
        },
        |_, _| jobs,
    );
    let ingest = |host: &str| {
        post_json(
            "/api/demos",
            json!({"url": format!("https://{host}.invalid/a.dem")}),
            "198.51.100.7",
        )
    };
    // Two attempts are let through to the URL check (which fails: not a Valve replay host)...
    for host in ["one", "two"] {
        let (status, _) = call_json(&h.app, ingest(host)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }
    // ...and the third is refused before it resolves anything.
    let (status, v) = call_json(&h.app, ingest("three")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
    // Upload starts from that client count against the same attempts.
    let (status, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "198.51.100.7"),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Another client is unaffected.
    let (status, _) = call_json(
        &h.app,
        post_json("/api/uploads", json!({"size": 1000}), "198.51.100.8"),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}

// ---- share codes ----------------------------------------------------------------------------

const CODE: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";
const CODE_MATCH: &str = "3230642215713767580";

/// The ids of a share code for Valve's match `match_id`.
fn ids_for(match_id: u64) -> ShareCode {
    ShareCode {
        match_id,
        outcome_id: 1,
        token: 1,
    }
}

/// A share code for Valve's match `match_id`.
fn code_for(match_id: u64) -> String {
    encode(&ids_for(match_id))
}

fn post_code(code: &str, ip: &str) -> Request<Body> {
    post_json("/api/demos", json!({ "sharecode": code }), ip)
}

/// A harness whose runner looks share codes up with `resolver`.
fn with_resolver(resolver: Arc<FakeResolver>, cfg: impl FnOnce(&Path) -> Config) -> Harness {
    harness(cfg, |store, cfg| {
        let hooks = Hooks {
            parse: Arc::new(|_: &Path| Ok(tiny_match("de_mirage"))),
            resolver: Some(resolver),
            ..Hooks::default()
        };
        jobs::spawn_runner_with(store, cfg, hooks)
    })
}

async fn until(what: &str, f: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(std::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// One share code posted by many people at once (a Discord burst): one record, one lookup, one
/// demo id for everyone, and the repeats spend nobody's ingests.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_burst_of_one_share_code_makes_one_lookup() {
    let fake = FakeResolver::held(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        ingests_per_hour: 1,
        ..config(d, 40 * KB as u64)
    });
    let posts: Vec<_> = (0..20)
        .map(|n| {
            let app = h.app.clone();
            tokio::spawn(async move {
                call_json(&app, post_code(CODE, &format!("203.0.113.{n}"))).await
            })
        })
        .collect();
    let mut ids = HashSet::new();
    for post in posts {
        let (status, v) = post.await.unwrap();
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        ids.insert(v["demoId"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids.len(), 1, "{ids:?}");
    let id = ids.into_iter().next().unwrap();
    until("the lookup", || fake.calls() == 1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(fake.calls(), 1);
    let r = h.store.get(&id).unwrap();
    assert_eq!(
        (r.status, r.source, r.match_id.as_deref()),
        (Status::Resolving, Source::Sharecode, Some(CODE_MATCH))
    );
    let (_, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
    assert_eq!(v["status"], "resolving");
    let records: Vec<Value> =
        serde_json::from_slice(&std::fs::read(h.cfg.data_dir.join("demos.json")).unwrap()).unwrap();
    assert_eq!(records.len(), 1, "{records:?}");

    // One poster made the record and spent its one ingest; the other 19 still have theirs.
    let mut accepted = 0;
    for n in 0..20 {
        let (status, v) = call_json(
            &h.app,
            post_code(&code_for(1000 + n), &format!("203.0.113.{n}")),
        )
        .await;
        match status {
            StatusCode::ACCEPTED => accepted += 1,
            _ => assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}"),
        }
    }
    assert_eq!(accepted, 19);
    fake.release();
    let r = wait_until_finished(&h.store, &id).await;
    assert_eq!(r.error, Some(ResolveError::NotFound.to_string()), "{r:?}");
}

/// A share code the site has had before answers with its demo at once: no lookup, no new
/// record, and the poster's ingests untouched. Only that very code does (security review
/// 2026-10-22): a code with its match id and another outcome id or token, which anyone can
/// write, gets no link-only demo, and neither does a code for a match the site has from an
/// upload (whose summary learned the match id) or from its replay URL; each is looked up.
#[tokio::test]
async fn only_the_very_share_code_answers_from_the_cache() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        ingests_per_hour: 1,
        ..config(d, 40 * KB as u64)
    });
    let packed = |sha: &str| std::fs::write(h.store.pack_path(sha), b"pack").unwrap();
    let (shared, created) = h.store.claim_match(&ids_for(41), &Store::new_id());
    assert!(created);
    packed(&"ab".repeat(32));
    h.store.update(&shared.id, |r| {
        r.status = Status::Done;
        r.sha256 = Some("ab".repeat(32));
    });
    let uploaded = Store::new_id();
    h.store.create(&uploaded);
    packed(&"cd".repeat(32));
    h.store.update(&uploaded, |r| {
        r.status = Status::Done;
        r.sha256 = Some("cd".repeat(32));
    });
    h.store.matches().insert(MatchSummary {
        sha256: "cd".repeat(32),
        match_id: Some("42".into()),
        ..summarize(&tiny_match("de_nuke"))
    });
    let replay = Store::new_id();
    h.store.create_from(&replay, Source::Url);
    packed(&"ef".repeat(32));
    h.store.update(&replay, |r| {
        r.status = Status::Done;
        r.sha256 = Some("ef".repeat(32));
    });

    for _ in 0..3 {
        let (status, v) = call_json(&h.app, post_code(&code_for(41), "198.51.100.7")).await;
        assert_eq!(status, StatusCode::OK, "{v}");
        assert_eq!(v, json!({"demoId": shared.id, "cached": true}));
    }
    assert_eq!(fake.calls(), 0);

    let others = [
        encode(&ShareCode {
            outcome_id: 2,
            ..ids_for(41)
        }),
        encode(&ShareCode {
            token: 2,
            ..ids_for(41)
        }),
        code_for(42),
        // A replay URL's first number is the outcome id of the match's code.
        encode(&ShareCode {
            outcome_id: 4545,
            ..ids_for(45)
        }),
    ];
    let known = [&shared.id, &uploaded, &replay];
    for (n, code) in others.iter().enumerate() {
        let (status, v) = call_json(&h.app, post_code(code, &format!("203.0.113.{n}"))).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{code}: {v}");
        let id = v["demoId"].as_str().unwrap().to_owned();
        assert!(!known.contains(&&id), "{code} was given {id}");
    }
    until("the lookups", || fake.calls() == others.len()).await;

    // The poster's one ingest is still there.
    let (status, v) = call_json(&h.app, post_code(&code_for(43), "198.51.100.7")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let (status, _) = call_json(&h.app, post_code(&code_for(44), "198.51.100.7")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Out of ingests, the poster still gets the code's demo.
    let (status, v) = call_json(&h.app, post_code(&code_for(41), "198.51.100.7")).await;
    assert_eq!((status, &v["demoId"]), (StatusCode::OK, &json!(shared.id)));
}

/// A forged share code (a real match's id with another token) posted first neither holds the
/// real code's lookup nor makes Valve's refusal of it the real code's: the real code gets its
/// own record, and once Valve has refused the forgery, the forgery is refused at once while the
/// real code is still looked up (security review 2026-10-22).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_forged_share_code_does_not_spoil_the_real_one() {
    let real = ids_for(51);
    let fake = FakeResolver::held(move |code| {
        if decode(code) == Ok(real) {
            Err(ResolveError::Timeout)
        } else {
            Err(ResolveError::NotFound)
        }
    });
    let h = with_resolver(fake.clone(), |d| config(d, 40 * KB as u64));
    let forged = encode(&ShareCode { token: 7, ..real });
    let post = |code: String, ip: &'static str| {
        let app = h.app.clone();
        async move { call_json(&app, post_code(&code, ip)).await }
    };
    let (status, v) = post(forged.clone(), "203.0.113.1").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let forged_id = v["demoId"].as_str().unwrap().to_owned();
    let (status, v) = post(encode(&real), "203.0.113.2").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let real_id = v["demoId"].as_str().unwrap().to_owned();
    assert_ne!(real_id, forged_id);

    fake.release();
    let r = wait_until_finished(&h.store, &forged_id).await;
    assert_eq!(r.error, Some(ResolveError::NotFound.to_string()), "{r:?}");
    let r = wait_until_finished(&h.store, &real_id).await;
    assert_eq!(r.error, Some(ResolveError::Timeout.to_string()), "{r:?}");
    let (status, _) = post(forged, "203.0.113.3").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, v) = post(encode(&real), "203.0.113.4").await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    until("the real code's second lookup", || fake.calls() == 3).await;
}

/// Share-code posts count against the client's attempts before the code is even read, like URL
/// posts and upload starts: text without a code, a code the site has (answered from the index,
/// without an ingest) and a code Valve refused all count, so one address cannot keep the index
/// and the lookups busy for free (security audit 2026-10-23); other clients are unaffected.
#[tokio::test]
async fn share_code_posts_count_against_the_attempt_limit() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        attempts_per_hour: 4,
        ..config(d, 40 * KB as u64)
    });
    let (known, _) = h.store.claim_match(&ids_for(7), &Store::new_id());
    std::fs::write(h.store.pack_path(&"ab".repeat(32)), b"pack").unwrap();
    h.store.update(&known.id, |r| {
        r.status = Status::Done;
        r.sha256 = Some("ab".repeat(32));
    });
    let ip = "198.51.100.9";
    let (status, _) = call_json(&h.app, post_code("no code here", ip)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = call_json(&h.app, post_code(&code_for(7), ip)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, v) = call_json(&h.app, post_code(&code_for(8), ip)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    wait_until_finished(&h.store, v["demoId"].as_str().unwrap()).await;
    let (status, _) = call_json(&h.app, post_code(&code_for(8), ip)).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    for text in [
        "no code here".to_owned(),
        code_for(7),
        code_for(8),
        code_for(9),
    ] {
        let (status, v) = call_json(&h.app, post_code(&text, ip)).await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{text}: {v}");
    }
    assert_eq!(fake.calls(), 1);
    let (status, v) = call_json(&h.app, post_code(&code_for(7), "198.51.100.10")).await;
    assert_eq!((status, &v["demoId"]), (StatusCode::OK, &json!(known.id)));
}

/// `POST /api/demos` takes a URL or a share code, not both and not neither; the share code may
/// sit in other text (CS2's "copy share link"), and text without one is refused before anything
/// is looked up.
#[tokio::test]
async fn a_post_takes_a_url_or_a_share_code() {
    let fake = FakeResolver::held(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| config(d, 40 * KB as u64));
    for body in [
        json!({"url": "https://replay123.valve.net/730/a.dem.bz2", "sharecode": CODE}),
        json!({}),
        json!({"url": null, "sharecode": null}),
    ] {
        let (status, v) = call_json(
            &h.app,
            post_json("/api/demos", body.clone(), "198.51.100.1"),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}: {v}");
    }
    for text in [
        "hello",
        "CSGO-GADqf-jjyJ8",
        "https://replay123.valve.net/730/a.dem.bz2",
        "CSGO-IIIII-jjyJ8-cSP2r-smZRo-TO2xK",
        "CSGO-99999-99999-99999-99999-99999",
    ] {
        let (status, v) = call_json(&h.app, post_code(text, "198.51.100.1")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{text}: {v}");
        assert_eq!(v["error"], ResolveError::Invalid.to_string());
    }
    let link = format!("steam://rungame/730/76561202255233023/+csgo_download_match%20{CODE}");
    let (status, v) = call_json(&h.app, post_code(&link, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let r = h.store.get(v["demoId"].as_str().unwrap()).unwrap();
    assert_eq!(r.match_id.as_deref(), Some(CODE_MATCH));
    until("the lookup", || fake.calls() == 1).await;
}

/// Valve's "expired" is remembered for the match: the next post of its code, from anyone, gets
/// the same answer at once, without a lookup.
#[tokio::test]
async fn an_expired_lookup_is_answered_from_the_cache() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::Expired));
    let h = with_resolver(fake.clone(), |d| config(d, 40 * KB as u64));
    let (status, v) = call_json(&h.app, post_code(CODE, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let r = wait_until_finished(&h.store, v["demoId"].as_str().unwrap()).await;
    assert_eq!(
        (r.status, r.error),
        (Status::Error, Some(ResolveError::Expired.to_string()))
    );
    for ip in ["198.51.100.1", "198.51.100.2"] {
        let (status, v) = call_json(&h.app, post_code(CODE, ip)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{v}");
        assert_eq!(v["error"], ResolveError::Expired.to_string());
    }
    assert_eq!(fake.calls(), 1);
}

/// What a crosshair code gets: Valve has no match for it, and the demo says so.
#[tokio::test]
async fn a_code_valve_has_no_match_for_ends_in_the_not_found_copy() {
    let fake = FakeResolver::answering(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| config(d, 40 * KB as u64));
    let (status, v) = call_json(&h.app, post_code(CODE, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let id = v["demoId"].as_str().unwrap().to_owned();
    wait_until_finished(&h.store, &id).await;
    let (_, v) = call_json(&h.app, get(&format!("/api/demos/{id}"))).await;
    assert_eq!(v["status"], "error");
    assert_eq!(
        v["error"],
        "Valve has no match for this code (crosshair codes look the same)"
    );
}

/// With the share-code service offline, a share code is refused at once with the offline copy:
/// no record, no lookup, and none of the poster's ingests spent. A job queued before it went
/// offline fails at once with the same copy. Neither is remembered, so the code works once the
/// service is back.
#[tokio::test]
async fn an_offline_resolver_refuses_share_codes_at_once() {
    let fake = FakeResolver::held(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        ingests_per_hour: 3,
        ..config(d, 40 * KB as u64)
    });
    let mut queued = Vec::new();
    for match_id in [1, 2] {
        let (status, v) = call_json(&h.app, post_code(&code_for(match_id), "198.51.100.1")).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        queued.push(v["demoId"].as_str().unwrap().to_owned());
        until("the first lookup", || fake.calls() == 1).await;
    }

    fake.set_online(false);
    let (_, v) = call_json(&h.app, get("/api/site")).await;
    assert_eq!(v, json!({"sharecodes": false}));
    let started = std::time::Instant::now();
    let (status, v) = call_json(&h.app, post_code(CODE, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert_eq!(v["error"], ResolveError::Offline.to_string());
    assert!(started.elapsed() < Duration::from_secs(2));
    let records: Vec<Value> =
        serde_json::from_slice(&std::fs::read(h.cfg.data_dir.join("demos.json")).unwrap()).unwrap();
    assert_eq!(records.len(), 2, "{records:?}");
    // The lookup in progress gets its answer; the one waiting behind it is not sent.
    fake.release();
    let r = wait_until_finished(&h.store, &queued[0]).await;
    assert_eq!(r.error, Some(ResolveError::NotFound.to_string()));
    let r = wait_until_finished(&h.store, &queued[1]).await;
    assert_eq!(r.error, Some(ResolveError::Offline.to_string()));
    assert_eq!(fake.calls(), 1);

    fake.set_online(true);
    let (_, v) = call_json(&h.app, get("/api/site")).await;
    assert_eq!(v, json!({"sharecodes": true}));
    // The poster's third ingest is still there.
    let (status, v) = call_json(&h.app, post_code(CODE, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    let r = wait_until_finished(&h.store, v["demoId"].as_str().unwrap()).await;
    assert_eq!(r.error, Some(ResolveError::NotFound.to_string()));
    assert_eq!(fake.calls(), 2);
}

/// While [`MAX_WAITING`] lookups wait behind the one in progress, a new share code is refused
/// at once with the busy copy and spends none of the poster's ingests; a code already being
/// looked up still gets its demo.
#[tokio::test]
async fn a_full_lookup_queue_refuses_new_share_codes_at_once() {
    let fake = FakeResolver::held(|_| Err(ResolveError::NotFound));
    let in_line = MAX_WAITING as u64 + 1;
    let mut lookups: Option<Arc<ShareCodes>> = None;
    let h = harness(
        |d| Config {
            ingests_per_hour: in_line as u32 + 1,
            ..config(d, 40 * KB as u64)
        },
        |store, cfg| {
            let hooks = Hooks {
                resolver: Some(fake.clone()),
                ..Hooks::default()
            };
            let jobs = jobs::spawn_runner_with(store, cfg, hooks);
            lookups = jobs.sharecodes().cloned();
            jobs
        },
    );
    let lookups = lookups.unwrap();
    let mut queued = Vec::new();
    // From several clients, as one may have only FETCHES_PER_CLIENT on their way.
    let ip = |match_id: u64| format!("198.51.100.{}", 10 + match_id);
    for match_id in 1..=in_line {
        let (status, v) = call_json(&h.app, post_code(&code_for(match_id), &ip(match_id))).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        queued.push(v["demoId"].as_str().unwrap().to_owned());
    }
    until("the queue to fill", || lookups.busy()).await;
    assert_eq!(fake.calls(), 1);

    let started = std::time::Instant::now();
    let (status, v) = call_json(&h.app, post_code(CODE, &ip(1))).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert_eq!(v["error"], ResolveError::Busy.to_string());
    assert!(started.elapsed() < Duration::from_secs(2));
    let (status, v) = call_json(&h.app, post_code(&code_for(in_line), "198.51.100.2")).await;
    assert_eq!(
        (status, &v["demoId"]),
        (StatusCode::ACCEPTED, &json!(queued.last().unwrap()))
    );

    fake.release();
    for id in &queued {
        let r = wait_until_finished(&h.store, id).await;
        assert_eq!(r.error, Some(ResolveError::NotFound.to_string()));
    }
    assert!(!lookups.busy());
    // The refused post spent nothing: the poster has its ingests left.
    let (status, v) = call_json(&h.app, post_code(CODE, &ip(1))).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
}

/// Share-code jobs take the same places as URL jobs from their post until their file reaches
/// the parse queue, the lookup included: [`FETCHES_PER_CLIENT`] per client (429), `max_fetches`
/// in all (503), refused before a record or an ingest; the places come back as the jobs end.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn share_code_jobs_take_the_same_places_as_url_jobs() {
    let fake = FakeResolver::held(|_| Err(ResolveError::NotFound));
    let h = with_resolver(fake.clone(), |d| Config {
        max_fetches: 4,
        ingests_per_hour: 5,
        ..config(d, 40 * KB as u64)
    });
    let (a, b, c) = ("198.51.100.1", "198.51.100.2", "198.51.100.3");
    let mut queued = Vec::new();
    for match_id in 1..=FETCHES_PER_CLIENT as u64 {
        let (status, v) = call_json(&h.app, post_code(&code_for(match_id), a)).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        queued.push(v["demoId"].as_str().unwrap().to_owned());
    }
    let (status, v) = call_json(&h.app, post_code(&code_for(10), a)).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{v}");
    assert!(
        v["error"].as_str().unwrap().contains("still being fetched"),
        "{v}"
    );
    // A code already on its way still answers with its demo.
    let (status, v) = call_json(&h.app, post_code(&code_for(1), a)).await;
    assert_eq!(
        (status, &v["demoId"]),
        (StatusCode::ACCEPTED, &json!(queued[0]))
    );
    let (status, v) = call_json(&h.app, post_code(&code_for(11), b)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
    queued.push(v["demoId"].as_str().unwrap().to_owned());
    for _ in 0..5 {
        let (status, v) = call_json(&h.app, post_code(&code_for(12), c)).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
        assert!(v["error"].as_str().unwrap().contains("busy"), "{v}");
    }
    assert_eq!(h.store.find_match(&ids_for(12)), None);

    fake.release();
    for id in &queued {
        wait_until_finished(&h.store, id).await;
    }
    let (status, v) = call_json(&h.app, post_code(&code_for(12), c)).await;
    assert_eq!(status, StatusCode::ACCEPTED, "{v}");
}

/// A resolver answer that is not a Valve replay link, or that is about another match, fails
/// the job before anything is downloaded.
#[tokio::test]
async fn an_answer_off_valve_or_for_another_match_fails_the_job() {
    let fake = FakeResolver::answering(|code| {
        let off_valve = code == code_for(1);
        Ok(Resolved {
            match_id: if off_valve { 1 } else { 3 },
            url: if off_valve {
                "http://evil.example/730/000000000000000000001_1.dem.bz2"
            } else {
                "http://replay183.valve.net/730/000000000000000000002_1.dem.bz2"
            }
            .parse()
            .unwrap(),
            played_unix: None,
        })
    });
    let h = with_resolver(fake.clone(), |d| config(d, 40 * KB as u64));
    for match_id in [1, 2] {
        let (status, v) = call_json(&h.app, post_code(&code_for(match_id), "198.51.100.1")).await;
        assert_eq!(status, StatusCode::ACCEPTED, "{v}");
        let r = wait_until_finished(&h.store, v["demoId"].as_str().unwrap()).await;
        assert_eq!(
            (r.status, r.error.as_deref()),
            (
                Status::Error,
                Some("The share-code service returned an unexpected link")
            ),
            "{match_id}"
        );
    }
    assert_eq!(files_in(&h.cfg.data_dir.join("tmp")), Vec::<String>::new());
}

/// Without `DEMOVIEWER_GCBOT_URL` the server takes no share codes, and says so.
#[tokio::test]
async fn without_gcbot_a_share_code_is_503() {
    let (h, mut rx) = stub(40 * KB as u64);
    let (status, v) = call_json(&h.app, post_code(CODE, "198.51.100.1")).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert!(v["error"].as_str().unwrap().contains("share codes"), "{v}");
    assert!(rx.try_recv().is_err());
    let (_, v) = call_json(&h.app, get("/api/site")).await;
    assert_eq!(v, json!({"sharecodes": false}));
}
