// The gear by the camera modes: grenade labels and trails, damage numbers, the minimap, the
// outlines through walls, the names over heads, the round summary, the kill cam after each
// death, the sound and its volume, the HUD's size, the keys, and the link to the source. Closes
// on Escape or a click outside it; the Escape that closes it is spent there, so the key map
// does not also close the highlights or leave a reel with it.

import { useId, useRef, useState, type CSSProperties } from 'react';
import { useDismiss } from '../../state/dismiss';
import { HUD_SCALE, settingsStore, useSettings } from '../../state/settings';
import SourceLink from '../SourceLink';
import styles from './hud.module.css';

const KEYS: [string, string][] = [
  ['Space', 'Play or pause'],
  ['← →', 'Previous or next round'],
  [', .', 'Step back or forward'],
  ['1 – 0', 'Follow player 1 to 10'],
  ['V', 'First person'],
  ['C', 'Free camera'],
  ['A', 'Director picks who to follow'],
  ['R', 'The radar, full screen'],
  ['Q', 'Next quality preset'],
  ['X', 'Outlines through walls'],
  ['K', 'Kill cam of the followed player'],
  ['H', 'Highlights of the match'],
  ['N', 'Next in a replay'],
  ['Esc', 'Close the highlights, or back from a replay'],
  ['Tab', 'Scoreboard, while held'],
  ['W A S D Q E', 'Fly, in the free camera'],
];

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className={styles.toggle}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

export default function Settings() {
  const s = useSettings((x) => x.settings);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useId();

  useDismiss(open, root, () => setOpen(false));

  const set = settingsStore.getState().set;
  return (
    <div className={styles.settings} ref={root}>
      <button
        type="button"
        className={styles.gear}
        aria-expanded={open}
        aria-controls={panel}
        aria-label="Settings"
        title="Settings"
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" width="1em" height="1em" aria-hidden="true">
          <path
            fill="currentColor"
            d="M6.8 1h2.4l.4 1.9 1.1.5 1.6-1.1 1.7 1.7-1.1 1.6.5 1.1L15 6.8v2.4l-1.9.4-.5 1.1 1.1 1.6-1.7 1.7-1.6-1.1-1.1.5-.4 1.9H6.8l-.4-1.9-1.1-.5-1.6 1.1-1.7-1.7 1.1-1.6-.5-1.1L1 9.2V6.8l1.9-.4.5-1.1-1.1-1.6 1.7-1.7 1.6 1.1 1.1-.5ZM8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z"
          />
        </svg>
      </button>
      {open && (
        <div
          id={panel}
          className={styles.panel}
          role="dialog"
          aria-label="Settings"
        >
          <fieldset className={styles.fields}>
            <legend>Show</legend>
            <Toggle
              label="Grenade labels"
              checked={s.labels}
              onChange={(labels) => set({ labels })}
            />
            <Toggle
              label="Grenade trails"
              checked={s.trails}
              onChange={(trails) => set({ trails })}
            />
            <Toggle
              label="Damage numbers"
              checked={s.damageNumbers}
              onChange={(damageNumbers) => set({ damageNumbers })}
            />
            <Toggle
              label="Minimap"
              checked={s.minimap}
              onChange={(minimap) => set({ minimap })}
            />
            <Toggle
              label="Outlines through walls"
              checked={s.xray}
              onChange={(xray) => set({ xray })}
            />
            <Toggle
              label="Names over heads"
              checked={s.nameTags}
              onChange={(nameTags) => set({ nameTags })}
            />
            <Toggle
              label="Round summary"
              checked={s.roundSummary}
              onChange={(roundSummary) => set({ roundSummary })}
            />
          </fieldset>
          <fieldset className={styles.fields}>
            <legend>Replays</legend>
            <Toggle
              label="Kill cam after each death"
              checked={s.autoKillcam}
              onChange={(autoKillcam) => set({ autoKillcam })}
            />
          </fieldset>
          <fieldset className={styles.fields}>
            <legend>Audio</legend>
            <Toggle
              label="Sound"
              checked={!s.muted}
              onChange={(on) => set({ muted: !on })}
            />
            <label className={styles.scale}>
              <span>Volume {Math.round(s.volume * 100)}%</span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={Math.round(s.volume * 100)}
                disabled={s.muted}
                style={{ '--fill': `${s.volume * 100}%` } as CSSProperties}
                onChange={(e) =>
                  set({ volume: Number(e.currentTarget.value) / 100 })
                }
              />
            </label>
          </fieldset>
          <label className={styles.scale}>
            <span>HUD size {Math.round(s.hudScale * 100)}%</span>
            <input
              type="range"
              min={HUD_SCALE.min}
              max={HUD_SCALE.max}
              step={0.05}
              value={s.hudScale}
              // How far the brand fill runs along the track (styles/tokens.css).
              style={
                {
                  '--fill': `${((s.hudScale - HUD_SCALE.min) / (HUD_SCALE.max - HUD_SCALE.min)) * 100}%`,
                } as CSSProperties
              }
              onChange={(e) => set({ hudScale: Number(e.currentTarget.value) })}
            />
          </label>
          <dl className={styles.keys}>
            {KEYS.map(([k, what]) => (
              <div key={k}>
                <dt>
                  <kbd>{k}</kbd>
                </dt>
                <dd>{what}</dd>
              </div>
            ))}
          </dl>
          <div className={styles.foot}>
            {/* The click gives focus back to the page, as the transport's controls do, so the
                page has it when its tab comes back. (Space and the arrows play there either
                way: Space does not press a link, `isPressable`.) */}
            <SourceLink onClick={(e) => e.currentTarget.blur()} />
          </div>
        </div>
      )}
    </div>
  );
}
