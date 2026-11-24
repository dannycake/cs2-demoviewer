//! Sealing a tracked player's match-history authentication code at rest: XChaCha20-Poly1305
//! with the server's key (`DEMOVIEWER_TRACKING_KEY`), a random 24-byte nonce each time, and the
//! player's steamid as associated data, so a sealed code opens only for the player it was
//! sealed for. The key never prints.

use std::fmt;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use serde::{Deserialize, Serialize};

use crate::store::hex;

/// The sealing key: 32 bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct Key([u8; 32]);

impl Key {
    /// The key written as 64 hex digits.
    pub fn from_hex(s: &str) -> Result<Key, String> {
        let bytes = unhex(s.trim()).ok_or("not 64 hex digits")?;
        Ok(Key(bytes.try_into().map_err(|_| "not 64 hex digits")?))
    }
}

impl fmt::Debug for Key {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Key(hidden)")
    }
}

/// A sealed value, as kept on disk: its nonce and its ciphertext with the tag, in hex.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sealed {
    pub nonce: String,
    pub data: String,
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// `plain` sealed for `steamid`.
pub fn seal(key: &Key, steamid: u64, plain: &[u8]) -> Sealed {
    let nonce = rand::random::<[u8; 24]>();
    let aad = steamid.to_string();
    let data = XChaCha20Poly1305::new(&key.0.into())
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plain,
                aad: aad.as_bytes(),
            },
        )
        .expect("XChaCha20-Poly1305 seals any length we give it");
    Sealed {
        nonce: hex(&nonce),
        data: hex(&data),
    }
}

/// What `s` sealed, when it was sealed with `key` for `steamid` and is whole; else `None`.
pub fn open(key: &Key, steamid: u64, s: &Sealed) -> Option<Vec<u8>> {
    let nonce: [u8; 24] = unhex(&s.nonce)?.try_into().ok()?;
    let data = unhex(&s.data)?;
    let aad = steamid.to_string();
    XChaCha20Poly1305::new(&key.0.into())
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &data,
                aad: aad.as_bytes(),
            },
        )
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    #[test]
    fn a_sealed_code_opens_only_for_its_steamid() {
        let key = Key::from_hex(KEY).unwrap();
        let sealed = seal(&key, 76561198000000001, b"ABCD-EFGHI-JKLM");
        assert_eq!(
            open(&key, 76561198000000001, &sealed).as_deref(),
            Some(&b"ABCD-EFGHI-JKLM"[..])
        );
        assert_eq!(open(&key, 76561198000000002, &sealed), None);
        let other = Key::from_hex(&KEY.replace('0', "1")).unwrap();
        assert_eq!(open(&other, 76561198000000001, &sealed), None);
        // A fresh nonce every time.
        assert_ne!(seal(&key, 1, b"x").nonce, seal(&key, 1, b"x").nonce);
        assert!(!sealed.data.contains("ABCD"));
    }

    #[test]
    fn keys_are_64_hex_digits_and_never_print() {
        assert!(Key::from_hex(&KEY[2..]).is_err());
        assert!(Key::from_hex(&KEY.replace('a', "g")).is_err());
        let key = Key::from_hex(KEY).unwrap();
        assert!(!format!("{key:?}").contains("0011"));
    }

    #[test]
    fn a_damaged_seal_does_not_open() {
        let key = Key::from_hex(KEY).unwrap();
        let mut sealed = seal(&key, 7, b"secret");
        sealed.data.replace_range(
            0..2,
            if sealed.data.starts_with("00") {
                "11"
            } else {
                "00"
            },
        );
        assert_eq!(open(&key, 7, &sealed), None);
        assert_eq!(
            open(
                &key,
                7,
                &Sealed {
                    nonce: "zz".into(),
                    data: "00".into()
                }
            ),
            None
        );
    }
}
