// The two camera modes, top right: POV (the default) and Free. POV takes the first player
// when nobody is followed yet (the store does that). "Auto" is the director's toggle inside
// POV: on, the director picks whose eyes POV looks through (turning it on from Free goes to
// POV); picking a player turns it off.
// "Radar" swaps the 3D view for the full-screen radar; a camera mode swaps back.
// "Highlights" opens and closes the highlights panel (`H`), which hangs under this row.
// "Share" hands on a link to this moment (`ShareButton`). Compact (the narrow layout), the
// buttons drop their keys and close up, and Highlights and Share are glyphs, so the row fits
// a phone's width; their names stay for screen readers.

import type { CameraMode } from '../sim/follow';
import { playbackStore, usePlayback } from '../state/store';
import { Star } from './hud/icons';
import styles from './CameraBar.module.css';
import ShareButton from './ShareButton';

const MODES: { mode: CameraMode; label: string; key: string }[] = [
  { mode: 'pov', label: 'POV', key: 'V' },
  { mode: 'free', label: 'Free', key: 'C' },
];

export default function CameraBar({ compact = false }: { compact?: boolean }) {
  const camera = usePlayback((s) => s.camera);
  const director = usePlayback((s) => s.director);
  const radar = usePlayback((s) => s.radar);
  const highlights = usePlayback((s) => s.highlights);
  const hasPack = usePlayback((s) => s.pack !== null);
  const hasPlayers = usePlayback(
    (s) => (s.pack?.header.players.length ?? 0) > 0
  );

  return (
    <div
      className={styles.bar}
      data-compact={compact}
      role="group"
      aria-label="Camera"
    >
      {MODES.map(({ mode, label, key }) => (
        <button
          key={mode}
          type="button"
          className={styles.button}
          aria-pressed={camera === mode}
          disabled={mode === 'pov' && !hasPlayers}
          title={`${label} camera (${key})`}
          onClick={() => playbackStore.getState().setCamera(mode)}
        >
          {label}
          {!compact && <kbd className={styles.key}>{key}</kbd>}
        </button>
      ))}
      <span className={styles.divider} aria-hidden="true" />
      <button
        type="button"
        className={styles.button}
        aria-pressed={director}
        disabled={!hasPlayers}
        title="Director: picks who to follow (A)"
        onClick={() => playbackStore.getState().setDirector(!director)}
      >
        Auto
        {!compact && <kbd className={styles.key}>A</kbd>}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-pressed={radar}
        disabled={!hasPack}
        title="Radar: the whole map from above (R)"
        onClick={() => playbackStore.getState().setRadar(!radar)}
      >
        Radar
        {!compact && <kbd className={styles.key}>R</kbd>}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-pressed={highlights}
        aria-haspopup="dialog"
        disabled={!hasPack}
        title="Highlights of the match (H)"
        // The panel's press-outside close leaves this button to toggle it.
        data-highlights-toggle=""
        onClick={() => playbackStore.getState().setHighlights(!highlights)}
      >
        {compact ? (
          <>
            <Star />
            <span className={styles.srOnly}>Highlights</span>
          </>
        ) : (
          <>
            Highlights
            <kbd className={styles.key}>H</kbd>
          </>
        )}
      </button>
      <span className={styles.divider} aria-hidden="true" />
      <ShareButton className={styles.button} compact={compact} />
    </div>
  );
}
