// The foot of every skunk.club page: the mark, that the site is not Valve's, and the events
// list, the guides and the contact
// page (`/legal`: the address for legal requests, what is stored, and Valve's marks).

import SiteLink from './SiteLink';
import styles from './SiteFoot.module.css';
import './tokens.css';

export default function SiteFoot() {
  return (
    <footer className={styles.foot}>
      <div>
        <span className={styles.mark} aria-hidden="true" />
      </div>
      <div className={styles.note}>Not affiliated with Valve</div>
      <div className={styles.link}>
        <SiteLink href="/events">Events</SiteLink>
      </div>
      <div className={styles.link}>
        <SiteLink href="/guides">Guides</SiteLink>
      </div>
      <div className={styles.link}>
        <SiteLink href="/legal">Contact</SiteLink>
      </div>
    </footer>
  );
}
