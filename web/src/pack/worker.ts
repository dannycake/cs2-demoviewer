// Dedicated worker: fetches /api/demos/<id>/pack, parses it off the main thread and
// transfers the typed arrays' buffers back. Started by `loadPack` in client.ts.

import { messageOf } from '../errors';
import { fetchPack, PackLoadError, packTransferables } from './fetch';
import type { Pack } from './types';

export interface PackRequest {
  demoId: string;
}

export type PackReply =
  | { type: 'progress'; loaded: number; total: number | null }
  /** `transferred`: the bytes the pack came over the wire in, for the page's traffic count. */
  | { type: 'done'; pack: Pack; transferred: number }
  | { type: 'error'; message: string; status: number | null };

function reply(msg: PackReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = async (e: MessageEvent<PackRequest>) => {
  const url = `/api/demos/${encodeURIComponent(e.data.demoId)}/pack`;
  try {
    let read = 0;
    const pack = await fetchPack(url, (loaded, total) => {
      read = loaded;
      reply({ type: 'progress', loaded, total });
    });
    // The worker's own timeline has the download (0 when it came from the cache); the page's
    // does not see it. Without an entry, the bytes read: the body as decoded, so an upper bound.
    const timed = performance.getEntriesByName(
      new URL(url, self.location.href).href
    );
    const last = timed[timed.length - 1] as
      PerformanceResourceTiming | undefined;
    const transferred = last ? last.transferSize : read;
    reply({ type: 'done', pack, transferred }, packTransferables(pack));
  } catch (err) {
    reply({
      type: 'error',
      message: messageOf(err),
      status: err instanceof PackLoadError ? err.status : null,
    });
  }
};
