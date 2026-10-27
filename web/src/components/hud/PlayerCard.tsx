// Bottom left, in POV: the followed player. Name and money, health and armour,
// the weapon in hand with its magazine, the grenades carried, kills and deaths, and state
// tags. A click opens the scoreboard. Over it, once the followed player has died this round
// (and no reel plays), "Kill cam" replays that death, as `K` does. Compact (the narrow
// layout), it keeps the name, money, health, armour and the weapon with its magazine, and
// drops the weapon's name, the grenades and the footer.

import { countRender, useDerived } from '../../state/derive';
import { directedFollow, playbackStore, shownAt } from '../../state/store';
import { lastDeath } from '../../sim/killcam';
import { statsThrough } from '../../sim/stats';
import { Helmet, Kit, Vest } from './icons';
import { playerCardModel } from './models';
import { useScoreboard } from './scoreboard-state';
import WeaponIcon from './WeaponIcon';
import styles from './hud.module.css';

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export default function PlayerCard({ compact = false }: { compact?: boolean }) {
  countRender('PlayerCard');
  const toggle = useScoreboard((s) => s.togglePinned);
  // Changes with what the player's samples show (health, weapon, magazine, ...), not with
  // the frame.
  const m = useDerived((s) => {
    // Who the camera shows: after a death and its hold, the killer it cut to.
    const follow = shownAt(s);
    if (!s.pack || follow === null || s.camera === 'free') return null;
    // The match's kills and deaths, as counted at the end of the current second.
    const rate = s.pack.header.tick_rate;
    const second = Math.floor(s.tick / rate);
    const stats = statsThrough(s.pack, s.round, (second + 1) * rate);
    const card = playerCardModel(s.pack, s.round, s.tick, follow, stats);
    if (!card) return null;
    // The death `K` replays: the followed player's (the director's pick while it drives).
    const followed = directedFollow(s).follow;
    const killcam =
      !s.reel &&
      followed !== null &&
      lastDeath(s.pack, s.round, followed, s.tick) !== null;
    return { card, killcam };
  }, []);
  if (!m) return null;
  const c = m.card;
  const hp = Math.max(0, Math.min(100, c.health));
  return (
    <div className={styles.cardStack}>
      {m.killcam && (
        <button
          type="button"
          className={styles.killcam}
          title="Replay the death from the killer's eyes (K)"
          onClick={() => playbackStore.getState().killcam()}
        >
          Kill cam
          <kbd className={styles.killcamKey}>K</kbd>
        </button>
      )}
      <button
        type="button"
        className={styles.card}
        data-team={c.team}
        data-alive={c.alive}
        data-compact={compact}
        // A press here toggles the scoreboard, which a press elsewhere closes.
        data-scoreboard-toggle=""
        onClick={toggle}
        aria-label={`${c.name}: open the scoreboard`}
      >
        <span className={styles.cardHead}>
          <span className={styles.cardName}>{c.name}</span>
          {c.money !== null && (
            <span className={styles.money}>{money(c.money)}</span>
          )}
        </span>
        {c.alive ? (
          <>
            <span className={styles.vitals}>
              <span className={styles.hp}>
                <span className={styles.hpNum}>{hp}</span>
                <span className={styles.hpBar}>
                  <i style={{ width: `${hp}%` }} data-low={hp <= 25} />
                </span>
              </span>
              {c.armor > 0 && (
                <span
                  className={styles.armor}
                  title={c.helmet ? 'Armour and helmet' : 'Armour'}
                >
                  {c.helmet ? <Helmet /> : <Vest />}
                  {c.armor}
                </span>
              )}
              {c.kit && (
                <span className={styles.armor} title="Defuse kit">
                  <Kit />
                </span>
              )}
            </span>
            <span className={styles.hand}>
              {c.weapon.icon && (
                <WeaponIcon
                  name={c.weapon.icon}
                  label={c.weapon.label}
                  height={1.45}
                />
              )}
              {!compact && (
                <span className={styles.handName}>{c.weapon.label}</span>
              )}
              {c.ammo !== null && <span className={styles.ammo}>{c.ammo}</span>}
            </span>
            {!compact && c.grenades.length > 0 && (
              <span className={styles.nades} aria-label="Grenades">
                {c.grenades.map((g, i) => (
                  <WeaponIcon
                    key={`${g}${i}`}
                    name={g}
                    label={g}
                    height={1.1}
                  />
                ))}
              </span>
            )}
          </>
        ) : (
          <span className={styles.deadNote}>Dead</span>
        )}
        {!compact && (
          <span className={styles.cardFoot}>
            <span className={styles.kd}>
              {count(c.kills, 'kill', 'kills')},{' '}
              {count(c.deaths, 'death', 'deaths')}
            </span>
            {c.tags.map((t) => (
              <span key={t} className={styles.tag} data-tag={t}>
                {t}
              </span>
            ))}
          </span>
        )}
      </button>
    </div>
  );
}
