// Precompressed siblings: `<file>.gz` beside a served asset, which the server sends as
// `Content-Encoding: gzip` to clients that accept it (tower-http `precompressed_gzip`).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** gzip -9, as the player and weapon shrinks use. */
export const GZIP = Object.freeze({ level: 9 });

/** Writes `<dir>/<name>.gz` for each name; returns each file's size and its sibling's. */
export function writeGzSiblings(dir, names) {
  return names.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    const gz = zlib.gzipSync(bytes, GZIP);
    fs.writeFileSync(path.join(dir, `${name}.gz`), gz);
    return { name, bytes: bytes.length, gzBytes: gz.length };
  });
}

/** `ok` when `<file>.gz` inflates to `file`'s bytes, `missing` without one, `stale` otherwise. */
export function gzSiblingState(file) {
  const gzFile = `${file}.gz`;
  if (!fs.existsSync(gzFile)) return 'missing';
  try {
    return zlib.gunzipSync(fs.readFileSync(gzFile)).equals(fs.readFileSync(file)) ? 'ok' : 'stale';
  } catch {
    return 'stale';
  }
}
