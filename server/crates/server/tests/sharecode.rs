//! Share codes: the codec (akiver/csgo-sharecode's algorithm, checked against its README vector
//! and the ids of four real matches), finding a code in pasted text, the lookups the runner
//! makes through a resolver (one at a time, offline at once, Valve's answers checked and its
//! refusals remembered), and the client of gcbot's HTTP API against a local stand-in.

mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use demoviewer_server::gcbot::{
    GcbotClient, ResolveError, Resolved, Resolver, ShareCodes, MAX_WAITING,
};
use demoviewer_server::sharecode::{decode, encode, extract, ShareCode, ShareCodeError};
use serde_json::{json, Value};
use url::Url;

use common::FakeResolver;

const CODE: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

#[test]
fn decodes_akivers_readme_vector() {
    assert_eq!(
        decode(CODE),
        Ok(ShareCode {
            match_id: 3230642215713767580,
            outcome_id: 3230647599455273103,
            token: 55788,
        })
    );
    assert_eq!(encode(&decode(CODE).unwrap()), CODE);
}

/// (match id, reservation id, TV port) of four real matches, from the `.dem.info` files CS2
/// keeps beside downloaded replays (`match730_<reservation>_<tv port>_<replay server>.dem.info`).
/// A share code holds the reservation id as its outcome id and the TV port's low 16 bits.
const MATCHES: [(u64, u64, u32); 4] = [
    (3837786673941315625, 3837789388360646804, 1912149738),
    (3840641796401004951, 3840645724148597258, 1208867137),
    (3840736601361612910, 3840740872706588721, 967397881),
    (3842529956366123476, 3842533959275642952, 1783431197),
];

#[test]
fn real_matches_round_trip() {
    for (match_id, reservation, tv_port) in MATCHES {
        let sc = ShareCode {
            match_id,
            outcome_id: reservation,
            token: tv_port as u16,
        };
        let code = encode(&sc);
        assert_eq!(extract(&code).as_deref(), Some(code.as_str()), "{code}");
        assert_eq!(decode(&code), Ok(sc), "{code}");
    }
    // The extremes fit: 57^25 > 2^144.
    for sc in [
        ShareCode {
            match_id: 0,
            outcome_id: 0,
            token: 0,
        },
        ShareCode {
            match_id: u64::MAX,
            outcome_id: u64::MAX,
            token: u16::MAX,
        },
    ] {
        assert_eq!(decode(&encode(&sc)), Ok(sc));
    }
}

#[test]
fn a_wrong_shape_or_letter_is_an_error() {
    for bad in ['I', 'l', 'g', '0', '1'] {
        let code = format!("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x{bad}");
        assert_eq!(decode(&code), Err(ShareCodeError::Letter(bad)), "{code}");
    }
    for bad in [
        "",
        "CSGO-GADqf-jjyJ8",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK-AAAAA",
        "xCSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK",
        "CSGO_GADqf_jjyJ8_cSP2r_smZRo_TO2xK",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xKK",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xé",
    ] {
        assert_eq!(decode(bad), Err(ShareCodeError::Shape), "{bad:?}");
    }
    // The largest digit everywhere is a number over 18 bytes, which no encoder makes.
    assert_eq!(
        decode("CSGO-99999-99999-99999-99999-99999"),
        Err(ShareCodeError::TooLarge)
    );
}

/// The same cases as gcbot's `extractShareCode` (gcbot/test/sharecode.test.mjs).
#[test]
fn extract_finds_a_code_anywhere() {
    assert_eq!(extract(CODE).as_deref(), Some(CODE));
    assert_eq!(extract(&format!("  {CODE}\n")).as_deref(), Some(CODE));
    let link = format!("steam://rungame/730/76561202255233023/+csgo_download_match%20{CODE}");
    assert_eq!(extract(&link).as_deref(), Some(CODE));
    assert_eq!(
        extract(&format!("watch this: {link} gg")).as_deref(),
        Some(CODE)
    );
    // The first code wins; a longer last group is cut like the pattern cuts it.
    let second = "CSGO-AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
    assert_eq!(extract(&format!("{CODE} {second}")).as_deref(), Some(CODE));
    assert_eq!(extract(&format!("CSGO-x {CODE}")).as_deref(), Some(CODE));
    assert_eq!(extract(&format!("{CODE}K")).as_deref(), Some(CODE));
    assert_eq!(extract(&format!("東京{CODE}")).as_deref(), Some(CODE));

    for bad in [
        "CSGO-GADqf-jjyJ8",
        "http://replay183.valve.net/730/003710983364429447230_1612365234.dem.bz2",
        "https://cs.skunk.to/d/4f9Kq",
        "",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x",
        "csgo-GADqf-jjyJ8-cSP2r-smZRo-TO2xK",
        "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2x東",
    ] {
        assert_eq!(extract(bad), None, "{bad:?}");
    }
}

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

/// A TV port whose low 16 bits are `token` (a share code holds no more of it).
fn tv_port(token: u16) -> u32 {
    29_178 << 16 | u32::from(token)
}

/// Valve's replay URL for the match of share code `code`: `/730/<reservation id>_<TV port>`,
/// both zero-padded, the reservation id being the code's outcome id.
fn replay_url(code: &ShareCode) -> Url {
    let (reservation, port) = (code.outcome_id, tv_port(code.token));
    format!("http://replay183.valve.net/730/{reservation:021}_{port:010}.dem.bz2")
        .parse()
        .unwrap()
}

/// The answer for [`code_for`]`(match_id)`.
fn replay(match_id: u64) -> Resolved {
    Resolved {
        match_id,
        url: replay_url(&ids_for(match_id)),
        played_unix: Some(1_761_163_200),
        info: None,
    }
}

/// Lookups run one at a time.
#[tokio::test]
async fn lookups_run_one_at_a_time() {
    let fake = FakeResolver::slow(Duration::from_millis(30), |code| {
        Ok(replay(decode(code).unwrap().match_id))
    });
    let codes = Arc::new(ShareCodes::new(fake.clone()));
    let lookups: Vec<_> = (1..=5u64)
        .map(|id| {
            let codes = codes.clone();
            tokio::spawn(async move { codes.resolve(&ids_for(id)).await })
        })
        .collect();
    for (id, lookup) in (1..=5u64).zip(lookups) {
        assert_eq!(lookup.await.unwrap(), Ok(replay(id)));
    }
    assert_eq!(fake.calls(), 5);
    assert_eq!(fake.most_at_once(), 1, "two lookups overlapped");
}

/// Past [`MAX_WAITING`] lookups waiting for their turn, one more fails at once as busy without
/// asking the resolver. A lookup gives its place back when it gets its turn, or when it is
/// dropped while it waits.
#[tokio::test]
async fn lookups_past_the_queue_are_busy_at_once() {
    let fake = FakeResolver::held(|code| Ok(replay(decode(code).unwrap().match_id)));
    let codes = Arc::new(ShareCodes::new(fake.clone()));
    let lookup = |id: u64| {
        let codes = codes.clone();
        tokio::spawn(async move { codes.resolve(&ids_for(id)).await })
    };
    let first = lookup(1);
    until(|| fake.calls() == 1).await;
    let waiting: Vec<_> = (2..=MAX_WAITING as u64 + 1).map(lookup).collect();
    until(|| codes.busy()).await;
    let refused =
        tokio::time::timeout(Duration::from_millis(500), codes.resolve(&ids_for(99))).await;
    assert_eq!(refused, Ok(Err(ResolveError::Busy)), "it waited");

    waiting[0].abort();
    until(|| !codes.busy()).await;
    let late = lookup(100);
    until(|| codes.busy()).await;

    fake.release();
    assert_eq!(first.await.unwrap(), Ok(replay(1)));
    for (id, lookup) in (3..).zip(waiting.into_iter().skip(1)) {
        assert_eq!(lookup.await.unwrap(), Ok(replay(id)));
    }
    assert_eq!(late.await.unwrap(), Ok(replay(100)));
    assert!(!codes.busy());
    assert_eq!(fake.calls(), MAX_WAITING + 1);
}

/// While the resolver says it is offline, a lookup fails at once without asking it, also one
/// that was waiting for its turn.
#[tokio::test]
async fn an_offline_resolver_fails_lookups_at_once() {
    let fake = FakeResolver::held(|code| Ok(replay(decode(code).unwrap().match_id)));
    let codes = Arc::new(ShareCodes::new(fake.clone()));
    let first = tokio::spawn({
        let codes = codes.clone();
        async move { codes.resolve(&ids_for(1)).await }
    });
    until(|| fake.calls() == 1).await;
    let waiting = tokio::spawn({
        let codes = codes.clone();
        async move { codes.resolve(&ids_for(2)).await }
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    fake.set_online(false);
    let started = Instant::now();
    assert_eq!(codes.resolve(&ids_for(3)).await, Err(ResolveError::Offline));
    assert!(started.elapsed() < Duration::from_millis(500));
    fake.release();
    assert_eq!(first.await.unwrap(), Ok(replay(1)));
    assert_eq!(waiting.await.unwrap(), Err(ResolveError::Offline));
    assert_eq!(fake.calls(), 1);
}

/// An answer that is not a Valve replay link, or that is about another match, is refused.
#[tokio::test]
async fn answers_off_valve_or_for_another_match_are_bad() {
    let fake = FakeResolver::answering(|code| {
        let id = decode(code).unwrap().match_id;
        let mut r = replay(id);
        match id {
            1 => r.url = "http://evil.example/730/x.dem.bz2".parse().unwrap(),
            2 => r.match_id = 3,
            3 => {
                r.url = "http://replay183.valve.net.evil.example/x.dem.bz2"
                    .parse()
                    .unwrap()
            }
            4 => r.url = "ftp://replay183.valve.net/730/x.dem.bz2".parse().unwrap(),
            5 => r.url = "http://replay.valve.net/730/x.dem.bz2".parse().unwrap(),
            _ => {}
        }
        Ok(r)
    });
    let codes = ShareCodes::new(fake.clone());
    for id in 1..=5 {
        assert_eq!(
            codes.resolve(&ids_for(id)).await,
            Err(ResolveError::BadAnswer),
            "{id}"
        );
    }
    assert_eq!(codes.resolve(&ids_for(6)).await, Ok(replay(6)));
    // Unpadded numbers name the same replay.
    let https = Url::parse("https://replay12.valve.net/730/1_65537.dem.bz2").unwrap();
    let fake = FakeResolver::answering(move |_| {
        Ok(Resolved {
            url: https.clone(),
            ..replay(7)
        })
    });
    assert!(ShareCodes::new(fake).resolve(&ids_for(7)).await.is_ok());
}

/// An answer is taken only for the very code it names: its replay URL's reservation id must be
/// the code's outcome id and its TV port's low 16 bits the code's token, besides the match id.
/// gcbot can be handed the GC's late answer to an earlier lookup of another code of the same
/// match, such as the real code of a match a forgery names; taking it would give the forgery the
/// replay (security review 2026-10-23).
#[tokio::test]
async fn an_answer_for_another_code_of_the_match_is_bad() {
    let (match_id, reservation, port) = MATCHES[0];
    let real = ShareCode {
        match_id,
        outcome_id: reservation,
        token: port as u16,
    };
    let real_url: Url =
        format!("http://replay404.valve.net/730/{reservation:021}_{port:010}.dem.bz2")
            .parse()
            .unwrap();
    // The late answer to the real code's lookup, whatever is asked.
    let answer = Resolved {
        match_id,
        url: real_url,
        played_unix: None,
        info: None,
    };
    let late = answer.clone();
    let fake = FakeResolver::answering(move |_| Ok(late.clone()));
    let codes = ShareCodes::new(fake.clone());
    let forged = [
        ShareCode {
            outcome_id: 1,
            token: 1,
            ..real
        },
        ShareCode {
            outcome_id: reservation + 1,
            ..real
        },
        ShareCode {
            token: real.token.wrapping_add(1),
            ..real
        },
        // The whole TV port in the token's place.
        ShareCode {
            token: (port >> 16) as u16,
            ..real
        },
    ];
    for f in &forged {
        assert_eq!(
            codes.resolve(f).await,
            Err(ResolveError::BadAnswer),
            "{f:?}"
        );
        assert_eq!(codes.failed(f), None, "{f:?}");
    }
    assert_eq!(codes.resolve(&real).await, Ok(answer));

    // A replay URL that does not name its reservation id and TV port that way names no code.
    let code = ids_for(1);
    for path in [
        "/730/x.dem.bz2",
        "/730/000000000000000000001.dem.bz2",
        "/730/000000000000000000001_0000000001.dem",
        "/730/000000000000000000001_0000000001_404.dem.bz2",
        "/730/+1_1.dem.bz2",
        "/730/1_+1.dem.bz2",
        "/730/_1.dem.bz2",
        "/730/1_.dem.bz2",
        "/731/1_1.dem.bz2",
        "/730/a/1_1.dem.bz2",
        "/1_1.dem.bz2",
        // A TV port is 32 bits.
        "/730/1_4294967297.dem.bz2",
        "/730/18446744073709551617_1.dem.bz2",
    ] {
        let url = Url::parse(&format!("http://replay183.valve.net{path}")).unwrap();
        let fake = FakeResolver::answering(move |_| {
            Ok(Resolved {
                url: url.clone(),
                ..replay(1)
            })
        });
        let codes = ShareCodes::new(fake);
        assert_eq!(
            codes.resolve(&code).await,
            Err(ResolveError::BadAnswer),
            "{path}"
        );
    }
}

/// Valve's refusals (expired, no such match) are remembered for the code for a while; the
/// service's own troubles are not.
#[tokio::test]
async fn valves_refusals_are_remembered_for_a_while() {
    let fake = FakeResolver::answering(|code| match decode(code).unwrap().match_id {
        1 => Err(ResolveError::Expired),
        2 => Err(ResolveError::NotFound),
        3 => Err(ResolveError::Timeout),
        4 => Err(ResolveError::Busy),
        _ => Err(ResolveError::Offline),
    });
    let codes = ShareCodes::with_failure_ttl(fake.clone(), Duration::from_millis(300));
    for id in 1..=5 {
        assert_eq!(codes.failed(&ids_for(id)), None, "{id}");
        assert!(codes.resolve(&ids_for(id)).await.is_err());
    }
    assert_eq!(codes.failed(&ids_for(1)), Some(ResolveError::Expired));
    assert_eq!(codes.failed(&ids_for(2)), Some(ResolveError::NotFound));
    for id in 3..=6 {
        assert_eq!(codes.failed(&ids_for(id)), None, "{id}");
    }
    tokio::time::sleep(Duration::from_millis(350)).await;
    assert_eq!(codes.failed(&ids_for(1)), None, "remembered too long");
    assert_eq!(codes.failed(&ids_for(2)), None);
}

/// A refusal is remembered for the whole code only: a forged code naming a real match (its
/// match id with another outcome id or token) that Valve refuses leaves the real code free to
/// be looked up (security review 2026-10-22), and the code is sent as `encode` writes it.
#[tokio::test]
async fn a_refusal_is_remembered_for_its_code_not_its_match() {
    let real = ids_for(1);
    let forged = [
        ShareCode {
            outcome_id: 2,
            ..real
        },
        ShareCode { token: 2, ..real },
    ];
    let fake = FakeResolver::answering(move |code| {
        if decode(code) == Ok(real) {
            Ok(replay(1))
        } else {
            Err(ResolveError::NotFound)
        }
    });
    let codes = ShareCodes::new(fake.clone());
    for f in &forged {
        assert_eq!(codes.resolve(f).await, Err(ResolveError::NotFound));
        assert_eq!(codes.failed(f), Some(ResolveError::NotFound));
    }
    assert_eq!(codes.failed(&real), None);
    assert_eq!(codes.resolve(&real).await, Ok(replay(1)));
    assert_eq!(fake.calls(), 3);
}

#[test]
fn every_error_says_what_happened() {
    let copy = |e: ResolveError| e.to_string();
    assert_eq!(
        copy(ResolveError::Invalid),
        "That is not a match share code (CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx)"
    );
    assert_eq!(
        copy(ResolveError::Expired),
        "Valve no longer has this match's replay (they keep them about a month)"
    );
    assert_eq!(
        copy(ResolveError::NotFound),
        "Valve has no match for this code (crosshair codes look the same)"
    );
    assert_eq!(
        copy(ResolveError::Offline),
        "The share-code service is offline right now: paste the replay URL or upload the demo instead"
    );
    assert_eq!(
        copy(ResolveError::Busy),
        "Too many share codes are being looked up: try again in a minute"
    );
    assert_eq!(
        copy(ResolveError::Timeout),
        "Valve did not answer: try again in a minute"
    );
    assert_eq!(
        copy(ResolveError::BadAnswer),
        "The share-code service returned an unexpected link"
    );
}

// ---- the gcbot client ----------------------------------------------------------------------

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

/// A stand-in gcbot: `/health` says `health` and counts its requests; `/resolve` answers by the
/// code's match id, as gcbot's server.mjs would.
async fn fake_gcbot(health: Value) -> (Url, Arc<AtomicUsize>) {
    let checks = Arc::new(AtomicUsize::new(0));
    let counted = checks.clone();
    let router = Router::new()
        .route(
            "/health",
            get(move || {
                counted.fetch_add(1, Ordering::SeqCst);
                let health = health.clone();
                async move { Json(health) }
            }),
        )
        .route(
            "/resolve",
            post(|Json(body): Json<Value>| async move {
                let code = body["sharecode"].as_str().unwrap_or_default().to_owned();
                let id = decode(&code).map(|c| c.match_id).unwrap_or(0);
                let refusal = |status: StatusCode, error: &str| {
                    (status, Json(json!({"error": error, "message": "…"}))).into_response()
                };
                match id {
                    1 => Json(json!({
                        "matchId": "1",
                        "url": "http://replay183.valve.net/730/000000000000000000001_0000000001.dem.bz2",
                        "playedAt": 1_761_163_200u64,
                    }))
                    .into_response(),
                    2 => Json(json!({
                        "matchId": "2",
                        "url": "http://replay183.valve.net/730/2_1.dem.bz2",
                        "playedAt": null,
                    }))
                    .into_response(),
                    3 => refusal(StatusCode::NOT_FOUND, "expired"),
                    4 => refusal(StatusCode::NOT_FOUND, "not_found"),
                    5 => refusal(StatusCode::SERVICE_UNAVAILABLE, "offline"),
                    6 => refusal(StatusCode::SERVICE_UNAVAILABLE, "busy"),
                    7 => refusal(StatusCode::GATEWAY_TIMEOUT, "timeout"),
                    8 => refusal(StatusCode::BAD_REQUEST, "invalid"),
                    9 => Json(json!({"matchId": "nine", "url": "x"})).into_response(),
                    10 => (StatusCode::OK, "<html>a proxy page</html>").into_response(),
                    11 => {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        StatusCode::OK.into_response()
                    }
                    12 => (StatusCode::OK, "x".repeat(1 << 20)).into_response(),
                    // The GC's whole match info: about 100 KB, the size of a long match's.
                    14 => Json(json!({
                        "matchId": "14",
                        "url": "http://replay183.valve.net/730/000000000000000000014_0000000001.dem.bz2",
                        "playedAt": null,
                        "info": {
                            "matchid": "14",
                            "padding": "x".repeat(100_000),
                            "roundstatsall": [
                                {"reservation": {"game_type": 1}},
                                {"reservation": {"game_type": 8, "account_ids": [39734273]}},
                            ],
                        },
                    }))
                    .into_response(),
                    _ => refusal(StatusCode::INTERNAL_SERVER_ERROR, "internal"),
                }
            }),
        );
    let addr = serve(router).await;
    (format!("http://{addr}/").parse().unwrap(), checks)
}

async fn until(f: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < deadline, "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test]
async fn the_client_maps_gcbots_answers() {
    let (url, _) = fake_gcbot(json!({"steam": "online", "gc": true, "queued": 0})).await;
    let client = GcbotClient::with_timeout(url, Duration::from_millis(500));
    let resolve = |id: u64| {
        let client = client.clone();
        async move { client.resolve(&code_for(id)).await }
    };
    let one = resolve(1).await.unwrap();
    assert_eq!(
        (one.match_id, one.url.as_str(), one.played_unix),
        (
            1,
            "http://replay183.valve.net/730/000000000000000000001_0000000001.dem.bz2",
            Some(1_761_163_200)
        )
    );
    assert_eq!(resolve(2).await.unwrap().played_unix, None);
    for (id, err) in [
        (3, ResolveError::Expired),
        (4, ResolveError::NotFound),
        (5, ResolveError::Offline),
        (6, ResolveError::Busy),
        (7, ResolveError::Timeout),
        (8, ResolveError::Invalid),
        (9, ResolveError::BadAnswer),
        (10, ResolveError::BadAnswer),
        (11, ResolveError::Timeout),
        (12, ResolveError::BadAnswer),
        (13, ResolveError::Offline),
    ] {
        assert_eq!(resolve(id).await, Err(err), "{id}");
    }
}

#[tokio::test]
async fn a_lookup_keeps_the_gc_match_info() {
    let (url, _) = fake_gcbot(json!({"steam": "online", "gc": true, "queued": 0})).await;
    let client = GcbotClient::with_timeout(url, Duration::from_millis(500));
    let found = client.resolve(&code_for(14)).await.unwrap();
    let info = found.info.expect("the GC's match info");
    assert_eq!(info["matchid"], "14");
    assert_eq!(demoviewer_server::gcbot::gc_game_type(&info), Some(8));
    // An answer from before gcbot kept it has none.
    assert_eq!(client.resolve(&code_for(1)).await.unwrap().info, None);
}

/// `/health` is asked once at the start and then every 30 s, not on every question; Steam and
/// the GC must both be up.
#[tokio::test]
async fn the_client_caches_gcbots_health() {
    let (url, checks) = fake_gcbot(json!({"steam": "online", "gc": true})).await;
    let client = GcbotClient::new(url);
    until(|| client.online()).await;
    for _ in 0..100 {
        assert!(client.online());
    }
    assert_eq!(checks.load(Ordering::SeqCst), 1);

    for health in [
        json!({"steam": "online", "gc": false}),
        json!({"steam": "offline", "gc": false}),
        json!({"steam": "online"}),
        json!("ok"),
    ] {
        let (url, checks) = fake_gcbot(health.clone()).await;
        let client = GcbotClient::new(url);
        until(|| checks.load(Ordering::SeqCst) == 1).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!client.online(), "{health}");
    }
}

/// With gcbot down, a lookup fails as offline at once, and the client says so until gcbot is
/// heard from again.
#[tokio::test]
async fn a_client_whose_gcbot_is_down_is_offline() {
    let closed = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap()
    };
    let client = GcbotClient::new(format!("http://{closed}/").parse().unwrap());
    let started = Instant::now();
    assert_eq!(
        client.resolve(&code_for(1)).await,
        Err(ResolveError::Offline)
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert!(!client.online());

    // A gcbot that answers "offline" puts the client offline before its next health check.
    let (url, _) = fake_gcbot(json!({"steam": "online", "gc": true})).await;
    let client = GcbotClient::new(url);
    until(|| client.online()).await;
    assert_eq!(
        client.resolve(&code_for(5)).await,
        Err(ResolveError::Offline)
    );
    assert!(!client.online());
    assert!(client.resolve(&code_for(1)).await.is_ok());
    assert!(client.online());
}
