import { describe, expect, it, vi } from 'vitest';
import {
  formatBytes,
  Traffic,
  transferred,
  watchPageTraffic,
} from '../src/net/traffic';

describe('transferred', () => {
  it('sums what came over the wire and skips entries without a size', () => {
    expect(
      transferred([
        { transferSize: 300 },
        { transferSize: 0 },
        {},
        { transferSize: NaN },
        { transferSize: 1200 },
      ])
    ).toBe(1500);
  });
});

describe('Traffic', () => {
  it('adds bytes and tells its listeners, until they leave', () => {
    const t = new Traffic();
    const heard: number[] = [];
    const leave = t.subscribe(() => heard.push(t.total));
    t.add(100);
    t.add(0);
    t.add(-5);
    t.add(NaN);
    t.add(50);
    expect(t.total).toBe(150);
    expect(heard).toEqual([100, 150]);
    leave();
    t.add(1);
    expect(heard).toEqual([100, 150]);
  });
});

describe('watchPageTraffic', () => {
  it("counts the page's navigation and every resource, earlier ones included", () => {
    const observers: {
      cb: (list: { getEntries(): { transferSize: number }[] }) => void;
      types: string[];
      disconnected: boolean;
    }[] = [];
    class FakeObserver {
      private readonly o: (typeof observers)[number];
      constructor(cb: (typeof observers)[number]['cb']) {
        this.o = { cb, types: [], disconnected: false };
        observers.push(this.o);
      }
      observe(init: { type: string; buffered: boolean }) {
        expect(init.buffered).toBe(true);
        this.o.types.push(init.type);
      }
      disconnect() {
        this.o.disconnected = true;
      }
    }
    vi.stubGlobal('PerformanceObserver', FakeObserver);
    const t = new Traffic();
    const stop = watchPageTraffic(t);
    expect(observers.flatMap((o) => o.types).sort()).toEqual([
      'navigation',
      'resource',
    ]);
    for (const o of observers)
      o.cb({ getEntries: () => [{ transferSize: 1000 }] });
    expect(t.total).toBe(2000);
    stop();
    expect(observers.every((o) => o.disconnected)).toBe(true);
    vi.unstubAllGlobals();
  });

  it('does nothing where the browser cannot observe resources', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const t = new Traffic();
    expect(() => watchPageTraffic(t)()).not.toThrow();
    expect(t.total).toBe(0);
    vi.unstubAllGlobals();
  });
});

describe('formatBytes', () => {
  it('reads like a download size', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(84_000)).toBe('84 KB');
    expect(formatBytes(3_400_000)).toBe('3.4 MB');
    expect(formatBytes(12_600_000)).toBe('12.6 MB');
    expect(formatBytes(1_210_000_000)).toBe('1.21 GB');
  });
});
