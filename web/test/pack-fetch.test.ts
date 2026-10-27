import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fetchPack, PackLoadError, packTransferables } from '../src/pack/fetch';
import { buildPack, type BuildOptions } from './helpers/build-pack';

const OPTS: BuildOptions = {
  players: 2,
  rounds: [
    { samples: 3, start_tick: 100 },
    { samples: 4, start_tick: 500 },
  ],
  tick_step: 2,
  grenades: [{ samples: 2 }, { samples: 1 }],
};

/** A fetch that answers every request with `body` in chunks of `chunk` bytes. */
function fakeFetch(
  body: Uint8Array,
  init: ResponseInit = {},
  chunk = 50
): typeof fetch {
  return async () => {
    let off = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (off >= body.length) return c.close();
        c.enqueue(body.slice(off, off + chunk));
        off += chunk;
      },
    });
    return new Response(stream, init);
  };
}

function recorder() {
  const calls: [number, number | null][] = [];
  return {
    calls,
    fn: (loaded: number, total: number | null) => calls.push([loaded, total]),
  };
}

describe('fetchPack', () => {
  it('reads the body with progress and parses it', async () => {
    const bytes = buildPack(OPTS);
    const p = recorder();
    const headers = { 'content-length': String(bytes.length) };
    const pack = await fetchPack('/x', p.fn, fakeFetch(bytes, { headers }));
    expect(pack.header.rounds).toHaveLength(2);
    expect(p.calls.length).toBeGreaterThan(2);
    expect(p.calls.at(-1)).toEqual([bytes.length, bytes.length]);
    const loaded = p.calls.map(([l]) => l);
    expect(loaded).toEqual([...loaded].sort((a, b) => a - b));
  });

  it('reports an unknown total when the transfer was content-encoded', async () => {
    // fetch hands back the inflated stream while content-length counts the gzip bytes.
    const bytes = buildPack(OPTS);
    const p = recorder();
    const headers = { 'content-length': '10', 'content-encoding': 'gzip' };
    await fetchPack('/x', p.fn, fakeFetch(bytes, { headers }));
    expect(p.calls.at(-1)).toEqual([bytes.length, null]);
  });

  it('inflates a body that is still gzip (a pack served as a file)', async () => {
    const gz = new Uint8Array(gzipSync(buildPack(OPTS)));
    const pack = await fetchPack('/x', () => {}, fakeFetch(gz));
    expect(pack.grenades).toHaveLength(2);
  });

  it("rejects with the server's error text on a non-2xx", async () => {
    const body = new TextEncoder().encode(
      JSON.stringify({ error: 'not ready' })
    );
    const res = fetchPack('/x', () => {}, fakeFetch(body, { status: 409 }));
    await expect(res).rejects.toThrow(PackLoadError);
    await expect(
      fetchPack('/x', () => {}, fakeFetch(body, { status: 409 }))
    ).rejects.toMatchObject({ message: 'not ready', status: 409 });
  });

  it('falls back to the status when the error body is not JSON', async () => {
    const body = new TextEncoder().encode('<html>Bad Gateway</html>');
    await expect(
      fetchPack(
        '/x',
        () => {},
        fakeFetch(body, { status: 502, statusText: 'Bad Gateway' })
      )
    ).rejects.toMatchObject({ message: 'HTTP 502 Bad Gateway', status: 502 });
  });

  it('refuses a replay larger than it can safely hold, read or inflated', async () => {
    const big = buildPack(OPTS);
    await expect(
      fetchPack('/x', () => {}, fakeFetch(big), big.length - 1)
    ).rejects.toThrow(/too large/);
    const gz = new Uint8Array(gzipSync(big));
    await expect(
      fetchPack('/x', () => {}, fakeFetch(gz), big.length - 1)
    ).rejects.toThrow(/too large/);
    // At the limit it opens.
    await expect(
      fetchPack('/x', () => {}, fakeFetch(gz), big.length)
    ).resolves.toBeDefined();
  });

  it('rejects a body that is not a pack', async () => {
    const body = new TextEncoder().encode('hello world');
    await expect(fetchPack('/x', () => {}, fakeFetch(body))).rejects.toThrow(
      /magic/
    );
  });
});

describe('packTransferables', () => {
  const TRK2 = ['HDR1', 'TRK1', 'TRK2', 'EVT1', 'GRN1', 'GRB1'];

  it('lists every column buffer exactly once, TRK2 included', async () => {
    const pack = await fetchPack(
      '/x',
      () => {},
      fakeFetch(buildPack({ ...OPTS, order: TRK2 }))
    );
    const list = packTransferables(pack);
    // 2 rounds x 2 players x (10 + 3) columns + 2 grenades x 3 columns.
    expect(list).toHaveLength(2 * 2 * 13 + 2 * 3);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain(pack.rounds[1].players[0].weapon.buffer);
    expect(list).toContain(pack.rounds[1].players[1].money.buffer);
    expect(list).toContain(pack.rounds[0].players[0].ammo.buffer);
    expect(list).toContain(pack.rounds[0].players[1].gear.buffer);
    expect(list).toContain(pack.grenades[1].z.buffer);
  });

  it("lists a pack without TRK2's shared defaults once a round", async () => {
    const pack = await fetchPack('/x', () => {}, fakeFetch(buildPack(OPTS)));
    const list = packTransferables(pack);
    // 2 rounds x (2 players x 10 columns + 3 shared defaults) + 2 grenades x 3 columns.
    expect(list).toHaveLength(2 * (2 * 10 + 3) + 2 * 3);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toContain(pack.rounds[1].players[0].money.buffer);
  });

  it('survives a structured-clone transfer intact', async () => {
    const pack = await fetchPack(
      '/x',
      () => {},
      fakeFetch(buildPack({ ...OPTS, order: TRK2 }))
    );
    const x = Array.from(pack.rounds[0].players[1].x);
    const money = Array.from(pack.rounds[1].players[0].money);
    const copy = structuredClone(pack, { transfer: packTransferables(pack) });
    expect(Array.from(copy.rounds[0].players[1].x)).toEqual(x);
    expect(Array.from(copy.rounds[1].players[0].money)).toEqual(money);
    // Detached in the sender: moved, not copied.
    expect(pack.rounds[0].players[1].x.length).toBe(0);
    expect(pack.rounds[1].players[0].money.length).toBe(0);
  });
});
