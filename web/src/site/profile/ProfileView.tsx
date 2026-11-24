// A player's profile (`/id/<name>`, `/profiles/<steamid>`, anything under them): who they are,
// their Premier rating and Competitive rank, the stat strip and the figures under it, what the
// replays add, their maps, who they played with and their matches (each map and match expands
// in place to its full figures), from the matches the server holds and what Steam says, then a
// tracked player's FACEIT matches as FACEIT gave them (./FaceitHistory). Every block shows in every state, "—" where a value is unknown, so
// profiles look alike however much is known; what the replays add and who they played with show
// only when there is any. A hidden profile shows only that, an account Steam does not know only
// that, each with the way home; a profile that did not load, only that and a way to ask again.
// Over the server's pre-rendered copy of the profile (`pre.ts`) it draws only the site's frame
// while it loads, and one slim line if it fails (`PreFrame`): the copy is the page under them. The
// copy goes once the profile is in, or the server says it is hidden or has no account.

import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from '../../api/demos';
import {
  getProfile,
  HiddenProfileError,
  lookup,
  type Profile,
} from '../../api/players';
import { messageOf } from '../../errors';
import { pageTitle, type ProfileRef } from '../../router';
import { statsTitle } from '../format';
import LoadingBar from '../LoadingBar';
import OneInput from '../OneInput';
import { hasPre, removePre } from '../pre';
import PreFrame from '../PreFrame';
import SiteBar from '../SiteBar';
import SiteFoot from '../SiteFoot';
import SiteLink from '../SiteLink';
import FaceitHistory from './FaceitHistory';
import FromReplays from './FromReplays';
import MapTable from './MapTable';
import MatchRows from './MatchRows';
import Mates from './Mates';
import Ranks from './Ranks';
import StatGrid from './StatGrid';
import StatStrip from './StatStrip';
import Who from './Who';
import s from './profile.module.css';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; profile: Profile }
  | { kind: 'hidden' }
  | { kind: 'missing' }
  | { kind: 'error'; message: string };

/** What a profile shows before it is in: every block, with dashes. */
const BLANK: Profile = {
  steamid: '',
  name: null,
  avatar: null,
  steam: {
    sinceYear: null,
    country: null,
    cs2Hours: null,
    cs2RecentMinutes: null,
    level: null,
    vacBans: null,
    gameBans: null,
    communityBanned: null,
    tradeBan: null,
    daysSinceLastBan: null,
  },
  tracking: 'off',
  premier: null,
  competitive: null,
  totals: {
    rating: null,
    openingWon: 0,
    openingLost: 0,
    kd: null,
    adr: null,
    hsPct: null,
    matches: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    rounds: 0,
    kastPct: null,
    survivalPct: null,
    multiKills: [0, 0, 0, 0],
    wins: 0,
    losses: 0,
    ties: 0,
    seconds: 0,
  },
  replay: {
    matches: 0,
    kills: 0,
    weapons: [],
    clutches: [0, 0, 0, 0, 0],
    clutchesWon: [0, 0, 0, 0, 0],
    tradeKills: 0,
    tradedDeaths: 0,
    flashAssists: 0,
    enemiesFlashed: 0,
    blindPerRound: null,
    utilityAdr: null,
    plants: 0,
    defuses: 0,
    t: { rounds: 0, kills: 0, deaths: 0, kd: null, adr: null },
    ct: { rounds: 0, kills: 0, deaths: 0, kd: null, adr: null },
    wallbangs: null,
    throughSmoke: null,
    noScopes: null,
    blindKills: null,
  },
  maps: [],
  mates: [],
  matches: [],
  matchCount: 0,
};

/** While Steam's facts are being fetched, the profile is asked for again this often, this many
 * times at most (the server answers at once with what it keeps). */
export const STEAM_AGAIN_MS = 2000;
const STEAM_TRIES = 5;

/** Waits `ms`, or less when `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      done();
    });
  });
}

const where = (ref: ProfileRef) =>
  ref.kind === 'steamid'
    ? `skunk.club/profiles/${ref.id}`
    : `skunk.club/id/${ref.name}`;

/** A message as a sentence: a capital first, a full stop last. */
function sentence(text: string): string {
  const t = text.trim();
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?…]$/.test(s) ? s : `${s}.`;
}

/** What shows instead of a profile: a heading, one sentence and the one way on, in the contact
 * page's column of boxes. */
function Notice({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action: ReactNode;
}) {
  return (
    <div className={s.noticePage}>
      <section className={s.notice} data-testid="notice">
        <h1 className={s.noticeTitle}>{title}</h1>
        <p className={s.noticeText}>{children}</p>
        {action}
      </section>
    </div>
  );
}

const HOME = (
  <SiteLink className={s.noticeGo} href="/">
    Go to the home page
  </SiteLink>
);

/** The tab's title for a page that is not a profile. */
const TITLES = {
  hidden: 'Hidden profile',
  missing: 'Player not found',
} as const;

export default function ProfileView({ profile: ref }: { profile: ProfileRef }) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  /** Asking again after a failure. */
  const [attempt, setAttempt] = useState(0);
  const key = ref.kind === 'steamid' ? ref.id : ref.name;

  useEffect(() => {
    const ac = new AbortController();
    setState({ kind: 'loading' });
    void (async () => {
      try {
        let id = ref.kind === 'steamid' ? ref.id : null;
        if (id === null) {
          // As an /id/ link: a custom URL name only, never a player's name.
          const found = await lookup(where(ref));
          if (found.kind !== 'profile') throw new ApiError('not found', 404);
          id = found.steamid;
        }
        let profile = await getProfile(id, ac.signal);
        if (ac.signal.aborted) return;
        setState({ kind: 'ok', profile });
        // Shown at once with what the server keeps; Steam's facts fill in when they come.
        for (let i = 0; profile.steamPending && i < STEAM_TRIES; i++) {
          await pause(STEAM_AGAIN_MS, ac.signal);
          if (ac.signal.aborted) return;
          try {
            profile = await getProfile(id, ac.signal);
          } catch {
            break;
          }
          if (ac.signal.aborted) return;
          setState({ kind: 'ok', profile });
        }
        if (profile.steamPending)
          setState({
            kind: 'ok',
            profile: { ...profile, steamPending: false },
          });
      } catch (e) {
        if (ac.signal.aborted) return;
        if (e instanceof HiddenProfileError) setState({ kind: 'hidden' });
        else if (e instanceof ApiError && e.status === 404)
          setState({ kind: 'missing' });
        else setState({ kind: 'error', message: messageOf(e) });
      }
    })();
    return () => ac.abort();
    // `key` stands for the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.kind, key, attempt]);

  const profile = state.kind === 'ok' ? state.profile : BLANK;
  const busy = state.kind === 'loading' || !!profile.steamPending;
  // While it loads, the title the server sent ("‹name›'s CS2 stats · skunk.club") stands.
  useEffect(() => {
    if (state.kind === 'ok')
      document.title = pageTitle(
        state.profile.name && `${statsTitle(state.profile.name)} and demos`
      );
    else if (state.kind === 'hidden' || state.kind === 'missing')
      document.title = pageTitle(TITLES[state.kind]);
    if (state.kind !== 'loading' && state.kind !== 'error') removePre();
  }, [state]);

  if (hasPre() && (state.kind === 'loading' || state.kind === 'error'))
    return (
      <PreFrame
        search={<OneInput variant="bar" />}
        failed={
          state.kind === 'error'
            ? {
                text: 'Live stats did not load.',
                retry: () => setAttempt((n) => n + 1),
              }
            : undefined
        }
      />
    );

  return (
    <div className="site">
      <SiteBar search={<OneInput variant="bar" />} />
      {busy && <LoadingBar />}
      <main className={s.page}>
        {state.kind === 'hidden' && (
          <Notice title="This profile is hidden" action={HOME}>
            Its owner asked for it to be taken off skunk.club.
          </Notice>
        )}
        {state.kind === 'missing' && (
          <Notice title="Player not found" action={HOME}>
            {ref.kind === 'vanity' ? (
              <>No Steam account goes by “{ref.name}”.</>
            ) : (
              <>
                No Steam account has the ID <span className="n">{ref.id}</span>.
              </>
            )}
          </Notice>
        )}
        {state.kind === 'error' && (
          <Notice
            title="This profile did not load"
            action={
              <button
                type="button"
                className={s.noticeGo}
                onClick={() => setAttempt((n) => n + 1)}
              >
                Try again
              </button>
            }
          >
            <span role="alert">{sentence(state.message)}</span>
          </Notice>
        )}
        {(state.kind === 'ok' || state.kind === 'loading') && (
          <div className={s.stack} aria-busy={state.kind === 'loading'}>
            <Who profile={profile} asking={busy} />
            <Ranks
              premier={profile.premier}
              competitive={profile.competitive}
            />
            <StatStrip totals={profile.totals} />
            <StatGrid totals={profile.totals} />
            <FromReplays
              replay={profile.replay}
              matches={profile.totals.matches}
            />
            {/* A new player's table starts shut. Not the bare steamid, the match rows' key:
                siblings' keys must differ. */}
            <MapTable key={`maps-${profile.steamid}`} maps={profile.maps} />
            <Mates mates={profile.mates} />
            <MatchRows
              key={profile.steamid}
              steamid={profile.steamid}
              first={profile.matches}
              count={profile.matchCount}
            />
            <FaceitHistory
              rows={profile.faceitHistory ?? []}
              tracking={profile.tracking}
            />
          </div>
        )}
      </main>
      <SiteFoot />
    </div>
  );
}
