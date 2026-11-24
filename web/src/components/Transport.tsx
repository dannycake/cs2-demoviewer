// The bar at the bottom: play/pause, round navigation with the score, the scrubber, the
// clock, speed and the quality preset.
// Controls that change a setting give focus back to the page, so Space and the arrows keep
// driving playback instead of the control. In the narrow layout its controls are 44 px touch
// targets, speed and quality are in Settings (`Settings`' `playback`), and the scrubber has a
// row of its own above the rest, held upright, or sits between them on its side. `ref` is the
// bar, whose height the view measures.

import { useRef, type Ref, type SyntheticEvent } from 'react';
import { QUALITIES, QUALITY_LABEL, type Quality } from '../scene/quality';
import { countRender, useDerived, useFrameWriter } from '../state/derive';
import { playbackStore, SPEEDS } from '../state/store';
import Digits from './hud/Digits';
import { roundClock, roundTitle } from './scrubber-model';
import Scrubber from './Scrubber';
import styles from './Transport.module.css';

function blur(e: SyntheticEvent<HTMLElement>) {
  e.currentTarget.blur();
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M4 2.5v11l9-5.5z" fill="currentColor" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z" fill="currentColor" />
    </svg>
  );
}

function Chevron({ dir }: { dir: -1 | 1 }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={dir < 0 ? 'M10 3 5 8l5 5' : 'M6 3l5 5-5 5'}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The debug corner's page (`?debug=1`): the clock's tooltip names the tick. */
const DEBUG =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('debug') === '1';

/**
 * Time in the round, kept apart from the bar: it renders once a second while playing, and
 * the exact tick (`data-tick`, and with `?debug=1` the tooltip) is written to it in the frame
 * after it changes.
 */
function Clock() {
  countRender('Clock');
  const text = useDerived((s) => {
    const info = s.pack?.header.rounds[s.round];
    return info && s.pack
      ? roundClock(info, s.tick, s.pack.header.tick_rate)
      : '';
  }, []);
  const el = useRef<HTMLSpanElement>(null);
  useFrameWriter((s) => {
    const whole = String(Math.round(s.tick));
    if (!el.current || el.current.dataset.tick === whole) return;
    el.current.dataset.tick = whole;
    if (DEBUG) el.current.title = `tick ${whole}`;
  }, []);
  return (
    <span ref={el} className={styles.clock} data-testid="clock">
      {text}
    </span>
  );
}

export default function Transport({ ref }: { ref?: Ref<HTMLDivElement> }) {
  countRender('Transport');
  const { loaded, round, last, title, playing, speed, quality } = useDerived(
    (s) => ({
      loaded: s.pack !== null,
      round: s.round,
      last: (s.pack?.header.rounds.length ?? 0) - 1,
      title: s.pack ? roundTitle(s.pack.header.rounds, s.round) : 'Round –',
      playing: s.playing,
      speed: s.speed,
      quality: s.quality,
    }),
    []
  );
  const act = playbackStore.getState;

  return (
    <div ref={ref} className={styles.bar} data-testid="transport">
      <button
        type="button"
        className={styles.play}
        disabled={!loaded}
        aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
        title={playing ? 'Pause (Space)' : 'Play (Space)'}
        onClick={() => act().toggle()}
      >
        {playing ? <PauseIcon /> : <PlayIcon />}
      </button>

      <div className={styles.rounds}>
        <button
          type="button"
          className={styles.step}
          disabled={!loaded || round <= 0}
          aria-label="Previous round (←)"
          title="Previous round (←)"
          onClick={() => act().seekRound(round - 1)}
        >
          <Chevron dir={-1} />
        </button>
        <span className={styles.title} data-testid="round-title">
          <Digits text={title} />
        </span>
        <button
          type="button"
          className={styles.step}
          disabled={!loaded || round >= last}
          aria-label="Next round (→)"
          title="Next round (→)"
          onClick={() => act().seekRound(round + 1)}
        >
          <Chevron dir={1} />
        </button>
      </div>

      <Scrubber />
      <Clock />

      <label
        className={`${styles.speed} ${styles.figures}`}
        title="Playback speed"
      >
        <span className={styles.srOnly}>Speed</span>
        <select
          value={speed}
          onChange={(e) => {
            act().setSpeed(Number(e.currentTarget.value));
            blur(e);
          }}
        >
          {SPEEDS.map((v) => (
            <option key={v} value={v}>
              {v}×
            </option>
          ))}
        </select>
      </label>

      <label
        className={styles.speed}
        title="Rendering quality: lighting, shadows and effects (Q)"
      >
        <span className={styles.srOnly}>Quality</span>
        <select
          value={quality}
          data-testid="quality"
          onChange={(e) => {
            act().setQuality(e.currentTarget.value as Quality);
            blur(e);
          }}
        >
          {QUALITIES.map((q) => (
            <option key={q} value={q}>
              {QUALITY_LABEL[q]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
