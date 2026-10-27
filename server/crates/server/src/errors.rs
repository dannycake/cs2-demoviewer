//! What the modules share about failures: an error's whole cause chain as text, and blocking
//! work whose panic comes back as an error.

use std::error::Error;
use std::fmt;

/// `e` and its whole cause chain, `: `-separated: reqwest's own message leaves out why
/// ("connection refused").
pub fn with_causes(e: &dyn Error) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(cause) = source {
        msg.push_str(": ");
        msg.push_str(&cause.to_string());
        source = cause.source();
    }
    msg
}

/// Runs `f` on tokio's blocking pool. A panic in it (or the runtime shutting down under it)
/// comes back as [`Panicked`], which `?` turns into the caller's error: a 500 for a handler, a
/// failed job for the runner.
pub(crate) async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Panicked> {
    tokio::task::spawn_blocking(f).await.map_err(Panicked)
}

/// Blocking work that did not return; see [`blocking`].
#[derive(Debug)]
pub(crate) struct Panicked(tokio::task::JoinError);

impl fmt::Display for Panicked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "a blocking task failed: {}", self.0)
    }
}

/// A job's error: the panic is logged, and the demo's link says only that it was internal (it
/// used to say "the parser panicked" whatever had: a hash, a rename, an eviction).
impl From<Panicked> for String {
    fn from(e: Panicked) -> String {
        tracing::error!(error = %e, "a job step failed");
        "internal error: processing the demo failed".to_owned()
    }
}
