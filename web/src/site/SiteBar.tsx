// The bar on top of every skunk.club page: the mark and the name (home), the compact one input on
// a page that asks for it (`search`; below 800 px, a search icon that goes home, where the input
// is), and sign-in through Steam on the right (the Steam logo and a door on phones); signed in,
// the player's avatar and name there instead, linking to their tracking.
import type { ReactNode } from 'react';
import { steamLogoUrl } from '../api/site-assets';
import SiteLink from './SiteLink';
import { useMe } from './use-me';
import { useSiteAssets } from './use-site-assets';
import styles from './SiteBar.module.css';
import './tokens.css';

export default function SiteBar({ search }: { search?: ReactNode }) {
  const assets = useSiteAssets();
  const [me] = useMe();
  return (
    <header className={styles.bar}>
      <SiteLink href="/" className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        skunk.club
      </SiteLink>
      <div className={styles.find}>
        {search && <div className={styles.wide}>{search}</div>}
        {search && (
          // Below 800 px the bar has no room for the input: the icon goes home, where it is.
          <SiteLink href="/" className={styles.icon} aria-label="Search">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.6-3.6" />
            </svg>
          </SiteLink>
        )}
      </div>
      {me ? (
        <SiteLink
          href="/track"
          className={styles.me}
          aria-label={me.name ?? 'Signed in'}
        >
          <span className={styles.ava} aria-hidden="true">
            {me.avatar ? (
              <img src={me.avatar} alt="" referrerPolicy="no-referrer" />
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="8" r="4.5" />
                <path d="M3 21c0-4.4 4-7 9-7s9 2.6 9 7z" />
              </svg>
            )}
          </span>
          <span className={styles.who}>{me.name ?? 'Signed in'}</span>
        </SiteLink>
      ) : (
        <a
          className={styles.steam}
          href="/auth/steam"
          aria-label="Sign in through Steam"
        >
          {assets && (
            <img src={steamLogoUrl(assets)} alt="" width={22} height={22} />
          )}
          <span>Sign in through Steam</span>
          <svg
            className={styles.door}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5" />
            <path d="M3 12h11" />
            <path d="M10 8l4 4-4 4" />
          </svg>
        </a>
      )}
    </header>
  );
}
