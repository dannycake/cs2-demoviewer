// Share a moment: a link to the demo at the store's round and tick, in its camera, with the
// player on screen (`p`, Free's selected player too) and the free camera's pose for Free
// (`at`), and the ways to hand it on. On a phone (a coarse pointer) the share sheet takes it;
// elsewhere the clipboard does; and where neither is there (the clipboard API needs a secure
// context, so a plain-http LAN address has none) or either fails, the link is shown to copy by
// hand. A share sheet the user cancels is a dismissal, not a failure.

import { parseRoute, routeToPath, type FreePose } from '../router';
import { urlCamera, urlPlayer } from './url';
import type { PlaybackState } from './store';

/**
 * The link to the moment in `s`, on the demo page `href` points at (its other parameters and
 * its hash left out): `r` (1-based), `t` (rounded), `cam`, then `p` without the director
 * (`urlPlayer`), and `at` for Free when `pose` (the free camera's, from `Scene.cameraDebug`,
 * with its field of view) is given. Without a pack, the page alone.
 */
export function shareUrl(
  s: Pick<
    PlaybackState,
    | 'pack'
    | 'round'
    | 'tick'
    | 'camera'
    | 'director'
    | 'follow'
    | 'followPinned'
  >,
  href: string,
  pose: FreePose | null
): string {
  const url = new URL(href);
  const route = parseRoute(url);
  if (route.view !== 'demo') return url.origin + url.pathname;
  const page = { view: 'demo' as const, demoId: route.demoId };
  if (!s.pack) return new URL(routeToPath(page), url).toString();
  const cam = urlCamera(s);
  const path = routeToPath({
    ...page,
    round: s.round + 1,
    tick: Math.round(s.tick),
    cam,
    p: urlPlayer(s),
    at: cam === 'free' && pose ? pose : undefined,
  });
  // `new URL` would escape the pose's commas again: join the origin and the path as they are.
  return url.origin + path;
}

/** What `shareLink` did with the link. */
export type ShareOutcome = 'shared' | 'copied' | 'manual';

/**
 * Hands `url` on: to the share sheet (`nav.share`) on a coarse pointer (`'shared'`, also when
 * the user cancels it), else to the clipboard (`'copied'`); `'manual'` when neither is there
 * or the one tried fails, for the caller to show the link in a field.
 */
export async function shareLink(
  url: string,
  nav:
    | {
        clipboard?: Pick<Clipboard, 'writeText'>;
        share?: (d: ShareData) => Promise<void>;
      }
    | undefined,
  coarse: boolean
): Promise<ShareOutcome> {
  /** The share sheet was tried, so a rejection came from it. */
  let sheet = false;
  try {
    if (coarse && typeof nav?.share === 'function') {
      sheet = true;
      await nav.share({ url });
      return 'shared';
    }
    if (typeof nav?.clipboard?.writeText === 'function') {
      await nav.clipboard.writeText(url);
      return 'copied';
    }
  } catch (e) {
    // The user cancelled the share sheet: a dismissal, not a failure, so no field.
    if (sheet && (e as { name?: unknown } | null)?.name === 'AbortError')
      return 'shared';
    // Refused, or not allowed here: the field still gives the link.
  }
  return 'manual';
}
