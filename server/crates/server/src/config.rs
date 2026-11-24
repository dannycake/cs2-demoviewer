//! Server configuration, read from the environment with defaults.

use std::path::PathBuf;
use std::time::Duration;

use url::Url;

use crate::faceit::FaceitKey;
use crate::ratelimit::{parse_cidrs, Cidr};
use crate::steam::ApiKey;

/// Everything the server needs to know at startup. [`from_env`] fills it from `DEMOVIEWER_*`
/// variables; `Config::default()` is the same with no variables set (tests start from it and
/// shrink the limits).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    /// `DEMOVIEWER_PORT`, default 8095.
    pub port: u16,
    /// `DEMOVIEWER_DATA`, default `./data`: uploads, work files, packs, match summaries and
    /// `demos.json`.
    pub data_dir: PathBuf,
    /// `DEMOVIEWER_ASSETS`, default `./assets`: served under `/maps/`, `/players/`, `/weapons/`,
    /// `/viewmodels/`, `/effects/`, `/sounds/` and `/site/`.
    pub assets_dir: PathBuf,
    /// `DEMOVIEWER_WEB`, default `./static`: the web app, with `index.html` as the fallback.
    pub web_dir: PathBuf,
    /// Largest demo accepted by upload or URL ingest: 500 MiB.
    pub max_upload_bytes: u64,
    /// Size of every upload chunk but the last: 32 MiB.
    pub chunk_bytes: u64,
    /// `DEMOVIEWER_CACHE_BYTES`: packs kept on disk before the least recently used are evicted.
    /// `None`, the default: packs are kept forever (spec §8.2).
    pub cache_bytes: Option<u64>,
    /// Upload starts, URL ingests and share codes that start a lookup, accepted per client
    /// address per hour: 10. Counted last ([`crate::admission`]), so a refusal spends none.
    pub ingests_per_hour: u32,
    /// Declared size of all unfinished uploads together: 10 GiB. One client address may hold
    /// at most twice `max_upload_bytes` of it.
    pub upload_budget_bytes: u64,
    /// The executable that parses demos in child processes (`<exe> parse-worker <demo>
    /// <pack>`, see `worker`). The server sets it to itself at startup; `None`, the default,
    /// parses on a thread of this process, where a parser that runs out of memory takes the
    /// whole process with it (tests and tools only).
    pub parse_worker: Option<PathBuf>,
    /// Writable memory a parse child may use: 4 GiB. A 237 MB demo needs under 1 GiB.
    pub parse_memory_bytes: u64,
    /// Peers whose `CF-Connecting-IP` / `X-Forwarded-For` headers are believed
    /// (`DEMOVIEWER_TRUSTED_PROXIES`, comma-separated blocks). Default: loopback only. The
    /// deployment must name the Cloudflare tunnel's address (its docker network), or every
    /// visitor through the tunnel shares one rate-limit bucket; a LAN client talking to the
    /// port directly is always identified by its own address.
    pub trusted_proxies: Vec<Cidr>,
    /// How long a chunk `PUT` may go without delivering a byte before it is dropped with 408
    /// (`DEMOVIEWER_PUT_IDLE_SECS`).
    pub put_idle: Duration,
    /// Completed uploads that may be waiting for or going through the parse worker at once.
    /// A completed upload keeps its slot (and so its disk) until its job ends; past this, a
    /// `complete` is refused with 503 and the upload's chunks stay for a retry.
    pub max_queued_uploads: usize,
    /// URL and share-code jobs that may be on their way to the parse worker at once (being
    /// looked up, waiting for a download slot or downloading): 32, at most 3 of them one
    /// client's. Past this, a post is refused with 503 before its record is made.
    pub max_fetches: usize,
    /// Upload starts, URL ingests and share-code posts one client may attempt per hour, counted
    /// before any DNS, disk or index work (rejected ones included, and share codes answered
    /// from the index): 120; `ingests_per_hour` then counts the ones that are accepted.
    pub attempts_per_hour: u32,
    /// Free space the data volume must keep (`DEMOVIEWER_MIN_FREE_BYTES`): uploads, URLs and
    /// share codes are refused with 507 when accepting one could take the disk below it, and a
    /// job fails before a download or a pack write that could, and when inflating reaches it.
    pub min_free_bytes: u64,
    /// What the public site offers. There is no site-wide list of matches: they are listed on
    /// their players' profiles and on tournament pages, and indexed by search engines once done
    /// (spec §13.2).
    pub site: Site,
    /// `DEMOVIEWER_PUBLIC_URL`: where visitors reach the site (`https://skunk.club/`), for the
    /// absolute links a match page's preview tags need. Always ends in `/`. `None`, the default:
    /// pages carry no absolute links.
    pub public_url: Option<Url>,
    /// `DEMOVIEWER_GCBOT_URL`: gcbot's HTTP API (`http://gcbot:8097` in the stack), which turns
    /// share codes into replay URLs (see `gcbot`). Always ends in `/`. `None`, the default: share
    /// codes are refused.
    pub gcbot_url: Option<Url>,
    /// `DEMOVIEWER_IMPORT_DIR`: a demo corpus the server reads and never writes (its
    /// `index.jsonl`), imported in the background (see `import`). `None`, the default: none.
    pub import_dir: Option<PathBuf>,
    /// `DEMOVIEWER_STEAM_API_KEY`: the Steam Web API key (32 hex digits; anything else stops
    /// the server), for profiles' Steam facts and custom URL names (see `steam`). `None`, the
    /// default: no Steam calls at all.
    pub steam_api_key: Option<ApiKey>,
    /// Lookups that may ask Steam (a custom URL name, a profile not fetched yet) per client an
    /// hour.
    pub lookups_per_hour: u32,
    /// `DEMOVIEWER_REDIRECT_HOSTS`: old hosts (comma-separated, any case) sent to the public URL
    /// for good (see `hosts`). Empty, the default: none.
    pub redirect_hosts: Vec<String>,
    /// Steam's OpenID endpoint, which sign-in goes to and asks to confirm a sign-in
    /// (`auth::STEAM_OPENID`); a test's fake provider otherwise. Not read from the environment.
    #[doc(hidden)]
    pub openid_endpoint: Url,
    /// FACEIT's site API, asked beside Steam for a profile's FACEIT account
    /// (`faceit::FACEIT_API`); a test's fake FACEIT otherwise, which every test with a fake
    /// Steam must set. Not read from the environment.
    #[doc(hidden)]
    pub faceit_api: Url,
    /// `DEMOVIEWER_FACEIT_API_KEY`: the FACEIT Data API key (8 to 128 printable characters
    /// without whitespace; anything else stops the server), for FACEIT nicknames in the one
    /// input, room links and the poller (see `faceit`), with or without Steam. A profile's
    /// FACEIT facts are asked only inside a Steam fetch, so they come from the Data API only
    /// with `DEMOVIEWER_STEAM_API_KEY` as well. `None`, the default: FACEIT's site API is asked beside Steam instead, for the level and Elo alone.
    pub faceit_api_key: Option<FaceitKey>,
    /// FACEIT's Data API (`faceit::FACEIT_DATA_API`); a test's fake FACEIT otherwise. Not read
    /// from the environment.
    #[doc(hidden)]
    pub faceit_data_api: Url,
    /// `DEMOVIEWER_TRACKING_KEY`: the key tracked players' authentication codes are sealed with
    /// at rest (64 hex digits; anything else stops the server). `None`, the default: nobody can
    /// start tracking.
    pub tracking_key: Option<crate::seal::Key>,
    /// `DEMOVIEWER_CF_BEACON_TOKEN`: the site token of Cloudflare Web Analytics (letters and
    /// digits, at most 64; anything else stops the server), which every page loads the beacon
    /// with. `None`, the default: no analytics script.
    pub cf_beacon_token: Option<String>,
    /// `DEMOVIEWER_GSC_TOKEN`: the content of Google Search Console's
    /// `google-site-verification` tag, which every page carries. `None`, the default: no tag.
    pub gsc_token: Option<String>,
    /// `DEMOVIEWER_INDEXNOW_KEY`: the IndexNow key (8 to 128 letters, digits and `-`; anything
    /// else stops the server), served at `/{key}.txt`. With `DEMOVIEWER_PUBLIC_URL` too, new
    /// pages are submitted to IndexNow. `None`, the default: no submissions.
    pub indexnow_key: Option<String>,
    /// Where IndexNow submissions go (`indexnow::ENDPOINT`). `DEMOVIEWER_INDEXNOW_URL`, a test
    /// hook.
    #[doc(hidden)]
    pub indexnow_url: Url,
}

/// The public site's switches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Site {
    /// `DEMOVIEWER_PREVIEWS`, default on: match pages carry OpenGraph tags and a preview image,
    /// so a pasted link previews in Discord.
    pub previews: bool,
}

impl Default for Site {
    fn default() -> Self {
        Site { previews: true }
    }
}

impl Default for Config {
    fn default() -> Self {
        Config {
            port: 8095,
            data_dir: PathBuf::from("./data"),
            assets_dir: PathBuf::from("./assets"),
            web_dir: PathBuf::from("./static"),
            max_upload_bytes: 524_288_000,
            chunk_bytes: 33_554_432,
            cache_bytes: None,
            ingests_per_hour: 10,
            upload_budget_bytes: 10 * 1024 * 1024 * 1024,
            parse_worker: None,
            parse_memory_bytes: 4 * 1024 * 1024 * 1024,
            trusted_proxies: parse_cidrs("127.0.0.0/8, ::1").unwrap(),
            put_idle: Duration::from_secs(60),
            max_queued_uploads: 4,
            max_fetches: 32,
            attempts_per_hour: 120,
            min_free_bytes: 5 * 1024 * 1024 * 1024,
            site: Site::default(),
            public_url: None,
            gcbot_url: None,
            import_dir: None,
            steam_api_key: None,
            lookups_per_hour: 60,
            redirect_hosts: Vec::new(),
            openid_endpoint: Url::parse(crate::auth::STEAM_OPENID)
                .expect("Steam's OpenID endpoint"),
            faceit_api: Url::parse(crate::faceit::FACEIT_API).expect("FACEIT's API"),
            faceit_api_key: None,
            faceit_data_api: Url::parse(crate::faceit::FACEIT_DATA_API).expect("FACEIT's Data API"),
            tracking_key: None,
            cf_beacon_token: None,
            gsc_token: None,
            indexnow_key: None,
            indexnow_url: Url::parse(crate::indexnow::ENDPOINT).expect("IndexNow's endpoint"),
        }
    }
}

/// Reads the `DEMOVIEWER_*` variable each field's doc names: `PORT`, `DATA`, `ASSETS`, `WEB`,
/// `TRUSTED_PROXIES`, `CACHE_BYTES`, `MIN_FREE_BYTES`, `PUT_IDLE_SECS`, `PREVIEWS`, `PUBLIC_URL`,
/// `GCBOT_URL`, `IMPORT_DIR`, `STEAM_API_KEY`, `FACEIT_API_KEY`, `REDIRECT_HOSTS`, `TRACKING_KEY`, `CF_BEACON_TOKEN` and `GSC_TOKEN`; the other
/// limits keep their defaults. An unset or empty variable means the
/// default.
///
/// # Panics
/// If `DEMOVIEWER_PORT` is set but not a port number: a typo should stop the server, not
/// move it to another port. The same for a switch that is neither on nor off ([`switch`]) and
/// a public or gcbot URL that is not an http(s) address, and a Steam key that is not 32 hex
/// digits, a FACEIT key that is not 8 to 128 printable characters without whitespace, and a
/// beacon token that is not 1 to 64 letters and digits.
pub fn from_env() -> Config {
    from_vars(|name| std::env::var(name).ok())
}

fn from_vars(var: impl Fn(&str) -> Option<String>) -> Config {
    let var = |name: &str| var(name).filter(|v| !v.trim().is_empty());
    let mut cfg = Config::default();
    if let Some(port) = var("DEMOVIEWER_PORT") {
        cfg.port = port
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("DEMOVIEWER_PORT={port:?} is not a port number"));
    }
    for (name, field) in [
        ("DEMOVIEWER_DATA", &mut cfg.data_dir),
        ("DEMOVIEWER_ASSETS", &mut cfg.assets_dir),
        ("DEMOVIEWER_WEB", &mut cfg.web_dir),
    ] {
        if let Some(v) = var(name) {
            *field = PathBuf::from(v);
        }
    }
    if let Some(v) = var("DEMOVIEWER_TRUSTED_PROXIES") {
        cfg.trusted_proxies =
            parse_cidrs(&v).unwrap_or_else(|e| panic!("DEMOVIEWER_TRUSTED_PROXIES: {e}"));
    }
    if let Some(v) = var("DEMOVIEWER_CACHE_BYTES") {
        let bytes: u64 = v
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("DEMOVIEWER_CACHE_BYTES={v:?} is not a number of bytes"));
        cfg.cache_bytes = Some(bytes);
    }
    if let Some(v) = var("DEMOVIEWER_MIN_FREE_BYTES") {
        cfg.min_free_bytes = v
            .trim()
            .parse()
            .unwrap_or_else(|_| panic!("DEMOVIEWER_MIN_FREE_BYTES={v:?} is not a number of bytes"));
    }
    if let Some(v) = var("DEMOVIEWER_PUT_IDLE_SECS") {
        let secs: u64 = v.trim().parse().unwrap_or_else(|_| {
            panic!("DEMOVIEWER_PUT_IDLE_SECS={v:?} is not a number of seconds")
        });
        cfg.put_idle = Duration::from_secs(secs.max(1));
    }
    if let Some(v) = var("DEMOVIEWER_PREVIEWS") {
        cfg.site.previews = switch("DEMOVIEWER_PREVIEWS", &v);
    }
    if let Some(v) = var("DEMOVIEWER_PUBLIC_URL") {
        let url = base_url(&v).unwrap_or_else(|e| panic!("DEMOVIEWER_PUBLIC_URL={v:?}: {e}"));
        cfg.public_url = Some(url);
    }
    if let Some(v) = var("DEMOVIEWER_GCBOT_URL") {
        let url = base_url(&v).unwrap_or_else(|e| panic!("DEMOVIEWER_GCBOT_URL={v:?}: {e}"));
        cfg.gcbot_url = Some(url);
    }
    cfg.import_dir = var("DEMOVIEWER_IMPORT_DIR").map(PathBuf::from);
    if let Some(v) = var("DEMOVIEWER_TRACKING_KEY") {
        // The value is a secret: never in the message.
        let key = crate::seal::Key::from_hex(&v)
            .unwrap_or_else(|_| panic!("DEMOVIEWER_TRACKING_KEY is not 64 hex digits"));
        cfg.tracking_key = Some(key);
    }
    if let Some(v) = var("DEMOVIEWER_REDIRECT_HOSTS") {
        cfg.redirect_hosts = v
            .split(',')
            .map(|h| h.trim().to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
    }
    if let Some(v) = var("DEMOVIEWER_STEAM_API_KEY") {
        // The value is a secret: never in the message.
        let key = ApiKey::new(v.trim())
            .unwrap_or_else(|| panic!("DEMOVIEWER_STEAM_API_KEY is not 32 hex digits"));
        cfg.steam_api_key = Some(key);
    }
    if let Some(v) = var("DEMOVIEWER_FACEIT_API_KEY") {
        // The value is a secret: never in the message.
        let key = FaceitKey::new(v.trim()).unwrap_or_else(|| {
            panic!(
                "DEMOVIEWER_FACEIT_API_KEY is not 8 to 128 printable characters without whitespace"
            )
        });
        cfg.faceit_api_key = Some(key);
    }
    if let Some(v) = var("DEMOVIEWER_CF_BEACON_TOKEN") {
        let token = v.trim();
        if token.len() > 64 || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
            panic!("DEMOVIEWER_CF_BEACON_TOKEN is not 1 to 64 letters and digits");
        }
        cfg.cf_beacon_token = Some(token.to_owned());
    }
    cfg.gsc_token = var("DEMOVIEWER_GSC_TOKEN").map(|v| v.trim().to_owned());
    if let Some(v) = var("DEMOVIEWER_INDEXNOW_KEY") {
        let key = v.trim();
        if !key.is_empty() {
            if !(8..=128).contains(&key.len())
                || !key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            {
                panic!("DEMOVIEWER_INDEXNOW_KEY is not 8 to 128 letters, digits and hyphens");
            }
            cfg.indexnow_key = Some(key.to_owned());
        }
    }
    if let Some(v) = var("DEMOVIEWER_INDEXNOW_URL") {
        cfg.indexnow_url = Url::parse(v.trim())
            .unwrap_or_else(|e| panic!("DEMOVIEWER_INDEXNOW_URL is not a URL: {e}"));
    }
    cfg
}

/// An on/off variable: `1`, `true`, `on` or `yes`, or `0`, `false`, `off` or `no`, in any case.
///
/// # Panics
/// On anything else: a typo should stop the server rather than pick a side.
fn switch(name: &str, value: &str) -> bool {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => true,
        "0" | "false" | "off" | "no" => false,
        _ => panic!("{name}={value:?} is not on (1/true/on/yes) or off (0/false/off/no)"),
    }
}

/// `v` as an http(s) URL with a host, its path ending in `/` so that a path joined to it stays
/// under it (`https://example.com/dv` → `https://example.com/dv/`).
fn base_url(v: &str) -> Result<Url, String> {
    let mut url = Url::parse(v.trim()).map_err(|e| e.to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err("not an http or https address".into());
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// With nothing set, the defaults. Three are pinned for what depends on them outside this
    /// crate; a limit's value is not (the tests of a limit read it from the config).
    #[test]
    fn defaults_when_nothing_is_set() {
        assert_eq!(from_vars(|_| None), Config::default());
        let d = Config::default();
        // The web app's dev server and its e2e runs reach a local server here.
        assert_eq!(d.port, 8095);
        // The web app resumes an upload in chunks of its own CHUNK_SIZE (web/src/api/upload.ts)
        // when it does not have the chunk size the start answered.
        assert_eq!(d.chunk_bytes, 32 * 1024 * 1024);
        assert_eq!(d.cache_bytes, None, "packs are kept forever");
        assert_eq!(d.import_dir, None);
    }

    #[test]
    fn variables_override_and_empty_means_default() {
        let cfg = from_vars(|name| match name {
            "DEMOVIEWER_PORT" => Some("9000".into()),
            "DEMOVIEWER_DATA" => Some("/srv/dv".into()),
            "DEMOVIEWER_WEB" => Some("".into()),
            "DEMOVIEWER_CACHE_BYTES" => Some(" 1000 ".into()),
            "DEMOVIEWER_IMPORT_DIR" => Some("/corpus".into()),
            "DEMOVIEWER_REDIRECT_HOSTS" => Some(" CS.skunk.to, ,old.example ".into()),
            _ => None,
        });
        assert_eq!(cfg.redirect_hosts, ["cs.skunk.to", "old.example"]);
        assert_eq!(cfg.import_dir, Some(PathBuf::from("/corpus")));
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.cache_bytes, Some(1000));
        assert_eq!(cfg.data_dir, PathBuf::from("/srv/dv"));
        assert_eq!(cfg.web_dir, PathBuf::from("./static"));
        assert_eq!(cfg.assets_dir, PathBuf::from("./assets"));
    }

    #[test]
    fn a_steam_key_is_read_and_hidden() {
        // Made at run time: a literal shaped like a key reads as a leaked one to secret scanners.
        let hex = "0123456789ABCDEF".repeat(2);
        let cfg =
            from_vars(|name| (name == "DEMOVIEWER_STEAM_API_KEY").then(|| format!(" {hex} ")));
        assert_eq!(cfg.steam_api_key, ApiKey::new(&hex));
        assert!(!format!("{cfg:?}").contains(&hex));
        assert_eq!(Config::default().steam_api_key, None);
    }

    #[test]
    fn a_tracking_key_is_read_and_hidden_and_a_bad_one_is_fatal() {
        let hex = "0123456789abcdef".repeat(4);
        let cfg = from_vars(|name| (name == "DEMOVIEWER_TRACKING_KEY").then(|| hex.clone()));
        assert_eq!(cfg.tracking_key, crate::seal::Key::from_hex(&hex).ok());
        assert!(!format!("{cfg:?}").contains(&hex));
        let bad = "0123456789abcdef".repeat(3);
        let stopped = std::panic::catch_unwind(|| {
            from_vars(|name| (name == "DEMOVIEWER_TRACKING_KEY").then(|| bad.clone()))
        })
        .unwrap_err();
        let msg = stopped.downcast_ref::<&str>().copied().unwrap_or_default();
        assert!(
            msg.contains("DEMOVIEWER_TRACKING_KEY") && !msg.contains(&bad),
            "{msg}"
        );
    }

    #[test]
    fn a_faceit_key_is_read_and_hidden_and_the_data_api_is_faceits() {
        // Made at run time: a literal shaped like a key reads as a leaked one to secret scanners.
        let key = ["0f1e2d3c", "4b5a", "4697", "8a7b", "6c5d4e3f2a1b"].join("-");
        let cfg =
            from_vars(|name| (name == "DEMOVIEWER_FACEIT_API_KEY").then(|| format!(" {key} ")));
        assert_eq!(cfg.faceit_api_key, FaceitKey::new(&key));
        assert!(!format!("{cfg:?}").contains(&key));
        assert_eq!(Config::default().faceit_api_key, None);
        assert_eq!(
            Config::default().faceit_data_api.as_str(),
            "https://open.faceit.com/data/v4/"
        );
    }

    #[test]
    fn a_bad_faceit_key_is_fatal_and_not_shown() {
        let bad = "not a key: it has spaces";
        let stopped = std::panic::catch_unwind(|| {
            from_vars(|name| (name == "DEMOVIEWER_FACEIT_API_KEY").then(|| bad.into()))
        })
        .unwrap_err();
        let msg = stopped
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| stopped.downcast_ref::<String>().map(String::as_str))
            .unwrap();
        assert!(
            msg.contains("DEMOVIEWER_FACEIT_API_KEY") && !msg.contains(bad),
            "{msg}"
        );
    }

    #[test]
    fn a_bad_steam_key_is_fatal_and_not_shown() {
        let bad = "not-a-key-0123456789abcdef012345";
        let stopped = std::panic::catch_unwind(|| {
            from_vars(|name| (name == "DEMOVIEWER_STEAM_API_KEY").then(|| bad.into()))
        })
        .unwrap_err();
        let msg = stopped
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| stopped.downcast_ref::<String>().map(String::as_str))
            .unwrap();
        assert!(
            msg.contains("DEMOVIEWER_STEAM_API_KEY") && !msg.contains(bad),
            "{msg}"
        );
    }

    #[test]
    #[should_panic(expected = "DEMOVIEWER_PORT")]
    fn a_bad_port_is_fatal() {
        from_vars(|name| (name == "DEMOVIEWER_PORT").then(|| "eighty".into()));
    }

    #[test]
    #[should_panic(expected = "DEMOVIEWER_CACHE_BYTES")]
    fn a_bad_cache_limit_is_fatal() {
        from_vars(|name| (name == "DEMOVIEWER_CACHE_BYTES").then(|| "20G".into()));
    }

    #[test]
    fn previews_are_on_and_there_is_no_public_url_by_default() {
        let d = Config::default();
        assert!(d.site.previews);
        assert_eq!(d.public_url, None);
    }

    #[test]
    fn switches_take_the_usual_spellings() {
        for (v, on) in [
            ("1", true),
            ("true", true),
            ("On", true),
            (" yes ", true),
            ("0", false),
            ("false", false),
            ("OFF", false),
            ("no", false),
        ] {
            let cfg = from_vars(|name| (name == "DEMOVIEWER_PREVIEWS").then(|| v.into()));
            assert_eq!(cfg.site.previews, on, "{v:?}");
        }
    }

    #[test]
    #[should_panic(expected = "DEMOVIEWER_PREVIEWS")]
    fn a_bad_switch_is_fatal() {
        from_vars(|name| (name == "DEMOVIEWER_PREVIEWS").then(|| "maybe".into()));
    }

    /// The public URL always ends in `/`, so a path joined to it stays under it.
    #[test]
    fn the_public_url_is_a_base_for_links() {
        for (v, base) in [
            ("https://cs.skunk.to", "https://cs.skunk.to/"),
            ("https://cs.skunk.to/", "https://cs.skunk.to/"),
            ("http://192.0.2.10:8080/dv", "http://192.0.2.10:8080/dv/"),
        ] {
            let cfg = from_vars(|name| (name == "DEMOVIEWER_PUBLIC_URL").then(|| v.into()));
            let url = cfg.public_url.expect(v);
            assert_eq!(url.as_str(), base);
            assert_eq!(
                url.join("og/x.png").unwrap().as_str(),
                format!("{base}og/x.png")
            );
        }
    }

    #[test]
    fn share_codes_need_a_gcbot_url() {
        assert_eq!(Config::default().gcbot_url, None);
        let cfg =
            from_vars(|name| (name == "DEMOVIEWER_GCBOT_URL").then(|| "http://gcbot:8097".into()));
        let url = cfg.gcbot_url.unwrap();
        assert_eq!(
            url.join("resolve").unwrap().as_str(),
            "http://gcbot:8097/resolve"
        );
        let bad = std::panic::catch_unwind(|| {
            from_vars(|name| (name == "DEMOVIEWER_GCBOT_URL").then(|| "gcbot:8097".into()))
        });
        assert!(bad.is_err());
    }

    #[test]
    fn a_public_url_that_is_not_a_web_address_is_fatal() {
        for bad in [
            "cs.skunk.to",
            "ftp://cs.skunk.to",
            "https://",
            "mailto:a@b.c",
        ] {
            let started = std::panic::catch_unwind(|| {
                from_vars(|name| (name == "DEMOVIEWER_PUBLIC_URL").then(|| bad.into()))
            });
            assert!(started.is_err(), "{bad:?} was accepted");
        }
    }

    #[test]
    fn the_beacon_and_verification_tokens_are_read_and_empty_means_none() {
        let d = Config::default();
        assert_eq!((d.cf_beacon_token, d.gsc_token), (None, None));
        let cfg = from_vars(|name| match name {
            "DEMOVIEWER_CF_BEACON_TOKEN" => Some("".into()),
            "DEMOVIEWER_GSC_TOKEN" => Some("  ".into()),
            _ => None,
        });
        assert_eq!((cfg.cf_beacon_token, cfg.gsc_token), (None, None));
        let cfg = from_vars(|name| match name {
            "DEMOVIEWER_CF_BEACON_TOKEN" => Some("abc".into()),
            "DEMOVIEWER_GSC_TOKEN" => Some("abc".into()),
            _ => None,
        });
        assert_eq!(cfg.cf_beacon_token.as_deref(), Some("abc"));
        assert_eq!(cfg.gsc_token.as_deref(), Some("abc"));
    }

    #[test]
    fn the_indexnow_key_is_validated_and_empty_means_none() {
        let with = |v: &str| {
            let v = v.to_owned();
            from_vars(move |name| (name == "DEMOVIEWER_INDEXNOW_KEY").then(|| v.clone()))
        };
        assert_eq!(Config::default().indexnow_key, None);
        assert_eq!(
            Config::default().indexnow_url.as_str(),
            crate::indexnow::ENDPOINT
        );
        assert_eq!(with("").indexnow_key, None);
        assert_eq!(with("  ").indexnow_key, None);
        assert_eq!(
            with(" abcd-1234 ").indexnow_key.as_deref(),
            Some("abcd-1234")
        );
        let long = "a".repeat(128);
        assert_eq!(with(&long).indexnow_key.as_deref(), Some(long.as_str()));
        for bad in ["short", "abcd efgh1234", "abcd_efgh1234", "abcdéfgh1234"] {
            assert!(std::panic::catch_unwind(|| with(bad)).is_err(), "{bad:?}");
        }
        assert!(std::panic::catch_unwind(|| with(&"a".repeat(129))).is_err());
    }

    #[test]
    fn the_indexnow_url_can_be_overridden() {
        let cfg = from_vars(|name| {
            (name == "DEMOVIEWER_INDEXNOW_URL").then(|| "http://127.0.0.1:9/x".into())
        });
        assert_eq!(cfg.indexnow_url.as_str(), "http://127.0.0.1:9/x");
    }

    /// The beacon token lands inside a single-quoted attribute, so only letters and digits pass.
    #[test]
    fn a_beacon_token_that_is_not_alphanumeric_is_fatal() {
        for bad in ["a'b", "a b", "a\"b", "<x>", &"a".repeat(65)] {
            let started = std::panic::catch_unwind(|| {
                from_vars(|name| (name == "DEMOVIEWER_CF_BEACON_TOKEN").then(|| bad.into()))
            });
            assert!(started.is_err(), "{bad:?} was accepted");
        }
    }
}
