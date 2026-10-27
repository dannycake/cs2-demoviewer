//! Per-round player tracks sampled from the tick table.

use ahash::AHashMap;
use demoviewer_pack::{
    flags, gear, quant, sample_tick, InventoryChange, MatchHeader, PlayerTrack, RoundTracks,
};

use super::events::{blind_at, carrier_at};
use super::props::TickTable;

/// Player state that comes from events rather than the tick table.
pub(super) struct EventState<'a> {
    /// The round's bomb carrier changes, from `events::bomb_carrier`.
    pub carrier: &'a [(i32, Option<usize>)],
    /// Per player (header order), when they are blind, from `events::blind_ranges`.
    pub blind: &'a [Vec<(i32, i32)>],
}

/// `header.weapons`, built on first sight; index 0 is `"none"`.
pub(super) struct Weapons {
    names: Vec<String>,
    index: AHashMap<String, u8>,
}

impl Weapons {
    pub fn new() -> Self {
        Weapons {
            names: vec!["none".to_string()],
            index: [("none".to_string(), 0)].into_iter().collect(),
        }
    }

    /// The index of `name`, adding it if new. No weapon, or a 257th distinct name, is 0.
    pub fn index(&mut self, name: Option<&str>) -> u8 {
        let Some(name) = name.filter(|n| !n.is_empty()) else {
            return 0;
        };
        if let Some(&i) = self.index.get(name) {
            return i;
        }
        let Ok(i) = u8::try_from(self.names.len()) else {
            return 0;
        };
        self.names.push(name.to_string());
        self.index.insert(name.to_string(), i);
        i
    }

    pub fn into_names(self) -> Vec<String> {
        self.names
    }
}

/// Every player's track for round `r` of `header`; `steamids` is in `header.players` order.
/// Sample k is the player's state at `sample_tick(round, header, k)`. A sample without data
/// (not connected, no pawn, or no row in the round within `max_age` ticks) is all zeros, so
/// not alive; every track has exactly `round.samples` entries either way. A dead player's
/// flags are all clear (the pawn keeps stale scoped/walking state). FLASHED and HAS_BOMB come
/// from `events`. Money, the magazine and gear (helmet, kit, zoom) are sampled alongside;
/// each player's inventory goes to `inventory` at the first sample that has it and whenever it
/// changes.
#[allow(clippy::too_many_arguments)]
pub(super) fn round_tracks(
    table: &TickTable,
    steamids: &[u64],
    header: &MatchHeader,
    r: usize,
    max_age: i32,
    events: &EventState,
    weapons: &mut Weapons,
    inventory: &mut Vec<InventoryChange>,
) -> RoundTracks {
    let round = &header.rounds[r];
    let n = round.samples as usize;
    let mut players = Vec::with_capacity(steamids.len());
    for (p, &steamid) in steamids.iter().enumerate() {
        let mut t = PlayerTrack {
            x: Vec::with_capacity(n),
            y: Vec::with_capacity(n),
            z: Vec::with_capacity(n),
            yaw: Vec::with_capacity(n),
            pitch: Vec::with_capacity(n),
            health: Vec::with_capacity(n),
            armor: Vec::with_capacity(n),
            flags: Vec::with_capacity(n),
            duck: Vec::with_capacity(n),
            weapon: Vec::with_capacity(n),
            money: Vec::with_capacity(n),
            ammo: Vec::with_capacity(n),
            gear: Vec::with_capacity(n),
        };
        let mut items: Option<Vec<u8>> = None;
        for k in 0..round.samples {
            let tick = sample_tick(round, header, k);
            let Some(s) = table.state_at(steamid, round.start_tick, tick, max_age) else {
                for col in [&mut t.x, &mut t.y, &mut t.z, &mut t.yaw, &mut t.pitch] {
                    col.push(0);
                }
                for col in [
                    &mut t.health,
                    &mut t.armor,
                    &mut t.flags,
                    &mut t.duck,
                    &mut t.weapon,
                ] {
                    col.push(0);
                }
                t.money.push(0);
                t.ammo.push(gear::AMMO_NONE);
                t.gear.push(0);
                continue;
            };
            let mut f = 0;
            if s.alive {
                for (on, bit) in [
                    (true, flags::ALIVE),
                    (s.scoped, flags::SCOPED),
                    (
                        events.blind.get(p).is_some_and(|b| blind_at(b, tick)),
                        flags::FLASHED,
                    ),
                    (carrier_at(events.carrier, tick) == Some(p), flags::HAS_BOMB),
                    (s.defusing, flags::DEFUSING),
                    (s.airborne, flags::AIRBORNE),
                    (s.walking, flags::WALKING),
                ] {
                    if on {
                        f |= bit;
                    }
                }
            }
            t.x.push(quant::position(s.x));
            t.y.push(quant::position(s.y));
            t.z.push(quant::position(s.z));
            t.yaw.push(quant::angle(s.yaw));
            t.pitch.push(quant::angle(s.pitch));
            t.health.push(s.health.clamp(0, 255) as u8);
            t.armor.push(s.armor.clamp(0, 255) as u8);
            t.flags.push(f);
            t.duck.push(quant::duck(s.duck));
            t.weapon.push(weapons.index(s.weapon));
            t.money.push(s.money.clamp(0, u16::MAX as i32) as u16);
            t.ammo.push(match s.ammo {
                Some(a) if s.alive && a >= 0 => a.min(254) as u8,
                _ => gear::AMMO_NONE,
            });
            t.gear.push(if s.alive {
                gear::pack(s.helmet, s.kit, s.zoom.clamp(0, 3) as u8)
            } else {
                0
            });
            if let Some(names) = s.inventory {
                let now: Vec<u8> = names.iter().map(|n| weapons.index(Some(n))).collect();
                if items.as_ref() != Some(&now) {
                    inventory.push(InventoryChange {
                        round: r as u16,
                        player: p as u8,
                        tick,
                        items: now.clone(),
                    });
                    items = Some(now);
                }
            }
        }
        players.push(t);
    }
    RoundTracks { players }
}

#[cfg(test)]
mod tests {
    use super::super::props::test_table;
    use super::*;
    use demoviewer_pack::{RoundInfo, PACK_VERSION};
    use parser::second_pass::variants::VarVec;

    fn header(start: i32, end: i32, step: u32) -> MatchHeader {
        MatchHeader {
            version: PACK_VERSION,
            map: String::new(),
            server_name: String::new(),
            game_build: String::new(),
            tick_rate: 64,
            sample_hz: 32,
            tick_step: step,
            players: vec![],
            rounds: vec![RoundInfo {
                number: 1,
                start_tick: start,
                freeze_end_tick: start,
                end_tick: end,
                winner: 0,
                reason: String::new(),
                score_t: 0,
                score_ct: 0,
                samples: ((end - start) / step as i32 + 1) as u32,
                post_end_tick: None,
            }],
            weapons: vec![],
        }
    }

    #[test]
    fn disconnected_and_absent_players_keep_full_length_tracks() {
        // Player 1 is there all round, player 2 disconnects at tick 150, player 3 never appears.
        let mut rows: Vec<(u64, i32, f32)> = (90..=200).map(|t| (1, t, t as f32)).collect();
        rows.extend((90..=150).map(|t| (2, t, -(t as f32))));
        let cols = test_table::columns(&rows);
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 200, 2);
        let mut weapons = Weapons::new();
        let carrier = [(120, Some(0)), (130, None)];
        let events = EventState {
            carrier: &carrier,
            blind: &[],
        };
        let rt = round_tracks(
            &table,
            &[1, 2, 3],
            &h,
            0,
            32,
            &events,
            &mut weapons,
            &mut Vec::new(),
        );

        assert_eq!(h.rounds[0].samples, 51);
        for t in &rt.players {
            for len in [
                t.x.len(),
                t.yaw.len(),
                t.health.len(),
                t.flags.len(),
                t.weapon.len(),
            ] {
                assert_eq!(len, 51);
            }
        }
        let (p1, p2, p3) = (&rt.players[0], &rt.players[1], &rt.players[2]);
        assert!(p1.flags.iter().all(|f| f & flags::ALIVE != 0));
        assert_eq!((p1.x[0], p1.x[50]), (100, 200));
        // Bomb from tick 120 (sample 10) until tick 130 (sample 15).
        let bomb: Vec<usize> = (0..51)
            .filter(|&k| p1.flags[k] & flags::HAS_BOMB != 0)
            .collect();
        assert_eq!(bomb, (10..15).collect::<Vec<_>>());
        // Player 2: data up to tick 150 + 32 = sample 41, then nothing.
        assert!(p2.flags[..=41].iter().all(|f| f & flags::ALIVE != 0));
        assert_eq!(p2.x[41], -150);
        assert!(p2.flags[42..].iter().all(|&f| f == 0));
        assert!(p2.x[42..].iter().all(|&x| x == 0));
        assert!(p3.flags.iter().all(|&f| f == 0));
        assert!(p3.weapon.iter().all(|&w| w == 0));
        assert_eq!(weapons.into_names(), ["none", "knife"]);
        assert_eq!(p1.weapon[0], 1);
    }

    #[test]
    fn dead_players_have_no_flags_but_keep_their_position() {
        let mut cols = test_table::columns(&[(1, 100, 7.0), (1, 102, 8.0)]);
        cols.insert("is_alive", VarVec::Bool(vec![Some(true), Some(false)]));
        cols.insert("is_scoped", VarVec::Bool(vec![Some(true), Some(true)]));
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 102, 2);
        let events = EventState {
            carrier: &[(100, Some(0))],
            blind: &[vec![(90, 200)]],
        };
        let rt = round_tracks(
            &table,
            &[1],
            &h,
            0,
            32,
            &events,
            &mut Weapons::new(),
            &mut Vec::new(),
        );
        assert_eq!(
            rt.players[0].flags,
            [
                flags::ALIVE | flags::SCOPED | flags::FLASHED | flags::HAS_BOMB,
                0
            ]
        );
        assert_eq!(rt.players[0].x, [7, 8]);
    }

    #[test]
    fn flashed_only_while_blind() {
        let cols = test_table::columns(&(100..=110).map(|t| (1, t, 0.0)).collect::<Vec<_>>());
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 110, 2);
        let events = EventState {
            carrier: &[],
            blind: &[vec![(101, 105), (108, 109)]],
        };
        let rt = round_tracks(
            &table,
            &[1],
            &h,
            0,
            32,
            &events,
            &mut Weapons::new(),
            &mut Vec::new(),
        );
        let flashed: Vec<bool> = rt.players[0]
            .flags
            .iter()
            .map(|f| f & flags::FLASHED != 0)
            .collect();
        // Sample ticks 100, 102, 104, 106, 108, 110.
        assert_eq!(flashed, [false, true, true, false, true, false]);
    }

    #[test]
    fn rows_before_the_round_are_not_used() {
        let cols = test_table::columns(&[(1, 90, 5.0), (1, 104, 6.0)]);
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 104, 2);
        let events = EventState {
            carrier: &[],
            blind: &[],
        };
        let rt = round_tracks(
            &table,
            &[1],
            &h,
            0,
            32,
            &events,
            &mut Weapons::new(),
            &mut Vec::new(),
        );
        assert_eq!(rt.players[0].x, [0, 0, 6]);
        assert_eq!(rt.players[0].flags, [0, 0, flags::ALIVE]);
    }

    #[test]
    fn money_ammo_gear_and_inventory_are_sampled() {
        // One player, rows every tick from 100 to 106: alive with an AK until 104, then dead.
        let rows: Vec<(u64, i32, f32)> = (100..=106).map(|t| (1, t, t as f32)).collect();
        let mut cols = test_table::columns(&rows);
        let n = rows.len();
        cols.insert(
            "is_alive",
            VarVec::Bool((0..n).map(|i| Some(i < 5)).collect()),
        );
        cols.insert(
            "balance",
            VarVec::I32(
                (0..n)
                    .map(|i| Some(if i == 0 { 70_000 } else { 1650 }))
                    .collect(),
            ),
        );
        cols.insert(
            "active_weapon_ammo",
            VarVec::I32(
                (0..n)
                    .map(|i| {
                        Some(match i {
                            0 => -1,
                            1 => 300,
                            _ => 30 - i as i32,
                        })
                    })
                    .collect(),
            ),
        );
        cols.insert("has_helmet", VarVec::Bool(vec![Some(true); n]));
        cols.insert(
            "has_defuser",
            VarVec::Bool((0..n).map(|i| Some(i >= 2)).collect()),
        );
        cols.insert(
            "zoom_lvl",
            VarVec::U32((0..n).map(|i| Some(if i == 3 { 2 } else { 0 })).collect()),
        );
        let inv = |names: &[&str]| names.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        cols.insert(
            "inventory",
            VarVec::StringVec(
                (0..n)
                    .map(|i| {
                        if i < 3 {
                            inv(&["knife_t", "Glock-18"])
                        } else {
                            inv(&["knife_t", "Glock-18", "AK-47"])
                        }
                    })
                    .collect(),
            ),
        );
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 106, 2);
        let events = EventState {
            carrier: &[],
            blind: &[],
        };
        let mut weapons = Weapons::new();
        let mut inventory = Vec::new();
        let rt = round_tracks(
            &table,
            &[1, 2],
            &h,
            0,
            32,
            &events,
            &mut weapons,
            &mut inventory,
        );
        let t = &rt.players[0];
        // Samples at ticks 100, 102, 104, 106.
        assert_eq!(t.money, [u16::MAX, 1650, 1650, 1650]);
        assert_eq!(t.ammo, [gear::AMMO_NONE, 28, 26, gear::AMMO_NONE]);
        assert_eq!(t.gear[0], gear::HELMET);
        assert_eq!(t.gear[1], gear::HELMET | gear::DEFUSE_KIT);
        assert_eq!(t.gear[3], 0, "a dead player has no gear");
        // Player 2 has no rows: zero money, no magazine, no gear.
        assert_eq!(rt.players[1].money, [0; 4]);
        assert_eq!(rt.players[1].ammo, [gear::AMMO_NONE; 4]);
        let names = weapons.into_names();
        let items = |c: &InventoryChange| {
            c.items
                .iter()
                .map(|&i| names[i as usize].clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(inventory.len(), 2);
        assert_eq!(
            (inventory[0].tick, items(&inventory[0])),
            (100, inv(&["knife_t", "Glock-18"]))
        );
        assert_eq!(
            (inventory[1].tick, items(&inventory[1])),
            (104, inv(&["knife_t", "Glock-18", "AK-47"]))
        );
        assert!(inventory.iter().all(|c| c.round == 0 && c.player == 0));
    }

    #[test]
    fn zoom_lands_in_the_gear_bits() {
        let rows: Vec<(u64, i32, f32)> = vec![(1, 100, 0.0), (1, 102, 0.0)];
        let mut cols = test_table::columns(&rows);
        cols.insert("zoom_lvl", VarVec::U32(vec![Some(1), Some(2)]));
        let table = TickTable::new(|n| cols.get(n));
        let h = header(100, 102, 2);
        let events = EventState {
            carrier: &[],
            blind: &[],
        };
        let rt = round_tracks(
            &table,
            &[1],
            &h,
            0,
            32,
            &events,
            &mut Weapons::new(),
            &mut Vec::new(),
        );
        let zoom: Vec<u8> = rt.players[0]
            .gear
            .iter()
            .map(|g| (g & gear::ZOOM_MASK) >> gear::ZOOM_SHIFT)
            .collect();
        assert_eq!(zoom, [1, 2]);
    }
}
