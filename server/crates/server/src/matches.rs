//! Match summaries: what a match page and its preview need to know about a match without
//! opening its pack. Each pack has one, `matches/<sha256>.json`, written when the demo is
//! parsed and kept forever (spec §8.2), even after a cache limit (`DEMOVIEWER_CACHE_BYTES`)
//! evicts the pack. [`MatchIndex`] holds them all in memory.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, PoisonError, RwLock, RwLockReadGuard, RwLockWriteGuard};

use demoviewer_pack::{Event, Match, MatchHeader, PlayerInfo, PlayerRank};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::event_dates;
use crate::players::PlayerIndex;
use crate::store::{DemoRecord, Source, Store};

/// The most characters of a player's or the server's name a summary keeps: far more than a
/// real name has (Steam's are at most 32). A longer one comes from a crafted demo, and would
/// make the parse child's report, the summary file and every page that shows it as long.
pub const MAX_NAME_CHARS: usize = 128;

/// What [`summarize`] knows, counted up whenever it learns more: a stored summary of an older
/// version is summarized again from its pack at startup ([`upgrade_summaries`]).
pub const SUMMARY_VERSION: u8 = 4;

/// The most rounds whose winners and halves a summary keeps: a real match has a few dozen, and a
/// crafted demo's thousands would only make its summary, and every card drawn from it, larger.
pub const MAX_SUMMARY_ROUNDS: usize = 300;

/// The most weapons a player's kills are counted by in one match ([`ReplayStats::weapons`]): a
/// real player kills with a handful, a crafted demo's every kill could name another.
pub const MAX_WEAPONS: usize = 16;
/// The longest weapon name counted: the game's are at most a couple of dozen characters.
pub const MAX_WEAPON_CHARS: usize = 32;
/// The longest one blinding counts for: a full flash in the face is about five seconds.
pub const MAX_BLIND_MS: u32 = 10_000;

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
    /// The matchmaking mode, from the players' rank types ([`game_mode`]); `None` for a pack
    /// from before ranks.
    #[serde(default)]
    pub mode: Option<GameMode>,
    /// The tournament a match came from (a pro demo's), if known.
    #[serde(default)]
    pub event: Option<String>,
    /// The two teams of a pro match, if the corpus names them. Left out of the JSON when
    /// unknown, so every other summary, on disk and in the API, stays as it was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub teams: Option<[String; 2]>,
    /// The game coordinator's game type, if the match came through it.
    #[serde(default)]
    pub gc_game_type: Option<u32>,
    /// FACEIT's id of the match, if the demo came from a FACEIT match
    /// ([`DemoRecord::faceit_match_id`]). Left out of the JSON when there is none, so the
    /// summaries of every other match, on disk and in the API, stay as they were.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub faceit_match_id: Option<String>,
    /// Whether the demo came from the corpus ([`Source::Import`]): `created_unix` then says when
    /// the site got it, and nothing of when it was played ([`MatchSummary::played`]). Left out of
    /// the JSON when not.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub imported: bool,
}

impl MatchSummary {
    /// Takes what `rec` knows of its match and a parse cannot, where this summary has none:
    /// Valve's match id, when the match was played, the event, the teams, the game coordinator's game
    /// type and FACEIT's match id. What the summary has is kept, so an alias's record fills in
    /// what the pack's summary lacks and changes nothing it has. The one place a record's facts
    /// reach its summary: a parse's, a re-parse's and an alias's.
    /// [`MatchSummary::keep_known`] is its twin for an older summary, and a fact added here goes
    /// there too.
    pub fn take_known(&mut self, rec: &DemoRecord) {
        fill(&mut self.match_id, &rec.match_id);
        fill(&mut self.played_unix, &rec.played_unix);
        fill(&mut self.event, &rec.event);
        fill(&mut self.teams, &rec.teams);
        fill(&mut self.gc_game_type, &rec.gc_game_type);
        fill(&mut self.faceit_match_id, &rec.faceit_match_id);
        self.imported |= rec.source == Source::Import;
    }

    /// [`MatchSummary::take_known`] from `old`, an older summary of the match (one summarized
    /// again, from its pack or its original): the same facts, where this summary has none.
    pub fn keep_known(&mut self, old: &MatchSummary) {
        fill(&mut self.match_id, &old.match_id);
        fill(&mut self.played_unix, &old.played_unix);
        fill(&mut self.event, &old.event);
        fill(&mut self.teams, &old.teams);
        fill(&mut self.gc_game_type, &old.gc_game_type);
        fill(&mut self.faceit_match_id, &old.faceit_match_id);
        self.imported |= old.imported;
    }

    /// When the match was played, as far as the site can say: the time its source gave, else the
    /// day it was stored, which is the nearest thing known of an upload. A demo from the corpus
    /// has neither: the day it was stored is only the day it was imported.
    pub fn played(&self) -> Option<u64> {
        self.played_unix
            .or((!self.imported && self.created_unix > 0).then_some(self.created_unix))
    }

    /// Where the match stands in a list by date: when it was played, else the last day of its
    /// tournament, else the day it was stored.
    pub fn sort_unix(&self) -> u64 {
        self.played()
            .or_else(|| {
                let (_, last) = event_dates::of(self.event.as_deref()?)?;
                Some(last)
            })
            .unwrap_or(self.created_unix)
    }

    /// Whether this summary's match is known to be a FACEIT match beyond what its demo says, as
    /// a new summary of it must keep: it has a FACEIT match id, or its mode is FACEIT already (a
    /// FACEIT match whose server's name does not say so must not lose its mode when summarized
    /// again).
    pub fn known_faceit(&self) -> bool {
        self.faceit_match_id.is_some() || self.mode == Some(GameMode::Faceit)
    }
}

/// Sets `field` to `known` where it has no value.
fn fill<T: Clone>(field: &mut Option<T>, known: &Option<T>) {
    if field.is_none() {
        field.clone_from(known);
    }
}

/// What kind of match: the mode the players were ranked in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GameMode {
    Premier,
    Competitive,
    Wingman,
    /// Played on FACEIT: its server's name says so, or the demo came from a FACEIT match.
    Faceit,
    /// Ranked in nothing: a tournament or community server's demo.
    Other,
}

/// A player's result: their team's against the final score.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MatchResult {
    #[serde(rename = "w")]
    Win,
    #[serde(rename = "l")]
    Loss,
    #[serde(rename = "t")]
    Tie,
}

/// The mode most players' rank type says (11 Premier, 12 Competitive, 7 Wingman, anything else
/// Other); `None` when no player has a rank (a pack from before ranks).
pub fn game_mode(players: &[PlayerInfo]) -> Option<GameMode> {
    let mut counts: HashMap<GameMode, usize> = HashMap::new();
    for rank in players.iter().filter_map(|p| p.rank) {
        let mode = match rank.kind {
            11 => GameMode::Premier,
            12 => GameMode::Competitive,
            7 => GameMode::Wingman,
            _ => GameMode::Other,
        };
        *counts.entry(mode).or_default() += 1;
    }
    // Ties go to the order above, so the answer does not depend on the map's order.
    [
        GameMode::Premier,
        GameMode::Competitive,
        GameMode::Wingman,
        GameMode::Other,
    ]
    .into_iter()
    .filter_map(|m| counts.get(&m).map(|&n| (m, n)))
    .fold(None, |best: Option<(GameMode, usize)>, (m, n)| match best {
        Some((_, b)) if b >= n => best,
        _ => Some((m, n)),
    })
    .map(|(m, _)| m)
}

/// Whether `server_name` is a FACEIT server's: FACEIT names its servers after itself, in
/// whatever case.
pub fn is_faceit_server(server_name: &str) -> bool {
    server_name.to_ascii_lowercase().contains("faceit")
}

/// The mode of a match: FACEIT when `faceit_match` (the demo is known to be a FACEIT match's) or
/// the server is FACEIT's, whatever the players' ranks say; else the one their rank types say,
/// Other when none has a rank.
pub fn mode_of(server_name: &str, faceit_match: bool, players: &[PlayerInfo]) -> GameMode {
    if faceit_match || is_faceit_server(server_name) {
        GameMode::Faceit
    } else {
        game_mode(players).unwrap_or(GameMode::Other)
    }
}

/// `p`'s result: the side their team finished on against the final score; `None` for a player
/// with no known side.
pub fn result_of(m: &MatchSummary, p: &SummaryPlayer) -> Option<MatchResult> {
    let (own, other) = match p.team {
        2 => (m.score_t, m.score_ct),
        3 => (m.score_ct, m.score_t),
        _ => return None,
    };
    Some(match own.cmp(&other) {
        std::cmp::Ordering::Greater => MatchResult::Win,
        std::cmp::Ordering::Less => MatchResult::Loss,
        std::cmp::Ordering::Equal => MatchResult::Tie,
    })
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// The rounds the player was on a side for, which KAST and the rating are over.
    #[serde(default)]
    pub rounds: u16,
    /// Of those, the rounds with a kill, an assist, survival or a traded death (`stats.ts`).
    #[serde(default)]
    pub kast_rounds: u16,
    /// Opening duels: the first enemy kill of a round, won (the killer) or lost (the victim).
    #[serde(default)]
    pub opening_wins: u16,
    #[serde(default)]
    pub opening_losses: u16,
    /// Rounds with 2, 3, 4 and 5 or more enemy kills.
    #[serde(default)]
    pub multi_kills: [u16; 4],
    /// The player's rank as the match started ([`PlayerInfo::rank`]).
    #[serde(default)]
    pub rank: Option<PlayerRank>,
    /// What the replay's events tell beyond the scoreboard; `None` in a summary from before
    /// version 3.
    #[serde(default)]
    pub replay: Option<ReplayStats>,
}

/// What a player did that only the replay's events tell, by [`scoreboard`]'s rules: kills and
/// damage count against enemies only, from a round's start to its post-end tick.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayStats {
    /// Enemy kills by weapon, named as the kill names it (`ak47`, `m4a1_silencer`, `inferno`),
    /// every knife as `knife`. At most [`MAX_WEAPONS`] names, each of lower-case letters, digits
    /// and underscores and at most [`MAX_WEAPON_CHARS`] long; a kill by any other is left out.
    pub weapons: BTreeMap<String, u16>,
    /// Clutches, 1v1 to 1v5: the rounds the player was the last of their side alive, against so
    /// many enemies, and of those the rounds their side won.
    pub clutches: [u16; 5],
    pub clutches_won: [u16; 5],
    /// Kills of an enemy who had killed a teammate within [`TRADE_S`], and the player's deaths a
    /// teammate so avenged.
    pub trade_kills: u16,
    pub traded_deaths: u16,
    /// Enemy kills the player assisted with a flash.
    pub flash_assists: u16,
    /// Living enemies the player's flashes blinded, and how long they were blind in all, in
    /// milliseconds (each blinding at most [`MAX_BLIND_MS`]).
    pub enemies_flashed: u16,
    pub blind_ms: u32,
    /// Health damage to enemies by HE grenades and fire, capped as `damage` is.
    pub utility_damage: u32,
    pub plants: u16,
    pub defuses: u16,
    /// The player's line on each side: T, then CT.
    pub sides: [SideLine; 2],
    /// Enemy kills through a wall, through smoke, without a scope and while blind; `None` when
    /// none of the match's kills says.
    pub wallbangs: Option<u16>,
    pub through_smoke: Option<u16>,
    pub no_scopes: Option<u16>,
    pub blind_kills: Option<u16>,
}

/// A player's rounds on one side, and their enemy kills, deaths and damage in them.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SideLine {
    pub rounds: u16,
    pub kills: u16,
    pub deaths: u16,
    pub damage: u32,
}

/// The summary of a parsed match. What the parse cannot know is left empty for the job runner
/// to fill: `sha256`, `created_unix`, and the facts [`MatchSummary::take_known`] takes from the
/// record. `faceit_match` says the demo is known to be a FACEIT match's, which makes its mode
/// FACEIT even off a FACEIT server.
pub fn summarize(m: &Match, faceit_match: bool) -> MatchSummary {
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
                rounds: board[i].rounds,
                kast_rounds: board[i].kast_rounds,
                opening_wins: board[i].opening_wins,
                opening_losses: board[i].opening_losses,
                multi_kills: board[i].multi_kills,
                rank: p.rank,
                replay: Some(board[i].replay.clone()),
            })
            .collect(),
        created_unix: 0,
        played_unix: None,
        match_id: None,
        round_winners: round_winners(h),
        swaps,
        version: SUMMARY_VERSION,
        mode: Some(mode_of(&h.server_name, faceit_match, &h.players)),
        event: None,
        teams: None,
        imported: false,
        gc_game_type: None,
        faceit_match_id: None,
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Board {
    assists: u16,
    damage: u32,
    headshots: u16,
    rounds: u16,
    kast_rounds: u16,
    opening_wins: u16,
    opening_losses: u16,
    multi_kills: [u16; 4],
    replay: ReplayStats,
}

/// The weapons whose damage is utility damage, as `player_hurt` names them.
const UTILITY: [&str; 4] = ["hegrenade", "inferno", "molotov", "incgrenade"];

/// The kinds of kill a `player_death` may say it was, by its fields: through a wall (`penetrated`
/// above 0), through smoke, without a scope, while blind.
const KILL_KINDS: [&str; 4] = ["penetrated", "thrusmoke", "noscope", "attackerblind"];

/// The name a kill's weapon is counted under ([`ReplayStats::weapons`]): as the event names it,
/// without a `weapon_` before it, every knife `knife`; `None` for a name no weapon has.
fn weapon_key(name: &str) -> Option<String> {
    let name = name.strip_prefix("weapon_").unwrap_or(name);
    let plain = name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if name.is_empty() || name.len() > MAX_WEAPON_CHARS || !plain {
        return None;
    }
    if name.contains("knife") || name.contains("bayonet") {
        return Some("knife".to_owned());
    }
    Some(name.to_owned())
}

/// `count` plus one, if it is counted at all.
fn bump(count: &mut Option<u16>) {
    if let Some(c) = count {
        *c = c.saturating_add(1);
    }
}

/// Index of a side in [`ReplayStats::sides`]: T, then CT.
fn side_index(side: u8) -> Option<usize> {
    match side {
        2 => Some(0),
        3 => Some(1),
        _ => None,
    }
}

/// Assists, damage and headshot kills per player (header order) by the web scoreboard's rules
/// (`web/src/sim/stats.ts`, over the whole match), so a preview and the scoreboard agree: each
/// counts only against an enemy (both sides known and different in that round); damage is each
/// hit's `dmg_health` capped at the health the victim had left, followed through the round
/// from each `player_hurt`'s `health` (players spawn at 100); events count from a round's
/// start to its post-end tick. Per round, also by stats.ts's rules: the rounds a player was on
/// a side for, KAST (a kill, an assist, survival — no death through `end_tick` — or a death an
/// enemy's teammate avenged within [`TRADE_S`]), the opening duel (the round's first kill of an
/// enemy) and the round's enemy kills for multi-kills. Every round of a stored match is decided.
/// By the same rules, what only the events tell ([`ReplayStats`]): a clutch starts when a death
/// through `end_tick` leaves one player of a side alive with enemies alive, and a blinding
/// counts while its victim is alive.
fn scoreboard(m: &Match) -> Vec<Board> {
    const SPAWN_HEALTH: i64 = 100;
    let h = &m.header;
    let n = h.players.len();
    let player = |e: &Event, key: &str| {
        e.data
            .get(key)
            .and_then(Value::as_u64)
            .and_then(|i| usize::try_from(i).ok())
            .filter(|&i| i < n)
    };
    // A number as the web reads one: anything else is 0 (`num` in stats.ts).
    let number = |e: &Event, key: &str| e.data.get(key).and_then(Value::as_f64);
    // A flag is `true`, or a count above 0 (`penetrated` is the walls a bullet went through).
    let flag = |e: &Event, key: &str| match e.data.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(v) => v.as_f64().is_some_and(|x| x > 0.0),
        None => false,
    };
    fn weapon(e: &Event) -> &str {
        e.data.get("weapon").and_then(Value::as_str).unwrap_or("")
    }
    // The kinds of kill some kill of the match says it was or was not; the others are unknown.
    let said = KILL_KINDS.map(|key| {
        m.events
            .iter()
            .any(|e| e.kind == "player_death" && e.data.get(key).is_some_and(|v| !v.is_null()))
    });
    let known = |i: usize| said[i].then_some(0);
    let blank = Board {
        replay: ReplayStats {
            wallbangs: known(0),
            through_smoke: known(1),
            no_scopes: known(2),
            blind_kills: known(3),
            ..ReplayStats::default()
        },
        ..Board::default()
    };
    let mut out = vec![blank; n];
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
        let on_side = |p: usize| matches!(side(p), 2 | 3);
        let (mut kills, mut assists) = (vec![0u16; n], vec![0u16; n]);
        // `died`: through `end_tick`, for KAST and clutches; `dead`: at all, for blindings.
        let (mut died, mut traded) = (vec![false; n], vec![false; n]);
        let mut dead = vec![false; n];
        let mut opened = false;
        // Each side's players alive through `end_tick` (T, then CT), and the enemies each
        // player was left alone against.
        let mut alive = [0usize; 2];
        for p in 0..n {
            if let Some(i) = side_index(side(p)) {
                alive[i] += 1;
            }
        }
        let mut clutch: Vec<Option<usize>> = vec![None; n];
        // The enemy kills so far, by killer, open to a trade for TRADE_S after: (victim, tick).
        // A kill of the killer reads and drops their list, so each kill is looked at once and a
        // crafted round of many kills costs time in proportion to them.
        let mut pending: HashMap<usize, Vec<(usize, i32)>> = HashMap::new();
        let trade_ticks = i32::try_from(TRADE_S * u64::from(h.tick_rate)).unwrap_or(i32::MAX);
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
                            let x = &mut out[a].replay;
                            if let Some(i) = side_index(side(a)) {
                                x.sides[i].damage = x.sides[i].damage.saturating_add(add);
                            }
                            let w = weapon(e);
                            if UTILITY.contains(&w.strip_prefix("weapon_").unwrap_or(w)) {
                                x.utility_damage = x.utility_damage.saturating_add(add);
                            }
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
                    dead[victim] = true;
                    if let Some(i) = side_index(side(victim)) {
                        let line = &mut out[victim].replay.sides[i];
                        line.deaths = line.deaths.saturating_add(1);
                    }
                    if e.tick <= info.end_tick && !died[victim] {
                        died[victim] = true;
                        // The death may leave one of the victim's side alone against enemies.
                        if let Some(i) = side_index(side(victim)) {
                            alive[i] = alive[i].saturating_sub(1);
                            let against = alive[1 - i];
                            let last = (alive[i] == 1)
                                .then(|| (0..n).find(|&p| side(p) == side(victim) && !died[p]))
                                .flatten();
                            if let Some(p) = last.filter(|&p| clutch[p].is_none()) {
                                clutch[p] = (against > 0).then_some(against.min(5));
                            }
                        }
                    }
                    let attacker = player(e, "attacker_idx");
                    if let Some(a) = attacker.filter(|&a| a != victim && enemies(a, victim)) {
                        if e.data.get("headshot") == Some(&Value::Bool(true)) {
                            out[a].headshots = out[a].headshots.saturating_add(1);
                        }
                        kills[a] = kills[a].saturating_add(1);
                        if !opened {
                            opened = true;
                            out[a].opening_wins = out[a].opening_wins.saturating_add(1);
                            out[victim].opening_losses =
                                out[victim].opening_losses.saturating_add(1);
                        }
                        // The victim had killed a teammate of `a` within TRADE_S: that teammate's
                        // death is traded.
                        let mut avenged = false;
                        for (dead, tick) in pending.remove(&victim).unwrap_or_default() {
                            if e.tick.saturating_sub(tick) <= trade_ticks
                                && dead != a
                                && side(dead) == side(a)
                            {
                                traded[dead] = true;
                                avenged = true;
                            }
                        }
                        pending.entry(a).or_default().push((victim, e.tick));
                        let x = &mut out[a].replay;
                        if avenged {
                            x.trade_kills = x.trade_kills.saturating_add(1);
                        }
                        if let Some(i) = side_index(side(a)) {
                            x.sides[i].kills = x.sides[i].kills.saturating_add(1);
                        }
                        if let Some(w) = weapon_key(weapon(e)) {
                            if x.weapons.len() < MAX_WEAPONS || x.weapons.contains_key(&w) {
                                let k = x.weapons.entry(w).or_default();
                                *k = k.saturating_add(1);
                            }
                        }
                        let kinds = [
                            &mut x.wallbangs,
                            &mut x.through_smoke,
                            &mut x.no_scopes,
                            &mut x.blind_kills,
                        ];
                        for (count, key) in kinds.into_iter().zip(KILL_KINDS) {
                            if flag(e, key) {
                                bump(count);
                            }
                        }
                    }
                    let assister = player(e, "assister_idx")
                        .filter(|&s| s != victim && Some(s) != attacker && enemies(s, victim));
                    if let Some(s) = assister {
                        out[s].assists = out[s].assists.saturating_add(1);
                        assists[s] = assists[s].saturating_add(1);
                        if flag(e, "assistedflash") {
                            let x = &mut out[s].replay;
                            x.flash_assists = x.flash_assists.saturating_add(1);
                        }
                    }
                }
                "player_blind" => {
                    let Some(victim) = player(e, "user_idx").filter(|&v| !dead[v]) else {
                        continue;
                    };
                    let Some(a) = player(e, "attacker_idx").filter(|&a| enemies(a, victim)) else {
                        continue;
                    };
                    let secs = number(e, "blind_duration").unwrap_or(0.0);
                    if secs > 0.0 {
                        // `as` saturates: a crafted duration cannot overflow.
                        let ms = ((secs * 1000.0).round() as u32).min(MAX_BLIND_MS);
                        let x = &mut out[a].replay;
                        x.enemies_flashed = x.enemies_flashed.saturating_add(1);
                        x.blind_ms = x.blind_ms.saturating_add(ms);
                    }
                }
                "bomb_planted" | "bomb_defused" => {
                    let Some(p) = player(e, "user_idx") else {
                        continue;
                    };
                    let x = &mut out[p].replay;
                    let count = if e.kind == "bomb_planted" {
                        &mut x.plants
                    } else {
                        &mut x.defuses
                    };
                    *count = count.saturating_add(1);
                }
                _ => {}
            }
        }
        for p in (0..n).filter(|&p| on_side(p)) {
            let b = &mut out[p];
            b.rounds = b.rounds.saturating_add(1);
            if kills[p] > 0 || assists[p] > 0 || !died[p] || traded[p] {
                b.kast_rounds = b.kast_rounds.saturating_add(1);
            }
            if kills[p] >= 2 {
                let slot = usize::from(kills[p].min(5) - 2);
                b.multi_kills[slot] = b.multi_kills[slot].saturating_add(1);
            }
            let x = &mut b.replay;
            if traded[p] {
                x.traded_deaths = x.traded_deaths.saturating_add(1);
            }
            if let Some(i) = side_index(side(p)) {
                x.sides[i].rounds = x.sides[i].rounds.saturating_add(1);
            }
            if let Some(against) = clutch[p] {
                let slot = against - 1;
                x.clutches[slot] = x.clutches[slot].saturating_add(1);
                if info.winner == side(p) {
                    x.clutches_won[slot] = x.clutches_won[slot].saturating_add(1);
                }
            }
        }
    }
    out
}

/// A death is traded when a teammate kills the killer within this many seconds after
/// (`STATS.tradeS` in `web/src/sim/stats.ts`).
const TRADE_S: u64 = 5;

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

/// Every match summary, in memory, by sha (a demo's page), and its players by steamid and by
/// name ([`MatchIndex::players`]): the matches on a player's profile are the only list. A share
/// code finds its demo through the store by the whole code
/// ([`crate::store::Store::find_match`]). Rebuilt from `matches/` at startup
/// ([`MatchIndex::load`]); the job runner adds each summary it writes or completes. The demo
/// ids of a sha are the store's ([`crate::store::Store::find_by_sha`]).
#[derive(Default)]
pub struct MatchIndex {
    by_sha: RwLock<HashMap<String, Arc<MatchSummary>>>,
    players: PlayerIndex,
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
        self.players.insert(&summary);
        self.write().insert(sha, Arc::new(summary));
    }

    /// The players of the indexed matches.
    pub fn players(&self) -> &PlayerIndex {
        &self.players
    }

    /// The summary of the pack with this sha.
    pub fn get(&self, sha: &str) -> Option<Arc<MatchSummary>> {
        self.read().get(sha).cloned()
    }

    /// Every indexed summary.
    pub fn all(&self) -> Vec<Arc<MatchSummary>> {
        self.read().values().cloned().collect()
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

/// The packs [`upgrade_summaries`] reads at once: each is a few dozen megabytes once read, and
/// the server answers nothing until they are all done.
const UPGRADE_THREADS: usize = 4;

/// Summarizes again, from its pack, every indexed summary an older [`summarize`] wrote,
/// keeping what only the runner knows (the sha, the store date and the record's facts,
/// [`MatchSummary::keep_known`]) and a FACEIT match's mode ([`MatchSummary::known_faceit`]).
/// Each is rewritten in place (a temporary file renamed over it) and replaces the indexed one,
/// so its preview, older than the summary now, is drawn again. A match whose pack is gone
/// (evicted) or unreadable keeps its old summary. Up to [`UPGRADE_THREADS`] packs at once
/// (reading one takes about 30 ms a megabyte). Blocking; returns how many were rewritten.
pub fn upgrade_summaries(store: &Store) -> usize {
    let outdated = store.matches().outdated();
    if outdated.is_empty() {
        return 0;
    }
    tracing::info!(
        summaries = outdated.len(),
        "upgrading match summaries from their packs"
    );
    let threads = std::thread::available_parallelism()
        .map_or(1, |n| n.get())
        .min(UPGRADE_THREADS)
        .min(outdated.len());
    let (next, rewritten) = (AtomicUsize::new(0), AtomicUsize::new(0));
    std::thread::scope(|scope| {
        for _ in 0..threads {
            scope.spawn(|| {
                while let Some(old) = outdated.get(next.fetch_add(1, Ordering::Relaxed)) {
                    if upgrade_summary(store, old) {
                        rewritten.fetch_add(1, Ordering::Relaxed);
                    }
                }
            });
        }
    });
    rewritten.into_inner()
}

/// [`upgrade_summaries`] for one summary: whether it was rewritten.
fn upgrade_summary(store: &Store, old: &MatchSummary) -> bool {
    let sha = old.sha256.as_str();
    let read = fs::File::open(store.pack_path(sha))
        .and_then(|f| demoviewer_pack::read(&mut io::BufReader::new(f)));
    let m = match read {
        Ok(m) => m,
        Err(e) => {
            if e.kind() != io::ErrorKind::NotFound {
                tracing::warn!(sha, error = %e, "cannot read a pack to upgrade its summary");
            }
            return false;
        }
    };
    let mut new = MatchSummary {
        sha256: old.sha256.clone(),
        created_unix: old.created_unix,
        ..summarize(&m, old.known_faceit())
    };
    new.keep_known(old);
    let tmp = store.tmp_dir().join(format!("summary-{sha}.json"));
    let written = serde_json::to_vec(&new)
        .map_err(io::Error::other)
        .and_then(|json| crate::store::write_file(&tmp, &store.summary_path(sha), &json));
    match written {
        Ok(()) => {
            store.matches().insert(new);
            true
        }
        Err(e) => {
            tracing::warn!(sha, error = %e, "cannot rewrite a match summary");
            false
        }
    }
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
    #[test]
    fn a_match_says_when_it_was_played_only_as_far_as_that_is_known() {
        let played = MatchSummary {
            played_unix: Some(100),
            created_unix: 900,
            imported: true,
            ..MatchSummary::default()
        };
        assert_eq!(played.played(), Some(100));
        let upload = MatchSummary {
            created_unix: 900,
            ..MatchSummary::default()
        };
        assert_eq!(upload.played(), Some(900));
        assert_eq!(MatchSummary::default().played(), None);
        let corpus = MatchSummary {
            created_unix: 900,
            imported: true,
            ..MatchSummary::default()
        };
        assert_eq!(corpus.played(), None);
        assert_eq!(corpus.sort_unix(), 900);
        let (_, last) = event_dates::of("iem_cologne_major_2026").unwrap();
        let tournament = MatchSummary {
            event: Some("iem_cologne_major_2026".into()),
            ..corpus
        };
        assert_eq!(tournament.played(), None);
        assert_eq!(tournament.sort_unix(), last);
    }

    #[test]
    fn take_known_and_keep_known_carry_the_corpus_mark() {
        let mut s = MatchSummary::default();
        s.take_known(&crate::store::new_record("a", Source::Import));
        assert!(s.imported);
        let mut again = MatchSummary::default();
        again.keep_known(&s);
        assert!(again.imported);
        let mut other = MatchSummary::default();
        other.take_known(&crate::store::new_record("b", Source::Upload));
        assert!(!other.imported);
    }

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
            rank: None,
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
        let s = summarize(&two_rounds(), false);
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
        let mut s = summarize(&two_rounds(), false);
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
        let s = summarize(&m, false);
        assert_eq!(s.server_name, "s".repeat(MAX_NAME_CHARS));
        assert_eq!(s.map, "m".repeat(MAX_NAME_CHARS));
        assert_eq!(s.game_build, "b".repeat(MAX_NAME_CHARS));
        assert_eq!(s.players[0].name, "\u{1F600}".repeat(MAX_NAME_CHARS));
        assert_eq!(s.players[1].name, "Bravo");
    }

    /// `m` with a still sample for every player in every round: a pack needs every player's
    /// track in every round.
    fn with_still_tracks(mut m: Match) -> Match {
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
        m
    }

    /// The summary of [`two_rounds`] as the runner would store it.
    fn stored(sha: &str, match_id: Option<&str>, created_unix: u64) -> MatchSummary {
        MatchSummary {
            sha256: sha.into(),
            match_id: match_id.map(Into::into),
            created_unix,
            ..summarize(&two_rounds(), false)
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
        let s = summarize(&m, false);
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
        let s = summarize(&m, false);
        // Both rounds went to the Ts: Alpha and Charlie's team in round 1 (they finished CT),
        // Bravo's in round 2.
        assert_eq!(s.round_winners, [3, 2]);
        assert_eq!(s.swaps, [1]);
        assert_eq!(s.version, SUMMARY_VERSION);
        m.header.rounds[0].winner = 0;
        assert_eq!(summarize(&m, false).round_winners, [0, 2]);
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
        let s = summarize(&m, false);
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
        assert!(summarize(&m, false).swaps.is_empty());
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
        let m = with_still_tracks(two_rounds());
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

    /// A match of `teams.len()` players over `rounds` rounds of 64 ticks a second, round `r`
    /// from `r * 10000` to `r * 10000 + 5000`, with `events`; the Ts win every round.
    fn rounds_with(teams: &[&[u8]], rounds: usize, events: Vec<Event>) -> Match {
        let mut m = two_rounds();
        m.header.players = teams
            .iter()
            .enumerate()
            .map(|(i, t)| PlayerInfo {
                steamid: 76561198000000001 + i as u64,
                name: format!("P{i}"),
                team_by_round: t.to_vec(),
                crosshair: None,
                rank: None,
            })
            .collect();
        m.header.rounds = (0..rounds)
            .map(|r| {
                let start = r as i32 * 10000;
                round(r as u16 + 1, start, start + 5000, (r as u8 + 1, 0))
            })
            .collect();
        m.rounds = vec![RoundTracks::default(); rounds];
        m.events = events;
        m
    }

    fn of(s: &MatchSummary, i: usize) -> &SummaryPlayer {
        &s.players[i]
    }

    #[test]
    fn kast_counts_a_kill_an_assist_survival_or_a_trade_within_five_seconds() {
        const A: Option<u64> = Some(0);
        const B: Option<u64> = Some(1);
        const X: Option<u64> = Some(2);
        let m = rounds_with(
            &[&[2, 2], &[2, 2], &[3, 3]],
            2,
            vec![
                // Round 1: X kills A; B kills X exactly 5 s later: A is traded.
                death(1000, A, X),
                death(1000 + 5 * 64, X, B),
                // Round 2: the same, one tick too late: A is not.
                death(11000, A, X),
                death(11000 + 5 * 64 + 1, X, B),
            ],
        );
        let s = summarize(&m, false);
        assert_eq!(of(&s, 0).kast_rounds, 1);
        assert_eq!(of(&s, 0).rounds, 2);
    }

    #[test]
    fn the_first_enemy_kill_of_a_round_is_its_opening_duel() {
        const A: Option<u64> = Some(0);
        const B: Option<u64> = Some(1);
        const X: Option<u64> = Some(2);
        const L: Option<u64> = Some(3);
        let m = rounds_with(
            &[&[2], &[2], &[3], &[2]],
            1,
            vec![
                death(900, L, B), // a team kill first: no duel
                death(1000, A, X),
            ],
        );
        let s = summarize(&m, false);
        assert_eq!((of(&s, 2).opening_wins, of(&s, 2).opening_losses), (1, 0));
        assert_eq!((of(&s, 0).opening_wins, of(&s, 0).opening_losses), (0, 1));
        assert_eq!((of(&s, 1).opening_wins, of(&s, 1).opening_losses), (0, 0));
    }

    #[test]
    fn multi_kills_count_rounds_by_enemy_kills() {
        const B: Option<u64> = Some(0);
        let (x, y, z) = (Some(1), Some(2), Some(3));
        let m = rounds_with(
            &[&[2, 2], &[3, 3], &[3, 3], &[3, 3]],
            2,
            vec![
                death(1000, x, B),
                death(1100, y, B),
                death(1200, z, B),
                death(11000, x, B),
                death(11100, y, B),
            ],
        );
        assert_eq!(of(&summarize(&m, false), 0).multi_kills, [1, 1, 0, 0]);
    }

    /// A crafted round of sixty thousand kills between two players: the trade check looks
    /// only at the victim's own kills, once, so the round costs time in proportion to its kills
    /// (it was quadratic, every kill scanning every earlier one).
    #[test]
    fn a_round_of_crafted_kills_is_summarized_in_linear_time() {
        const A: Option<u64> = Some(0);
        const X: Option<u64> = Some(1);
        let events = (0..60_000)
            .map(|i| {
                if i % 2 == 0 {
                    death(1000, A, X)
                } else {
                    death(1000, X, A)
                }
            })
            .collect();
        let m = rounds_with(&[&[2], &[3]], 1, events);
        let t = std::time::Instant::now();
        let s = summarize(&m, false);
        assert_eq!(
            u32::from(of(&s, 0).kills) + u32::from(of(&s, 1).kills),
            60_000
        );
        assert!(
            t.elapsed() < std::time::Duration::from_secs(5),
            "{:?}",
            t.elapsed()
        );
    }

    /// Review Focus 4: one who left is rated over the rounds they played.
    #[test]
    fn a_leaver_is_rated_over_the_rounds_they_played() {
        let m = rounds_with(&[&[2, 0, 0], &[3, 3, 3]], 3, vec![]);
        let s = summarize(&m, false);
        assert_eq!(of(&s, 0).rounds, 1);
        assert_eq!(of(&s, 1).rounds, 3);
    }

    fn ranked(kinds: &[u8]) -> Vec<PlayerInfo> {
        kinds
            .iter()
            .map(|&kind| PlayerInfo {
                rank: Some(demoviewer_pack::PlayerRank {
                    kind,
                    value: 0,
                    wins: 0,
                    if_win: 0,
                    if_loss: 0,
                    if_tie: 0,
                }),
                ..player(76561198000000001, "p", [2, 2])
            })
            .collect()
    }

    /// A demo from a FACEIT server is a FACEIT match, whatever its players' ranks say.
    #[test]
    fn a_faceit_servers_demo_is_a_faceit_match() {
        let premier = ranked(&[11; 10]);
        assert_eq!(
            mode_of("FACEIT.com register to play here", false, &[]),
            GameMode::Faceit
        );
        assert_eq!(
            mode_of("FACEIT.com register to play here", false, &premier),
            GameMode::Faceit
        );
        assert_eq!(
            mode_of("Valve CS2 Server", false, &premier),
            GameMode::Premier
        );
        assert_eq!(mode_of("x", true, &[]), GameMode::Faceit);
        assert_eq!(mode_of("x", false, &[]), GameMode::Other);
    }

    /// What a record knows of its match and a parse cannot goes into its summary in one place,
    /// where the summary has none: what it has is kept. An older summary of the match carries
    /// the same facts, and nothing else, into a newer one.
    #[test]
    fn a_summary_takes_what_its_record_knows() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        })
        .unwrap();
        let (mut rec, _) =
            store.claim_faceit("1-aaaa", "aaaaaaaaaaaaaaaaaaaaaa", Some(1_761_000_000));
        rec.match_id = Some("42".into());
        rec.event = Some("Major".into());
        rec.gc_game_type = Some(8);

        let mut fresh = MatchSummary::default();
        fresh.take_known(&rec);
        assert_eq!(
            (
                fresh.match_id.as_deref(),
                fresh.played_unix,
                fresh.event.as_deref(),
                fresh.gc_game_type,
                fresh.faceit_match_id.as_deref()
            ),
            (
                Some("42"),
                Some(1_761_000_000),
                Some("Major"),
                Some(8),
                Some("1-aaaa")
            )
        );
        let mut newer = MatchSummary::default();
        newer.keep_known(&fresh);
        assert_eq!(newer, fresh);

        let mut known = MatchSummary {
            match_id: Some("7".into()),
            faceit_match_id: Some("1-bbbb".into()),
            ..MatchSummary::default()
        };
        known.take_known(&rec);
        assert_eq!(
            (known.match_id.as_deref(), known.faceit_match_id.as_deref()),
            (Some("7"), Some("1-bbbb"))
        );
        assert_eq!(known.event.as_deref(), Some("Major"));
        let json = serde_json::to_value(&fresh).unwrap();
        assert_eq!(json["faceitMatchId"], "1-aaaa");
        let json = serde_json::to_value(MatchSummary::default()).unwrap();
        assert!(json.get("faceitMatchId").is_none(), "{json}");
        let older: MatchSummary = serde_json::from_value(json!({
            "sha256": "", "map": "", "rounds": 0, "scoreT": 0, "scoreCt": 0, "durationS": 0,
            "serverName": "", "gameBuild": "", "players": [], "createdUnix": 0,
            "playedUnix": null, "matchId": null
        }))
        .unwrap();
        assert_eq!(
            older.faceit_match_id, None,
            "a summary from before the field"
        );
    }

    #[test]
    fn take_known_and_keep_known_fill_teams() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        })
        .unwrap();
        let rec = DemoRecord {
            teams: Some(["Spirit".into(), "Falcons".into()]),
            ..store.create("a")
        };
        let mut s = MatchSummary::default();
        s.take_known(&rec);
        assert_eq!(s.teams, Some(["Spirit".into(), "Falcons".into()]));
        let mut other = MatchSummary {
            teams: Some(["A".into(), "B".into()]),
            ..MatchSummary::default()
        };
        other.take_known(&rec);
        assert_eq!(other.teams, Some(["A".into(), "B".into()]), "kept");
        let mut newer = MatchSummary::default();
        newer.keep_known(&s);
        assert_eq!(newer.teams, s.teams);
        let json = serde_json::to_value(&s).unwrap();
        assert_eq!(json["teams"], json!(["Spirit", "Falcons"]));
        let json = serde_json::to_value(MatchSummary::default()).unwrap();
        assert!(json.get("teams").is_none(), "{json}");
    }

    /// A FACEIT match summarized again from its pack stays FACEIT's though its server's name
    /// does not say so: by its FACEIT id, which it keeps, or by the mode it had (Task 1 review:
    /// it must not lose the mode on an upgrade). A match with neither is what its pack says.
    #[test]
    fn an_upgrade_keeps_a_faceit_matchs_mode() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        })
        .unwrap();
        let mut pack = Vec::new();
        demoviewer_pack::write(&with_still_tracks(two_rounds()), &mut pack).unwrap();
        let (by_id, by_mode, neither) = ("aa".repeat(32), "bb".repeat(32), "cc".repeat(32));
        for (sha, faceit_match_id, mode) in [
            (&by_id, Some("1-aaaa"), Some(GameMode::Other)),
            (&by_mode, None, Some(GameMode::Faceit)),
            (&neither, None, Some(GameMode::Competitive)),
        ] {
            fs::write(store.pack_path(sha), &pack).unwrap();
            let old = MatchSummary {
                version: 3,
                faceit_match_id: faceit_match_id.map(Into::into),
                mode,
                ..stored(sha, None, 7)
            };
            fs::write(store.summary_path(sha), serde_json::to_vec(&old).unwrap()).unwrap();
            store.matches().insert(old);
        }
        assert_eq!(upgrade_summaries(&store), 3);
        let new = |sha: &str| store.matches().get(sha).unwrap();
        assert_eq!(
            (new(&by_id).mode, new(&by_id).faceit_match_id.as_deref()),
            (Some(GameMode::Faceit), Some("1-aaaa"))
        );
        assert_eq!(new(&by_mode).mode, Some(GameMode::Faceit));
        assert_eq!(new(&neither).mode, Some(GameMode::Other));
        assert_eq!(new(&neither).version, SUMMARY_VERSION);
    }

    /// Summaries written before the FACEIT mode are summarized again.
    #[test]
    fn summaries_from_before_version_four_are_outdated() {
        let set = MatchIndex::default();
        set.insert(MatchSummary {
            sha256: "aa".repeat(32),
            version: 3,
            ..MatchSummary::default()
        });
        assert_eq!(set.outdated().len(), 1);
    }

    /// Review Focus 5: the mode is what most players' rank type says.
    #[test]
    fn the_mode_is_the_most_common_rank_type() {
        assert_eq!(
            game_mode(&ranked(&[11, 11, 11, 12])),
            Some(GameMode::Premier)
        );
        assert_eq!(game_mode(&ranked(&[12; 10])), Some(GameMode::Competitive));
        assert_eq!(game_mode(&ranked(&[7; 4])), Some(GameMode::Wingman));
        assert_eq!(game_mode(&ranked(&[0; 10])), Some(GameMode::Other)); // a tournament demo
        let unranked: Vec<PlayerInfo> = (0..10)
            .map(|_| player(76561198000000001, "p", [2, 2]))
            .collect();
        assert_eq!(game_mode(&unranked), None); // a pack from before ranks
    }

    #[test]
    fn a_result_is_the_players_team_against_the_final_score() {
        let mut s = MatchSummary {
            score_t: 13,
            score_ct: 9,
            ..MatchSummary::default()
        };
        let with = |team| SummaryPlayer {
            team,
            ..SummaryPlayer::default()
        };
        assert_eq!(result_of(&s, &with(2)), Some(MatchResult::Win));
        assert_eq!(result_of(&s, &with(3)), Some(MatchResult::Loss));
        assert_eq!(result_of(&s, &with(0)), None);
        s.score_ct = 13;
        s.score_t = 13;
        assert_eq!(result_of(&s, &with(2)), Some(MatchResult::Tie));
        assert_eq!(serde_json::to_value(MatchResult::Win).unwrap(), "w");
    }

    #[test]
    fn version_one_summaries_are_upgraded_with_the_new_stats() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let a = "aa".repeat(32);
        let m = with_still_tracks(two_rounds());
        let mut pack = Vec::new();
        demoviewer_pack::write(&m, &mut pack).unwrap();
        fs::write(store.pack_path(&a), pack).unwrap();
        let mut v1 = stored(&a, Some("42"), 7);
        v1.version = 1;
        v1.event = Some("x".into());
        v1.gc_game_type = Some(8);
        v1.played_unix = Some(1_761_163_200);
        for p in &mut v1.players {
            p.kast_rounds = 0;
            p.rounds = 0;
        }
        fs::write(store.summary_path(&a), serde_json::to_vec(&v1).unwrap()).unwrap();
        store.matches().insert(v1);

        assert_eq!(upgrade_summaries(&store), 1);
        let new = store.matches().get(&a).unwrap();
        assert_eq!(new.version, SUMMARY_VERSION);
        assert_eq!(new.event.as_deref(), Some("x"));
        assert_eq!(new.gc_game_type, Some(8));
        assert_eq!(new.played_unix, Some(1_761_163_200));
        assert!(new.players.iter().any(|p| p.kast_rounds > 0));
        assert_eq!(new.players[0].rounds, 2);
    }

    #[test]
    fn a_match_with_no_rounds_or_tick_rate_has_no_duration() {
        let mut m = two_rounds();
        m.header.tick_rate = 0;
        assert_eq!(summarize(&m, false).duration_s, 0);
        m.header.rounds.clear();
        let s = summarize(&m, false);
        assert_eq!(
            (s.rounds, s.score_t, s.score_ct, s.duration_s),
            (0, 0, 0, 0)
        );
    }

    /// `e` with `fields` set.
    fn with(mut e: Event, fields: &[(&str, Value)]) -> Event {
        for (k, v) in fields {
            e.data.insert((*k).into(), v.clone());
        }
        e
    }

    /// An event of `kind` at `tick` by `user` (an index), with `fields`.
    fn by(kind: &str, tick: i32, user: u64, fields: &[(&str, Value)]) -> Event {
        let mut data = Map::new();
        data.insert("user_idx".into(), json!(user));
        with(
            Event {
                tick,
                kind: kind.into(),
                data,
            },
            fields,
        )
    }

    fn replay(s: &MatchSummary, i: usize) -> &ReplayStats {
        of(s, i)
            .replay
            .as_ref()
            .expect("a new summary has the replay's stats")
    }

    #[test]
    fn kills_are_counted_by_weapon_every_knife_as_one() {
        const A: Option<u64> = Some(0);
        const T: Option<u64> = Some(1);
        let (x, y) = (Some(2), Some(3));
        let kill = |tick, victim, attacker, weapon: &str| {
            with(death(tick, victim, attacker), &[("weapon", json!(weapon))])
        };
        let m = rounds_with(
            &[&[2], &[2], &[3], &[3]],
            1,
            vec![
                kill(1000, x, A, "ak47"),
                kill(1100, y, A, "ak47"),
                kill(1200, x, A, "knife_karambit"),
                kill(1300, y, A, "bayonet"),
                kill(1400, x, A, "weapon_awp"),
                kill(1500, T, A, "ak47"),   // a team kill: not by any weapon
                kill(1600, x, A, "AK 47!"), // not a weapon's name: a kill, by no weapon
                kill(1700, y, A, &"a".repeat(MAX_WEAPON_CHARS + 1)),
                death(1800, x, A), // no weapon at all
            ],
        );
        let s = summarize(&m, false);
        let weapons: Vec<(&str, u16)> = replay(&s, 0)
            .weapons
            .iter()
            .map(|(w, &k)| (w.as_str(), k))
            .collect();
        assert_eq!(weapons, [("ak47", 2), ("awp", 1), ("knife", 2)]);
        // The kills themselves are as before.
        assert_eq!(of(&s, 0).kills, 8);
    }

    /// A crafted demo's endless weapon names keep only the first [`MAX_WEAPONS`].
    #[test]
    fn a_player_keeps_at_most_so_many_weapons() {
        const A: Option<u64> = Some(0);
        const X: Option<u64> = Some(1);
        let events = (0..MAX_WEAPONS + 5)
            .map(|i| {
                with(
                    death(1000 + i as i32, X, A),
                    &[("weapon", json!(format!("w{i}")))],
                )
            })
            .chain([with(death(2000, X, A), &[("weapon", json!("w0"))])])
            .collect();
        let s = summarize(&rounds_with(&[&[2], &[3]], 1, events), false);
        let weapons = &replay(&s, 0).weapons;
        assert_eq!(weapons.len(), MAX_WEAPONS);
        assert_eq!(weapons["w0"], 2);
    }

    /// The last of a side alive against one to five enemies is in a clutch, won when their side
    /// wins the round; each player once a round, both when two are left alone.
    #[test]
    fn clutches_are_the_last_alive_against_so_many_won_with_the_round() {
        const A: Option<u64> = Some(0);
        const B: Option<u64> = Some(1);
        let (x, y, z) = (Some(2), Some(3), Some(4));
        let mut m = rounds_with(
            &[&[2, 2, 2], &[2, 2, 2], &[3, 3, 3], &[3, 3, 3], &[3, 3, 3]],
            3,
            vec![
                // Round 1 (the Ts win): B dies, A is alone against three; A kills two, then the
                // last CT is alone against A: a 1v3 for A and a 1v1 for Z.
                death(1000, B, x),
                death(1100, x, A),
                death(1200, y, A),
                death(1300, z, A),
                // Round 2 (the CTs win): A dies first, then B alone against three dies too.
                death(11000, A, x),
                death(11100, B, y),
                // Round 3 (the Ts win): a death after the round's end leaves no one in a clutch.
                death(25000 + 10, A, x),
            ],
        );
        m.header.rounds[1].winner = 3;
        let s = summarize(&m, false);
        let clutch = |i| (replay(&s, i).clutches, replay(&s, i).clutches_won);
        assert_eq!(clutch(0), ([0, 0, 1, 0, 0], [0, 0, 1, 0, 0]));
        assert_eq!(clutch(1), ([0, 0, 1, 0, 0], [0, 0, 0, 0, 0]));
        assert_eq!(clutch(4), ([1, 0, 0, 0, 0], [0, 0, 0, 0, 0]));
        assert_eq!(clutch(2), ([0; 5], [0; 5]));
    }

    #[test]
    fn a_trade_is_the_avengers_kill_and_the_avenged_death() {
        const A: Option<u64> = Some(0);
        const B: Option<u64> = Some(1);
        const X: Option<u64> = Some(2);
        let m = rounds_with(
            &[&[2, 2], &[2, 2], &[3, 3]],
            2,
            vec![
                // Round 1: X kills A; B kills X exactly 5 s later.
                death(1000, A, X),
                death(1000 + 5 * 64, X, B),
                // Round 2: the same, one tick too late.
                death(11000, A, X),
                death(11000 + 5 * 64 + 1, X, B),
            ],
        );
        let s = summarize(&m, false);
        assert_eq!(
            (replay(&s, 1).trade_kills, replay(&s, 1).traded_deaths),
            (1, 0)
        );
        assert_eq!(
            (replay(&s, 0).trade_kills, replay(&s, 0).traded_deaths),
            (0, 1)
        );
        assert_eq!(replay(&s, 2).trade_kills, 0);
    }

    /// Enemies blinded while alive, each for at most [`MAX_BLIND_MS`], and kills the player's
    /// flash assisted.
    #[test]
    fn flashes_count_living_enemies_blinded_and_flash_assists() {
        let blind = |tick, victim: u64, secs: Value| {
            by(
                "player_blind",
                tick,
                victim,
                &[("attacker_idx", json!(0)), ("blind_duration", secs)],
            )
        };
        let m = rounds_with(
            &[&[2], &[2], &[3], &[3]],
            1,
            vec![
                blind(1000, 2, json!(2.5)),
                blind(1100, 3, json!(1000.0)), // crafted: at most MAX_BLIND_MS
                blind(1200, 1, json!(3.0)),    // a teammate
                blind(1300, 0, json!(3.0)),    // themself
                blind(1400, 2, json!(0.0)),    // not blinded
                with(
                    death(1500, Some(2), Some(1)),
                    &[("assister_idx", json!(0)), ("assistedflash", json!(true))],
                ),
                blind(1600, 2, json!(4.0)), // dead
                with(
                    death(1700, Some(3), Some(1)),
                    &[("assister_idx", json!(0)), ("assistedflash", json!(false))],
                ),
            ],
        );
        let s = summarize(&m, false);
        let r = replay(&s, 0);
        assert_eq!((r.enemies_flashed, r.blind_ms), (2, 2500 + MAX_BLIND_MS));
        assert_eq!(r.flash_assists, 1);
        assert_eq!(
            of(&s, 0).assists,
            2,
            "a flash assist is an assist as before"
        );
    }

    #[test]
    fn utility_damage_is_he_and_fire_against_enemies() {
        let (a, t, x) = (Some(0), Some(1), Some(2));
        let hit = |tick, victim, dmg, health, weapon: &str| {
            with(
                hurt(tick, victim, a, dmg, health),
                &[("weapon", json!(weapon))],
            )
        };
        let m = rounds_with(
            &[&[2], &[2], &[3]],
            1,
            vec![
                hit(1000, x, 40, 60, "hegrenade"),
                hit(1100, x, 8, 52, "inferno"),
                hit(1200, x, 10, 42, "molotov"),
                hit(1300, x, 30, 12, "ak47"),
                hit(1400, x, 50, 0, "incgrenade"), // only the 12 left count
                hit(1500, t, 40, 60, "hegrenade"), // a teammate
            ],
        );
        let s = summarize(&m, false);
        assert_eq!(replay(&s, 0).utility_damage, 40 + 8 + 10 + 12);
        assert_eq!(of(&s, 0).damage, 100);
    }

    #[test]
    fn plants_and_defuses_are_counted() {
        let m = rounds_with(
            &[&[2, 2], &[3, 3]],
            2,
            vec![
                by("bomb_planted", 1000, 0, &[]),
                by("bomb_defused", 2000, 1, &[]),
                by("bomb_planted", 11000, 0, &[]),
            ],
        );
        let s = summarize(&m, false);
        assert_eq!((replay(&s, 0).plants, replay(&s, 0).defuses), (2, 0));
        assert_eq!((replay(&s, 1).plants, replay(&s, 1).defuses), (0, 1));
    }

    /// T first, then CT: the rounds on each, the enemy kills, every death and the damage.
    #[test]
    fn each_side_has_its_rounds_kills_deaths_and_damage() {
        const A: Option<u64> = Some(0);
        const X: Option<u64> = Some(1);
        let m = rounds_with(
            &[&[2, 3, 3], &[3, 2, 2]],
            3,
            vec![
                hurt(1000, X, A, 30, 70),
                death(1100, X, A),
                hurt(11000, A, X, 100, 0),
                death(11000, A, X),
                death(21000, X, A),
                death(21100, A, A), // a suicide: a death, no kill
            ],
        );
        let s = summarize(&m, false);
        let line = |r: &SideLine| (r.rounds, r.kills, r.deaths, r.damage);
        assert_eq!(line(&replay(&s, 0).sides[0]), (1, 1, 0, 30));
        assert_eq!(line(&replay(&s, 0).sides[1]), (2, 1, 2, 0));
        assert_eq!(line(&replay(&s, 1).sides[0]), (2, 1, 1, 100));
        assert_eq!(line(&replay(&s, 1).sides[1]), (1, 0, 1, 0));
    }

    /// Wallbangs, kills through smoke, no-scopes and kills while blind, when the kills say.
    #[test]
    fn kill_kinds_count_when_the_kills_carry_them() {
        const A: Option<u64> = Some(0);
        const X: Option<u64> = Some(1);
        let kind = |tick, fields: &[(&str, Value)]| with(death(tick, X, A), fields);
        let plain = [
            ("penetrated", json!(0)),
            ("thrusmoke", json!(false)),
            ("noscope", json!(false)),
            ("attackerblind", json!(false)),
        ];
        let m = rounds_with(
            &[&[2], &[3]],
            1,
            vec![
                kind(1000, &plain),
                kind(
                    1100,
                    &[("penetrated", json!(2)), ("thrusmoke", json!(true))],
                ),
                kind(
                    1200,
                    &[("noscope", json!(true)), ("attackerblind", json!(true))],
                ),
                kind(1300, &[("penetrated", json!(1))]),
                with(death(1400, A, X), &[("penetrated", json!(1))]), // X's
            ],
        );
        let s = summarize(&m, false);
        let r = replay(&s, 0);
        assert_eq!(
            (r.wallbangs, r.through_smoke, r.no_scopes, r.blind_kills),
            (Some(2), Some(1), Some(1), Some(1))
        );
        assert_eq!(replay(&s, 1).wallbangs, Some(1));
        assert_eq!(replay(&s, 1).through_smoke, Some(0));
        // Kills that never say are unknown, not none.
        let s = summarize(
            &rounds_with(&[&[2], &[3]], 1, vec![death(1000, X, A)]),
            false,
        );
        let r = replay(&s, 0);
        assert_eq!(
            (r.wallbangs, r.through_smoke, r.no_scopes, r.blind_kills),
            (None, None, None, None)
        );
    }

    /// A version 2 summary has no replay stats, and reads back so; upgraded, it has them.
    #[test]
    fn version_two_summaries_read_back_and_are_upgraded_with_the_replays_stats() {
        let v2 = r#"{"sha256":"aa","map":"de_mirage","rounds":2,"scoreT":1,"scoreCt":1,
            "durationS":10,"serverName":"","gameBuild":"","players":[{"steamid":"1","name":"a",
            "team":2,"kills":1,"deaths":0,"assists":0,"damage":0,"headshots":0,"rounds":2,
            "kastRounds":1,"openingWins":0,"openingLosses":0,"multiKills":[0,0,0,0],"rank":null}],
            "createdUnix":1,"playedUnix":null,"matchId":null,"roundWinners":[2,3],"swaps":[1],
            "version":2,"mode":null,"event":null,"gcGameType":null}"#;
        let old: MatchSummary = serde_json::from_str(v2).unwrap();
        assert_eq!(old.players[0].replay, None);

        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let a = "aa".repeat(32);
        let mut m = with_still_tracks(two_rounds());
        m.events[0].data.insert("weapon".into(), json!("ak47"));
        let mut pack = Vec::new();
        demoviewer_pack::write(&m, &mut pack).unwrap();
        fs::write(store.pack_path(&a), pack).unwrap();
        let mut v2 = stored(&a, Some("42"), 7);
        v2.version = 2;
        for p in &mut v2.players {
            p.replay = None;
        }
        store.matches().insert(v2);

        assert_eq!(upgrade_summaries(&store), 1);
        let new = store.matches().get(&a).unwrap();
        assert_eq!(new.version, SUMMARY_VERSION);
        let alpha = new.players[0].replay.as_ref().unwrap();
        assert_eq!(alpha.weapons.get("ak47"), Some(&1));
        assert!(new.players.iter().all(|p| p.replay.is_some()));
    }

    /// More outdated summaries than the upgrade reads at once: every one is upgraded, once.
    #[test]
    fn many_summaries_are_upgraded_each_once() {
        let dir = tempfile::tempdir().unwrap();
        let cfg = crate::config::Config {
            data_dir: dir.path().to_owned(),
            ..crate::config::Config::default()
        };
        let store = Store::open(&cfg).unwrap();
        let m = with_still_tracks(two_rounds());
        let mut pack = Vec::new();
        demoviewer_pack::write(&m, &mut pack).unwrap();
        let shas: Vec<String> = (0..3 * UPGRADE_THREADS + 1)
            .map(|i| format!("{i:02x}").repeat(32))
            .collect();
        for (i, sha) in shas.iter().enumerate() {
            fs::write(store.pack_path(sha), &pack).unwrap();
            let mut old = stored(sha, None, i as u64);
            old.version = 2;
            store.matches().insert(old);
        }
        assert_eq!(upgrade_summaries(&store), shas.len());
        for (i, sha) in shas.iter().enumerate() {
            let new = store.matches().get(sha).unwrap();
            assert_eq!((new.version, new.created_unix), (SUMMARY_VERSION, i as u64));
            assert!(store.summary_path(sha).exists());
        }
        assert_eq!(upgrade_summaries(&store), 0);
    }
}
