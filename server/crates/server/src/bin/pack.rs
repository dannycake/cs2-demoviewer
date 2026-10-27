//! `demoviewer-pack-cli <demo.dem> <out.dvpk.gz>`: parses a CS2 demo and writes its replay pack.
//! `demoviewer-pack-cli <pack.dvpk.gz>`: reads a pack back and summarises it.

use std::fs::File;
use std::io::{BufReader, BufWriter, Write};
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use demoviewer_pack::Match;
use demoviewer_server::parse::parse_file;

const USAGE: &str = "usage: demoviewer-pack-cli <demo.dem> <out.dvpk.gz>\n       demoviewer-pack-cli <pack.dvpk.gz>";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.as_slice() {
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
