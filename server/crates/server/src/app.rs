//! The whole HTTP surface: health check, `/api`, match pages and their preview images, map,
//! player and weapon assets, and the web app.

use std::sync::Arc;
use std::time::Duration;

use axum::extract::Request;
use axum::http::{header, HeaderValue};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use tower_http::services::ServeDir;
use tower_http::trace::TraceLayer;

use crate::admission::Admission;
use crate::api::{self, AppState};
use crate::auth;
use crate::config::Config;
use crate::faceit::{FaceitApi, FaceitData, FaceitDataApi, FACEIT_MIN_GAP};
use crate::faceit_history::FaceitHistory;
use crate::faceit_tracker::spawn_faceit_tracker;
use crate::feed;
use crate::hidden::{self, Hidden};
use crate::history::{MatchHistory, SteamHistory};
use crate::hosts;
use crate::indexnow::{self, spawn_indexnow, IndexNow};
use crate::jobs::Jobs;
use crate::pages;
use crate::profiles::{spawn_warmer, ProfileCache};
use crate::ratelimit::RateLimiter;
use crate::sessions::Sessions;
use crate::sitemap;
use crate::steam::{SteamApi, SteamGate, STEAM_MIN_GAP};
use crate::store::Store;
use crate::tracker::spawn_tracker;
use crate::tracking::Tracking;
use crate::uploads::Uploads;

/// The page's Content Security Policy: everything from this origin; WebAssembly compiled
/// (the meshopt decoder) but no `eval`; images, workers and fetches of `blob:`/`data:` URLs
/// (the glTF loader hands embedded textures over as blobs); inline styles (React's `style`
/// attributes); Cloudflare's analytics beacon (its script and where it reports to); no framing (clickjacking), no plugins.
pub const CSP: &str = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com; \
worker-src 'self' blob:; img-src 'self' data: blob: https://avatars.steamstatic.com \
https://avatars.akamai.steamstatic.com https://avatars.fastly.steamstatic.com \
https://avatars.cloudflare.steamstatic.com; connect-src 'self' blob: data: https://cloudflareinsights.com; \
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

/// A page's `Cache-Control`: revalidated on every visit. Cloudflare, in front of the site, may
/// write its Web Analytics beacon into the page on the way out ("automatic setup"; the CSP
/// names the beacon's origins). It used to carry `no-transform` as well, because Bot Fight
/// Mode's inline scripts were injected too and the CSP refused them, a console error for every
/// visitor; Bot Fight Mode is off, so the page is sent transformable again (2026-10-31).
pub const PAGE_CACHE: &str = "no-cache";

/// Sets `Cache-Control` on a successful response: kept for a year and never revalidated when
/// `immutable` says the request names content that never changes, else revalidated every time
/// ([`PAGE_CACHE`] for a page). Misses carry no header.
async fn cache_control(req: Request, next: Next, immutable: fn(&Request) -> bool) -> Response {
    let immutable = immutable(&req);
    let mut res = next.run(req).await;
    if res.status().is_success() {
        let page = res
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|t| t.to_str().ok())
            .is_some_and(|t| t.starts_with("text/html"));
        let value = if immutable {
            "public, max-age=31536000, immutable"
        } else if page {
            PAGE_CACHE
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
const ASSET_DIRS: [&str; 7] = [
    "maps",
    "players",
    "weapons",
    "viewmodels",
    "effects",
    "sounds",
    "site",
];

/// `/healthz`; `/api/*`; the match pages `/d/{id}` and their images `/og/{id}.jpg` ([`pages`]);
/// `/maps/*`, `/players/*`, `/weapons/*`, `/viewmodels/*`, `/effects/*` and `/sounds/*` from
/// `assets_dir/{maps,players,weapons,viewmodels,effects,sounds}`, sending a `<file>.gz` sibling
/// as `Content-Encoding: gzip` when the client accepts it, with [`cache_control`] by
/// [`versioned`]; the web build's bundles, `/assets/*` from `web_dir/assets`, and its fonts,
/// `/fonts/*` from `web_dir/fonts`, immutable (a missing one a 404); anything
/// else from `web_dir`, with `index.html` for paths that are not files (client-side routes),
/// revalidated. The web app's `.gz` siblings (`web/scripts/gzip-dist.mjs`) are sent the same way.
pub fn build_app(
    cfg: Arc<Config>,
    store: Arc<Store>,
    jobs: Jobs,
    limiter: Arc<RateLimiter>,
) -> Router {
    // One gate for every Steam call the server makes.
    let steam = cfg
        .steam_api_key
        .clone()
        .map(|key| Arc::new(SteamApi::new(key, SteamGate::new(STEAM_MIN_GAP))));
    build_app_with(cfg, store, jobs, limiter, steam)
}

/// [`build_app`] asking `steam` (a test's fake Steam) instead of the Steam the key reaches.
#[doc(hidden)]
pub fn build_app_with(
    cfg: Arc<Config>,
    store: Arc<Store>,
    jobs: Jobs,
    limiter: Arc<RateLimiter>,
    steam: Option<Arc<SteamApi>>,
) -> Router {
    // Match histories are asked through the same gate as every other Steam call.
    let history = match (&steam, cfg.steam_api_key.clone(), &cfg.tracking_key) {
        (Some(api), Some(key), Some(_)) => {
            Some(Arc::new(SteamHistory::new(key, api.gate())) as Arc<dyn MatchHistory>)
        }
        _ => None,
    };
    build_app_with_history(cfg, store, jobs, limiter, steam, history)
}

/// [`build_app_with`] asking `history` (a test's fake) for match histories.
#[doc(hidden)]
pub fn build_app_with_history(
    cfg: Arc<Config>,
    store: Arc<Store>,
    jobs: Jobs,
    limiter: Arc<RateLimiter>,
    steam: Option<Arc<SteamApi>>,
    history: Option<Arc<dyn MatchHistory>>,
) -> Router {
    // The build's bundles carry a content hash in their names and never change. One this build
    // does not have is a 404, never the page: a tab left open across a deploy asks for the
    // previous build's chunks, and given index.html as one, immutable, its browser would keep
    // the page as that script for a year.
    // The site's fonts (`public/fonts`) are the same: a font that changes gets a new file name.
    // Kept for a year, a page load does not ask again for each before its text takes its face.
    let bundles: Router<AppState> = Router::new()
        .nest_service(
            "/assets",
            ServeDir::new(cfg.web_dir.join("assets")).precompressed_gzip(),
        )
        .nest_service("/fonts", ServeDir::new(cfg.web_dir.join("fonts")))
        .layer(middleware::from_fn(|req, next| {
            cache_control(req, next, |_| true)
        }));
    // Everything else (`index.html`, the fallback for client-side routes, the favicon) is
    // revalidated, so a deploy reaches a returning visitor at once. Without the header browsers
    // kept the page by heuristic caching and loaded the previous build's bundles.
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
    // FACEIT's Data API, with a key, Steam or not: asked beside Steam for profiles and for
    // the one input's nicknames, through a gate of its own.
    let faceit_data = cfg.faceit_api_key.clone().map(|key| {
        Arc::new(FaceitDataApi::new(
            cfg.faceit_data_api.clone(),
            key,
            SteamGate::new(FACEIT_MIN_GAP),
        ))
    });
    // Without a key, FACEIT's site API is asked beside Steam, so only with a Steam to ask.
    let faceit = steam
        .as_ref()
        .filter(|_| faceit_data.is_none())
        .map(|_| Arc::new(FaceitApi::new(cfg.faceit_api.clone())));
    // `Store::open` made the data directory; this fails only as it would have.
    let profiles = ProfileCache::open(
        &cfg.data_dir.join("profiles"),
        steam.clone(),
        faceit,
        faceit_data.clone(),
    )
    .unwrap_or_else(|e| panic!("cannot make {}/profiles: {e}", cfg.data_dir.display()));
    let (public_url, redirect_hosts) = (cfg.public_url.clone(), cfg.redirect_hosts.clone());
    let sessions = Sessions::open(&cfg.data_dir)
        .unwrap_or_else(|e| panic!("cannot read {}/sessions.json: {e}", cfg.data_dir.display()));
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .expect("an HTTP client");
    let tracking = Tracking::open(&cfg.data_dir, cfg.tracking_key.clone())
        .unwrap_or_else(|e| panic!("cannot read {}/tracking.json: {e}", cfg.data_dir.display()));
    // The tracker asks Steam through the same gate as every other Steam call.
    // Tracking needs a history to walk and a key to seal codes with.
    let tracker = match (&history, &cfg.tracking_key) {
        (Some(h), Some(_)) => Some(spawn_tracker(
            store.clone(),
            jobs.clone(),
            tracking.clone(),
            h.clone(),
        )),
        _ => None,
    };
    // The FACEIT poller needs a FACEIT key alone (not Steam, nor a tracking key: it reads who is
    // tracked, never their codes), and asks through the Data API's gate. Its handle is dropped,
    // as the warmer's is: it runs for as long as the server does, or until FACEIT turns the key
    // away. So a test app built with a FACEIT key that tracks a player sees the poller's calls
    // on its fake FACEIT, which spend turns at the gate. Profiles read the files it writes;
    // without it they read whatever an earlier run left, and the directory is not made.
    let faceit_histories = match &faceit_data {
        Some(data) => {
            let histories = FaceitHistory::open(&cfg.data_dir)
                .unwrap_or_else(|e| panic!("cannot make {}/faceit: {e}", cfg.data_dir.display()));
            spawn_faceit_tracker(
                store.clone(),
                jobs.clone(),
                tracking.clone(),
                histories.clone(),
                data.clone() as Arc<dyn FaceitData>,
                profiles.clone(),
            );
            histories
        }
        None => FaceitHistory::at(&cfg.data_dir),
    };
    let hidden = Arc::new(Hidden::open(&cfg.data_dir.join(hidden::FILE)));
    // The warmer asks Steam through the same gate too, and only with a Steam to ask. Its
    // handle is dropped: it runs for as long as the server does. It starts here, not in
    // `main.rs` (which lacks the cache, store and hidden list), so it starts in every app built
    // with a Steam source, tests with a fake Steam included. It does nothing for `WARM_AFTER`
    // (120 s): a `start_paused` test that advances the clock past that sees fake-Steam calls
    // from it.
    if steam.is_some() {
        spawn_warmer(profiles.clone(), store.clone(), hidden.clone());
    }
    // IndexNow needs a key and an address to submit pages under. The runner (started before the
    // app) is handed it through the job queue's handle.
    let indexnow = match (&cfg.indexnow_key, &cfg.public_url) {
        (Some(key), Some(url)) => {
            let ix = IndexNow::new(
                http.clone(),
                key.clone(),
                url.clone(),
                cfg.indexnow_url.clone(),
                hidden.clone(),
            );
            jobs.set_indexnow(ix.clone());
            spawn_indexnow(ix.clone());
            Some(ix)
        }
        _ => None,
    };
    let state = AppState {
        tracking,
        tracker,
        history,
        sessions,
        sign_ins: Arc::default(),
        http,
        hidden,
        lookups: Arc::new(RateLimiter::new(cfg.lookups_per_hour)),
        steam,
        faceit: faceit_data.map(|f| f as Arc<dyn FaceitData>),
        profiles,
        cfg,
        store,
        jobs,
        admission,
        uploads,
        drawing: Arc::default(),
        sitemaps: Arc::default(),
        faceit_histories,
        indexnow,
    };
    // Files are served as they are; a path that is neither a file nor a page is the 404 page.
    let web = Router::new()
        .fallback_service(
            ServeDir::new(&state.cfg.web_dir)
                .precompressed_gzip()
                .fallback(get(pages::not_found_page).with_state(state.clone())),
        )
        .layer(middleware::from_fn(|req, next| {
            cache_control(req, next, |_| false)
        }));
    let mut app = Router::new().route("/healthz", get(|| async { "ok" }));
    // The key's own file, as the literal path: no other .txt is touched.
    if let Some(key) = &state.cfg.indexnow_key {
        app = app.route(&format!("/{key}.txt"), get(indexnow::key_file));
    }
    let app = app
        .nest("/api", api::routes())
        .merge(sitemap::routes())
        .merge(feed::routes())
        .merge(pages::routes())
        .merge(auth::routes())
        .merge(assets)
        .merge(bundles)
        .fallback_service(web)
        .with_state(state);
    hosts::with_redirects(app, public_url, redirect_hosts)
        .layer(middleware::from_fn(security_headers))
        .layer(TraceLayer::new_for_http())
}
