use std::io::{self, ErrorKind, Read};

use flate2::read::GzDecoder;
use serde::de::DeserializeOwned;

use crate::format::{
    GrenadeMeta, GroundRun, MapEntities, ENT1, EVT1, GNB1, GND1, GRB1, GRENADE_SAMPLE_BYTES, GRN1,
    GROUND_KEY_BYTES, HDR1, INV1, MAGIC, TRACK2_SAMPLE_BYTES, TRACK_SAMPLE_BYTES, TRK1, TRK2,
};
use crate::types::{
    validate, Event, GrenadeTrack, GroundItem, InventoryChange, Match, MatchHeader, PlayerTrack,
    RoundTracks, PACK_VERSION,
};

/// Reads a gzip'd DVPK pack. Malformed input yields `InvalidData` (or `UnexpectedEof` when
/// truncated), never a panic. Unknown section tags are skipped.
pub fn read(r: &mut dyn Read) -> io::Result<Match> {
    let mut gz = GzDecoder::new(r);

    let mut preamble = [0u8; 6];
    gz.read_exact(&mut preamble)?;
    if preamble[..4] != MAGIC {
        return Err(invalid("not a DVPK pack (bad magic)"));
    }
    let version = u16::from_le_bytes([preamble[4], preamble[5]]);
    if version != PACK_VERSION {
        return Err(invalid(format!(
            "unsupported pack version {version}, expected {PACK_VERSION}"
        )));
    }

    let mut header: Option<MatchHeader> = None;
    let mut rounds: Option<Vec<RoundTracks>> = None;
    let mut events: Option<Vec<Event>> = None;
    let mut metas: Option<Vec<GrenadeMeta>> = None;
    let mut grenades: Option<Vec<GrenadeTrack>> = None;
    let mut extra: Option<()> = None;
    let mut inventory: Option<Vec<InventoryChange>> = None;
    let mut map_entities: Option<MapEntities> = None;
    let mut ground_runs: Option<Vec<GroundRun>> = None;
    let mut ground: Option<Vec<GroundItem>> = None;

    while let Some((tag, len)) = next_section(&mut gz)? {
        match tag {
            HDR1 => set_once(&mut header, tag, || json(&payload(&mut gz, tag, len)?))?,
            TRK1 => {
                let h = header
                    .as_ref()
                    .ok_or_else(|| invalid("TRK1 section before HDR1"))?;
                set_once(&mut rounds, tag, || {
                    decode_tracks(h, &payload(&mut gz, tag, len)?)
                })?
            }
            EVT1 => set_once(&mut events, tag, || json(&payload(&mut gz, tag, len)?))?,
            GRN1 => set_once(&mut metas, tag, || json(&payload(&mut gz, tag, len)?))?,
            GRB1 => {
                let ms = metas
                    .as_deref()
                    .ok_or_else(|| invalid("GRB1 section before GRN1"))?;
                set_once(&mut grenades, tag, || {
                    decode_grenades(ms, &payload(&mut gz, tag, len)?)
                })?
            }
            TRK2 => {
                let h = header
                    .as_ref()
                    .ok_or_else(|| invalid("TRK2 section before HDR1"))?;
                let rs = rounds
                    .as_mut()
                    .ok_or_else(|| invalid("TRK2 section before TRK1"))?;
                let bytes = payload(&mut gz, tag, len)?;
                set_once(&mut extra, tag, || decode_tracks2(h, rs, &bytes))?
            }
            INV1 => set_once(&mut inventory, tag, || json(&payload(&mut gz, tag, len)?))?,
            ENT1 => set_once(&mut map_entities, tag, || {
                json(&payload(&mut gz, tag, len)?)
            })?,
            GND1 => set_once(&mut ground_runs, tag, || json(&payload(&mut gz, tag, len)?))?,
            GNB1 => {
                let runs = ground_runs
                    .as_deref()
                    .ok_or_else(|| invalid("GNB1 section before GND1"))?;
                set_once(&mut ground, tag, || {
                    decode_ground(runs, &payload(&mut gz, tag, len)?)
                })?
            }
            _ => skip(&mut gz, tag, len)?,
        }
    }

    let missing = |name: &str| invalid(format!("missing {name} section"));
    let map_entities = map_entities.unwrap_or_default();
    if ground_runs.is_some() && ground.is_none() {
        return Err(missing("GNB1"));
    }
    let m = Match {
        header: header.ok_or_else(|| missing("HDR1"))?,
        rounds: rounds.ok_or_else(|| missing("TRK1"))?,
        events: events.ok_or_else(|| missing("EVT1"))?,
        grenades: grenades.ok_or_else(|| missing(if metas.is_some() { "GRB1" } else { "GRN1" }))?,
        inventory: inventory.unwrap_or_default(),
        map_entities: map_entities.entities,
        map_changes: map_entities.changes,
        ground: ground.unwrap_or_default(),
    };
    validate(&m).map_err(invalid)?;
    Ok(m)
}

fn invalid(msg: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg)
}

fn tag_name(tag: [u8; 4]) -> String {
    tag.escape_ascii().to_string()
}

/// Reads the next section's tag and length; `None` at a clean end of stream.
fn next_section(r: &mut impl Read) -> io::Result<Option<([u8; 4], u64)>> {
    let mut tag = [0u8; 4];
    let mut got = 0;
    while got < tag.len() {
        match r.read(&mut tag[got..]) {
            Ok(0) => break,
            Ok(n) => got += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    match got {
        0 => Ok(None),
        4 => {
            let mut len = [0u8; 8];
            r.read_exact(&mut len)?;
            Ok(Some((tag, u64::from_le_bytes(len))))
        }
        _ => Err(io::Error::new(
            ErrorKind::UnexpectedEof,
            "truncated section tag",
        )),
    }
}

fn truncated(tag: [u8; 4], got: u64, len: u64) -> io::Error {
    io::Error::new(
        ErrorKind::UnexpectedEof,
        format!("section {} truncated: {got} of {len} bytes", tag_name(tag)),
    )
}

fn payload(r: &mut impl Read, tag: [u8; 4], len: u64) -> io::Result<Vec<u8>> {
    // Capacity is capped: `len` is untrusted until the bytes have actually arrived.
    let mut buf = Vec::with_capacity(len.min(1 << 24) as usize);
    r.take(len).read_to_end(&mut buf)?;
    if buf.len() as u64 != len {
        return Err(truncated(tag, buf.len() as u64, len));
    }
    Ok(buf)
}

fn skip(r: &mut impl Read, tag: [u8; 4], len: u64) -> io::Result<()> {
    let got = io::copy(&mut r.take(len), &mut io::sink())?;
    if got != len {
        return Err(truncated(tag, got, len));
    }
    Ok(())
}

fn set_once<T>(
    slot: &mut Option<T>,
    tag: [u8; 4],
    decode: impl FnOnce() -> io::Result<T>,
) -> io::Result<()> {
    if slot.is_some() {
        return Err(invalid(format!("duplicate {} section", tag_name(tag))));
    }
    *slot = Some(decode()?);
    Ok(())
}

fn json<T: DeserializeOwned>(bytes: &[u8]) -> io::Result<T> {
    serde_json::from_slice(bytes).map_err(invalid)
}

/// Sequential reader over a payload whose total length has already been checked.
struct Columns<'a> {
    buf: &'a [u8],
}

impl Columns<'_> {
    fn i16s(&mut self, n: usize) -> Vec<i16> {
        let (col, rest) = self.buf.split_at(n * 2);
        self.buf = rest;
        col.as_chunks::<2>()
            .0
            .iter()
            .map(|&c| i16::from_le_bytes(c))
            .collect()
    }

    fn u16s(&mut self, n: usize) -> Vec<u16> {
        let (col, rest) = self.buf.split_at(n * 2);
        self.buf = rest;
        col.as_chunks::<2>()
            .0
            .iter()
            .map(|&c| u16::from_le_bytes(c))
            .collect()
    }

    fn i32s(&mut self, n: usize) -> Vec<i32> {
        let (col, rest) = self.buf.split_at(n * 4);
        self.buf = rest;
        col.as_chunks::<4>()
            .0
            .iter()
            .map(|&c| i32::from_le_bytes(c))
            .collect()
    }

    fn u8s(&mut self, n: usize) -> Vec<u8> {
        let (col, rest) = self.buf.split_at(n);
        self.buf = rest;
        col.to_vec()
    }
}

fn expect_len(tag: [u8; 4], actual: usize, expected: Option<u64>) -> io::Result<()> {
    match expected {
        Some(e) if e == actual as u64 => Ok(()),
        Some(e) => Err(invalid(format!(
            "{} is {actual} bytes, header implies {e}",
            tag_name(tag)
        ))),
        None => Err(invalid(format!("{} size overflows", tag_name(tag)))),
    }
}

fn decode_tracks(h: &MatchHeader, bytes: &[u8]) -> io::Result<Vec<RoundTracks>> {
    let players = h.players.len() as u64;
    let expected = h.rounds.iter().try_fold(0u64, |acc, r| {
        players
            .checked_mul(r.samples as u64)?
            .checked_mul(TRACK_SAMPLE_BYTES)?
            .checked_add(acc)
    });
    expect_len(TRK1, bytes.len(), expected)?;

    let mut c = Columns { buf: bytes };
    let rounds = h
        .rounds
        .iter()
        .map(|r| {
            let n = r.samples as usize;
            let players = (0..h.players.len())
                .map(|_| PlayerTrack {
                    x: c.i16s(n),
                    y: c.i16s(n),
                    z: c.i16s(n),
                    yaw: c.i16s(n),
                    pitch: c.i16s(n),
                    health: c.u8s(n),
                    armor: c.u8s(n),
                    flags: c.u8s(n),
                    duck: c.u8s(n),
                    weapon: c.u8s(n),
                    ..PlayerTrack::default()
                })
                .collect();
            RoundTracks { players }
        })
        .collect();
    Ok(rounds)
}

/// Fills `money`, `ammo` and `gear` of every track from a `TRK2` payload.
fn decode_tracks2(h: &MatchHeader, rounds: &mut [RoundTracks], bytes: &[u8]) -> io::Result<()> {
    let players = h.players.len() as u64;
    let expected = h.rounds.iter().try_fold(0u64, |acc, r| {
        players
            .checked_mul(r.samples as u64)?
            .checked_mul(TRACK2_SAMPLE_BYTES)?
            .checked_add(acc)
    });
    expect_len(TRK2, bytes.len(), expected)?;
    let mut c = Columns { buf: bytes };
    for (info, round) in h.rounds.iter().zip(rounds.iter_mut()) {
        let n = info.samples as usize;
        for t in &mut round.players {
            t.money = c.u16s(n);
            t.ammo = c.u8s(n);
            t.gear = c.u8s(n);
        }
    }
    Ok(())
}

fn decode_grenades(metas: &[GrenadeMeta], bytes: &[u8]) -> io::Result<Vec<GrenadeTrack>> {
    let expected = metas.iter().try_fold(0u64, |acc, g| {
        (g.samples as u64)
            .checked_mul(GRENADE_SAMPLE_BYTES)?
            .checked_add(acc)
    });
    expect_len(GRB1, bytes.len(), expected)?;

    let mut c = Columns { buf: bytes };
    let grenades = metas
        .iter()
        .map(|g| {
            let n = g.samples as usize;
            GrenadeTrack {
                entity_id: g.entity_id,
                kind: g.kind.clone(),
                thrower: g.thrower,
                start_tick: g.start_tick,
                detonate_tick: g.detonate_tick,
                expire_tick: g.expire_tick,
                x: c.i16s(n),
                y: c.i16s(n),
                z: c.i16s(n),
            }
        })
        .collect();
    Ok(grenades)
}

fn decode_ground(runs: &[GroundRun], bytes: &[u8]) -> io::Result<Vec<GroundItem>> {
    let expected = runs.iter().try_fold(0u64, |acc, r| {
        (r.keys as u64)
            .checked_mul(GROUND_KEY_BYTES)?
            .checked_add(acc)
    });
    expect_len(GNB1, bytes.len(), expected)?;

    // Each column holds every key, run after run, a run's values after its first as
    // differences from the one before (see `write::ground_keys`).
    let n = bytes.len() / GROUND_KEY_BYTES as usize;
    let mut c = Columns { buf: bytes };
    let mut tick = c.i32s(n);
    let mut cols = [(); 6].map(|_| c.i16s(n));
    let gone = c.u8s(n);
    if let Some(b) = gone.iter().find(|&&b| b > 1) {
        return Err(invalid(format!("GNB1 gone byte {b}, not 0 or 1")));
    }
    let mut at = 0;
    for r in runs {
        let keys = at..at + r.keys as usize;
        for k in keys.clone().skip(1) {
            tick[k] = tick[k].wrapping_add(tick[k - 1]);
            for col in &mut cols {
                col[k] = col[k].wrapping_add(col[k - 1]);
            }
        }
        at = keys.end;
    }
    let [x, y, z, pitch, yaw, roll] = cols;
    let mut out = Vec::with_capacity(n);
    let mut k = 0;
    for r in runs {
        for _ in 0..r.keys {
            out.push(GroundItem {
                round: r.round,
                id: r.id,
                weapon: r.weapon,
                tick: tick[k],
                x: x[k],
                y: y[k],
                z: z[k],
                pitch: pitch[k],
                yaw: yaw[k],
                roll: roll[k],
                gone: gone[k] == 1,
            });
            k += 1;
        }
    }
    Ok(out)
}
