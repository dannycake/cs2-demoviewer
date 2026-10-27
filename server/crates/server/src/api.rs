//! `/api` handlers: chunked uploads, URL and share-code ingest, demo status (with the match
//! summary) and packs, and what the site offers.
//!
//! The handlers are adapters: what a request may start is decided by [`crate::admission`], in
//! one order for every ingest path, and an upload's chunks are kept by [`crate::uploads`].
//! Uploads: `POST /uploads {size}` makes an upload; each `PUT /uploads/{id}/{n}` stores one
//! chunk; `POST /uploads/{id}/complete` requires every chunk the declared size implies, claims
//! the upload, concatenates the chunks while hashing, and either answers from the pack cache or
//! queues a job.

use std::io::{self, ErrorKind};
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::body::Body;
use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, Path as UrlPath, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::io::ReaderStream;

use crate::admission::Admission;
use crate::config::Config;
use crate::errors::{blocking, Panicked};
use crate::gcbot::ResolveError;
use crate::ingest;
use crate::jobs::{Job, Jobs};
use crate::ratelimit::client_ip;
use crate::sharecode;
use crate::store::{self, valid_id, DemoRecord, Source, Status, Store, WorkFiles};
use crate::uploads::{self, UploadMeta, Uploads, PUTS_PER_CHUNK, SPARE_PUTS};

/// What every handler can reach.
#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Arc<Store>,
    pub jobs: Jobs,
    /// The attempt and ingest limits, the upload budget and the queues a request is admitted
    /// through.
    pub admission: Arc<Admission>,
    /// Unfinished uploads.
    pub uploads: Arc<Uploads>,
    /// Held while a match page's preview image is drawn, so only one is drawn at a time.
    pub drawing: Arc<tokio::sync::Mutex<()>>,
}

/// The `/api` routes, to be nested under `/api`. Unknown paths answer a JSON 404.
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/uploads", post(create_upload))
        .route("/uploads/{id}/complete", post(complete_upload))
        .route("/uploads/{id}/{n}", put(put_chunk))
        .route("/demos", post(create_demo))
        .route("/demos/{id}", get(get_demo))
        .route("/demos/{id}/pack", get(get_pack))
        .route("/site", get(get_site))
        .fallback(|| async { ApiError::new(StatusCode::NOT_FOUND, "not found") })
}

/// An error answer: the status with `{"error": message}`.
#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        ApiError {
            status,
            message: message.into(),
        }
    }

    /// A 500 that answers `what` alone: the cause, which may name a path or carry an OS
    /// error, goes to the log (code-health review 2026-10-26).
    pub(crate) fn internal(what: &str, e: impl std::fmt::Display) -> Self {
        tracing::error!(error = %e, "{what}");
        ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, what)
    }

    #[cfg(test)]
    pub(crate) fn status(&self) -> StatusCode {
        self.status
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

fn bad_json(e: JsonRejection) -> ApiError {
    ApiError::new(StatusCode::BAD_REQUEST, e.body_text())
}

/// A handler's blocking work that panicked: a 500 that says only that ([`blocking`]).
impl From<Panicked> for ApiError {
    fn from(e: Panicked) -> ApiError {
        ApiError::internal("internal error", e)
    }
}

// ---- uploads ----------------------------------------------------------------------------

#[derive(Deserialize)]
struct NewUpload {
    size: u64,
    #[serde(default)]
    name: Option<String>,
}

async fn create_upload(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<NewUpload>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(req) = body.map_err(bad_json)?;
    if req.size == 0 {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, "the file is empty"));
    }
    if req.size > s.cfg.max_upload_bytes {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            format!(
                "the file is larger than the {} MiB limit",
                s.cfg.max_upload_bytes >> 20
            ),
        ));
    }
    let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
    let attempt = s.admission.attempt(ip)?;
    let client = attempt.client();
    // Abandoned uploads leave the budget before this one is measured against it.
    s.uploads.sweep();
    let (id, size) = (Store::new_id(), req.size);
    // The chunks, the assembled file and the decompressed demo may all exist at once.
    let (reservation, refund) = attempt
        .room(size.saturating_mul(3))?
        .upload_place(&id, size)?
        .ingest()?
        .commit_until_failed();
    // The directory is made on a blocking task, which goes on when the client goes away, so the
    // task holds the reservation and keeps it once the directory is there: a start dropped
    // meanwhile leaves an upload the budget counts, and its ingest spent, like one that was
    // answered (code-health review 2026-10-26: the handler held both, and a dropped request gave
    // both back while the directory was still made, so a restart found uploads it had not
    // counted).
    let (uploads, upload) = (s.uploads.clone(), id.clone());
    let created = blocking(move || {
        uploads.create(&upload, &UploadMeta { size, client })?;
        reservation.keep();
        io::Result::Ok(())
    })
    .await?;
    if let Err(e) = created {
        refund.refund();
        return Err(ApiError::internal("cannot start the upload", e));
    }

    let name: String = req.name.unwrap_or_default().chars().take(120).collect();
    tracing::info!(upload = %id, size, %name, %ip, "upload started");
    Ok((
        StatusCode::CREATED,
        Json(json!({ "uploadId": id, "chunkSize": s.cfg.chunk_bytes })),
    )
        .into_response())
}

async fn put_chunk(
    State(s): State<AppState>,
    UrlPath((id, n)): UrlPath<(String, String)>,
    headers: HeaderMap,
    body: Body,
) -> Result<StatusCode, ApiError> {
    let (dir, layout) = s.uploads.layout(&id).await?;
    let n: u64 = n.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "the chunk number must be an integer",
        )
    })?;
    let count = layout.count();
    if n >= count {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            format!(
                "chunk {n} is out of range: this upload has chunks 0 to {}",
                count - 1
            ),
        ));
    }
    let gzip = match headers.get(header::CONTENT_ENCODING) {
        None => false,
        Some(v) => match v
            .to_str()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "" | "identity" => false,
            "gzip" | "x-gzip" => true,
            other => {
                return Err(ApiError::new(
                    StatusCode::UNSUPPORTED_MEDIA_TYPE,
                    format!("Content-Encoding {other:?} is not supported; send gzip or nothing"),
                ))
            }
        },
    };
    let slot = s
        .uploads
        .begin_put(&id, count * PUTS_PER_CHUNK + SPARE_PUTS)?;
    uploads::store_chunk(&dir, &layout, n, gzip, body, s.cfg.put_idle, slot).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn complete_upload(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let (dir, layout) = s.uploads.layout(&id).await?;
    let count = layout.count();
    for n in 0..count {
        if !tokio::fs::try_exists(dir.join(n.to_string()))
            .await
            .unwrap_or(false)
        {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                format!("missing chunk {n}"),
            ));
        }
    }
    let slot = s
        .admission
        .complete(&layout.client, layout.size.saturating_mul(2))?;

    let demo_id = Store::new_id();
    let parts = s.store.tmp_dir().join(format!("{id}.parts"));
    let dem_path = s.store.tmp_dir().join(format!("{demo_id}.upload"));
    let (uploads, upload, dst) = (s.uploads.clone(), id.clone(), dem_path.clone());
    let started = Instant::now();
    // Claimed and assembled on a blocking task, which goes on when the client goes away, so the
    // task holds the place and the assembled file: dropped with its result unread, it gives the
    // place back and deletes the file (code-health review 2026-10-26: a completion dropped while
    // the claim's rename waited left the chunks in tmp/ and the upload in the budget for an
    // hour, and one dropped during the assembly left the file, up to 500 MiB, until a restart).
    let assembled = blocking(move || {
        uploads.claim(&upload, &parts)?;
        let mut file = WorkFiles::default();
        file.add(&dst);
        let r = uploads::assemble(&parts, count, &dst);
        let _ = std::fs::remove_dir_all(&parts);
        let (sha, total) = r.map_err(|e| ApiError::internal("cannot assemble the upload", e))?;
        Ok::<_, ApiError>((sha, total, file, slot))
    })
    .await??;
    let (sha, total, mut file, slot) = assembled;
    let secs = started.elapsed().as_secs_f64();
    if total != layout.size || total > s.cfg.max_upload_bytes {
        // Deleting up to 500 MiB is file-system work: off the async workers, like the assembly.
        // The queue place goes with the file, so the disk is free before the place is.
        let _ = tokio::task::spawn_blocking(move || drop((file, slot))).await;
        return Err(ApiError::internal(
            "cannot assemble the upload",
            format!("assembled {total} bytes, expected {}", layout.size),
        ));
    }

    s.store.create(&demo_id);
    s.store.update(&demo_id, |r| r.sha256 = Some(sha.clone()));
    if let Some(done) = s.store.alias_packed(&demo_id, &sha) {
        let _ = tokio::task::spawn_blocking(move || drop((file, slot))).await;
        s.store.touch_pack(&sha);
        tracing::info!(upload = %id, demo = %demo_id, of = %done.id, total, secs, "upload complete; already packed");
        s.store.saved().await;
        return Ok((
            StatusCode::OK,
            Json(json!({ "demoId": demo_id, "cached": true })),
        )
            .into_response());
    }

    // The file is the job's now.
    file.release();
    s.jobs.enqueue(Job::Upload {
        demo_id: demo_id.clone(),
        dem_path,
        slot: Some(slot),
    });
    tracing::info!(upload = %id, demo = %demo_id, total, secs, "upload complete; queued");
    s.store.saved().await;
    Ok((StatusCode::ACCEPTED, Json(json!({ "demoId": demo_id }))).into_response())
}

// ---- URL and share-code ingest, and demos -----------------------------------------------

/// `POST /demos`: a URL to fetch or a share code to look up, exactly one of them.
#[derive(Deserialize)]
struct NewDemo {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    sharecode: Option<String>,
}

const MAX_URL_LEN: usize = 2048;

async fn create_demo(
    State(s): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Result<Json<NewDemo>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(req) = body.map_err(bad_json)?;
    let ip = client_ip(&headers, peer, &s.cfg.trusted_proxies);
    match (req.url, req.sharecode) {
        (Some(url), None) => ingest_url(&s, ip, &url).await,
        (None, Some(text)) => ingest_sharecode(&s, ip, &text).await,
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "send either a url or a sharecode",
        )),
    }
}

async fn ingest_url(s: &AppState, ip: IpAddr, url: &str) -> Result<Response, ApiError> {
    if url.len() > MAX_URL_LEN {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "the URL is too long",
        ));
    }
    let attempt = s.admission.attempt(ip)?;
    // The floor uploads keep, for the largest download (security audit 2026-10-23); the job
    // checks again before it writes.
    let room = attempt.room(s.cfg.max_upload_bytes)?;
    // Scheme, host and the allowlist, with no DNS: the download resolves and checks every hop
    // (code-health review 2026-10-26: the lookup here, and the per-client hold that bounded it,
    // date from before only Valve's replay hosts were taken).
    let url = ingest::check_url(url.trim())
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e.to_string()))?;
    // A place on the way to the parse worker before the record (security audit 2026-10-23).
    let ticket = room.fetch_place()?.ingest()?;
    let demo_id = Store::new_id();
    s.store.create_from(&demo_id, Source::Url);
    tracing::info!(demo = %demo_id, %url, %ip, "url ingest queued");
    s.jobs.enqueue(Job::Url {
        demo_id: demo_id.clone(),
        url,
        slot: Some(ticket.commit()),
    });
    s.store.saved().await;
    Ok((StatusCode::ACCEPTED, Json(json!({ "demoId": demo_id }))).into_response())
}

/// A share code (anywhere in `text`, see [`sharecode::extract`]), after the client's attempt
/// limit (`429`): the demo this very code brought when the site has it or is getting it
/// (`200 cached` once done, `202` before), without spending the client's ingests; Valve's
/// refusal of this code when it came lately (`404`); `503` while the share-code service is
/// offline or [`MAX_WAITING`](crate::gcbot::MAX_WAITING) lookups wait, also without spending
/// them (the job checks both again); `507` below the free-space floor, as for a URL; `429`/`503`
/// when the client or everyone has no place left among the jobs on their way to the parse
/// worker ([`crate::admission`]), again without spending them; else, for one of the client's
/// ingests, a `Resolving` record and a share-code job (`202`), which holds its place. One record
/// per code ([`Store::claim_match`]), so a code posted by many at once is looked up once. All
/// of it goes by the whole code, never the match id alone, which anyone can put in a code of
/// their own.
async fn ingest_sharecode(s: &AppState, ip: IpAddr, text: &str) -> Result<Response, ApiError> {
    // Before the code is read and looked up, also for a code the site has (security audit
    // 2026-10-23: share-code posts could be repeated without limit).
    let attempt = s.admission.attempt(ip)?;
    let Some(sharecodes) = s.jobs.sharecodes() else {
        return Err(ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "this server does not take share codes: paste the replay URL or upload the demo instead",
        ));
    };
    let invalid = || ApiError::new(StatusCode::BAD_REQUEST, ResolveError::Invalid.to_string());
    let code = sharecode::extract(text).ok_or_else(invalid)?;
    let ids = sharecode::decode(&code).map_err(|_| invalid())?;

    if let Some(r) = s.store.find_match(&ids) {
        return Ok(known_match(s, r).await);
    }
    if let Some(e) = sharecodes.failed(&ids) {
        return Err(ApiError::new(StatusCode::NOT_FOUND, e.to_string()));
    }
    // A lookup that would fail at once spends no ingest.
    let unavailable =
        |e: ResolveError| ApiError::new(StatusCode::SERVICE_UNAVAILABLE, e.to_string());
    if !sharecodes.online() {
        return Err(unavailable(ResolveError::Offline));
    }
    if sharecodes.busy() {
        return Err(unavailable(ResolveError::Busy));
    }
    let ticket = attempt
        .room(s.cfg.max_upload_bytes)?
        .fetch_place()?
        .ingest()?;
    let (r, created) = s.store.claim_match(&ids, &Store::new_id());
    if !created {
        // Another post of the match got there first: this one is a repeat after all, and the
        // dropped ticket gives the ingest and the place back.
        drop(ticket);
        return Ok(known_match(s, r).await);
    }
    tracing::info!(demo = %r.id, match_id = ids.match_id, %ip, "share code queued");
    s.jobs.enqueue(Job::ShareCode {
        demo_id: r.id.clone(),
        code: ids,
        slot: Some(ticket.commit()),
    });
    s.store.saved().await;
    Ok((StatusCode::ACCEPTED, Json(json!({ "demoId": r.id }))).into_response())
}

/// The answer for a share code whose match already has demo `r`, once `r` is on disk (another
/// post may have made it a moment ago).
async fn known_match(s: &AppState, r: DemoRecord) -> Response {
    s.store.saved().await;
    if r.status != Status::Done {
        return (StatusCode::ACCEPTED, Json(json!({ "demoId": r.id }))).into_response();
    }
    if let Some(sha) = &r.sha256 {
        s.store.touch_pack(sha);
    }
    (
        StatusCode::OK,
        Json(json!({ "demoId": r.id, "cached": true })),
    )
        .into_response()
}

/// The record for `id` as it is on disk ([`Store::get_saved`]), or 404.
async fn find_demo(s: &AppState, id: &str) -> Result<DemoRecord, ApiError> {
    let unknown = || ApiError::new(StatusCode::NOT_FOUND, "unknown demo");
    if !valid_id(id) {
        return Err(unknown());
    }
    s.store.get_saved(id).await.ok_or_else(unknown)
}

#[derive(Serialize)]
struct DemoView {
    id: String,
    status: Status,
    map: Option<String>,
    rounds: Option<u16>,
    error: Option<String>,
    /// The match summary once `Done` (none for a pack parsed before summaries were written).
    summary: Option<Value>,
}

async fn get_demo(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Json<DemoView>, ApiError> {
    let r = find_demo(&s, &id).await?;
    let summary = r
        .sha256
        .as_deref()
        .filter(|_| r.status == Status::Done)
        .and_then(|sha| s.store.matches().get(sha))
        .and_then(|m| serde_json::to_value(&*m).ok())
        .map(|mut v| {
            // Like the record's, the sha stays on the server.
            if let Value::Object(fields) = &mut v {
                fields.remove("sha256");
            }
            v
        });
    Ok(Json(DemoView {
        id: r.id,
        status: r.status,
        map: r.map,
        rounds: r.rounds,
        error: r.error,
        summary,
    }))
}

/// What the web app may offer. Nothing is listed (link only), so the one question is whether a
/// share code can be pasted.
#[derive(Serialize)]
struct SiteView {
    /// A share-code service is configured and online.
    sharecodes: bool,
}

async fn get_site(State(s): State<AppState>) -> Json<SiteView> {
    Json(SiteView {
        sharecodes: s.jobs.sharecodes().is_some_and(|c| c.online()),
    })
}

async fn get_pack(
    State(s): State<AppState>,
    UrlPath(id): UrlPath<String>,
) -> Result<Response, ApiError> {
    let r = find_demo(&s, &id).await?;
    if r.status != Status::Done {
        return Err(ApiError::new(StatusCode::CONFLICT, "not ready"));
    }
    let sha = r
        .sha256
        .ok_or_else(|| ApiError::internal("cannot serve the pack", "done demo without a sha"))?;
    let file = match tokio::fs::File::open(s.store.pack_path(&sha)).await {
        Ok(f) => f,
        // Evicted between the index update and this request, or removed by hand.
        Err(e) if e.kind() == ErrorKind::NotFound => {
            s.store.update(&id, |r| {
                r.status = Status::Error;
                r.error = Some(store::EXPIRED.into());
            });
            return Err(ApiError::new(StatusCode::GONE, store::EXPIRED));
        }
        Err(e) => return Err(ApiError::internal("cannot serve the pack", e)),
    };
    let len = file
        .metadata()
        .await
        .map_err(|e| ApiError::internal("cannot serve the pack", e))?
        .len();
    s.store.touch_pack(&sha);
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_ENCODING, "gzip".to_owned()),
            (
                header::CACHE_CONTROL,
                "public, max-age=31536000, immutable".to_owned(),
            ),
            (header::CONTENT_LENGTH, len.to_string()),
        ],
        Body::from_stream(ReaderStream::with_capacity(file, 1 << 16)),
    )
        .into_response())
}
