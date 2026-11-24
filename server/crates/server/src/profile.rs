//! A player's profile from the matches we hold: their Premier rating and Competitive rank,
//! totals, maps, who they played with and their match list. Pure: the caller hands it the
//! player's matches, what Steam says ([`crate::profiles`]) and who is hidden. Every field is
//! always there; what is unknown is `null`, which the page shows as "—".
//!
//! Every match is listed, and counts for who they played with; only full 5v5 matches count in
//! the totals and the maps (a match of Wingman, the 3v3 mode, or with fewer than five players a
//! side, whatever its rank type).
//!
//! A tracked player's FACEIT history ([`crate::faceit_history`]) is added by the caller, as
//! FACEIT gave it ([`faceit_rows`]): FACEIT's facts, never counted with ours.

use std::collections::HashMap;
use std::sync::Arc;

use demoviewer_pack::PlayerRank;
use serde::{Deserialize, Serialize};

use crate::faceit::Faceit;
use crate::faceit_history::{DemoState, FaceitEntry};
use crate::identity::individual_steamid;
use crate::matches::{result_of, GameMode, MatchResult, MatchSummary, ReplayStats, SummaryPlayer};
use crate::profiles::CachedProfile;
use crate::rating::{norms, rating, RatingLine};
use crate::steam::TradeBan;

/// Matches a profile lists at once; the rest come by [`match_rows`]' offset.
pub const PROFILE_PAGE: usize = 100;
/// Players a side for a match to count: those with a round on that side.
const FULL_SIDE: usize = 5;
/// The players a profile lists as played with.
const MATES: usize = 10;
/// The matches together that make someone a player played with: one is chance.
const MATE_MATCHES: u32 = 2;
/// The weapons a profile lists the kills of.
const WEAPONS: usize = 8;
/// The rows of a player's FACEIT history a profile lists: the newest.
pub const FACEIT_ROWS: usize = 20;
/// Rank types ([`PlayerRank::kind`]).
const PREMIER: u8 = 11;
const COMPETITIVE: u8 = 12;

/// One of the player's matches: its summary, and the demo id its links use.
#[derive(Debug, Clone)]
pub struct MatchRef {
    pub summary: Arc<MatchSummary>,
    pub demo_id: String,
}

/// Whether the player's new matches are fetched as they play them ([`crate::tracking`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrackingState {
    Off,
    On,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub steamid: String,
    pub name: Option<String>,
    pub avatar: Option<String>,
    pub steam: SteamFacts,
    /// The FACEIT account linked to theirs, kept with Steam's facts; none without one.
    pub faceit: Option<Faceit>,
    pub tracking: TrackingState,
    pub premier: Option<PremierRank>,
    pub competitive: Option<CompetitiveRank>,
    pub totals: Totals,
    /// What the replays' events add to the totals.
    pub replay: ReplayTotals,
    pub maps: Vec<MapLine>,
    /// Who was on the player's team most often, in [`MATE_MATCHES`] or more, at most [`MATES`].
    pub mates: Vec<Mate>,
    /// The newest [`PROFILE_PAGE`].
    pub matches: Vec<MatchRow>,
    /// All the player's matches.
    pub match_count: u32,
    /// Steam's facts are being fetched: a later answer has them.
    pub steam_pending: bool,
    /// Their newest [`FACEIT_ROWS`] FACEIT matches, newest first, as FACEIT gave them
    /// ([`faceit_rows`]); none but for a player the FACEIT poller tracked, and then left out of
    /// the JSON.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub faceit_history: Vec<FaceitRow>,
}

/// A match of the player's FACEIT history, as FACEIT gave it, with where to watch it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceitRow {
    /// FACEIT's id of the match.
    pub match_id: String,
    /// When it finished, in unix seconds.
    pub finished_unix: u64,
    /// The map (`de_mirage`), when FACEIT said.
    pub map: Option<String>,
    /// The player's team's score, then the other's, when FACEIT said.
    pub score: Option<[u8; 2]>,
    /// Whether the player's team won, when FACEIT said.
    pub won: Option<bool>,
    /// The competition it was played in (`CS2 5v5`, a hub's or a league's name).
    pub competition: Option<String>,
    /// The demo id of its replay, when the site holds its demo.
    pub replay: Option<String>,
    /// Its room on FACEIT.
    pub room_url: String,
}

/// The rows a profile lists of `entry`, a player's FACEIT history: its newest [`FACEIT_ROWS`],
/// newest first, as the file keeps them. A row held by a demo has its replay while `done` says
/// that demo's record is done (one forgotten since, or expired, has none: the poller turns its
/// row back into a pending one, and a demo uploaded again attaches to it).
pub fn faceit_rows(entry: &FaceitEntry, done: impl Fn(&str) -> bool) -> Vec<FaceitRow> {
    entry
        .matches
        .iter()
        .take(FACEIT_ROWS)
        .map(|m| FaceitRow {
            match_id: m.match_id.clone(),
            finished_unix: m.finished_unix,
            map: m.map.clone(),
            score: m.score,
            won: m.won,
            competition: m.competition.clone(),
            replay: match &m.demo {
                DemoState::Held(id) if done(id) => Some(id.clone()),
                _ => None,
            },
            room_url: format!("https://www.faceit.com/en/cs2/room/{}", m.match_id),
        })
        .collect()
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamFacts {
    pub since_year: Option<u16>,
    pub country: Option<String>,
    pub cs2_hours: Option<u32>,
    /// Minutes of CS2 in the last two weeks.
    pub cs2_recent_minutes: Option<u32>,
    pub level: Option<u32>,
    pub vac_bans: Option<u32>,
    pub game_bans: Option<u32>,
    pub community_banned: Option<bool>,
    /// `probation` or `banned`; none without a trade ban.
    pub trade_ban: Option<TradeBan>,
    /// Days since the last VAC or game ban; none without one.
    pub days_since_last_ban: Option<u32>,
}

/// From the player's latest Premier match: their rating after it (0 = unrated, with `wins` of
/// the ten it takes).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PremierRank {
    pub rating: u32,
    pub wins: u32,
    pub demo_id: String,
}

/// The latest Competitive rank on the map the player played most in Competitive (0 =
/// unranked).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompetitiveRank {
    pub map: String,
    pub rank: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Totals {
    /// The mean of the matches' ratings.
    pub rating: Option<f32>,
    pub opening_won: u32,
    pub opening_lost: u32,
    pub kd: Option<f32>,
    /// Damage per round played.
    pub adr: Option<f32>,
    pub hs_pct: Option<f32>,
    pub matches: u32,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    /// Rounds played.
    pub rounds: u32,
    /// The rounds with a kill, an assist, survival or a traded death, of the rounds played: over
    /// the matches whose summary counts the player's rounds, as is `survival_pct`.
    pub kast_pct: Option<f32>,
    /// The rounds survived, of the rounds played (a player dies at most once a round).
    pub survival_pct: Option<f32>,
    /// Rounds with 2, 3, 4 and 5 or more kills.
    pub multi_kills: [u32; 4],
    /// The matches with a result, by it.
    pub wins: u32,
    pub losses: u32,
    pub ties: u32,
    /// Time played: the matches' lengths, in seconds.
    pub seconds: u64,
}

/// What the replays' events add ([`ReplayStats`]), over the counted matches whose summary has
/// them (summary version 3 on): `matches` of [`Totals::matches`]. Per round is over the
/// player's own rounds in those matches.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayTotals {
    pub matches: u32,
    /// The player's kills in those matches, which a weapon's share is of.
    pub kills: u32,
    /// Kills by weapon, most first, at most [`WEAPONS`].
    pub weapons: Vec<WeaponKills>,
    /// Clutches 1v1 to 1v5, and of those the ones won.
    pub clutches: [u32; 5],
    pub clutches_won: [u32; 5],
    pub trade_kills: u32,
    pub traded_deaths: u32,
    pub flash_assists: u32,
    pub enemies_flashed: u32,
    /// Seconds enemies were blind from the player's flashes, a round.
    pub blind_per_round: Option<f32>,
    /// Damage to enemies by HE grenades and fire, a round.
    pub utility_adr: Option<f32>,
    pub plants: u32,
    pub defuses: u32,
    pub t: SideTotals,
    pub ct: SideTotals,
    /// Kills through a wall, through smoke, without a scope and while blind, over the matches
    /// whose kills say; none when no match's do.
    pub wallbangs: Option<u32>,
    pub through_smoke: Option<u32>,
    pub no_scopes: Option<u32>,
    pub blind_kills: Option<u32>,
}

/// The player's rounds on one side, their kills and deaths, K/D and damage per round.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SideTotals {
    pub rounds: u32,
    pub kills: u32,
    pub deaths: u32,
    pub kd: Option<f32>,
    pub adr: Option<f32>,
}

/// A weapon, as the kills name it (`ak47`, `m4a1_silencer`, `knife`), and the kills with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponKills {
    pub weapon: String,
    pub kills: u32,
}

/// A player who was on the player's team: in how many matches, and how many of those they won.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mate {
    pub steamid: String,
    /// Their name in the latest match together.
    pub name: String,
    pub matches: u32,
    pub wins: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLine {
    pub map: String,
    pub matches: u32,
    /// Over the matches with a result.
    pub win_pct: Option<f32>,
    pub rating: Option<f32>,
    /// The latest Competitive rank on the map.
    pub rank: Option<u8>,
    /// The totals over this map's counted matches alone.
    pub totals: Totals,
    /// The replay figures over those of this map's counted matches that have them.
    pub replay: ReplayTotals,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchRow {
    pub demo_id: String,
    pub map: String,
    pub mode: Option<GameMode>,
    pub event: Option<String>,
    /// When it was played, else when it was stored.
    pub played_unix: Option<u64>,
    pub result: Option<MatchResult>,
    /// The player's team's, then the other's.
    pub score: Option<[u8; 2]>,
    pub kills: u16,
    pub deaths: u16,
    pub assists: u16,
    /// Damage per round played.
    pub adr: Option<f32>,
    pub hs_pct: Option<f32>,
    pub kast_pct: Option<f32>,
    pub rating: Option<f32>,
    pub rank: Option<PlayerRank>,
    /// Whether it counts towards the totals (a Competitive, Premier or similar 5v5 match).
    pub counted: bool,
    /// Opening duels the player won and lost.
    pub opening_won: u16,
    pub opening_lost: u16,
    /// Rounds with two, three, four and five kills.
    pub multi_kills: [u16; 4],
    /// Rounds the player played, and of those the rounds they were killing, assisting,
    /// surviving or traded in.
    pub rounds: u16,
    pub kast_rounds: u16,
    /// What the replay tells of this game alone; `None` for a summary from before it did.
    pub replay: Option<ReplayTotals>,
}

/// One of the player's matches with their line in it.
struct Played<'a> {
    m: &'a MatchRef,
    p: &'a SummaryPlayer,
    /// When it was played, else stored: what the list is ordered by.
    at: u64,
    counted: bool,
    rating: Option<f32>,
    result: Option<MatchResult>,
}

/// The profile of `steamid` from `matches` (any order; those without the player are left
/// out) and Steam's facts. `hidden` says who is hidden: never listed as played with.
pub fn build_profile(
    steamid: u64,
    matches: &[MatchRef],
    steam: Option<&CachedProfile>,
    tracking: TrackingState,
    hidden: impl Fn(u64) -> bool,
) -> ProfileView {
    let all = played(steamid, matches);
    let counted: Vec<&Played> = all.iter().filter(|x| x.counted).collect();
    ProfileView {
        steamid: steamid.to_string(),
        name: steam
            .map(|s| s.name.clone())
            .or_else(|| all.first().map(|x| x.p.name.clone())),
        avatar: steam.and_then(|s| s.avatar.clone()),
        steam: steam.map_or_else(SteamFacts::default, |s| SteamFacts {
            since_year: s.since_year,
            country: s.country.clone(),
            cs2_hours: s.cs2_hours,
            cs2_recent_minutes: s.cs2_recent_minutes,
            level: s.level,
            vac_bans: s.vac_bans,
            game_bans: s.game_bans,
            community_banned: s.community_banned,
            trade_ban: s.trade_ban,
            days_since_last_ban: s.days_since_last_ban,
        }),
        faceit: steam.and_then(|s| s.faceit.clone()),
        tracking,
        premier: premier(&all),
        competitive: competitive(&all),
        totals: totals(&counted),
        replay: replay_totals(&counted),
        maps: maps(&counted),
        mates: mates(steamid, &all, hidden),
        matches: all.iter().take(PROFILE_PAGE).map(row).collect(),
        match_count: u32::try_from(all.len()).unwrap_or(u32::MAX),
        steam_pending: false,
        faceit_history: Vec::new(),
    }
}

/// The rows of `steamid`'s matches from `offset`, newest first, at most [`PROFILE_PAGE`].
pub fn match_rows(steamid: u64, matches: &[MatchRef], offset: usize) -> Vec<MatchRow> {
    played(steamid, matches)
        .iter()
        .skip(offset)
        .take(PROFILE_PAGE)
        .map(row)
        .collect()
}

/// `steamid`'s line in each match that has one, newest first.
fn played(steamid: u64, matches: &[MatchRef]) -> Vec<Played<'_>> {
    let id = steamid.to_string();
    let mut all: Vec<Played> = matches
        .iter()
        .filter_map(|m| {
            let s = &m.summary;
            let p = s.players.iter().find(|p| p.steamid == id)?;
            Some(Played {
                m,
                p,
                at: s.sort_unix(),
                counted: counts(s),
                rating: rating(&RatingLine::from(p), norms()),
                result: result_of(s, p),
            })
        })
        .collect();
    all.sort_by(|a, b| {
        b.at.cmp(&a.at)
            .then_with(|| b.m.summary.sha256.cmp(&a.m.summary.sha256))
    });
    all
}

/// Whether a match counts in the totals and maps: not Wingman, and five players or more a
/// side, counting those with a round on that side (all of them in a summary from before
/// rounds were counted).
fn counts(s: &MatchSummary) -> bool {
    if s.mode == Some(GameMode::Wingman) {
        return false;
    }
    let rounds_known = s.players.iter().any(|p| p.rounds > 0);
    let side = |team: u8| {
        s.players
            .iter()
            .filter(|p| p.team == team && (!rounds_known || p.rounds > 0))
            .count()
    };
    side(2) >= FULL_SIDE && side(3) >= FULL_SIDE
}

fn totals(counted: &[&Played]) -> Totals {
    let sum = |f: &dyn Fn(&Played) -> u64| counted.iter().map(|x| f(x)).sum::<u64>();
    let kills = sum(&|x| u64::from(x.p.kills));
    let deaths = sum(&|x| u64::from(x.p.deaths));
    let damage = sum(&|x| u64::from(x.p.damage));
    let rounds = sum(&|x| u64::from(rounds_of(x)));
    let headshots = sum(&|x| u64::from(x.p.headshots));
    // KAST and survival only where the summary counts the player's own rounds (all of them but
    // one from before rounds were counted, whose KAST rounds are 0 too).
    let own_rounds = sum(&|x| u64::from(x.p.rounds));
    let kast_rounds = sum(&|x| u64::from(x.p.kast_rounds));
    let survived = sum(&|x| u64::from(x.p.rounds.saturating_sub(x.p.deaths)));
    let results = |r: MatchResult| counted.iter().filter(|x| x.result == Some(r)).count() as u32;
    let int = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    Totals {
        rating: mean(counted.iter().filter_map(|x| x.rating)),
        opening_won: sum(&|x| u64::from(x.p.opening_wins)) as u32,
        opening_lost: sum(&|x| u64::from(x.p.opening_losses)) as u32,
        kd: (kills > 0 || deaths > 0).then(|| kills as f32 / deaths.max(1) as f32),
        adr: ratio(damage, rounds),
        hs_pct: ratio(headshots * 100, kills),
        matches: counted.len() as u32,
        kills: int(kills),
        deaths: int(deaths),
        assists: int(sum(&|x| u64::from(x.p.assists))),
        rounds: int(rounds),
        kast_pct: ratio(kast_rounds * 100, own_rounds),
        survival_pct: ratio(survived * 100, own_rounds),
        multi_kills: std::array::from_fn(|i| int(sum(&|x| u64::from(x.p.multi_kills[i])))),
        wins: results(MatchResult::Win),
        losses: results(MatchResult::Loss),
        ties: results(MatchResult::Tie),
        seconds: sum(&|x| u64::from(x.m.summary.duration_s)),
    }
}

fn replay_totals(counted: &[&Played]) -> ReplayTotals {
    let seen: Vec<(&Played, &ReplayStats)> = counted
        .iter()
        .filter_map(|x| Some((*x, x.p.replay.as_ref()?)))
        .collect();
    let sum = |f: &dyn Fn(&ReplayStats) -> u64| seen.iter().map(|(_, r)| f(r)).sum::<u64>();
    let int = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    let rounds: u64 = seen.iter().map(|(x, _)| u64::from(x.p.rounds)).sum();
    let mut by_weapon: HashMap<&str, u64> = HashMap::new();
    for (_, r) in &seen {
        for (weapon, &kills) in &r.weapons {
            *by_weapon.entry(weapon).or_default() += u64::from(kills);
        }
    }
    let mut weapons: Vec<WeaponKills> = by_weapon
        .into_iter()
        .map(|(weapon, kills)| WeaponKills {
            weapon: weapon.to_owned(),
            kills: int(kills),
        })
        .collect();
    weapons.sort_by(|a, b| b.kills.cmp(&a.kills).then_with(|| a.weapon.cmp(&b.weapon)));
    weapons.truncate(WEAPONS);
    let side = |i: usize| {
        let rounds = sum(&|r| u64::from(r.sides[i].rounds));
        let kills = sum(&|r| u64::from(r.sides[i].kills));
        let deaths = sum(&|r| u64::from(r.sides[i].deaths));
        SideTotals {
            rounds: int(rounds),
            kills: int(kills),
            deaths: int(deaths),
            kd: (kills > 0 || deaths > 0).then(|| kills as f32 / deaths.max(1) as f32),
            adr: ratio(sum(&|r| u64::from(r.sides[i].damage)), rounds),
        }
    };
    // Over the matches whose kills say; none when none does.
    let kind = |f: &dyn Fn(&ReplayStats) -> Option<u16>| {
        let known: Vec<u64> = seen
            .iter()
            .filter_map(|(_, r)| f(r))
            .map(u64::from)
            .collect();
        (!known.is_empty()).then(|| int(known.iter().sum()))
    };
    ReplayTotals {
        matches: seen.len() as u32,
        kills: int(seen.iter().map(|(x, _)| u64::from(x.p.kills)).sum()),
        weapons,
        clutches: std::array::from_fn(|i| int(sum(&|r| u64::from(r.clutches[i])))),
        clutches_won: std::array::from_fn(|i| int(sum(&|r| u64::from(r.clutches_won[i])))),
        trade_kills: int(sum(&|r| u64::from(r.trade_kills))),
        traded_deaths: int(sum(&|r| u64::from(r.traded_deaths))),
        flash_assists: int(sum(&|r| u64::from(r.flash_assists))),
        enemies_flashed: int(sum(&|r| u64::from(r.enemies_flashed))),
        blind_per_round: ratio(sum(&|r| u64::from(r.blind_ms)), rounds * 1000),
        utility_adr: ratio(sum(&|r| u64::from(r.utility_damage)), rounds),
        plants: int(sum(&|r| u64::from(r.plants))),
        defuses: int(sum(&|r| u64::from(r.defuses))),
        t: side(0),
        ct: side(1),
        wallbangs: kind(&|r| r.wallbangs),
        through_smoke: kind(&|r| r.through_smoke),
        no_scopes: kind(&|r| r.no_scopes),
        blind_kills: kind(&|r| r.blind_kills),
    }
}

/// `a` over `b`; `None` when `b` is 0.
fn ratio(a: u64, b: u64) -> Option<f32> {
    (b > 0).then(|| a as f32 / b as f32)
}

/// The rounds the player played: theirs, or the match's in a summary from before they were
/// counted.
fn rounds_of(x: &Played) -> u16 {
    if x.p.rounds > 0 {
        x.p.rounds
    } else {
        x.m.summary.rounds
    }
}

fn maps(counted: &[&Played]) -> Vec<MapLine> {
    // Newest first, so the first of a map is its latest.
    let mut by_map: HashMap<&str, Vec<&Played>> = HashMap::new();
    for x in counted {
        by_map.entry(x.m.summary.map.as_str()).or_default().push(x);
    }
    let mut lines: Vec<(u64, MapLine)> = by_map
        .into_iter()
        .map(|(map, xs)| {
            let decided: Vec<MatchResult> = xs.iter().filter_map(|x| x.result).collect();
            let wins = decided.iter().filter(|r| **r == MatchResult::Win).count();
            let line = MapLine {
                map: map.to_owned(),
                matches: xs.len() as u32,
                win_pct: (!decided.is_empty()).then(|| wins as f32 * 100.0 / decided.len() as f32),
                rating: mean(xs.iter().filter_map(|x| x.rating)),
                rank: xs
                    .iter()
                    .find_map(|x| x.p.rank.filter(|r| r.kind == COMPETITIVE))
                    .map(|r| clamp_u8(r.value)),
                totals: totals(&xs),
                replay: replay_totals(&xs),
            };
            (xs[0].at, line)
        })
        .collect();
    lines.sort_by(|(a_at, a), (b_at, b)| {
        b.matches
            .cmp(&a.matches)
            .then(b_at.cmp(a_at))
            .then_with(|| a.map.cmp(&b.map))
    });
    lines.into_iter().map(|(_, line)| line).collect()
}

/// Who was on `steamid`'s team in `all` (newest first), most matches together first, then most
/// won, then the latest: real players only (an individual's steamid64, never a bot), in
/// [`MATE_MATCHES`] matches or more, never `steamid` and never one `hidden` names, at most
/// [`MATES`].
fn mates(steamid: u64, all: &[Played], hidden: impl Fn(u64) -> bool) -> Vec<Mate> {
    // Newest first, so a mate's first entry has their latest name and match.
    let mut by_id: HashMap<u64, (u64, Mate)> = HashMap::new();
    for x in all.iter().filter(|x| matches!(x.p.team, 2 | 3)) {
        let won = u32::from(x.result == Some(MatchResult::Win));
        for p in x.m.summary.players.iter().filter(|p| p.team == x.p.team) {
            let Some(id) = individual_steamid(&p.steamid).filter(|&id| id != steamid) else {
                continue;
            };
            let (_, mate) = by_id.entry(id).or_insert_with(|| {
                let mate = Mate {
                    steamid: p.steamid.clone(),
                    name: p.name.clone(),
                    matches: 0,
                    wins: 0,
                };
                (x.at, mate)
            });
            mate.matches += 1;
            mate.wins += won;
        }
    }
    let mut mates: Vec<(u64, u64, Mate)> = by_id
        .into_iter()
        .map(|(id, (at, mate))| (id, at, mate))
        .collect();
    mates.sort_by(|(a_id, a_at, a), (b_id, b_at, b)| {
        b.matches
            .cmp(&a.matches)
            .then(b.wins.cmp(&a.wins))
            .then(b_at.cmp(a_at))
            .then(a_id.cmp(b_id))
    });
    // The hidden are left out before the cut, so the list stays full.
    mates
        .into_iter()
        .filter(|(id, _, mate)| mate.matches >= MATE_MATCHES && !hidden(*id))
        .take(MATES)
        .map(|(_, _, mate)| mate)
        .collect()
}

fn premier(all: &[Played]) -> Option<PremierRank> {
    let (x, rank) = all
        .iter()
        .find_map(|x| x.p.rank.filter(|r| r.kind == PREMIER).map(|r| (x, r)))?;
    let after = match x.result {
        Some(MatchResult::Win) => rank.if_win,
        Some(MatchResult::Loss) => rank.if_loss,
        Some(MatchResult::Tie) => rank.if_tie,
        None => 0,
    };
    let rating = if after != 0 { after } else { rank.value };
    Some(PremierRank {
        rating: u32::try_from(rating).unwrap_or(0),
        wins: u32::try_from(rank.wins).unwrap_or(0),
        demo_id: x.m.demo_id.clone(),
    })
}

fn competitive(all: &[Played]) -> Option<CompetitiveRank> {
    // Newest first: a map's first entry is its latest rank.
    let mut by_map: HashMap<&str, (u32, u64, PlayerRank)> = HashMap::new();
    for x in all {
        let Some(rank) = x.p.rank.filter(|r| r.kind == COMPETITIVE) else {
            continue;
        };
        by_map
            .entry(x.m.summary.map.as_str())
            .or_insert((0, x.at, rank))
            .0 += 1;
    }
    let (map, (_, _, rank)) = by_map.into_iter().max_by(|(a_map, a), (b_map, b)| {
        a.0.cmp(&b.0)
            .then(a.1.cmp(&b.1))
            .then_with(|| b_map.cmp(a_map))
    })?;
    Some(CompetitiveRank {
        map: map.to_owned(),
        rank: clamp_u8(rank.value),
    })
}

fn row(x: &Played) -> MatchRow {
    let s = &x.m.summary;
    MatchRow {
        demo_id: x.m.demo_id.clone(),
        map: s.map.clone(),
        mode: s.mode,
        event: s.event.clone(),
        played_unix: s.played(),
        result: x.result,
        score: match x.p.team {
            2 => Some([s.score_t, s.score_ct]),
            3 => Some([s.score_ct, s.score_t]),
            _ => None,
        },
        kills: x.p.kills,
        deaths: x.p.deaths,
        assists: x.p.assists,
        adr: ratio(u64::from(x.p.damage), u64::from(rounds_of(x))),
        hs_pct: ratio(u64::from(x.p.headshots) * 100, u64::from(x.p.kills)),
        kast_pct: ratio(u64::from(x.p.kast_rounds) * 100, u64::from(x.p.rounds)),
        rating: x.rating,
        rank: x.p.rank,
        counted: x.counted,
        opening_won: x.p.opening_wins,
        opening_lost: x.p.opening_losses,
        multi_kills: x.p.multi_kills,
        rounds: x.p.rounds,
        kast_rounds: x.p.kast_rounds,
        replay: x.p.replay.as_ref().map(|_| replay_totals(&[x])),
    }
}

fn mean(values: impl Iterator<Item = f32>) -> Option<f32> {
    let (sum, n) = values.fold((0.0, 0u32), |(s, n), v| (s + v, n + 1));
    (n > 0).then(|| sum / n as f32)
}

fn clamp_u8(v: i32) -> u8 {
    u8::try_from(v.max(0)).unwrap_or(u8::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matches::{ReplayStats, SideLine, SummaryPlayer};

    const ME: u64 = 76561198000000001;

    fn me(team: u8, k: u16, d: u16) -> SummaryPlayer {
        SummaryPlayer {
            steamid: ME.to_string(),
            name: "skunk".into(),
            team,
            kills: k,
            deaths: d,
            rounds: 20,
            kast_rounds: 14,
            damage: 80 * 20,
            ..SummaryPlayer::default()
        }
    }

    fn ranked(mut p: SummaryPlayer, kind: u8, value: i32, wins: i32) -> SummaryPlayer {
        p.rank = Some(PlayerRank {
            kind,
            value,
            wins,
            if_win: 0,
            if_loss: 0,
            if_tie: 0,
        });
        p
    }

    /// A match of `mine` and `others` more players a side (4 + 5 for a 5v5), played at `at`.
    fn game(
        sha: &str,
        map: &str,
        mode: Option<GameMode>,
        at: u64,
        score: (u8, u8),
        mine: SummaryPlayer,
        side: usize,
    ) -> MatchRef {
        let mut players = vec![mine.clone()];
        for i in 0..(2 * side - 1) {
            let team = if i < side - 1 {
                mine.team
            } else {
                5 - mine.team
            };
            players.push(SummaryPlayer {
                steamid: (ME + 100 + i as u64).to_string(),
                name: format!("p{i}"),
                team,
                rounds: mine.rounds,
                ..SummaryPlayer::default()
            });
        }
        MatchRef {
            summary: Arc::new(MatchSummary {
                sha256: sha.into(),
                map: map.into(),
                rounds: u16::from(score.0) + u16::from(score.1),
                score_t: score.0,
                score_ct: score.1,
                players,
                created_unix: at,
                played_unix: Some(at),
                mode,
                ..MatchSummary::default()
            }),
            demo_id: format!("id-{sha}"),
        }
    }

    fn comp(sha: &str, map: &str, at: u64, mine: SummaryPlayer) -> MatchRef {
        game(sha, map, Some(GameMode::Competitive), at, (13, 9), mine, 5)
    }

    /// Hides no one.
    fn no_one(_: u64) -> bool {
        false
    }

    /// `m` lasting `seconds`.
    fn lasting(mut m: MatchRef, seconds: u32) -> MatchRef {
        Arc::make_mut(&mut m.summary).duration_s = seconds;
        m
    }

    /// `m` with the players beside [`ME`] named `mates` (steamid, name), in order.
    fn beside(mut m: MatchRef, mates: &[(&str, &str)]) -> MatchRef {
        let s = Arc::make_mut(&mut m.summary);
        let team = s.players[0].team;
        let others = s.players.iter_mut().skip(1).filter(|p| p.team == team);
        for (p, (id, name)) in others.zip(mates) {
            (p.steamid, p.name) = ((*id).to_owned(), (*name).to_owned());
        }
        m
    }

    #[test]
    fn faceit_rows_are_the_newest_twenty_with_a_replay_only_when_held_and_done() {
        use crate::faceit_history::FaceitMatch;
        let row = |n: u64, demo: DemoState| FaceitMatch {
            match_id: format!("1-{n}"),
            finished_unix: 1_000 - n,
            map: Some("de_nuke".into()),
            score: Some([13, 9]),
            won: Some(true),
            competition: Some("CS2 5v5".into()),
            players: vec![1, 2],
            demo,
            demo_url: Some("https://example.com/a.dem.gz".into()),
            fetch_tries: 1,
            detail_tries: 1,
        };
        let mut entry = FaceitEntry {
            matches: vec![
                row(0, DemoState::Held("done".into())),
                row(1, DemoState::Held("gone".into())),
                row(2, DemoState::Pending),
            ],
            ..FaceitEntry::default()
        };
        entry
            .matches
            .extend((3..25).map(|n| row(n, DemoState::Unavailable)));
        let rows = faceit_rows(&entry, |id| id == "done");
        assert_eq!(rows.len(), FACEIT_ROWS);
        assert_eq!(
            rows[0],
            FaceitRow {
                match_id: "1-0".into(),
                finished_unix: 1_000,
                map: Some("de_nuke".into()),
                score: Some([13, 9]),
                won: Some(true),
                competition: Some("CS2 5v5".into()),
                replay: Some("done".into()),
                room_url: "https://www.faceit.com/en/cs2/room/1-0".into(),
            }
        );
        let replays: Vec<Option<&str>> = rows.iter().map(|r| r.replay.as_deref()).collect();
        assert_eq!(replays[..3], [Some("done"), None, None]);
        assert_eq!(rows[19].match_id, "1-19");
        // An empty history is left out of the profile's JSON.
        let view = build_profile(1, &[], None, TrackingState::Off, no_one);
        assert!(view.faceit_history.is_empty());
        let json = serde_json::to_value(&view).unwrap();
        assert!(json.get("faceitHistory").is_none(), "{json}");
    }

    #[test]
    fn totals_add_up_the_counted_matches_and_their_results() {
        let line = |team, k, d, a, rounds, kast, multi| SummaryPlayer {
            assists: a,
            rounds,
            kast_rounds: kast,
            multi_kills: multi,
            ..me(team, k, d)
        };
        let v = build_profile(
            ME,
            &[
                lasting(
                    comp(
                        "a",
                        "de_mirage",
                        10,
                        line(2, 20, 10, 4, 20, 14, [3, 1, 0, 0]),
                    ),
                    2400,
                ),
                lasting(
                    game(
                        "b",
                        "de_nuke",
                        Some(GameMode::Premier),
                        20,
                        (9, 13),
                        line(2, 10, 15, 6, 20, 12, [1, 0, 1, 1]),
                        5,
                    ),
                    1800,
                ),
                lasting(
                    game(
                        "c",
                        "de_inferno",
                        Some(GameMode::Competitive),
                        30,
                        (12, 12),
                        line(3, 15, 15, 2, 24, 18, [2, 0, 0, 0]),
                        5,
                    ),
                    3000,
                ),
                // Wingman is listed, never totalled.
                lasting(
                    game(
                        "d",
                        "de_vertigo",
                        Some(GameMode::Wingman),
                        40,
                        (9, 2),
                        line(2, 30, 1, 9, 11, 11, [5, 4, 3, 2]),
                        2,
                    ),
                    900,
                ),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let t = &v.totals;
        assert_eq!(t.matches, 3);
        assert_eq!((t.kills, t.deaths, t.assists, t.rounds), (45, 40, 12, 64));
        assert_eq!(t.kast_pct, Some(44.0 * 100.0 / 64.0));
        assert_eq!(
            t.survival_pct,
            Some(24.0 * 100.0 / 64.0),
            "10 + 5 + 9 of 64"
        );
        assert_eq!(t.multi_kills, [6, 1, 1, 1]);
        assert_eq!((t.wins, t.losses, t.ties), (1, 1, 1));
        assert_eq!(t.seconds, 7200);
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["totals"]["survivalPct"], 37.5);
        assert_eq!(json["totals"]["seconds"], 7200);
    }

    #[test]
    fn kast_and_survival_leave_out_a_summary_without_the_players_rounds() {
        let mut old = me(2, 5, 12);
        (old.rounds, old.kast_rounds) = (0, 0);
        let mut new = me(2, 20, 10);
        new.kast_rounds = 15;
        let v = build_profile(
            ME,
            &[
                game(
                    "a",
                    "de_mirage",
                    Some(GameMode::Competitive),
                    10,
                    (13, 9),
                    old,
                    5,
                ),
                comp("b", "de_mirage", 20, new),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let t = &v.totals;
        assert_eq!(t.kast_pct, Some(75.0));
        assert_eq!(t.survival_pct, Some(50.0));
        assert_eq!(t.rounds, 42, "the old match's own 22 rounds");
        assert_eq!(t.deaths, 22);
    }

    #[test]
    fn mates_are_teammates_most_matches_then_wins_then_latest() {
        const A: &str = "76561198000000011";
        const B: &str = "76561198000000012";
        const C: &str = "76561198000000013";
        const D: &str = "76561198000000014";
        const HID: u64 = 76561198000000015;
        let hid = HID.to_string();
        let lost = |sha, at| {
            game(
                sha,
                "de_nuke",
                Some(GameMode::Competitive),
                at,
                (9, 13),
                me(2, 1, 1),
                5,
            )
        };
        let wingman = game(
            "d",
            "de_vertigo",
            Some(GameMode::Wingman),
            40,
            (9, 5),
            me(2, 1, 1),
            2,
        );
        let v = build_profile(
            ME,
            &[
                beside(
                    comp("a", "de_mirage", 10, me(2, 1, 1)),
                    &[(A, "a old"), (B, "b"), (C, "c"), (D, "d")],
                ),
                beside(
                    lost("b", 20),
                    &[(A, "a"), (B, "b"), (&hid, "hidden"), ("0", "BOT Kev")],
                ),
                beside(
                    comp("c", "de_mirage", 30, me(2, 1, 1)),
                    &[(A, "a new"), (C, "c"), ("12345", "odd"), ("0", "BOT Kev")],
                ),
                beside(wingman, &[(D, "d")]),
            ],
            None,
            TrackingState::Off,
            |id| id == HID,
        );
        let mates: Vec<(&str, &str, u32, u32)> = v
            .mates
            .iter()
            .map(|m| (m.steamid.as_str(), m.name.as_str(), m.matches, m.wins))
            .collect();
        // D and C both won twice of two: D was beside the player last (Wingman counts here).
        // No opponent, no bot, no id that is not an individual's, not the player, not the
        // hidden player.
        assert_eq!(
            mates,
            [
                (A, "a new", 3, 2),
                (D, "d", 2, 2),
                (C, "c", 2, 2),
                (B, "b", 2, 1)
            ]
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(
            json["mates"][0],
            serde_json::json!({"steamid": A, "name": "a new", "matches": 3, "wins": 2})
        );
    }

    /// One match together is chance, not someone they play with: only two or more list them.
    #[test]
    fn a_teammate_of_one_match_is_not_listed() {
        const A: &str = "76561198000000011";
        const B: &str = "76561198000000012";
        let v = build_profile(
            ME,
            &[
                beside(
                    comp("a", "de_mirage", 10, me(2, 1, 1)),
                    &[(A, "a"), (B, "b")],
                ),
                beside(comp("b", "de_nuke", 20, me(2, 1, 1)), &[(A, "a")]),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let listed: Vec<&str> = v.mates.iter().map(|m| m.name.as_str()).collect();
        assert!(
            listed.contains(&"a") && !listed.contains(&"b"),
            "{listed:?}"
        );
        assert!(v.mates.iter().all(|m| m.matches >= 2), "{:?}", v.mates);
    }

    #[test]
    fn mates_are_the_top_ten_after_the_hidden_are_left_out() {
        let id = |i: u64| (ME + 1000 + i).to_string();
        let ids: Vec<String> = (1..=12).map(id).collect();
        let four = |from: usize| -> Vec<(&str, &str)> {
            ids[from..from + 4]
                .iter()
                .map(|i| (i.as_str(), "m"))
                .collect()
        };
        let v = build_profile(
            ME,
            &[
                // Three matches with the first four, two with each of the others.
                beside(comp("a", "de_mirage", 10, me(2, 1, 1)), &four(0)),
                beside(comp("b", "de_mirage", 20, me(2, 1, 1)), &four(0)),
                beside(comp("c", "de_mirage", 25, me(2, 1, 1)), &four(0)),
                beside(comp("d", "de_mirage", 30, me(2, 1, 1)), &four(4)),
                beside(comp("e", "de_mirage", 35, me(2, 1, 1)), &four(4)),
                beside(comp("f", "de_mirage", 40, me(2, 1, 1)), &four(8)),
                beside(comp("g", "de_mirage", 45, me(2, 1, 1)), &four(8)),
            ],
            None,
            TrackingState::Off,
            |x| x == ME + 1001,
        );
        let listed: Vec<&str> = v.mates.iter().map(|m| m.steamid.as_str()).collect();
        assert_eq!(listed.len(), 10);
        assert_eq!(&listed[..3], [&ids[1], &ids[2], &ids[3]]);
        assert!(!listed.contains(&ids[0].as_str()));
    }

    #[test]
    fn a_row_has_the_players_assists_adr_headshots_and_kast() {
        let mut p = me(2, 16, 10);
        (p.assists, p.damage, p.headshots, p.kast_rounds) = (5, 1700, 8, 15);
        let mut none = me(2, 0, 10);
        (none.rounds, none.kast_rounds, none.damage) = (0, 0, 1100);
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, p),
                comp("b", "de_mirage", 20, none),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let r = &v.matches[1];
        assert_eq!(
            (r.assists, r.adr, r.hs_pct, r.kast_pct),
            (5, Some(85.0), Some(50.0), Some(75.0))
        );
        // No kills, no rounds of their own: ADR over the match's 22 rounds, the rest unknown.
        let r = &v.matches[0];
        assert_eq!((r.adr, r.hs_pct, r.kast_pct), (Some(50.0), None, None));
        let json = serde_json::to_value(&v.matches[1]).unwrap();
        assert_eq!(
            (&json["assists"], &json["hsPct"], &json["kastPct"]),
            (
                &serde_json::json!(5),
                &serde_json::json!(50.0),
                &serde_json::json!(75.0)
            )
        );
    }

    #[test]
    fn totals_are_sums_over_counted_matches() {
        let mut a = me(2, 20, 10);
        (
            a.damage,
            a.rounds,
            a.headshots,
            a.opening_wins,
            a.opening_losses,
        ) = (1600, 20, 10, 3, 1);
        let mut b = me(2, 10, 15);
        (
            b.damage,
            b.rounds,
            b.headshots,
            b.opening_wins,
            b.opening_losses,
        ) = (1100, 20, 4, 1, 2);
        let v = build_profile(
            ME,
            &[comp("a", "de_mirage", 10, a), comp("b", "de_mirage", 20, b)],
            None,
            TrackingState::Off,
            no_one,
        );
        let t = &v.totals;
        assert_eq!(t.matches, 2);
        assert!((t.kd.unwrap() - 1.2).abs() < 0.001, "{:?}", t.kd);
        assert!((t.adr.unwrap() - 67.5).abs() < 0.001);
        assert!((t.hs_pct.unwrap() - 46.67).abs() < 0.01);
        assert_eq!((t.opening_won, t.opening_lost), (4, 3));
        assert!(t.rating.is_some());
        assert_eq!(v.match_count, 2);
        assert_eq!(v.name.as_deref(), Some("skunk"), "the latest demo's name");
    }

    #[test]
    fn wingman_is_listed_but_not_counted_and_other_is_counted() {
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, me(2, 20, 10)),
                game(
                    "b",
                    "de_vertigo",
                    Some(GameMode::Wingman),
                    20,
                    (9, 5),
                    me(2, 9, 9),
                    2,
                ),
                game(
                    "c",
                    "de_nuke",
                    Some(GameMode::Other),
                    30,
                    (13, 11),
                    me(3, 25, 17),
                    5,
                ),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(v.totals.matches, 2);
        let maps: Vec<&str> = v.maps.iter().map(|m| m.map.as_str()).collect();
        assert_eq!(maps, ["de_nuke", "de_mirage"]);
        let modes: Vec<Option<GameMode>> = v.matches.iter().map(|r| r.mode).collect();
        assert_eq!(
            modes,
            [
                Some(GameMode::Other),
                Some(GameMode::Wingman),
                Some(GameMode::Competitive)
            ]
        );
    }

    #[test]
    fn a_three_a_side_match_is_listed_but_not_counted() {
        // The 3v3 mode (Rush): whatever its rank type, only 5v5 counts.
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, me(2, 20, 10)),
                game(
                    "b",
                    "de_inferno",
                    Some(GameMode::Other),
                    20,
                    (8, 6),
                    me(2, 9, 2),
                    3,
                ),
                game(
                    "c",
                    "de_dust2",
                    Some(GameMode::Competitive),
                    30,
                    (8, 6),
                    me(2, 9, 2),
                    3,
                ),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(v.totals.matches, 1);
        assert_eq!(v.maps.len(), 1);
        assert_eq!(v.matches.len(), 3);
    }

    #[test]
    fn a_leavers_match_counts_their_teams_result() {
        let mut left = me(3, 2, 4);
        (left.rounds, left.damage) = (5, 500);
        let v = build_profile(
            ME,
            &[game(
                "a",
                "de_mirage",
                Some(GameMode::Competitive),
                10,
                (9, 13),
                left,
                5,
            )],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(v.matches[0].result, Some(MatchResult::Win));
        assert_eq!(v.matches[0].score, Some([13, 9]));
        assert_eq!(v.totals.adr, Some(100.0), "over the 5 rounds played");
        assert_eq!(v.totals.matches, 1);
    }

    #[test]
    fn premier_rating_is_the_latest_matchs_value_after_its_result() {
        let mut latest = ranked(me(2, 20, 10), 11, 8058, 31);
        latest.rank.as_mut().unwrap().if_win = 8150;
        latest.rank.as_mut().unwrap().if_loss = 7960;
        let older = ranked(me(2, 20, 10), 11, 12000, 20);
        let premier = |sha, at, p| {
            game(
                sha,
                "de_ancient",
                Some(GameMode::Premier),
                at,
                (13, 9),
                p,
                5,
            )
        };
        let v = build_profile(
            ME,
            &[premier("old", 10, older), premier("new", 20, latest)],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(
            v.premier,
            Some(PremierRank {
                rating: 8150,
                wins: 31,
                demo_id: "id-new".into()
            })
        );
    }

    #[test]
    fn an_unrated_premier_player_shows_wins_of_ten() {
        let p = ranked(me(2, 20, 10), 11, 0, 4);
        let v = build_profile(
            ME,
            &[game(
                "a",
                "de_ancient",
                Some(GameMode::Premier),
                10,
                (9, 13),
                p,
                5,
            )],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(
            v.premier,
            Some(PremierRank {
                rating: 0,
                wins: 4,
                demo_id: "id-a".into()
            })
        );
    }

    #[test]
    fn the_competitive_rank_is_the_most_played_maps_latest() {
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, ranked(me(2, 1, 1), 12, 7, 30)),
                comp("b", "de_mirage", 20, ranked(me(2, 1, 1), 12, 8, 31)),
                comp("c", "de_nuke", 30, ranked(me(2, 1, 1), 12, 15, 12)),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(
            v.competitive,
            Some(CompetitiveRank {
                map: "de_mirage".into(),
                rank: 8
            })
        );
        assert_eq!(v.premier, None);
    }

    #[test]
    fn maps_are_most_played_first_with_their_latest_rank() {
        let v = build_profile(
            ME,
            &[
                comp("a", "de_nuke", 10, ranked(me(2, 1, 1), 12, 3, 1)),
                comp("b", "de_mirage", 20, me(2, 1, 1)),
                game(
                    "c",
                    "de_mirage",
                    Some(GameMode::Other),
                    30,
                    (9, 13),
                    me(2, 1, 1),
                    5,
                ),
                comp("d", "de_nuke", 40, ranked(me(2, 1, 1), 12, 5, 2)),
                comp("e", "de_inferno", 50, me(2, 1, 1)),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let maps: Vec<(&str, u32, Option<u8>)> = v
            .maps
            .iter()
            .map(|m| (m.map.as_str(), m.matches, m.rank))
            .collect();
        // Nuke and Mirage both twice: Nuke was played last.
        assert_eq!(
            maps,
            [
                ("de_nuke", 2, Some(5)),
                ("de_mirage", 2, None),
                ("de_inferno", 1, None)
            ]
        );
        let mirage = &v.maps[1];
        assert_eq!(mirage.win_pct, Some(50.0));
        assert!(mirage.rating.is_some());
    }

    /// `p` with what the replay's events tell.
    fn seen(mut p: SummaryPlayer, r: ReplayStats) -> SummaryPlayer {
        p.replay = Some(r);
        p
    }

    fn side(rounds: u16, kills: u16, deaths: u16, damage: u32) -> SideLine {
        SideLine {
            rounds,
            kills,
            deaths,
            damage,
        }
    }

    fn by_weapon(weapons: &[(&str, u16)]) -> std::collections::BTreeMap<String, u16> {
        weapons.iter().map(|&(w, k)| (w.to_owned(), k)).collect()
    }

    /// Over the counted matches whose summary has them: a summary from before them, and a
    /// Wingman match, are left out.
    #[test]
    fn the_replays_stats_add_up_over_the_counted_matches_that_have_them() {
        let one = ReplayStats {
            weapons: by_weapon(&[("ak47", 10), ("awp", 4), ("knife", 1)]),
            clutches: [2, 1, 0, 0, 0],
            clutches_won: [1, 0, 0, 0, 0],
            trade_kills: 3,
            traded_deaths: 2,
            flash_assists: 1,
            enemies_flashed: 6,
            blind_ms: 12_000,
            utility_damage: 100,
            plants: 2,
            defuses: 0,
            sides: [side(12, 10, 5, 1000), side(8, 5, 5, 600)],
            wallbangs: Some(1),
            through_smoke: Some(2),
            no_scopes: None,
            blind_kills: Some(0),
        };
        let two = ReplayStats {
            weapons: by_weapon(&[("ak47", 5), ("m4a1", 6)]),
            clutches: [1, 0, 0, 0, 1],
            clutches_won: [1, 0, 0, 0, 1],
            trade_kills: 1,
            traded_deaths: 1,
            flash_assists: 2,
            enemies_flashed: 4,
            blind_ms: 8_000,
            utility_damage: 60,
            plants: 0,
            defuses: 1,
            sides: [side(8, 4, 6, 400), side(12, 7, 4, 900)],
            wallbangs: Some(2),
            through_smoke: None,
            no_scopes: None,
            blind_kills: Some(1),
        };
        let wingman = game(
            "d",
            "de_vertigo",
            Some(GameMode::Wingman),
            40,
            (9, 2),
            seen(me(2, 30, 1), one.clone()),
            2,
        );
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, seen(me(2, 15, 10), one)),
                comp("b", "de_nuke", 20, seen(me(3, 11, 10), two)),
                comp("c", "de_inferno", 30, me(2, 30, 5)),
                wingman,
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let r = &v.replay;
        assert_eq!((r.matches, r.kills), (2, 26));
        assert_eq!(v.totals.matches, 3);
        let weapons: Vec<(&str, u32)> = r
            .weapons
            .iter()
            .map(|w| (w.weapon.as_str(), w.kills))
            .collect();
        assert_eq!(
            weapons,
            [("ak47", 15), ("m4a1", 6), ("awp", 4), ("knife", 1)]
        );
        assert_eq!(r.clutches, [3, 1, 0, 0, 1]);
        assert_eq!(r.clutches_won, [2, 0, 0, 0, 1]);
        assert_eq!((r.trade_kills, r.traded_deaths), (4, 3));
        assert_eq!((r.flash_assists, r.enemies_flashed), (3, 10));
        // Over the 40 rounds of the two matches.
        assert_eq!(r.blind_per_round, Some(0.5));
        assert_eq!(r.utility_adr, Some(4.0));
        assert_eq!((r.plants, r.defuses), (2, 1));
        assert_eq!(
            r.t,
            SideTotals {
                rounds: 20,
                kills: 14,
                deaths: 11,
                kd: Some(14.0 / 11.0),
                adr: Some(70.0),
            }
        );
        assert_eq!(
            (r.ct.rounds, r.ct.kd, r.ct.adr),
            (20, Some(12.0 / 9.0), Some(75.0))
        );
        // A kind of kill counts over the matches whose kills say; none say, none known.
        assert_eq!(
            (r.wallbangs, r.through_smoke, r.no_scopes, r.blind_kills),
            (Some(3), Some(2), None, Some(1))
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(
            json["replay"]["clutchesWon"],
            serde_json::json!([2, 0, 0, 0, 1])
        );
        assert_eq!(
            json["replay"]["weapons"][0],
            serde_json::json!({"weapon": "ak47", "kills": 15})
        );
        assert_eq!(json["replay"]["t"]["adr"], 70.0);
        assert_eq!(json["replay"]["noScopes"], serde_json::Value::Null);
    }

    /// The weapons with the most kills, then by name, at most [`WEAPONS`].
    #[test]
    fn the_top_weapons_are_the_most_kills_at_most_so_many() {
        let names: Vec<String> = (0..12).map(|i| format!("w{i:02}")).collect();
        let weapons: Vec<(&str, u16)> = names
            .iter()
            .enumerate()
            .map(|(i, w)| (w.as_str(), if i < 2 { 1 } else { 10 + i as u16 }))
            .collect();
        let r = ReplayStats {
            weapons: by_weapon(&weapons),
            ..ReplayStats::default()
        };
        let v = build_profile(
            ME,
            &[comp("a", "de_mirage", 10, seen(me(2, 15, 10), r))],
            None,
            TrackingState::Off,
            no_one,
        );
        let top: Vec<&str> = v.replay.weapons.iter().map(|w| w.weapon.as_str()).collect();
        assert_eq!(
            top,
            ["w11", "w10", "w09", "w08", "w07", "w06", "w05", "w04"]
        );
        assert_eq!(top.len(), WEAPONS);
    }

    /// Only summaries from before the replay's stats: nothing from them, the rest unchanged.
    #[test]
    fn without_the_replays_stats_a_profile_has_none() {
        let v = build_profile(
            ME,
            &[comp("a", "de_mirage", 10, me(2, 15, 10))],
            None,
            TrackingState::Off,
            no_one,
        );
        assert_eq!(v.totals.matches, 1);
        assert_eq!(v.replay, ReplayTotals::default());
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(json["replay"]["matches"], 0);
        assert_eq!(json["replay"]["weapons"], serde_json::json!([]));
        assert_eq!(json["replay"]["utilityAdr"], serde_json::Value::Null);
        assert_eq!(json["replay"]["t"]["kd"], serde_json::Value::Null);
    }

    #[test]
    fn a_player_with_no_matches_has_every_field_and_dashes() {
        let v = build_profile(ME, &[], None, TrackingState::Off, no_one);
        assert_eq!(v.steamid, ME.to_string());
        assert_eq!((v.name.as_deref(), v.avatar.as_deref()), (None, None));
        assert_eq!(
            v.totals,
            Totals {
                rating: None,
                opening_won: 0,
                opening_lost: 0,
                kd: None,
                adr: None,
                hs_pct: None,
                matches: 0,
                kills: 0,
                deaths: 0,
                assists: 0,
                rounds: 0,
                kast_pct: None,
                survival_pct: None,
                multi_kills: [0; 4],
                wins: 0,
                losses: 0,
                ties: 0,
                seconds: 0,
            }
        );
        assert!(v.maps.is_empty() && v.matches.is_empty() && v.mates.is_empty());
        assert_eq!(
            (v.match_count, v.premier.is_none(), v.competitive.is_none()),
            (0, true, true)
        );
        let json = serde_json::to_value(&v).unwrap();
        for fact in [
            "sinceYear",
            "level",
            "cs2RecentMinutes",
            "communityBanned",
            "tradeBan",
            "daysSinceLastBan",
        ] {
            assert_eq!(json["steam"][fact], serde_json::Value::Null, "{fact}");
        }
        assert_eq!(json["totals"]["hsPct"], serde_json::Value::Null);
        assert_eq!(json["totals"]["kastPct"], serde_json::Value::Null);
        assert_eq!(
            json["totals"]["multiKills"],
            serde_json::json!([0, 0, 0, 0])
        );
        assert_eq!(json["mates"], serde_json::json!([]));
        assert_eq!(json["tracking"], "off");
        assert_eq!(json["matchCount"], 0);
        assert_eq!(json["faceit"], serde_json::Value::Null);
        assert!(json.as_object().unwrap().contains_key("faceit"));
    }

    #[test]
    fn steams_facts_and_name_come_first() {
        let steam = CachedProfile {
            steamid: ME,
            name: "skunk on steam".into(),
            avatar: Some("https://avatars.steamstatic.com/a.jpg".into()),
            since_year: Some(2009),
            country: Some("US".into()),
            cs2_hours: Some(1234),
            cs2_recent_minutes: Some(725),
            level: Some(42),
            vac_bans: Some(1),
            game_bans: Some(0),
            community_banned: Some(false),
            trade_ban: Some(TradeBan::Banned),
            days_since_last_ban: Some(400),
            faceit: Some(Faceit {
                nickname: "alphafaceit".into(),
                level: Some(10),
                elo: Some(3609),
                player_id: Some("a1b2c3d4-0000-4000-8000-000000000001".into()),
                wins_pct: Some(61.0),
                matches: Some(1204),
            }),
            fetched_unix: 1,
        };
        let v = build_profile(
            ME,
            &[comp("a", "de_mirage", 10, me(2, 1, 1))],
            Some(&steam),
            TrackingState::Off,
            no_one,
        );
        assert_eq!(v.name.as_deref(), Some("skunk on steam"));
        assert_eq!(v.avatar, steam.avatar);
        assert_eq!(
            v.steam,
            SteamFacts {
                since_year: Some(2009),
                country: Some("US".into()),
                cs2_hours: Some(1234),
                cs2_recent_minutes: Some(725),
                level: Some(42),
                vac_bans: Some(1),
                game_bans: Some(0),
                community_banned: Some(false),
                trade_ban: Some(TradeBan::Banned),
                days_since_last_ban: Some(400),
            }
        );
        let json = serde_json::to_value(&v).unwrap();
        assert_eq!(
            json["steam"],
            serde_json::json!({
                "sinceYear": 2009, "country": "US", "cs2Hours": 1234,
                "cs2RecentMinutes": 725, "level": 42, "vacBans": 1, "gameBans": 0,
                "communityBanned": false, "tradeBan": "banned", "daysSinceLastBan": 400,
            })
        );
        assert_eq!(
            json["faceit"],
            serde_json::json!({
                "nickname": "alphafaceit", "level": 10, "elo": 3609,
                "playerId": "a1b2c3d4-0000-4000-8000-000000000001", "winsPct": 61.0,
                "matches": 1204,
            })
        );
    }

    #[test]
    fn a_maps_line_carries_its_own_totals() {
        let r = |weapons| ReplayStats {
            weapons: by_weapon(weapons),
            ..ReplayStats::default()
        };
        let v = build_profile(
            ME,
            &[
                comp("a", "de_mirage", 10, seen(me(2, 10, 5), r(&[("ak47", 10)]))),
                comp("b", "de_mirage", 20, seen(me(2, 7, 9), r(&[("awp", 7)]))),
                comp("c", "de_nuke", 30, seen(me(2, 3, 3), r(&[("ak47", 3)]))),
            ],
            None,
            TrackingState::Off,
            no_one,
        );
        let mirage = v.maps.iter().find(|m| m.map == "de_mirage").unwrap();
        assert_eq!(mirage.totals.matches, 2);
        assert_eq!(mirage.totals.kills, 17);
        assert_eq!(mirage.replay.matches, 2);
        let nuke = v.maps.iter().find(|m| m.map == "de_nuke").unwrap();
        assert_eq!((nuke.totals.matches, nuke.totals.kills), (1, 3));
        assert_eq!(nuke.replay.matches, 1);
    }

    #[test]
    fn a_match_row_carries_its_game() {
        let mut mine = seen(me(2, 10, 5), ReplayStats::default());
        mine.opening_wins = 3;
        mine.opening_losses = 2;
        mine.multi_kills = [1, 2, 3, 4];
        let wingman = game(
            "w",
            "de_inferno",
            Some(GameMode::Wingman),
            5,
            (9, 7),
            me(2, 1, 1),
            2,
        );
        let v = build_profile(
            ME,
            &[comp("a", "de_mirage", 10, mine), wingman],
            None,
            TrackingState::Off,
            no_one,
        );
        let row = &v.matches[0];
        assert_eq!(row.demo_id, "id-a");
        assert!(row.counted);
        assert_eq!((row.opening_won, row.opening_lost), (3, 2));
        assert_eq!(row.multi_kills, [1, 2, 3, 4]);
        assert_eq!((row.rounds, row.kast_rounds), (20, 14));
        assert_eq!(row.replay.as_ref().map(|r| r.matches), Some(1));
        let w = &v.matches[1];
        assert!(!w.counted);
        assert!(w.replay.is_none());
    }

    #[test]
    fn rows_are_newest_first_and_paged() {
        let all: Vec<MatchRef> = (0..130u64)
            .map(|i| comp(&format!("m{i}"), "de_mirage", 1000 + i, me(2, 1, 1)))
            .collect();
        let v = build_profile(ME, &all, None, TrackingState::Off, no_one);
        assert_eq!((v.matches.len(), v.match_count), (PROFILE_PAGE, 130));
        assert_eq!(v.matches[0].demo_id, "id-m129");
        assert_eq!(v.matches[0].played_unix, Some(1129));
        let rest = match_rows(ME, &all, 100);
        assert_eq!(rest.len(), 30);
        assert_eq!(rest.last().unwrap().demo_id, "id-m0");
        assert!(match_rows(ME, &all, 500).is_empty());
    }
}
