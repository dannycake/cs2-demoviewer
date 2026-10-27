//! URL ingest: fetch a demo from a URL with the SSRF guard on every hop, then turn whatever
//! arrived (bzip2, gzip or a raw demo) into a plain `.dem`.
//!
//! The guard runs in two places. Before each request, the hop's URL goes through the same
//! check as a user-supplied one ([`check_url`], [`check_redirect`]: scheme, host, the
//! allowlist), then its host is resolved and refused when an address is private, which covers
//! IP literals and redirects. At connect time, the HTTP client resolves names through
//! [`GuardedResolver`], which refuses a private answer, so a name that resolved to a public
//! address during the check and to `127.0.0.1` a moment later (DNS rebinding) still never
//! reaches a socket.

mod decompress;
mod urlcheck;

use std::error::Error as StdError;
use std::fmt;
use std::net::SocketAddr;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::header::LOCATION;
use reqwest::StatusCode;
use tokio::io::AsyncWriteExt;
use url::Url;

pub use decompress::{decompress_to_dem_within, MAX_DEM_BYTES, MAX_INFLATE_RATIO};
pub use urlcheck::{check_redirect, check_url, is_private, is_replay_host, UrlError};

pub(crate) use decompress::{copy_capped, read_head};

use crate::errors::with_causes;
use urlcheck::Guard;

/// Redirects followed before giving up.
pub const MAX_REDIRECTS: usize = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// Longest silence between two reads of the body.
const READ_TIMEOUT: Duration = Duration::from_secs(30);
/// Ceiling for one request including its body, so a trickling server cannot hold the job
/// runner forever.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(15 * 60);
/// Slowest average a body may arrive at once [`SLOW_GRACE`] has passed: a server that keeps
/// a download slot busy for the whole [`TOTAL_TIMEOUT`] has to send over 200 MB doing it.
const MIN_BYTES_PER_SEC: u64 = 256 * 1024;
const SLOW_GRACE: Duration = Duration::from_secs(30);

/// Downloads `url` to `dest`, following up to [`MAX_REDIRECTS`] redirects and checking every
/// hop (the first included) with [`check_url`] or [`check_redirect`] and then its addresses.
/// The body streams to disk; more than `max_bytes` (announced or received) is
/// [`UrlError::TooLarge`]. Returns the bytes written. On any error after `dest` was created it
/// is removed.
pub async fn download(url: &Url, dest: &Path, max_bytes: u64) -> Result<u64, UrlError> {
    download_guarded(url, dest, max_bytes, Guard::default()).await
}

/// Test seam: [`download`] with connections to the listed socket addresses let through (a
/// local test server on 127.0.0.1) and each of `hosts` resolved to its address instead of by
/// DNS (a Valve replay host served by that test server). Every other hop is guarded exactly as
/// in `download`. Not for production use.
#[doc(hidden)]
pub async fn download_testing(
    url: &Url,
    dest: &Path,
    max_bytes: u64,
    exempt: &[SocketAddr],
    hosts: &[(String, SocketAddr)],
) -> Result<u64, UrlError> {
    download_guarded(url, dest, max_bytes, Guard::testing(exempt, hosts)).await
}

async fn download_guarded(
    url: &Url,
    dest: &Path,
    max_bytes: u64,
    guard: Guard,
) -> Result<u64, UrlError> {
    let guard = Arc::new(guard);
    let client = client(guard.clone())?;
    let mut current = check_url(url.as_str())?;
    let mut redirects = 0;
    let response = loop {
        guard.check_addresses(&current).await?;
        let response = client
            .get(current.clone())
            .send()
            .await
            .map_err(request_error)?;
        let status = response.status();
        if !is_redirect(status) {
            break response;
        }
        if redirects == MAX_REDIRECTS {
            return Err(UrlError::Redirect(format!(
                "more than {MAX_REDIRECTS} redirects"
            )));
        }
        redirects += 1;
        let location = response
            .headers()
            .get(LOCATION)
            .ok_or_else(|| {
                UrlError::Redirect(format!("HTTP {} without a Location", status.as_u16()))
            })?
            .to_str()
            .map_err(|_| UrlError::Redirect("Location is not valid text".into()))?;
        current = check_redirect(&current, location)?;
    };
    if !response.status().is_success() {
        return Err(UrlError::Http(response.status().as_u16()));
    }
    save(response, dest, max_bytes).await
}

fn is_redirect(status: StatusCode) -> bool {
    matches!(status.as_u16(), 301 | 302 | 303 | 307 | 308)
}

async fn save(
    mut response: reqwest::Response,
    dest: &Path,
    max_bytes: u64,
) -> Result<u64, UrlError> {
    if response.content_length().is_some_and(|n| n > max_bytes) {
        return Err(UrlError::TooLarge);
    }
    // The path and the OS error are logged; the demo's link says what the user can act on.
    let disk = |e: std::io::Error| {
        tracing::error!(path = %dest.display(), error = %e, "cannot write a download");
        UrlError::Io(if e.kind() == std::io::ErrorKind::StorageFull {
            crate::store::LOW_DISK.to_owned()
        } else {
            "the server could not store the download; try again later".to_owned()
        })
    };
    let mut file = tokio::fs::File::create(dest).await.map_err(disk)?;
    let started = Instant::now();
    let result = async {
        let mut total: u64 = 0;
        while let Some(chunk) = response.chunk().await.map_err(request_error)? {
            total += chunk.len() as u64;
            if total > max_bytes {
                return Err(UrlError::TooLarge);
            }
            if too_slow(total, started.elapsed()) {
                return Err(UrlError::Io(format!(
                    "the server is sending too slowly (under {} KB/s)",
                    MIN_BYTES_PER_SEC / 1024
                )));
            }
            file.write_all(&chunk).await.map_err(disk)?;
        }
        file.flush().await.map_err(disk)?;
        Ok(total)
    }
    .await;
    if result.is_err() {
        drop(file);
        let _ = tokio::fs::remove_file(dest).await;
    }
    result
}

/// True once [`SLOW_GRACE`] has passed and `bytes` in `elapsed` averages under
/// [`MIN_BYTES_PER_SEC`].
fn too_slow(bytes: u64, elapsed: Duration) -> bool {
    elapsed > SLOW_GRACE && (bytes as f64) < MIN_BYTES_PER_SEC as f64 * elapsed.as_secs_f64()
}

fn client(guard: Arc<Guard>) -> Result<reqwest::Client, UrlError> {
    reqwest::Client::builder()
        // Redirects are followed by hand so each hop goes through the guard.
        .redirect(reqwest::redirect::Policy::none())
        // A proxy would resolve names itself, out of the guard's reach.
        .no_proxy()
        .dns_resolver(Arc::new(GuardedResolver(guard)))
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .timeout(TOTAL_TIMEOUT)
        .user_agent(concat!("demoviewer/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            tracing::error!(error = %e, "cannot build the HTTP client");
            UrlError::Io("internal error: the server cannot fetch the URL".to_owned())
        })
}

/// The client's resolver: system DNS, but any private address in the answer fails the
/// lookup, so the connection is never attempted.
struct GuardedResolver(Arc<Guard>);

impl reqwest::dns::Resolve for GuardedResolver {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let guard = self.0.clone();
        Box::pin(async move {
            let addrs = guard.lookup(name.as_str(), 0).await?;
            if addrs.iter().any(|a| guard.refuses_ip(a.ip())) {
                return Err(Box::new(PrivateAddressRefused) as Box<dyn StdError + Send + Sync>);
            }
            Ok(Box::new(addrs.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

#[derive(Debug)]
struct PrivateAddressRefused;

impl fmt::Display for PrivateAddressRefused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("refused: the name resolves to a private address")
    }
}

impl StdError for PrivateAddressRefused {}

/// Maps a reqwest failure to [`UrlError`]: the resolver's refusal becomes `PrivateAddress`,
/// anything else `Io` with a fixed message for its kind. The whole cause chain (reqwest's own
/// message omits it), OS error text included, goes to the log rather than to the demo's link
/// (code-health review 2026-10-26).
fn request_error(e: reqwest::Error) -> UrlError {
    let mut causes = std::iter::successors(e.source(), |&cause| cause.source());
    let refused = causes.any(|cause| cause.is::<PrivateAddressRefused>());
    if refused {
        return UrlError::PrivateAddress;
    }
    tracing::info!(error = %with_causes(&e), "download request failed");
    let msg = if e.is_timeout() {
        "the replay server took too long to answer"
    } else if e.is_connect() {
        "cannot connect to the replay server"
    } else if e.is_body() || e.is_decode() {
        "the download was cut off"
    } else {
        "the replay server could not be reached"
    };
    UrlError::Io(msg.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The job runner spawns `download`: its future must be `Send`. This fails to compile
    /// otherwise.
    #[allow(dead_code)]
    fn futures_are_send(url: &Url, dest: &Path) {
        fn assert_send<T: Send>(_: T) {}
        assert_send(download(url, dest, 1));
    }

    #[test]
    fn a_trickle_is_too_slow_only_after_the_grace_period() {
        let secs = Duration::from_secs;
        assert!(!too_slow(0, secs(29)), "inside the grace period");
        assert!(!too_slow(MIN_BYTES_PER_SEC * 40, secs(40)));
        assert!(too_slow(MIN_BYTES_PER_SEC * 40 - 1, secs(40)));
        assert!(too_slow(1, secs(31)));
        assert!(!too_slow(500_000_000, secs(600)), "800 KB/s is fine");
    }

    /// The connect-time half of the guard, which the URL check cannot exercise: a name that
    /// resolves to loopback must fail in the resolver, before any connection.
    #[tokio::test]
    async fn resolver_refuses_private_answers_before_connecting() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = client(Arc::new(Guard::default())).unwrap();
        let err = client
            .get(format!("http://localhost:{port}/x.dem"))
            .send()
            .await
            .map_err(request_error)
            .unwrap_err();
        assert_eq!(err, UrlError::PrivateAddress);
        let accepted = tokio::time::timeout(Duration::from_millis(200), listener.accept()).await;
        assert!(
            accepted.is_err(),
            "a connection reached the private address"
        );
    }
}
