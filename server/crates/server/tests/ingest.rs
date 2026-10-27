//! URL ingest: the SSRF guard (scheme, host, the Valve-only allowlist, private addresses,
//! re-checked on every redirect hop), the size-capped streaming download, and decompression by
//! magic.
//!
//! Only `replayN.valve.net` passes the allowlist, and the local axum test servers live on
//! 127.0.0.1, which `download` refuses by design. So the download tests go through
//! `download_testing`: the same code path with a replay host name resolved to the test server
//! instead of by DNS, and that one socket address (the first-hop server) let through. Every
//! other hop, including a second test server on another port, is guarded exactly as in
//! production.

use std::io::Write;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use demoviewer_server::ingest::{
    check_redirect, check_url, decompress_to_dem_within, download, download_testing, is_private,
    UrlError, MAX_INFLATE_RATIO,
};

// ---------------------------------------------------------------- is_private

#[test]
fn is_private_table() {
    let private = [
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.0.1",
        "192.168.255.255",
        "127.0.0.1",
        "127.8.9.10",
        "169.254.0.1",
        "169.254.169.254",
        "100.64.0.1",
        "100.127.255.255",
        "0.0.0.0",
        "::1",
        "::",
        "fc00::1",
        "fdff:ffff::1",
        "fe80::1",
        "febf::1",
        "::ffff:127.0.0.1",
        "::ffff:10.1.2.3",
        "::ffff:172.16.0.1",
        "::ffff:192.168.0.1",
        "::ffff:169.254.169.254",
        "::ffff:100.64.0.1",
        "::ffff:0.0.0.0",
        "192.0.0.1",
        "192.0.2.1",
        "198.18.0.1",
        "198.19.255.255",
        "198.51.100.1",
        "203.0.113.1",
        "2002:7f00:1::1",
        "2002:c0a8:101::1",
        "2002:a00:1::1",
        "64:ff9b:1::1",
    ];
    let public = [
        "2002:808:808::1",
        "8.8.8.8",
        "1.1.1.1",
        "34.126.236.240",
        "9.255.255.255",
        "11.0.0.0",
        "172.15.255.255",
        "172.32.0.0",
        "192.167.255.255",
        "192.169.0.0",
        "100.63.255.255",
        "100.128.0.0",
        "169.253.255.255",
        "169.255.0.0",
        "2606:4700:4700::1111",
        "2600:1900:8010:1360::",
        "::ffff:8.8.8.8",
    ];
    for s in private {
        let ip: IpAddr = s.parse().unwrap();
        assert!(is_private(ip), "{s} must be private");
    }
    for s in public {
        let ip: IpAddr = s.parse().unwrap();
        assert!(!is_private(ip), "{s} must be public");
    }
}

// ---------------------------------------------------------------- check_url

#[test]
fn check_url_refuses_non_http_schemes() {
    assert_eq!(check_url("ftp://x.dem"), Err(UrlError::Scheme));
    assert_eq!(check_url("file:///etc/passwd.dem"), Err(UrlError::Scheme));
    assert_eq!(
        check_url("gopher://example.com/a.dem"),
        Err(UrlError::Scheme)
    );
}

#[test]
fn check_url_refuses_localhost() {
    let err = check_url("http://localhost/a.dem").unwrap_err();
    assert!(
        matches!(err, UrlError::Host | UrlError::PrivateAddress),
        "localhost: {err:?}"
    );
    // A trailing dot does not make it a dotted name.
    let err = check_url("http://localhost./a.dem").unwrap_err();
    assert!(
        matches!(err, UrlError::Host | UrlError::PrivateAddress),
        "localhost.: {err:?}"
    );
}

#[test]
fn check_url_refuses_ip_literals_in_every_spelling() {
    // An IP literal is never a Valve replay host, private or not.
    for u in [
        "http://127.0.0.1:1/a.dem",
        "http://127.0.0.1/a.dem",
        "http://2130706433/a.dem", // 127.0.0.1 as one integer
        "http://0x7f.0.0.1/a.dem", // hex octet
        "http://0177.0.0.1/a.dem", // octal octet
        "http://0.0.0.0/a.dem",
        "http://169.254.169.254/latest.dem",
        "http://192.168.1.1/x.dem.gz",
        "http://10.0.0.5:8080/x.dem.bz2",
        "http://100.64.1.1/x.dem",
        "http://[::1]/a.dem",
        "http://[::ffff:127.0.0.1]/a.dem",
        "http://[::ffff:7f00:1]/a.dem",
        "http://[fe80::1]/a.dem",
        "http://[fd00::1]/a.dem",
        "http://8.8.8.8/x.dem",
    ] {
        assert_eq!(check_url(u), Err(UrlError::NotAllowed), "{u}");
    }
}

#[test]
fn check_url_accepts_valve_replay_host() {
    let url =
        check_url("https://replay123.valve.net/730/x.dem.bz2").expect("replay host is allowed");
    assert_eq!(url.host_str(), Some("replay123.valve.net"));
}

#[test]
fn check_url_allowlist() {
    assert_eq!(
        check_url("https://example.com/file.zip"),
        Err(UrlError::NotAllowed)
    );
    // Only Valve's replay servers: a demo file anywhere else is refused, whatever its name.
    for u in [
        "https://replay123.valve.net.evil.example/x.zip",
        "https://replay123.valve.net.evil.example/730/x.dem.bz2",
        "https://evilreplay1.valve.net/x.zip",
        "https://replayx.valve.net/x.zip",
        "https://replay.valve.net/x.zip",
        "https://replay1.valve.com/730/x.dem.bz2",
        "https://valve.net/730/x.dem.bz2",
        "https://www.valve.net/730/x.dem.bz2",
        "https://replay123.valve.net@evil.example/730/x.dem.bz2",
        "https://example.com/x.dem",
        "https://example.com/730/x.dem.bz2",
        "https://cdn.example.com/x.dem.gz?replay123.valve.net",
        "http://8.8.8.8/x.dem",
        "http://8.8.8.8/a/b/x.dem.bz2",
        "https://8.8.8.8:8443/x.dem.gz",
    ] {
        assert_eq!(check_url(u), Err(UrlError::NotAllowed), "{u}");
    }
}

#[test]
fn check_url_refuses_bad_hosts() {
    assert_eq!(check_url("http://"), Err(UrlError::Host));
    assert_eq!(check_url("http://intranet/a.dem"), Err(UrlError::Host));
    assert_eq!(check_url("http://nas:8080/a.dem"), Err(UrlError::Host));
}

// ---------------------------------------------------------------- redirect hop check

#[tokio::test]
async fn redirect_hop_off_valve_is_refused() {
    let target = serve(Router::new().route("/x.dem", get(|| async { "secret" }))).await;
    let from = url::Url::parse("https://replay123.valve.net/730/a.dem.bz2").unwrap();
    let location = format!("http://127.0.0.1:{}/x.dem", target.port());
    assert_eq!(check_redirect(&from, &location), Err(UrlError::NotAllowed));
    assert_eq!(
        check_redirect(&from, "http://192.168.0.10/x.dem"),
        Err(UrlError::NotAllowed)
    );
    assert_eq!(
        check_redirect(&from, "https://example.com/730/a.dem.bz2"),
        Err(UrlError::NotAllowed)
    );
    assert_eq!(
        check_redirect(&from, "ftp://replay1.valve.net/x.dem"),
        Err(UrlError::Scheme)
    );
}

#[test]
fn redirect_hop_resolves_relative_locations() {
    let from = url::Url::parse("https://replay123.valve.net/730/a.dem.bz2").unwrap();
    let next = check_redirect(&from, "/b.dem").unwrap();
    assert_eq!(next.as_str(), "https://replay123.valve.net/b.dem");
    let next = check_redirect(&from, "c.dem.gz").unwrap();
    assert_eq!(next.as_str(), "https://replay123.valve.net/730/c.dem.gz");
    assert_eq!(
        check_redirect(&from, "//example.com/c.dem"),
        Err(UrlError::NotAllowed)
    );
}

// ---------------------------------------------------------------- download

const MB: usize = 1_000_000;

fn payload(len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
    while out.len() < len {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        out.extend_from_slice(&x.to_le_bytes());
    }
    out.truncate(len);
    out
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

fn found(location: String) -> impl IntoResponse {
    (StatusCode::FOUND, [(header::LOCATION, location)])
}

/// A server whose `/x.dem` counts its hits and answers with 1 MB.
async fn counting_target() -> (SocketAddr, Arc<AtomicUsize>) {
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let addr = serve(Router::new().route(
        "/x.dem",
        get(move || {
            let h = h.clone();
            async move {
                h.fetch_add(1, Ordering::SeqCst);
                payload(MB)
            }
        }),
    ))
    .await;
    (addr, hits)
}

/// The replay host the download tests' first hop answers as.
const REPLAY: &str = "replay183.valve.net";

/// `path` on `host` (a replay host name) at the port of the test server `addr`.
fn replay_url(host: &str, addr: SocketAddr, path: &str) -> url::Url {
    url::Url::parse(&format!("http://{host}:{}{path}", addr.port())).unwrap()
}

/// Downloads `path` from the test server `server` as [`REPLAY`], with `server` let through.
async fn fetch(server: SocketAddr, path: &str, dest: &Path, max: u64) -> Result<u64, UrlError> {
    let url = replay_url(REPLAY, server, path);
    download_testing(&url, dest, max, &[server], &[(REPLAY.into(), server)]).await
}

#[tokio::test]
async fn download_refuses_redirect_to_a_replay_name_that_resolves_to_loopback() {
    let (target, target_hits) = counting_target().await;
    let other = "replay184.valve.net";
    let first = serve(Router::new().route(
        "/x.dem",
        get(move || async move { found(replay_url(other, target, "/x.dem").to_string()) }),
    ))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");

    // The second name resolves to the target, which is not let through.
    let hosts = [(REPLAY.into(), first), (other.into(), target)];
    let url = replay_url(REPLAY, first, "/x.dem");
    let res = download_testing(&url, &dest, 10 * MB as u64, &[first], &hosts).await;
    assert_eq!(res, Err(UrlError::PrivateAddress));
    assert_eq!(
        target_hits.load(Ordering::SeqCst),
        0,
        "the private hop was contacted"
    );
    assert!(!dest.exists());
}

#[tokio::test]
async fn download_refuses_redirects_off_valve() {
    let first = serve(
        Router::new()
            .route(
                "/a.dem",
                get(|| async { found("http://192.168.1.1/x.dem".into()) }),
            )
            .route(
                "/b.dem",
                get(|| async { found("https://example.com/x.dem".into()) }),
            ),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    for path in ["/a.dem", "/b.dem"] {
        let res = fetch(first, path, &dest, 10 * MB as u64).await;
        assert_eq!(res, Err(UrlError::NotAllowed), "{path}");
        assert!(!dest.exists());
    }
}

#[tokio::test]
async fn download_without_exemption_refuses_loopback_first_hop() {
    let (target, hits) = counting_target().await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    // Production refuses the address outright...
    let url = url::Url::parse(&format!("http://{target}/x.dem")).unwrap();
    let res = download(&url, &dest, 10 * MB as u64).await;
    assert_eq!(res, Err(UrlError::NotAllowed));
    // ...and a replay name that resolves to it is refused for its address.
    let url = replay_url(REPLAY, target, "/x.dem");
    let res = download_testing(&url, &dest, 10 * MB as u64, &[], &[(REPLAY.into(), target)]).await;
    assert_eq!(res, Err(UrlError::PrivateAddress));
    assert_eq!(hits.load(Ordering::SeqCst), 0);
    assert!(!dest.exists());
}

#[tokio::test]
async fn download_follows_allowed_redirects_and_streams_to_disk() {
    let body = payload(MB);
    let expected = body.clone();
    let server = serve(
        Router::new()
            .route("/a.dem", get(|| async { found("/b.dem".into()) }))
            .route(
                "/b.dem",
                get(|| async { (StatusCode::MOVED_PERMANENTLY, [(header::LOCATION, "c.dem")]) }),
            )
            .route("/c.dem", get(move || async move { body })),
    )
    .await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    let n = fetch(server, "/a.dem", &dest, 2 * MB as u64).await.unwrap();
    assert_eq!(n, MB as u64);
    assert_eq!(std::fs::read(&dest).unwrap(), expected);
}

#[tokio::test]
async fn download_gives_up_after_five_redirects() {
    let server =
        serve(Router::new().route("/loop.dem", get(|| async { found("/loop.dem".into()) }))).await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    let res = fetch(server, "/loop.dem", &dest, MB as u64).await;
    assert!(matches!(res, Err(UrlError::Redirect(_))), "{res:?}");
    assert!(!dest.exists());
}

#[tokio::test]
async fn download_reports_http_status() {
    let server = serve(Router::new()).await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    let res = fetch(server, "/gone.dem", &dest, MB as u64).await;
    assert_eq!(res, Err(UrlError::Http(404)));
    assert!(!dest.exists());
}

/// A download the server cannot write says so without the path or the OS error, which go to
/// the log: the message reaches the demo's link (code-health review 2026-10-26: it read
/// "writing /data/tmp/<id>.download: …"). A server that cannot be reached is described the
/// same way, not by reqwest's cause chain.
#[tokio::test]
async fn download_failures_name_no_path_or_os_error() {
    let server = serve(Router::new().route("/x.dem", get(|| async { payload(MB) }))).await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("missing").join("out.dem");
    let res = fetch(server, "/x.dem", &dest, 2 * MB as u64).await;
    assert_eq!(
        res,
        Err(UrlError::Io(
            "the server could not store the download; try again later".into()
        ))
    );

    // Nothing listens there any more.
    let closed = {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        listener.local_addr().unwrap()
    };
    let res = fetch(closed, "/x.dem", &dir.path().join("out.dem"), MB as u64).await;
    assert_eq!(
        res,
        Err(UrlError::Io("cannot connect to the replay server".into()))
    );
}

#[tokio::test]
async fn download_too_large_with_content_length() {
    let server = serve(Router::new().route("/x.dem", get(|| async { payload(MB) }))).await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    let res = fetch(server, "/x.dem", &dest, 100_000).await;
    assert_eq!(res, Err(UrlError::TooLarge));
    assert!(!dest.exists());
}

#[tokio::test]
async fn download_too_large_while_streaming_without_length() {
    // Chunked transfer, no Content-Length: the cap has to hold while counting bytes.
    let server = serve(Router::new().route(
        "/x.dem",
        get(|| async {
            let chunks =
                (0..16).map(|_| Ok::<_, std::convert::Infallible>(Bytes::from(payload(65_536))));
            Body::from_stream(futures_util::stream::iter(chunks))
        }),
    ))
    .await;
    let dir = tempfile::tempdir().unwrap();
    let dest = dir.path().join("out.dem");
    let res = fetch(server, "/x.dem", &dest, 100_000).await;
    assert_eq!(res, Err(UrlError::TooLarge));
    assert!(!dest.exists());
}

// ---------------------------------------------------------------- decompress_to_dem_within

fn fake_demo() -> Vec<u8> {
    let mut v = b"PBDEMS2\0".to_vec();
    v.extend(payload(300_000));
    v.extend(std::iter::repeat_n(7u8, 200_000));
    v
}

fn bz(data: &[u8]) -> Vec<u8> {
    let mut e = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn gz(data: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(data).unwrap();
    e.finish().unwrap()
}

fn write(dir: &Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

#[test]
fn decompress_bz2_gz_and_raw_give_identical_output() {
    let dir = tempfile::tempdir().unwrap();
    let raw = fake_demo();
    let inputs = [
        ("raw", raw.clone()),
        ("bz2", bz(&raw)),
        ("gz", gz(&raw)),
        // Two concatenated gzip members (what `cat a.gz b.gz` or pigz can produce).
        ("gz2", [gz(&raw[..1000]), gz(&raw[1000..])].concat()),
        // Two concatenated bzip2 streams (pbzip2 output).
        ("bz2x2", [bz(&raw[..1000]), bz(&raw[1000..])].concat()),
    ];
    for (name, bytes) in inputs {
        let src = write(dir.path(), &format!("in.{name}"), &bytes);
        let dest = dir.path().join(format!("out.{name}.dem"));
        decompress_to_dem_within(&src, &dest, u64::MAX).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert!(
            std::fs::read(&dest).unwrap() == raw,
            "{name}: output differs"
        );
    }
}

#[test]
fn decompress_rejects_non_demos_with_invalid_data() {
    let dir = tempfile::tempdir().unwrap();
    let hl2 = [&b"HL2DEMO\0"[..], &payload(4096)[..]].concat();
    let cases = [
        ("random", payload(100_000)),
        ("empty", Vec::new()),
        ("short", b"PBD".to_vec()),
        ("hl2demo", hl2.clone()),
        ("gz-random", gz(&payload(100_000))),
        ("bz2-hl2demo", bz(&hl2)),
        ("truncated-bz2", bz(&fake_demo())[..5_000].to_vec()),
        ("truncated-gz", gz(&fake_demo())[..5_000].to_vec()),
        ("bad-bz2", [&b"BZh9"[..], &payload(1000)[..]].concat()),
    ];
    for (name, bytes) in cases {
        let src = write(dir.path(), name, &bytes);
        let dest = dir.path().join(format!("{name}.dem"));
        let err = decompress_to_dem_within(&src, &dest, u64::MAX).expect_err(name);
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{name}: {err}");
        assert!(!dest.exists(), "{name}: partial output left behind");
    }
}

#[test]
fn decompress_names_csgo_demos() {
    let dir = tempfile::tempdir().unwrap();
    let src = write(
        dir.path(),
        "old.dem",
        &[&b"HL2DEMO\0"[..], &[0u8; 64][..]].concat(),
    );
    let err = decompress_to_dem_within(&src, &dir.path().join("out.dem"), u64::MAX).unwrap_err();
    assert!(err.to_string().contains("CS:GO"), "{err}");
}

/// Inflating within the room the disk has above its floor stops there, as `StorageFull`, with
/// nothing left behind, also for a file well within the ratio and size caps; a file that fits
/// is written whole, and a raw demo is copied within the same room (security audit 2026-10-23).
#[test]
fn decompress_stops_at_the_room_it_is_given() {
    let dir = tempfile::tempdir().unwrap();
    let raw = fake_demo();
    for (name, bytes) in [("raw", raw.clone()), ("bz2", bz(&raw)), ("gz", gz(&raw))] {
        let src = write(dir.path(), &format!("in.{name}"), &bytes);
        let dest = dir.path().join(format!("out.{name}.dem"));
        let err = decompress_to_dem_within(&src, &dest, raw.len() as u64 - 1).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::StorageFull, "{name}: {err}");
        assert!(!dest.exists(), "{name}");
        decompress_to_dem_within(&src, &dest, raw.len() as u64).unwrap();
        assert!(std::fs::read(&dest).unwrap() == raw, "{name}");
    }
    // The ratio and size caps still say what they say when the room is larger.
    let bomb = write(
        dir.path(),
        "bomb.gz",
        &gz(&[&raw[..8], &[0u8; 4 << 20][..]].concat()),
    );
    let err = decompress_to_dem_within(&bomb, &dir.path().join("bomb.dem"), u64::MAX).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{err}");
    assert!(err.to_string().contains("times its size"), "{err}");
}

/// A small compressed file may not inflate to a huge one: demos shrink about 1.5 times, so
/// more than `MAX_INFLATE_RATIO` times is refused, long before `MAX_DEM_BYTES`.
#[test]
fn decompress_refuses_an_implausible_inflate_ratio() {
    let dir = tempfile::tempdir().unwrap();
    let bomb = [&b"PBDEMS2\0"[..], &vec![0u8; 4 << 20][..]].concat();
    for (name, bytes) in [("bz2", bz(&bomb)), ("gz", gz(&bomb))] {
        assert!((bytes.len() as u64) * MAX_INFLATE_RATIO < bomb.len() as u64);
        let src = write(dir.path(), &format!("bomb.{name}"), &bytes);
        let dest = dir.path().join(format!("bomb.{name}.dem"));
        let err = decompress_to_dem_within(&src, &dest, u64::MAX).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{name}: {err}");
        assert!(err.to_string().contains("20 times"), "{name}: {err}");
        assert!(!dest.exists(), "{name}");
    }
}

#[test]
fn decompress_does_not_touch_dest_when_source_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let dest = write(dir.path(), "keep.dem", b"existing");
    let err = decompress_to_dem_within(&dir.path().join("nope"), &dest, u64::MAX).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::NotFound);
    assert_eq!(std::fs::read(&dest).unwrap(), b"existing");
}

#[test]
fn a_missing_replay_says_it_may_have_expired() {
    for code in [404, 410] {
        let msg = UrlError::Http(code).to_string();
        assert!(msg.contains("expired"), "{msg}");
        assert!(msg.contains("about a month"), "{msg}");
    }
    assert_eq!(
        UrlError::Http(503).to_string(),
        "the server answered HTTP 503"
    );
}
