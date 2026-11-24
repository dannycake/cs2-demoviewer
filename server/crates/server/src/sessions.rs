//! Signed-in sessions: a random token in the visitor's cookie, and in `sessions.json` the
//! SHA-256 of each token with its steamid and when it ends. The token itself is never stored,
//! so the file cannot sign anyone in. Sessions last [`SESSION_TTL`] and survive restarts.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::store;

/// How long a sign-in lasts.
pub const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 3600);
const FILE: &str = "sessions.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
struct Session {
    steamid: u64,
    expires_unix: u64,
}

pub struct Sessions {
    path: PathBuf,
    tmp: PathBuf,
    /// Hex SHA-256 of a token → its session.
    by_hash: Mutex<HashMap<String, Session>>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

fn hash(token: &str) -> String {
    store::hex(&Sha256::digest(token.as_bytes()))
}

impl Sessions {
    /// The sessions kept in `data_dir`, those that ended dropped; none when there is no file.
    pub fn open(data_dir: &Path) -> io::Result<Arc<Sessions>> {
        let path = data_dir.join(FILE);
        let mut by_hash: HashMap<String, Session> = match std::fs::read(&path) {
            Ok(json) => serde_json::from_slice(&json)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e),
        };
        let t = now();
        by_hash.retain(|_, s| s.expires_unix > t);
        Ok(Arc::new(Sessions {
            tmp: data_dir.join(format!("{FILE}.tmp")),
            path,
            by_hash: Mutex::new(by_hash),
        }))
    }

    /// A new session for `steamid`: its token (32 random bytes, base58), for the cookie.
    /// Writes the file (blocking).
    pub fn create(&self, steamid: u64) -> String {
        let token = bs58::encode(rand::random::<[u8; 32]>()).into_string();
        let session = Session {
            steamid,
            expires_unix: now() + SESSION_TTL.as_secs(),
        };
        let mut by_hash = self.lock();
        by_hash.insert(hash(&token), session);
        self.save(&by_hash);
        token
    }

    /// Whose session `token` is, while it lasts.
    pub fn steamid(&self, token: &str) -> Option<u64> {
        let s = *self.lock().get(&hash(token))?;
        (s.expires_unix > now()).then_some(s.steamid)
    }

    /// Ends the session of `token`. Writes the file (blocking).
    pub fn remove(&self, token: &str) {
        let mut by_hash = self.lock();
        if by_hash.remove(&hash(token)).is_some() {
            self.save(&by_hash);
        }
    }

    /// Writes every session that has not ended; a failure is logged (the sessions in memory
    /// still hold until a restart).
    fn save(&self, by_hash: &HashMap<String, Session>) {
        let t = now();
        let live: HashMap<&String, &Session> =
            by_hash.iter().filter(|(_, s)| s.expires_unix > t).collect();
        let written = serde_json::to_vec(&live)
            .map_err(io::Error::other)
            .and_then(|json| store::write_file(&self.tmp, &self.path, &json));
        if let Err(e) = written {
            tracing::error!(error = %e, "cannot write the sessions");
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, Session>> {
        self.by_hash.lock().unwrap_or_else(PoisonError::into_inner)
    }
}
