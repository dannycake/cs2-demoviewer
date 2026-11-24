// Fetch-and-parse core of the pack worker, kept free of worker globals so it is testable
// under node with a stubbed fetch.

import { responseError } from '../errors';
import { inflateIfGzip, parsePack } from './reader';
import type { Pack } from './types';

export type PackProgress = (loaded: number, total: number | null) => void;

/** A pack request the server refused: `message` is its `{error}` text. */
export class PackLoadError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'PackLoadError';
    this.status = status;
  }
}

/**
 * Fetches a pack, reporting bytes received, then inflates (if still gzip) and parses it.
 * `total` is null when unknown: with `Content-Encoding: gzip` the browser hands over the
 * inflated stream while `Content-Length` counts the compressed bytes, so the two cannot be
 * compared; the inflated size is then `X-Pack-Size`, where the server sends it.
 */
export async function fetchPack(
  url: string,
  onProgress: PackProgress,
  fetchFn: typeof fetch = fetch,
  maxBytes = MAX_PACK_BYTES
): Promise<Pack> {
  const res = await fetchFn(url);
  if (!res.ok) throw new PackLoadError(await responseError(res), res.status);
  const bytes = await readBody(res, onProgress, maxBytes);
  return parsePack(await inflateIfGzip(bytes, maxBytes, tooLarge));
}

/**
 * The most bytes a replay may take once read and inflated. A real match is about 20 MB;
 * a crafted demo could otherwise make a shared link exhaust the viewer's memory (security
 * audit 2026-10-22).
 */
export const MAX_PACK_BYTES = 256 * 1024 * 1024;

const tooLarge = () =>
  new PackLoadError('this replay is too large to open', null);

function bodyTotal(res: Response): number | null {
  const size = (name: string) => {
    const n = Number(res.headers.get(name) ?? NaN);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity')
    return size('x-pack-size');
  return size('content-length');
}

async function readBody(
  res: Response,
  onProgress: PackProgress,
  maxBytes: number
): Promise<Uint8Array> {
  const total = bodyTotal(res);
  if (!res.body) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) throw tooLarge();
    onProgress(bytes.length, total);
    return bytes;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (loaded > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    onProgress(loaded, total);
  }
  if (chunks.length === 1) return chunks[0];
  const bytes = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    bytes.set(c, off);
    off += c.length;
  }
  return bytes;
}

/**
 * Every column buffer of `pack`, once each, for `postMessage(pack, { transfer })`. A pack
 * without `TRK2` shares one money, ammo and gear array among a round's players: the set lists
 * each once, and the clone keeps them shared.
 */
export function packTransferables(pack: Pack): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>();
  const add = (a: Int16Array | Uint16Array | Uint8Array) =>
    buffers.add(a.buffer as ArrayBuffer);
  for (const round of pack.rounds) {
    for (const t of round.players) {
      add(t.x);
      add(t.y);
      add(t.z);
      add(t.yaw);
      add(t.pitch);
      add(t.health);
      add(t.armor);
      add(t.flags);
      add(t.duck);
      add(t.weapon);
      add(t.money);
      add(t.ammo);
      add(t.gear);
    }
  }
  for (const g of pack.grenades) {
    add(g.x);
    add(g.y);
    add(g.z);
  }
  return [...buffers];
}
