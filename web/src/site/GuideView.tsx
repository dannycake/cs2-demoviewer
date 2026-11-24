// The guides (`/guides`) and a how-to page (`/guides/<slug>`). Each guide's body is one HTML
// fragment shared with the server (server/crates/server/guides/), which embeds it for crawlers;
// the title is the page's `<h1>`. The server's copy goes as soon as this one shows.

import { useEffect } from 'react';
import { pageTitle } from '../router';
import { GUIDES } from './guides';
import { removePre } from './pre';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';
import SiteLink from './SiteLink';
import styles from './GuideView.module.css';

/** The index's heading, as guides.rs titles it. */
const INDEX_TITLE = 'CS2 demo guides';

export default function GuideView({ slug }: { slug?: string }) {
  const guide = GUIDES.find((g) => g.slug === slug);
  const title = guide
    ? guide.title
    : slug === undefined
      ? INDEX_TITLE
      : 'Guide not found';
  useEffect(() => {
    document.title = pageTitle(title);
    removePre();
  }, [title]);
  return (
    <div className="site">
      <SiteBar />
      <main className={styles.page}>
        <article className={styles.guide}>
          <h1 className={styles.title}>{title}</h1>
          {guide && (
            // Static, first-party HTML (the fragment the server also embeds), never user input.
            <div dangerouslySetInnerHTML={{ __html: guide.body }} />
          )}
          {slug === undefined && (
            <ul>
              {GUIDES.map((g) => (
                <li key={g.slug}>
                  <SiteLink href={`/guides/${g.slug}`}>{g.title}</SiteLink>
                </li>
              ))}
            </ul>
          )}
          {slug !== undefined && !guide && (
            <p>
              There is no such guide.{' '}
              <SiteLink href="/guides">See all the guides</SiteLink>.
            </p>
          )}
        </article>
      </main>
      <SiteFoot />
    </div>
  );
}
