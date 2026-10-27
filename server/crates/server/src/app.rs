//! The whole HTTP surface: health check, `/api`, match pages and their preview images, map,
//! player and weapon assets, and the web app.

use std::sync::Arc;

use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;

use crate::admission::Admission;
use crate::api::{self, AppState};
use crate::config::Config;
use crate::jobs::Jobs;
use crate::pages;
use crate::ratelimit::RateLimiter;
use crate::store::Store;
use crate::uploads::Uploads;

/// The page's Content Security Policy: everything from this origin; WebAssembly compiled
/// (the meshopt decoder) but no `eval`; images, workers and fetches of `blob:`/`data:` URLs
/// (the glTF loader hands embedded textures over as blobs); inline styles (React's `style`
/// attributes); no framing (clickjacking), no plugins.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; \
worker-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' blob: data:; \
style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; object-src 'none'; \
base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

/// Security headers on every response (security audit 2026-10-22): the CSP above, no MIME
/// sniffing, no framing for browsers without `frame-ancestors`, and no full URL in referrers.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    h.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    res
}

/// Sets `Cache-Control` on a successful response: kept for a year and never revalidated when
/// `immutable` says the request names content that never changes, else revalidated every time.
/// Misses carry no header.
async fn cache_control(req: Request, next: Next, immutable: fn(&Request) -> bool) -> Response {
    let immutable = immutable(&req);
    let mut res = next.run(req).await;
    if res.status().is_success() {
        let value = if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        };
        res.headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(value));
    }
    res
}

/// For assets: a request that names the content it wants (`?v=<sha prefix>`, what the web app
/// sends for every file listed in a manifest) is immutable; anything else (the manifests
/// themselves, a bare URL) is not.
fn versioned(req: &Request) -> bool {
    req.uri()
        .query()
        .is_some_and(|q| q.split('&').any(|p| p.len() > 2 && p.starts_with("v=")))
}

/// The asset directories under `assets_dir`, each served at `/<dir>`.
const ASSET_DIRS: [&str; 6] = [
    "maps",
    "players",
    "weapons",
    "viewmodels",
    "effects",
    "sounds",
];

/// `/healthz`; `/api/*`; the match pages `/d/{id}` and their images `/og/{id}.jpg` ([`pages`]);
/// `/maps/*`, `/players/*`, `/weapons/*`, `/viewmodels/*`, `/effects/*` and `/sounds/*` from
/// `assets_dir/{maps,players,weapons,viewmodels,effects,sounds}`, sending a `<file>.gz` sibling
/// as `Content-Encoding: gzip` when the client accepts it, with [`cache_control`] by
/// [`versioned`]; the web build's bundles, `/assets/*` from `web_dir/assets`, immutable; anything
/// else from `web_dir`, with `index.html` for paths that are not files (client-side routes),
/// revalidated. The web app's `.gz` siblings (`web/scripts/gzip-dist.mjs`) are sent the same way.
pub fn build_app(
    cfg: Arc<Config>,
    store: Arc<Store>,
    jobs: Jobs,
    limiter: Arc<RateLimiter>,
) -> Router {
    // The build's bundles carry a content hash in their names and never change. One this build
    // does not have is a 404, never the page: a tab left open across a deploy asks for the
    // previous build's chunks, and given index.html as one, immutable, its browser would keep
    // the page as that script for a year.
    let bundles: Router<AppState> = Router::new()
        .nest_service(
            "/assets",
            ServeDir::new(cfg.web_dir.join("assets")).precompressed_gzip(),
        )
        .layer(middleware::from_fn(|req, next| {
            cache_control(req, next, |_| true)
        }));
    // Everything else (`index.html`, the fallback for client-side routes, the favicon) is
    // revalidated, so a deploy reaches a returning visitor at once. Without the header browsers
    // kept the page by heuristic caching and loaded the previous build's bundles.
    let web = Router::new()
        .fallback_service(
            ServeDir::new(&cfg.web_dir)
                .precompressed_gzip()
                .fallback(ServeFile::new(cfg.web_dir.join("index.html")).precompressed_gzip()),
        )
        .layer(middleware::from_fn(|req, next| {
            cache_control(req, next, |_| false)
        }));
    let assets: Router<AppState> = ASSET_DIRS
        .into_iter()
        .fold(Router::new(), |router, dir| {
            router.nest_service(
                &format!("/{dir}"),
                ServeDir::new(cfg.assets_dir.join(dir)).precompressed_gzip(),
            )
        })
        .layer(middleware::from_fn(|req, next| {
            cache_control(req, next, versioned)
        }));
    let uploads = Arc::new(Uploads::open(&store, &cfg));
    let admission = Arc::new(Admission::new(
        &cfg,
        store.clone(),
        limiter,
        uploads.clone(),
    ));
    let state = AppState {
        cfg,
        store,
        jobs,
        admission,
        uploads,
        drawing: Arc::default(),
    };
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .nest("/api", api::routes())
        .merge(pages::routes())
        .merge(assets)
        .merge(bundles)
        .fallback_service(web)
        .with_state(state)
        .layer(middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
}
