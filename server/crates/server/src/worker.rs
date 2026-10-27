//! Parsing one demo into a pack, in this process or in a child process.
//!
//! The server parses each demo in a child, `demoviewer-server parse-worker <demo> <pack>`
//! ([`parse_in_child`]), so that a parse cannot take the server down with it. A failed
//! allocation aborts a Rust process, and `catch_unwind` cannot catch an abort; the kernel's OOM
//! killer cannot be caught at all. Before the child starts, the parent caps its writable memory
//! (`RLIMIT_DATA`, see `set_memory_limit`), so a parse that wants too much memory dies
//! alone. At the job's time limit the parent kills the child instead of abandoning a thread
//! that keeps running and holding memory. The child writes the pack and prints one
//! JSON [`Outcome`] line on stdout, with the match's summary; the parent renames the pack into
//! place.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, BufWriter, Write};
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{ExitCode, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

use demoviewer_pack::Match;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;

use crate::jobs::NO_ROUNDS;
use crate::matches::{self, MatchSummary};
use crate::parse::{self, ParseError};

/// The first argument that makes `demoviewer-server` a parse worker.
pub const SUBCOMMAND: &str = "parse-worker";

/// Most of the child's stdout the parent keeps. The outcome line carries the match summary,
/// whose names are capped ([`matches::MAX_NAME_CHARS`]): this fits over a thousand players with
/// the longest names, each character escaped.
const MAX_OUTPUT: u64 = 1024 * 1024;

/// The child's report, its last line on stdout.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Outcome {
    // Boxed: the summary is far larger than an error (serde writes it the same).
    Packed { summary: Box<MatchSummary> },
    Failed { error: String },
}

/// Parses `demo` with `parse`, writes its pack to `pack` (not renamed anywhere) and returns
/// the match's summary. A match with no complete round is [`NO_ROUNDS`]. When `abandoned` is
/// set by the time the parse returns, nothing is written.
pub fn parse_to_pack(
    parse: &dyn Fn(&Path) -> Result<Match, ParseError>,
    demo: &Path,
    pack: &Path,
    abandoned: Option<&AtomicBool>,
) -> Result<MatchSummary, String> {
    let m = parse(demo).map_err(|e| e.to_string())?;
    if m.header.rounds.is_empty() {
        return Err(NO_ROUNDS.to_owned());
    }
    if abandoned.is_some_and(|a| a.load(Ordering::SeqCst)) {
        return Err("abandoned after the parse time limit".to_owned());
    }
    write_pack(&m, pack).map_err(|e| match e.kind() {
        io::ErrorKind::FileTooLarge => e.to_string(),
        // The path and the OS error are logged (the parse child's log goes to the server's
        // stderr), not shown with the demo.
        _ => {
            tracing::error!(path = %pack.display(), error = %e, "cannot write the replay pack");
            "the server could not write the replay pack; try again later".to_owned()
        }
    })?;
    Ok(matches::summarize(&m))
}

fn write_pack(m: &Match, path: &Path) -> io::Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    demoviewer_pack::write(m, &mut w)?;
    w.flush()
}

/// The child's side of [`parse_in_child`]: `args` are what follows [`SUBCOMMAND`].
pub fn child_main(args: &[OsString]) -> ExitCode {
    let [demo, pack] = args else {
        eprintln!("usage: demoviewer-server {SUBCOMMAND} <demo.dem> <out.dvpk.gz>");
        return ExitCode::from(2);
    };
    // What the parse logs (a file it cannot read or write) goes to stderr, which is the
    // server's; stdout carries the outcome.
    let _ = tracing_subscriber::fmt()
        .with_writer(io::stderr)
        .with_ansi(false)
        .try_init();
    let outcome = match parse_to_pack(&parse::parse_file, Path::new(demo), Path::new(pack), None) {
        Ok(summary) => Outcome::Packed {
            summary: Box::new(summary),
        },
        Err(error) => Outcome::Failed { error },
    };
    let line = serde_json::to_string(&outcome).expect("an outcome always serialises");
    let mut out = io::stdout().lock();
    match writeln!(out, "{line}").and_then(|()| out.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}

/// Runs `exe parse-worker demo pack` with at most `memory_limit` bytes of writable memory and
/// returns the summary of the match it packed into `pack`. Its stderr (a panic message, say)
/// goes to the server's.
///
/// Dropping the future kills the child, which is how the caller's time limit stops it.
pub async fn parse_in_child(
    exe: &Path,
    demo: &Path,
    pack: &Path,
    memory_limit: u64,
) -> Result<MatchSummary, String> {
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg(SUBCOMMAND)
        .arg(demo)
        .arg(pack)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    // SAFETY: the closure runs in the forked child before exec. It only makes the getrlimit
    // and setrlimit system calls, which are async-signal-safe, and allocates nothing.
    unsafe {
        cmd.pre_exec(move || set_memory_limit(memory_limit));
    }
    let mut child = cmd.spawn().map_err(|e| {
        tracing::error!(exe = %exe.display(), error = %e, "cannot start the parse child");
        "internal error: cannot start the parser".to_owned()
    })?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    let mut out = Vec::new();
    // Keep the start of the output and drain the rest, so the child never blocks on a full
    // pipe. A read error just leaves the outcome unreadable; the exit status still counts.
    let _ = (&mut stdout).take(MAX_OUTPUT).read_to_end(&mut out).await;
    let _ = tokio::io::copy(&mut stdout, &mut tokio::io::sink()).await;
    let status = child.wait().await.map_err(|e| {
        tracing::error!(error = %e, "cannot wait for the parse child");
        "internal error: the parser did not report back".to_owned()
    })?;
    if !status.success() {
        return Err(crash_message(status, memory_limit));
    }
    let outcome = String::from_utf8_lossy(&out)
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str::<Outcome>(l).ok());
    match outcome {
        Some(Outcome::Packed { summary }) => Ok(*summary),
        Some(Outcome::Failed { error }) => Err(error),
        None => Err("internal error: the parser exited without a result".to_owned()),
    }
}

fn crash_message(status: ExitStatus, memory_limit: u64) -> String {
    let how = match status.signal() {
        Some(libc::SIGABRT) => "it aborted, usually because an allocation failed".to_owned(),
        Some(libc::SIGKILL) => "it was killed, usually for using too much memory".to_owned(),
        Some(libc::SIGSEGV) => "segmentation fault".to_owned(),
        Some(sig) => format!("signal {sig}"),
        None => format!("exit status {}", status.code().unwrap_or(-1)),
    };
    format!(
        "the demo parser crashed ({how}); the demo may be corrupt, or need more than the \
         parser's {} MiB of memory",
        memory_limit >> 20
    )
}

/// Caps this process's writable memory (heap, writable mappings, thread stacks) at `bytes`,
/// soft and hard limit both, never raising the current hard limit.
///
/// `RLIMIT_DATA` rather than `RLIMIT_AS`: the address-space limit also counts the read-only
/// map of the demo and the 64 MiB that glibc reserves (but does not use) for each thread's
/// malloc arena, so it would depend on the file size and the core count.
fn set_memory_limit(bytes: u64) -> io::Result<()> {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: plain system calls on a valid, initialised struct.
    unsafe {
        if libc::getrlimit(libc::RLIMIT_DATA, &mut lim) != 0 {
            return Err(io::Error::last_os_error());
        }
        let cap = (bytes as libc::rlim_t).min(lim.rlim_max);
        lim.rlim_cur = cap;
        lim.rlim_max = cap;
        if libc::setrlimit(libc::RLIMIT_DATA, &lim) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
