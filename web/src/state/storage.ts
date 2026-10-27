// Where the viewer remembers its preferences per browser (the settings, the quality preset, the
// director, the fly camera's speed): `localStorage`, or nothing where the page cannot have it.

/** A store of preferences; `null` keeps nothing (tests, private windows, blocked storage). */
export type PrefsStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

/**
 * The page's `localStorage`, or null outside a page (node's own `localStorage` is not the
 * page's) or where reading it throws.
 */
export function browserStorage(): PrefsStorage {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}
