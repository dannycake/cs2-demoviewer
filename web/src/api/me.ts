// The signed-in visitor (`/api/me`, which answers `{"signedIn": false}` for nobody), signing out,
// and sharing their match history (`/api/me/tracking`). Signing in is a page load: `/auth/steam`.

import { responseError } from '../errors';

export interface Me {
  steamid: string;
  name: string | null;
  avatar: string | null;
  tracking: 'off' | 'on' | 'stopped';
  /** Steam's name and avatar are being fetched: asked again shortly, they are in. */
  steamPending?: boolean;
}

/** While Steam fills in the signed-in player, `/api/me` is asked again this often, at most
 * this many times in a row. */
export const ME_AGAIN_MS = 2500;
const ME_TRIES = 3;
let followUps = 0;

/** Steam refused what was sent, or the server did: `field` names the input to fix, if one. */
export class TrackingError extends Error {
  readonly field: 'authCode' | 'token' | 'olderToken' | null;

  constructor(message: string, field: TrackingError['field']) {
    super(message);
    this.name = 'TrackingError';
    this.field = field;
  }
}

let cached: Promise<Me | null> | null = null;
/** A fresh look under way: looks asked for meanwhile share it. */
let looking: Promise<Me | null> | null = null;
const listeners = new Set<(me: Me | null) => void>();

function publish(me: Me | null): void {
  for (const l of listeners) l(me);
}

/**
 * Who is signed in, asked once a page (`fresh` asks again, and every listener hears the
 * answer); null when nobody is.
 */
export function getMe({ fresh = false } = {}): Promise<Me | null> {
  if (cached && !fresh) return cached;
  if (fresh && looking) return looking;
  const asked = fetchMe();
  cached = asked;
  looking = asked;
  void asked.then((me) => {
    if (looking === asked) looking = null;
    if (cached === asked) publish(me);
  });
  return asked;
}

/** Puts `me` in place of what `getMe` answers (after tracking changed, or signing out). */
export function setMe(me: Me | null): void {
  cached = Promise.resolve(me);
  looking = null;
  publish(me);
}

/** Hears every change of who is signed in, until the returned function is called. */
export function onMe(listener: (me: Me | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function fetchMe(): Promise<Me | null> {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return null;
    const me = (await res.json()) as
      (Partial<Me> & { signedIn?: boolean }) | null;
    if (!me || me.signedIn === false || typeof me.steamid !== 'string')
      return null;
    if (me.steamPending && followUps < ME_TRIES) {
      followUps++;
      setTimeout(() => void getMe({ fresh: true }), ME_AGAIN_MS);
    } else if (!me.steamPending) followUps = 0;
    return me as Me;
  } catch {
    return null;
  }
}

export async function startTracking(body: {
  authCode: string;
  token: string;
  olderToken?: string;
}): Promise<void> {
  const res = await fetch('/api/me/tracking', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) return;
  if (res.status === 400) {
    const answer = (await res
      .clone()
      .json()
      .catch(() => null)) as { field?: string; error?: string } | null;
    const field = answer?.field;
    if (field === 'authCode' || field === 'token' || field === 'olderToken')
      throw new TrackingError(answer?.error ?? 'Steam refused this', field);
  }
  throw new TrackingError(await responseError(res), null);
}

export async function stopTracking(): Promise<void> {
  const res = await fetch('/api/me/tracking', { method: 'DELETE' });
  if (!res.ok) throw new TrackingError(await responseError(res), null);
}

export async function signOut(): Promise<void> {
  const res = await fetch('/auth/signout', { method: 'POST' });
  if (!res.ok) throw new Error(await responseError(res));
  setMe(null);
}
