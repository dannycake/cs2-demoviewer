//! Match share codes (`CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx`): finding one in pasted text, and
//! the ids it holds. The codec is akiver/csgo-sharecode's: the 25 characters, read last to
//! first, are a base-57 number whose 18 bytes (big endian) hold the match id and the outcome id
//! (u64) and a token (u16), each little endian. The outcome id is the match's reservation id
//! and the token the low 16 bits of its TV port. Crosshair codes have the same shape and
//! alphabet: they decode, and Valve has no match for them.

use std::fmt;

/// The share-code alphabet: letters and digits without I, g, l, 0 or 1.
pub const ALPHABET: &[u8; 57] = b"ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

/// `CSGO` and five dash-led groups of five.
const LEN: usize = 34;

/// What a share code holds: what the Game Coordinator is asked for the match. Valve answers only
/// for all three together, and so does the site ([`crate::store::Store::find_match`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ShareCode {
    pub match_id: u64,
    pub outcome_id: u64,
    pub token: u16,
}

/// Why a string is not a share code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShareCodeError {
    /// Not `CSGO-` and five groups of five letters or digits, and nothing else.
    Shape,
    /// A letter or digit outside [`ALPHABET`].
    Letter(char),
    /// A number over 18 bytes, which no encoder makes.
    TooLarge,
}

impl fmt::Display for ShareCodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ShareCodeError::Shape => {
                f.write_str("not shaped like CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx")
            }
            ShareCodeError::Letter(c) => write!(f, "{c:?} is not in the share-code alphabet"),
            ShareCodeError::TooLarge => f.write_str("the code's number is too large"),
        }
    }
}

impl std::error::Error for ShareCodeError {}

/// The first share code in `text`: the first `CSGO(-[A-Za-z0-9]{5}){5}` anywhere in it, so
/// CS2's "copy share link" (`steam://rungame/730/…/+csgo_download_match%20CSGO-…`) works as is.
/// gcbot (`gcbot/src/sharecode.mjs`) and the web app (`web/src/sharecode.ts`) use the same rule.
pub fn extract(text: &str) -> Option<String> {
    // Every byte of a match is ASCII, so both ends of one are char boundaries.
    text.match_indices("CSGO")
        .map(|(at, _)| &text.as_bytes()[at..])
        .find(|rest| shaped(rest))
        .map(|rest| String::from_utf8_lossy(&rest[..LEN]).into_owned())
}

/// Whether `bytes` starts with `CSGO` and five groups of `-` and five letters or digits.
fn shaped(bytes: &[u8]) -> bool {
    bytes.len() >= LEN
        && bytes.starts_with(b"CSGO")
        && bytes[4..LEN]
            .chunks(6)
            .all(|group| group[0] == b'-' && group[1..].iter().all(u8::is_ascii_alphanumeric))
}

/// The ids in `code`, which must be a share code and nothing else.
pub fn decode(code: &str) -> Result<ShareCode, ShareCodeError> {
    let bytes = code.as_bytes();
    if bytes.len() != LEN || !shaped(bytes) {
        return Err(ShareCodeError::Shape);
    }
    // The number, big endian, read from the last character (the most significant digit).
    let mut n = [0u8; 18];
    for &c in bytes[5..].iter().rev().filter(|&&c| c != b'-') {
        let digit = ALPHABET
            .iter()
            .position(|&a| a == c)
            .ok_or(ShareCodeError::Letter(char::from(c)))?;
        let mut carry = digit as u32;
        for byte in n.iter_mut().rev() {
            let v = u32::from(*byte) * 57 + carry;
            *byte = v as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return Err(ShareCodeError::TooLarge);
        }
    }
    let u64_at = |at: usize| u64::from_le_bytes(n[at..at + 8].try_into().unwrap());
    Ok(ShareCode {
        match_id: u64_at(0),
        outcome_id: u64_at(8),
        token: u16::from_le_bytes([n[16], n[17]]),
    })
}

/// The share code for `code`'s ids.
pub fn encode(code: &ShareCode) -> String {
    let mut n = [0u8; 18];
    n[..8].copy_from_slice(&code.match_id.to_le_bytes());
    n[8..16].copy_from_slice(&code.outcome_id.to_le_bytes());
    n[16..].copy_from_slice(&code.token.to_le_bytes());
    // Least significant digit first: the first character.
    let mut digits = [0u8; 25];
    for d in &mut digits {
        let mut rem = 0u32;
        for byte in &mut n {
            let v = (rem << 8) | u32::from(*byte);
            *byte = (v / 57) as u8;
            rem = v % 57;
        }
        *d = ALPHABET[rem as usize];
    }
    let mut out = String::with_capacity(LEN);
    out.push_str("CSGO");
    for group in digits.chunks(5) {
        out.push('-');
        out.extend(group.iter().map(|&c| char::from(c)));
    }
    out
}
