// The site's frame over the server's pre-rendered page (`pre.ts`), while the view's own content is
// not in: the bar, and under it a loading bar while it loads, or one slim line saying the live page
// did not load, with a way to ask again. No main part and no foot: the pre-rendered body, after
// the app's root, is the page under it.

import type { ReactNode } from 'react';
import LoadingBar from './LoadingBar';
import SiteBar from './SiteBar';
import styles from './PreFrame.module.css';

export default function PreFrame({
  search,
  failed,
}: {
  /** The bar's input, on a page whose bar has one. */
  search?: ReactNode;
  /** What did not load and how to ask again; while loading, none. */
  failed?: { text: string; retry: () => void };
}) {
  return (
    <div className="site site-frame">
      <SiteBar search={search} />
      {failed ? (
        <div className={styles.wrap}>
          <div className={styles.line}>
            <p role="alert">{failed.text}</p>
            <button type="button" onClick={failed.retry}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <LoadingBar />
      )}
    </div>
  );
}
