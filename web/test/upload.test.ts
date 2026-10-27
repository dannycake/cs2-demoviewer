import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api/demos';
import {
  CHUNK_SIZE,
  RETRY_DELAY_MS,
  UploadError,
  ingestShareCode,
  ingestUrl,
  isDemoFile,
  resumeUpload,
  uploadDemo,
  type UploadProgress,
} from '../src/api/upload';

const MiB = 1024 * 1024;
const SIZE = 100 * MiB;

/** A demo whose every byte is its MiB index, so an inflated chunk says where it came from. */
function demoFile(name = 'match.dem', size = SIZE): File {
  const bytes = new Uint8Array(size);
  for (let m = 0; m * MiB < size; m++)
    bytes.fill(m & 0xff, m * MiB, Math.min(size, (m + 1) * MiB));
  return new File([bytes], name);
}

const DEMO = demoFile();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function gunzip(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

interface Put {
  n: number;
  encoding: string | null;
  bytes: Uint8Array;
}

type Failure = Response | Error | undefined;

/**
 * A fetch that plays the phase 1 upload API for upload `up1`. `fail(n, attempt)` may answer
 * a chunk PUT with an error response or throw (a network error) instead of storing it.
 */
function server(
  opts: {
    start?: () => Response;
    fail?: (n: number, attempt: number) => Failure;
    complete?: () => Response;
  } = {}
) {
  const calls: string[] = [];
  const puts: Put[] = [];
  const startBodies: unknown[] = [];
  const attempts = new Map<number, number>();
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url}`);
    if (method === 'POST' && url === '/api/uploads') {
      startBodies.push(JSON.parse(String(init?.body)));
      return (
        opts.start?.() ?? json({ uploadId: 'up1', chunkSize: CHUNK_SIZE }, 201)
      );
    }
    const put = /^\/api\/uploads\/up1\/(\d+)$/.exec(url);
    if (method === 'PUT' && put) {
      const n = Number(put[1]);
      const attempt = attempts.get(n) ?? 0;
      attempts.set(n, attempt + 1);
      const failure = opts.fail?.(n, attempt);
      if (failure instanceof Error) throw failure;
      if (failure) return failure;
      const encoding = new Headers(init?.headers).get('content-encoding');
      const sent = new Uint8Array(await new Response(init?.body).arrayBuffer());
      const bytes = encoding === 'gzip' ? await gunzip(sent) : sent;
      puts.push({ n, encoding, bytes });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && url === '/api/uploads/up1/complete')
      return opts.complete?.() ?? json({ demoId: 'demo1' }, 202);
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const putCalls = (n: number) =>
    calls.filter((c) => c === `PUT /api/uploads/up1/${n}`).length;
  return { calls, puts, startBodies, putCalls, fetchFn };
}

/** Collects the progress reports of one upload. */
function recorder() {
  const seen: UploadProgress[] = [];
  return { seen, onProgress: (p: UploadProgress) => seen.push({ ...p }) };
}

const fast = { retryDelayMs: 5 };

/** The upload `server()` opens. */
const UP1 = { id: 'up1', chunkSize: CHUNK_SIZE };

describe('uploadDemo', () => {
  it('sends a 100 MiB demo as four gzip chunks and completes', async () => {
    const { calls, puts, startBodies, fetchFn } = server();
    const { seen, onProgress } = recorder();
    const result = await uploadDemo(DEMO, onProgress, undefined, {
      ...fast,
      fetchFn,
    });

    expect(result).toEqual({ demoId: 'demo1', cached: false });
    expect(startBodies).toEqual([{ size: SIZE, name: 'match.dem' }]);
    expect(puts.map((p) => p.n)).toEqual([0, 1, 2, 3]);
    expect(puts.map((p) => p.bytes.length)).toEqual([
      32 * MiB,
      32 * MiB,
      32 * MiB,
      SIZE - 3 * 32 * MiB,
    ]);
    expect(puts.every((p) => p.encoding === 'gzip')).toBe(true);
    // Each chunk carries its own part of the file: its first byte is its first MiB's index.
    expect(puts.map((p) => p.bytes[0])).toEqual([0, 32, 64, 96]);
    expect(calls.at(-1)).toBe('POST /api/uploads/up1/complete');

    expect(seen.map((p) => `${p.phase} ${p.chunk}`)).toEqual([
      'gzip 0',
      'put 0',
      'gzip 1',
      'put 1',
      'gzip 2',
      'put 2',
      'gzip 3',
      'put 3',
      'complete 4',
    ]);
    expect(seen.every((p) => p.chunks === 4 && p.total === SIZE)).toBe(true);
    expect(seen.map((p) => p.bytes)).toEqual([
      0,
      0,
      32 * MiB,
      32 * MiB,
      64 * MiB,
      64 * MiB,
      96 * MiB,
      96 * MiB,
      SIZE,
    ]);
  });

  it('retries a chunk once after a network error', async () => {
    const { puts, putCalls, fetchFn } = server({
      fail: (n, attempt) =>
        n === 2 && attempt === 0 ? new TypeError('Failed to fetch') : undefined,
    });
    const result = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn,
    });
    expect(result.demoId).toBe('demo1');
    expect(putCalls(2)).toBe(2);
    expect(puts.map((p) => p.n)).toEqual([0, 1, 2, 3]);
  });

  it('retries a chunk once after a 5xx, waiting the retry delay', async () => {
    const times: number[] = [];
    const { putCalls, fetchFn } = server({
      fail: (n, attempt) => {
        if (n === 1) times.push(performance.now());
        return n === 1 && attempt === 0
          ? json({ error: 'the server is receiving 32 chunks already' }, 503)
          : undefined;
      },
    });
    await uploadDemo(DEMO, () => {}, undefined, {
      retryDelayMs: 50,
      fetchFn,
    });
    expect(putCalls(1)).toBe(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(45);
    expect(RETRY_DELAY_MS).toBe(1000);
  });

  it('throws an UploadError naming the chunk when the retry fails too', async () => {
    const { calls, putCalls, fetchFn } = server({
      fail: (n) => (n === 2 ? new TypeError('Failed to fetch') : undefined),
    });
    const err = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.chunk).toBe(2);
    expect(err.upload).toEqual({ id: 'up1', chunkSize: CHUNK_SIZE });
    expect(err.message).toContain('Failed to fetch');
    expect(putCalls(2)).toBe(2);
    expect(putCalls(3)).toBe(0);
    expect(calls).not.toContain('POST /api/uploads/up1/complete');
  });

  it("throws a 4xx at once with the server's text", async () => {
    const { putCalls, fetchFn } = server({
      fail: (n) =>
        n === 1
          ? json({ error: 'chunk 1 is over the chunk size' }, 413)
          : undefined,
    });
    const err = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toBe('chunk 1 is over the chunk size');
    expect(err.status).toBe(413);
    expect(err.chunk).toBe(1);
    expect(putCalls(1)).toBe(1);
    expect(putCalls(2)).toBe(0);
  });

  it('throws when the upload cannot start, with no upload to resume', async () => {
    const { calls, fetchFn } = server({
      start: () => json({ error: 'too many uploads from this address' }, 429),
    });
    const err = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toBe('too many uploads from this address');
    expect(err.status).toBe(429);
    expect(err.upload).toBeNull();
    expect(calls).toEqual(['POST /api/uploads']);
  });

  it('resolves cached when the server already has the demo', async () => {
    const { fetchFn } = server({
      complete: () => json({ demoId: 'known', cached: true }),
    });
    expect(
      await uploadDemo(DEMO, () => {}, undefined, { ...fast, fetchFn })
    ).toEqual({ demoId: 'known', cached: true });
  });

  it('names the missing chunk when complete refuses', async () => {
    const { fetchFn } = server({
      complete: () => json({ error: 'missing chunk 1' }, 409),
    });
    const err = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect(err.message).toBe('missing chunk 1');
    expect(err.chunk).toBe(1);
    expect(err.upload).toEqual({ id: 'up1', chunkSize: CHUNK_SIZE });
  });

  it('sends an already compressed demo without gzip', async () => {
    const { puts, fetchFn } = server();
    const { seen, onProgress } = recorder();
    await uploadDemo(
      demoFile('match.dem.bz2', 40 * MiB),
      onProgress,
      undefined,
      {
        ...fast,
        fetchFn,
      }
    );
    expect(puts.map((p) => [p.n, p.encoding, p.bytes.length])).toEqual([
      [0, null, 32 * MiB],
      [1, null, 8 * MiB],
    ]);
    expect(seen.map((p) => p.phase)).toEqual(['put', 'put', 'complete']);
  });

  it('rejects with the abort reason and stops sending', async () => {
    const ac = new AbortController();
    const { calls, fetchFn } = server();
    const p = uploadDemo(
      DEMO,
      (pr) => {
        if (pr.phase === 'put' && pr.chunk === 1)
          ac.abort(new Error('cancelled'));
      },
      ac.signal,
      { ...fast, fetchFn }
    );
    await expect(p).rejects.toThrow('cancelled');
    expect(calls.filter((c) => c.startsWith('PUT'))).toEqual([
      'PUT /api/uploads/up1/0',
    ]);
  });
});

describe('resumeUpload', () => {
  it('sends only the chunks from the failed one on, then completes', async () => {
    const { calls, puts, fetchFn } = server();
    const { seen, onProgress } = recorder();
    const result = await resumeUpload(DEMO, UP1, 2, onProgress, undefined, {
      ...fast,
      fetchFn,
    });
    expect(result).toEqual({ demoId: 'demo1', cached: false });
    expect(calls).not.toContain('POST /api/uploads');
    expect(puts.map((p) => p.n)).toEqual([2, 3]);
    expect(puts.map((p) => p.bytes[0])).toEqual([64, 96]);
    expect(seen[0]).toMatchObject({ phase: 'gzip', chunk: 2, bytes: 64 * MiB });
  });

  it('only completes when every chunk was sent', async () => {
    const { calls, fetchFn } = server();
    await resumeUpload(DEMO, UP1, 4, () => {}, undefined, {
      ...fast,
      fetchFn,
    });
    expect(calls).toEqual(['POST /api/uploads/up1/complete']);
  });

  it('slices the file by the chunk size the server opened the upload with', async () => {
    // A server whose chunks are 16 MiB: chunk 3 fails, and so does its one retry; resuming
    // carries on from there.
    const opened = server({
      start: () => json({ uploadId: 'up1', chunkSize: 16 * MiB }, 201),
      fail: (n) => (n === 3 ? json({ error: 'disk full' }, 507) : undefined),
    });
    const err = await uploadDemo(DEMO, () => {}, undefined, {
      ...fast,
      fetchFn: opened.fetchFn,
    }).then(
      () => null,
      (e: unknown) => e
    );
    if (!(err instanceof UploadError) || !err.upload)
      throw new Error(`not a resumable UploadError: ${String(err)}`);
    expect(err.chunk).toBe(3);
    expect(err.upload).toEqual({ id: 'up1', chunkSize: 16 * MiB });
    expect(opened.puts.map((p) => p.bytes[0])).toEqual([0, 16, 32]);

    const { puts, fetchFn } = server();
    const { seen, onProgress } = recorder();
    await resumeUpload(DEMO, err.upload, err.chunk, onProgress, undefined, {
      ...fast,
      fetchFn,
    });
    // 100 MiB in 16 MiB chunks: 3 to 6, each starting at its own MiB.
    expect(puts.map((p) => p.n)).toEqual([3, 4, 5, 6]);
    expect(puts.map((p) => p.bytes[0])).toEqual([48, 64, 80, 96]);
    expect(puts.map((p) => p.bytes.length)).toEqual([
      16 * MiB,
      16 * MiB,
      16 * MiB,
      SIZE - 6 * 16 * MiB,
    ]);
    expect(seen[0]).toMatchObject({
      chunk: 3,
      chunks: 7,
      chunkSize: 16 * MiB,
      bytes: 48 * MiB,
    });
  });
});

describe('isDemoFile', () => {
  it('accepts .dem, .dem.bz2 and .dem.gz in any case', () => {
    for (const name of ['a.dem', 'B.DEM', 'c.dem.bz2', 'd.Dem.GZ'])
      expect(isDemoFile(name)).toBe(true);
  });

  it('refuses anything else', () => {
    for (const name of ['a.zip', 'dem', 'a.bz2', 'a.dem.zip', 'a.demo'])
      expect(isDemoFile(name)).toBe(false);
  });
});

describe('ingestUrl', () => {
  it('posts the URL and returns the demo id', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return json({ demoId: 'fromurl' }, 202);
    }) as typeof fetch;
    const replay = 'http://replay183.valve.net/730/003712345678_1234.dem.bz2';
    expect(await ingestUrl(replay, { fetchFn })).toEqual({ demoId: 'fromurl' });
    expect(seen).toEqual([{ url: '/api/demos', body: { url: replay } }]);
  });

  it("rejects with the server's text", async () => {
    const fetchFn = (async () =>
      json(
        { error: 'only Valve replay URLs are accepted' },
        400
      )) as typeof fetch;
    const err = await ingestUrl('http://example.com/x', { fetchFn }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('only Valve replay URLs are accepted');
    expect(err.status).toBe(400);
  });
});

describe('ingestShareCode', () => {
  const CODE = 'CSGO-GADqf-jjyJ8-cSP2r-smZRo-TO2xK';

  it('posts the code and returns the demo id', async () => {
    const seen: { url: string; body: unknown }[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return json({ demoId: 'fromcode' }, 202);
    }) as typeof fetch;
    expect(await ingestShareCode(CODE, { fetchFn })).toEqual({
      demoId: 'fromcode',
      cached: false,
    });
    expect(seen).toEqual([{ url: '/api/demos', body: { sharecode: CODE } }]);
  });

  it('says when the site already has the match', async () => {
    const fetchFn = (async () =>
      json({ demoId: 'known', cached: true })) as typeof fetch;
    expect(await ingestShareCode(CODE, { fetchFn })).toEqual({
      demoId: 'known',
      cached: true,
    });
  });

  it("rejects with the server's text", async () => {
    const copy =
      "Valve no longer has this match's replay (they keep them about a month)";
    const fetchFn = (async () => json({ error: copy }, 404)) as typeof fetch;
    const err = await ingestShareCode(CODE, { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(copy);
    expect(err.status).toBe(404);
  });

  it('rejects an answer without a demo id', async () => {
    const fetchFn = (async () => json({}, 202)) as typeof fetch;
    const err = await ingestShareCode(CODE, { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
  });
});
