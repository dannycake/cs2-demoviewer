// Main-thread side of the pack worker.

import { PackLoadError, type PackProgress } from './fetch';
import type { PackReply, PackRequest } from './worker';
import type { Pack } from './types';

export { PackLoadError };

/**
 * Loads and parses a demo's pack in a Worker. Rejects with a `PackLoadError` carrying the
 * server's `{error}` text (and HTTP status) on a non-2xx, or the reader's message on a
 * malformed pack. Aborting `signal` stops the worker and rejects with an AbortError.
 */
export function loadPack(
  demoId: string,
  onProgress: PackProgress,
  signal?: AbortSignal
): Promise<Pack> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort);

    worker.onmessage = (e: MessageEvent<PackReply>) => {
      const msg = e.data;
      if (msg.type === 'progress') {
        onProgress(msg.loaded, msg.total);
      } else if (msg.type === 'done') {
        finish();
        resolve(msg.pack);
      } else {
        finish();
        reject(new PackLoadError(msg.message, msg.status));
      }
    };
    worker.onerror = (e) => {
      finish();
      reject(
        new PackLoadError(e.message || 'the pack worker failed to start', null)
      );
    };
    worker.postMessage({ demoId } satisfies PackRequest);
  });
}
