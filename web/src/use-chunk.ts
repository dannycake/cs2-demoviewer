// A view the page loads later as a chunk of its own (the viewer: `App`; the 3D view: `DemoView`),
// held in state rather than through `React.lazy`: React shows a lazy component that suspended no
// sooner than 300 ms after its Suspense fallback was shown, however soon its chunk came, where
// this shows it in the render after the chunk is in. The chunk is asked for once a page, through
// `importOrReload`, and its promise kept, a failure too: browsers keep a module that failed to
// fetch, so only the page loaded again tries it again.

import { useEffect, useState } from 'react';
import { importOrReload } from './chunk';

/** `load`, asked for at the first call and the same promise at every call after. */
export function chunkOnce<T>(load: () => Promise<T>): () => Promise<T> {
  let module: Promise<T> | null = null;
  return () => (module ??= importOrReload(load));
}

/**
 * The module `get` (a `chunkOnce`) answers, once it is in, and null until then; nothing is asked
 * for while `want` is false. The request goes out from the render that first wants it, not
 * after its commit (a task sooner), and the module comes in a commit of its own, after this
 * one's effects and its parents'. A chunk that will not load is thrown, to the nearest error
 * boundary.
 */
export function useChunk<T>(get: () => Promise<T>, want = true): T | null {
  const module = want ? get() : null;
  const [loaded, setLoaded] = useState<{ module: T } | null>(null);
  const [failed, setFailed] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (!module) return;
    let live = true;
    module.then(
      (m) => live && setLoaded({ module: m }),
      (error: unknown) => live && setFailed({ error })
    );
    return () => {
      live = false;
    };
  }, [module]);
  if (failed) throw failed.error;
  return loaded?.module ?? null;
}
