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
  | { type: 'done'; pack: Pack }
  | { type: 'error'; message: string; status: number | null };

function reply(msg: PackReply, transfer: Transferable[] = []): void {
  self.postMessage(msg, { transfer });
}

self.onmessage = async (e: MessageEvent<PackRequest>) => {
  const url = `/api/demos/${encodeURIComponent(e.data.demoId)}/pack`;
  try {
    const pack = await fetchPack(url, (loaded, total) => {
      reply({ type: 'progress', loaded, total });
    });
    reply({ type: 'done', pack }, packTransferables(pack));
  } catch (err) {
    reply({
      type: 'error',
      message: messageOf(err),
      status: err instanceof PackLoadError ? err.status : null,
    });
  }
};
