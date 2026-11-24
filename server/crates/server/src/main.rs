//! `demoviewer-server`: serves the demo API, assets and web app on `0.0.0.0:$DEMOVIEWER_PORT`.
//! `demoviewer-server parse-worker <demo> <pack>` is the server's own parse child (see
//! `demoviewer_server::worker`), not meant to be run by hand. `demoviewer-server healthcheck`
//! asks the server on this host whether it is up ([`healthcheck`]): the image's Docker health
//! check, since the image has no curl.

use std::ffi::OsString;
use std::io::IsTerminal;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use demoviewer_server::app::build_app;
use demoviewer_server::background::schedule_background;
use demoviewer_server::config;
use demoviewer_server::errors::with_causes;
use demoviewer_server::hidden;
use demoviewer_server::identity::{classify, Input};
use demoviewer_server::import::spawn_importer;
use demoviewer_server::jobs::spawn_runner;
use demoviewer_server::matches::upgrade_summaries;
use demoviewer_server::ratelimit::RateLimiter;
use demoviewer_server::store::{Store, FAILED_RECORD_TTL, FORGET_FAILED_EVERY};
use demoviewer_server::worker;
use tracing_subscriber::EnvFilter;

const HEALTHCHECK: &str = "healthcheck";
/// `hide <steamid>` / `unhide <steamid>`: edit the hidden profiles ([`hidden::edit`]).
const HIDE: &str = "hide";
const UNHIDE: &str = "unhide";
/// How long the health check waits for `/healthz`, connecting included.
const HEALTHCHECK_TIMEOUT: Duration = Duration::from_secs(3);

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    if args.first().is_some_and(|a| a == worker::SUBCOMMAND) {
        return worker::child_main(&args[1..]);
    }
    if args.first().is_some_and(|a| a == HEALTHCHECK) {
        return healthcheck();
    }
    if let Some(cmd) = args.first().filter(|a| *a == HIDE || *a == UNHIDE) {
        return hide(cmd == HIDE, &args[1..]);
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        // Colour only on a terminal; `docker logs` would show the escape codes.
        .with_ansi(std::io::stdout().is_terminal())
        .init();
    let served = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("starting the runtime: {e}"))
        .and_then(|rt| rt.block_on(run()));
    match served {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            tracing::error!("{e}");
            ExitCode::FAILURE
        }
    }
}

/// Hides a profile (or shows it again) in the data directory's list, which the running server
/// reads again within a minute. Any form of Steam id is taken (a link, a friend code, …).
fn hide(hide: bool, args: &[OsString]) -> ExitCode {
    let id = match args.first().and_then(|a| a.to_str()).map(classify) {
        Some(Input::SteamId(id)) if args.len() == 1 => id,
        _ => {
            eprintln!("usage: demoviewer-server {HIDE}|{UNHIDE} <steamid>");
            return ExitCode::from(2);
        }
    };
    let cfg = config::from_env();
    match hidden::edit(&cfg.data_dir, id, hide) {
        Ok(()) => {
            println!("{id} {}", if hide { "hidden" } else { "shown" });
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!(
                "cannot edit {}: {e}",
                cfg.data_dir.join(hidden::FILE).display()
            );
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let mut cfg = config::from_env();
    // Every parse runs in a child process of this same binary.
    cfg.parse_worker =
        Some(std::env::current_exe().map_err(|e| format!("finding the server executable: {e}"))?);
    let cfg = Arc::new(cfg);
    let store = Arc::new(
        Store::open(&cfg).map_err(|e| format!("opening {}: {e}", cfg.data_dir.display()))?,
    );
    store.forget_failed_every(FORGET_FAILED_EVERY, FAILED_RECORD_TTL);
    // Summaries from an older `summarize` get what it now knows from their packs, before the
    // job runner starts: the runner rewrites summaries too (an alias completing one), and an
    // upgrade alongside it could write back a copy older than the runner's. It only works once
    // per summary version.
    let upgrading = store.clone();
    let n = tokio::task::spawn_blocking(move || upgrade_summaries(&upgrading))
        .await
        .map_err(|e| format!("upgrading match summaries: {e}"))?;
    if n > 0 {
        tracing::info!(summaries = n, "match summaries upgraded from their packs");
    }
    let jobs = spawn_runner(store.clone(), cfg.clone());
    // After the upgrade: a summary it rewrote without ranks is parsed again from its original.
    tokio::spawn(schedule_background(store.clone(), jobs.clone()));
    if let Some(dir) = cfg.import_dir.clone() {
        spawn_importer(store.clone(), jobs.clone(), dir);
    }
    let limiter = Arc::new(RateLimiter::new(cfg.ingests_per_hour));
    let app = build_app(cfg.clone(), store.clone(), jobs, limiter);

    let addr = SocketAddr::from(([0, 0, 0, 0], cfg.port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("binding {addr}: {e}"))?;
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        %addr,
        data = %cfg.data_dir.display(),
        assets = %cfg.assets_dir.display(),
        web = %cfg.web_dir.display(),
        parse_memory_mib = cfg.parse_memory_bytes >> 20,
        matches = store.matches().len(),
        previews = cfg.site.previews,
        public_url = cfg.public_url.as_ref().map_or("", |u| u.as_str()),
        gcbot = cfg.gcbot_url.as_ref().map_or("", |u| u.as_str()),
        "listening"
    );
    let served = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown())
    .await
    .map_err(|e| format!("serving: {e}"));
    // demos.json is written behind the index's changes; the last of them reach the disk before
    // the process ends. Jobs still running end with it, and read as interrupted at the next
    // start.
    store.saved().await;
    tracing::info!("demos.json saved");
    served
}

/// GETs `/healthz` from `127.0.0.1:$DEMOVIEWER_PORT`, the server in the same container: exit 0
/// when it answers `200 ok`, 1 (and why, on stderr, which `docker inspect` shows) when the port
/// is closed, something else answers, or nothing answers within [`HEALTHCHECK_TIMEOUT`].
fn healthcheck() -> ExitCode {
    let url = format!("http://127.0.0.1:{}/healthz", config::from_env().port);
    let checked = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("starting the runtime: {e}"))
        .and_then(|rt| rt.block_on(answers_ok(&url)));
    match checked {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("healthcheck: {e}");
            ExitCode::FAILURE
        }
    }
}

async fn answers_ok(url: &str) -> Result<(), String> {
    let client = reqwest::Client::builder()
        // The server is on this host; a proxy in the environment must not be asked.
        .no_proxy()
        .timeout(HEALTHCHECK_TIMEOUT)
        .build()
        .map_err(|e| format!("building the HTTP client: {e}"))?;
    let failed = |e: reqwest::Error| format!("GET {url}: {}", with_causes(&e));
    let res = client.get(url).send().await.map_err(failed)?;
    let status = res.status();
    let body = res.text().await.map_err(failed)?;
    if status != reqwest::StatusCode::OK {
        return Err(format!("GET {url} answered {status}"));
    }
    if body != "ok" {
        let start: String = body.chars().take(64).collect();
        return Err(format!("GET {url} answered {start:?}, not \"ok\""));
    }
    Ok(())
}

/// Resolves on Ctrl-C or SIGTERM (`docker stop`).
async fn shutdown() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending().await,
        }
    };
    tokio::select! {
        () = ctrl_c => {},
        () = term => {},
    }
    tracing::info!("shutting down");
}
