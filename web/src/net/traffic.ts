// What this page has downloaded since it opened, in bytes over the wire (compressed, headers
// included): the page and its scripts, the map, the models and the replay. The browser's
// resource timing counts what the page fetched itself; the pack worker reports its own
// download, which the page's timeline does not see.

export interface TransferEntry {
  transferSize?: number;
}

/** The bytes the entries came over the wire in; an entry without a size counts nothing. */
export function transferred(entries: Iterable<TransferEntry>): number {
  let sum = 0;
  for (const e of entries) {
    const n = e.transferSize;
    if (typeof n === 'number' && n > 0) sum += n;
  }
  return sum;
}

/** A running byte count with listeners, for `useSyncExternalStore`. */
export class Traffic {
  private bytes = 0;
  private readonly listeners = new Set<() => void>();

  get total(): number {
    return this.bytes;
  }

  add(bytes: number): void {
    if (!(bytes > 0)) return;
    this.bytes += bytes;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

/** The page's count, shown in the transport bar. */
export const traffic = new Traffic();

/**
 * Counts the page's own document and every resource it fetches into `t`, those fetched
 * before the call included. Returns a function that stops counting; a no-op where the
 * browser has no `PerformanceObserver`.
 */
export function watchPageTraffic(t: Traffic = traffic): () => void {
  if (typeof PerformanceObserver === 'undefined') return () => {};
  const observers = (['navigation', 'resource'] as const).map((type) => {
    const o = new PerformanceObserver((list) =>
      t.add(transferred(list.getEntries() as TransferEntry[]))
    );
    o.observe({ type, buffered: true });
    return o;
  });
  return () => {
    for (const o of observers) o.disconnect();
  };
}

/** `n` bytes as a download size: B, KB, MB, GB (powers of 1000, as browsers show them). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1e6) return `${Math.round(n / 1e3)} KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)} MB`;
  return `${(n / 1e9).toFixed(2)} GB`;
}
