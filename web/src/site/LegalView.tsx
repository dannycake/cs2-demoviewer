// The contact page (`/legal`, "Contact" in every page's foot): one address for legal requests, one
// line on what the site holds, one on Valve and FACEIT.

import { useEffect } from 'react';
import { pageTitle } from '../router';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';
import styles from './LegalView.module.css';

const ADDRESS = 'contact@skunk.legal';

export default function LegalView() {
  useEffect(() => {
    document.title = pageTitle('Contact');
  }, []);
  return (
    <div className="site">
      <SiteBar />
      <main className={styles.page}>
        <div className={styles.legal}>
          <h1 className={styles.title}>Contact</h1>
          <div className={styles.cell} data-testid="legal-cell">
            <b>Legal requests</b> Takedowns, privacy and data requests, and
            anything else that needs a lawyer&apos;s attention:{' '}
            <a className={styles.mail} href={`mailto:${ADDRESS}`}>
              {ADDRESS}
            </a>{' '}
            Say which page or match you mean and we&apos;ll reply from this
            address.
          </div>
          <div className={styles.cell} data-testid="legal-cell">
            <b>Your data</b> Matches here come from demos uploaded or linked on
            this site and from public pro tournament demos. A tracked
            player&apos;s authentication code and match token are kept only to
            fetch that player&apos;s matches from Steam, and are deleted when
            tracking is stopped. Stored demos are the files Valve serves to
            every player in the match. A profile can be hidden on request: write
            to the address above. Profiles, matches and tournament pages are
            public and may appear in search engines. Cloudflare counts visits
            without cookies. The only cookie is the sign-in session.
          </div>
          <div className={styles.cell} data-testid="legal-cell">
            skunk.club is not affiliated with Valve Corporation or FACEIT.
            Counter-Strike and Steam are trademarks of Valve Corporation; FACEIT
            and its mark are trademarks of FACEIT.
          </div>
        </div>
      </main>
      <SiteFoot />
    </div>
  );
}
