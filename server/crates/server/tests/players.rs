//! Players: `/api/players/{steamid}` (a profile from the matches we hold), the one input's
//! `/api/lookup`, the profile pages, and hidden profiles. The router runs in process over a
//! temp data dir; Steam and FACEIT are local fakes that count their calls.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::body::{to_bytes, Body};
use axum::extract::connect_info::MockConnectInfo;
use axum::extract::Query;
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::routing::get;
use axum::Router;
use demoviewer_server::app::build_app_with;
use demoviewer_server::config::Config;
use demoviewer_server::faceit::FaceitKey;
use demoviewer_server::hidden;
use demoviewer_server::jobs::Jobs;
use demoviewer_server::matches::{GameMode, MatchSummary, ReplayStats, SummaryPlayer};
use demoviewer_server::preview;
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::steam::{ApiKey, SteamApi, SteamGate};
use demoviewer_server::store::{Status, Store};
use serde_json::Value;
use tempfile::TempDir;
use tower::ServiceExt;
use url::Url;

const PAGE: &str =
    "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"UTF-8\" />\n    \
<title>cs.skunk.to</title>\n  </head>\n  <body>\n    <div id=\"root\"></div>\n  </body>\n</html>\n";
const ME: u64 = 76561198000000001;
const KEY: &str = "0123456789abcdef0123456789abcdef";
/// The FACEIT Data API key [`fake_faceit_data`] takes.
const FACEIT_KEY: &str = "00000000-1111-4222-8333-444444444444";

struct Site {
    _dir: TempDir,
    store: Arc<Store>,
    app: Router,
    steam_calls: Arc<AtomicUsize>,
    faceit_calls: Arc<AtomicUsize>,
}

/// A fake Steam: `gabe` resolves to [`ME`], every other name is unknown (success 42), and
/// every other call is a 404. Counts every call.
async fn fake_steam(calls: Arc<AtomicUsize>) -> Url {
    serve_steam(calls, Router::new()).await
}

/// The colour of [`ME`]'s avatar.
const AVATAR: (u8, u8, u8) = (0x20, 0xc0, 0x40);

/// [`ME`]'s avatar as Steam's image hosts send it: a 184×184 JPEG, all [`AVATAR`].
fn avatar_jpeg() -> Vec<u8> {
    let rgb: Vec<u8> = (0..184 * 184)
        .flat_map(|_| [AVATAR.0, AVATAR.1, AVATAR.2])
        .collect();
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, 90)
        .encode(&rgb, 184, 184, jpeg_encoder::ColorType::Rgb)
        .unwrap();
    out
}

/// [`fake_steam`] that also knows [`ME`]'s profile (Steam's name `gabe`, on Steam since 2016,
/// their avatar on Steam's image hosts, which it serves too, level 42, a trade probation and
/// private games) and takes `delay` over each summary, as a busy Steam does.
async fn steam_knowing_me(calls: Arc<AtomicUsize>, delay: Duration) -> Url {
    let json = |body: &'static str| ([(header::CONTENT_TYPE, "application/json")], body);
    let routes = Router::new()
        .route(
            "/abc_full.jpg",
            get(|| async { ([(header::CONTENT_TYPE, "image/jpeg")], avatar_jpeg()) }),
        )
        .route(
            "/ISteamUser/GetPlayerSummaries/v2/",
            get(move || async move {
                tokio::time::sleep(delay).await;
                json(
                    r#"{"response":{"players":[{"steamid":"76561198000000001","personaname":"gabe",
                    "avatarfull":"https://avatars.steamstatic.com/abc_full.jpg",
                    "communityvisibilitystate":3,"timecreated":1460000000}]}}"#,
                )
            }),
        )
        .route(
            "/ISteamUser/GetPlayerBans/v1/",
            get(move || async move {
                json(
                    r#"{"players":[{"SteamId":"76561198000000001","CommunityBanned":false,
                    "VACBanned":false,"NumberOfVACBans":0,"DaysSinceLastBan":0,"NumberOfGameBans":0,
                    "EconomyBan":"probation"}]}"#,
                )
            }),
        )
        .route(
            "/IPlayerService/GetOwnedGames/v1/",
            get(move || async move { json(r#"{"response":{}}"#) }),
        )
        .route(
            "/IPlayerService/GetSteamLevel/v1/",
            get(move || async move { json(r#"{"response":{"player_level":42}}"#) }),
        );
    serve_steam(calls, routes).await
}

/// A fake Steam answering `routes` and resolving `gabe` to [`ME`]; counts every call.
async fn serve_steam(calls: Arc<AtomicUsize>, routes: Router) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let counting = calls.clone();
    let app = routes
        .route(
            "/ISteamUser/ResolveVanityURL/v1/",
            get(|q: Query<HashMap<String, String>>| async move {
                let body = if q.get("vanityurl").map(String::as_str) == Some("gabe") {
                    format!(r#"{{"response":{{"steamid":"{ME}","success":1}}}}"#)
                } else {
                    r#"{"response":{"success":42,"message":"No match"}}"#.to_owned()
                };
                ([(header::CONTENT_TYPE, "application/json")], body)
            }),
        )
        .layer(axum::middleware::from_fn(
            move |req: axum::extract::Request, next: axum::middleware::Next| {
                counting.fetch_add(1, Ordering::SeqCst);
                next.run(req)
            },
        ));
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A fake FACEIT: [`ME`]'s account is `gabe_fi`, level 7 with 1,540 Elo; any other has none.
/// Counts every call.
async fn fake_faceit(calls: Arc<AtomicUsize>) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().route(
        "/users/v1/users",
        get(move |q: Query<HashMap<String, String>>| async move {
            calls.fetch_add(1, Ordering::SeqCst);
            let me = q.get("game_id") == Some(&ME.to_string())
                && q.get("game").map(String::as_str) == Some("cs2");
            let body = if me {
                format!(
                    r#"{{"result":"OK","size":1,"payload":[{{"nickname":"gabe_fi",
                    "games":{{"cs2":{{"game_id":"{ME}","skill_level":7,"faceit_elo":1540}}}}}}]}}"#
                )
            } else {
                r#"{"result":"OK"}"#.to_owned()
            };
            ([(header::CONTENT_TYPE, "application/json")], body)
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

/// A fake FACEIT Data API taking [`FACEIT_KEY`]: the nickname `gabe_fi` is [`ME`]'s player; any
/// other is a 404. Counts every call.
async fn fake_faceit_data(calls: Arc<AtomicUsize>) -> Url {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().route(
        "/players",
        get(
            move |q: Query<HashMap<String, String>>, headers: HeaderMap| async move {
                calls.fetch_add(1, Ordering::SeqCst);
                let keyed = headers
                    .get(header::AUTHORIZATION)
                    .and_then(|v| v.to_str().ok())
                    == Some(&format!("Bearer {FACEIT_KEY}"));
                if !keyed {
                    return (StatusCode::UNAUTHORIZED, String::new());
                }
                if q.get("nickname").map(String::as_str) != Some("gabe_fi") {
                    return (StatusCode::NOT_FOUND, r#"{"errors":[]}"#.to_owned());
                }
                let body = format!(
                    r#"{{"player_id":"0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0","nickname":"gabe_fi",
                    "steam_id_64":"{ME}","games":{{"cs2":{{"game_player_id":"{ME}",
                    "skill_level":7,"faceit_elo":1540}}}}}}"#
                );
                (StatusCode::OK, body)
            },
        ),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    base
}

async fn site(cfg: impl FnOnce(Config) -> Config, before: impl FnOnce(&std::path::Path)) -> Site {
    site_with_steam(cfg, before, fake_steam).await
}

async fn site_with_steam<F: std::future::Future<Output = Url>>(
    cfg: impl FnOnce(Config) -> Config,
    before: impl FnOnce(&std::path::Path),
    steam: impl FnOnce(Arc<AtomicUsize>) -> F,
) -> Site {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("web")).unwrap();
    std::fs::write(dir.path().join("web/index.html"), PAGE).unwrap();
    std::fs::create_dir_all(dir.path().join("data")).unwrap();
    before(&dir.path().join("data"));
    // Never the real FACEIT.
    let faceit_calls = Arc::new(AtomicUsize::new(0));
    let cfg = Arc::new(cfg(Config {
        data_dir: dir.path().join("data"),
        web_dir: dir.path().join("web"),
        faceit_api: fake_faceit(faceit_calls.clone()).await,
        ..Config::default()
    }));
    let store = Arc::new(Store::open(&cfg).unwrap());
    let (jobs, _rx) = Jobs::channel();
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    let steam_calls = Arc::new(AtomicUsize::new(0));
    let base = steam(steam_calls.clone()).await;
    let steam = SteamApi::with_base(
        base,
        ApiKey::new(KEY).unwrap(),
        SteamGate::new(Duration::ZERO),
    );
    let app = build_app_with(cfg, store.clone(), jobs, limiter, Some(Arc::new(steam)))
        .layer(MockConnectInfo(SocketAddr::from(([10, 0, 0, 2], 40000))));
    Site {
        _dir: dir,
        store,
        app,
        steam_calls,
        faceit_calls,
    }
}

fn player(id: u64, name: &str, team: u8, kills: u16) -> SummaryPlayer {
    SummaryPlayer {
        steamid: id.to_string(),
        name: name.into(),
        team,
        kills,
        deaths: 10,
        damage: 1600,
        rounds: 20,
        kast_rounds: 14,
        ..SummaryPlayer::default()
    }
}

/// A done 5v5 Competitive match on `map` with [`ME`] (named `name`) in it, at `at`; returns
/// its demo id.
fn stored(store: &Store, tag: u8, map: &str, at: u64, name: &str) -> String {
    let sha = format!("{tag:02x}").repeat(32);
    let mut players = vec![player(ME, name, 2, 25)];
    players.extend((1..10).map(|i| {
        player(
            ME + 1000 + i,
            &format!("p{i}"),
            if i < 5 { 2 } else { 3 },
            10,
        )
    }));
    store.matches().insert(MatchSummary {
        sha256: sha.clone(),
        map: map.into(),
        rounds: 20,
        score_t: 13,
        score_ct: 7,
        players,
        created_unix: at,
        played_unix: Some(at),
        mode: Some(GameMode::Competitive),
        version: demoviewer_server::matches::SUMMARY_VERSION,
        ..MatchSummary::default()
    });
    let id = Store::new_id();
    store.create(&id);
    store.update(&id, |r| {
        r.status = Status::Done;
        r.sha256 = Some(sha);
    });
    id
}

async fn call(app: &Router, uri: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
    let req = Request::get(uri).body(Body::empty()).unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let (status, headers) = (res.status(), res.headers().clone());
    let body = to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    (status, headers, body)
}

async fn json(app: &Router, uri: &str) -> (StatusCode, Value) {
    let (status, _, body) = call(app, uri).await;
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn q(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

#[tokio::test]
async fn a_corpus_match_has_no_day_and_stands_by_when_its_tournament_ended() {
    let s = site(|c| c, |_| {}).await;
    let (_, last) = demoviewer_server::event_dates::of("iem_cologne_major_2026").unwrap();
    let before = stored(&s.store, 1, "de_mirage", last - 86_400, "skunk");
    let after = stored(&s.store, 2, "de_nuke", last + 86_400, "skunk");
    // Imported long after both: that day says nothing of when it was played.
    let imported = stored(&s.store, 3, "de_inferno", last + 400 * 86_400, "skunk");
    let sha = "03".repeat(32);
    let mut m = (*s.store.matches().get(&sha).unwrap()).clone();
    m.played_unix = None;
    m.imported = true;
    m.event = Some("iem_cologne_major_2026".into());
    s.store.matches().insert(m);

    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let rows = v["matches"].as_array().unwrap();
    let ids: Vec<&str> = rows.iter().map(|r| r["demoId"].as_str().unwrap()).collect();
    assert_eq!(ids, [after.as_str(), imported.as_str(), before.as_str()]);
    assert_eq!(rows[1]["playedUnix"], Value::Null);
    assert_eq!(rows[0]["playedUnix"], last + 86_400);
}

#[tokio::test]
async fn a_players_profile_lists_their_matches_with_demo_ids() {
    let s = site(|c| c, |_| {}).await;
    let old = stored(&s.store, 1, "de_mirage", 100, "old name");
    let new = stored(&s.store, 2, "de_nuke", 200, "skunk");
    // A sha with no done record is left out.
    s.store.matches().insert(MatchSummary {
        sha256: "03".repeat(32),
        players: vec![player(ME, "x", 2, 1)],
        ..MatchSummary::default()
    });
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["steamid"], ME.to_string());
    assert_eq!(v["matchCount"], 2);
    assert_eq!(v["name"], "skunk", "the latest demo's name without Steam's");
    let ids: Vec<&str> = v["matches"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["demoId"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [new.as_str(), old.as_str()]);
    assert_eq!(v["totals"]["matches"], 2);
    let (status, rows) = json(&s.app, &format!("/api/players/{ME}/matches?offset=1")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(rows.as_array().unwrap().len(), 1);
    assert_eq!(rows[0]["demoId"], old);
}

#[tokio::test]
async fn a_faceit_servers_match_is_listed_as_faceit_and_counted() {
    let s = site(|c| c, |_| {}).await;
    let id = stored(&s.store, 1, "de_mirage", 100, "skunk");
    let sha = s.store.get(&id).unwrap().sha256.unwrap();
    let mut sum = (*s.store.matches().get(&sha).unwrap()).clone();
    sum.mode = Some(GameMode::Faceit);
    sum.server_name = "FACEIT.com register to play here".into();
    s.store.matches().insert(sum);
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["matches"][0]["mode"], "faceit");
    assert_eq!(v["totals"]["matches"], 1);
}

/// A tracked player's FACEIT history (the poller's file) is in their profile: the newest 20
/// rows as the file keeps them, newest first, each with FACEIT's facts, its replay when the site
/// holds the demo (a row held by a record the site no longer has has none) and its room on
/// FACEIT, and nothing the poller keeps for itself. Without a file there is none. The page's
/// copy for crawlers lists the rows, each linking to its replay or else to its room.
#[tokio::test]
async fn a_profile_has_the_players_faceit_history() {
    let s = site(|c| c, |_| {}).await;
    let held = stored(&s.store, 1, "de_mirage", 100, "skunk");
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert!(v.get("faceitHistory").is_none(), "no file, no history: {v}");

    let room = |id: &str| format!("https://www.faceit.com/en/cs2/room/{id}");
    let older = |n: u64| {
        serde_json::json!({
            "matchId": format!("1-old-{n:02}"), "finishedUnix": 1_761_000_000 + n,
            "map": "de_nuke", "score": [13, 9], "won": true, "competition": "CS2 5v5",
            "players": [ME], "demo": "unavailable",
        })
    };
    let mut rows = vec![
        serde_json::json!({
            "matchId": "1-held", "finishedUnix": 1_762_000_300u64, "map": "de_mirage",
            "score": [13, 11], "won": true, "competition": "CS2 5v5", "players": [ME],
            "demo": { "held": held },
        }),
        serde_json::json!({
            "matchId": "1-pending", "finishedUnix": 1_762_000_200u64, "map": null,
            "score": [7, 13], "won": false, "competition": "Hub", "players": [ME],
            "demo": "pending", "demoUrl": "https://example.com/1.dem.gz", "detailTries": 2,
        }),
        serde_json::json!({
            "matchId": "1-gone", "finishedUnix": 1_762_000_100u64, "map": "de_inferno",
            "score": null, "won": null, "competition": null, "players": [],
            "demo": { "held": "NoSuchRecordAtAllHere1" },
        }),
    ];
    rows.extend((0..19).rev().map(older));
    let dir = s._dir.path().join("data/faceit");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join(format!("{ME}.json")),
        serde_json::json!({ "playerId": "p-1", "nickname": "gabe_fi", "matches": rows })
            .to_string(),
    )
    .unwrap();

    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let history = v["faceitHistory"].as_array().expect("a history");
    assert_eq!(history.len(), 20, "the newest 20");
    assert_eq!(
        history[0],
        serde_json::json!({
            "matchId": "1-held", "finishedUnix": 1_762_000_300u64, "map": "de_mirage",
            "score": [13, 11], "won": true, "competition": "CS2 5v5", "replay": held,
            "roomUrl": room("1-held"),
        })
    );
    assert_eq!(
        history[1],
        serde_json::json!({
            "matchId": "1-pending", "finishedUnix": 1_762_000_200u64, "map": null,
            "score": [7, 13], "won": false, "competition": "Hub", "replay": null,
            "roomUrl": room("1-pending"),
        })
    );
    assert_eq!(history[2]["replay"], Value::Null, "its record is gone");
    assert_eq!(history[2]["roomUrl"], room("1-gone"));
    let ids: Vec<&str> = history[3..]
        .iter()
        .map(|r| r["matchId"].as_str().unwrap())
        .collect();
    let want: Vec<String> = (2..19).rev().map(|n| format!("1-old-{n:02}")).collect();
    assert_eq!(ids, want, "newest first; the two oldest left out");

    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    assert!(page.contains("<caption>On FACEIT</caption>"), "{page}");
    assert!(
        page.contains(&format!(r#"<a href="/d/{held}">Replay</a>"#)),
        "{page}"
    );
    assert!(
        page.contains(&format!(r#"<a href="{}" "#, room("1-pending"))),
        "{page}"
    );

    // A file that cannot be read (a directory in its place) is no history, not an error.
    let file = dir.join(format!("{ME}.json"));
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir(&file).unwrap();
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert!(v.get("faceitHistory").is_none(), "{v}");
    assert!(file.is_dir(), "left where it is");
}

#[tokio::test]
async fn a_profile_lists_who_they_played_with_never_a_hidden_player() {
    // [`stored`] puts p1 to p4 beside the player; p1 is hidden.
    let s = site(|c| c, |data| hidden::edit(data, ME + 1001, true).unwrap()).await;
    stored(&s.store, 1, "de_mirage", 100, "skunk");
    stored(&s.store, 2, "de_nuke", 200, "skunk");
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    let mates: Vec<(&str, i64, i64)> = v["mates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["name"].as_str().unwrap(),
                m["matches"].as_i64().unwrap(),
                m["wins"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(mates, [("p2", 2, 2), ("p3", 2, 2), ("p4", 2, 2)]);
    let text = v.to_string();
    assert!(
        !text.contains(&(ME + 1001).to_string()) && !text.contains("\"p1\""),
        "{text}"
    );
    assert_eq!(v["totals"]["wins"], 2);
    assert_eq!(v["totals"]["kastPct"], 70.0);
    assert_eq!(v["matches"][0]["adr"], 80.0);
}

/// A profile adds up what the replays tell over the matches whose summary has it; a summary
/// from before is left out of those, not of the rest.
#[tokio::test]
async fn a_profile_adds_up_what_the_replays_tell() {
    let s = site(|c| c, |_| {}).await;
    stored(&s.store, 1, "de_mirage", 100, "skunk");
    stored(&s.store, 2, "de_nuke", 200, "skunk");
    let sha = "02".repeat(32);
    let mut new = (*s.store.matches().get(&sha).unwrap()).clone();
    new.players[0].replay = Some(ReplayStats {
        weapons: [("ak47".to_owned(), 20)].into(),
        clutches: [1, 0, 0, 0, 0],
        clutches_won: [1, 0, 0, 0, 0],
        ..ReplayStats::default()
    });
    s.store.matches().insert(new);
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["totals"]["matches"], 2);
    assert_eq!(v["totals"]["kills"], 50);
    assert_eq!(
        (&v["replay"]["matches"], &v["replay"]["kills"]),
        (&1.into(), &25.into())
    );
    assert_eq!(
        v["replay"]["weapons"],
        serde_json::json!([{ "weapon": "ak47", "kills": 20 }])
    );
    assert_eq!(
        v["replay"]["clutchesWon"],
        serde_json::json!([1, 0, 0, 0, 0])
    );
    // Each map line and each match carries its own figures, for the expansions.
    assert_eq!(v["maps"][0]["map"], "de_nuke");
    assert_eq!(v["maps"][0]["totals"]["matches"], 1);
    assert!(v["maps"][0]["totals"].get("rating").is_some());
    assert_eq!(v["maps"][0]["replay"]["matches"], 1);
    assert_eq!(
        v["matches"][0]["replay"]["weapons"],
        serde_json::json!([{ "weapon": "ak47", "kills": 20 }])
    );
    assert_eq!(v["matches"][0]["counted"], true);
    assert_eq!(v["matches"][0]["rounds"], 20);
    assert_eq!(v["matches"][0]["kastRounds"], 14);
    assert_eq!(
        v["matches"][0]["multiKills"],
        serde_json::json!([0, 0, 0, 0])
    );
    assert!(v["matches"][1]["replay"].is_null());
    let (_, rows) = json(&s.app, &format!("/api/players/{ME}/matches?offset=0")).await;
    assert_eq!(rows[0]["counted"], true);
    assert!(rows[0]["replay"]["weapons"].is_array());
    assert_eq!(rows[0]["openingWon"], 0);
}

#[tokio::test]
async fn a_valid_id_with_no_matches_still_has_a_profile() {
    let s = site(|c| c, |_| {}).await;
    let (status, v) = json(&s.app, "/api/players/76561198000000009").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["matchCount"], 0);
    assert_eq!(v["matches"], Value::Array(vec![]));
    assert_eq!(v["tracking"], "off");
    for bad in ["123", "76561190000000000", "abc", "STEAM_0:1:1"] {
        let (status, v) = json(&s.app, &format!("/api/players/{bad}")).await;
        assert_eq!(
            (status, &v["error"]),
            (StatusCode::NOT_FOUND, &Value::from("no such player")),
            "{bad}"
        );
    }
}

#[tokio::test]
async fn a_hidden_profile_answers_410() {
    let s = site(|c| c, |data| hidden::edit(data, ME, true).unwrap()).await;
    stored(&s.store, 1, "de_mirage", 100, "skunk");
    for uri in [
        format!("/api/players/{ME}"),
        format!("/api/players/{ME}/matches"),
    ] {
        let (status, v) = json(&s.app, &uri).await;
        assert_eq!(status, StatusCode::GONE, "{uri}");
        assert_eq!(v["error"], "This profile is hidden.");
        assert_eq!(v["hidden"], true);
    }
}

#[tokio::test]
async fn lookup_resolves_every_id_form_without_steam() {
    let s = site(|c| c, |_| {}).await;
    for form in [
        "76561198000000001",
        "[U:1:39734273]",
        "STEAM_0:1:19867136",
        "39734273",
        "AJJQ8-EMDJ",
        "https://steamcommunity.com/profiles/76561198000000001/",
        "https://s.team/p/dhv-grbc",
    ] {
        let (status, v) = json(&s.app, &format!("/api/lookup?q={}", q(form))).await;
        assert_eq!(status, StatusCode::OK, "{form}");
        assert_eq!(v["kind"], "profile", "{form}");
        assert_eq!(v["steamid"], ME.to_string(), "{form}");
    }
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
    let (status, v) = json(
        &s.app,
        &format!("/api/lookup?q={}", q("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")),
    )
    .await;
    assert_eq!(
        (status, &v["error"]),
        (
            StatusCode::BAD_REQUEST,
            &Value::from("That is a match, not a player")
        )
    );
}

#[tokio::test]
async fn lookup_of_an_unknown_vanity_falls_back_to_names() {
    let s = site(|c| c, |data| hidden::edit(data, ME + 1, true).unwrap()).await;
    let (status, v) = json(&s.app, "/api/lookup?q=gabe").await;
    assert_eq!(
        (status, &v["kind"], &v["steamid"]),
        (
            StatusCode::OK,
            &Value::from("profile"),
            &Value::from(ME.to_string())
        )
    );
    let (status, v) = json(&s.app, "/api/lookup?q=nosuchvanity").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        v["error"],
        "No Steam account or player called “nosuchvanity”"
    );
    stored(&s.store, 1, "de_mirage", 100, "nosuchvanity");
    // A hidden player of the same name is never offered.
    s.store.matches().insert(MatchSummary {
        sha256: "09".repeat(32),
        players: vec![player(ME + 1, "NoSuchVanity", 2, 1)],
        ..MatchSummary::default()
    });
    let (status, v) = json(&s.app, "/api/lookup?q=nosuchvanity").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["kind"], "players");
    assert_eq!(
        v["players"],
        serde_json::json!([{"steamid": ME.to_string(), "name": "nosuchvanity", "matches": 1}])
    );
}

/// With a FACEIT key, a bare word Steam knows no custom URL of is tried as a FACEIT nickname
/// (one call) before the names of the players held; one FACEIT has no player for falls through
/// to them. FACEIT's site API is never asked.
#[tokio::test]
async fn lookup_of_a_faceit_nickname_finds_their_steam_account() {
    let data_calls = Arc::new(AtomicUsize::new(0));
    let data = fake_faceit_data(data_calls.clone()).await;
    let s = site(
        |c| Config {
            faceit_api_key: FaceitKey::new(FACEIT_KEY),
            faceit_data_api: data,
            ..c
        },
        |_| {},
    )
    .await;
    let (status, v) = json(&s.app, "/api/lookup?q=gabe_fi").await;
    assert_eq!(
        (status, &v["kind"], &v["steamid"]),
        (
            StatusCode::OK,
            &Value::from("profile"),
            &Value::from(ME.to_string())
        ),
        "{v}"
    );
    // Steam was asked first, then FACEIT once.
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 1);
    assert_eq!(data_calls.load(Ordering::SeqCst), 1);
    stored(&s.store, 1, "de_mirage", 100, "nobody_fi");
    let (status, v) = json(&s.app, "/api/lookup?q=nobody_fi").await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["kind"], "players");
    assert_eq!(v["players"][0]["name"], "nobody_fi");
    assert_eq!(data_calls.load(Ordering::SeqCst), 2);
    // A Steam id never reaches FACEIT.
    let (status, _) = json(&s.app, &format!("/api/lookup?q={ME}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(data_calls.load(Ordering::SeqCst), 2);
    assert_eq!(s.faceit_calls.load(Ordering::SeqCst), 0);
}

/// A hidden player's FACEIT nickname finds no one: the lookup goes on to the names we hold,
/// which leave them out too, and never names their account.
#[tokio::test]
async fn a_faceit_nickname_never_finds_a_hidden_player() {
    let data_calls = Arc::new(AtomicUsize::new(0));
    let data = fake_faceit_data(data_calls.clone()).await;
    let s = site(
        |c| Config {
            faceit_api_key: FaceitKey::new(FACEIT_KEY),
            faceit_data_api: data,
            ..c
        },
        |data| hidden::edit(data, ME, true).unwrap(),
    )
    .await;
    stored(&s.store, 1, "de_mirage", 100, "gabe_fi");
    let (status, v) = json(&s.app, "/api/lookup?q=gabe_fi").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{v}");
    assert!(!v.to_string().contains(&ME.to_string()), "{v}");
    // FACEIT was asked, and named them.
    assert_eq!(data_calls.load(Ordering::SeqCst), 1);
}

/// Without a FACEIT key a nickname is never looked for on FACEIT.
#[tokio::test]
async fn without_a_faceit_key_a_nickname_is_not_looked_for() {
    let data_calls = Arc::new(AtomicUsize::new(0));
    let data = fake_faceit_data(data_calls.clone()).await;
    let s = site(
        |c| Config {
            faceit_data_api: data,
            ..c
        },
        |_| {},
    )
    .await;
    let (status, _) = json(&s.app, "/api/lookup?q=gabe_fi").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(data_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn an_id_link_never_falls_back_to_names() {
    let s = site(|c| c, |_| {}).await;
    stored(&s.store, 1, "de_mirage", 100, "x1");
    let (status, v) = json(
        &s.app,
        &format!("/api/lookup?q={}", q("https://steamcommunity.com/id/x1")),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(
        v["error"],
        "No Steam account or player called “https://steamcommunity.com/id/x1”"
    );
}

#[tokio::test]
async fn lookups_that_reach_steam_are_limited_per_client() {
    let s = site(
        |c| Config {
            lookups_per_hour: 2,
            ..c
        },
        |_| {},
    )
    .await;
    for name in ["a1", "a2"] {
        let (status, _) = json(&s.app, &format!("/api/lookup?q={name}")).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    let (status, _) = json(&s.app, "/api/lookup?q=a3").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    // Ids never reach Steam and are never limited.
    let (status, _) = json(&s.app, &format!("/api/lookup?q={ME}")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn profile_pages_are_the_app_and_noindex() {
    let s = site(|c| c, |_| {}).await;
    for uri in [
        "/id/someone".to_owned(),
        "/id/someone/".to_owned(),
        format!("/profiles/{ME}"),
        format!("/profiles/{ME}/games/?tab=all"),
    ] {
        let (status, headers, body) = call(&s.app, &uri).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert!(headers[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        let html = String::from_utf8(body).unwrap();
        assert!(
            html.contains(r#"<meta name="robots" content="noindex">"#),
            "{uri}: {html}"
        );
        assert!(html.contains(r#"<div id="root">"#));
        assert!(!html.contains("og:"), "no preview tags");
    }
}

#[tokio::test]
async fn csp_allows_steam_avatars_and_nothing_else_new() {
    let s = site(|c| c, |_| {}).await;
    let (_, headers, _) = call(&s.app, "/healthz").await;
    let csp = headers[header::CONTENT_SECURITY_POLICY].to_str().unwrap();
    let img = csp
        .split(';')
        .map(str::trim)
        .find(|d| d.starts_with("img-src"))
        .unwrap();
    assert_eq!(
        img,
        "img-src 'self' data: blob: https://avatars.steamstatic.com https://avatars.akamai.steamstatic.com \
https://avatars.fastly.steamstatic.com https://avatars.cloudflare.steamstatic.com"
    );
    for d in csp
        .split(';')
        .map(str::trim)
        .filter(|d| !d.starts_with("img-src"))
    {
        assert!(!d.contains("steamstatic"), "{d}");
    }
}

#[tokio::test]
async fn a_hidden_players_name_is_left_off_the_match_page() {
    let s = site(|c| c, |data| hidden::edit(data, ME, true).unwrap()).await;
    let id = stored(&s.store, 1, "de_mirage", 100, "toppfragger");
    let (status, _, body) = call(&s.app, &format!("/d/{id}")).await;
    assert_eq!(status, StatusCode::OK);
    let html = String::from_utf8(body).unwrap();
    assert!(!html.contains("toppfragger"), "{html}");
    assert!(html.contains("— led with 25 kills"), "{html}");
}

#[tokio::test]
async fn a_card_with_a_hidden_player_is_kept_apart_and_the_named_card_dropped() {
    let s = site(|c| c, |data| hidden::edit(data, ME, true).unwrap()).await;
    let id = stored(&s.store, 1, "de_mirage", 100, "toppfragger");
    let sha = "01".repeat(32);
    // A card drawn before the player was hidden, naming them.
    let named = s.store.og_path(&sha);
    std::fs::create_dir_all(named.parent().unwrap()).unwrap();
    std::fs::write(&named, b"a card naming toppfragger").unwrap();
    let (status, headers, first) = call(&s.app, &format!("/og/{id}.jpg")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_ne!(first, b"a card naming toppfragger");
    assert!(
        !named.exists(),
        "the card naming a hidden player is deleted"
    );
    let apart: Vec<_> = std::fs::read_dir(named.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(apart.len(), 1, "{apart:?}");
    assert!(
        apart[0].starts_with(&format!("{sha}-")) && apart[0].ends_with(".jpg"),
        "{apart:?}"
    );
    // Drawn once: the second answer is the kept card.
    let kept = named.with_file_name(&apart[0]);
    let card = [b"the kept redacted card ", preview::MATCH_DESIGN].concat();
    std::fs::write(&kept, &card).unwrap();
    let (_, _, second) = call(&s.app, &format!("/og/{id}.jpg")).await;
    assert_eq!(second, card);
}

/// The `content` of the `<meta property=…>` or `<meta name=…>` called `key`.
fn meta(html: &str, key: &str) -> Option<String> {
    ["property", "name"].iter().find_map(|attr| {
        let start = format!("<meta {attr}=\"{key}\" content=\"");
        let at = html.find(&start)? + start.len();
        Some(html[at..at + html[at..].find('"')?].to_owned())
    })
}

async fn html(app: &Router, uri: &str) -> String {
    let (status, _, body) = call(app, uri).await;
    // The app's page, whatever the status says of the player (404 none, 410 hidden).
    assert!(
        [StatusCode::OK, StatusCode::NOT_FOUND, StatusCode::GONE].contains(&status),
        "{uri}: {status}"
    );
    String::from_utf8(body).unwrap()
}

/// [`ME`]'s Steam profile as the cache keeps it, fetched now.
fn cached_me(data: &std::path::Path) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    std::fs::create_dir_all(data.join("profiles")).unwrap();
    std::fs::write(
        data.join(format!("profiles/{ME}.json")),
        serde_json::json!({
            "steamid": ME, "name": "gabe <3",
            "avatar": "https://avatars.steamstatic.com/abc_full.jpg",
            "since_year": 2016, "country": null, "cs2_hours": null,
            "vac_bans": 0, "game_bans": 0, "fetched_unix": now,
        })
        .to_string(),
    )
    .unwrap();
}

/// A profile link pasted in Discord previews as the player's CS2 stats ("‹Steam's name›'s CS2
/// stats", so it reads as Counter-Strike at a glance), the stat line in the
/// site's words (numbers first), their card as a large image, the site's crimson. The card's
/// link names the numbers it shows, so Discord, which keeps an image by its link, shows the new
/// card after a new match. Read from what the server holds: a crawler never makes the server
/// ask Steam.
#[tokio::test]
async fn a_known_players_page_previews_their_profile() {
    let s = site(public, cached_me).await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "gabe");
    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    for (key, value) in [
        ("og:site_name", "skunk.club".to_owned()),
        ("og:type", "profile".to_owned()),
        ("og:title", "gabe &lt;3&#39;s CS2 stats".to_owned()),
        ("og:image:width", "1200".to_owned()),
        ("og:image:height", "630".to_owned()),
        ("twitter:card", "summary_large_image".to_owned()),
        ("theme-color", "#e4163a".to_owned()),
    ] {
        assert_eq!(
            meta(&page, key).as_deref(),
            Some(value.as_str()),
            "{key}: {page}"
        );
    }
    // A known player is indexable, under one address.
    assert_eq!(meta(&page, "robots"), None, "{page}");
    assert!(
        page.contains(&format!(
            r#"<link rel="canonical" href="https://skunk.club/profiles/{ME}">"#
        )),
        "{page}"
    );
    let description = meta(&page, "og:description").unwrap();
    for part in ["rating", "K/D", "ADR", "1 match"] {
        assert!(description.contains(part), "{part}: {description}");
    }
    let sentence = meta(&page, "description").unwrap();
    for part in ["CS2 stats from 1 match", "K/D", "ADR", "3D replay"] {
        assert!(sentence.contains(part), "{part}: {sentence}");
    }
    assert!(
        page.contains("<title>gabe &lt;3&#39;s CS2 stats and demos · skunk.club</title>"),
        "{page}"
    );
    let image = meta(&page, "og:image").unwrap();
    let key = image
        .strip_prefix(&format!("https://skunk.club/og/profile-{ME}.jpg?v="))
        .unwrap_or_else(|| panic!("the card: {image}"));
    assert!(
        key.len() == 16 && key.bytes().all(|b| b.is_ascii_hexdigit()),
        "{image}"
    );
    let (status, _, _) = call(&s.app, &image["https://skunk.club".len()..]).await;
    assert_eq!(status, StatusCode::OK, "the link answers the card");
    stored(&s.store, 2, "de_nuke", 1_762_000_000, "gabe");
    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    assert_ne!(
        meta(&page, "og:image").unwrap(),
        image,
        "a new match, a new link"
    );
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
    assert_eq!(s.faceit_calls.load(Ordering::SeqCst), 0);
}

/// A player the server knows only from Steam's facts, with no match of theirs held, has a thin
/// page: titled and previewed as them, but `noindex`, with no canonical link, no JSON-LD and no
/// pre-rendered body. Still no call to Steam.
#[tokio::test]
async fn a_player_with_steams_facts_but_no_match_is_noindex() {
    let s = site(public, cached_me).await;
    let (status, _, body) = call(&s.app, &format!("/profiles/{ME}")).await;
    assert_eq!(status, StatusCode::OK);
    let page = String::from_utf8(body).unwrap();
    assert!(
        page.contains("<title>gabe &lt;3&#39;s CS2 stats and demos · skunk.club</title>"),
        "{page}"
    );
    assert_eq!(meta(&page, "robots").as_deref(), Some("noindex"), "{page}");
    assert!(!page.contains(r#"<link rel="canonical""#), "{page}");
    assert!(!page.contains("ld+json"), "{page}");
    assert!(!page.contains(r#"<div id="pre">"#), "{page}");
    assert!(page.contains(r#"<div id="root"></div>"#), "{page}");
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// Without Steam's profile kept, the name is the one from the player's latest match, and there
/// is no image; still no call to Steam.
#[tokio::test]
async fn a_player_without_a_kept_profile_previews_with_their_match_name() {
    let s = site(|c| c, |_| {}).await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "old name");
    stored(&s.store, 2, "de_nuke", 1_762_000_000, "new name");
    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    assert_eq!(
        meta(&page, "og:title").as_deref(),
        Some("new name&#39;s CS2 stats")
    );
    // Without a public URL there is no absolute link to a card.
    assert_eq!(meta(&page, "og:image"), None);
    assert!(meta(&page, "og:description").unwrap().contains("2 matches"));
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// A hidden player's page previews as nobody, and a custom URL the server has not resolved
/// yet costs no call to Steam to preview.
#[tokio::test]
async fn hidden_players_and_unresolved_names_have_no_preview() {
    let s = site(
        |c| c,
        |data| {
            cached_me(data);
            hidden::edit(data, ME, true).unwrap();
        },
    )
    .await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "gabe");
    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    assert!(!page.contains("og:"), "{page}");
    assert!(!page.contains("gabe"), "{page}");
    let page = html(&s.app, "/id/gabe").await;
    assert!(!page.contains("og:"), "{page}");
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// A profile page with no player to show still has a title, and no player's tags: "Player not
/// found" where the server knows there is none (an address no account can have, or a custom URL
/// Steam has said no account has), "Hidden profile" for a hidden player, and "Player profile"
/// where it cannot know without asking Steam, which a crawler never makes it do.
#[tokio::test]
async fn a_page_with_no_player_to_show_has_a_title() {
    let s = site(public, |data| hidden::edit(data, ME, true).unwrap()).await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "gabe");
    let cases = [
        ("/profiles/123".to_owned(), "Player not found"),
        ("/profiles/76561197960265728".to_owned(), "Player not found"),
        ("/id/a".to_owned(), "Player not found"),
        ("/id/no%20such/".to_owned(), "Player not found"),
        (format!("/profiles/{ME}"), "Hidden profile"),
        (format!("/profiles/{}", ME + 7), "Player profile"),
        ("/id/nosuchname123456".to_owned(), "Player profile"),
    ];
    for (uri, title) in &cases {
        let want = match *title {
            "Player not found" => StatusCode::NOT_FOUND,
            "Hidden profile" => StatusCode::GONE,
            _ => StatusCode::OK,
        };
        assert_eq!(call(&s.app, uri).await.0, want, "{uri}");
        let page = html(&s.app, uri).await;
        assert!(
            page.contains(&format!("<title>{title} · skunk.club</title>")),
            "{uri}: {page}"
        );
        assert!(!page.contains("og:"), "{uri}: {page}");
        assert!(!page.contains("gabe"), "{uri}: {page}");
    }
    assert_eq!(
        s.steam_calls.load(Ordering::SeqCst),
        0,
        "a page asks nothing"
    );
    assert_eq!(s.faceit_calls.load(Ordering::SeqCst), 0, "nor FACEIT");
    // The page's own lookup asks Steam, which knows no such name: now the page says so.
    let (status, _) = json(
        &s.app,
        &format!("/api/lookup?q={}", q("skunk.club/id/nosuchname123456")),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let page = html(&s.app, "/id/NoSuchName123456").await;
    assert!(
        page.contains("<title>Player not found · skunk.club</title>"),
        "{page}"
    );
}

/// A profile answers at once with what the server keeps; Steam's facts it does not keep are
/// fetched in the background (once, however often the page asks, and counted as the client's
/// lookup) while the answer says so, and a later answer has them.
#[tokio::test]
async fn a_profile_answers_at_once_and_steam_fills_in_later() {
    let s = site_with_steam(
        |c| c,
        |_| {},
        |calls| steam_knowing_me(calls, Duration::from_millis(700)),
    )
    .await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "from the match");
    let uri = format!("/api/players/{ME}");
    let t0 = std::time::Instant::now();
    let (status, v) = json(&s.app, &uri).await;
    assert!(
        t0.elapsed() < Duration::from_millis(500),
        "{:?}",
        t0.elapsed()
    );
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "from the match");
    assert_eq!(v["matchCount"], 1);
    assert_eq!(v["steamPending"], true);
    let (_, again) = json(&s.app, &uri).await;
    assert_eq!(again["steamPending"], true);
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let v = loop {
        let (_, v) = json(&s.app, &uri).await;
        if v["steamPending"] == false {
            break v;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "Steam never filled in: {v}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(v["name"], "gabe");
    assert_eq!(v["steam"]["sinceYear"], 2016);
    assert_eq!(v["steam"]["level"], 42);
    assert_eq!(v["steam"]["tradeBan"], "probation");
    assert_eq!(v["steam"]["communityBanned"], false);
    assert_eq!(v["steam"]["daysSinceLastBan"], Value::Null);
    assert_eq!(v["steam"]["cs2RecentMinutes"], Value::Null);
    // One fetch: a summary, the bans, the playtime, the level and the avatar; FACEIT once
    // beside it.
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 5);
    assert_eq!(
        v["faceit"],
        serde_json::json!({
            "nickname": "gabe_fi", "level": 7, "elo": 1540,
            "playerId": null, "winsPct": null, "matches": null,
        })
    );
    assert_eq!(s.faceit_calls.load(Ordering::SeqCst), 1);
}

/// A profile kept before Steam's level, recent playtime and every kind of ban were asked for
/// still answers, those facts unknown, and is not fetched again while fresh.
#[tokio::test]
async fn a_profile_kept_before_the_newer_facts_answers_with_them_unknown() {
    let s = site(|c| c, cached_me).await;
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK, "{v}");
    assert_eq!(v["name"], "gabe <3");
    assert_eq!(v["steam"]["sinceYear"], 2016);
    assert_eq!(v["steam"]["vacBans"], 0);
    for fact in [
        "level",
        "cs2RecentMinutes",
        "communityBanned",
        "tradeBan",
        "daysSinceLastBan",
    ] {
        assert_eq!(v["steam"][fact], Value::Null, "{fact}");
    }
    assert_eq!(v["steamPending"], false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// Past the client's lookups a profile still answers at once, with what is kept, and starts no
/// fetch.
#[tokio::test]
async fn past_the_limit_a_profile_answers_without_a_fetch() {
    let s = site_with_steam(
        |c| Config {
            lookups_per_hour: 0,
            ..c
        },
        |_| {},
        |calls| steam_knowing_me(calls, Duration::ZERO),
    )
    .await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "from the match");
    let (status, v) = json(&s.app, &format!("/api/players/{ME}")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v["name"], "from the match");
    assert_eq!(v["steamPending"], false);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// `https://skunk.club/` as the public URL: pages carry absolute links (a card's).
fn public(c: Config) -> Config {
    Config {
        public_url: Some(Url::parse("https://skunk.club/").unwrap()),
        ..c
    }
}

/// The card's JPEG: its size and the colour at (`x`, `y`).
fn card(jpeg: &[u8], x: usize, y: usize) -> ((u16, u16), (u8, u8, u8)) {
    let mut d = jpeg_decoder::Decoder::new(jpeg);
    let rgb = d.decode().unwrap();
    let info = d.info().unwrap();
    let i = (y * usize::from(info.width) + x) * 3;
    ((info.width, info.height), (rgb[i], rgb[i + 1], rgb[i + 2]))
}

fn near(a: (u8, u8, u8), b: (u8, u8, u8)) -> bool {
    a.0.abs_diff(b.0) <= 40 && a.1.abs_diff(b.1) <= 40 && a.2.abs_diff(b.2) <= 40
}

/// A profile link previews in Discord as a card the server draws, as a match link does: the
/// player's name and numbers on the site's black, edge to edge, 1200×630. Drawn once
/// for the numbers it shows (a new match draws a new one, the old one deleted), only for a
/// player the server holds, never a hidden one, and never asking Steam.
#[tokio::test]
async fn a_players_card_is_drawn_once_for_their_numbers() {
    let s = site(public, cached_me).await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "gabe");
    let uri = format!("/og/profile-{ME}.jpg");
    let (status, headers, first) = call(&s.app, &uri).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&first)
    );
    assert_eq!(headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(headers[header::CACHE_CONTROL], "public, max-age=3600");
    let (size, edge) = card(&first, 3, 315);
    assert_eq!(size, (1200, 630));
    assert!(near(edge, (0, 0, 0)), "no coloured edge: {edge:?}");
    let (_, _, again) = call(&s.app, &uri).await;
    assert_eq!(again, first, "the same numbers, the same card");
    stored(&s.store, 2, "de_nuke", 1_762_000_000, "gabe");
    let (_, _, newer) = call(&s.app, &uri).await;
    assert_ne!(newer, first, "a new match, a new card");
    let og = s._dir.path().join("data/og");
    let kept: Vec<_> = std::fs::read_dir(&og)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&format!("profile-{ME}")))
        .collect();
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}

/// The card shows the player's avatar once the server keeps it, which it fetches with their
/// profile when someone looks them up; drawing a card never asks Steam for it.
#[tokio::test]
async fn a_players_card_shows_the_avatar_kept_with_their_profile() {
    let s = site_with_steam(
        public,
        |_| {},
        |calls| steam_knowing_me(calls, Duration::ZERO),
    )
    .await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "from the match");
    let uri = format!("/og/profile-{ME}.jpg");
    let link = |page: &str| meta(page, "og:image").unwrap();
    let page = html(&s.app, &format!("/profiles/{ME}")).await;
    let (_, _, before) = call(&s.app, &uri).await;
    // Where the avatar goes: above the name, without one.
    let (_, at) = card(&before, 70, 130);
    assert!(near(at, (0, 0, 0)), "no avatar yet: {at:?}");
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);

    json(&s.app, &format!("/api/players/{ME}")).await;
    let kept = s._dir.path().join(format!("data/profiles/{ME}.jpg"));
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !kept.is_file() {
        assert!(
            std::time::Instant::now() < deadline,
            "the avatar was never kept"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    let asked = s.steam_calls.load(Ordering::SeqCst);
    let (status, _, after) = call(&s.app, &uri).await;
    assert_eq!(status, StatusCode::OK);
    let (_, at) = card(&after, 70, 130);
    assert!(near(at, AVATAR), "the avatar: {at:?}");
    assert_eq!(
        s.steam_calls.load(Ordering::SeqCst),
        asked,
        "the card asked nothing"
    );
    let newer = html(&s.app, &format!("/profiles/{ME}")).await;
    assert_ne!(link(&newer), link(&page), "a new card, a new link");
}

#[tokio::test]
async fn no_card_for_a_hidden_or_unknown_player() {
    let s = site(public, |data| {
        cached_me(data);
        hidden::edit(data, ME, true).unwrap();
    })
    .await;
    stored(&s.store, 1, "de_mirage", 1_761_000_000, "gabe");
    for uri in [
        format!("/og/profile-{ME}.jpg"),
        format!("/og/profile-{}.jpg", ME + 7),
        "/og/profile-gabe.jpg".to_owned(),
    ] {
        let (status, _, _) = call(&s.app, &uri).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
    }
    assert_eq!(s.steam_calls.load(Ordering::SeqCst), 0);
}
