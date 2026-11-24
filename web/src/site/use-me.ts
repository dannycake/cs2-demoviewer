// The signed-in visitor (api/me) in a component: undefined while asked, null when nobody is. Every
// component hears every change (a sign-out, tracking started or stopped), and the tab looks again
// when it comes back (focus, shown again, restored from the back-forward cache): another tab may
// have signed out, or in as someone else.

import { useEffect, useState } from 'react';
import { getMe, onMe, setMe, type Me } from '../api/me';

function lookAgain(): void {
  if (document.visibilityState !== 'hidden') void getMe({ fresh: true });
}

function restored(e: PageTransitionEvent): void {
  if (e.persisted) lookAgain();
}

export function useMe(): [Me | null | undefined, (me: Me | null) => void] {
  const [me, setLocal] = useState<Me | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const off = onMe((m) => {
      if (live) setLocal(m);
    });
    void getMe().then((m) => {
      if (live) setLocal(m);
    });
    window.addEventListener('focus', lookAgain);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange', lookAgain);
    return () => {
      live = false;
      off();
      window.removeEventListener('focus', lookAgain);
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange', lookAgain);
    };
  }, []);
  return [me, setMe];
}
