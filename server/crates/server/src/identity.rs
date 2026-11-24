//! Everything a person may type to name a Steam account or a match, in the one input (the
//! homepage's, or a skunk.club path): Steam's links and id forms, friend and invite codes,
//! custom URLs, share codes, Valve replay links, FACEIT match room links and the site's own demo
//! links. One resolver; the web app's detector follows the same rules, and both are held to
//! `tests/fixtures/inputs.json`.

use md5::{Digest, Md5};
use url::Url;

use crate::ingest::{check_url, is_replay_host};
use crate::sharecode::{self, ShareCode};
use crate::store::valid_id;

/// The steamid64 of account id 0: an individual's steamid64 is this plus their account id.
pub const STEAMID64_BASE: u64 = 76_561_197_960_265_728;
/// CS2 friend codes' alphabet (base 32, without I, O, 0 and 1).
const FRIEND_ALPHABET: &[u8; 32] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/// Steam invite codes' hex digits (`s.team/p/…`).
const INVITE_ALPHABET: &[u8; 16] = b"bcdfghjkmnpqrtvw";

/// What a typed text names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Input {
    /// An account, as its steamid64.
    SteamId(u64),
    /// A Steam custom URL name, from an `/id/` link or typed as a bare word (`bare`; only
    /// then may a player's name stand in for it).
    Vanity {
        name: String,
        bare: bool,
    },
    ShareCode(ShareCode),
    /// A Valve replay link (what [`check_url`] accepts).
    ReplayUrl(Url),
    /// A demo on this site (`skunk.club/d/<id>`, `cs.skunk.to/d/<id>`).
    Demo(String),
    /// A FACEIT match, by FACEIT's id of it ([`faceit_match_id`]), from its room link
    /// (`faceit.com/<lang>/cs2/room/<id>`).
    FaceitMatch(String),
    Unrecognised,
}

/// What `text` names. Spaces around it are ignored; then, in this order: a profile link
/// (`steamcommunity.com` or `skunk.club`, any scheme, `www.`, trailing path or query), an
/// `/id/` link, an invite link (`s.team/p/…`, `steamcommunity.com/user/…`), a share code
/// (also inside CS2's `steam://rungame/…` link), a Valve replay link, a demo link, a FACEIT
/// match room link (`faceit.com`, any scheme, `www.`, the language segment optional and not
/// checked, a trailing path or query; any other `faceit.com` page names nothing); then a
/// steamid64 (`7656119` and 10 digits), `STEAM_X:Y:Z`, `[U:1:N]`, an account id (a number up
/// to `u32::MAX`, never a demo id), a friend code (`XXXXX-XXXX`, when its hash checks), and a
/// custom URL name (2 to 32 letters, digits, `_`, `.` or `-`). A link to one of those sites
/// that names nothing valid is unrecognised, as is any other number.
pub fn classify(text: &str) -> Input {
    let text = text.trim();
    if text.is_empty() {
        return Input::Unrecognised;
    }
    if let Some(input) = site_link(text) {
        return input;
    }
    if let Some(code) = sharecode::extract(text) {
        return sharecode::decode(&code).map_or(Input::Unrecognised, Input::ShareCode);
    }
    if let Some(id) = steamid64(text)
        .or_else(|| steam2(text))
        .or_else(|| steam3(text))
    {
        return id;
    }
    if text.bytes().all(|b| b.is_ascii_digit()) {
        let account = text.parse::<u64>().ok();
        return account
            .and_then(of_account)
            .map_or(Input::Unrecognised, Input::SteamId);
    }
    if friend_shaped(text) {
        if let Some(id) = steamid_from_friend_code(text) {
            return Input::SteamId(id);
        }
    }
    if vanity_name(text) {
        return Input::Vanity {
            name: text.to_owned(),
            bare: true,
        };
    }
    Input::Unrecognised
}

/// A link to Steam's or this site's pages, to a Valve replay, or to a FACEIT match room; `None`
/// for any other text, a link elsewhere included.
fn site_link(text: &str) -> Option<Input> {
    let full = if text.contains("://") {
        text.to_owned()
    } else {
        format!("https://{text}")
    };
    let url = Url::parse(&full).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_ascii_lowercase();
    let host = host.strip_prefix("www.").unwrap_or(&host);
    let segments: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|s| !s.is_empty()).collect())
        .unwrap_or_default();
    let (first, second) = (
        segments.first().copied(),
        segments.get(1).copied().unwrap_or(""),
    );
    let profile_site = matches!(host, "steamcommunity.com" | "skunk.club");
    let found = match first {
        Some("profiles") if profile_site => steamid64(second).unwrap_or(Input::Unrecognised),
        Some("id") if profile_site => {
            if vanity_name(second) {
                Input::Vanity {
                    name: second.to_owned(),
                    bare: false,
                }
            } else {
                Input::Unrecognised
            }
        }
        Some("user") if host == "steamcommunity.com" => invite(second),
        Some("p") if host == "s.team" => invite(second),
        Some("d") if matches!(host, "skunk.club" | "cs.skunk.to") => {
            if valid_id(second) {
                Input::Demo(second.to_owned())
            } else {
                Input::Unrecognised
            }
        }
        _ if is_replay_host(host) => check_url(&full).map_or(Input::Unrecognised, Input::ReplayUrl),
        _ if host == "faceit.com" => {
            faceit_room(&segments).map_or(Input::Unrecognised, Input::FaceitMatch)
        }
        _ => return None,
    };
    Some(found)
}

/// The match of a FACEIT room link's path, `[<lang>/]cs2/room/<id>[/…]` (the language is not
/// checked, and a page of the room such as `/scoreboard` may follow); `None` for any other
/// path.
fn faceit_room(segments: &[&str]) -> Option<String> {
    let game = match segments {
        ["cs2", ..] => segments,
        [_, rest @ ..] => rest,
        [] => return None,
    };
    match game {
        ["cs2", "room", id, ..] => faceit_match_id(id),
        _ => None,
    }
}

/// FACEIT's id of a CS2 match, in lower case: a UUID (8-4-4-4-12 hex digits, any case), with
/// or without the `1-` FACEIT puts before it; `None` for anything else, so an id taken can go
/// into FACEIT's API path as it is.
pub fn faceit_match_id(s: &str) -> Option<String> {
    let uuid = s.strip_prefix("1-").unwrap_or(s);
    let shaped = uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        });
    shaped.then(|| s.to_ascii_lowercase())
}

fn invite(code: &str) -> Input {
    steamid_from_invite(code).map_or(Input::Unrecognised, Input::SteamId)
}

/// The steamid64 of an individual's account id; `None` for 0 and past `u32::MAX`.
fn of_account(account: u64) -> Option<u64> {
    (1..=u64::from(u32::MAX))
        .contains(&account)
        .then_some(STEAMID64_BASE + account)
}

/// `7656119` and 10 digits, naming an individual's account; any other 17 digits starting so
/// is unrecognised. `None` for anything else.
/// `s` as an individual's steamid64 written out in its 17 digits (`7656119…`); `None` for
/// anything else, a bot's `0` included.
pub fn individual_steamid(s: &str) -> Option<u64> {
    match steamid64(s)? {
        Input::SteamId(id) => Some(id),
        _ => None,
    }
}

fn steamid64(s: &str) -> Option<Input> {
    let shaped = s.len() == 17 && s.starts_with("7656119") && s.bytes().all(|b| b.is_ascii_digit());
    if !shaped {
        return None;
    }
    let account = s.parse::<u64>().ok()?.checked_sub(STEAMID64_BASE);
    Some(
        account
            .and_then(of_account)
            .map_or(Input::Unrecognised, Input::SteamId),
    )
}

/// `STEAM_X:Y:Z` (X 0 to 5, Y 0 or 1): account `2Z + Y`.
fn steam2(s: &str) -> Option<Input> {
    let rest = s.strip_prefix("STEAM_")?;
    let mut parts = rest.split(':');
    let (x, y, z) = (parts.next()?, parts.next()?, parts.next()?);
    let digits = |p: &str| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit());
    if parts.next().is_some() || !matches!(x, "0" | "1" | "2" | "3" | "4" | "5") {
        return None;
    }
    if !matches!(y, "0" | "1") || !digits(z) {
        return None;
    }
    let account = z.parse::<u64>().ok()?.checked_mul(2)? + y.parse::<u64>().ok()?;
    Some(of_account(account).map_or(Input::Unrecognised, Input::SteamId))
}

/// `[U:1:N]`: account `N`.
fn steam3(s: &str) -> Option<Input> {
    let n = s.strip_prefix("[U:1:")?.strip_suffix(']')?;
    if n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let account = n.parse::<u64>().ok();
    Some(
        account
            .and_then(of_account)
            .map_or(Input::Unrecognised, Input::SteamId),
    )
}

fn friend_shaped(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[5] == b'-' && b[..5].iter().chain(&b[6..]).all(u8::is_ascii_alphanumeric)
}

/// A Steam custom URL name, or what may be one: 2 to 32 letters, digits, `_`, `.` or `-`.
fn vanity_name(s: &str) -> bool {
    (2..=32).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
}

/// The first 32 bits (little endian) of the MD5 of `"CSGO"` and the account id, as one
/// little-endian u64: the friend code's check bits.
fn friend_hash(account: u32) -> u32 {
    let strange = u64::from(account) | (0x4353_474F << 32);
    let digest = Md5::digest(strange.to_le_bytes());
    u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// CS2's friend code of an individual's `steamid` (`AJJQ8-EMDJ`): the account id's eight
/// nibbles, each followed by one bit of [`friend_hash`], read as 13 base-32 digits of the
/// byte-swapped number, the always-`AAAA-` start dropped (xPaw's scheme).
pub fn friend_code(steamid: u64) -> String {
    let account = (steamid & 0xFFFF_FFFF) as u32;
    let hash = friend_hash(account);
    let mut r: u64 = 0;
    for i in 0..8 {
        let nibble = u64::from((account >> (4 * i)) & 0xF);
        let bit = u64::from((hash >> i) & 1);
        r = (r << 5) | (nibble << 1) | bit;
    }
    let mut r = r.swap_bytes();
    let mut out = String::with_capacity(15);
    for i in 0..13 {
        if i == 4 || i == 9 {
            out.push('-');
        }
        out.push(char::from(FRIEND_ALPHABET[(r & 31) as usize]));
        r >>= 5;
    }
    out.split_off(5)
}

/// The steamid of a friend code (`XXXXX-XXXX`, or with its `AAAA-` start; any case), when its
/// check bits agree.
pub fn steamid_from_friend_code(code: &str) -> Option<u64> {
    let code = code.trim().to_ascii_uppercase();
    let code = code.strip_prefix("AAAA-").unwrap_or(&code);
    if !friend_shaped(code) {
        return None;
    }
    let mut r: u64 = 0;
    for (i, c) in "AAAA"
        .bytes()
        .chain(code.bytes().filter(|&b| b != b'-'))
        .enumerate()
    {
        let digit = FRIEND_ALPHABET.iter().position(|&a| a == c)?;
        r |= (digit as u64) << (5 * i);
    }
    let mut r = r.swap_bytes();
    let mut account: u64 = 0;
    for _ in 0..8 {
        r >>= 1;
        account = (account << 4) | (r & 0xF);
        r >>= 4;
    }
    let steamid = of_account(account)?;
    (friend_code(steamid) == code).then_some(steamid)
}

/// The steamid of a Steam invite code (`dhv-grbc`): the account id in hex, written with
/// [`INVITE_ALPHABET`]; dashes are ignored.
pub fn steamid_from_invite(code: &str) -> Option<u64> {
    let mut account: u64 = 0;
    let mut digits = 0;
    for c in code.trim().bytes().filter(|&b| b != b'-') {
        let digit = INVITE_ALPHABET
            .iter()
            .position(|&a| a == c.to_ascii_lowercase())?;
        account = (account << 4) | digit as u64;
        digits += 1;
        if digits > 8 {
            return None;
        }
    }
    of_account(account)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: u64 = 76561198000000001;

    #[test]
    fn friend_codes_round_trip() {
        assert_eq!(friend_code(76561197960265729), "AJJJS-ABAA");
        assert_eq!(friend_code(ID), "AJJQ8-EMDJ");
        assert_eq!(
            steamid_from_friend_code("a6kg8-elcj"),
            Some(76561198000000007)
        );
        assert_eq!(steamid_from_friend_code("AJJQ8-EMDK"), None); // hash fails
        assert_eq!(steamid_from_friend_code("AAAA-AJJQ8-EMDJ"), Some(ID));
        assert_eq!(steamid_from_friend_code("AJJQ8-EMD"), None);
        assert_eq!(steamid_from_friend_code("AJJQ1-EMDJ"), None); // 1 is not in the alphabet
    }

    #[test]
    fn invite_codes_are_hex_in_steams_alphabet() {
        assert_eq!(steamid_from_invite("dhv-grbc"), Some(ID));
        assert_eq!(steamid_from_invite("dhvgrbk"), Some(76561198000000007));
        assert_eq!(steamid_from_invite("dhv-grba"), None); // a is not in the alphabet
        assert_eq!(steamid_from_invite(""), None);
        assert_eq!(steamid_from_invite("ccccccccc"), None); // past u32
    }

    #[test]
    fn every_id_form_names_the_same_account() {
        for s in [
            "76561198000000001",
            "STEAM_0:1:19867136",
            "STEAM_1:1:19867136",
            "[U:1:39734273]",
            "39734273",
            "https://steamcommunity.com/profiles/76561198000000001/games/?tab=all",
            "skunk.club/profiles/76561198000000001/",
            "AJJQ8-EMDJ",
            "https://s.team/p/dhv-grbc",
            "steamcommunity.com/user/dhv-grbc",
        ] {
            assert_eq!(classify(s), Input::SteamId(ID), "{s}");
        }
    }

    #[test]
    fn an_individual_steamid_is_its_17_digits_only() {
        assert_eq!(individual_steamid("76561198000000001"), Some(ID));
        for s in ["0", "39734273", "STEAM_0:1:19867136", "7656119800000000x"] {
            assert_eq!(individual_steamid(s), None, "{s}");
        }
    }

    #[test]
    fn a_bare_number_is_never_a_demo_id() {
        assert_eq!(classify("1"), Input::SteamId(76561197960265729));
        assert_eq!(classify("0"), Input::Unrecognised);
    }

    #[test]
    fn a_friend_code_shape_is_tried_before_a_vanity() {
        assert!(matches!(
            classify("ABCDE-FGHJ"),
            Input::Vanity { bare: true, .. }
        ));
    }

    #[test]
    fn id_links_are_vanities_but_not_bare_words() {
        let vanity = |name: &str, bare| Input::Vanity {
            name: name.into(),
            bare,
        };
        assert_eq!(
            classify("https://steamcommunity.com/id/gabelogannewell/"),
            vanity("gabelogannewell", false)
        );
        assert_eq!(
            classify("www.skunk.club/id/Some.Name?l=en"),
            vanity("Some.Name", false)
        );
        assert_eq!(classify("gabelogannewell"), vanity("gabelogannewell", true));
        assert_eq!(classify("x"), Input::Unrecognised);
        assert_eq!(classify("hello world"), Input::Unrecognised);
        assert_eq!(classify("https://example.com/id/x"), Input::Unrecognised);
    }

    #[test]
    fn match_inputs_are_recognised() {
        let code = crate::sharecode::decode("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK").unwrap();
        assert_eq!(
            classify("CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"),
            Input::ShareCode(code)
        );
        assert_eq!(
            classify("steam://rungame/730/76561202255233023/+csgo_download_match%20CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK"),
            Input::ShareCode(code)
        );
        let replay = "https://replay123.valve.net/730/003456789012345678_1234567890.dem.bz2";
        assert_eq!(
            classify(replay),
            Input::ReplayUrl(Url::parse(replay).unwrap())
        );
        for s in [
            "https://skunk.club/d/Jnv7rxggBidutAQ2kv4DRv",
            "cs.skunk.to/d/Jnv7rxggBidutAQ2kv4DRv/",
        ] {
            assert_eq!(
                classify(s),
                Input::Demo("Jnv7rxggBidutAQ2kv4DRv".into()),
                "{s}"
            );
        }
        assert_eq!(
            classify("https://skunk.club/d/../../etc"),
            Input::Unrecognised
        );
        assert_eq!(
            classify("https://replay123.valve.net.evil.example/730/a.dem.bz2"),
            Input::Unrecognised
        );
    }

    #[test]
    fn faceit_room_links_name_their_match() {
        let id = "1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978";
        for s in [
            "https://www.faceit.com/en/cs2/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
            "faceit.com/pt-br/cs2/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978/scoreboard",
            "http://faceit.com/cs2/room/1-2F3E4D5C-6B7A-4980-8F1E-2D3C4B5A6978?x=1",
        ] {
            assert_eq!(classify(s), Input::FaceitMatch(id.into()), "{s}");
        }
        assert_eq!(
            classify("faceit.com/de/cs2/room/2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978"),
            Input::FaceitMatch("2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978".into())
        );
        for s in [
            "https://www.faceit.com/en/players/someone",
            "https://www.faceit.com/",
            "faceit.com/en/cs2/room/",
            "faceit.com/en/cs2/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a697",
            "faceit.com/en/cs2/room/2-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
            "faceit.com/en/cs2/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a697g",
            "faceit.com/en/cs2/room/1-2f3e4d5c66b7a-4980-8f1e-2d3c4b5a6978",
            "faceit.com/en/csgo/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
            "ftp://faceit.com/en/cs2/room/1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
            "1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
        ] {
            assert_eq!(classify(s), Input::Unrecognised, "{s}");
        }
    }

    #[test]
    fn a_faceit_match_id_is_its_uuid_with_or_without_1_dash() {
        assert_eq!(
            faceit_match_id("1-2F3E4D5C-6B7A-4980-8F1E-2D3C4B5A6978").as_deref(),
            Some("1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978")
        );
        assert_eq!(
            faceit_match_id("2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978").as_deref(),
            Some("2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978")
        );
        for s in [
            "",
            "1-",
            "1-aaaa-bbbb",
            "../matches/x",
            " 2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
            "1-1-2f3e4d5c-6b7a-4980-8f1e-2d3c4b5a6978",
        ] {
            assert_eq!(faceit_match_id(s), None, "{s:?}");
        }
    }

    #[derive(serde::Deserialize)]
    struct Case {
        input: String,
        kind: String,
        steamid: Option<String>,
        /// The FACEIT match a room link names.
        #[serde(rename = "faceitMatch")]
        faceit_match: Option<String>,
    }

    #[test]
    fn the_shared_fixture_agrees() {
        let json = include_str!("../tests/fixtures/inputs.json");
        let cases: Vec<Case> = serde_json::from_str(json).unwrap();
        assert!(cases.len() >= 30);
        for c in cases {
            let got = classify(&c.input);
            let kind = match got {
                Input::SteamId(_) | Input::Vanity { .. } => "profile",
                Input::ShareCode(_)
                | Input::ReplayUrl(_)
                | Input::Demo(_)
                | Input::FaceitMatch(_) => "match",
                Input::Unrecognised => "none",
            };
            assert_eq!(kind, c.kind, "{:?} → {got:?}", c.input);
            if let Some(id) = c.steamid {
                assert_eq!(got, Input::SteamId(id.parse().unwrap()), "{:?}", c.input);
            }
            match c.faceit_match {
                Some(id) => assert_eq!(got, Input::FaceitMatch(id), "{:?}", c.input),
                None => assert!(
                    !matches!(got, Input::FaceitMatch(_)),
                    "{:?} → {got:?}",
                    c.input
                ),
            }
        }
    }
}
