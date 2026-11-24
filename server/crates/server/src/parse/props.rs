//! The parser passes, and typed access to the per-tick player columns they produce.

use ahash::AHashMap;
use demoviewer_pack::PlayerRank;
use parser::first_pass::parser_settings::{rm_user_friendly_names, ParserInputs};
use parser::first_pass::read_bits::DemoParserError;
use parser::parse_demo::{DemoOutput, Parser, ParsingMode};
use parser::second_pass::parser_settings::create_huffman_lookup_table;
use parser::second_pass::variants::{PropColumn, VarVec};

/// Player props sampled into tracks, as demoparser friendly names. The parser adds `tick`,
/// `steamid` and `name` to every pass on its own.
pub(super) const PLAYER_PROPS: &[&str] = &[
    "team_num",
    "X",
    "Y",
    "Z",
    "pitch",
    "yaw",
    "health",
    "armor_value",
    "is_alive",
    "is_scoped",
    "is_defusing",
    "is_walking",
    "is_airborne",
    "duck_amount",
    "active_weapon_name",
    "balance",
    "active_weapon_ammo",
    "has_helmet",
    "has_defuser",
    "zoom_lvl",
    "inventory",
    "crosshair_code",
    "rank",
    "comp_rank_type",
    "comp_wins",
    "rank_if_win",
    "rank_if_loss",
    "rank_if_tie",
];

/// Team-entity prop the events pass attaches to every event as `t_score` / `ct_score`.
const TEAM_SCORE: &str = "CCSTeam.m_iScore";

pub(super) struct Outputs {
    /// One row per player per tick: `PLAYER_PROPS` plus tick, steamid, name.
    pub ticks: DemoOutput,
    /// All game events, each carrying `t_score` / `ct_score`.
    pub events: DemoOutput,
    /// One row per grenade projectile per tick, and the world-entity records
    /// (`DemoOutput::world_entities`).
    pub projectiles: DemoOutput,
}

/// Parses `bytes` three times. A single pass cannot produce all three outputs: the vendored
/// parser collects no player rows while any event is wanted, and only projectile rows while
/// projectiles are (`second_pass/collect_data.rs`, `collect_entities`).
pub(super) fn run_passes(bytes: &[u8]) -> Result<Outputs, DemoParserError> {
    let huf = create_huffman_lookup_table();

    let friendly: Vec<String> = PLAYER_PROPS.iter().map(|s| s.to_string()).collect();
    let real = rm_user_friendly_names(&friendly)?;
    let real_to_friendly = real.iter().cloned().zip(friendly).collect();
    let ticks = parse(
        bytes,
        ParserInputs {
            wanted_player_props: real,
            real_name_to_og_name: real_to_friendly,
            ..base(&huf)
        },
    )?;

    let events = parse(
        bytes,
        ParserInputs {
            wanted_events: vec!["all".to_string()],
            wanted_other_props: vec![TEAM_SCORE.to_string()],
            real_name_to_og_name: [(TEAM_SCORE.to_string(), "score".to_string())]
                .into_iter()
                .collect(),
            ..base(&huf)
        },
    )?;

    // `parse_grenades` stays off: it only adds rows for grenades still in players' hands,
    // which have no coordinates. Doors, breakables and items on the ground ride along: they
    // need no prop and no player row.
    let projectiles = parse(
        bytes,
        ParserInputs {
            parse_projectiles: true,
            parse_world_entities: true,
            ..base(&huf)
        },
    )?;

    Ok(Outputs {
        ticks,
        events,
        projectiles,
    })
}

#[allow(clippy::ptr_arg)] // `ParserInputs` holds a `&Vec`.
fn base(huf: &Vec<(u8, u8)>) -> ParserInputs<'_> {
    ParserInputs {
        real_name_to_og_name: AHashMap::default(),
        wanted_players: vec![],
        wanted_player_props: vec![],
        wanted_other_props: vec![],
        wanted_prop_states: AHashMap::default(),
        wanted_ticks: vec![],
        wanted_events: vec![],
        parse_ents: true,
        parse_projectiles: false,
        parse_grenades: false,
        parse_world_entities: false,
        only_header: false,
        only_convars: false,
        huffman_lookup_table: huf,
        order_by_steamid: false,
        list_props: false,
        fallback_bytes: None,
    }
}

fn parse(bytes: &[u8], inputs: ParserInputs<'_>) -> Result<DemoOutput, DemoParserError> {
    Parser::new(inputs, ParsingMode::Normal).parse_demo(bytes)
}

/// One column of parser output. A missing column, a missing cell and a cell of an unexpected
/// type all read as `None`.
#[derive(Clone, Copy, Default)]
pub(super) struct Column<'a>(pub Option<&'a VarVec>);

impl<'a> Column<'a> {
    pub fn of(df: &'a AHashMap<u32, PropColumn>, id: u32) -> Self {
        Column(df.get(&id).and_then(|c| c.data.as_ref()))
    }

    pub fn len(&self) -> usize {
        match self.0 {
            Some(VarVec::U32(v)) => v.len(),
            Some(VarVec::Bool(v)) => v.len(),
            Some(VarVec::U64(v)) => v.len(),
            Some(VarVec::F32(v)) => v.len(),
            Some(VarVec::I32(v)) => v.len(),
            Some(VarVec::String(v)) => v.len(),
            Some(VarVec::XYVec(v)) => v.len(),
            Some(VarVec::XYZVec(v)) => v.len(),
            Some(VarVec::StringVec(v)) => v.len(),
            Some(VarVec::U64Vec(v)) => v.len(),
            Some(VarVec::U32Vec(v)) => v.len(),
            Some(VarVec::Stickers(v)) => v.len(),
            Some(VarVec::InputHistory(v)) => v.len(),
            Some(VarVec::UserCmdSubtickMoves(v)) => v.len(),
            None => 0,
        }
    }

    pub fn f32(&self, row: usize) -> Option<f32> {
        match self.0? {
            VarVec::F32(v) => *v.get(row)?,
            VarVec::I32(v) => v.get(row)?.map(|x| x as f32),
            VarVec::U32(v) => v.get(row)?.map(|x| x as f32),
            VarVec::U64(v) => v.get(row)?.map(|x| x as f32),
            VarVec::Bool(v) => v.get(row)?.map(|x| x as u8 as f32),
            _ => None,
        }
    }

    pub fn i32(&self, row: usize) -> Option<i32> {
        match self.0? {
            VarVec::I32(v) => *v.get(row)?,
            VarVec::U32(v) => v.get(row)?.and_then(|x| x.try_into().ok()),
            VarVec::U64(v) => v.get(row)?.and_then(|x| x.try_into().ok()),
            VarVec::F32(v) => v
                .get(row)?
                .filter(|x| x.is_finite())
                .map(|x| x.round() as i32),
            VarVec::Bool(v) => v.get(row)?.map(i32::from),
            _ => None,
        }
    }

    pub fn u64(&self, row: usize) -> Option<u64> {
        match self.0? {
            VarVec::U64(v) => *v.get(row)?,
            VarVec::U32(v) => v.get(row)?.map(u64::from),
            VarVec::I32(v) => v.get(row)?.and_then(|x| x.try_into().ok()),
            VarVec::String(v) => v.get(row)?.as_deref()?.parse().ok(),
            _ => None,
        }
    }

    pub fn bool(&self, row: usize) -> Option<bool> {
        match self.0? {
            VarVec::Bool(v) => *v.get(row)?,
            _ => self.f32(row).map(|x| x != 0.0),
        }
    }

    pub fn str(&self, row: usize) -> Option<&'a str> {
        match self.0? {
            VarVec::String(v) => v.get(row)?.as_deref(),
            _ => None,
        }
    }

    pub fn strs(&self, row: usize) -> Option<&'a [String]> {
        match self.0? {
            VarVec::StringVec(v) => v.get(row).map(Vec::as_slice),
            _ => None,
        }
    }
}

/// A player's state at one tick, read from the tick pass.
#[derive(Debug, Clone, Default, PartialEq)]
pub(super) struct PlayerState<'a> {
    pub tick: i32,
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub yaw: f32,
    pub pitch: f32,
    pub health: i32,
    pub armor: i32,
    /// 2 = T, 3 = CT, 0 otherwise.
    pub team: u8,
    pub alive: bool,
    pub scoped: bool,
    pub defusing: bool,
    pub walking: bool,
    pub airborne: bool,
    pub duck: f32,
    pub weapon: Option<&'a str>,
    pub money: i32,
    /// Rounds in the active weapon's magazine; `None` (or negative) without one.
    pub ammo: Option<i32>,
    pub helmet: bool,
    pub kit: bool,
    /// 0 unscoped, 1 or 2 by scope level.
    pub zoom: i32,
    /// Display names of everything carried, in the game's order.
    pub inventory: Option<&'a [String]>,
}

/// The tick pass's player rows, indexed by player.
pub(super) struct TickTable<'a> {
    tick: Column<'a>,
    team: Column<'a>,
    x: Column<'a>,
    y: Column<'a>,
    z: Column<'a>,
    yaw: Column<'a>,
    pitch: Column<'a>,
    health: Column<'a>,
    armor: Column<'a>,
    alive: Column<'a>,
    scoped: Column<'a>,
    defusing: Column<'a>,
    walking: Column<'a>,
    airborne: Column<'a>,
    duck: Column<'a>,
    weapon: Column<'a>,
    money: Column<'a>,
    ammo: Column<'a>,
    helmet: Column<'a>,
    kit: Column<'a>,
    zoom: Column<'a>,
    inventory: Column<'a>,
    crosshair: Column<'a>,
    rank: Column<'a>,
    rank_kind: Column<'a>,
    rank_wins: Column<'a>,
    rank_if_win: Column<'a>,
    rank_if_loss: Column<'a>,
    rank_if_tie: Column<'a>,
    /// Per steamid: `(tick, row)` for every row that has a position, sorted by tick.
    by_player: AHashMap<u64, Vec<(i32, usize)>>,
}

impl<'a> TickTable<'a> {
    pub fn from_output(out: &'a DemoOutput) -> Self {
        let ids: AHashMap<&str, u32> = out
            .prop_controller
            .prop_infos
            .iter()
            .map(|p| (p.prop_friendly_name.as_str(), p.id))
            .collect();
        Self::new(|name| {
            ids.get(name)
                .and_then(|id| out.df.get(id))
                .and_then(|c| c.data.as_ref())
        })
    }

    /// Builds the table from columns looked up by friendly name.
    pub fn new(col: impl Fn(&str) -> Option<&'a VarVec>) -> Self {
        let c = |name: &str| Column(col(name));
        let mut t = TickTable {
            tick: c("tick"),
            team: c("team_num"),
            x: c("X"),
            y: c("Y"),
            z: c("Z"),
            yaw: c("yaw"),
            pitch: c("pitch"),
            health: c("health"),
            armor: c("armor_value"),
            alive: c("is_alive"),
            scoped: c("is_scoped"),
            defusing: c("is_defusing"),
            walking: c("is_walking"),
            airborne: c("is_airborne"),
            duck: c("duck_amount"),
            weapon: c("active_weapon_name"),
            money: c("balance"),
            ammo: c("active_weapon_ammo"),
            helmet: c("has_helmet"),
            kit: c("has_defuser"),
            zoom: c("zoom_lvl"),
            inventory: c("inventory"),
            crosshair: c("crosshair_code"),
            rank: c("rank"),
            rank_kind: c("comp_rank_type"),
            rank_wins: c("comp_wins"),
            rank_if_win: c("rank_if_win"),
            rank_if_loss: c("rank_if_loss"),
            rank_if_tie: c("rank_if_tie"),
            by_player: AHashMap::default(),
        };
        let steamid = c("steamid");
        for row in 0..t.tick.len() {
            let (Some(sid), Some(tick)) = (steamid.u64(row), t.tick.i32(row)) else {
                continue;
            };
            if sid == 0
                || t.x.f32(row).is_none()
                || t.y.f32(row).is_none()
                || t.z.f32(row).is_none()
            {
                continue;
            }
            t.by_player.entry(sid).or_default().push((tick, row));
        }
        for rows in t.by_player.values_mut() {
            // Already in tick order from the parser; the stable sort keeps same-tick rows in order.
            if !rows.windows(2).all(|w| w[0].0 <= w[1].0) {
                rows.sort_by_key(|&(tick, _)| tick);
            }
        }
        t
    }

    /// The player's state from the latest row at or before `tick`, if that row is no earlier
    /// than `from_tick` and at most `max_age` ticks old. `None` means no data: not connected,
    /// no pawn, or not in the demo at all.
    pub fn state_at(
        &self,
        steamid: u64,
        from_tick: i32,
        tick: i32,
        max_age: i32,
    ) -> Option<PlayerState<'a>> {
        let rows = self.by_player.get(&steamid)?;
        let i = rows.partition_point(|&(t, _)| t <= tick);
        let &(row_tick, row) = rows.get(i.checked_sub(1)?)?;
        if row_tick < from_tick || tick - row_tick > max_age {
            return None;
        }
        Some(PlayerState {
            tick: row_tick,
            x: self.x.f32(row)?,
            y: self.y.f32(row)?,
            z: self.z.f32(row)?,
            yaw: self.yaw.f32(row).unwrap_or(0.0),
            pitch: self.pitch.f32(row).unwrap_or(0.0),
            health: self.health.i32(row).unwrap_or(0),
            armor: self.armor.i32(row).unwrap_or(0),
            team: match self.team.i32(row) {
                Some(team @ (2 | 3)) => team as u8,
                _ => 0,
            },
            alive: self.alive.bool(row).unwrap_or(false),
            scoped: self.scoped.bool(row).unwrap_or(false),
            defusing: self.defusing.bool(row).unwrap_or(false),
            walking: self.walking.bool(row).unwrap_or(false),
            airborne: self.airborne.bool(row).unwrap_or(false),
            duck: self.duck.f32(row).unwrap_or(0.0),
            weapon: self.weapon.str(row),
            money: self.money.i32(row).unwrap_or(0),
            ammo: self.ammo.i32(row),
            helmet: self.helmet.bool(row).unwrap_or(false),
            kit: self.kit.bool(row).unwrap_or(false),
            zoom: self.zoom.i32(row).unwrap_or(0),
            inventory: self.inventory.strs(row),
        })
    }

    /// The player's last non-empty crosshair share code in the demo.
    pub fn crosshair(&self, steamid: u64) -> Option<&'a str> {
        let rows = self.by_player.get(&steamid)?;
        rows.iter()
            .rev()
            .find_map(|&(_, row)| self.crosshair.str(row).filter(|c| !c.is_empty()))
    }

    /// The player's rank as the match started: the first row whose rank type is set (the
    /// scoreboard's pre-match state; later rows can drop back to 0), all six values from that
    /// row. A player the demo never ranks (a tournament server ranks nobody) gets their first
    /// row's, type 0; `None` only when the rows carry no rank type at all (a demo or a table
    /// without the rank props).
    pub fn rank(&self, steamid: u64) -> Option<PlayerRank> {
        let rows = self.by_player.get(&steamid)?;
        let at = |row: usize| {
            let kind = self.rank_kind.i32(row)?;
            let v = |c: &Column| c.i32(row).unwrap_or(0);
            Some(PlayerRank {
                kind: u8::try_from(kind).unwrap_or(0),
                value: v(&self.rank),
                wins: v(&self.rank_wins),
                if_win: v(&self.rank_if_win),
                if_loss: v(&self.rank_if_loss),
                if_tie: v(&self.rank_if_tie),
            })
        };
        rows.iter()
            .find_map(|&(_, row)| at(row).filter(|r| r.kind != 0))
            .or_else(|| rows.iter().find_map(|&(_, row)| at(row)))
    }

    /// The latest tick of any row, or `None` for an empty table.
    pub fn last_tick(&self) -> Option<i32> {
        self.by_player
            .values()
            .filter_map(|rows| rows.last())
            .map(|&(t, _)| t)
            .max()
    }
}

#[cfg(test)]
pub(super) mod test_table {
    use super::*;

    /// Columns for a synthetic tick table: `(steamid, tick, x)` rows, everyone alive on team 2
    /// holding a knife.
    pub fn columns(rows: &[(u64, i32, f32)]) -> AHashMap<&'static str, VarVec> {
        let n = rows.len();
        let mut m = AHashMap::default();
        m.insert(
            "steamid",
            VarVec::U64(rows.iter().map(|r| Some(r.0)).collect()),
        );
        m.insert(
            "tick",
            VarVec::I32(rows.iter().map(|r| Some(r.1)).collect()),
        );
        m.insert("X", VarVec::F32(rows.iter().map(|r| Some(r.2)).collect()));
        m.insert("Y", VarVec::F32(vec![Some(0.0); n]));
        m.insert("Z", VarVec::F32(vec![Some(0.0); n]));
        m.insert("team_num", VarVec::U32(vec![Some(2); n]));
        m.insert("health", VarVec::I32(vec![Some(100); n]));
        m.insert("is_alive", VarVec::Bool(vec![Some(true); n]));
        m.insert(
            "active_weapon_name",
            VarVec::String(vec![Some("knife".to_string()); n]),
        );
        m
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_at_takes_latest_row_and_respects_window_and_age() {
        let cols = test_table::columns(&[(7, 10, 1.0), (7, 11, 2.0), (7, 11, 3.0), (7, 20, 4.0)]);
        let t = TickTable::new(|n| cols.get(n));
        // Latest row at or before the tick; of two rows at one tick, the later one.
        assert_eq!(t.state_at(7, 0, 12, 32).unwrap().x, 3.0);
        assert_eq!(t.state_at(7, 0, 20, 32).unwrap().x, 4.0);
        // Before the first row, before the window, or too old: no data.
        assert!(t.state_at(7, 0, 9, 32).is_none());
        assert!(t.state_at(7, 12, 15, 32).is_none());
        assert!(t.state_at(7, 0, 53, 32).is_none());
        assert_eq!(t.state_at(7, 0, 52, 32).unwrap().tick, 20);
        assert!(t.state_at(8, 0, 12, 32).is_none());
    }

    /// The first row with a rank type is the rank; a player the demo never ranks (a tournament
    /// server's) has type 0, and only a table without the rank props has none.
    #[test]
    fn the_rank_is_the_first_ranked_row_and_type_0_when_none_is() {
        let mut cols =
            test_table::columns(&[(7, 10, 1.0), (7, 11, 1.0), (7, 12, 1.0), (8, 10, 1.0)]);
        let col = |v: [i32; 4]| VarVec::I32(v.iter().map(|&x| Some(x)).collect());
        cols.insert("comp_rank_type", col([0, 12, 0, 0]));
        cols.insert("rank", col([0, 9, 0, 0]));
        cols.insert("comp_wins", col([0, 31, 0, 0]));
        cols.insert("rank_if_win", col([0, 10, 0, 0]));
        cols.insert("rank_if_loss", col([0, 8, 0, 0]));
        cols.insert("rank_if_tie", col([0, 9, 0, 0]));
        let t = TickTable::new(|n| cols.get(n));
        let r = t.rank(7).unwrap();
        assert_eq!(
            (r.kind, r.value, r.wins, r.if_win, r.if_loss, r.if_tie),
            (12, 9, 31, 10, 8, 9)
        );
        assert_eq!(t.rank(8).map(|r| (r.kind, r.value)), Some((0, 0)));
        assert!(t.rank(9).is_none());
        let bare = test_table::columns(&[(7, 10, 1.0)]);
        assert!(TickTable::new(|n| bare.get(n)).rank(7).is_none());
    }

    #[test]
    fn rows_without_position_or_steamid_are_no_data() {
        let mut cols = test_table::columns(&[(7, 10, 1.0), (0, 10, 1.0), (7, 11, 2.0)]);
        cols.insert("X", VarVec::F32(vec![Some(1.0), Some(1.0), None]));
        let t = TickTable::new(|n| cols.get(n));
        assert_eq!(t.state_at(7, 0, 11, 32).unwrap().tick, 10);
        assert!(t.state_at(0, 0, 11, 32).is_none());
    }
}
