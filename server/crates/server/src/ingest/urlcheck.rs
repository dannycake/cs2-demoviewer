//! The SSRF guard: which URLs the ingest may fetch, and which addresses it may never connect to.
//!
//! A URL passes [`check_url`] when its scheme is http or https and its host is one of Valve's
//! replay servers (`replayN.valve.net`) or one of FACEIT's demo hosts ([`FACEIT_DEMO_HOSTS`]),
//! each named exactly and nothing else (the owner's ruling 2026-10-24, widened on 2026-10-31
//! from Valve alone to FACEIT's hosts too, so the server only ever fetches from those two).
//! That takes no DNS, so the API checks a posted URL with it alone, and the host a request
//! names never reaches a resolver at post time. `download` checks every hop, the first and
//! each redirect, the same way, so a redirect off those hosts is refused; then resolves the hop's host and refuses it when any address is private
//! ([`Guard::check_addresses`]), before the request; and checks the addresses again at connect
//! time.

use std::fmt;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};
use std::time::Duration;

use tokio::sync::Semaphore;
use url::{Host, Url};

/// Why a URL was refused, or why fetching it failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UrlError {
    /// Not an http or https URL.
    Scheme,
    /// No host, or a bare name without a dot (`localhost`, `nas`).
    Host,
    /// Not a Valve replay host (`replayN.valve.net`) or a FACEIT demo host.
    NotAllowed,
    /// The host is, or resolves to, a private, loopback, link-local, CGNAT or unspecified address.
    PrivateAddress,
    /// A redirect that cannot be followed: too many hops, or no usable `Location`.
    Redirect(String),
    /// The body is larger than the caller's limit.
    TooLarge,
    /// The final response had this non-2xx status.
    Http(u16),
    /// DNS, connection, TLS, timeout or disk failure.
    Io(String),
}

impl fmt::Display for UrlError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UrlError::Scheme => f.write_str("only http and https URLs are accepted"),
            UrlError::Host => f.write_str("the URL needs a public host name"),
            UrlError::NotAllowed => {
                f.write_str("only Valve replay links (http://replayN.valve.net/730/…)")?;
                if !FACEIT_DEMO_HOSTS.is_empty() {
                    f.write_str(" and FACEIT demo links")?;
                }
                f.write_str(" are accepted; upload the file or paste a share code instead")
            }
            UrlError::PrivateAddress => f.write_str("the URL points at a private or local address"),
            UrlError::Redirect(why) => write!(f, "redirect not followed: {why}"),
            UrlError::TooLarge => f.write_str("the file is larger than the size limit"),
            UrlError::Http(code @ (404 | 410)) => write!(
                f,
                "there is no demo at that link (HTTP {code}): it may have expired or been removed",
            ),
            UrlError::Http(code) => write!(f, "the server answered HTTP {code}"),
            UrlError::Io(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for UrlError {}

/// True for addresses the ingest must never connect to: 0.0.0.0/8, 10/8, 100.64/10, 127/8,
/// 169.254/16, 172.16/12, 192.168/16, multicast and 240/4 (reserved, broadcast); `::/96`
/// (`::`, `::1` and the deprecated IPv4-compatible block), fc00::/7, fe80::/10, fec0::/10,
/// multicast; and IPv4-mapped (`::ffff:a.b.c.d`) or NAT64 (`64:ff9b::a.b.c.d`) forms of any
/// private IPv4 address.
pub fn is_private(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => is_private_v6(v6),
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, ..] = ip.octets();
    a == 0 // "this network", including 0.0.0.0
        || a == 10
        || a == 127
        || (a == 100 && (64..128).contains(&b)) // CGNAT 100.64/10
        || (a == 169 && b == 254) // link-local, cloud metadata
        || (a == 172 && (16..32).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments 192.0.0.0/24
        || (a == 192 && b == 0 && c == 2) // TEST-NET-1
        || (a == 198 && (b == 18 || b == 19)) // benchmarking 198.18.0.0/15
        || (a == 198 && b == 51 && c == 100) // TEST-NET-2
        || (a == 203 && b == 0 && c == 113) // TEST-NET-3
        || a >= 224 // multicast 224/4, reserved 240/4, broadcast
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    let s = ip.segments();
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] {
        let [.., hi, lo] = s;
        return is_private_v4(Ipv4Addr::from((u32::from(hi) << 16) | u32::from(lo)));
    }
    if s[..3] == [0x64, 0xff9b, 1] {
        return true; // 64:ff9b:1::/48, local-use NAT64 (RFC 8215)
    }
    if s[0] == 0x2002 {
        // 6to4: the IPv4 address sits in bits 16..48.
        return is_private_v4(Ipv4Addr::from((u32::from(s[1]) << 16) | u32::from(s[2])));
    }
    s[..6] == [0; 6] // ::, ::1, ::a.b.c.d
        || (s[0] & 0xfe00) == 0xfc00 // unique local
        || (s[0] & 0xffc0) == 0xfe80 // link-local
        || (s[0] & 0xffc0) == 0xfec0 // site-local (deprecated)
        || (s[0] & 0xff00) == 0xff00 // multicast
}

/// Checks a URL a user handed in, or a download's first hop: scheme, host and the allowlist,
/// with no DNS. Returns the parsed URL.
pub fn check_url(url: &str) -> Result<Url, UrlError> {
    check_parsed(Url::parse(url).map_err(parse_error)?)
}

/// Checks the next hop of a redirect: `location` is resolved against the URL that answered
/// with it, then put through the same checks as [`check_url`].
pub fn check_redirect(from: &Url, location: &str) -> Result<Url, UrlError> {
    let next = from
        .join(location)
        .map_err(|e| UrlError::Redirect(format!("bad Location {location:?}: {e}")))?;
    check_parsed(next)
}

/// Which addresses a download refuses. Production refuses every private address; the test seam
/// `download_testing` lets named socket addresses (its own local test server) through and
/// resolves named hosts to given addresses without DNS. Every lookup (each hop's, and at
/// connect time) waits for one of [`LOOKUPS`].
#[derive(Debug, Default)]
pub(crate) struct Guard {
    exempt: Vec<SocketAddr>,
    hosts: Vec<(String, SocketAddr)>,
}

impl Guard {
    pub(crate) fn testing(exempt: &[SocketAddr], hosts: &[(String, SocketAddr)]) -> Guard {
        Guard {
            exempt: exempt.to_vec(),
            hosts: hosts.to_vec(),
        }
    }

    /// Refuses `url`, a hop that passed [`check_url`] or [`check_redirect`], when its host is
    /// or resolves to an address this guard refuses: what a download runs on every hop before
    /// its request.
    pub(crate) async fn check_addresses(&self, url: &Url) -> Result<(), UrlError> {
        let port = url.port_or_known_default().ok_or(UrlError::Scheme)?;
        let addrs = match url.host().ok_or(UrlError::Host)? {
            Host::Ipv4(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Ipv6(ip) => vec![SocketAddr::new(ip.into(), port)],
            Host::Domain(name) => resolve(self, name, port).await?,
        };
        if addrs.iter().any(|a| self.refuses(*a)) {
            return Err(UrlError::PrivateAddress);
        }
        Ok(())
    }

    /// Resolves `name` with the system resolver once one of [`LOOKUPS`] is free, giving up
    /// after [`RESOLVE_TIMEOUT`] (`TimedOut`).
    pub(crate) async fn lookup(&self, name: &str, port: u16) -> io::Result<Vec<SocketAddr>> {
        if let Some((_, addr)) = self.hosts.iter().find(|(host, _)| host == name) {
            return Ok(vec![SocketAddr::new(addr.ip(), port)]);
        }
        let name = name.to_owned();
        lookup_in(&LOOKUPS, RESOLVE_TIMEOUT, move || {
            (name.as_str(), port).to_socket_addrs().map(|a| a.collect())
        })
        .await
    }

    fn refuses(&self, addr: SocketAddr) -> bool {
        is_private(addr.ip()) && !self.exempt.contains(&addr)
    }

    /// For connect-time DNS answers, which carry no port.
    pub(crate) fn refuses_ip(&self, ip: IpAddr) -> bool {
        is_private(ip) && !self.exempt.iter().any(|a| a.ip() == ip)
    }
}

fn check_parsed(url: Url) -> Result<Url, UrlError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UrlError::Scheme);
    }
    let host = url.host().ok_or(UrlError::Host)?;
    if let Host::Domain(name) = host {
        // "localhost." is still a bare name.
        if !name.trim_end_matches('.').contains('.') {
            return Err(UrlError::Host);
        }
    }
    if !allowed(&url) {
        return Err(UrlError::NotAllowed);
    }
    Ok(url)
}

/// Whether the URL's host is one a download may fetch from: a Valve replay host or a FACEIT
/// demo host.
fn allowed(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|h| is_replay_host(h) || is_faceit_demo_host(h))
}

/// The hosts FACEIT serves match demos from, each named exactly (no suffix or wildcard
/// match). Empty until the API spike names them; until then no FACEIT URL is fetched.
pub const FACEIT_DEMO_HOSTS: &[&str] = &[];

/// Whether `host` is one of [`FACEIT_DEMO_HOSTS`], compared exactly and ignoring case.
pub fn is_faceit_demo_host(host: &str) -> bool {
    host_listed(FACEIT_DEMO_HOSTS, host)
}

/// Whether `host` equals one entry of `list`, ignoring ASCII case; a suffix or prefix match
/// never counts.
fn host_listed(list: &[&str], host: &str) -> bool {
    list.iter().any(|h| h.eq_ignore_ascii_case(host))
}

/// Whether `host` is one of Valve's replay servers, `replayN.valve.net`.
pub fn is_replay_host(host: &str) -> bool {
    host.strip_prefix("replay")
        .and_then(|h| h.strip_suffix(".valve.net"))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Longest a DNS lookup may take, waiting for a free lookup included (security audit
/// 2026-10-22).
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
/// System DNS lookups that may run at once, for downloads (each hop and at connect time). A
/// posted URL is not resolved ([`check_url`]): only a job that holds a fetch place and spent an
/// ingest gets this far.
static LOOKUPS: Semaphore = Semaphore::const_new(4);

/// Runs `resolve` on a blocking thread once `slots` has room, giving up after `timeout`.
/// `getaddrinfo` cannot be cancelled, so the thread keeps its place in `slots` until `resolve`
/// returns, even after the caller has given up: lookups that outlive their timeout still count
/// against the limit (security review 2026-10-22).
async fn lookup_in<F>(
    slots: &'static Semaphore,
    timeout: Duration,
    resolve: F,
) -> io::Result<Vec<SocketAddr>>
where
    F: FnOnce() -> io::Result<Vec<SocketAddr>> + Send + 'static,
{
    let run = async move {
        let slot = slots.acquire().await.map_err(io::Error::other)?;
        tokio::task::spawn_blocking(move || {
            let _slot = slot;
            resolve()
        })
        .await
        .map_err(io::Error::other)?
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "the lookup took too long"))?
}

async fn resolve(guard: &Guard, name: &str, port: u16) -> Result<Vec<SocketAddr>, UrlError> {
    let addrs = guard.lookup(name, port).await.map_err(|e| match e.kind() {
        io::ErrorKind::TimedOut => UrlError::Io(format!("resolving {name} took too long")),
        // The resolver's own text is logged, not shown.
        _ => {
            tracing::info!(name, error = %e, "cannot resolve");
            UrlError::Io(format!("cannot resolve {name}"))
        }
    })?;
    if addrs.is_empty() {
        return Err(UrlError::Io(format!("{name} has no addresses")));
    }
    Ok(addrs)
}

fn parse_error(e: url::ParseError) -> UrlError {
    match e {
        // "example.com/a.dem", "not a url": there is no scheme at all.
        url::ParseError::RelativeUrlWithoutBase => UrlError::Scheme,
        _ => UrlError::Host,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_lookup_keeps_its_slot_until_the_resolver_returns() {
        static SLOTS: Semaphore = Semaphore::const_new(1);
        let short = Duration::from_millis(50);
        let slow = || {
            std::thread::sleep(Duration::from_millis(300));
            Ok(vec![])
        };
        let err = lookup_in(&SLOTS, short, slow).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        // The caller gave up, but the resolver still runs and still holds the slot, so the
        // next lookup waits for it and gives up at its own deadline.
        assert_eq!(SLOTS.available_permits(), 0);
        let err = lookup_in(&SLOTS, short, || Ok(vec![])).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        // Once the slow resolver returns, its slot is free again.
        for _ in 0..100 {
            if SLOTS.available_permits() == 1 {
                break;
            }
            tokio::time::sleep(short).await;
        }
        assert_eq!(SLOTS.available_permits(), 1);
        let addr = SocketAddr::from(([192, 0, 2, 1], 80));
        let found = lookup_in(&SLOTS, Duration::from_secs(5), move || Ok(vec![addr])).await;
        assert_eq!(found.unwrap(), [addr]);
    }

    #[tokio::test]
    async fn the_system_resolver_answers_through_lookup() {
        let addrs = Guard::default().lookup("localhost", 80).await.unwrap();
        assert!(
            addrs.iter().all(|a| a.port() == 80 && a.ip().is_loopback()),
            "{addrs:?}"
        );
    }

    /// Today the FACEIT list is empty, so only Valve's replay hosts pass; a listed host is
    /// matched exactly, whatever its case, and never by suffix or prefix.
    #[test]
    fn faceit_demo_hosts_are_allowed_when_listed() {
        let allowed_host =
            |h: &str| allowed(&Url::parse(&format!("https://{h}/x.dem.gz")).unwrap());
        assert!(allowed_host("replay183.valve.net"));
        assert!(!allowed_host("demos.faceit.example"));
        assert!(!is_faceit_demo_host("demos.faceit.example"));

        let list = ["demos.faceit.example"];
        assert!(host_listed(&list, "demos.faceit.example"));
        assert!(host_listed(&list, "Demos.FACEIT.example"));
        assert!(!host_listed(&list, "evil.demos.faceit.example"));
        assert!(!host_listed(&list, "demos.faceit.example.evil.net"));
        assert!(!host_listed(&list, "xdemos.faceit.example"));
        assert!(!host_listed(&[], "demos.faceit.example"));
    }

    /// Every hop is checked against the same list: a redirect off it is refused, one back
    /// onto a replay host is followed.
    #[test]
    fn a_redirect_off_the_list_is_refused() {
        let from = Url::parse("https://replay183.valve.net/730/a.dem.bz2").unwrap();
        for off in [
            "https://cdn.example.com/a.dem",
            "https://replay183.valve.net.evil.net/a.dem",
            "http://127.0.0.1/a.dem",
        ] {
            assert_eq!(
                check_redirect(&from, off),
                Err(UrlError::NotAllowed),
                "{off}"
            );
        }
        assert!(check_redirect(&from, "https://replay9.valve.net/b.dem").is_ok());
    }
}
