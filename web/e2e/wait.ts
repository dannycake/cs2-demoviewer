// Waits on what the page is doing, for the specs: a fixed sleep is too short on a loaded machine
// and wasted time on an idle one. What a spec waits for after a seek, a camera change or a load
// is that the 3D view has everything it asked for and has drawn it:
// - `trackLoads` counts the page's loads in flight, from before its first script runs: fetches
//   and the reading of their bodies, image bitmaps decoding and <img> loads (the sky, the effect
//   atlases and the detail texture come through TextureLoader's <img>). Everything the scene
//   fetches or decodes (the world, the players, the arms and their clips, the weapons, the
//   atlases, a GLB's textures) is one of them; the sound's banks too, once a gesture starts it.
// - `settled` waits, while paused, until no load is in flight, the scene has nothing left to
//   draw (its frame counter, `stats.frames`, stands still over a few animation frames) and no
//   CSS animation of a finite length is running (a killfeed row sliding in over the canvas is in
//   a shot of it). A load that lands invalidates the scene, which draws once more, so the wait
//   goes on until all are quiet. Playing (or flying), the scene draws every frame and never
//   settles.
// - `animationFrames` waits for the page's next animation frames: a store change is drawn on the
//   next one (`startLoop`).

import { expect, type Page } from '@playwright/test';

interface Loads {
  /** Loads in flight, by what they are (a URL, or the kind of decode). */
  pending: Map<number, string>;
}

declare global {
  interface Window {
    __e2eLoads?: Loads;
  }
}

/** Counts the page's loads in flight (`window.__e2eLoads`), from its next navigation on. */
export async function trackLoads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // Once per document, however many specs' opens added the script.
    if (window.__e2eLoads) return;
    const loads: Loads = { pending: new Map() };
    window.__e2eLoads = loads;
    let next = 0;
    const track = <T>(what: string, p: Promise<T>): Promise<T> => {
      const id = next++;
      loads.pending.set(id, what);
      const done = () => loads.pending.delete(id);
      p.then(done, done);
      return p;
    };
    const fetch0 = window.fetch;
    window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
      const [input] = args;
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return track(url, fetch0.apply(this, args));
    } as typeof fetch;
    for (const read of ['arrayBuffer', 'blob', 'json', 'text'] as const) {
      const read0 = Response.prototype[read] as () => Promise<unknown>;
      Response.prototype[read] = function (this: Response) {
        return track(`${read} of ${this.url}`, read0.call(this));
      } as never;
    }
    const bitmap0 = window.createImageBitmap;
    window.createImageBitmap = function (
      this: unknown,
      ...args: Parameters<typeof createImageBitmap>
    ) {
      return track(
        'createImageBitmap',
        (bitmap0 as (...a: unknown[]) => Promise<ImageBitmap>).apply(this, args)
      );
    } as typeof createImageBitmap;
    const src = Object.getOwnPropertyDescriptor(
      HTMLImageElement.prototype,
      'src'
    )!;
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...src,
      set(this: HTMLImageElement, v: string) {
        track(
          `<img> ${v.slice(0, 120)}`,
          new Promise((done) => {
            this.addEventListener('load', done, { once: true });
            this.addEventListener('error', done, { once: true });
          })
        );
        src.set!.call(this, v);
      },
    });
  });
}

/** The 3D view's frame counter (`Scene.stats.frames`). */
export const frames = (page: Page): Promise<number> =>
  page.evaluate(() => window.__demoviewer!.stats.frames);

/** Waits for the page's next `n` animation frames. */
export function animationFrames(page: Page, n = 2): Promise<void> {
  return page.evaluate(async (n) => {
    for (let i = 0; i < n; i++)
      await new Promise((r) => requestAnimationFrame(r));
  }, n);
}

/**
 * Waits, paused, until no load is in flight and the 3D view has drawn all it was asked to (see
 * the head of this file); with `since` (a `frames` reading taken before a change), also until
 * it has drawn since. Fails naming what was still loading or that it kept drawing.
 */
export async function settled(
  page: Page,
  { since, timeout = 60_000 }: { since?: number; timeout?: number } = {}
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (since) => {
          const loads = window.__e2eLoads;
          if (!loads) return 'loads are not tracked (trackLoads before goto)';
          const busy = () => {
            if (loads.pending.size > 0)
              return `loading ${[...loads.pending.values()].slice(0, 3).join(', ')}`;
            const moving = document
              .getAnimations()
              .filter(
                (a) =>
                  a.playState === 'running' &&
                  Number.isFinite(
                    Number(a.effect?.getComputedTiming().endTime ?? Infinity)
                  )
              );
            return moving.length > 0
              ? `${moving.length} CSS animation(s) running`
              : null;
          };
          const d = window.__demoviewer;
          if (!d) return 'no 3D view';
          if (since !== null && d.stats.frames <= since)
            return 'not drawn since';
          const f0 = d.stats.frames;
          const before = busy();
          if (before) return before;
          for (let i = 0; i < 3; i++)
            await new Promise((r) => requestAnimationFrame(r));
          return busy() ?? (d.stats.frames === f0 ? 'settled' : 'drawing');
        }, since ?? null),
      { timeout, message: 'the 3D view settles' }
    )
    .toBe('settled');
}
