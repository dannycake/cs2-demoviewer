//! Per-client limits in a sliding one-hour window (the attempts and the ingests of
//! [`crate::admission`]), and who the client is: its address, believed from forwarding headers
//! only behind a trusted proxy.

use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv6Addr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::http::HeaderMap;

const WINDOW: Duration = Duration::from_secs(3600);
/// The fewest tracked keys at which a check sweeps out the ones with no hit in the last hour.
/// After a sweep the next waits until the map has doubled (code-health review 2026-10-26: past
/// this many clients active in the hour, every check swept them all, under the one lock), so a
/// sweep's cost is spread over the new keys that grew the map to it.
const SWEEP_AT: usize = 4096;
/// How many times one client's limit an IPv6 /48 may use across its /64s.
pub const PER_48: u32 = 10;

/// Allows `per_hour` hits per client in any rolling hour. IPv6 clients are counted per /64
/// (one subscriber's allocation, so rotating the low bits does not buy a fresh budget), and an
/// IPv4-mapped IPv6 address counts as its IPv4 address. A /48, what one tunnel-broker account
/// or one site gets, holds 65,536 /64s, so it also has a budget of its own: [`PER_48`] times
/// `per_hour` across all of them (code-health review 2026-10-26). A household or an office
/// rarely spreads over more than a few /64s; a mobile carrier puts many subscribers in one /48,
/// but ten clients' worth an hour is far above this site's use.
pub struct RateLimiter {
    per_hour: u32,
    hits: Mutex<Hits>,
}

struct Hits {
    by_key: HashMap<Key, VecDeque<Instant>>,
    /// The size at which the next check sweeps.
    sweep_at: usize,
}

/// What hits are counted under: a client ([`bucket`]), or the IPv6 /48 a client is in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Key {
    Client(IpAddr),
    Block48(Ipv6Addr),
}

impl RateLimiter {
    pub fn new(per_hour: u32) -> Self {
        RateLimiter {
            per_hour,
            hits: Mutex::new(Hits {
                by_key: HashMap::new(),
                sweep_at: SWEEP_AT,
            }),
        }
    }

    /// The keys `ip`'s hits count under, each with its limit.
    fn keys(&self, ip: IpAddr) -> Vec<(Key, usize)> {
        let client = bucket(ip);
        let mut keys = vec![(Key::Client(client), self.per_hour as usize)];
        if let IpAddr::V6(v6) = client {
            let s = v6.segments();
            let block = Ipv6Addr::new(s[0], s[1], s[2], 0, 0, 0, 0, 0);
            keys.push((
                Key::Block48(block),
                self.per_hour.saturating_mul(PER_48) as usize,
            ));
        }
        keys
    }

    /// Records a hit by `ip` at `now` and returns true, or returns false (recording nothing)
    /// when `ip`, or its IPv6 /48, already has its limit of hits in the hour before `now`.
    pub fn check(&self, ip: IpAddr, now: Instant) -> bool {
        let keys = self.keys(ip);
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        hits.sweep(now);
        for &(key, limit) in &keys {
            if let Some(q) = hits.by_key.get_mut(&key) {
                prune(q, now);
                if q.len() >= limit {
                    return false;
                }
            }
        }
        for (key, _) in keys {
            hits.by_key.entry(key).or_default().push_back(now);
        }
        true
    }

    /// Takes back the hit [`RateLimiter::check`] recorded for `ip` at `at`, for one that
    /// turned out not to need it.
    pub fn refund(&self, ip: IpAddr, at: Instant) {
        let keys = self.keys(ip);
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        for (key, _) in keys {
            if let Some(q) = hits.by_key.get_mut(&key) {
                if let Some(i) = q.iter().rposition(|&t| t == at) {
                    q.remove(i);
                }
            }
        }
    }
}

impl Hits {
    /// Drops the keys with no hit in the hour before `now`, once the map has reached
    /// `sweep_at`, and sets the next sweep at twice what is left (at least [`SWEEP_AT`]).
    fn sweep(&mut self, now: Instant) {
        if self.by_key.len() < self.sweep_at {
            return;
        }
        self.by_key.retain(|_, q| {
            prune(q, now);
            !q.is_empty()
        });
        self.sweep_at = self.by_key.len().saturating_mul(2).max(SWEEP_AT);
    }
}

/// Drops hits that are an hour or more older than `now`.
fn prune(q: &mut VecDeque<Instant>, now: Instant) {
    while q
        .front()
        .is_some_and(|&t| now.saturating_duration_since(t) >= WINDOW)
    {
        q.pop_front();
    }
}

/// The address a client is counted under: itself for IPv4, its /64 for IPv6, the IPv4
/// address for an IPv4-mapped one.
pub fn bucket(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => IpAddr::V4(v4),
            None => {
                let s = v6.segments();
                IpAddr::V6(Ipv6Addr::new(s[0], s[1], s[2], s[3], 0, 0, 0, 0))
            }
        },
    }
}

/// An address block (`10.0.0.0/8`, `fd00::/8`, or a single address) for the list of proxies
/// whose forwarding headers are believed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cidr {
    pub addr: IpAddr,
    pub prefix: u8,
}

impl Cidr {
    /// Whether `ip` is inside the block; an IPv4-mapped IPv6 address is matched as IPv4.
    pub fn contains(&self, ip: IpAddr) -> bool {
        match (self.addr, ip) {
            (IpAddr::V4(n), IpAddr::V4(i)) => {
                let p = u32::from(self.prefix.min(32));
                p == 0 || (u32::from(n) >> (32 - p)) == (u32::from(i) >> (32 - p))
            }
            (IpAddr::V6(n), IpAddr::V6(i)) => {
                let p = u32::from(self.prefix.min(128));
                p == 0 || (u128::from(n) >> (128 - p)) == (u128::from(i) >> (128 - p))
            }
            (IpAddr::V4(_), IpAddr::V6(i)) => i
                .to_ipv4_mapped()
                .is_some_and(|v4| self.contains(IpAddr::V4(v4))),
            (IpAddr::V6(_), IpAddr::V4(_)) => false,
        }
    }
}

impl std::str::FromStr for Cidr {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let s = s.trim();
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a, Some(p)),
            None => (s, None),
        };
        let addr: IpAddr = addr
            .parse()
            .map_err(|_| format!("{s:?} is not an address block"))?;
        let max = if addr.is_ipv4() { 32 } else { 128 };
        let prefix = match prefix {
            Some(p) => p
                .trim()
                .parse::<u8>()
                .ok()
                .filter(|&n| n <= max)
                .ok_or_else(|| format!("{s:?} has a bad prefix length"))?,
            None => max,
        };
        Ok(Cidr { addr, prefix })
    }
}

/// Parses a comma-separated list of blocks; empty entries are skipped.
pub fn parse_cidrs(list: &str) -> Result<Vec<Cidr>, String> {
    list.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::parse)
        .collect()
}

/// The client's address. Forwarding headers are believed only when the TCP peer is inside one
/// of the `trusted` blocks (the Cloudflare tunnel or a reverse proxy on a known address): then
/// `CF-Connecting-IP`, else the last `X-Forwarded-For` entry (the one that proxy appended),
/// else the peer. From any other peer the headers are ignored, because anyone reaching the
/// port directly could forge them to dodge the rate limit. A header that does not parse as an
/// address is skipped.
pub fn client_ip(headers: &HeaderMap, peer: SocketAddr, trusted: &[Cidr]) -> IpAddr {
    if !trusted.iter().any(|c| c.contains(peer.ip())) {
        return peer.ip();
    }
    let header = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    header("cf-connecting-ip")
        .and_then(|v| v.trim().parse().ok())
        .or_else(|| {
            header("x-forwarded-for")
                .and_then(|v| v.rsplit(',').next())
                .and_then(|v| v.trim().parse().ok())
        })
        .unwrap_or(peer.ip())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn eleventh_call_within_an_hour_is_refused() {
        let rl = RateLimiter::new(10);
        let t0 = Instant::now();
        for i in 0..10 {
            assert!(
                rl.check(ip("203.0.113.7"), t0 + Duration::from_secs(i * 60)),
                "call {} refused",
                i + 1
            );
        }
        assert!(!rl.check(ip("203.0.113.7"), t0 + Duration::from_secs(59 * 60)));
        // Another address has its own budget.
        assert!(rl.check(ip("203.0.113.8"), t0 + Duration::from_secs(59 * 60)));
    }

    #[test]
    fn calls_are_allowed_again_after_an_hour() {
        let rl = RateLimiter::new(10);
        let t0 = Instant::now();
        for _ in 0..10 {
            assert!(rl.check(ip("203.0.113.7"), t0));
        }
        // Refused attempts do not count, so they do not push the window out.
        assert!(!rl.check(ip("203.0.113.7"), t0 + HOUR / 2));
        assert!(!rl.check(ip("203.0.113.7"), t0 + HOUR - Duration::from_secs(1)));
        assert!(rl.check(ip("203.0.113.7"), t0 + HOUR));
    }

    #[test]
    fn ipv6_shares_one_budget_per_64_and_mapped_v4_is_v4() {
        let rl = RateLimiter::new(2);
        let t0 = Instant::now();
        assert!(rl.check(ip("2001:db8:1:2::1"), t0));
        assert!(rl.check(ip("2001:db8:1:2:ffff::9"), t0));
        assert!(!rl.check(ip("2001:db8:1:2::77"), t0));
        assert!(rl.check(ip("2001:db8:1:3::1"), t0));

        assert!(rl.check(ip("198.51.100.4"), t0));
        assert!(rl.check(ip("::ffff:198.51.100.4"), t0));
        assert!(!rl.check(ip("198.51.100.4"), t0));
    }

    /// A /48 has [`PER_48`] times a client's budget across its /64s, so rotating through the
    /// 65,536 /64s of one tunnel-broker allocation buys ten clients' worth, not 65,536; another
    /// /48 has its own. A refund gives the hit back to both.
    #[test]
    fn an_ipv6_48_has_ten_clients_worth_across_its_64s() {
        let rl = RateLimiter::new(2);
        let t0 = Instant::now();
        let in_48 = |n: u16| IpAddr::V6(Ipv6Addr::new(0x2001, 0xdb8, 7, n, 0, 0, 0, 1));
        for n in 0..PER_48 as u16 {
            assert!(rl.check(in_48(n), t0), "/64 {n}");
            assert!(rl.check(in_48(n), t0), "/64 {n}");
        }
        assert!(!rl.check(in_48(100), t0), "a fresh /64 of a spent /48");
        assert!(rl.check(ip("2001:db8:8::1"), t0), "another /48");
        rl.refund(in_48(3), t0);
        assert!(rl.check(in_48(100), t0), "a hit given back to the /48");
        assert!(!rl.check(in_48(3), t0), "and taken by another /64");
        assert!(rl.check(in_48(100), t0 + HOUR), "an hour on");
    }

    /// Past [`SWEEP_AT`] clients active in the hour, a check sweeps once and the next sweep
    /// waits until the map has doubled: it used to sweep every client on every check, as a
    /// sweep that drops nothing never brought the map back under the threshold.
    #[test]
    fn sweeps_wait_until_the_map_has_doubled() {
        let rl = RateLimiter::new(1);
        let t0 = Instant::now();
        let client = |n: u32| IpAddr::V4(std::net::Ipv4Addr::from(0x0a00_0000 + n));
        let state = |rl: &RateLimiter| {
            let hits = rl.hits.lock().unwrap();
            (hits.by_key.len(), hits.sweep_at)
        };
        for n in 0..SWEEP_AT as u32 {
            assert!(rl.check(client(n), t0));
        }
        assert_eq!(state(&rl), (SWEEP_AT, SWEEP_AT));
        // Every client is still active: the sweep drops nothing.
        assert!(rl.check(client(SWEEP_AT as u32), t0));
        assert_eq!(state(&rl), (SWEEP_AT + 1, 2 * SWEEP_AT));
        for n in SWEEP_AT as u32 + 1..2 * SWEEP_AT as u32 {
            assert!(rl.check(client(n), t0));
        }
        assert_eq!(state(&rl), (2 * SWEEP_AT, 2 * SWEEP_AT));
        // An hour on, the next check sweeps every one of them out.
        assert!(rl.check(client(0), t0 + HOUR));
        assert_eq!(state(&rl), (1, SWEEP_AT));
    }

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }

    const PEER: SocketAddr =
        SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::new(10, 0, 0, 2)), 5555);

    fn trusted() -> Vec<Cidr> {
        parse_cidrs("10.0.0.0/8, ::1").unwrap()
    }

    #[test]
    fn client_ip_prefers_cf_connecting_ip() {
        let h = headers(&[
            ("cf-connecting-ip", "198.51.100.1"),
            ("x-forwarded-for", "198.51.100.2, 10.0.0.1"),
        ]);
        assert_eq!(client_ip(&h, PEER, &trusted()), ip("198.51.100.1"));
    }

    #[test]
    fn client_ip_takes_the_last_forwarded_for_entry() {
        let h = headers(&[(
            "x-forwarded-for",
            " 2001:db8::5 , 198.51.100.2, 2001:db8::9 ",
        )]);
        assert_eq!(client_ip(&h, PEER, &trusted()), ip("2001:db8::9"));
    }

    #[test]
    fn client_ip_falls_back_to_the_peer() {
        assert_eq!(client_ip(&HeaderMap::new(), PEER, &trusted()), PEER.ip());
        // Unparseable headers are skipped, not trusted.
        let h = headers(&[("cf-connecting-ip", "nope"), ("x-forwarded-for", "")]);
        assert_eq!(client_ip(&h, PEER, &trusted()), PEER.ip());
        let h = headers(&[
            ("cf-connecting-ip", "nope"),
            ("x-forwarded-for", "198.51.100.3"),
        ]);
        assert_eq!(client_ip(&h, PEER, &trusted()), ip("198.51.100.3"));
    }

    #[test]
    fn client_ip_ignores_headers_from_an_untrusted_peer() {
        let h = headers(&[
            ("cf-connecting-ip", "198.51.100.1"),
            ("x-forwarded-for", "198.51.100.2"),
        ]);
        assert_eq!(client_ip(&h, PEER, &[]), PEER.ip());
        let lan = parse_cidrs("192.168.0.0/16").unwrap();
        assert_eq!(client_ip(&h, PEER, &lan), PEER.ip());
        // The mapped form of a trusted IPv4 peer is trusted too.
        let mapped = SocketAddr::new("::ffff:10.0.0.2".parse().unwrap(), 1);
        assert_eq!(client_ip(&h, mapped, &trusted()), ip("198.51.100.1"));
    }

    #[test]
    fn cidr_parsing_and_matching() {
        let c: Cidr = "172.16.0.0/12".parse().unwrap();
        assert!(c.contains(ip("172.31.255.255")));
        assert!(!c.contains(ip("172.32.0.0")));
        assert!("127.0.0.1"
            .parse::<Cidr>()
            .unwrap()
            .contains(ip("127.0.0.1")));
        assert!(!"127.0.0.1"
            .parse::<Cidr>()
            .unwrap()
            .contains(ip("127.0.0.2")));
        assert!("fd00::/8".parse::<Cidr>().unwrap().contains(ip("fdab::1")));
        assert!("0.0.0.0/0".parse::<Cidr>().unwrap().contains(ip("8.8.8.8")));
        assert!("10.0.0.0/33".parse::<Cidr>().is_err());
        assert!("ten.0.0.0/8".parse::<Cidr>().is_err());
        assert_eq!(parse_cidrs(" , ").unwrap(), vec![]);
    }

    #[test]
    fn a_refunded_ingest_no_longer_counts() {
        let rl = RateLimiter::new(1);
        let t0 = Instant::now();
        assert!(rl.check(ip("198.51.100.1"), t0));
        assert!(!rl.check(ip("198.51.100.1"), t0));
        rl.refund(ip("198.51.100.1"), t0);
        let t1 = t0 + Duration::from_secs(1);
        assert!(rl.check(ip("198.51.100.1"), t1));
        // Nothing recorded at that time, or for that client: nothing changes.
        rl.refund(ip("198.51.100.1"), t0);
        rl.refund(ip("198.51.100.2"), t1);
        assert!(!rl.check(ip("198.51.100.1"), t1));
    }
}
