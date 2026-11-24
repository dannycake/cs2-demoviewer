// Under the home page's upload: the latest tournaments, as plain links. Nothing shows while they
// load, when they fail or when there are none. Once they are in (none at all is an answer too),
// the server's pre-rendered copy of them goes (`pre.ts`); after a failure it stays.

import { useEffect, useState } from 'react';
import { getHomeLinks, type HomeLinks as Links } from '../api/events';
import { removePre } from './pre';
import SiteLink from './SiteLink';
import styles from './HomeLinks.module.css';

export default function HomeLinks() {
  const [links, setLinks] = useState<Links | null>(null);
  useEffect(() => {
    let live = true;
    getHomeLinks().then(
      (l) => live && setLinks(l),
      () => {}
    );
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (links) removePre();
  }, [links]);
  if (!links) return null;
  const events = (links.events ?? []).slice(0, 5);
  if (!events.length) return null;
  return (
    <nav className={styles.links} aria-label="Tournaments">
      <p>
        <span className={styles.label}>Tournaments</span>
        {events.map((e) => (
          <SiteLink key={e.slug} href={`/events/${e.slug}`}>
            {e.name}
          </SiteLink>
        ))}
        <SiteLink href="/events">All</SiteLink>
      </p>
    </nav>
  );
}
