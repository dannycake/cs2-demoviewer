// The map manifest (api/assets.ts `mapManifest`): one request per map for the whole viewer (the
// page's "no assets" notice, the 3D view, the radar), kept once it is in; a 404 is "no assets",
// any other failure rejects, and neither is kept.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetMapManifests, mapManifest } from '../src/api/assets';

/** Answers manifest requests from `replies` in order (the last one again after), counted. */
function serve(...replies: (() => Response | Promise<Response>)[]) {
  const fetch = vi.fn<(url: string) => Promise<Response>>(async () =>
    (replies.length > 1 ? replies.shift()! : replies[0])()
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

const MIRAGE = {
  map: 'de_mirage',
  schema: 1,
  files: { 'world.glb': { bytes: 10, sha256: 'a'.repeat(64) } },
  hd: { textureSize: 1024 },
};

describe('mapManifest', () => {
  beforeEach(forgetMapManifests);
  afterEach(() => vi.unstubAllGlobals());

  it('asks for the map’s manifest once, sharing the request in flight and keeping the manifest', async () => {
    const fetch = serve(() => Response.json(MIRAGE));
    const [a, b] = await Promise.all([
      mapManifest('de_mirage'),
      mapManifest('de_mirage'),
    ]);
    expect(await mapManifest('de_mirage')).toBe(a);
    expect(b).toBe(a);
    expect(a).toEqual(MIRAGE);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/maps/de_mirage/manifest.json',
    ]);
    // Another map is its own request.
    await mapManifest('de_dust 2');
    expect(fetch.mock.lastCall?.[0]).toBe('/maps/de_dust%202/manifest.json');
  });

  it('answers null when the server has no assets for the map (404), and asks again next time', async () => {
    const fetch = serve(
      () => new Response('', { status: 404 }),
      () => Response.json(MIRAGE)
    );
    expect(await mapManifest('de_mirage')).toBeNull();
    // The assets were built since.
    expect(await mapManifest('de_mirage')).toEqual(MIRAGE);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects on any other failure, and asks again next time', async () => {
    const fetch = serve(
      () => new Response('', { status: 503 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Response.json(MIRAGE)
    );
    await expect(mapManifest('de_mirage')).rejects.toThrow(
      'manifest: HTTP 503'
    );
    await expect(mapManifest('de_mirage')).rejects.toThrow('Failed to fetch');
    expect(await mapManifest('de_mirage')).toEqual(MIRAGE);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('reads an answer that is not JSON as a manifest that lists nothing', async () => {
    serve(() => new Response('<html>'));
    expect(await mapManifest('de_mirage')).toEqual({});
  });
});
