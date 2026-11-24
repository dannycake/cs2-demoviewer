// Top centre, under the round bar, while a reel plays: what the segment shows (the kill cam's
// two players, or a highlight's player and kinds) and where the reel is, "Next" (`N`) while
// a segment follows, and "Back" (Escape) to where the reel started.

import { countRender, useDerived } from '../../state/derive';
import { playbackStore } from '../../state/store';
import { reelBanner } from './models';
import styles from './ReelBanner.module.css';
import Digits from './Digits';

export default function ReelBanner() {
  countRender('ReelBanner');
  // Changes when a reel starts, moves to another segment or ends; not with the frame.
  const b = useDerived(
    (s) =>
      s.reel && s.pack
        ? { ...reelBanner(s.reel, s.pack), kind: s.reel.kind }
        : null,
    []
  );
  if (!b) return null;
  return (
    <div
      className={styles.banner}
      role="group"
      aria-label={b.kind === 'killcam' ? 'Kill cam' : 'Highlights'}
    >
      <span className={styles.info} aria-live="polite">
        <span className={styles.title}>
          <Digits text={b.title} />
        </span>
        {b.position && <span className={styles.position}>{b.position}</span>}
      </span>
      {b.canNext && (
        <button
          type="button"
          className={styles.button}
          title="Next (N)"
          onClick={() => playbackStore.getState().nextInReel()}
        >
          Next
          <kbd className={styles.key}>N</kbd>
        </button>
      )}
      <button
        type="button"
        className={styles.button}
        title="Back to where it started (Escape)"
        onClick={() => playbackStore.getState().endReel()}
      >
        Back
        <kbd className={styles.key}>Esc</kbd>
      </button>
    </div>
  );
}
