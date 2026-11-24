//! Every demo's original, kept zstd-compressed in `originals/<sha256>.dem.zst` beside its pack:
//! the pack holds only what the viewer draws today, and a later re-parse (new stats, a pack
//! format change) needs the demo. Written before the parse, so a demo the parser fails on is
//! kept too. One file per sha, however many demo ids share it.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::Path;

use crate::store;

/// The zstd level: about 2.3× on a demo at a few seconds a demo on one core.
pub const ORIGINAL_ZSTD_LEVEL: i32 = 10;

/// Compresses the raw demo `dem` into `tmp` and renames it onto `dest` durably
/// ([`store::replace_file`]); returns the bytes written, or 0 when `dest` already exists.
pub fn keep_original(dem: &Path, tmp: &Path, dest: &Path) -> io::Result<u64> {
    if dest.is_file() {
        return Ok(0);
    }
    let written = (|| {
        let mut input = BufReader::new(File::open(dem)?);
        let out = BufWriter::new(File::create(tmp)?);
        let mut enc = zstd::Encoder::new(out, ORIGINAL_ZSTD_LEVEL)?;
        io::copy(&mut input, &mut enc)?;
        enc.finish()?.flush()?;
        let bytes = fs::metadata(tmp)?.len();
        store::replace_file(tmp, dest)?;
        Ok(bytes)
    })();
    if written.is_err() {
        let _ = fs::remove_file(tmp);
    }
    written
}

/// Inflates the kept original `src` into `dest`, at most `room` bytes: past that the partial
/// file is removed and the error is [`io::ErrorKind::StorageFull`].
pub fn restore_original(src: &Path, dest: &Path, room: u64) -> io::Result<()> {
    let restored = (|| {
        let dec = zstd::Decoder::new(File::open(src)?)?;
        let mut out = BufWriter::new(File::create(dest)?);
        let copied = io::copy(&mut dec.take(room.saturating_add(1)), &mut out)?;
        out.flush()?;
        if copied > room {
            return Err(io::Error::new(
                io::ErrorKind::StorageFull,
                "the original is larger than the room left",
            ));
        }
        Ok(())
    })();
    if restored.is_err() {
        let _ = fs::remove_file(dest);
    }
    restored
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo(len: usize) -> Vec<u8> {
        // Varied bytes, so the round trip is not of a run of zeros.
        (0..len).map(|i| (i * 7 + i / 13) as u8).collect()
    }

    #[test]
    fn an_original_round_trips_byte_for_byte() {
        let dir = tempfile::tempdir().unwrap();
        let (dem, tmp, kept, back) = (
            dir.path().join("a.dem"),
            dir.path().join("a.zst.tmp"),
            dir.path().join("a.dem.zst"),
            dir.path().join("b.dem"),
        );
        let bytes = demo(300_000);
        fs::write(&dem, &bytes).unwrap();
        let written = keep_original(&dem, &tmp, &kept).unwrap();
        assert_eq!(written, fs::metadata(&kept).unwrap().len());
        assert!(written > 0 && !tmp.exists());
        restore_original(&kept, &back, u64::MAX).unwrap();
        assert_eq!(fs::read(&back).unwrap(), bytes);
    }

    #[test]
    fn keeping_an_original_twice_writes_it_once() {
        let dir = tempfile::tempdir().unwrap();
        let (dem, tmp, kept) = (
            dir.path().join("a.dem"),
            dir.path().join("t"),
            dir.path().join("a.dem.zst"),
        );
        fs::write(&dem, demo(10_000)).unwrap();
        assert!(keep_original(&dem, &tmp, &kept).unwrap() > 0);
        let first = fs::metadata(&kept).unwrap().modified().unwrap();
        assert_eq!(keep_original(&dem, &tmp, &kept).unwrap(), 0);
        assert_eq!(fs::metadata(&kept).unwrap().modified().unwrap(), first);
    }

    #[test]
    fn restoring_stops_at_the_room_given() {
        let dir = tempfile::tempdir().unwrap();
        let (dem, tmp, kept, back) = (
            dir.path().join("a.dem"),
            dir.path().join("t"),
            dir.path().join("a.dem.zst"),
            dir.path().join("b.dem"),
        );
        fs::write(&dem, demo(100_000)).unwrap();
        keep_original(&dem, &tmp, &kept).unwrap();
        let err = restore_original(&kept, &back, 50_000).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::StorageFull);
        assert!(!back.exists(), "a partial restore is removed");
    }
}
