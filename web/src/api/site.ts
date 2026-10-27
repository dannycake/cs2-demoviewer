// What the server lets the web app offer: `GET /api/site`. The site is link only, so the one
// switch is whether a share code can be pasted.

import type { RequestOptions } from './demos';

export interface Site {
  sharecodes: boolean;
}

/** Everything off: what an old server, a failed request or a strange answer means. */
const OFF: Site = { sharecodes: false };

/**
 * The server's switches. Any failure (no answer, a non-2xx, a body that is not the switches,
 * an abort) turns everything off rather than throwing: a feature the server may not have is
 * hidden, never broken.
 */
export async function getSite({
  fetchFn = fetch,
  signal,
}: RequestOptions = {}): Promise<Site> {
  try {
    const res = await fetchFn('/api/site', { signal });
    if (!res.ok) return { ...OFF };
    const body: unknown = JSON.parse(await res.text());
    if (!body || typeof body !== 'object') return { ...OFF };
    return {
      sharecodes: 'sharecodes' in body && body.sharecodes === true,
    };
  } catch {
    return { ...OFF };
  }
}
