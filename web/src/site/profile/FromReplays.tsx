// What the replays add, between the figures under the strip and the maps: the weapons the player
// kills most with, their clutches, their utility, each side's line, the bomb and trades, and the
// kinds of kill the kills say. White figures in the strip's hairline grid, each label after its
// figure. A block with nothing to show is left out, and all of them for a player none of whose
// counted matches has them (summaries from before the replays were read for them); when only
// some have, the first block says over how many.

import type { CSSProperties, ReactNode } from 'react';
import type { ReplayTotals, SideTotals } from '../../api/players';
import { spriteStyle } from '../../components/hud/weapon-sprite';
import { normaliseWeapon, weaponName } from '../../sim/weapons';
import { DASH, formatInt, plural } from '../format';
import Pct from '../Pct';
import s from './profile.module.css';

/** What kills name that the game has no one name for, or one longer than a row wants. */
const KILLED_BY: Readonly<Record<string, string>> = {
  knife: 'Knife',
  hegrenade: 'HE grenade',
  inferno: 'Fire',
  planted_c4: 'Bomb',
};

/** A weapon as the page calls it: the game's name where it has one, else as the kills name it. */
function weaponLabel(weapon: string): string {
  return KILLED_BY[weapon] ?? weaponName(weapon) ?? weapon;
}

/** A figure and the label after it. */
type Figure = [ReactNode, string];

/** A heading, then figures: as many a row as there are on a desktop, two on a phone. */
function Figures({
  id,
  title,
  note,
  figures,
}: {
  id: string;
  title: string;
  note?: ReactNode;
  figures: Figure[];
}) {
  return (
    <section className={s.block} data-testid={id}>
      <h2 className={s.head}>
        {title}
        {note}
      </h2>
      <div
        className={`g ${s.figs} ${s.cells}`}
        style={{ '--cols': figures.length } as CSSProperties}
      >
        {figures.map(([value, label]) => (
          <div key={label} className={s.stat} data-cell>
            <span className="n">{value}</span>
            {/* 1v1 to 1v5: numbers, so in the numbers' face. */}
            <span data-label className={/\d/.test(label) ? s.labN : undefined}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A weapon's silhouette, as the kill feed draws it, at the end of its name's cell, so the
 * names keep the page's left edge and the silhouettes line up after them; nothing for a kill
 * without one (fire, the bomb). Beside its name, so hidden from screen readers. */
function WeaponSilhouette({ weapon }: { weapon: string }) {
  const style = spriteStyle(normaliseWeapon(weapon), 1);
  return (
    <span className={s.wslot}>
      {style && (
        <span className={s.wicon} style={style} aria-hidden="true" data-icon />
      )}
    </span>
  );
}

/** Won of played: the clutches won stand out, how many were played is set back. */
function wonOf(won: number, played: number): ReactNode {
  return (
    <>
      {won}
      <span className={s.of} data-of>
        /{played}
      </span>
    </>
  );
}

function Weapons({
  replay: r,
  note,
}: {
  replay: ReplayTotals;
  note?: ReactNode;
}) {
  return (
    <section className={`${s.block} ${s.wblock}`} data-testid="weapons">
      <h2 className={s.head}>
        Weapons
        {note}
      </h2>
      {r.weapons.map((w) => {
        const share = r.kills ? (100 * w.kills) / r.kills : null;
        return (
          <div key={w.weapon} className={`${s.mrow} ${s.wrow}`} data-weapon>
            <div className={`${s.m} ${s.wcell}`}>
              <span className={s.wname} data-name>
                {weaponLabel(w.weapon)}
              </span>
              <WeaponSilhouette weapon={w.weapon} />
            </div>
            <div>
              <span className="n">{w.kills}</span>
              <span className={s.lab}>{plural(w.kills, 'kill', 'kills')}</span>
            </div>
            <div
              className={s.share}
              data-share
              style={
                share === null
                  ? undefined
                  : ({ '--share': `${share}%` } as CSSProperties)
              }
            >
              <span className="n">
                <Pct value={share} />
              </span>
              <span className={s.lab}>of kills</span>
            </div>
          </div>
        );
      })}
    </section>
  );
}

function Sides({ t, ct }: { t: SideTotals; ct: SideTotals }) {
  const sides: [string, SideTotals][] = [
    ['T side', t],
    ['CT side', ct],
  ];
  return (
    <section className={s.block} data-testid="sides">
      <h2 className={s.head}>Sides</h2>
      {sides.map(([name, x]) => (
        <div key={name} className={s.mrow} data-side>
          <div className={s.m}>{name}</div>
          <div>
            <span className="n">{x.kd === null ? DASH : x.kd.toFixed(2)}</span>
            <span className={s.lab}>K/D</span>
          </div>
          <div>
            <span className="n">{formatInt(x.adr)}</span>
            <span className={s.lab}>ADR</span>
          </div>
          <div className={s.across}>
            <span className="n">{x.rounds}</span>
            <span className={s.lab}>{plural(x.rounds, 'round', 'rounds')}</span>
          </div>
        </div>
      ))}
    </section>
  );
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export default function FromReplays({
  replay: r,
  matches,
}: {
  replay: ReplayTotals;
  /** The counted matches the totals are over. */
  matches: number;
}) {
  if (!r.matches) return null;
  const played = sum(r.clutches);
  const kinds: Figure[] = [];
  if (r.wallbangs !== null)
    kinds.push([r.wallbangs, plural(r.wallbangs, 'wallbang', 'wallbangs')]);
  if (r.throughSmoke !== null) kinds.push([r.throughSmoke, 'through smoke']);
  if (r.noScopes !== null)
    kinds.push([r.noScopes, plural(r.noScopes, 'no-scope', 'no-scopes')]);
  if (r.blindKills !== null) kinds.push([r.blindKills, 'while blind']);
  const note = r.matches < matches && (
    <span className={s.headNote}>
      <span className="n">{r.matches}</span> of{' '}
      <span className="n">{matches}</span> matches
    </span>
  );
  // The note goes in the first block, which is one of these three (utility always shows).
  const first = r.weapons.length ? 'weapons' : played ? 'clutches' : 'utility';
  const noteIn = (block: string) => (block === first ? note : undefined);
  return (
    <>
      {r.weapons.length > 0 && <Weapons replay={r} note={noteIn('weapons')} />}
      {played > 0 && (
        <Figures
          id="clutches"
          title="Clutches"
          note={noteIn('clutches')}
          figures={[
            [wonOf(sum(r.clutchesWon), played), 'won'],
            ...r.clutches.map((n, i): Figure => [
              wonOf(r.clutchesWon[i], n),
              `1v${i + 1}`,
            ]),
          ]}
        />
      )}
      <Figures
        id="utility"
        title="Utility"
        note={noteIn('utility')}
        figures={[
          [
            r.flashAssists,
            plural(r.flashAssists, 'flash assist', 'flash assists'),
          ],
          [
            r.enemiesFlashed,
            plural(r.enemiesFlashed, 'enemy flashed', 'enemies flashed'),
          ],
          [
            r.blindPerRound === null ? DASH : r.blindPerRound.toFixed(1),
            's blind per round',
          ],
          [formatInt(r.utilityAdr), 'utility ADR'],
        ]}
      />
      <Sides t={r.t} ct={r.ct} />
      <div className={s.pair}>
        <Figures
          id="bomb"
          title="Bomb"
          figures={[
            [r.plants, plural(r.plants, 'plant', 'plants')],
            [r.defuses, plural(r.defuses, 'defuse', 'defuses')],
          ]}
        />
        <Figures
          id="trades"
          title="Trades"
          figures={[
            [r.tradeKills, plural(r.tradeKills, 'trade kill', 'trade kills')],
            [
              r.tradedDeaths,
              plural(r.tradedDeaths, 'death traded', 'deaths traded'),
            ],
          ]}
        />
      </div>
      {kinds.length > 0 && (
        <Figures id="kill-kinds" title="Kills" figures={kinds} />
      )}
    </>
  );
}
