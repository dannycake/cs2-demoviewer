//! IndexNow: Bing, Yandex and others take "these URLs changed" as a batched POST, with a key
//! the site proves it owns by serving it at `/{key}.txt`. New match, event and profile pages
//! are queued as they appear and sent every [`FLUSH_EVERY`]. All of it is off without a key and
//! a public URL.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use axum::extract::State;
use axum::http::header;
use axum::response::{IntoResponse, Response};
use url::Url;

use crate::api::AppState;
use crate::events::valid_slug;
use crate::guides::GUIDES;
use crate::hidden::Hidden;
use crate::matches::MatchSummary;

/// The shared endpoint every IndexNow search engine passes submissions on to.
pub const ENDPOINT: &str = "https://api.indexnow.org/indexnow";
/// How often the queue is sent.
pub const FLUSH_EVERY: Duration = Duration::from_secs(300);
/// The most URLs one submission carries (the protocol's limit).
pub const MAX_URLS: usize = 10_000;

pub struct IndexNow {
    client: reqwest::Client,
    key: String,
    public_url: Url,
    endpoint: Url,
    hidden: Arc<Hidden>,
    /// Site-relative paths (`d/abc`) waiting to be sent.
    pending: Mutex<BTreeSet<String>>,
    /// Whether the last flush failed in a way worth one more try.
    retried: AtomicBool,
}

impl IndexNow {
    pub fn new(
        client: reqwest::Client,
        key: String,
        public_url: Url,
        endpoint: Url,
        hidden: Arc<Hidden>,
    ) -> Arc<IndexNow> {
        Arc::new(IndexNow {
            client,
            key,
            public_url,
            endpoint,
            hidden,
            pending: Mutex::default(),
            retried: AtomicBool::new(false),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeSet<String>> {
        self.pending.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Queues site-relative paths; one already queued is kept once.
    pub fn queue(&self, paths: impl IntoIterator<Item = String>) {
        self.lock().extend(paths);
    }

    /// Queues a finished match's page, its tournament's and its players' (not bots, not
    /// hidden ones). `canonical_id` is the id the pages use.
    pub fn queue_match(&self, canonical_id: &str, m: &MatchSummary) {
        let mut paths = vec![format!("d/{canonical_id}")];
        if let Some(slug) = m.event.as_deref().filter(|s| valid_slug(s)) {
            paths.push(format!("events/{slug}"));
        }
        for p in &m.players {
            match p.steamid.parse::<u64>() {
                Ok(id) if id != 0 && !self.hidden.is_hidden(id) => {
                    paths.push(format!("profiles/{id}"));
                }
                _ => {}
            }
        }
        self.queue(paths);
    }

    /// The queued paths, sorted.
    #[doc(hidden)]
    pub fn pending(&self) -> Vec<String> {
        self.lock().iter().cloned().collect()
    }

    /// Sends up to [`MAX_URLS`] queued paths in one POST. A 2xx or a 4xx (the batch is wrong,
    /// sending it again would not help) drains them; a 5xx or a transport error keeps them for
    /// the next flush, once: a batch that fails twice in a row is dropped.
    pub async fn flush(&self) -> Result<usize, String> {
        let batch: Vec<String> = self.lock().iter().take(MAX_URLS).cloned().collect();
        if batch.is_empty() {
            return Ok(0);
        }
        let urls: Vec<String> = batch
            .iter()
            .filter_map(|p| self.public_url.join(p).ok())
            .map(String::from)
            .collect();
        let key_location = self
            .public_url
            .join(&format!("{}.txt", self.key))
            .map_err(|e| format!("IndexNow's key location: {e}"))?;
        let body = serde_json::json!({
            "host": self.public_url.host_str(),
            "key": self.key,
            "keyLocation": key_location.as_str(),
            "urlList": urls,
        });
        let sent = self
            .client
            .post(self.endpoint.clone())
            .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
            .body(body.to_string())
            .send()
            .await;
        let drain = |this: &IndexNow| {
            let mut pending = this.lock();
            for p in &batch {
                pending.remove(p);
            }
        };
        let error = match sent {
            Ok(res) if res.status().is_success() => {
                self.retried.store(false, Ordering::SeqCst);
                drain(self);
                return Ok(batch.len());
            }
            Ok(res) if res.status().is_client_error() => {
                self.retried.store(false, Ordering::SeqCst);
                drain(self);
                let e = format!("IndexNow answered {}", res.status());
                tracing::warn!(urls = batch.len(), error = %e, "IndexNow turned a batch away");
                return Err(e);
            }
            Ok(res) => format!("IndexNow answered {}", res.status()),
            Err(e) => format!("IndexNow is unreachable: {e}"),
        };
        if self.retried.swap(true, Ordering::SeqCst) {
            self.retried.store(false, Ordering::SeqCst);
            drain(self);
            tracing::warn!(urls = batch.len(), %error, "IndexNow failed twice; a batch is dropped");
        }
        Err(error)
    }
}

/// Queues the guides (new with a deploy) and flushes every [`FLUSH_EVERY`], for as long as the
/// server runs.
pub fn spawn_indexnow(indexnow: Arc<IndexNow>) {
    indexnow.queue(GUIDES.iter().map(|g| format!("guides/{}", g.slug)));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(FLUSH_EVERY).await;
            match indexnow.flush().await {
                Ok(0) => {}
                Ok(n) => tracing::info!(urls = n, "submitted to IndexNow"),
                Err(e) => tracing::debug!(error = %e, "IndexNow flush failed"),
            }
        }
    });
}

/// The key as `/{key}.txt`, which proves the site owns it.
pub async fn key_file(State(s): State<AppState>) -> Response {
    let key = s.cfg.indexnow_key.clone().unwrap_or_default();
    (
        [
            (header::CONTENT_TYPE, "text/plain; charset=utf-8"),
            (header::CACHE_CONTROL, "public, max-age=86400"),
        ],
        key,
    )
        .into_response()
}
