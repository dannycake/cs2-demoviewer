// A chunk the page loads later (the viewer: `App`; the 3D view: `DemoView`) is named by the build
// the page came with. A deploy since then removes it, and the server answers its old URL with a
// 404 (an older server answered with the app's page, which is not a script), so the import
// fails: on the upload page left open across a deploy, opening a demo would end on the error
// screen, and on a phone left on the radar, the 3D view would fail as it first shows. The page
// loaded again names the new build's chunk, so on any such failure the page reloads, at most
// once a minute (noted in sessionStorage): a chunk that is really missing still ends on the
// error screen (the 3D view's on its panel's note), not in a reload loop. The minute counts
// either way: a reload noted in the future (the clock set back since) does not hold off the next
// one until the clock catches up with it.

/** The parts of `sessionStorage` used. */
export interface ReloadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const RELOAD_KEY = 'demoviewer.chunkReload';
/** The least time between two reloads for a chunk. */
export const RELOAD_MS = 60_000;

function sessionStore(): ReloadStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/**
 * `load()`, or, when it fails and no reload for a chunk came in the last `RELOAD_MS`, a reload
 * of the page (and a promise that never settles, so nothing renders the failure meanwhile).
 * Without a storage to note the reload in, the failure stands.
 */
export function importOrReload<T>(
  load: () => Promise<T>,
  {
    storage = sessionStore(),
    reload = () => window.location.reload(),
    now = Date.now,
  }: {
    storage?: ReloadStorage | null;
    reload?: () => void;
    now?: () => number;
  } = {}
): Promise<T> {
  return load().catch((e: unknown) => {
    try {
      if (!storage) throw e;
      const last = Number(storage.getItem(RELOAD_KEY));
      if (Number.isFinite(last) && Math.abs(now() - last) < RELOAD_MS) throw e;
      storage.setItem(RELOAD_KEY, String(now()));
    } catch {
      // A reload too soon, or a storage that refuses: the import's failure stands.
      throw e;
    }
    reload();
    return new Promise<T>(() => {});
  });
}
