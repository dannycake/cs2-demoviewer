import { describe, expect, it } from 'vitest';
import {
  ApiError,
  getDemo,
  packUrl,
  POLL_MAX_FAILURES,
  pollDemo,
  type DemoStatus,
} from '../src/api/demos';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function demo(status: DemoStatus['status'], error: string | null = null) {
  return { id: 'abc', status, map: 'de_mirage', rounds: 24, error };
}

/** A fetch that answers from `replies` in order and records the URLs it was asked for. */
function scripted(replies: (() => Response)[]) {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    const next = replies.shift();
    if (!next) throw new Error('no more replies');
    return next();
  }) as typeof fetch;
  return { urls, fetchFn };
}

describe('getDemo', () => {
  it('reads the status JSON', async () => {
    const { urls, fetchFn } = scripted([() => json(demo('parsing'))]);
    expect(await getDemo('abc', { fetchFn })).toEqual(demo('parsing'));
    expect(urls).toEqual(['/api/demos/abc']);
  });

  it("rejects with the server's error text and status", async () => {
    const { fetchFn } = scripted([() => json({ error: 'unknown demo' }, 404)]);
    const err = await getDemo('abc', { fetchFn }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('unknown demo');
    expect(err.status).toBe(404);
  });

  it('falls back to the HTTP status when the body is not JSON', async () => {
    const { fetchFn } = scripted([
      () => new Response('<html>bad gateway</html>', { status: 502 }),
    ]);
    const err = await getDemo('abc', { fetchFn }).catch((e) => e);
    expect(err.message).toBe('HTTP 502');
  });
});

describe('pollDemo', () => {
  it('polls until done, reporting every status', async () => {
    const { urls, fetchFn } = scripted([
      () => json(demo('queued')),
      () => json(demo('parsing')),
      () => json(demo('done')),
    ]);
    const seen: string[] = [];
    const last = await pollDemo('abc', (s) => seen.push(s.status), undefined, {
      fetchFn,
      intervalMs: 0,
    });
    expect(last.status).toBe('done');
    expect(seen).toEqual(['queued', 'parsing', 'done']);
    expect(urls).toHaveLength(3);
  });

  it('keeps polling while Valve is asked for the replay', async () => {
    const { fetchFn } = scripted([
      () => json(demo('resolving')),
      () => json(demo('downloading')),
      () => json(demo('done')),
    ]);
    const seen: DemoStatus['status'][] = [];
    await pollDemo('abc', (s) => seen.push(s.status), undefined, {
      fetchFn,
      intervalMs: 0,
    });
    expect(seen).toEqual(['resolving', 'downloading', 'done']);
  });

  it('stops at error and resolves with it', async () => {
    const { fetchFn } = scripted([
      () => json(demo('downloading')),
      () => json(demo('error', 'not a CS2 demo')),
    ]);
    const last = await pollDemo('abc', () => {}, undefined, {
      fetchFn,
      intervalMs: 0,
    });
    expect(last).toMatchObject({ status: 'error', error: 'not a CS2 demo' });
  });

  it('rides out a 5xx or a network failure between two answers', async () => {
    const { urls, fetchFn } = scripted([
      () => json(demo('parsing')),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => {
        throw new TypeError('Failed to fetch');
      },
      () => json(demo('parsing')),
      () => json({ error: 'busy' }, 503),
      () => json(demo('done')),
    ]);
    const seen: string[] = [];
    const last = await pollDemo('abc', (s) => seen.push(s.status), undefined, {
      fetchFn,
      intervalMs: 0,
    });
    expect(last.status).toBe('done');
    expect(seen).toEqual(['parsing', 'parsing', 'done']);
    expect(urls).toHaveLength(6);
  });

  it('rejects at once on a 404', async () => {
    const { urls, fetchFn } = scripted([
      () => json({ error: 'unknown demo' }, 404),
      () => json(demo('done')),
    ]);
    const err = await pollDemo('abc', () => {}, undefined, {
      fetchFn,
      intervalMs: 0,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(404);
    expect(urls).toHaveLength(1);
  });

  it('gives up after too many failures in a row', async () => {
    const { urls, fetchFn } = scripted(
      Array.from(
        { length: POLL_MAX_FAILURES + 5 },
        () => () => json({ error: 'down' }, 502)
      )
    );
    const err = await pollDemo('abc', () => {}, undefined, {
      fetchFn,
      intervalMs: 0,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('down');
    expect(urls).toHaveLength(POLL_MAX_FAILURES);
  });

  it('rejects with the abort reason once aborted', async () => {
    const ac = new AbortController();
    const { fetchFn } = scripted([
      () => json(demo('queued')),
      () => json(demo('queued')),
    ]);
    const p = pollDemo('abc', () => ac.abort(new Error('left')), ac.signal, {
      fetchFn,
      intervalMs: 10_000,
    });
    await expect(p).rejects.toThrow('left');
  });
});

describe('packUrl', () => {
  it('escapes the id', () => {
    expect(packUrl('abc')).toBe('/api/demos/abc/pack');
    expect(packUrl('a/b')).toBe('/api/demos/a%2Fb/pack');
  });
});
