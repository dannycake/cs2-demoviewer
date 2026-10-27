// The demo endpoints of the phase 1 server (server/README.md) and the map manifests of the
// phase 2 assets (tools/README.md). Errors carry the server's `{error}` text.

import { responseError } from '../errors';

/** `resolving`: a share code's replay URL is being asked of Valve. */
export type DemoStatusName =
  'resolving' | 'queued' | 'downloading' | 'parsing' | 'done' | 'error';

export interface DemoStatus {
  id: string;
  status: DemoStatusName;
  map: string | null;
  rounds: number | null;
  error: string | null;
  /** The match once `done`; null before, and for a replay packed before summaries. */
  summary: MatchSummary | null;
}

/** A player's line in a match summary. */
export interface SummaryPlayer {
  /** Decimal string, like the pack's. */
  steamid: string;
  name: string;
  /** The side of the last round: 2 = T, 3 = CT, 0 = unknown. */
  team: number;
  /** Players of the other side killed; team kills and suicides do not count. */
  kills: number;
  deaths: number;
}

/** The server's summary of a parsed match (server/crates/server/src/matches.rs). */
export interface MatchSummary {
  map: string;
  rounds: number;
  /** The score after the last round, by the side each team ended on. */
  scoreT: number;
  scoreCt: number;
  durationS: number;
  serverName: string;
  gameBuild: string;
  /** In the pack's player order. */
  players: SummaryPlayer[];
  /** When the demo was first stored, in Unix seconds. */
  createdUnix: number;
  /** When the match was played, if known (a share code's match info). */
  playedUnix: number | null;
  /** Valve's match id as a decimal string, if known. */
  matchId: string | null;
}

/** A request the server answered with a non-2xx status. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface RequestOptions {
  fetchFn?: typeof fetch;
  signal?: AbortSignal;
}

/** Time between two status requests while a demo is queued or being parsed. */
export const POLL_MS = 1000;
/** Consecutive transient failures `pollDemo` rides out before it gives up. */
export const POLL_MAX_FAILURES = 10;

const enc = encodeURIComponent;

export function packUrl(id: string): string {
  return `/api/demos/${enc(id)}/pack`;
}

/** A failed response as an ApiError: the server's `{error}` text, else the status line. */
export async function errorOf(res: Response): Promise<ApiError> {
  return new ApiError(await responseError(res), res.status);
}

export async function getDemo(
  id: string,
  { fetchFn = fetch, signal }: RequestOptions = {}
): Promise<DemoStatus> {
  const res = await fetchFn(`/api/demos/${enc(id)}`, { signal });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as DemoStatus;
}

/** Resolves after `ms`, or rejects with the abort reason when `signal` aborts first. */
export function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * True for a failure worth asking again: no answer at all (fetch's TypeError), a 408 or 429,
 * or a 5xx (a proxy or tunnel while the server restarts).
 */
function transient(e: unknown): boolean {
  if (e instanceof ApiError)
    return e.status === 408 || e.status === 429 || e.status >= 500;
  return e instanceof TypeError;
}

/**
 * Asks for the demo's status every `POLL_MS` until it is `done` or `error`, calling
 * `onStatus` with every answer, and resolves with the last one. A transient failure (see
 * `transient`) is retried with a growing pause, up to `POLL_MAX_FAILURES` in a row; any
 * other failed request, such as a 404 for an unknown demo, rejects at once. Aborting
 * `signal` rejects with its reason.
 */
export async function pollDemo(
  id: string,
  onStatus: (s: DemoStatus) => void,
  signal?: AbortSignal,
  opts: { fetchFn?: typeof fetch; intervalMs?: number } = {}
): Promise<DemoStatus> {
  const interval = opts.intervalMs ?? POLL_MS;
  let failures = 0;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    let s: DemoStatus;
    try {
      s = await getDemo(id, { fetchFn: opts.fetchFn, signal });
    } catch (e) {
      if (signal?.aborted) throw signal.reason;
      if (!transient(e) || ++failures >= POLL_MAX_FAILURES) throw e;
      await wait(interval * 2 ** Math.min(failures, 3), signal);
      continue;
    }
    failures = 0;
    if (signal?.aborted) throw signal.reason;
    onStatus(s);
    if (s.status === 'done' || s.status === 'error') return s;
    await wait(interval, signal);
  }
}
