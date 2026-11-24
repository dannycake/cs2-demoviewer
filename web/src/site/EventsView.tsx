// The tournaments pages: `/events` lists them, `/events/<slug>` is one with its matches (date,
// map, score with the winner first, the top fragger and the replay). Over the server's
// pre-rendered copy (`pre.ts`) it draws only the site's frame while it loads, and one slim line if
// it fails (`PreFrame`): the copy is the page under them. The copy goes once the list or the event
// is in, or the server says there is no such event.

import { useEffect, useState } from 'react';
import {
  getEvent,
  getEvents,
  type EventPage,
  type EventSummary,
} from '../api/events';
import { ApiError } from '../api/demos';
import { mapName } from '../components/hud/models';
import { messageOf } from '../errors';
import { pageTitle } from '../router';
import { DASH, formatDate, plural } from './format';
import { hasPre, removePre } from './pre';
import PreFrame from './PreFrame';
import PlayIcon from './PlayIcon';
import SiteBar from './SiteBar';
import SiteFoot from './SiteFoot';
import SiteLink from './SiteLink';
import styles from './EventsView.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'list'; events: EventSummary[] }
  | { kind: 'event'; page: EventPage }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** What the list is, as the server's copy says it (prerender.rs `events_html`). */
const EVENTS_INTRO =
  'Pro CS2 tournaments, every match a 3D replay you can watch in your browser with each player\'s stats.';

/** The days an event ran, the day once when they are one; '' when they are not known. */
function range(e: EventSummary): string {
  const first = formatDate(e.firstUnix);
  const last = formatDate(e.lastUnix);
  return first === last ? first : `${first} – ${last}`;
}

export default function EventsView({ slug }: { slug?: string }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  /** Asking again after a failure. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    setState({ kind: 'loading' });
    const load: Promise<State> = slug
      ? getEvent(slug).then((page) => ({ kind: 'event', page }) as State)
      : getEvents().then((events) => ({ kind: 'list', events }) as State);
    load.then(
      (s) => live && setState(s),
      (e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404)
          setState({ kind: 'missing' });
        else setState({ kind: 'error', message: messageOf(e) });
      }
    );
    return () => {
      live = false;
    };
  }, [slug, attempt]);

  // As the server titles each, a missing event "Tournament not found". While it loads and after
  // a failure the title the server sent stands: a renderer that cannot reach the API reads it.
  useEffect(() => {
    if (state.kind === 'list' || state.kind === 'event')
      document.title = pageTitle(
        state.kind === 'event'
          ? `${state.page.event.name} CS2 demos`
          : 'CS2 tournament demos'
      );
    else if (state.kind === 'missing')
      document.title = pageTitle('Tournament not found');
    if (state.kind !== 'loading' && state.kind !== 'error') removePre();
  }, [state]);

  // A Teams column only when the corpus named the teams of some match.
  const teamed =
    state.kind === 'event' && state.page.matches.some((m) => m.teams);
  // A Date column only when some match has a day of its own: the corpus's have none.
  const dated =
    state.kind === 'event' &&
    state.page.matches.some((m) => m.playedUnix !== null);
  const columns = `${teamed ? styles.teamed : ''} ${dated ? '' : styles.undated}`;
  if (hasPre() && (state.kind === 'loading' || state.kind === 'error'))
    return (
      <PreFrame
        failed={
          state.kind === 'error'
            ? {
                text: 'The live list did not load.',
                retry: () => setAttempt((n) => n + 1),
              }
            : undefined
        }
      />
    );

  return (
    <div className="site">
      <SiteBar />
      <main className={styles.page}>
        <div className={styles.box}>
          {state.kind === 'list' && (
            <>
              <h1 className={styles.title}>CS2 tournament demos</h1>
              <div className={styles.cell}>{EVENTS_INTRO}</div>
              {state.events.length === 0 && (
                <div className={styles.cell}>No tournaments yet</div>
              )}
              {state.events.map((e) => (
                <div key={e.slug} className={styles.item}>
                  <SiteLink href={`/events/${e.slug}`} className={styles.name}>
                    {e.name}
                  </SiteLink>
                  <span className={styles.dim}>
                    <span className="n">{e.matches}</span>{' '}
                    {plural(e.matches, 'match', 'matches')}
                  </span>
                  <span className={`${styles.dim} n`}>{range(e)}</span>
                </div>
              ))}
            </>
          )}
          {state.kind === 'event' && (
            <>
              <h1 className={styles.title}>{state.page.event.name}</h1>
              <div className={styles.cell} data-testid="event-span">
                <span className="n">{state.page.event.matches}</span>{' '}
                {plural(state.page.event.matches, 'match', 'matches')}
                {range(state.page.event) && (
                  <>
                    {' · '}
                    <span className="n">{range(state.page.event)}</span>
                  </>
                )}
              </div>
              <div className={`${styles.head} ${columns}`}>
                <span>Date</span>
                <span>Map</span>
                {teamed && <span>Teams</span>}
                <span>Score</span>
                <span>Top</span>
                <span />
              </div>
              {state.page.matches.map((m) => (
                <div
                  key={m.demoId}
                  className={`${styles.match} ${columns}`}
                  data-match
                >
                  <span className="n">{formatDate(m.playedUnix)}</span>
                  <SiteLink href={`/d/${m.demoId}`} className={styles.name}>
                    {mapName(m.map)}
                  </SiteLink>
                  {teamed && (
                    <span className={styles.top}>
                      {m.teams ? `${m.teams[0]} vs ${m.teams[1]}` : DASH}
                    </span>
                  )}
                  <span className="n">
                    {m.score[0]}–{m.score[1]}
                  </span>
                  <span className={styles.top}>{m.top ?? DASH}</span>
                  <SiteLink
                    href={`/d/${m.demoId}`}
                    className={styles.replay}
                    aria-label={`Replay ${m.title}`}
                  >
                    <PlayIcon />
                    Replay
                  </SiteLink>
                </div>
              ))}
            </>
          )}
          {state.kind === 'missing' && (
            <>
              <h1 className={styles.title}>No such tournament</h1>
              <div className={styles.cell}>
                <SiteLink href="/">Home</SiteLink>
              </div>
            </>
          )}
          {state.kind === 'error' && (
            <>
              <h1 className={styles.title}>Tournaments</h1>
              <div className={styles.cell} role="alert">
                {state.message}
              </div>
            </>
          )}
        </div>
      </main>
      <SiteFoot />
    </div>
  );
}
