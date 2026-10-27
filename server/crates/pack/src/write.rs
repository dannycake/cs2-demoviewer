use std::io::{self, Write};

use flate2::{write::GzEncoder, Compression};

use crate::format::{
    GrenadeMeta, GroundRun, MapEntitiesRef, ENT1, EVT1, GNB1, GND1, GRB1, GRENADE_SAMPLE_BYTES,
    GRN1, GROUND_KEY_BYTES, HDR1, INV1, MAGIC, TRACK2_SAMPLE_BYTES, TRACK_SAMPLE_BYTES, TRK1, TRK2,
};
use crate::types::{validate, GroundItem, Match, PACK_VERSION};

/// Largest a pack may be once inflated: 256 MiB, what the web viewer agrees to hold
/// (`MAX_PACK_BYTES` in `web/src/pack/fetch.ts`). A full match comes to under 20 MiB.
pub const MAX_PACK_BYTES: u64 = 256 * 1024 * 1024;

/// Writes `m` as a gzip'd DVPK pack. Refuses (`InvalidInput`) a `Match` that violates the
/// format's invariants, so nothing is written that `read` would reject, and one whose pack
/// would inflate to more than [`MAX_PACK_BYTES`] (`FileTooLarge`, after writing part of it).
pub fn write(m: &Match, w: &mut dyn Write) -> io::Result<()> {
    write_limited(m, w, MAX_PACK_BYTES)
}

/// [`write`] with another limit on the inflated size.
pub fn write_limited(m: &Match, w: &mut dyn Write, max_bytes: u64) -> io::Result<()> {
    validate(m).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))?;

    let mut gz = Capped {
        inner: GzEncoder::new(w, Compression::default()),
        left: max_bytes,
    };
    gz.write_all(&MAGIC)?;
    gz.write_all(&PACK_VERSION.to_le_bytes())?;
    section(&mut gz, HDR1, &serde_json::to_vec(&m.header)?)?;
    section(&mut gz, TRK1, &tracks(m))?;
    section(&mut gz, EVT1, &serde_json::to_vec(&m.events)?)?;
    let metas: Vec<GrenadeMeta> = m.grenades.iter().map(GrenadeMeta::from).collect();
    section(&mut gz, GRN1, &serde_json::to_vec(&metas)?)?;
    section(&mut gz, GRB1, &grenade_samples(m))?;
    // Optional sections last: a reader that predates them skips them.
    if m.rounds
        .iter()
        .flat_map(|r| &r.players)
        .any(|t| !t.money.is_empty())
    {
        section(&mut gz, TRK2, &tracks2(m))?;
    }
    if !m.inventory.is_empty() {
        section(&mut gz, INV1, &serde_json::to_vec(&m.inventory)?)?;
    }
    if !m.map_entities.is_empty() {
        let ent = MapEntitiesRef {
            entities: &m.map_entities,
            changes: &m.map_changes,
        };
        section(&mut gz, ENT1, &serde_json::to_vec(&ent)?)?;
    }
    if !m.ground.is_empty() {
        let runs: Vec<&[GroundItem]> = m
            .ground
            .chunk_by(|a, b| (a.round, a.id, a.weapon) == (b.round, b.id, b.weapon))
            .collect();
        let metas: Vec<GroundRun> = runs
            .iter()
            .map(|r| GroundRun {
                round: r[0].round,
                id: r[0].id,
                weapon: r[0].weapon,
                keys: r.len() as u32,
            })
            .collect();
        section(&mut gz, GND1, &serde_json::to_vec(&metas)?)?;
        section(&mut gz, GNB1, &ground_keys(m.ground.len(), &runs))?;
    }
    gz.inner.finish()?.flush()
}

/// Passes bytes on until `left` runs out, then fails every write.
struct Capped<W> {
    inner: W,
    left: u64,
}

impl<W: Write> Write for Capped<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.len() as u64 > self.left {
            return Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "the replay would be too large to open",
            ));
        }
        let n = self.inner.write(buf)?;
        self.left -= n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn section(w: &mut impl Write, tag: [u8; 4], payload: &[u8]) -> io::Result<()> {
    w.write_all(&tag)?;
    w.write_all(&(payload.len() as u64).to_le_bytes())?;
    w.write_all(payload)
}

fn put_i16s(buf: &mut Vec<u8>, values: &[i16]) {
    buf.extend(values.iter().flat_map(|v| v.to_le_bytes()));
}

fn tracks(m: &Match) -> Vec<u8> {
    let players = m.header.players.len() as u64;
    let len: u64 = m
        .header
        .rounds
        .iter()
        .map(|r| players * r.samples as u64 * TRACK_SAMPLE_BYTES)
        .sum();
    let mut buf = Vec::with_capacity(len as usize);
    for round in &m.rounds {
        for t in &round.players {
            for col in [&t.x, &t.y, &t.z, &t.yaw, &t.pitch] {
                put_i16s(&mut buf, col);
            }
            for col in [&t.health, &t.armor, &t.flags, &t.duck, &t.weapon] {
                buf.extend_from_slice(col);
            }
        }
    }
    buf
}

fn tracks2(m: &Match) -> Vec<u8> {
    let players = m.header.players.len() as u64;
    let len: u64 = m
        .header
        .rounds
        .iter()
        .map(|r| players * r.samples as u64 * TRACK2_SAMPLE_BYTES)
        .sum();
    let mut buf = Vec::with_capacity(len as usize);
    for round in &m.rounds {
        for t in &round.players {
            buf.extend(t.money.iter().flat_map(|v| v.to_le_bytes()));
            buf.extend_from_slice(&t.ammo);
            buf.extend_from_slice(&t.gear);
        }
    }
    buf
}

fn grenade_samples(m: &Match) -> Vec<u8> {
    let len: u64 = m
        .grenades
        .iter()
        .map(|g| g.x.len() as u64 * GRENADE_SAMPLE_BYTES)
        .sum();
    let mut buf = Vec::with_capacity(len as usize);
    for g in &m.grenades {
        for col in [&g.x, &g.y, &g.z] {
            put_i16s(&mut buf, col);
        }
    }
    buf
}

/// `GNB1`: each column over every key, run after run; within a run, the first value as is
/// and each next one as its wrapping difference from the key before.
fn ground_keys(keys: usize, runs: &[&[GroundItem]]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(keys * GROUND_KEY_BYTES as usize);
    for run in runs {
        let mut prev = 0i32;
        for g in *run {
            buf.extend(g.tick.wrapping_sub(prev).to_le_bytes());
            prev = g.tick;
        }
    }
    for col in [
        |g: &GroundItem| g.x,
        |g: &GroundItem| g.y,
        |g: &GroundItem| g.z,
        |g: &GroundItem| g.pitch,
        |g: &GroundItem| g.yaw,
        |g: &GroundItem| g.roll,
    ] {
        for run in runs {
            let mut prev = 0i16;
            for g in *run {
                buf.extend(col(g).wrapping_sub(prev).to_le_bytes());
                prev = col(g);
            }
        }
    }
    for run in runs {
        buf.extend(run.iter().map(|g| g.gone as u8));
    }
    buf
}
