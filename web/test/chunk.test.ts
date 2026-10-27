import { describe, expect, it, vi } from 'vitest';
import { importOrReload, RELOAD_KEY, RELOAD_MS } from '../src/chunk';

function memory(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

/** Whether `p` settled within a few turns of the event loop. */
async function settled(p: Promise<unknown>): Promise<boolean> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true)
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
}

describe('importOrReload', () => {
  it('hands on a chunk that loads', async () => {
    const reload = vi.fn();
    const mod = { default: 'view' };
    await expect(
      importOrReload(async () => mod, { storage: memory(), reload })
    ).resolves.toBe(mod);
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the page when the chunk is gone (a deploy since), and renders nothing meanwhile', async () => {
    const storage = memory();
    const reload = vi.fn();
    const p = importOrReload(
      () =>
        Promise.reject(
          new TypeError('Failed to fetch dynamically imported module')
        ),
      { storage, reload, now: () => 5_000_000 }
    );
    expect(await settled(p)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.m.get(RELOAD_KEY)).toBe('5000000');
  });

  it('lets the failure stand within a minute of the last reload, so a missing chunk never loops', async () => {
    const reload = vi.fn();
    const failure = new TypeError(
      'Failed to fetch dynamically imported module'
    );
    const storage = memory({ [RELOAD_KEY]: '5000000' });
    await expect(
      importOrReload(() => Promise.reject(failure), {
        storage,
        reload,
        now: () => 5_000_000 + RELOAD_MS - 1,
      })
    ).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
    // A minute on, it may reload again (a second deploy).
    const p = importOrReload(() => Promise.reject(failure), {
      storage,
      reload,
      now: () => 5_000_000 + RELOAD_MS,
    });
    expect(await settled(p)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('reloads when the last reload is noted more than a minute in the future (the clock was set back)', async () => {
    const failure = new TypeError(
      'Failed to fetch dynamically imported module'
    );
    const reload = vi.fn();
    const storage = memory({
      [RELOAD_KEY]: String(5_000_000 + 10 * RELOAD_MS),
    });
    const p = importOrReload(() => Promise.reject(failure), {
      storage,
      reload,
      now: () => 5_000_000,
    });
    expect(await settled(p)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.m.get(RELOAD_KEY)).toBe('5000000');
    // Within a minute of it, either way, the failure stands.
    storage.m.set(RELOAD_KEY, String(5_000_000 + RELOAD_MS - 1));
    await expect(
      importOrReload(() => Promise.reject(failure), {
        storage,
        reload,
        now: () => 5_000_000,
      })
    ).rejects.toBe(failure);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('lets the failure stand without a storage to note the reload in', async () => {
    const reload = vi.fn();
    const failure = new Error('gone');
    await expect(
      importOrReload(() => Promise.reject(failure), { storage: null, reload })
    ).rejects.toBe(failure);
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    await expect(
      importOrReload(() => Promise.reject(failure), {
        storage: refusing,
        reload,
      })
    ).rejects.toBe(failure);
    expect(reload).not.toHaveBeenCalled();
  });
});
