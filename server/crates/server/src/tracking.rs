//! Tracked players: whose match history the server walks, with what. A player links by giving
//! their match-history authentication code and a match token ([`Tracking::link`]); the code is
//! kept sealed ([`crate::seal`]), never in plain, in `tracking.json` in the data directory, with
//! the cursor (the latest token reached), when the player is next due and the order checks were
//! made in. Unlinking or a stop (Steam refused the code) deletes the sealed code from memory and
//! from the file before it returns.

use std::collections::HashMap;
use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::profile::TrackingState;
use crate::seal::{self, Key, Sealed};
use crate::store;

const FILE: &str = "tracking.json";

/// A match-history authentication code (`AAAA-AAAAA-AAAA`). It never prints.
#[derive(Clone, PartialEq, Eq)]
pub struct AuthCode(String);

impl AuthCode {
    /// The code in `s`, trimmed and uppercased, when it has Steam's shape.
    pub fn parse(s: &str) -> Option<AuthCode> {
        let s = s.trim().to_ascii_uppercase();
        let groups: Vec<&str> = s.split('-').collect();
        let shaped = groups.len() == 3
            && [4, 5, 4]
                .iter()
                .zip(&groups)
                .all(|(n, g)| g.len() == *n && g.bytes().all(|b| b.is_ascii_alphanumeric()));
        shaped.then_some(AuthCode(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for AuthCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthCode(…)")
    }
}

impl fmt::Display for AuthCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("AuthCode(…)")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Entry {
    state: TrackingState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    code: Option<Sealed>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    cursor: Option<String>,
    /// When the player is next due (unix seconds).
    #[serde(default)]
    next_unix: u64,
    /// The order of the last check: higher is more recent; 0 never checked.
    #[serde(default)]
    checked: u64,
    /// Why tracking stopped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
}

pub struct Tracking {
    path: PathBuf,
    tmp: PathBuf,
    key: Option<Key>,
    entries: Mutex<HashMap<u64, Entry>>,
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Tracking {
    /// The tracked players kept in `data_dir`; `key` seals and opens their codes (without one,
    /// nobody can link and no code opens).
    pub fn open(data_dir: &Path, key: Option<Key>) -> io::Result<Arc<Tracking>> {
        let path = data_dir.join(FILE);
        let on_disk: HashMap<String, Entry> = match std::fs::read(&path) {
            Ok(json) => serde_json::from_slice(&json)?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => HashMap::new(),
            Err(e) => return Err(e),
        };
        let entries = on_disk
            .into_iter()
            .filter_map(|(id, e)| Some((id.parse().ok()?, e)))
            .collect();
        Ok(Arc::new(Tracking {
            tmp: data_dir.join(format!("{FILE}.tmp")),
            path,
            key,
            entries: Mutex::new(entries),
        }))
    }

    /// Tracks `steamid` from `cursor` (the oldest token the player gave) with `code`, due now.
    /// Fails without a key, or when the file cannot be written.
    pub fn link(&self, steamid: u64, code: &AuthCode, cursor: &str) -> io::Result<()> {
        let key = self
            .key
            .as_ref()
            .ok_or_else(|| io::Error::other("tracking is not set up on this server"))?;
        let mut entries = self.lock();
        let checked = entries.get(&steamid).map_or(0, |e| e.checked);
        entries.insert(
            steamid,
            Entry {
                state: TrackingState::On,
                code: Some(seal::seal(key, steamid, code.as_str().as_bytes())),
                cursor: Some(cursor.to_owned()),
                next_unix: unix_now(),
                checked,
                reason: None,
            },
        );
        self.save(&entries)
    }

    /// Stops tracking `steamid` at their asking: the code and cursor are gone once it returns.
    pub fn unlink(&self, steamid: u64) -> io::Result<()> {
        self.end(steamid, TrackingState::Off, None)
    }

    /// Stops tracking `steamid` because of `reason` (Steam refused the code): the code is gone
    /// once it returns, and the profile says tracking stopped.
    pub fn stop(&self, steamid: u64, reason: &str) -> io::Result<()> {
        self.end(steamid, TrackingState::Stopped, Some(reason.to_owned()))
    }

    fn end(&self, steamid: u64, state: TrackingState, reason: Option<String>) -> io::Result<()> {
        let mut entries = self.lock();
        let Some(e) = entries.get_mut(&steamid) else {
            return Ok(());
        };
        e.state = state;
        e.code = None;
        e.cursor = None;
        e.reason = reason;
        self.save(&entries)
    }

    pub fn state(&self, steamid: u64) -> TrackingState {
        self.lock()
            .get(&steamid)
            .map_or(TrackingState::Off, |e| e.state)
    }

    /// Why tracking `steamid` stopped, when it did.
    pub fn reason(&self, steamid: u64) -> Option<String> {
        self.lock().get(&steamid).and_then(|e| e.reason.clone())
    }

    /// `steamid`'s code, opened, while they are tracked.
    pub fn code(&self, steamid: u64) -> Option<AuthCode> {
        let key = self.key.as_ref()?;
        let sealed = self.lock().get(&steamid)?.code.clone()?;
        let plain = seal::open(key, steamid, &sealed)?;
        AuthCode::parse(std::str::from_utf8(&plain).ok()?)
    }

    pub fn cursor(&self, steamid: u64) -> Option<String> {
        self.lock().get(&steamid).and_then(|e| e.cursor.clone())
    }

    /// Whether `steamid` is still tracked with `code` from `cursor`: false once they stopped,
    /// were stopped, or linked again (a walk started before then is over).
    pub fn still(&self, steamid: u64, code: &AuthCode, cursor: &str) -> bool {
        let on = self
            .lock()
            .get(&steamid)
            .is_some_and(|e| e.state == TrackingState::On && e.cursor.as_deref() == Some(cursor));
        on && self.code(steamid).as_ref() == Some(code)
    }

    /// Moves `steamid`'s cursor from `from` to `to` (the next match found), only while they are
    /// still tracked from `from` ([`Tracking::still`]'s rule for the cursor); false, and nothing
    /// written, otherwise.
    pub fn advance(&self, steamid: u64, from: &str, to: &str) -> io::Result<bool> {
        let mut entries = self.lock();
        let Some(e) = entries.get_mut(&steamid) else {
            return Ok(false);
        };
        if e.state != TrackingState::On || e.code.is_none() || e.cursor.as_deref() != Some(from) {
            return Ok(false);
        }
        e.cursor = Some(to.to_owned());
        self.save(&entries).map(|()| true)
    }

    /// Every player tracking is on for, by steamid: whose FACEIT history the FACEIT poller keeps
    /// ([`crate::faceit_tracker`]), on a schedule of its own rather than [`Tracking::due`]'s.
    pub fn tracked(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self
            .lock()
            .iter()
            .filter(|(_, e)| e.state == TrackingState::On)
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    }

    /// The tracked player due by `now` who was checked longest ago.
    pub fn due(&self, now: u64) -> Option<u64> {
        self.lock()
            .iter()
            .filter(|(_, e)| e.state == TrackingState::On && e.code.is_some() && e.next_unix <= now)
            .min_by_key(|(id, e)| (e.checked, **id))
            .map(|(id, _)| *id)
    }

    /// Notes that `steamid` was checked now, and is next due at `next_unix`. A failure to write
    /// is logged.
    pub fn checked(&self, steamid: u64, next_unix: u64) {
        let mut entries = self.lock();
        let order = entries.values().map(|e| e.checked).max().unwrap_or(0) + 1;
        let Some(e) = entries.get_mut(&steamid) else {
            return;
        };
        e.checked = order;
        e.next_unix = next_unix;
        if let Err(e) = self.save(&entries) {
            tracing::error!(error = %e, "cannot write the tracked players");
        }
    }

    fn save(&self, entries: &HashMap<u64, Entry>) -> io::Result<()> {
        let on_disk: HashMap<String, &Entry> =
            entries.iter().map(|(id, e)| (id.to_string(), e)).collect();
        let json = serde_json::to_vec(&on_disk).map_err(io::Error::other)?;
        store::write_file(&self.tmp, &self.path, &json)
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<u64, Entry>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::seal::Key;

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const A: u64 = 76561198000000001;
    const B: u64 = 76561198000000002;
    const CURSOR: &str = "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK";

    fn tracking(dir: &Path) -> Arc<Tracking> {
        Tracking::open(dir, Some(Key::from_hex(KEY).unwrap())).unwrap()
    }

    fn code() -> AuthCode {
        AuthCode::parse(" abcd-efghi-jklm ").unwrap()
    }

    #[test]
    fn auth_codes_never_print() {
        assert_eq!(format!("{:?}", code()), "AuthCode(…)");
        assert_eq!(format!("{}", code()), "AuthCode(…)");
        assert_eq!(code().as_str(), "ABCD-EFGHI-JKLM");
    }

    #[test]
    fn an_auth_code_must_have_steams_shape() {
        assert!(AuthCode::parse("ABCD-EFGH-JKLM").is_none());
        assert!(AuthCode::parse("ABCD-EFGHI-JKLMN").is_none());
        assert!(AuthCode::parse("AB D-EFGHI-JKLM").is_none());
        assert!(AuthCode::parse("").is_none());
    }

    #[test]
    fn the_tracking_file_never_holds_the_code_in_plain() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        t.link(A, &code(), CURSOR).unwrap();
        let file = std::fs::read_to_string(dir.path().join("tracking.json")).unwrap();
        assert!(!file.contains("ABCD-EFGHI-JKLM"), "{file}");
        assert!(file.contains(CURSOR));
        // Read back, it opens.
        let again = tracking(dir.path());
        assert_eq!(again.code(A).unwrap().as_str(), "ABCD-EFGHI-JKLM");
        assert_eq!(again.state(A), TrackingState::On);
        assert_eq!(again.cursor(A).as_deref(), Some(CURSOR));
    }

    #[test]
    fn unlink_deletes_the_code_from_disk_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        t.link(A, &code(), CURSOR).unwrap();
        let sealed_before = std::fs::read_to_string(dir.path().join("tracking.json")).unwrap();
        assert!(sealed_before.contains("\"nonce\""));
        t.unlink(A).unwrap();
        let file = std::fs::read_to_string(dir.path().join("tracking.json")).unwrap();
        assert!(!file.contains("\"nonce\""), "{file}");
        assert!(t.code(A).is_none());
        assert_eq!(t.state(A), TrackingState::Off);
        assert_eq!(tracking(dir.path()).state(A), TrackingState::Off);
    }

    #[test]
    fn stop_deletes_the_code_and_says_stopped() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        t.link(A, &code(), CURSOR).unwrap();
        t.stop(A, "Steam refused the authentication code").unwrap();
        assert_eq!(t.state(A), TrackingState::Stopped);
        assert!(t.code(A).is_none());
        let file = std::fs::read_to_string(dir.path().join("tracking.json")).unwrap();
        assert!(!file.contains("\"nonce\""));
        assert_eq!(t.due(u64::MAX), None, "a stopped player is never due");
    }

    #[test]
    fn the_longest_waiting_due_player_is_next() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        assert_eq!(t.state(A), TrackingState::Off);
        assert_eq!(t.due(0), None);
        t.link(A, &code(), CURSOR).unwrap();
        t.link(B, &code(), CURSOR).unwrap();
        let now = unix_now();
        // Both due now; A was checked longer ago once B has been checked.
        t.checked(B, now);
        assert_eq!(t.due(now + 1), Some(A));
        t.checked(A, now + 100);
        assert_eq!(t.due(now + 1), Some(B), "A is not due till now + 100");
        assert_eq!(t.due(now + 200), Some(B), "B was checked longer ago");
        assert!(t
            .advance(B, CURSOR, "CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB")
            .unwrap());
        assert_eq!(
            t.cursor(B).as_deref(),
            Some("CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB")
        );
    }

    #[test]
    fn a_walk_cannot_move_a_cursor_it_did_not_start_from() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        t.link(A, &code(), CURSOR).unwrap();
        let next = "CSGO-QUGOA-uCOn5-HXTw9-8FwfM-sPcAB";
        assert!(t.still(A, &code(), CURSOR));
        // Linked again from another token: the old walk's step is refused.
        t.link(A, &code(), next).unwrap();
        assert!(!t.still(A, &code(), CURSOR));
        assert!(!t
            .advance(A, CURSOR, "CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK")
            .unwrap());
        assert_eq!(t.cursor(A).as_deref(), Some(next));
        // Linked again with another code: the old code's walk is over.
        let other = AuthCode::parse("WXYZ-EFGHI-JKLM").unwrap();
        t.link(A, &other, next).unwrap();
        assert!(!t.still(A, &code(), next));
        // Stopped: nothing moves, nothing comes back.
        t.unlink(A).unwrap();
        assert!(!t.advance(A, next, CURSOR).unwrap());
        assert_eq!(t.cursor(A), None);
    }

    #[test]
    fn tracked_lists_the_players_tracking_is_on_for() {
        let dir = tempfile::tempdir().unwrap();
        let t = tracking(dir.path());
        assert!(t.tracked().is_empty());
        let c = 76561198000000003;
        for id in [c, B, A] {
            t.link(id, &code(), CURSOR).unwrap();
        }
        assert_eq!(t.tracked(), [A, B, c], "by steamid");
        t.unlink(B).unwrap();
        t.stop(c, "revoked").unwrap();
        assert_eq!(t.tracked(), [A]);
        assert_eq!(tracking(dir.path()).tracked(), [A], "read back");
    }

    #[test]
    fn without_a_key_nothing_links() {
        let dir = tempfile::tempdir().unwrap();
        let t = Tracking::open(dir.path(), None).unwrap();
        assert!(t.link(A, &code(), CURSOR).is_err());
        assert_eq!(t.state(A), TrackingState::Off);
    }
}
