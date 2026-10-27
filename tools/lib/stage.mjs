// Staging and atomic writes, in the one temp name every tool writes through: a file or a
// directory is written as <target>.tmp-<pid> beside its target and renamed over it, so a reader
// never sees half of it. A run killed before its rename (a signal, a crash, a power loss) leaves
// only that name behind, and sweepLeftovers reads the pid back from it to reclaim it once that
// process is gone; the name is the contract between the two, so nothing else spells it. The rip
// scripts (lib/rip.sh) stage the same way, and while they swap an export into place they move
// the previous one aside as <dest>.old-<pid>, which the sweep puts back if the swap never ended.
// Nothing is fsynced, as none of the writers this replaced did.
//
// node tools/lib/stage.mjs sweep <dir>: sweepLeftovers(<dir>), one line per leftover reclaimed
// (build-assets.sh runs it when a build starts).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { isMain } from './cli.mjs';
import { GZIP } from './gz.mjs';

/** `target`'s temp name for the process `pid` (this one unless given): `<target>.tmp-<pid>`, the pid last. */
export function tmpPath(target, pid = process.pid) {
  return `${target}.tmp-${pid}`;
}

/**
 * Writes each `[file, data]` of `files` to its tmpPath, then renames each over its file in
 * order: every byte is written before the first rename, so a failed write changes none of the
 * files. A temp file still there at the end (after a failure) is removed.
 */
export function writeFilesAtomic(files) {
  try {
    for (const [file, data] of files) fs.writeFileSync(tmpPath(file), data);
    for (const [file] of files) fs.renameSync(tmpPath(file), file);
  } finally {
    for (const [file] of files) fs.rmSync(tmpPath(file), { force: true });
  }
}

/** Writes `data` to `file` through its tmpPath and a rename. */
export function writeFileAtomic(file, data) {
  writeFilesAtomic([[file, data]]);
}

/**
 * Writes `obj` as JSON (two-space indent, a final newline) to `file` through its tmpPath. With
 * `gz`, also its gzip -9 `<file>.gz`, written before either is renamed and renamed into place
 * just before `file`.
 */
export function writeJsonAtomic(file, obj, { gz = false } = {}) {
  const text = JSON.stringify(obj, null, 2) + '\n';
  writeFilesAtomic(gz ? [[`${file}.gz`, zlib.gzipSync(text, GZIP)], [file, text]] : [[file, text]]);
}

/**
 * Renames each of `names` from the directory `from` into the directory `into` (made if missing),
 * one rename per file in the order given; anything else in `into` is left alone.
 */
export function renameInto(from, into, names) {
  fs.mkdirSync(into, { recursive: true });
  for (const name of names) fs.renameSync(path.join(from, name), path.join(into, name));
}

/**
 * A staging directory for files that go into place together: tmpPath(target), emptied and made.
 * `target` names what they make up: an output directory (maps/<map>, players, sounds) or one
 * item's files in one (weapons/<name>), so two items a process builds stage apart.
 * - `write(name, data)` writes a file into it, and `file(name)` is that file's path there.
 * - `commit(into, names)` renames each of `names` from it into the directory `into`
 *   (renameInto: one rename per file, in order, anything else in `into` left alone).
 * - `abort()` removes it with whatever is still in it: a caller's `finally` runs it after a
 *   commit as after a failure.
 */
export function staging(target) {
  const dir = tmpPath(target);
  const abort = () => fs.rmSync(dir, { recursive: true, force: true });
  abort();
  fs.mkdirSync(dir, { recursive: true });
  return {
    dir,
    file: (name) => path.join(dir, name),
    write: (name, data) => fs.writeFileSync(path.join(dir, name), data),
    commit: (into, names) => renameInto(dir, into, names),
    abort,
  };
}

/** A leftover's name, `<target>.tmp-<pid>` or `<target>.old-<pid>`, as `{ target, kind, pid }`; null for any other name. */
export function leftoverOf(name) {
  const m = /\.(tmp|old)-(\d+)$/.exec(name);
  return m ? { target: name.slice(0, -m[0].length), kind: m[1], pid: Number(m[2]) } : null;
}

/** Whether a process `pid` exists; one this user may not signal counts. */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
}

/**
 * Reclaims what killed runs left anywhere under `root`: a `<x>.tmp-<pid>` is removed, and a
 * `<x>.old-<pid>` goes back to `<x>` when `<x>` is missing (a rip killed mid-swap), else is
 * removed. A leftover whose pid is alive belongs to a script still running (one started by hand
 * beside a build) and is left alone. Symlinks are not followed, so a checkout whose raw/ links
 * another's leaves that tree to its owner, and a leftover is never looked into. Returns one line
 * per leftover reclaimed.
 */
export function sweepLeftovers(root, { alive = pidAlive } = {}) {
  const said = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      const left = leftoverOf(d.name);
      if (!left) {
        if (d.isDirectory()) walk(p);
        continue;
      }
      if (alive(left.pid)) continue;
      const target = path.join(dir, left.target);
      if (left.kind === 'old' && !fs.existsSync(target)) {
        fs.renameSync(p, target);
        said.push(`restoring leftover ${p} to ${target}`);
      } else {
        fs.rmSync(p, { recursive: true, force: true });
        said.push(`removing leftover ${p}`);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return said;
}

if (isMain(import.meta.url)) {
  const [command, root] = process.argv.slice(2);
  if (command !== 'sweep' || !root || process.argv.length !== 4) {
    console.error('usage: node tools/lib/stage.mjs sweep <dir>');
    process.exit(2);
  }
  try {
    for (const line of sweepLeftovers(root)) console.log(line);
  } catch (e) {
    console.error(`stage.mjs: ${e.message}`);
    process.exit(1);
  }
}
