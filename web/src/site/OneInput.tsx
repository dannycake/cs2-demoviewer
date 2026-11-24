// The one input: any player (a Steam profile link, a SteamID in any form, a friend code, a custom
// URL name, a player's name) or match (a share code, CS2's share link, a Valve replay link, a
// FACEIT match room link, a replay link of this site), tagged as it is typed (`detectInput`). A
// player opens their profile (the server resolves the text: `/api/lookup`), or a list of players
// of that name; a match is fetched as the upload page does (a FACEIT room by its match id, which
// the server fetches at most once) and opens its replay. The server's error shows under it.

import { useEffect, useState, type FormEvent } from 'react';
import { lookup } from '../api/players';
import { ingestFaceitMatch, ingestShareCode, ingestUrl } from '../api/upload';
import { navigate } from '../router';
import { extractShareCode } from '../sharecode';
import {
  demoLink,
  detectInput,
  faceitMatch,
  INPUT_WORDS,
  inputIsCode,
} from './detect';
import PlayIcon from './PlayIcon';
import SiteLink from './SiteLink';
import styles from './OneInput.module.css';

const PLACEHOLDER = 'Player name, Steam ID or match link';
/** Where the input is narrow: a phone, or the bar beside the mark and sign-in below 900 px. */
const PLACEHOLDER_NARROW = 'Player or match link';
const NARROW = {
  hero: '(max-width: 700px)',
  bar: '(max-width: 900px)',
} as const;

type Hit = { steamid: string; name: string; matches: number };

/** Whether the page is as narrow as `query`. */
function useNarrow(query: string): boolean {
  const [narrow, setNarrow] = useState(
    () =>
      typeof window.matchMedia === 'function' &&
      window.matchMedia(query).matches
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, [query]);
  return narrow;
}

/** `?q=` of the page, trimmed and cut to 200 characters: where a search engine's sitelinks box
 * lands. Nothing is submitted for the visitor. */
function initialText(): string {
  const q = new URLSearchParams(window.location.search).get('q');
  return q ? q.trim().slice(0, 200) : '';
}

export default function OneInput({ variant }: { variant: 'hero' | 'bar' }) {
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const narrow = useNarrow(NARROW[variant]);
  const kind = detectInput(text);
  const [tag, button] = INPUT_WORDS[kind];
  const has = kind !== 'empty';
  // A name is set as words; a code, an ID or a link in the numbers' face.
  const code = inputIsCode(text);
  const idle = busy || kind === 'empty' || kind === 'none';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (idle) return;
    setBusy(true);
    setError(null);
    setHits(null);
    try {
      if (kind === 'profile') {
        const found = await lookup(text.trim());
        if (found.kind === 'profile') navigate(`/profiles/${found.steamid}`);
        else setHits(found.players);
      } else {
        const link = demoLink(text);
        const room = faceitMatch(text);
        const code = extractShareCode(text);
        if (link) navigate(link);
        else {
          const { demoId } = room
            ? await ingestFaceitMatch(room)
            : code
              ? await ingestShareCode(code)
              : await ingestUrl(text.trim());
          navigate(`/d/${demoId}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const classes = [
    styles.ask,
    styles[variant],
    has ? styles.has : '',
    code ? styles.code : '',
    kind === 'none' ? styles.no : '',
  ].join(' ');
  return (
    <div className={styles.wrap}>
      <form
        className={classes}
        onSubmit={submit}
        role="search"
        data-code={code || undefined}
      >
        <label className={styles.in}>
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
          <input
            type="text"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setError(null);
              setHits(null);
            }}
            placeholder={narrow ? PLACEHOLDER_NARROW : PLACEHOLDER}
            aria-label="A player or a match"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <div className={`${styles.tag} ${styles[kind]}`} aria-live="polite">
          <span>{tag}</span>
        </div>
        <button type="submit" className={styles.go} disabled={idle}>
          {kind === 'match' && !busy && <PlayIcon />}
          {busy ? 'Opening…' : button}
        </button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {hits && (
        <ul className={styles.hits} aria-label="Players of that name">
          {hits.map((h) => (
            <li key={h.steamid}>
              <SiteLink href={`/profiles/${h.steamid}`}>
                <b>{h.name}</b>{' '}
                <span>
                  <span className="n">{h.matches}</span>{' '}
                  {h.matches === 1 ? 'match' : 'matches'}
                </span>
              </SiteLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
