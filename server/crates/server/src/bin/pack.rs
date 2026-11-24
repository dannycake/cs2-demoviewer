//! `demoviewer-pack-cli <demo.dem> <out.dvpk.gz>`: parses a CS2 demo and writes its replay pack.
//! `demoviewer-pack-cli <pack.dvpk.gz>`: reads a pack back and summarises it.
//! `demoviewer-pack-cli calibrate <dir>`: the rating norms (JSON, on stdout) of every player line
//! of every match summary (`*.json`) and pack (`*.dvpk.gz`, summarized) in `<dir>`.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use demoviewer_pack::Match;
use demoviewer_server::parse::parse_file;

const USAGE: &str = "usage: demoviewer-pack-cli <demo.dem> <out.dvpk.gz>\n       demoviewer-pack-cli <pack.dvpk.gz>\n       demoviewer-pack-cli calibrate <dir>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
        [cmd, dir] if cmd == "calibrate" => calibrate(Path::new(dir)),
        [demo, out] => pack(Path::new(demo), Path::new(out)),
        [pack] => show(Path::new(pack)),
        _ => {
            eprintln!("{USAGE}");
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e}");
            ExitCode::FAILURE
        }
    }
}

fn pack(demo: &Path, out: &Path) -> Result<(), String> {
    let t = Instant::now();
    let m = parse_file(demo).map_err(|e| e.to_string())?;
    let parsed = t.elapsed();
    let mut w =
        BufWriter::new(File::create(out).map_err(|e| format!("create {}: {e}", out.display()))?);
    demoviewer_pack::write(&m, &mut w)
        .and_then(|()| w.flush())
        .map_err(|e| format!("write {}: {e}", out.display()))?;
    drop(w);
    let bytes = std::fs::metadata(out).map_err(|e| e.to_string())?.len();
    summarise(&m);
    println!(
        "parsed in {:.2}s; wrote {bytes} bytes to {}",
        parsed.as_secs_f64(),
        out.display()
    );
    Ok(())
}

fn calibrate(dir: &Path) -> Result<(), String> {
    use demoviewer_server::matches::{summarize, MatchSummary};
    use demoviewer_server::rating::{self, RatingLine};
    let mut lines = Vec::new();
    let entries = std::fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let path = entry.map_err(|e| e.to_string())?.path();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let summary: MatchSummary = if name.ends_with(".json") {
            let bytes =
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?
        } else if name.ends_with(".dvpk.gz") {
            let f = File::open(&path).map_err(|e| format!("open {}: {e}", path.display()))?;
            let m = demoviewer_pack::read(&mut BufReader::new(f))
                .map_err(|e| format!("read {}: {e}", path.display()))?;
            summarize(&m, false)
        } else {
            continue;
        };
        lines.extend(summary.players.iter().map(RatingLine::from));
    }
    let norms = rating::calibrate(&lines);
    eprintln!(
        "{} lines, {} with at least {} rounds",
        lines.len(),
        norms.lines,
        rating::CALIBRATION_MIN_ROUNDS
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&norms).map_err(|e| e.to_string())?
    );
    Ok(())
}

fn show(pack: &Path) -> Result<(), String> {
    let f = File::open(pack).map_err(|e| format!("open {}: {e}", pack.display()))?;
    let m = demoviewer_pack::read(&mut BufReader::new(f))
        .map_err(|e| format!("read {}: {e}", pack.display()))?;
    summarise(&m);
    Ok(())
}

fn summarise(m: &Match) {
    let h = &m.header;
    println!(
        "map:      {} (build {}, {})",
        h.map, h.game_build, h.server_name
    );
    match h.rounds.last() {
        Some(r) => println!(
            "rounds:   {} (final T {} : CT {})",
            h.rounds.len(),
            r.score_t,
            r.score_ct
        ),
        None => println!("rounds:   0"),
    }
    let names: Vec<&str> = h.players.iter().map(|p| p.name.as_str()).collect();
    println!("players:  {} ({})", h.players.len(), names.join(", "));
    println!("events:   {}", m.events.len());
    println!("grenades: {}", m.grenades.len());
}
