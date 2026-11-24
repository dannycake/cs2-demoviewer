// Getting a demo onto the phase 1 server (server/README.md). A file goes up in chunks:
// `POST /api/uploads {size,name}` opens an upload, every 32 MiB chunk is sent gzip-encoded
// as `PUT /api/uploads/{id}/{n}`, and `POST /api/uploads/{id}/complete` queues the demo, or
// answers `cached: true` when the same demo is already packed. A chunk whose PUT fails on
// the network, with a 5xx or with a 408 idle timeout is sent once more after a second; a
// second failure, or any other 4xx, throws an UploadError that names the chunk and the
// server's chunk size, and `resumeUpload` carries on from that chunk in the same upload. The next chunk is compressed
// while the current one is on the wire. A Valve replay URL, or a match share code, goes to
// `POST /api/demos`.

import { messageOf } from '../errors';
import { ApiError, errorOf, wait, type RequestOptions } from './demos';

/**
 * The server's chunk size today; every chunk but the last is exactly this long. An upload
 * slices the file by the size the server answers when it opens it, not by this: the view only
 * estimates with it before that answer.
 */
export const CHUNK_SIZE = 32 * 1024 * 1024;

/** The pause before a failed chunk is sent the second (and last) time. */
export const RETRY_DELAY_MS = 1000;

export type UploadPhase = 'gzip' | 'put' | 'complete';

export interface UploadProgress {
  /** The 0-based chunk being compressed or sent; `chunks` once every chunk is sent. */
  chunk: number;
  chunks: number;
  /** The upload's chunk size, as the server opened it. */
  chunkSize: number;
  /** File bytes in the chunks already sent. */
  bytes: number;
  /** The file's size. */
  total: number;
  phase: UploadPhase;
}

export type OnUploadProgress = (p: UploadProgress) => void;

export interface UploadOptions {
  fetchFn?: typeof fetch;
  retryDelayMs?: number;
}

export interface UploadResult {
  demoId: string;
  cached: boolean;
}

/** The server's upload: its id and the chunk size it opened it with. */
export interface OpenUpload {
  id: string;
  chunkSize: number;
}

/**
 * An upload that stopped; `resumeUpload(file, error.upload, error.chunk, …)` continues it.
 */
export class UploadError extends Error {
  /** The chunk to send next: the one that failed, or `chunks` when only `complete` failed. */
  readonly chunk: number;
  /** The server's upload, or null when none was opened (the upload starts over). */
  readonly upload: OpenUpload | null;
  /** The HTTP status, or null for a network or file read error. */
  readonly status: number | null;

  constructor(
    message: string,
    chunk: number,
    upload: OpenUpload | null = null,
    status: number | null = null
  ) {
    super(message);
    this.name = 'UploadError';
    this.chunk = chunk;
    this.upload = upload;
    this.status = status;
  }

  /** Whether the upload can go on from `chunk`: it was opened and the server still has it. */
  get resumable(): boolean {
    return this.upload !== null && this.status !== 404;
  }
}

const DEMO_NAME = /\.dem(?:\.bz2|\.gz)?$/i;
const COMPRESSED_NAME = /\.(?:bz2|gz)$/i;

/** `.dem`, `.dem.bz2` or `.dem.gz`, the files the server takes. */
export function isDemoFile(name: string): boolean {
  return DEMO_NAME.test(name);
}

const enc = encodeURIComponent;

/** A fetch that threw: the abort reason when `signal` fired, else a network UploadError. */
function networkFailure(
  e: unknown,
  signal: AbortSignal | undefined,
  chunk: number,
  upload: OpenUpload | null
): unknown {
  if (signal?.aborted) return signal.reason;
  return new UploadError(`network error: ${messageOf(e)}`, chunk, upload);
}

function gzip(blob: Blob): Promise<Blob> {
  return new Response(
    blob.stream().pipeThrough(new CompressionStream('gzip'))
  ).blob();
}

/** Worth sending again: nothing came back, the server failed, or it timed the PUT out. */
function retryable(status: number | null): boolean {
  return status === null || status === 408 || status >= 500;
}

/**
 * Uploads `file` in chunks and completes it, reporting each step to `onProgress`. Rejects
 * with an UploadError (or the abort reason when `signal` fires).
 */
export async function uploadDemo(
  file: File,
  onProgress: OnUploadProgress,
  signal?: AbortSignal,
  opts: UploadOptions = {}
): Promise<UploadResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  signal?.throwIfAborted();
  let res: Response;
  try {
    res = await fetchFn('/api/uploads', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ size: file.size, name: file.name }),
      signal,
    });
  } catch (e) {
    throw networkFailure(e, signal, 0, null);
  }
  if (!res.ok) {
    const err = await errorOf(res);
    throw new UploadError(err.message, 0, null, res.status);
  }
  const body = (await res.json()) as {
    uploadId?: unknown;
    chunkSize?: unknown;
  };
  const { uploadId, chunkSize } = body;
  if (
    typeof uploadId !== 'string' ||
    !uploadId ||
    typeof chunkSize !== 'number' ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  )
    throw new UploadError('the server did not open an upload', 0);
  return send(file, { id: uploadId, chunkSize }, 0, onProgress, signal, opts);
}

/**
 * Continues `upload` of `file` (an UploadError's `upload`) from chunk `fromChunk` (its
 * `chunk`), then completes it, slicing the file by the chunk size the server opened it with.
 * Only within the session that started it: the server forgets an upload nobody touched for
 * an hour.
 */
export function resumeUpload(
  file: File,
  upload: OpenUpload,
  fromChunk: number,
  onProgress: OnUploadProgress,
  signal?: AbortSignal,
  opts: UploadOptions = {}
): Promise<UploadResult> {
  return send(file, upload, fromChunk, onProgress, signal, opts);
}

async function send(
  file: File,
  upload: OpenUpload,
  from: number,
  onProgress: OnUploadProgress,
  signal: AbortSignal | undefined,
  opts: UploadOptions
): Promise<UploadResult> {
  const { id: uploadId, chunkSize } = upload;
  const fetchFn = opts.fetchFn ?? fetch;
  const delay = opts.retryDelayMs ?? RETRY_DELAY_MS;
  const total = file.size;
  const chunks = Math.ceil(total / chunkSize);
  // A .bz2 or .gz demo is already compressed; gzip would only cost time and a few bytes.
  const encode = !COMPRESSED_NAME.test(file.name);

  const report = (chunk: number, phase: UploadPhase) => {
    onProgress({
      chunk,
      chunks,
      chunkSize,
      bytes: Math.min(total, chunk * chunkSize),
      total,
      phase,
    });
    signal?.throwIfAborted();
  };

  const prepare = (n: number): Promise<Blob> => {
    const slice = file.slice(
      n * chunkSize,
      Math.min(total, (n + 1) * chunkSize)
    );
    if (!encode) return Promise.resolve(slice);
    const body = gzip(slice).catch((e: unknown) => {
      throw new UploadError(
        `could not read the file: ${messageOf(e)}`,
        n,
        upload
      );
    });
    // Awaited when its turn comes; dropped unawaited when an earlier chunk fails.
    body.catch(() => {});
    return body;
  };

  const put = async (n: number, body: Blob): Promise<UploadError | null> => {
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
    };
    if (encode) headers['content-encoding'] = 'gzip';
    let res: Response;
    try {
      res = await fetchFn(`/api/uploads/${enc(uploadId)}/${n}`, {
        method: 'PUT',
        headers,
        body,
        signal,
      });
    } catch (e) {
      const failure = networkFailure(e, signal, n, upload);
      if (failure instanceof UploadError) return failure;
      throw failure;
    }
    if (res.ok) return null;
    const err = await errorOf(res);
    return new UploadError(err.message, n, upload, res.status);
  };

  let next = from < chunks ? prepare(from) : null;
  for (let n = from; n < chunks; n++) {
    if (encode) report(n, 'gzip');
    const body = await (next as Promise<Blob>);
    signal?.throwIfAborted();
    next = n + 1 < chunks ? prepare(n + 1) : null;
    report(n, 'put');
    for (let attempt = 0; ; attempt++) {
      const failure = await put(n, body);
      if (!failure) break;
      if (attempt >= 1 || !retryable(failure.status)) throw failure;
      await wait(delay, signal);
    }
  }

  report(chunks, 'complete');
  return complete(fetchFn, upload, chunks, signal);
}

async function complete(
  fetchFn: typeof fetch,
  upload: OpenUpload,
  chunks: number,
  signal: AbortSignal | undefined
): Promise<UploadResult> {
  let res: Response;
  try {
    res = await fetchFn(`/api/uploads/${enc(upload.id)}/complete`, {
      method: 'POST',
      signal,
    });
  } catch (e) {
    throw networkFailure(e, signal, chunks, upload);
  }
  if (!res.ok) {
    const err = await errorOf(res);
    // `409 missing chunk n`: send again from that chunk.
    const missing = /missing chunk (\d+)/.exec(err.message);
    const chunk = missing ? Math.min(Number(missing[1]), chunks) : chunks;
    throw new UploadError(err.message, chunk, upload, res.status);
  }
  const body = (await res.json()) as { demoId?: unknown; cached?: unknown };
  if (typeof body.demoId !== 'string' || !body.demoId)
    throw new UploadError(
      'the server did not return a demo id',
      chunks,
      upload,
      res.status
    );
  return { demoId: body.demoId, cached: body.cached === true };
}

/** Asks the server to download a demo from a Valve replay URL (the server checks it). */
export async function ingestUrl(
  url: string,
  opts: RequestOptions = {}
): Promise<{ demoId: string }> {
  const { demoId } = await postDemo({ url }, opts);
  return { demoId };
}

/**
 * Asks the server for the match a share code names: it has gcbot ask Valve for the replay URL
 * and downloads that, or answers `cached` when the site already has the match.
 */
export function ingestShareCode(
  code: string,
  opts: RequestOptions = {}
): Promise<UploadResult> {
  return postDemo({ sharecode: code }, opts);
}

/**
 * Asks the server for the demo of a FACEIT match, by FACEIT's id of it: the server asks FACEIT
 * for the match and downloads its demo, or answers `cached` when the site already has the match.
 */
export function ingestFaceitMatch(
  matchId: string,
  opts: RequestOptions = {}
): Promise<UploadResult> {
  return postDemo({ faceitMatch: matchId }, opts);
}

async function postDemo(
  body: { url: string } | { sharecode: string } | { faceitMatch: string },
  { fetchFn = fetch, signal }: RequestOptions
): Promise<UploadResult> {
  const res = await fetchFn('/api/demos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await errorOf(res);
  const answer = (await res.json()) as { demoId?: unknown; cached?: unknown };
  if (typeof answer.demoId !== 'string' || !answer.demoId)
    throw new ApiError('the server did not return a demo id', res.status);
  return { demoId: answer.demoId, cached: answer.cached === true };
}
