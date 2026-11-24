#!/usr/bin/env node
// Warm a list of players' profiles through the site's own API.
//
// Usage: node scripts/seed-players.mjs --base https://skunk.club --file players.txt [--delay-ms 125000]
//
// Input: one query per line, anything the site's one input accepts (Steam profile URL,
// SteamID64, custom URL name, friend code). Blank lines and lines starting with # are skipped.
// For each: GET /api/lookup?q=..., then GET /api/players/{steamid}, which starts the background
// Steam fetch for a missing or stale profile.
// Output: `ok <steamid> <name>`, `not found <query>`, `error <status> <query>` or
// `error net <query>`, one per input. Exit 0 at the end regardless.
//
// Rate limit: Steam-backed lookups are limited per client address (60 per hour by default). A
// custom URL name costs two of them (the lookup, then /api/players/{id}), so the default pause
// between inputs is 125000 ms: under 60 an hour for any input. A smaller --delay-ms (e.g. 1500)
// is fine against your own server.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The default pause between inputs, in ms: two lookups each stay under 60 an hour. */
export const DELAY_MS = 125000;

export function parseLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export async function seedOne(base, query, fetchImpl = fetch) {
  const found = await fetchImpl(`${base}/api/lookup?q=${encodeURIComponent(query)}`);
  if (found.status === 404) return { kind: 'not found' };
  if (!found.ok) return { kind: 'error', status: found.status };
  const hit = await found.json();
  // A name search (a list of hits) or a match is not one player.
  if (!hit || typeof hit.steamid !== 'string') return { kind: 'not found' };
  const profile = await fetchImpl(`${base}/api/players/${hit.steamid}`);
  if (!profile.ok) return { kind: 'error', status: profile.status };
  const body = await profile.json().catch(() => ({}));
  return { kind: 'ok', steamid: hit.steamid, name: body?.name ?? '' };
}

function line(query, r) {
  if (r.kind === 'ok') return `ok ${r.steamid} ${r.name}`;
  if (r.kind === 'not found') return `not found ${query}`;
  return `error ${r.status} ${query}`;
}

async function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i += 2) opt[argv[i]] = argv[i + 1];
  if (!opt['--base'] || !opt['--file']) {
    console.error(`usage: seed-players.mjs --base https://skunk.club --file players.txt [--delay-ms ${DELAY_MS}]`);
    process.exit(2);
  }
  const base = opt['--base'].replace(/\/+$/, '');
  const delay = Number(opt['--delay-ms'] ?? DELAY_MS);
  const queries = parseLines(readFileSync(opt['--file'], 'utf8'));
  for (const [i, q] of queries.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, delay));
    try {
      console.log(line(q, await seedOne(base, q)));
    } catch {
      console.log(`error net ${q}`);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main(process.argv.slice(2));
