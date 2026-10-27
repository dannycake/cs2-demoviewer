// Writes a gzip -9 `.gz` beside every text file of the build (dist/: the scripts, styles,
// index.html, SVGs, JSON) over 1 KB that gzip makes smaller, which the server sends as
// `Content-Encoding: gzip` to browsers that accept it (tower-http `precompressed_gzip`). The
// app's script drops from about 1.25 MB to 0.38 MB on the wire. Run after `vite build`.
//
//   node scripts/gzip-dist.mjs [dist]

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const TEXT = /\.(js|mjs|css|html|svg|json|txt|map|wasm)$/;
const MIN_BYTES = 1024;

const root = process.argv[2] ?? 'dist';
let before = 0;
let after = 0;
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (TEXT.test(name) && statSync(file).size >= MIN_BYTES) {
      const bytes = readFileSync(file);
      const gz = gzipSync(bytes, { level: 9 });
      if (gz.length >= bytes.length) continue;
      writeFileSync(`${file}.gz`, gz);
      before += bytes.length;
      after += gz.length;
    }
  }
};
walk(root);
console.log(
  `gzip-dist: ${(before / 1e6).toFixed(2)} MB of text → ${(after / 1e6).toFixed(2)} MB gzipped`
);
