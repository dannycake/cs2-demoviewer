// Who the player is: Steam's avatar (or a person glyph), their name, and Steam's facts, then
// buttons to their Steam profile and (when they have one) their FACEIT profile with FACEIT's mark,
// CS2 level and Elo, each in a new tab, FACEIT's win rate and match count beside it when FACEIT
// gives both, and whether their matches are tracked. While Steam is asked (`asking`) its facts are
// dashed; once it has answered, a fact it did not give is left out. FACEIT's are never dashed.

import type { FaceitAccount, Profile } from '../../api/players';
import { steamLogoUrl } from '../../api/site-assets';
import { faceitProfileUrl, steamProfileUrl } from '../../links';
import { banFacts, countryName, DASH, formatHours, plural } from '../format';
import { useSiteAssets } from '../use-site-assets';
import s from './profile.module.css';

const TRACKING = {
  on: 'Tracking on',
  off: 'Not tracked',
  stopped: 'Tracking stopped',
} as const;

/** The arrow after a link that opens another site. */
export function Away() {
  return (
    <svg
      className={s.arrow}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
    >
      <path d="M3.5 2.5h6v6M9.5 2.5 2.5 9.5" />
    </svg>
  );
}

/** FACEIT's mark (Simple Icons' `faceit`, web/public/faceit.svg), white as Steam's logo is; the
 * trademark is FACEIT's. */
const FACEIT_MARK = '/faceit.svg';

/** What the FACEIT button says after its name: the CS2 level and Elo it has, or that it is their
 * profile. */
function faceitWords({ level, elo }: FaceitAccount) {
  if (level == null && elo == null) return ' profile';
  return (
    <>
      {level != null && (
        <>
          {' · Level '}
          <b className="n">{level}</b>
        </>
      )}
      {elo != null && (
        <>
          {' · '}
          <b className="n">{elo.toLocaleString('en-US')}</b> Elo
        </>
      )}
    </>
  );
}

export default function Who({
  profile,
  asking,
}: {
  profile: Profile;
  /** Steam's facts are on their way. */
  asking: boolean;
}) {
  const assets = useSiteAssets();
  const { steam, faceit } = profile;
  const steamUrl = steamProfileUrl(profile.steamid);
  const days = steam.daysSinceLastBan;
  const bans = banFacts(steam).filter((b) => asking || b.words !== DASH);
  const recent =
    steam.cs2RecentMinutes == null
      ? null
      : formatHours(steam.cs2RecentMinutes * 60);
  return (
    <div className={`g ${s.who}`} data-testid="who">
      <div className={s.ava}>
        {profile.avatar ? (
          <img src={profile.avatar} alt="" referrerPolicy="no-referrer" />
        ) : (
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="12" cy="8" r="4.5" />
            <path d="M3 21c0-4.4 4-7 9-7s9 2.6 9 7z" />
          </svg>
        )}
      </div>
      <div className={s.about}>
        <h1 className={s.name}>{profile.name ?? DASH}</h1>
        {/* The account's age, country, hours and bans dashed while Steam is asked; the level
            and the last two weeks only when Steam gives them, as the rest once it has answered. */}
        <div className={s.facts}>
          {(asking || steam.sinceYear != null) && (
            <span data-fact>
              <b className="n">{steam.sinceYear ?? DASH}</b> on Steam
            </span>
          )}
          {(asking || steam.country) && (
            <span data-fact>
              from <b>{countryName(steam.country)}</b>
            </span>
          )}
          {/* Labels after their figures, hours in one word everywhere. */}
          {steam.level != null && (
            <span data-fact>
              <b className="n">{steam.level}</b> Steam level
            </span>
          )}
          {(asking || steam.cs2Hours != null) && (
            <span data-fact>
              <b className="n">{steam.cs2Hours ?? DASH}</b>{' '}
              {plural(steam.cs2Hours ?? DASH, 'hour', 'hours')} in CS2
            </span>
          )}
          {recent !== null && (
            <span data-fact>
              <b className="n">{recent}</b>
              <span>
                {' '}
                {plural(recent, 'hour', 'hours')} in{' '}
                <span className={s.labN}>2</span> weeks
              </span>
            </span>
          )}
          {bans.map(({ n, words }) => (
            <span key={words} data-fact>
              <b>
                {n !== null && (
                  <>
                    <span className="n">{n}</span>{' '}
                  </>
                )}
                {words}
              </b>
            </span>
          ))}
          {days != null && (
            <span data-fact>
              last ban{' '}
              {days === 0 ? (
                <b>today</b>
              ) : (
                <>
                  <b className="n">{days}</b> {days === 1 ? 'day' : 'days'} ago
                </>
              )}
            </span>
          )}
          {/* The row's spacer, which says when Steam's facts are on their way. */}
          <span className={`${s.fill} ${profile.steamPending ? s.asking : ''}`}>
            {profile.steamPending && 'Asking Steam…'}
          </span>
          {/* Each link is its whole cell, as the facts' are their words. */}
          {steamUrl && (
            <a
              className={s.out}
              href={steamUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-link="steam"
            >
              {assets && (
                <img src={steamLogoUrl(assets)} alt="" width={16} height={16} />
              )}
              Steam profile
              <Away />
            </a>
          )}
          {faceit && (
            <a
              className={s.out}
              href={faceitProfileUrl(faceit.nickname)}
              target="_blank"
              rel="noopener noreferrer"
              data-link="faceit"
            >
              <img src={FACEIT_MARK} alt="" width={16} height={16} />
              FACEIT{faceitWords(faceit)}
              <Away />
            </a>
          )}
          {/* FACEIT's lifetime figures, its own cell beside its button, only with both. */}
          {faceit?.winsPct != null && faceit.matches != null && (
            <span data-faceit-stats>
              <b className="n">{Math.round(faceit.winsPct)}%</b> wins ·{' '}
              <b className="n">{faceit.matches.toLocaleString('en-US')}</b>{' '}
              {plural(faceit.matches, 'match', 'matches')}
            </span>
          )}
          <span
            className={`${s.track} ${profile.tracking === 'on' ? '' : s.trackOff}`}
          >
            {TRACKING[profile.tracking]}
          </span>
        </div>
      </div>
    </div>
  );
}
