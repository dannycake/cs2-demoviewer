import { describe, expect, it } from 'vitest';
import { getSite } from '../src/api/site';

/** A fetch that answers every request with `reply()` and records the URLs it was asked for. */
function answering(reply: () => Response | Promise<Response>) {
  const urls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return reply();
  }) as typeof fetch;
  return { urls, fetchFn };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('getSite', () => {
  it("reads the server's switches", async () => {
    const { urls, fetchFn } = answering(() => json({ sharecodes: true }));
    expect(await getSite({ fetchFn })).toEqual({ sharecodes: true });
    expect(urls).toEqual(['/api/site']);
    const off = answering(() => json({ sharecodes: false }));
    expect(await getSite({ fetchFn: off.fetchFn })).toEqual({
      sharecodes: false,
    });
  });

  it('turns everything off when the server fails', async () => {
    const { fetchFn } = answering(() => json({ error: 'internal' }, 500));
    expect(await getSite({ fetchFn })).toEqual({ sharecodes: false });
  });

  it('turns everything off on a body that is not the switches', async () => {
    for (const body of [
      '<html>bad gateway</html>',
      'null',
      '[]',
      '{}',
      '{"sharecodes":"yes"}',
      '{"sharecodes":1}',
    ]) {
      const { fetchFn } = answering(() => new Response(body, { status: 200 }));
      expect(await getSite({ fetchFn }), body).toEqual({ sharecodes: false });
    }
  });

  it('turns everything off when there is no answer', async () => {
    const { fetchFn } = answering(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await getSite({ fetchFn })).toEqual({ sharecodes: false });
  });
});
