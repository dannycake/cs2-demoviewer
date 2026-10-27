//! Match summaries: what a match page and its preview need to know about a match without
//! opening its pack. Each pack has one, `matches/<sha256>.json`, written when the demo is
//! parsed and kept forever (spec §8.2), even after a cache limit (`DEMOVIEWER_CACHE_BYTES`)
//! evicts the pack. [`MatchIndex`] holds them all in memory.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::Path;
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use demoviewer_pack::{Event, Match, MatchHeader};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::Store;

/// The most characters of a player's or the server's name a summary keeps: far more than a
/// real name has (Steam's are at most 32). A longer one comes from a crafted demo, and would
/// make the parse child's report, the summary file and every page that shows it as long.
pub const MAX_NAME_CHARS: usize = 128;

/// What [`summarize`] knows, counted up whenever it learns more: a stored summary of an older
/// version is summarized again from its pack at startup ([`upgrade_summaries`]).
pub const SUMMARY_VERSION: u8 = 1;

/// The most rounds whose winners and halves a summary keeps: a real match has a few dozen, and a
/// crafted demo's thousands would only make its summary, and every card drawn from it, larger.
pub const MAX_SUMMARY_ROUNDS: usize = 300;

/// One match. JSON field names are camelCase, like the API's; steamids and match ids are
/// decimal strings (they exceed JavaScript's safe-integer range).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchSummary {
    pub sha256: String,
    pub map: String,
    pub rounds: u16,
    /// The score after the last round, by the side each team ended on.
    pub score_t: u8,
    pub score_ct: u8,
    /// From the first round's start to the last round's end.
    pub duration_s: u32,
    /// At most [`MAX_NAME_CHARS`] characters, like `map` and `game_build`: all three come from
    /// the demo's header as it is.
    pub server_name: String,
    pub game_build: String,
    /// In the pack's player order.
    pub players: Vec<SummaryPlayer>,
    /// When the demo was first stored: the creation of the demo id whose parse wrote this.
    pub created_unix: u64,
    /// When the match was played, if known (a share code's match info).
    pub played_unix: Option<u64>,
    /// Valve's match id, if known (a share code's).
    pub match_id: Option<String>,
    /// Who won each round, as the side the winning team ended the match on (2 = T, 3 = CT,
    /// 0 = unknown), so a team keeps one colour across the halves.
    #[serde(default)]
    pub round_winners: Vec<u8>,
    /// The rounds (0-based) before which the sides swapped: each starts a half.
    #[serde(default)]
    pub swaps: Vec<u16>,
    /// The [`SUMMARY_VERSION`] that wrote it; 0 before versions.
    #[serde(default)]
    pub version: u8,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SummaryPlayer {
    pub steamid: String,
    /// At most [`MAX_NAME_CHARS`] characters.
    pub name: String,
    /// The side the player's team finished on: 2 = T, 3 = CT, 0 = unknown. One who left
    /// before the end gets the side they were last on, swapped for each half after that.
    pub team: u8,
    /// Players of the other side killed; team kills and suicides do not count.
    pub kills: u16,
    pub deaths: u16,
    /// Assists, health damage and headshot kills against enemies, by the web scoreboard's rules
    /// ([`scoreboard`]); ADR is `damage` over the match's rounds.
    #[serde(default)]
    pub assists: u16,
    #[serde(default)]
    pub damage: u32,
    #[serde(default)]
    pub headshots: u16,
}

/// The summary of a parsed match. What the parse cannot know is left empty for the job runner
/// to fill: `sha256`, `created_unix`, `played_unix` and `match_id`.
pub fn summarize(m: &Match) -> MatchSummary {
    let h = &m.header;
    let (score_t, score_ct) = h.rounds.last().map_or((0, 0), |r| (r.score_t, r.score_ct));
    let duration_s = match (h.rounds.first(), h.rounds.last()) {
        (Some(first), Some(last)) if h.tick_rate > 0 => {
            u32::try_from(last.end_tick.saturating_sub(first.start_tick)).unwrap_or(0) / h.tick_rate
        }
        _ => 0,
    };

    let n = h.players.len();
    let (mut kills, mut deaths) = (vec![0u16; n], vec![0u16; n]);
    for e in m.events.iter().filter(|e| e.kind == "player_death") {
        // `*_idx` is the player's index, or null for the world and anyone not in the match.
        let player = |key: &str| {
            e.data
                .get(key)
                .and_then(serde_json::Value::as_u64)
                .and_then(|i| usize::try_from(i).ok())
                .filter(|&i| i < n)
        };
        let victim = player("user_idx");
        if let Some(v) = victim {
            deaths[v] = deaths[v].saturating_add(1);
        }
        let Some(attacker) = player("attacker_idx") else {
            continue;
        };
        let round = round_at(h, e.tick);
        let side = |p: usize| h.players[p].team_by_round.get(round).copied().unwrap_or(0);
        let own_side =
            victim.is_some_and(|v| v == attacker || (side(v) != 0 && side(v) == side(attacker)));
        if !own_side {
            kills[attacker] = kills[attacker].saturating_add(1);
        }
    }

    let board = scoreboard(m);
    let swaps = swaps(h);
    MatchSummary {
        sha256: String::new(),
        map: capped(&h.map),
        rounds: u16::try_from(h.rounds.len()).unwrap_or(u16::MAX),
        score_t,
        score_ct,
        duration_s,
        server_name: capped(&h.server_name),
        game_build: capped(&h.game_build),
        players: h
            .players
            .iter()
            .enumerate()
            .map(|(i, p)| SummaryPlayer {
                steamid: p.steamid.to_string(),
                name: capped(&p.name),
                team: final_side(&p.team_by_round, &swaps),
                kills: kills[i],
                deaths: deaths[i],
                assists: board[i].assists,
                damage: board[i].damage,
                headshots: board[i].headshots,
            })
            .collect(),
        created_unix: 0,
        played_unix: None,
        match_id: None,
        round_winners: round_winners(h),
        swaps,
        version: SUMMARY_VERSION,
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Board {
    assists: u16,
    damage: u32,
    headshots: u16,
}

/// Assists, damage and headshot kills per player (header order) by the web scoreboard's rules
/// (`web/src/sim/stats.ts`, over the whole match), so a preview and the scoreboard agree: each
/// counts only against an enemy (both sides known and different in that round); damage is each
/// hit's `dmg_health` capped at the health the victim had left, followed through the round
/// from each `player_hurt`'s `health` (players spawn at 100); events count from a round's
/// start to its post-end tick.
fn scoreboard(m: &Match) -> Vec<Board> {
    const SPAWN_HEALTH: i64 = 100;
    let h = &m.header;
    let n = h.players.len();
    let mut out = vec![Board::default(); n];
    let player = |e: &Event, key: &str| {
        e.data
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())
            .filter(|&i| i < n)
    };
    // A number as the web reads one: anything else is 0 (`num` in stats.ts).
    let number = |e: &Event, key: &str| e.data.get(key).and_then(Value::as_f64);
    // Sorted once (stable: events of a tick keep their order), so the rounds cost a search each
    // rather than a pass over every event.
    let mut by_tick: Vec<&Event> = m.events.iter().collect();
    by_tick.sort_by_key(|e| e.tick);
    for (r, info) in h.rounds.iter().enumerate() {
        let up_to = info.post_end_tick.unwrap_or(info.end_tick);
        let side = |p: usize| h.players[p].team_by_round.get(r).copied().unwrap_or(0);
        let enemies = |a: usize, b: usize| {
            let (x, y) = (side(a), side(b));
            matches!(x, 2 | 3) && matches!(y, 2 | 3) && x != y
        };
        let mut hp = vec![SPAWN_HEALTH; n];
        // The round's events, found by binary search in the one sorted copy.
        let from = by_tick.partition_point(|e| e.tick < info.start_tick);
        let in_round = by_tick[from..].iter().take_while(|e| e.tick <= up_to);
        for e in in_round {
            match e.kind.as_str() {
                "player_hurt" => {
                    let Some(victim) = player(e, "user_idx") else {
                        continue;
                    };
                    let dealt = (number(e, "dmg_health").unwrap_or(0.0) as i64).min(hp[victim]);
                    if let Some(a) = player(e, "attacker_idx").filter(|&a| a != victim) {
                        if enemies(a, victim) {
                            let add = u32::try_from(dealt.max(0)).unwrap_or(0);
                            out[a].damage = out[a].damage.saturating_add(add);
                        }
                    }
                    hp[victim] = match number(e, "health") {
                        Some(left) => (left as i64).max(0),
                        None => (hp[victim] - dealt).max(0),
                    };
                }
                "player_death" => {
                    let Some(victim) = player(e, "user_idx") else {
                        continue;
                    };
                    let attacker = player(e, "attacker_idx");
                    if let Some(a) = attacker.filter(|&a| a != victim && enemies(a, victim)) {
                        if e.data.get("headshot") == Some(&Value::Bool(true)) {
                            out[a].headshots = out[a].headshots.saturating_add(1);
                        }
                    }
                    let assister = player(e, "assister_idx")
                        .filter(|&s| s != victim && Some(s) != attacker && enemies(s, victim));
                    if let Some(s) = assister {
                        out[s].assists = out[s].assists.saturating_add(1);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// Each round's winner as the final side of the team that won it: the side most of the
/// winning side's players ended the match on (0 for no winner, or no such player).
fn round_winners(h: &MatchHeader) -> Vec<u8> {
    h.rounds
        .iter()
        .take(MAX_SUMMARY_ROUNDS)
        .enumerate()
        .map(|(r, info)| {
            if !matches!(info.winner, 2 | 3) {
                return 0;
            }
            let (mut t, mut ct) = (0u32, 0u32);
            for p in &h.players {
                if p.team_by_round.get(r) != Some(&info.winner) {
                    continue;
                }
                match p.team_by_round.last() {
                    Some(2) => t += 1,
                    Some(3) => ct += 1,
                    _ => {}
                }
            }
            match (t, ct) {
                (0, 0) => 0,
                (t, ct) if ct > t => 3,
                _ => 2,
            }
        })
        .collect()
}

/// The side a player's team finished on, from the player's side each round: the side of the
/// last round they were on one, swapped once for each half that started after it.
fn final_side(team_by_round: &[u8], swaps: &[u16]) -> u8 {
    let Some((last, &side)) = team_by_round
        .iter()
        .enumerate()
        .rev()
        .find(|(_, s)| matches!(s, 2 | 3))
    else {
        return 0;
    };
    let later = swaps.iter().filter(|&&s| usize::from(s) > last).count();
    if later % 2 == 1 {
        5 - side
    } else {
        side
    }
}

/// The rounds before which the sides swapped, in order: most players on a side in both rounds changed
/// it (one player switching teams is not a half).
fn swaps(h: &MatchHeader) -> Vec<u16> {
    (1..h.rounds.len().min(MAX_SUMMARY_ROUNDS))
        .filter(|&r| {
            let (mut kept, mut swapped) = (0u32, 0u32);
            for p in &h.players {
                if let (Some(&a), Some(&b)) = (p.team_by_round.get(r - 1), p.team_by_round.get(r)) {
                    if matches!(a, 2 | 3) && matches!(b, 2 | 3) {
                        if a == b {
                            kept += 1;
                        } else {
                            swapped += 1;
                        }
                    }
                }
            }
            swapped > kept
        })
        .filter_map(|r| u16::try_from(r).ok())
        .collect()
}

/// Every match summary, in memory, by sha (a demo's page). Nothing is listed (the site is link
/// only), and a share code finds its demo through the store by the whole code
/// ([`crate::store::Store::find_match`]), so this is the only lookup. Rebuilt from `matches/`
/// at startup ([`MatchIndex::load`]); the job runner adds each summary it writes or completes.
/// The demo ids of a sha are the store's ([`crate::store::Store::find_by_sha`]).
#[derive(Default)]
pub struct MatchIndex {
    by_sha: RwLock<HashMap<String, Arc<MatchSummary>>>,
}

impl MatchIndex {
    /// Reads every `<sha256>.json` in `dir`. A file that cannot be read, is not a summary, or
    /// is the summary of another sha is skipped with a warning: that match loses its page, the
    /// server still starts.
    pub fn load(dir: &Path) -> io::Result<MatchIndex> {
        let index = MatchIndex::default();
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let Some(sha) = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_suffix(".json"))
            else {
                continue;
            };
            let read = fs::read(&path).map_err(|e| e.to_string()).and_then(|json| {
                serde_json::from_slice::<MatchSummary>(&json).map_err(|e| e.to_string())
            });
            match read {
                Ok(s) if s.sha256 == sha => index.insert(s),
                Ok(s) => {
                    tracing::warn!(path = %path.display(), sha = %s.sha256, "match summary of another pack; skipped")
                }
                Err(e) => {
                    tracing::warn!(path = %path.display(), error = %e, "unreadable match summary; skipped")
                }
            }
        }
        Ok(index)
    }

    /// Adds `summary`, or replaces the one of its sha (an alias completing it).
    pub fn insert(&self, summary: MatchSummary) {
        let sha = summary.sha256.clone();
        self.write().insert(sha, Arc::new(summary));
    }

    /// The summary of the pack with this sha.
    pub fn get(&self, sha: &str) -> Option<Arc<MatchSummary>> {
        self.read().get(sha).cloned()
    }

    /// The summaries an older [`summarize`] wrote ([`SUMMARY_VERSION`]).
    pub fn outdated(&self) -> Vec<Arc<MatchSummary>> {
        self.read()
            .values()
            .filter(|s| s.version < SUMMARY_VERSION)
            .cloned()
            .collect()
    }

    /// How many matches are indexed.
    pub fn len(&self) -> usize {
        self.read().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn read(&self) -> RwLockReadGuard<'_, HashMap<String, Arc<MatchSummary>>> {
        self.by_sha.read().unwrap_or_else(PoisonError::into_inner)
    }

    fn write(&self) -> RwLockWriteGuard<'_, HashMap<String, Arc<MatchSummary>>> {
        self.by_sha.write().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Summarizes again, from its pack, every indexed summary an older [`summarize`] wrote,
/// keeping what only the runner knows (the sha, both dates and Valve's match id). Each is
/// rewritten in place (a temporary file renamed over it) and replaces the indexed one, so its
/// preview, older than the summary now, is drawn again. A match whose pack is gone (evicted)
/// or unreadable keeps its old summary. Blocking; returns how many were rewritten.
pub fn upgrade_summaries(store: &Store) -> usize {
    let mut rewritten = 0;
    for old in store.matches().outdated() {
        let sha = old.sha256.as_str();
        let read = fs::File::open(store.pack_path(sha))
            .and_then(|f| demoviewer_pack::read(&mut io::BufReader::new(f)));
        let m = match read {
            Ok(m) => m,
            Err(e) => {
                if e.kind() != io::ErrorKind::NotFound {
                    tracing::warn!(sha, error = %e, "cannot read a pack to upgrade its summary");
                }
                continue;
            }
        };
        let new = MatchSummary {
            sha256: old.sha256.clone(),
            created_unix: old.created_unix,
            played_unix: old.played_unix,
            match_id: old.match_id.clone(),
            ..summarize(&m)
        };
        let tmp = store.tmp_dir().join(format!("summary-{sha}.json"));
        let written = serde_json::to_vec(&new)
            .map_err(io::Error::other)
            .and_then(|json| crate::store::write_file(&tmp, &store.summary_path(sha), &json));
        match written {
            Ok(()) => {
                store.matches().insert(new);
                rewritten += 1;
            }
            Err(e) => tracing::warn!(sha, error = %e, "cannot rewrite a match summary"),
        }
    }
    rewritten
}

/// `name` cut to [`MAX_NAME_CHARS`] characters.
fn capped(name: &str) -> String {
    name.chars().take(MAX_NAME_CHARS).collect()
}

/// The index of the round `tick` falls in: the last one started by then (the first before any).
fn round_at(h: &MatchHeader, tick: i32) -> usize {
    h.rounds
        .iter()
        .rposition(|r| r.start_tick <= tick)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use demoviewer_pack::{
        Event, MatchHeader, PlayerInfo, PlayerTrack, RoundInfo, RoundTracks, PACK_VERSION,
    };
    use serde_json::{json, Map, Value};

    fn round(number: u16, start_tick: i32, end_tick: i32, score: (u8, u8)) -> RoundInfo {
        RoundInfo {
            number,
            start_tick,
            freeze_end_tick: start_tick + 100,
            end_tick,
            winner: 2,
            reason: "t_win".into(),
            score_t: score.0,
            score_ct: score.1,
            samples: 1,
            post_end_tick: Some(end_tick + 320),
        }
    }

    fn player(steamid: u64, name: &str, team_by_round: [u8; 2]) -> PlayerInfo {
        PlayerInfo {
            steamid,
            name: name.into(),
            team_by_round: team_by_round.to_vec(),
            crosshair: None,
        }
    }

    /// A `player_death` at `tick`; `None` is a null index (the world, or no one known).
    fn death(tick: i32, victim: Option<u64>, attacker: Option<u64>) -> Event {
        let idx = |i: Option<u64>| i.map_or(Value::Null, |i| json!(i));
        let mut data = Map::new();
        data.insert("user_idx".into(), idx(victim));
        data.insert("attacker_idx".into(), idx(attacker));
        data.insert("assister_idx".into(), Value::Null);
        Event {
            tick,
            kind: "player_death".into(),
            data,
        }
    }

    /// Two rounds at 64 ticks a second, the sides swapped between them. Alpha and Charlie play
    /// together, Bravo against them; Delta joins in round 2 on Alpha's side.
    fn two_rounds() -> Match {
        const A: Option<u64> = Some(0);
        const B: Option<u64> = Some(1);
        const C: Option<u64> = Some(2);
        const D: Option<u64> = Some(3);
        Match {
            header: MatchHeader {
                version: PACK_VERSION,
                map: "de_inferno".into(),
                server_name: "Valve CS2 EU West".into(),
                game_build: "14185".into(),
                tick_rate: 64,
                sample_hz: 32,
                tick_step: 2,
                players: vec![
                    player(76561198000000001, "Alpha", [2, 3]),
                    player(76561198000000002, "Bravo", [3, 2]),
                    player(76561198000000003, "Charlie", [2, 3]),
                    player(76561198000000004, "Delta", [0, 3]),
                ],
                rounds: vec![
                    round(1, 1000, 1000 + 64 * 100, (1, 0)),
                    round(2, 9000, 9000 + 64 * 90, (1, 1)),
                ],
                weapons: vec!["none".into()],
            },
            rounds: vec![RoundTracks::default(), RoundTracks::default()],
            events: vec![
                death(2000, B, A),        // a kill
                death(3000, A, C),        // a team kill: no kill, Alpha's death
                death(4000, B, B),        // a suicide: Bravo's death only
                death(5000, C, None),     // the world: Charlie's death only
                death(6000, None, A),     // someone not in the match: still Alpha's kill
                death(9500, B, D),        // round 2: Delta's kill
                death(10000, A, D),       // round 2: Delta's team kill
                death(10500, B, C),       // round 2: a kill across the swapped sides
                death(11000, Some(9), A), // an index past the players: Alpha's kill, nobody's death
            ],
            grenades: vec![],
            inventory: vec![],
            map_entities: vec![],
            map_changes: vec![],
            ground: vec![],
        }
    }

    #[test]
    fn a_summary_counts_kills_of_the_other_side_and_every_death() {
        let s = summarize(&two_rounds());
        assert_eq!(s.map, "de_inferno");
        assert_eq!((s.rounds, s.score_t, s.score_ct), (2, 1, 1));
        assert_eq!(s.duration_s, (9000 + 64 * 90 - 1000) / 64);
        assert_eq!(
            (s.server_name.as_str(), s.game_build.as_str()),
            ("Valve CS2 EU West", "14185")
        );
        let rows: Vec<(&str, &str, u8, u16, u16)> = s
            .players
            .iter()
            .map(|p| {
                (
                    p.steamid.as_str(),
                    p.name.as_str(),
                    p.team,
                    p.kills,
                    p.deaths,
                )
            })
            .collect();
        assert_eq!(
            rows,
            [
                ("76561198000000001", "Alpha", 3, 3, 2),
                ("76561198000000002", "Bravo", 2, 0, 4),
                ("76561198000000003", "Charlie", 3, 1, 1),
                ("76561198000000004", "Delta", 3, 1, 0),
            ]
        );
        // What only the runner knows is left empty.
        assert_eq!(s.sha256, "");
        assert_eq!((s.created_unix, s.played_unix, s.match_id), (0, None, None));
    }

    #[test]
    fn a_summary_is_camel_case_json_with_decimal_steamids() {
        let mut s = summarize(&two_rounds());
        s.match_id = Some("3712345678901234567".into());
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["scoreT"], 1);
        assert_eq!(v["durationS"], s.duration_s);
        assert_eq!(v["players"][0]["steamid"], "76561198000000001");
        assert_eq!(v["matchId"], "3712345678901234567");
        assert_eq!(v["playedUnix"], Value::Null);
        let back: MatchSummary = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    /// Names, the map and the build come from the demo as they are; a crafted one can make them
    /// any length.
    #[test]
    fn a_summary_cuts_long_names() {
        let mut m = two_rounds();
        m.header.server_name = "s".repeat(1000);
        m.header.map = "m".repeat(1000);
        m.header.game_build = "b".repeat(1000);
        m.header.players[0].name = "\u{1F600}".repeat(1000);
        let s = summarize(&m);
        assert_eq!(s.server_name, "s".repeat(MAX_NAME_CHARS));
        assert_eq!(s.map, "m".repeat(MAX_NAME_CHARS));
        assert_eq!(s.game_build, "b".repeat(MAX_NAME_CHARS));
        assert_eq!(s.players[0].name, "\u{1F600}".repeat(MAX_NAME_CHARS));
        assert_eq!(s.players[1].name, "Bravo");
    }

    /// The summary of [`two_rounds`] as the runner would store it.
    fn stored(sha: &str, match_id: Option<&str>, created_unix: u64) -> MatchSummary {
        MatchSummary {
            sha256: sha.into(),
            match_id: match_id.map(Into::into),
            created_unix,
            ..summarize(&two_rounds())
        }
    }

    #[test]
    fn the_index_finds_a_summary_by_sha() {
        let index = MatchIndex::default();
        let a = "aa".repeat(32);
        index.insert(stored(&a, None, 10));
        assert_eq!(index.get(&a).unwrap().map, "de_inferno");
        assert!(index.get(&"bb".repeat(32)).is_none());
        // An alias completes the summary later: the same sha again, now with a match id.
        index.insert(stored(&a, Some("3712345678901234567"), 10));
        assert_eq!(
            index.get(&a).unwrap().match_id.as_deref(),
            Some("3712345678901234567")
        );
        assert_eq!(index.len(), 1);
    }

    #[test]
    fn the_index_is_read_back_from_the_summary_files() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = ("aa".repeat(32), "bb".repeat(32));
        let write = |name: String, bytes: Vec<u8>| std::fs::write(dir.path().join(name), bytes);
        let json = |s: &MatchSummary| serde_json::to_vec(s).unwrap();
        write(format!("{a}.json"), json(&stored(&a, Some("42"), 1))).unwrap();
        // A summary under another pack's name (copied by hand), one that is not JSON, and a
        // file that is no summary at all are skipped.
        write(format!("{b}.json"), json(&stored(&a, None, 1))).unwrap();
        write(format!("{}.json", "cc".repeat(32)), b"{not json".to_vec()).unwrap();
        write("notes.txt".into(), b"hello".to_vec()).unwrap();

        let index = MatchIndex::load(dir.path()).unwrap();
        assert_eq!(index.len(), 1);
        assert_eq!(*index.get(&a).unwrap(), stored(&a, Some("42"), 1));
        assert!(index.get(&b).is_none());
    }

    /// A `player_hurt` of `victim` by `attacker` for `dmg`, leaving `health`.
    fn hurt(tick: i32, victim: Option<u64>, attacker: Option<u64>, dmg: u64, health: u64) -> Event {
        let idx = |i: Option<u64>| i.map_or(Value::Null, |i| json!(i));
        let mut data = Map::new();
        data.insert("user_idx".into(), idx(victim));
        data.insert("attacker_idx".into(), idx(attacker));
        data.insert("dmg_health".into(), json!(dmg));
        data.insert("health".into(), json!(health));
        Event {
            tick,
            kind: "player_hurt".into(),
            data,
        }
    }

    /// The scoreboard of `web/src/sim/stats.ts`: only enemies count, damage is capped at the
    /// health left, an assist is not the killer's.
    #[test]
    fn assists_damage_and_headshots_follow_the_web_scoreboard() {
        let (a, b, c) = (Some(0), Some(1), Some(2));
        let mut m = two_rounds();
        // Round 1: Alpha and Charlie are T, Bravo CT.
        m.events.extend([
            hurt(1500, b, a, 30, 70),
            hurt(1600, b, a, 100, 0), // only the 70 left count
            hurt(1700, a, c, 20, 80), // a teammate: nothing
            hurt(1800, a, b, 50, 30),
            hurt(1900, a, None, 10, 20), // the world: nothing
        ]);
        let set = |m: &mut Match, tick: i32, key: &str, v: Value| {
            let e = m.events.iter_mut().find(|e| e.tick == tick).unwrap();
            e.data.insert(key.into(), v);
        };
        // Alpha's headshot of Bravo, Charlie assisting.
        set(&mut m, 2000, "headshot", json!(true));
        set(&mut m, 2000, "assister_idx", json!(2));
        // Round 2, sides swapped: Alpha (CT) assists Delta's kill of Bravo (T)...
        set(&mut m, 9500, "assister_idx", json!(0));
        // ...and Charlie's assist of Delta's team kill of Alpha does not count.
        set(&mut m, 10000, "assister_idx", json!(2));
        m.events.sort_by_key(|e| e.tick);
        let s = summarize(&m);
        let board: Vec<(u16, u32, u16)> = s
            .players
            .iter()
            .map(|p| (p.assists, p.damage, p.headshots))
            .collect();
        assert_eq!(board, [(1, 100, 1), (0, 50, 0), (1, 0, 0), (0, 0, 0)]);
    }

    #[test]
    fn rounds_are_won_by_teams_coloured_by_the_side_they_finished_on() {
        let mut m = two_rounds();
        let s = summarize(&m);
        // Both rounds went to the Ts: Alpha and Charlie's team in round 1 (they finished CT),
        // Bravo's in round 2.
        assert_eq!(s.round_winners, [3, 2]);
        assert_eq!(s.swaps, [1]);
        assert_eq!(s.version, SUMMARY_VERSION);
        m.header.rounds[0].winner = 0;
        assert_eq!(summarize(&m).round_winners, [0, 2]);
    }

    /// A crafted demo's thousands of rounds keep only the first [`MAX_SUMMARY_ROUNDS`].
    #[test]
    fn a_summary_keeps_at_most_so_many_rounds_of_winners_and_halves() {
        let mut m = two_rounds();
        let round = m.header.rounds[0].clone();
        m.header.rounds = (0..5000).map(|_| round.clone()).collect();
        for p in &mut m.header.players {
            p.team_by_round = (0..5000).map(|r| if r % 2 == 0 { 2 } else { 3 }).collect();
        }
        let s = summarize(&m);
        assert_eq!(s.round_winners.len(), MAX_SUMMARY_ROUNDS);
        assert_eq!(s.swaps.len(), MAX_SUMMARY_ROUNDS - 1);
        assert!(s.swaps.windows(2).all(|w| w[0] < w[1]));
        assert_eq!(s.rounds, 5000);
    }

    /// A player who left still belongs to their team's side at the end.
    #[test]
    fn a_player_who_left_has_the_side_their_team_finished_on() {
        assert_eq!(final_side(&[2, 2, 0, 0], &[2]), 3);
        assert_eq!(final_side(&[2, 2, 0, 0, 0], &[2, 4]), 2);
        assert_eq!(final_side(&[3, 3, 3], &[]), 3);
        assert_eq!(final_side(&[2, 3], &[1]), 3);
        assert_eq!(final_side(&[0, 0], &[1]), 0);
        assert_eq!(final_side(&[], &[]), 0);
        // One player changing teams is not a half.
        let mut m = two_rounds();
        m.header.players[1].team_by_round = vec![3, 3];
        m.header.players[0].team_by_round = vec![2, 2];
        m.header.players[2].team_by_round = vec![2, 3];
        assert!(summarize(&m).swaps.is_empty());
    }

    /// A summary from before the scoreboard is summarized again from its pack, keeping what
    /// only the runner knew; one whose pack is gone is left as it is.
    #[test]
    fn old_summaries_are_upgraded_from_their_packs() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let (a, b) = ("aa".repeat(32), "bb".repeat(32));
        let old = |sha: &str| MatchSummary {
            version: 0,
            round_winners: vec![],
            swaps: vec![],
            played_unix: Some(1_761_163_200),
            ..stored(sha, Some("42"), 7)
        };
        // A pack needs every player's track in every round: one still sample each.
        let mut m = two_rounds();
        let still = PlayerTrack {
            x: vec![0],
            y: vec![0],
            z: vec![0],
            yaw: vec![0],
            pitch: vec![0],
            health: vec![100],
            armor: vec![0],
            flags: vec![0],
            duck: vec![0],
            weapon: vec![0],
            ..PlayerTrack::default()
        };
        for round in &mut m.rounds {
            round.players = vec![still.clone(); m.header.players.len()];
        }
        let mut pack = Vec::new();
        demoviewer_pack::write(&m, &mut pack).unwrap();
        fs::write(store.pack_path(&a), pack).unwrap();
        for sha in [&a, &b] {
            fs::write(
                store.summary_path(sha),
                serde_json::to_vec(&old(sha)).unwrap(),
            )
            .unwrap();
            store.matches().insert(old(sha));
        }

        assert_eq!(upgrade_summaries(&store), 1);
        let new = store.matches().get(&a).unwrap();
        assert_eq!(new.version, SUMMARY_VERSION);
        assert_eq!(new.round_winners, [3, 2]);
        assert_eq!(
            (
                new.sha256.as_str(),
                new.created_unix,
                new.played_unix,
                new.match_id.as_deref()
            ),
            (a.as_str(), 7, Some(1_761_163_200), Some("42"))
        );
        let on_disk: MatchSummary =
            serde_json::from_slice(&fs::read(store.summary_path(&a)).unwrap()).unwrap();
        assert_eq!(on_disk, *new);
        assert_eq!(*store.matches().get(&b).unwrap(), old(&b));
        // Nothing is left to upgrade but the one without a pack.
        assert_eq!(upgrade_summaries(&store), 0);
    }

    #[test]
    fn a_match_with_no_rounds_or_tick_rate_has_no_duration() {
        let mut m = two_rounds();
        m.header.tick_rate = 0;
        assert_eq!(summarize(&m).duration_s, 0);
        m.header.rounds.clear();
        let s = summarize(&m);
        assert_eq!(
            (s.rounds, s.score_t, s.score_ct, s.duration_s),
            (0, 0, 0, 0)
        );
    }
}
