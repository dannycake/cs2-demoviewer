//! The FACEIT poller: one task asks FACEIT for each tracked player's recent matches, keeps them
//! in the player's file (`faceit/<steamid>.json`) and fetches each match's demo through the
//! ingest, one at a time. FACEIT's Data API is a scripted fake; the job queue is the trackers'
//! stub ([`common::settle`]), whose records go done (or fail as told), so the poller is tested
//! alone.

mod common;

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use demoviewer_server::config::Config;
use demoviewer_server::faceit::{
    FaceitData, FaceitError, FaceitHistoryItem, FaceitLifetime, FaceitMatchDetail, FaceitPlayer,
};
use demoviewer_server::faceit_history::{DemoState, FaceitHistory};
use demoviewer_server::faceit_tracker::{
    spawn_faceit_tracker, CHECK_EVERY, FETCHES_PER_LOOK, FIRST_WINDOW, HISTORY_LIMIT, MAX_BACKOFF,
};
use demoviewer_server::gcbot::BoxFuture;
use demoviewer_server::ingest::UrlError;
use demoviewer_server::jobs::Jobs;
use demoviewer_server::matches::{GameMode, MatchSummary, SummaryPlayer, SUMMARY_VERSION};
use demoviewer_server::profiles::ProfileCache;
use demoviewer_server::seal::Key;
use demoviewer_server::store::{Source, Status, Store};
use demoviewer_server::tracker::MAX_FETCH_TRIES;
use demoviewer_server::tracking::{AuthCode, Tracking};
use serde_json::{json, Value};
use tokio::task::JoinHandle;

use common::{settle, Failures};

const A: u64 = 76561198000000001;
const B: u64 = 76561198000000002;
const C: u64 = 76561198000000003;
const D: u64 = 76561198000000004;
const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/// FACEIT's ids of the players, by steamid.
fn player_id(steamid: u64) -> String {
    format!("p-{}", steamid % 100)
}

/// FACEIT's id of match `n`.
fn match_n(n: u32) -> String {
    format!("1-0000000{n}-aaaa-4bbb-8ccc-dddddddddddd")
}

/// A demo URL the allowlist takes (a Valve replay host, until the spike names FACEIT's).
fn valve_demo(id: &str) -> String {
    format!("https://replay183.valve.net/730/{id}.dem.bz2")
}

/// A demo URL on FACEIT's CDN, which the allowlist does not take (yet).
fn cdn_demo(id: &str) -> String {
    format!("https://demos-us-east.backblaze.faceit-cdn.net/cs2/{id}.dem.gz")
}

/// The ten players of a match `steamids` played in, as [`FakeFaceit::play`] names them:
/// `steamids`, then strangers.
fn ten(steamids: &[u64]) -> Vec<u64> {
    let mut ten: Vec<u64> = steamids.to_vec();
    ten.extend((ten.len() as u64..10).map(|n| 76561198100000000 + n));
    ten
}

/// The sha of the demo [`uploaded`] stores with `tag`.
fn sha_of(tag: u8) -> String {
    format!("{tag:02x}").repeat(32)
}

/// An uploaded demo of a FACEIT match, done (as the job runner leaves one): its summary, on disk
/// and indexed, says FACEIT from its server's name, has `players` (the first five on the Ts'
/// side), `map` and `score` (the Ts', then the CTs') and no FACEIT match id; its pack is on disk
/// and its record was made at `created_unix`. Returns its demo id.
fn uploaded(
    store: &Store,
    tag: u8,
    players: &[u64],
    map: &str,
    score: [u8; 2],
    created_unix: u64,
) -> String {
    let sha = sha_of(tag);
    let summary = MatchSummary {
        sha256: sha.clone(),
        map: map.to_owned(),
        rounds: u16::from(score[0]) + u16::from(score[1]),
        score_t: score[0],
        score_ct: score[1],
        server_name: "FACEIT.com register to play here".to_owned(),
        players: players
            .iter()
            .enumerate()
            .map(|(i, id)| SummaryPlayer {
                steamid: id.to_string(),
                name: format!("p{i}"),
                team: if i < 5 { 2 } else { 3 },
                ..SummaryPlayer::default()
            })
            .collect(),
        created_unix,
        version: SUMMARY_VERSION,
        mode: Some(GameMode::Faceit),
        ..MatchSummary::default()
    };
    std::fs::write(
        store.summary_path(&sha),
        serde_json::to_vec(&summary).unwrap(),
    )
    .unwrap();
    std::fs::write(store.pack_path(&sha), b"pack").unwrap();
    store.matches().insert(summary);
    let id = Store::new_id();
    store.create(&id);
    store.update(&id, |r| {
        r.status = Status::Done;
        r.sha256 = Some(sha);
        r.map = Some(map.to_owned());
        r.created_unix = created_unix;
    });
    id
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

/// A call the fake got.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Player(u64),
    /// The player id, `from` and `limit`.
    History(String, u64, u32),
    Detail(String),
}

/// A scripted FACEIT: the players it knows by steamid, each player's matches (a history call
/// answers those finished since `from`, newest first) and each match's detail. Each call ends
/// with the next scripted error, if any, before it answers; a detail call first with the next
/// of that match's own errors; a history call of a `broken` player always fails. Records every
/// call.
#[derive(Default)]
struct FakeFaceit {
    players: Mutex<HashMap<u64, FaceitPlayer>>,
    played: Mutex<HashMap<String, Vec<FaceitHistoryItem>>>,
    details: Mutex<HashMap<String, FaceitMatchDetail>>,
    errors: Mutex<VecDeque<FaceitError>>,
    detail_errors: Mutex<HashMap<String, VecDeque<FaceitError>>>,
    broken: Mutex<HashSet<String>>,
    calls: Mutex<Vec<Call>>,
}

impl FakeFaceit {
    /// FACEIT has an account for `steamid`.
    fn player(&self, steamid: u64) {
        self.players.lock().unwrap().insert(
            steamid,
            FaceitPlayer {
                player_id: player_id(steamid),
                nickname: format!("nick{}", steamid % 100),
                steamid: Some(steamid),
                level: Some(7),
                elo: Some(1500),
            },
        );
    }

    /// `steamids` played match `id`, which finished at `finished` (the first of them won it
    /// 13–9), on Mirage, its demo at `demo_urls`.
    fn play(&self, steamids: &[u64], id: &str, finished: u64, demo_urls: &[String]) {
        let ten = ten(steamids);
        for s in steamids {
            self.played
                .lock()
                .unwrap()
                .entry(player_id(*s))
                .or_default()
                .push(FaceitHistoryItem {
                    match_id: id.to_owned(),
                    finished_unix: finished,
                    competition: Some("CS2 5v5".to_owned()),
                    score: Some([13, 9]),
                    won: Some(true),
                    players: ten.clone(),
                });
        }
        self.details.lock().unwrap().insert(
            id.to_owned(),
            FaceitMatchDetail {
                map: Some("de_mirage".to_owned()),
                demo_urls: demo_urls.to_vec(),
                players: ten,
                score: Some([13, 9]),
                finished_unix: Some(finished),
            },
        );
    }

    /// The next calls end with `errors`, one each.
    fn fail_next(&self, errors: Vec<FaceitError>) {
        self.errors.lock().unwrap().extend(errors);
    }

    /// The next detail calls for match `id` end with `errors`, one each.
    fn fail_detail(&self, id: &str, errors: Vec<FaceitError>) {
        self.detail_errors
            .lock()
            .unwrap()
            .entry(id.to_owned())
            .or_default()
            .extend(errors);
    }

    /// Every history call for `steamid`'s account fails, as FACEIT not answering.
    fn break_history(&self, steamid: u64) {
        self.broken.lock().unwrap().insert(player_id(steamid));
    }

    /// FACEIT posts the demo of match `id` at `url`, after the match.
    fn post_demo(&self, id: &str, url: &str) {
        self.details
            .lock()
            .unwrap()
            .get_mut(id)
            .expect("a match")
            .demo_urls = vec![url.to_owned()];
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().unwrap().clone()
    }

    fn details(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c {
                Call::Detail(id) => Some(id),
                _ => None,
            })
            .collect()
    }

    /// How many times match `id`'s detail was asked for.
    fn details_of(&self, id: &str) -> usize {
        self.details().iter().filter(|d| *d == id).count()
    }

    fn histories(&self) -> Vec<(String, u64)> {
        self.calls()
            .into_iter()
            .filter_map(|c| match c {
                Call::History(p, from, _) => Some((p, from)),
                _ => None,
            })
            .collect()
    }

    /// Notes `call`; the next scripted error, if any.
    fn called(&self, call: Call) -> Result<(), FaceitError> {
        self.calls.lock().unwrap().push(call);
        self.errors.lock().unwrap().pop_front().map_or(Ok(()), Err)
    }
}

impl FaceitData for FakeFaceit {
    fn player_by_steamid(
        &self,
        steamid: u64,
    ) -> BoxFuture<'_, Result<Option<FaceitPlayer>, FaceitError>> {
        Box::pin(async move {
            self.called(Call::Player(steamid))?;
            Ok(self.players.lock().unwrap().get(&steamid).cloned())
        })
    }
    fn player_by_nickname<'a>(
        &'a self,
        _name: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitPlayer>, FaceitError>> {
        Box::pin(async { Ok(None) })
    }
    fn lifetime_stats<'a>(
        &'a self,
        _player_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitLifetime>, FaceitError>> {
        Box::pin(async { Ok(None) })
    }
    fn history<'a>(
        &'a self,
        player_id: &'a str,
        from_unix: u64,
        limit: u32,
    ) -> BoxFuture<'a, Result<Vec<FaceitHistoryItem>, FaceitError>> {
        Box::pin(async move {
            self.called(Call::History(player_id.to_owned(), from_unix, limit))?;
            if self.broken.lock().unwrap().contains(player_id) {
                return Err(FaceitError::Unavailable("status 503".into()));
            }
            let mut items: Vec<_> = self
                .played
                .lock()
                .unwrap()
                .get(player_id)
                .into_iter()
                .flatten()
                .filter(|i| i.finished_unix >= from_unix)
                .cloned()
                .collect();
            items.sort_by_key(|i| std::cmp::Reverse(i.finished_unix));
            items.truncate(limit as usize);
            Ok(items)
        })
    }
    fn match_detail<'a>(
        &'a self,
        match_id: &'a str,
    ) -> BoxFuture<'a, Result<Option<FaceitMatchDetail>, FaceitError>> {
        Box::pin(async move {
            self.called(Call::Detail(match_id.to_owned()))?;
            let error = self
                .detail_errors
                .lock()
                .unwrap()
                .get_mut(match_id)
                .and_then(VecDeque::pop_front);
            if let Some(e) = error {
                return Err(e);
            }
            Ok(self.details.lock().unwrap().get(match_id).cloned())
        })
    }
}

struct World {
    _dir: tempfile::TempDir,
    data: PathBuf,
    store: Arc<Store>,
    tracking: Arc<Tracking>,
    histories: Arc<FaceitHistory>,
    profiles: Arc<ProfileCache>,
    faceit: Arc<FakeFaceit>,
    jobs_tx: Jobs,
    /// The URLs of the jobs the stub queue received.
    jobs: Arc<Mutex<Vec<String>>>,
    /// The most jobs in flight at once.
    most: Arc<AtomicUsize>,
    /// Per URL, the errors its next fetches end with, one each.
    fail: Failures,
}

impl World {
    /// Starts the poller.
    fn start(&self) -> JoinHandle<()> {
        spawn_faceit_tracker(
            self.store.clone(),
            self.jobs_tx.clone(),
            self.tracking.clone(),
            self.histories.clone(),
            self.faceit.clone() as Arc<dyn FaceitData>,
            self.profiles.clone(),
        )
    }

    /// `steamid` links their account for tracking.
    fn link(&self, steamid: u64) {
        let code = AuthCode::parse("ABCD-EFGHI-JKLM").unwrap();
        self.tracking
            .link(steamid, &code, "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")
            .unwrap();
    }

    /// `steamid`'s file, as JSON.
    fn file(&self, steamid: u64) -> Value {
        let path = self.data.join("faceit").join(format!("{steamid}.json"));
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap()
    }

    /// The demo state of each of `steamid`'s rows, newest first.
    fn demos(&self, steamid: u64) -> Vec<(String, DemoState)> {
        self.histories
            .get(steamid)
            .unwrap()
            .unwrap()
            .matches
            .into_iter()
            .map(|m| (m.match_id, m.demo))
            .collect()
    }

    /// Every FACEIT record, as (FACEIT match id, status), by match id.
    fn records(&self) -> Vec<(String, Status)> {
        let mut r: Vec<_> = self
            .store
            .records()
            .into_iter()
            .filter(|r| r.source == Source::Faceit)
            .map(|r| (r.faceit_match_id.unwrap_or_default(), r.status))
            .collect();
        r.sort_by(|a, b| a.0.cmp(&b.0));
        r
    }

    /// The id of the record that answers for FACEIT match `id`.
    fn held(&self, id: &str) -> DemoState {
        DemoState::Held(self.store.find_faceit(id).expect("a record").id)
    }
}

fn world() -> World {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let cfg = Config {
        data_dir: data.clone(),
        ..Config::default()
    };
    let store = Arc::new(Store::open(&cfg).unwrap());
    let tracking = Tracking::open(&data, Some(Key::from_hex(KEY).unwrap())).unwrap();
    let histories = FaceitHistory::open(&data).unwrap();
    let profiles = ProfileCache::open_with(&data.join("profiles"), None, None, None).unwrap();
    let (jobs_tx, rx) = Jobs::channel();
    let fail = Failures::default();
    let (jobs, most) = settle(store.clone(), rx, fail.clone());
    World {
        _dir: dir,
        data,
        store,
        tracking,
        histories,
        profiles,
        faceit: Arc::new(FakeFaceit::default()),
        jobs_tx,
        jobs,
        most,
        fail,
    }
}

/// Lets the poller run for `d` of (paused) time.
async fn run_for(d: Duration) {
    let step = Duration::from_millis(500);
    let mut t = Duration::ZERO;
    while t < d {
        tokio::time::sleep(step).await;
        t += step;
    }
}

#[tokio::test(start_paused = true)]
async fn the_poller_claims_one_record_per_new_match() {
    let w = world();
    let now = unix_now();
    let (m1, m2) = (match_n(1), match_n(2));
    w.faceit.player(A);
    w.faceit.player(B);
    w.faceit
        .play(&[A], &m1, now - 7200, &[valve_demo(&m1), cdn_demo(&m1)]);
    // B played the newer one with A.
    w.faceit.play(&[A, B], &m2, now - 3600, &[valve_demo(&m2)]);
    w.link(A);
    w.link(B);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    assert_eq!(
        w.records(),
        [(m1.clone(), Status::Done), (m2.clone(), Status::Done)]
    );
    let mut jobs = w.jobs.lock().unwrap().clone();
    jobs.sort();
    assert_eq!(jobs, [valve_demo(&m1), valve_demo(&m2)]);
    assert_eq!(w.most.load(Ordering::SeqCst), 1, "one download at a time");
    // Each row holds its match's one record, B's too; newest first.
    assert_eq!(
        w.demos(A),
        [(m2.clone(), w.held(&m2)), (m1.clone(), w.held(&m1))]
    );
    assert_eq!(w.demos(B), [(m2.clone(), w.held(&m2))]);
    // The file, as Task 7 reads it.
    let file = w.file(A);
    let DemoState::Held(id) = w.held(&m2) else {
        unreachable!()
    };
    assert_eq!(file["playerId"], json!(player_id(A)));
    assert_eq!(file["nickname"], json!("nick1"));
    assert_eq!(file["cursorUnix"], json!(now - 3600));
    assert_eq!(file["tries"], json!(0));
    let row = &file["matches"][0];
    assert_eq!(row["matchId"], json!(m2));
    assert_eq!(row["finishedUnix"], json!(now - 3600));
    assert_eq!(row["map"], json!("de_mirage"));
    assert_eq!(row["score"], json!([13, 9]));
    assert_eq!(row["won"], json!(true));
    assert_eq!(row["competition"], json!("CS2 5v5"));
    assert_eq!(row["players"].as_array().unwrap().len(), 10);
    assert_eq!(row["players"][0], json!(A));
    assert_eq!(row["demo"], json!({ "held": id }));
    assert!(row.get("demoUrl").is_none(), "{row}");
    // The record carries the match's facts.
    let rec = w.store.find_faceit(&m2).unwrap();
    assert_eq!(rec.played_unix, Some(now - 3600));

    // Checked again later: nothing new, nothing claimed again.
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert_eq!(w.jobs.lock().unwrap().len(), 2);
    assert_eq!(w.records().len(), 2);
}

/// Review Focus 2: a match whose demo FACEIT refuses is kept as unavailable and never tried
/// again. One FACEIT has no demo for yet (it posts it a little after the match ends) is kept
/// as pending, with nothing claimed or downloaded, and its detail is asked for again on later
/// looks.
#[tokio::test(start_paused = true)]
async fn a_refused_demo_is_marked_unavailable_once() {
    let w = world();
    let now = unix_now();
    let (refused, none) = (match_n(1), match_n(2));
    w.faceit.player(A);
    w.faceit
        .play(&[A], &refused, now - 7200, &[valve_demo(&refused)]);
    w.faceit.play(&[A], &none, now - 3600, &[]);
    w.fail.lock().unwrap().insert(
        valve_demo(&refused),
        [format!("download failed: {}", UrlError::Http(403))].into(),
    );
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    assert_eq!(
        w.demos(A),
        [
            (none.clone(), DemoState::Pending),
            (refused.clone(), DemoState::Unavailable)
        ]
    );
    assert_eq!(*w.jobs.lock().unwrap(), [valve_demo(&refused)]);
    // The refused fetch's record failed; the match without a demo has none.
    assert_eq!(w.records(), [(refused.clone(), Status::Error)]);
    let file = w.file(A);
    assert_eq!(file["matches"][0]["demo"], json!("pending"));
    assert_eq!(file["matches"][0]["detailTries"], json!(1));
    assert!(file["matches"][0].get("demoUrl").is_none());
    assert_eq!(file["matches"][1]["demo"], json!("unavailable"));
    assert_eq!(w.faceit.details_of(&none), 1, "not again in the same look");

    run_for(3 * CHECK_EVERY).await;
    assert_eq!(*w.jobs.lock().unwrap(), [valve_demo(&refused)], "no retry");
    assert_eq!(w.faceit.details_of(&refused), 1, "detailed once");
    assert!(w.faceit.details_of(&none) >= 3, "asked again on each look");
    assert_eq!(w.records(), [(refused, Status::Error)]);
    assert_eq!(
        w.histories.get(A).unwrap().unwrap().tries,
        0,
        "not a failure"
    );
}

/// FACEIT posts a match's demo after the match ends: a look that saw it first without one asks
/// again on the next, and fetches it then.
#[tokio::test(start_paused = true)]
async fn a_demo_url_posted_late_is_fetched() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 60, &[]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Pending)]);
    assert!(w.jobs.lock().unwrap().is_empty());
    assert!(w.records().is_empty());

    w.faceit.post_demo(&m1, &valve_demo(&m1));
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert_eq!(w.faceit.details(), [m1.clone(), m1.clone()]);
    assert_eq!(*w.jobs.lock().unwrap(), [valve_demo(&m1)]);
    assert_eq!(w.demos(A), [(m1.clone(), w.held(&m1))]);
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.tries, 0);
    assert_eq!(entry.matches[0].map.as_deref(), Some("de_mirage"));
}

/// A match FACEIT never posts a demo for is asked about on [`MAX_FETCH_TRIES`] looks in all
/// (the one that made its row included), then kept as unavailable and never asked about again.
#[tokio::test(start_paused = true)]
async fn a_match_that_never_gets_a_demo_is_given_up_after_eight_checks() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    run_for(MAX_FETCH_TRIES * CHECK_EVERY).await;

    assert_eq!(w.faceit.details_of(&m1), MAX_FETCH_TRIES as usize);
    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Unavailable)]);
    assert_eq!(w.file(A)["matches"][0]["demo"], json!("unavailable"));
    assert!(w.jobs.lock().unwrap().is_empty());
    assert!(w.records().is_empty());
    assert_eq!(
        w.histories.get(A).unwrap().unwrap().tries,
        0,
        "never backed off"
    );

    run_for(3 * CHECK_EVERY).await;
    assert_eq!(
        w.faceit.details_of(&m1),
        MAX_FETCH_TRIES as usize,
        "never again"
    );
}

/// A detail FACEIT did not give (an error status, not a 429) keeps the match's row without
/// it: the cursor moves past the match, and a later look asks for the detail again.
#[tokio::test(start_paused = true)]
async fn a_match_whose_detail_failed_is_kept_and_asked_again() {
    let w = world();
    let now = unix_now();
    let (m1, m2) = (match_n(1), match_n(2));
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 7200, &[valve_demo(&m1)]);
    w.faceit.play(&[A], &m2, now - 3600, &[valve_demo(&m2)]);
    w.faceit
        .fail_detail(&m1, vec![FaceitError::Unavailable("status 500".into())]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.cursor_unix, Some(now - 3600), "past the match");
    assert_eq!(entry.tries, 0);
    assert_eq!(
        w.demos(A),
        [(m2.clone(), w.held(&m2)), (m1.clone(), DemoState::Pending)]
    );
    assert_eq!(entry.matches[1].players.len(), 10, "the history's players");

    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert_eq!(w.faceit.details(), [m1.clone(), m2.clone(), m1.clone()]);
    assert_eq!(
        w.demos(A),
        [(m2.clone(), w.held(&m2)), (m1.clone(), w.held(&m1))]
    );
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.matches[1].map.as_deref(), Some("de_mirage"));
}

/// A look starts at most [`FETCHES_PER_LOOK`] downloads, so one player's backlog does not hold
/// up the others; the rest wait, pending, for the next look.
#[tokio::test(start_paused = true)]
async fn each_look_starts_at_most_three_downloads() {
    let w = world();
    let now = unix_now();
    w.faceit.player(A);
    let ids: Vec<String> = (1..=5).map(match_n).collect();
    for (n, id) in ids.iter().enumerate() {
        w.faceit
            .play(&[A], id, now - 3600 * (6 - n as u64), &[valve_demo(id)]);
    }
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    assert_eq!(FETCHES_PER_LOOK, 3);
    assert_eq!(w.jobs.lock().unwrap().len(), FETCHES_PER_LOOK);
    let states: Vec<bool> = w
        .demos(A)
        .into_iter()
        .map(|(_, d)| matches!(d, DemoState::Held(_)))
        .collect();
    assert_eq!(states, [true, true, true, false, false], "the newest first");
    assert_eq!(w.histories.get(A).unwrap().unwrap().tries, 0);

    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert_eq!(w.jobs.lock().unwrap().len(), 5);
    assert!(w
        .demos(A)
        .iter()
        .all(|(_, d)| matches!(d, DemoState::Held(_))));
}

/// A corrupt file is set aside and the player is looked at afresh; one that cannot be read (a
/// directory in its place) skips that player, and is left as it is, while others go on.
#[tokio::test(start_paused = true)]
async fn a_corrupt_file_is_set_aside_and_an_unreadable_one_skips_the_player() {
    let w = world();
    let now = unix_now();
    let dir = w.data.join("faceit");
    std::fs::write(dir.join(format!("{A}.json")), b"{not json").unwrap();
    std::fs::create_dir(dir.join(format!("{B}.json"))).unwrap();
    for (n, s) in [A, B].into_iter().enumerate() {
        w.faceit.player(s);
        let m = match_n(n as u32 + 1);
        w.faceit.play(&[s], &m, now - 3600, &[valve_demo(&m)]);
    }
    w.link(A);
    w.link(B);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    run_for(CHECK_EVERY).await;

    assert_eq!(w.demos(A), [(match_n(1), w.held(&match_n(1)))]);
    let aside: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with(&format!("{A}.json.corrupt-")))
        .collect();
    assert_eq!(aside.len(), 1, "{aside:?}");
    assert_eq!(std::fs::read(dir.join(&aside[0])).unwrap(), b"{not json");
    let asked_b = w.faceit.calls().into_iter().any(|c| match c {
        Call::Player(s) => s == B,
        Call::History(p, ..) => p == player_id(B),
        Call::Detail(_) => false,
    });
    assert!(!asked_b, "B is skipped");
    assert!(dir.join(format!("{B}.json")).is_dir(), "and left as it is");
    assert!(w.histories.get(B).is_err());
}

/// A player FACEIT keeps failing for is backed off alone: another is looked at every fifteen
/// minutes all the while.
#[tokio::test(start_paused = true)]
async fn a_failing_player_does_not_delay_another() {
    let w = world();
    w.faceit.player(A);
    w.faceit.player(B);
    w.faceit.break_history(A);
    w.link(A);
    w.link(B);
    let _poller = w.start();
    run_for(Duration::from_secs(3600 + 60)).await;
    let looks = |s: u64| {
        w.faceit
            .histories()
            .into_iter()
            .filter(|(p, _)| *p == player_id(s))
            .count()
    };
    assert_eq!(looks(B), 5, "every fifteen minutes");
    assert!(looks(A) >= 5, "{} looks at A", looks(A));
    assert!(w.histories.get(A).unwrap().unwrap().tries >= 5);
    assert_eq!(w.histories.get(B).unwrap().unwrap().tries, 0);
}

/// After looks that failed, one that works puts the player back on the fifteen-minute
/// schedule.
#[tokio::test(start_paused = true)]
async fn tries_go_back_to_zero_after_a_look_that_works() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    w.faceit
        .fail_next(vec![FaceitError::Unavailable("status 503".into()); 3]);
    w.link(A);
    let _poller = w.start();
    // Fails at 0 s, 60 s and 180 s; works at 420 s.
    run_for(Duration::from_secs(200)).await;
    assert_eq!(w.histories.get(A).unwrap().unwrap().tries, 3);
    run_for(Duration::from_secs(400)).await;
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.tries, 0);
    assert_eq!(w.demos(A), [(m1.clone(), w.held(&m1))]);
    assert!(entry.next_unix >= now + 420 + CHECK_EVERY.as_secs() - 5);
}

/// Review Focus 1: FACEIT turns the key away mid-run; the poller stops (its task ends), asks
/// FACEIT nothing more, and the file keeps what it had.
#[tokio::test(start_paused = true)]
async fn a_revoked_key_stops_the_poller() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.player(B);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    w.link(A);
    w.link(B);
    let poller = w.start();
    run_for(Duration::from_secs(60)).await;
    assert_eq!(w.demos(A), [(m1.clone(), w.held(&m1))]);
    assert!(!poller.is_finished());

    w.faceit.fail_next(vec![FaceitError::Unauthorized]);
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert!(poller.is_finished(), "the poller stopped");
    let calls = w.faceit.calls().len();
    run_for(4 * MAX_BACKOFF).await;
    assert_eq!(w.faceit.calls().len(), calls, "no call after the stop");
    assert_eq!(w.demos(A), [(m1.clone(), w.held(&m1))], "the file is kept");
}

#[tokio::test(start_paused = true)]
async fn the_cursor_advances_and_old_matches_are_not_refetched() {
    let w = world();
    let start = unix_now();
    let (m1, m2, m3) = (match_n(1), match_n(2), match_n(3));
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, start - 7200, &[valve_demo(&m1)]);
    w.faceit.play(&[A], &m2, start - 3600, &[valve_demo(&m2)]);
    // Older than the first look goes back: never asked for.
    w.faceit.play(
        &[A],
        &match_n(9),
        start - FIRST_WINDOW.as_secs() - 3600,
        &[valve_demo(&match_n(9))],
    );
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    let first = w.faceit.histories();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].0, player_id(A));
    let window = start - FIRST_WINDOW.as_secs();
    assert!(
        (window..window + 10).contains(&first[0].1),
        "the first look goes {} s back",
        start - first[0].1
    );
    assert_eq!(
        w.histories.get(A).unwrap().unwrap().cursor_unix,
        Some(start - 3600)
    );
    let limits: Vec<u32> = w
        .faceit
        .calls()
        .into_iter()
        .filter_map(|c| match c {
            Call::History(_, _, limit) => Some(limit),
            _ => None,
        })
        .collect();
    assert_eq!(limits, [HISTORY_LIMIT]);
    assert_eq!(HISTORY_LIMIT, 100, "FACEIT's cap");

    // A new match; FACEIT answers the cursor's match again with it.
    w.faceit.play(&[A], &m3, start + 60, &[valve_demo(&m3)]);
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    let later = w.faceit.histories();
    assert_eq!(later.len(), 2);
    assert_eq!(later[1], (player_id(A), start - 3600), "from the cursor");
    assert_eq!(w.faceit.details(), [m1.clone(), m2.clone(), m3.clone()]);
    assert_eq!(
        w.histories.get(A).unwrap().unwrap().cursor_unix,
        Some(start + 60)
    );
    let rows: Vec<String> = w.demos(A).into_iter().map(|(m, _)| m).collect();
    assert_eq!(rows, [m3.clone(), m2, m1]);
    assert_eq!(w.jobs.lock().unwrap().len(), 3);
    // The player was looked up once: their id is kept.
    let lookups = w
        .faceit
        .calls()
        .into_iter()
        .filter(|c| matches!(c, Call::Player(_)))
        .count();
    assert_eq!(lookups, 1);
}

#[tokio::test(start_paused = true)]
async fn only_tracked_players_are_polled() {
    let w = world();
    let now = unix_now();
    for (n, s) in [A, B, C, D].into_iter().enumerate() {
        w.faceit.player(s);
        let m = match_n(n as u32 + 1);
        w.faceit.play(&[s], &m, now - 3600, &[valve_demo(&m)]);
    }
    // A is tracked; B stopped tracking; C's code was refused; D never linked.
    w.link(A);
    w.link(B);
    w.tracking.unlink(B).unwrap();
    w.link(C);
    w.tracking.stop(C, "revoked").unwrap();
    assert_eq!(w.tracking.tracked(), [A]);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    run_for(CHECK_EVERY).await;

    let asked: Vec<Call> = w
        .faceit
        .calls()
        .into_iter()
        .filter(|c| !matches!(c, Call::Detail(_)))
        .collect();
    assert!(!asked.is_empty());
    assert!(
        asked.iter().all(|c| match c {
            Call::Player(s) => *s == A,
            Call::History(p, ..) => *p == player_id(A),
            Call::Detail(_) => true,
        }),
        "{asked:?}"
    );
    assert_eq!(w.records(), [(match_n(1), Status::Done)]);
    for s in [B, C, D] {
        assert!(w.histories.get(s).unwrap().is_none(), "no file for {s}");
    }

    // A stops: no more calls for them.
    w.tracking.unlink(A).unwrap();
    let calls = w.faceit.calls().len();
    run_for(3 * CHECK_EVERY).await;
    assert_eq!(w.faceit.calls().len(), calls);
}

/// A kept profile that names the player's FACEIT id spares the lookup by steamid.
#[tokio::test(start_paused = true)]
async fn a_kept_profiles_faceit_id_spares_the_lookup() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    let profile = json!({
        "steamid": A, "name": "a", "avatar": null, "since_year": null, "country": null,
        "cs2_hours": null, "vac_bans": null, "game_bans": null, "fetched_unix": now,
        "faceit": {"nickname": "kept", "level": 7, "elo": 1500, "playerId": player_id(A)}
    });
    std::fs::write(
        w.data.join("profiles").join(format!("{A}.json")),
        profile.to_string(),
    )
    .unwrap();
    assert!(w.profiles.peek(A).await.unwrap().faceit.is_some());
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    let calls = w.faceit.calls();
    assert!(
        !calls.iter().any(|c| matches!(c, Call::Player(_))),
        "{calls:?}"
    );
    assert_eq!(w.demos(A), [(m1.clone(), w.held(&m1))]);
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.player_id, Some(player_id(A)));
    assert_eq!(entry.nickname.as_deref(), Some("kept"));
}

/// Until the spike puts FACEIT's demo hosts on the allowlist, a FACEIT demo URL fails the check:
/// the row stays pending and nothing is claimed or fetched.
#[tokio::test(start_paused = true)]
async fn a_demo_off_the_allowlist_stays_pending_without_a_record() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[cdn_demo(&m1)]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    run_for(2 * CHECK_EVERY).await;

    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Pending)]);
    assert_eq!(w.file(A)["matches"][0]["demo"], json!("pending"));
    assert!(w.records().is_empty());
    assert!(w.jobs.lock().unwrap().is_empty());
    assert_eq!(w.faceit.details(), [m1], "detailed once");
    let entry = w.histories.get(A).unwrap().unwrap();
    assert_eq!(entry.tries, 0, "not a failure");
}

/// A fetch that fails on the way (not a refusal) leaves the row pending and is tried again, up
/// to [`MAX_FETCH_TRIES`] times in all; then the row is unavailable.
#[tokio::test(start_paused = true)]
async fn a_demo_that_keeps_failing_is_given_up_after_eight_tries() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    w.fail.lock().unwrap().insert(
        valve_demo(&m1),
        vec!["download failed: the download was cut off".to_owned(); 20].into(),
    );
    w.link(A);
    let _poller = w.start();
    // The first try fails at once; the next is a minute later.
    run_for(Duration::from_secs(30)).await;
    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Pending)]);
    assert_eq!(
        w.histories.get(A).unwrap().unwrap().matches[0].fetch_tries,
        1
    );
    assert_eq!(w.histories.get(A).unwrap().unwrap().tries, 1, "backed off");

    run_for(Duration::from_secs(6 * 3600)).await;
    let jobs = w.jobs.lock().unwrap().clone();
    assert_eq!(jobs.len(), MAX_FETCH_TRIES as usize, "{jobs:?}");
    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Unavailable)]);
    assert_eq!(w.faceit.details(), [m1], "detailed once");
}

#[tokio::test(start_paused = true)]
async fn an_unavailable_faceit_backs_off_up_to_two_hours() {
    let w = world();
    w.faceit.player(A);
    w.faceit
        .fail_next(vec![FaceitError::Unavailable("status 503".into()); 40]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(6 * 3600)).await;
    let n = w.faceit.calls().len();
    // Backing off by doubling to two hours: far fewer than one call every fifteen minutes.
    assert!((4..=10).contains(&n), "{n} calls in six hours");
    assert!(w.histories.get(A).unwrap().unwrap().tries >= 4);
}

/// An uploaded FACEIT demo carries no time it was played, so a row takes it by its facts: the
/// same ten players, map and score (either side's first). The row is held by it with no
/// download, and its record and summary (on disk too) take the match's FACEIT id, so the room
/// link finds it and it is under the FACEIT tab. Of two uploads of it, the older is taken; the
/// other is left as it was. A match whose demo FACEIT refused is rescued by an upload, on the
/// next look.
#[tokio::test(start_paused = true)]
async fn an_uploaded_faceit_demo_attaches_to_its_history_row() {
    let w = world();
    let now = unix_now();
    let (m1, m2) = (match_n(1), match_n(2));
    w.faceit.player(A);
    // m1's demo is fetchable, so an attach after the fetches would come too late; m2's is
    // refused. A played m2 with B, so its ten are others.
    w.faceit.play(&[A], &m1, now - 7200, &[valve_demo(&m1)]);
    w.faceit.play(&[A, B], &m2, now - 3600, &[valve_demo(&m2)]);
    w.fail.lock().unwrap().insert(
        valve_demo(&m2),
        [format!("download failed: {}", UrlError::Http(403))].into(),
    );
    // m1's demo, uploaded twice as two files; A's side ended on CT, 13 to the Ts' 9.
    let older = uploaded(&w.store, 1, &ten(&[A]), "de_mirage", [9, 13], 1_000);
    let newer = uploaded(&w.store, 2, &ten(&[A]), "de_mirage", [9, 13], 2_000);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    assert_eq!(
        w.demos(A),
        [
            (m2.clone(), DemoState::Unavailable),
            (m1.clone(), DemoState::Held(older.clone()))
        ]
    );
    assert_eq!(
        *w.jobs.lock().unwrap(),
        [valve_demo(&m2)],
        "nothing fetched for the upload's match"
    );
    assert_eq!(w.file(A)["matches"][1]["demo"], json!({ "held": older }));
    let rec = w.store.get(&older).unwrap();
    assert_eq!(rec.faceit_match_id.as_deref(), Some(m1.as_str()));
    assert_eq!(rec.status, Status::Done);
    assert_eq!(w.store.find_faceit(&m1).map(|r| r.id), Some(older.clone()));
    let summary = w.store.matches().get(&sha_of(1)).unwrap();
    assert_eq!(summary.faceit_match_id.as_deref(), Some(m1.as_str()));
    assert_eq!(summary.mode, Some(GameMode::Faceit));
    let on_disk: Value =
        serde_json::from_slice(&std::fs::read(w.store.summary_path(&sha_of(1))).unwrap()).unwrap();
    assert_eq!(on_disk["faceitMatchId"], json!(m1));
    assert_eq!(on_disk["mode"], json!("faceit"));
    assert_eq!(w.store.get(&newer).unwrap().faceit_match_id, None);
    assert_eq!(
        w.store.matches().get(&sha_of(2)).unwrap().faceit_match_id,
        None
    );

    // m2's demo is uploaded later: the next look holds its row by it.
    let rescue = uploaded(&w.store, 3, &ten(&[A, B]), "de_mirage", [13, 9], 3_000);
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;
    assert_eq!(w.demos(A)[0], (m2.clone(), DemoState::Held(rescue.clone())));
    assert_eq!(
        w.store.get(&rescue).unwrap().faceit_match_id.as_deref(),
        Some(m2.as_str())
    );
    assert_eq!(
        *w.jobs.lock().unwrap(),
        [valve_demo(&m2)],
        "still one download"
    );
    assert_eq!(w.demos(A)[1], (m1, DemoState::Held(older)));
}

/// A row held by a demo whose record is forgotten since (an evicted pack makes it fail, and a
/// failed record is forgotten in time) is pending again on the next look, and an upload of the
/// match then attaches to it, rather than the row staying held by nothing.
#[tokio::test(start_paused = true)]
async fn a_row_held_by_a_forgotten_record_is_pending_and_attaches_again() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;
    let first = w.held(&m1);
    assert_eq!(w.demos(A), [(m1.clone(), first.clone())]);
    let DemoState::Held(first_id) = first else {
        unreachable!()
    };

    // The pack is evicted: the record fails, then is forgotten. The match is uploaded by hand.
    w.store.update(&first_id, |r| {
        r.status = Status::Error;
        r.failed_unix = Some(1);
    });
    assert_eq!(w.store.forget_failed(Duration::from_secs(60)), 1);
    let upload = uploaded(&w.store, 1, &ten(&[A]), "de_mirage", [9, 13], 1_000);
    run_for(CHECK_EVERY + Duration::from_secs(60)).await;

    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Held(upload.clone()))]);
    assert_eq!(w.store.find_faceit(&m1).map(|r| r.id), Some(upload));
    assert_eq!(w.jobs.lock().unwrap().len(), 1, "no second download");
}

/// An attach cut short by a restart, the summary renamed into place with the match's FACEIT id
/// and the record's save lost, is finished by the next pass: the row is held by the upload, and
/// the record takes the id, so the room link finds it. Nothing is downloaded.
#[tokio::test(start_paused = true)]
async fn a_half_done_attach_is_finished() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[valve_demo(&m1)]);
    let id = uploaded(&w.store, 1, &ten(&[A]), "de_mirage", [9, 13], 1_000);
    let mut half = (*w.store.matches().get(&sha_of(1)).unwrap()).clone();
    half.faceit_match_id = Some(m1.clone());
    std::fs::write(
        w.store.summary_path(&sha_of(1)),
        serde_json::to_vec(&half).unwrap(),
    )
    .unwrap();
    w.store.matches().insert(half);
    assert_eq!(w.store.find_faceit(&m1), None, "the record has no id");
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Held(id.clone()))]);
    assert_eq!(w.store.find_faceit(&m1).map(|r| r.id), Some(id));
    assert!(w.jobs.lock().unwrap().is_empty(), "nothing fetched");
}

/// A demo of the same ten players on the same map with another score is another match, and so is
/// one of the same score with a stranger for one of the ten: neither is taken, and the row
/// stays pending.
#[tokio::test(start_paused = true)]
async fn a_near_miss_does_not_attach() {
    let w = world();
    let now = unix_now();
    let m1 = match_n(1);
    w.faceit.player(A);
    w.faceit.play(&[A], &m1, now - 3600, &[]);
    let score = uploaded(&w.store, 1, &ten(&[A]), "de_mirage", [11, 13], 1_000);
    let mut nine = ten(&[A]);
    nine[9] = C;
    let stranger = uploaded(&w.store, 2, &nine, "de_mirage", [9, 13], 2_000);
    w.link(A);
    let _poller = w.start();
    run_for(Duration::from_secs(60)).await;

    assert_eq!(w.demos(A), [(m1.clone(), DemoState::Pending)]);
    assert_eq!(w.store.find_faceit(&m1), None);
    for (id, tag) in [(score, 1), (stranger, 2)] {
        assert_eq!(w.store.get(&id).unwrap().faceit_match_id, None);
        assert_eq!(
            w.store.matches().get(&sha_of(tag)).unwrap().faceit_match_id,
            None
        );
    }
}

/// The server polls FACEIT with a FACEIT key, Steam or not; without one it does not.
#[tokio::test]
async fn the_server_polls_faceit_only_with_a_key() {
    use axum::extract::Query;
    use demoviewer_server::app::build_app;
    use demoviewer_server::faceit::FaceitKey;
    use demoviewer_server::ratelimit::RateLimiter;

    /// A fake Data API that has no players, counting the lookups by steamid it gets.
    async fn fake(asked: Arc<Mutex<Vec<String>>>) -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/", listener.local_addr().unwrap());
        let app = axum::Router::new().route(
            "/players",
            axum::routing::get(move |q: Query<HashMap<String, String>>| async move {
                asked
                    .lock()
                    .unwrap()
                    .push(q.get("game_player_id").cloned().unwrap_or_default());
                axum::http::StatusCode::NOT_FOUND
            }),
        );
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        url::Url::parse(&base).unwrap()
    }

    for keyed in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let key = Key::from_hex(KEY).unwrap();
        let code = AuthCode::parse("ABCD-EFGHI-JKLM").unwrap();
        Tracking::open(&data, Some(key.clone()))
            .unwrap()
            .link(A, &code, "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")
            .unwrap();
        let asked = Arc::new(Mutex::new(Vec::new()));
        let cfg = Arc::new(Config {
            data_dir: data.clone(),
            tracking_key: Some(key),
            faceit_api_key: if keyed {
                FaceitKey::new("00000000-1111-2222-3333-444444444444")
            } else {
                None
            },
            faceit_data_api: fake(asked.clone()).await,
            ..Config::default()
        });
        let store = Arc::new(Store::open(&cfg).unwrap());
        let (jobs, _rx) = Jobs::channel();
        let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
        let _app = build_app(cfg, store, jobs, limiter);
        // Without a key the missing directory says no poller started: nothing to wait for.
        let file = data.join("faceit").join(format!("{A}.json"));
        for _ in 0..100 {
            if !keyed || file.is_file() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let want: &[String] = if keyed { &[A.to_string()] } else { &[] };
        assert_eq!(*asked.lock().unwrap(), want, "keyed: {keyed}");
        assert_eq!(data.join("faceit").is_dir(), keyed);
        if keyed {
            // FACEIT has no account for them: they are looked at again in fifteen minutes.
            let entry = FaceitHistory::open(&data).unwrap().get(A).unwrap().unwrap();
            assert_eq!(entry.player_id, None);
            assert!(entry.next_unix >= unix_now() + CHECK_EVERY.as_secs() - 60);
        }
    }
}
