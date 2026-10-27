//! Turns a fetched or uploaded file into a plain CS2 demo, choosing the decoder by magic bytes
//! rather than by file name: `BZh` is bzip2, `1f 8b` is gzip, anything else is read as is. The
//! result must start with `PBDEMS2\0`, so a CS:GO demo or a stray file fails here, with a
//! message, before it reaches the parser.

use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, ErrorKind, Read, Seek, Write};
use std::path::Path;

use bzip2::read::MultiBzDecoder;
use flate2::read::MultiGzDecoder;

/// Largest demo [`decompress_to_dem_within`] writes: 1 GiB, about twice the 500 MiB upload
/// limit and four times a 237 MB matchmaking demo.
pub const MAX_DEM_BYTES: u64 = 1024 * 1024 * 1024;

/// Most a gzip or bzip2 file may inflate, as a multiple of its own size. CS2 demos shrink only
/// about 1.5 times under either, because their frames are already snappy-compressed, so a
/// file that inflates more than this is a compression bomb, not a demo. It keeps a small
/// upload from making the server write up to [`MAX_DEM_BYTES`].
pub const MAX_INFLATE_RATIO: u64 = 20;

const BUF: usize = 1 << 20;

/// Writes the demo inside `src` (bzip2, gzip or raw) to `dest`, capped at [`MAX_DEM_BYTES`],
/// at [`MAX_INFLATE_RATIO`] times the size of `src` and at `room` bytes, what the disk can spare
/// above its floor. Anything that is not a CS2 demo, is corrupt or truncated compressed data,
/// or goes over the size or ratio cap is `ErrorKind::InvalidData`; going over `room` is
/// `ErrorKind::StorageFull`, so a file that inflates more than the disk can take is stopped
/// there instead of filling it (security audit 2026-10-23). `dest` must not be `src`; on error
/// it is removed.
pub fn decompress_to_dem_within(src: &Path, dest: &Path, room: u64) -> io::Result<()> {
    decompress(src, dest, MAX_DEM_BYTES, room)
}

/// [`decompress_to_dem_within`] with the size cap `max_bytes` instead of [`MAX_DEM_BYTES`], so
/// a test can reach it.
fn decompress(src: &Path, dest: &Path, max_bytes: u64, room: u64) -> io::Result<()> {
    let mut file = File::open(src)?;
    let src_len = file.metadata()?.len();
    let magic = read_head(&mut file, 3)?;
    file.rewind()?;
    let input = BufReader::with_capacity(BUF, file);
    let mut reader: Box<dyn Read> = match magic[..] {
        [b'B', b'Z', b'h'] => Box::new(Decoder {
            inner: MultiBzDecoder::new(input),
            format: "bzip2",
        }),
        [0x1f, 0x8b, ..] => Box::new(Decoder {
            inner: MultiGzDecoder::new(input),
            format: "gzip",
        }),
        _ => Box::new(input),
    };

    let head = read_head(&mut reader, 8)?;
    check_demo_magic(&head)?;

    // A raw file is copied as is, so only a decompressor can pass the ratio. The smallest cap
    // decides; on a tie, what the file is says more than the disk.
    let ratio_cap = src_len.saturating_mul(MAX_INFLATE_RATIO);
    let caps = [
        (
            ratio_cap,
            ErrorKind::InvalidData,
            format!(
                "the file inflates to more than {MAX_INFLATE_RATIO} times its size, \
                 which no demo does"
            ),
        ),
        (
            max_bytes,
            ErrorKind::InvalidData,
            format!("the demo is larger than {max_bytes} bytes once decompressed"),
        ),
        (
            room,
            ErrorKind::StorageFull,
            format!("there is no room on the disk for the demo past {room} bytes"),
        ),
    ];
    let (cap, kind, too_big) = caps
        .into_iter()
        .reduce(|a, b| if b.0 < a.0 { b } else { a })
        .expect("three caps");
    let out = File::create(dest)?;
    let result = write_capped(&head, reader, out, cap, || {
        io::Error::new(kind, too_big.clone())
    });
    if result.is_err() {
        let _ = fs::remove_file(dest);
    }
    result
}

fn check_demo_magic(head: &[u8]) -> io::Result<()> {
    if head == b"PBDEMS2\0" {
        Ok(())
    } else if head.starts_with(b"HL2DEMO") {
        Err(invalid(
            "this is a CS:GO (Source 1) demo; only CS2 demos are supported".into(),
        ))
    } else {
        Err(invalid("this file is not a CS2 demo".into()))
    }
}

fn write_capped(
    head: &[u8],
    reader: impl Read,
    out: File,
    max_bytes: u64,
    too_big: impl Fn() -> io::Error,
) -> io::Result<()> {
    let budget = max_bytes
        .checked_sub(head.len() as u64)
        .ok_or_else(&too_big)?;
    let mut w = BufWriter::with_capacity(BUF, out);
    w.write_all(head)?;
    if copy_capped(reader, &mut w, budget)?.is_none() {
        return Err(too_big());
    }
    w.flush()
}

/// The first `n` bytes `r` gives; fewer only where it ends.
pub(crate) fn read_head(r: impl Read, n: u64) -> io::Result<Vec<u8>> {
    let mut head = Vec::new();
    r.take(n).read_to_end(&mut head)?;
    Ok(head)
}

/// Copies `reader` into `out` until it ends and returns how many bytes that was, or `None` when
/// it has more than `cap` (what was written stays, for the caller to delete): it reads one byte
/// past the cap to tell.
pub(crate) fn copy_capped(
    reader: impl Read,
    out: &mut impl Write,
    cap: u64,
) -> io::Result<Option<u64>> {
    let copied = io::copy(&mut reader.take(cap.saturating_add(1)), out)?;
    Ok((copied <= cap).then_some(copied))
}

fn invalid(msg: String) -> io::Error {
    io::Error::new(ErrorKind::InvalidData, msg)
}

/// A decompressor whose read errors all come out as `InvalidData` naming the format: to the
/// caller, corrupt and truncated input are the same "this file is broken".
struct Decoder<R> {
    inner: R,
    format: &'static str,
}

impl<R: Read> Read for Decoder<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf).map_err(|e| match e.kind() {
            ErrorKind::Interrupted => e,
            _ => invalid(format!("corrupt or truncated {} data: {e}", self.format)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A demo over the size cap is `InvalidData` with nothing left behind, whether it came raw,
    /// as bzip2 or as gzip; one exactly at the cap is written whole. (Production's cap is
    /// [`MAX_DEM_BYTES`]; a test file that large would take a gigabyte of disk.)
    #[test]
    fn the_size_cap_refuses_a_larger_demo() {
        let dir = tempfile::tempdir().unwrap();
        // Noise (xorshift), which does not compress, as a demo barely does.
        let mut raw = b"PBDEMS2\0".to_vec();
        let mut x: u64 = 0x9E37_79B9_7F4A_7C15;
        while raw.len() < 300_000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            raw.extend_from_slice(&x.to_le_bytes());
        }
        let mut bz = bzip2::write::BzEncoder::new(Vec::new(), bzip2::Compression::default());
        bz.write_all(&raw).unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(&raw).unwrap();
        let inputs = [
            ("raw", raw.clone()),
            ("bz2", bz.finish().unwrap()),
            ("gz", gz.finish().unwrap()),
        ];
        for (name, bytes) in inputs {
            let src = dir.path().join(format!("in.{name}"));
            fs::write(&src, bytes).unwrap();
            let dest = dir.path().join(format!("out.{name}.dem"));
            let cap = raw.len() as u64;
            let err = decompress(&src, &dest, cap - 1, u64::MAX).unwrap_err();
            assert_eq!(err.kind(), ErrorKind::InvalidData, "{name}: {err}");
            assert!(
                err.to_string().contains("once decompressed"),
                "{name}: {err}"
            );
            assert!(!dest.exists(), "{name}");
            decompress(&src, &dest, cap, u64::MAX).unwrap();
            assert!(fs::read(&dest).unwrap() == raw, "{name}");
        }
    }
}
