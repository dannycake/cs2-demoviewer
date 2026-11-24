// The player's matches, newest first: All, Premier or Competitive (Premier and Competitive never
// list Wingman or any other mode). Each row: the result, the map with its mode (or tournament) and
// day (a mode's tab, which says the mode, only the day) over a strip of the map's screenshot
// (./strip), the score, K–D, ADR, HS% and KAST (the widest screens only), the rating, the rank
// the player had, and its replay; a tablet's leaves out the K–D and the rank, a phone's the score
// too. The first ten show; "All ‹n› matches" shows the rest, fetching past the hundred the
// profile came with. A toggle (./Toggle) before the Replay, named by the game's map and day, opens
// the game's own strip, figures and replay figures under its row (./Expansion), with a note when
// it is not in the totals; one game is open at a time, and a tab change or asking for the rest
// shuts it.

import { Fragment, useId, useRef, useState, type KeyboardEvent } from 'react';
import { getMatches, type MatchRow } from '../../api/players';
import type { SiteAssets } from '../../api/site-assets';
import { mapName } from '../../components/hud/models';
import { messageOf } from '../../errors';
import { DASH, formatDay, formatInt, formatRating, modeLabel } from '../format';
import Pct from '../Pct';
import PlayIcon from '../PlayIcon';
import SiteLink from '../SiteLink';
import { useSiteAssets } from '../use-site-assets';
import Expansion from './Expansion';
import { NoRank, PremierBadge, RankIcon } from './Ranks';
import { totalsOfRow } from './row-totals';
import { stripCell } from './strip';
import Toggle from './Toggle';
import s from './profile.module.css';

const FIRST_ROWS = 10;
type Tab = 'all' | 'premier' | 'competitive' | 'faceit';
const TABS: [Tab, string][] = [
  ['all', 'All'],
  ['premier', 'Premier'],
  ['competitive', 'Competitive'],
  ['faceit', 'FACEIT'],
];

const RESULT = { w: 'W', l: 'L', t: 'T' } as const;

/** What a tab with no match says. */
const NONE: Record<Tab, string> = {
  all: 'No matches here',
  premier: 'No Premier matches here',
  competitive: 'No Competitive matches here',
  faceit: 'No FACEIT matches here',
};

/** The rank the player had: a Premier rating, a Competitive rank, or a dash for none. */
function RowRank({ row }: { row: MatchRow }) {
  if (row.rank?.kind === 11)
    return <PremierBadge rating={row.rank.value} small />;
  if (row.rank?.kind === 12 && row.rank.value > 0)
    return <RankIcon rank={row.rank.value} small />;
  return <NoRank />;
}

/** A row's own name among the rows: its React key, and what says it is the one open. */
const keyOf = (row: MatchRow) => `${row.demoId}${row.playedUnix}`;

/** What a game's toggle and figures are called for screen readers, so a list of the toggles
 * tells the games apart: its map and day ("Mirage, Oct 31"), the map alone without a day. */
function gameName(row: MatchRow, now: Date): string {
  const day = formatDay(row.playedUnix, now);
  return day ? `${mapName(row.map)}, ${day}` : mapName(row.map);
}

function Row({
  row,
  now,
  withMode,
  assets,
  open,
  panel,
  onToggle,
}: {
  row: MatchRow;
  now: Date;
  /** Whether to say the mode: not on a mode's own tab. */
  withMode: boolean;
  /** The site manifest, with the map's strip to set behind its name. */
  assets: SiteAssets | null;
  /** Whether its figures are open under it, and their id. */
  open: boolean;
  panel: string;
  onToggle: () => void;
}) {
  const mode = withMode ? modeLabel(row) : '';
  const day = formatDay(row.playedUnix, now);
  return (
    <div className={s.row} data-match>
      <div className={`${s.res} ${row.result ? s[`res_${row.result}`] : ''}`}>
        {row.result ? RESULT[row.result] : '–'}
      </div>
      <div {...stripCell(assets, row.map, s.map)}>
        {mapName(row.map)}
        {/* A long event gives way in a narrow row; the day, which tells rows apart, never. */}
        <small>
          {/* The comma goes with the mode, so a cut mode ends in "…", not "…,". */}
          {mode && (
            <span className={s.mode} data-mode>
              {mode}
              {day && ','}
            </span>
          )}
          {mode && day && <span className={s.sep}> </span>}
          {day && (
            <span className={s.day} data-day>
              {day}
            </span>
          )}
        </small>
      </div>
      <div className={s.wide}>
        <span className="n">
          {row.score ? `${row.score[0]}–${row.score[1]}` : DASH}
        </span>
        <span className={s.lab}>score</span>
      </div>
      <div className={`${s.wide} ${s.desk}`}>
        <span className="n">
          {row.kills}–{row.deaths}
        </span>
        <span className={s.lab}>K–D</span>
      </div>
      <div className={`${s.wide} ${s.wider}`}>
        <span className="n">{formatInt(row.adr)}</span>
        <span className={s.lab}>ADR</span>
      </div>
      <div className={`${s.wide} ${s.wider}`}>
        <span className="n">{formatInt(row.hsPct)}</span>
        <span className={s.lab}>HS%</span>
      </div>
      <div className={`${s.wide} ${s.wider}`}>
        <span className="n">
          <Pct value={row.kastPct} />
        </span>
        <span className={s.lab}>KAST</span>
      </div>
      <div className={s.rt}>
        <span className="n">{formatRating(row.rating)}</span>
        <span className={s.lab}>rating</span>
      </div>
      <div className={`${s.wide} ${s.desk}`}>
        <RowRank row={row} />
      </div>
      <Toggle
        open={open}
        controls={panel}
        label={`${open ? 'Hide' : 'Show'} ${gameName(row, now)} stats`}
        onToggle={onToggle}
      />
      <SiteLink
        className={s.replay}
        href={`/d/${row.demoId}`}
        aria-label={`Replay ${mapName(row.map)}`}
      >
        <PlayIcon />
        <span>Replay</span>
      </SiteLink>
    </div>
  );
}

export default function MatchRows({
  steamid,
  first,
  count,
}: {
  steamid: string;
  first: MatchRow[];
  count: number;
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [rows, setRows] = useState(first);
  const [all, setAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The row whose figures are open (`keyOf`). */
  const [open, setOpen] = useState<string | null>(null);
  const [now] = useState(() => new Date());
  const assets = useSiteAssets();
  const shown = rows.filter((r) => tab === 'all' || r.mode === tab);
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  /** Shows tab `t`; a row open in the last one shuts. */
  const choose = (t: Tab) => {
    if (t === tab) return;
    setTab(t);
    setOpen(null);
  };

  // WAI-ARIA's tabs: one stop for Tab, the arrow keys (and Home and End) between the tabs, each
  // shown as it is reached.
  const onKey = (e: KeyboardEvent) => {
    const at = TABS.findIndex(([t]) => t === tab);
    let to: number;
    if (e.key === 'ArrowRight') to = (at + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') to = (at - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = TABS.length - 1;
    else return;
    e.preventDefault();
    choose(TABS[to][0]);
    tabRefs.current[to]?.focus();
  };

  const showAll = async () => {
    setAll(true);
    setOpen(null);
    try {
      let have = rows;
      while (have.length < count) {
        const more = await getMatches(steamid, have.length);
        if (!more.length) break;
        have = [...have, ...more];
        setRows(have);
      }
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <>
      <h2 className={s.head} id={`${id}-head`}>
        Matches
      </h2>
      <div
        className={s.tabs}
        role="tablist"
        aria-labelledby={`${id}-head`}
        onKeyDown={onKey}
      >
        {TABS.map(([t, label], i) => (
          <button
            key={t}
            ref={(b) => {
              tabRefs.current[i] = b;
            }}
            id={`${id}-${t}`}
            type="button"
            role="tab"
            aria-selected={tab === t}
            aria-controls={`${id}-panel`}
            tabIndex={tab === t ? 0 : -1}
            className={tab === t ? s.on : ''}
            onClick={() => choose(t)}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className="g"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${tab}`}
        data-testid="match-rows"
      >
        {/* None, when every row is in: a mode's may still be past those loaded (below). */}
        {shown.length === 0 && (all || count <= rows.length) && (
          <p className={s.empty}>{NONE[tab]}</p>
        )}
        {(all ? shown : shown.slice(0, FIRST_ROWS)).map((r) => {
          const k = keyOf(r);
          const panel = `${id}-${k}`;
          return (
            <Fragment key={k}>
              <Row
                row={r}
                now={now}
                withMode={tab === 'all'}
                assets={assets}
                open={open === k}
                panel={panel}
                onToggle={() => setOpen(open === k ? null : k)}
              />
              {open === k && (
                <Expansion
                  id={panel}
                  totals={totalsOfRow(r)}
                  replay={r.replay}
                  note={r.counted ? undefined : 'Not in the totals'}
                  label={`${gameName(r, now)} stats`}
                />
              )}
            </Fragment>
          );
        })}
        {/* A mode's older matches may be past the rows loaded so far: showing all loads every
            row, then this tab shows its own. Until then its count is unknown. */}
        {!all && (shown.length > FIRST_ROWS || count > rows.length) && (
          <button
            type="button"
            className={s.more}
            onClick={() => void showAll()}
          >
            {/* One child: a flex box trims the spaces at the edges of each of its own. */}
            <span>
              All{' '}
              {tab === 'all' ? (
                <span className="n">{count}</span>
              ) : count > rows.length ? (
                TABS.find(([t]) => t === tab)?.[1]
              ) : (
                <span className="n">{shown.length}</span>
              )}{' '}
              matches
            </span>
          </button>
        )}
        {error && (
          <p className={s.more} role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  );
}
