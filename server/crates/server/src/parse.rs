//! Demo → [`Match`]: runs the vendored demoparser over a CS2 demo and adapts its output to
//! the DVPK pack types.

mod events;
mod grenades;
mod props;
mod rounds;
mod tracks;
mod world;

use std::any::Any;
use std::collections::BTreeMap;
use std::fmt;
use std::fs::File;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;

use ahash::AHashMap;
use demoviewer_pack::{Match, MatchHeader, PlayerInfo, RoundInfo, PACK_VERSION};
use parser::first_pass::read_bits::DemoParserError;

/// CS2 servers simulate 64 ticks per second; demos do not record the rate.
const TICK_RATE: u32 = 64;
/// Samples per second in player and grenade tracks.
const SAMPLE_HZ: u32 = 32;
/// A player row older than this many ticks counts as no data (half a second).
const MAX_ROW_AGE: i32 = TICK_RATE as i32 / 2;
/// The longest after-round a round's tracks cover: CS2's restart delay is 7 s.
const POST_END_TICKS: i32 = 10 * TICK_RATE as i32;
/// Longest round accepted, from `round_start` to `round_end`: one hour. A real round lasts a
/// few minutes, or longer with a long technical pause in freeze time. Round ticks come
/// straight from the demo's frame headers, so a longer span means edited or corrupt ticks.
pub const MAX_ROUND_TICKS: i64 = 60 * 60 * TICK_RATE as i64;
/// Most track samples a match may hold, summed over rounds and players (15 bytes each in
/// memory, 19 in the pack): 6 million, about 115 MB of pack, well under the
/// `MAX_PACK_BYTES` a viewer will open. A 30-round match with 10 players needs about 1.2
/// million, and a four-hour match with 12 players about 5.5 million.
pub const MAX_TRACK_SAMPLES: u64 = 6_000_000;

/// Why a demo could not be turned into a [`Match`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError(pub String);

impl fmt::Display for ParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ParseError {}

impl From<DemoParserError> for ParseError {
    fn from(e: DemoParserError) -> Self {
        ParseError(format!("demo parser: {e}"))
    }
}

/// Parses the demo at `path` (memory-mapped). A file that cannot be opened or mapped is the
/// server's trouble, not the demo's: the error says so, and the path and OS error are logged.
pub fn parse_file(path: &Path) -> Result<Match, ParseError> {
    let unreadable = |e: std::io::Error| {
        tracing::error!(path = %path.display(), error = %e, "cannot read the demo to parse it");
        ParseError("the server could not read the demo; try again later".into())
    };
    let file = File::open(path).map_err(unreadable)?;
    // SAFETY: the map is read-only and lives only for this call; the server owns the file and
    // nothing truncates it while it is being parsed.
    let map = unsafe { memmap2::Mmap::map(&file) }.map_err(unreadable)?;
    parse_demo(&map)
}

/// Parses a CS2 demo. Anything else, or a demo the parser chokes on, is an `Err`; a panic
/// inside the parser is caught and reported as one. A demo cut short parses to the rounds it
/// completes, possibly none.
pub fn parse_demo(bytes: &[u8]) -> Result<Match, ParseError> {
    match bytes.get(..8) {
        Some(b"PBDEMS2\0") => {}
        Some(b"HL2DEMO\0") => {
            return Err(ParseError(
                "this is a CS:GO (Source 1) demo; only CS2 demos are supported".into(),
            ))
        }
        _ => return Err(ParseError("this file is not a CS2 demo".into())),
    }
    if bytes.len() < parser::parse_demo::HEADER_ENDS_AT_BYTE {
        return Err(ParseError("demo is truncated inside its header".into()));
    }
    panic::catch_unwind(AssertUnwindSafe(|| build(bytes))).unwrap_or_else(|p| {
        Err(ParseError(format!(
            "demo parser crashed: {}",
            panic_message(&*p)
        )))
    })
}

fn panic_message(p: &(dyn Any + Send)) -> &str {
    p.downcast_ref::<&str>()
        .copied()
        .or_else(|| p.downcast_ref::<String>().map(String::as_str))
        .unwrap_or("unknown panic")
}

/// Track samples per round, `(end - start) / tick_step + 1`, for rounds given as
/// `(start_tick, end_tick)` with `end_tick > start_tick`. Refuses a round longer than
/// [`MAX_ROUND_TICKS`], and a match whose tracks for `players` players would hold more than
/// [`MAX_TRACK_SAMPLES`] samples.
pub fn round_samples(
    rounds: impl IntoIterator<Item = (i32, i32)>,
    tick_step: u32,
    players: usize,
) -> Result<Vec<u32>, ParseError> {
    let mut out = Vec::new();
    let mut total: u64 = 0;
    for (i, (start, end)) in rounds.into_iter().enumerate() {
        let span = i64::from(end) - i64::from(start);
        if !(0..=MAX_ROUND_TICKS).contains(&span) {
            return Err(ParseError(format!(
                "round {} runs from tick {start} to tick {end}, longer than the {}-minute limit; \
                 the demo is corrupt or its ticks were edited",
                i + 1,
                MAX_ROUND_TICKS / (60 * i64::from(TICK_RATE)),
            )));
        }
        // At most MAX_ROUND_TICKS + 1 (a u32 holds it).
        let n = (span / i64::from(tick_step.max(1)) + 1) as u32;
        total = total.saturating_add(u64::from(n).saturating_mul(players as u64));
        if total > MAX_TRACK_SAMPLES {
            return Err(ParseError(format!(
                "the match is too long to replay: its tracks would hold more than {MAX_TRACK_SAMPLES} samples"
            )));
        }
        out.push(n);
    }
    Ok(out)
}

fn build(bytes: &[u8]) -> Result<Match, ParseError> {
    let out = props::run_passes(bytes)?;
    let game_events = events::sorted(out.events.game_events);
    let spans = rounds::find_rounds(&game_events);
    let tick_step = (TICK_RATE as f64 / SAMPLE_HZ as f64).round() as u32;
    let table = props::TickTable::from_output(&out.ticks);

    // Players: the end-of-match scoreboard plus the live roster (which still lists players who
    // left early), without bots or anyone who never played a round on a side.
    let mut names = BTreeMap::new();
    for p in out.ticks.player_md.iter().chain(&out.ticks.roster) {
        if let Some(steamid) = p.steamid.filter(|&s| s != 0) {
            names
                .entry(steamid)
                .or_insert_with(|| p.name.clone().unwrap_or_default());
        }
    }
    let players: Vec<PlayerInfo> = names
        .into_iter()
        .map(|(steamid, name)| PlayerInfo {
            steamid,
            crosshair: table.crosshair(steamid).map(str::to_string),
            rank: table.rank(steamid),
            name,
            team_by_round: spans
                .iter()
                .map(|s| {
                    table
                        .state_at(steamid, s.start_tick, s.freeze_end_tick, MAX_ROW_AGE)
                        .map_or(0, |st| st.team)
                })
                .collect(),
        })
        .filter(|p| spans.is_empty() || p.team_by_round.iter().any(|&t| t != 0))
        .collect();
    let index: AHashMap<u64, usize> = players
        .iter()
        .enumerate()
        .map(|(i, p)| (p.steamid, i))
        .collect();

    // Each round's play runs past its round_end into the restart delay: to just before the
    // next round starts, at most POST_END_TICKS (so a half-time break is not swallowed), and
    // for the last round to the end of the demo's data.
    let demo_end = table.last_tick().unwrap_or(i32::MAX);
    let post_end: Vec<i32> = spans
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let next = spans
                .get(i + 1)
                .map_or(demo_end, |n| n.start_tick - tick_step as i32);
            next.min(s.end_tick.saturating_add(POST_END_TICKS))
                .max(s.end_tick)
        })
        .collect();
    // Checked before any track is allocated.
    let samples = round_samples(
        spans.iter().zip(&post_end).map(|(s, &p)| (s.start_tick, p)),
        tick_step,
        players.len(),
    )?;
    let teams: Vec<Vec<u8>> = players.iter().map(|p| p.team_by_round.clone()).collect();
    let rounds: Vec<RoundInfo> = spans
        .iter()
        .zip(rounds::scores(&spans, &teams))
        .zip(samples)
        .zip(&post_end)
        .enumerate()
        .map(
            |(i, (((s, (score_t, score_ct)), samples), &post))| RoundInfo {
                number: (i + 1) as u16,
                start_tick: s.start_tick,
                freeze_end_tick: s.freeze_end_tick,
                end_tick: s.end_tick,
                winner: s.winner,
                reason: s.reason.clone(),
                score_t,
                score_ct,
                samples,
                post_end_tick: Some(post),
            },
        )
        .collect();

    let demo_header = out.ticks.header.as_ref();
    let header_field = |k: &str| {
        demo_header
            .and_then(|h| h.get(k))
            .cloned()
            .unwrap_or_default()
    };
    let mut header = MatchHeader {
        version: PACK_VERSION,
        map: header_field("map_name"),
        server_name: header_field("server_name"),
        game_build: header_field("patch_version"),
        tick_rate: TICK_RATE,
        sample_hz: SAMPLE_HZ,
        tick_step,
        players,
        rounds,
        weapons: Vec::new(),
    };

    let steamids: Vec<u64> = header.players.iter().map(|p| p.steamid).collect();
    let round_end_ticks: Vec<i32> = game_events
        .iter()
        .filter(|e| e.name == "round_end")
        .map(|e| e.tick)
        .collect();
    let blind = events::blind_ranges(&game_events, TICK_RATE, &index);
    let mut weapons = tracks::Weapons::new();
    let mut inventory = Vec::new();
    let mut round_tracks = Vec::with_capacity(header.rounds.len());
    for (r, round) in header.rounds.iter().enumerate() {
        // The bomb is handed out at the start of each round: follow it from the previous
        // round_end, starting from nobody.
        let ended = round_end_ticks.partition_point(|&t| t < round.start_tick);
        let since = ended
            .checked_sub(1)
            .map_or(i32::MIN, |i| round_end_ticks[i]);
        let until = round.post_end_tick.unwrap_or(round.end_tick);
        let carrier = events::bomb_carrier(&game_events, since, until, &index);
        round_tracks.push(tracks::round_tracks(
            &table,
            &steamids,
            &header,
            r,
            MAX_ROW_AGE,
            &tracks::EventState {
                carrier: &carrier,
                blind: &blind,
            },
            &mut weapons,
            &mut inventory,
        ));
    }
    // Doors, breakables and items on the ground. A defuse kit on the ground is told apart
    // from other physics props by where and when a CT who carried one died.
    let kit_drops: Vec<(i32, [f32; 3])> = game_events
        .iter()
        .filter(|e| e.name == "player_death")
        .filter_map(|e| {
            let steamid = events::steamid_field(e, "user_steamid")?;
            let st = table.state_at(steamid, i32::MIN, e.tick - 1, MAX_ROW_AGE)?;
            st.kit.then_some((e.tick, [st.x, st.y, st.z]))
        })
        .collect();
    let world = world::build(
        &out.projectiles.world_entities,
        &header.rounds,
        &kit_drops,
        &mut weapons,
    );
    header.weapons = weapons.into_names();

    // Events and grenades run from the first round's start to the end of the match (the
    // `cs_win_panel_match` after the last round), or to the end of the demo without one.
    let first_tick = header.rounds.first().map_or(i32::MIN, |r| r.start_tick);
    let last_tick = header
        .rounds
        .last()
        .and_then(|last| {
            game_events
                .iter()
                .find(|e| e.name == "cs_win_panel_match" && e.tick >= last.end_tick)
        })
        .map_or(i32::MAX, |e| e.tick);
    let events = events::convert(&game_events, first_tick, last_tick, &index);
    let grenades = grenades::build(
        &out.projectiles,
        &game_events,
        first_tick,
        last_tick,
        tick_step,
        &index,
        |steamid, tick| {
            table
                .state_at(steamid, i32::MIN, tick, MAX_ROW_AGE)
                .map_or(0, |s| s.team)
        },
    );

    Ok(Match {
        header,
        rounds: round_tracks,
        events,
        grenades,
        inventory,
        map_entities: world.entities,
        map_changes: world.changes,
        ground: world.ground,
    })
}
