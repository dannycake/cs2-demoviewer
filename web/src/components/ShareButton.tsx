// The Share button at the end of the camera bar: a link to this moment, the round, the tick,
// the camera and the followed player, or in Free the camera's pose (`state/share.ts`). On a
// phone (a coarse pointer) it opens the share sheet; elsewhere it copies the link and says
// "Copied" for 2 s (a cancelled share sheet shows nothing). Where the page has no clipboard
// (a plain-http LAN address) or the clipboard or share sheet fails, it shows the link in a
// field, selected, which closes on Escape or a press outside it; the Escape that closes it is
// spent there, as in the settings. Compact (the narrow camera bar), the button is a glyph,
// brand-coloured while it says "Copied", and the field hangs from the camera row's right edge.

import { useEffect, useId, useRef, useState } from 'react';
import { useDismiss } from '../state/dismiss';
import { currentFreePose } from '../state/free-pose';
import { shareLink, shareUrl } from '../state/share';
import { playbackStore, usePlayback } from '../state/store';
import { Share } from './hud/icons';
import styles from './ShareButton.module.css';

/** How long the button says "Copied". */
const COPIED_MS = 2000;

function coarsePointer(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches
  );
}

/** `className` is the camera bar's button, so Share looks like its neighbours. */
export default function ShareButton({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const hasPack = usePlayback((s) => s.pack !== null);
  const [copied, setCopied] = useState(false);
  /** The link shown in the field, or null while it is closed. */
  const [manual, setManual] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Counts the presses, so an answer that comes after a later press is dropped. */
  const presses = useRef(0);
  const fieldId = useId();

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  // The field opens selected, and closes on Escape or a press outside it.
  useEffect(() => {
    const el = input.current;
    if (manual === null || !el) return;
    el.focus();
    el.select();
    el.setSelectionRange(0, el.value.length);
  }, [manual]);
  useDismiss(manual !== null, root, () => setManual(null));

  const share = () => {
    const url = shareUrl(
      playbackStore.getState(),
      window.location.href,
      currentFreePose()
    );
    const n = ++presses.current;
    // Called within the press: the share sheet and the clipboard need the user's gesture.
    void shareLink(url, navigator, coarsePointer()).then((outcome) => {
      if (n !== presses.current) return;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
      setCopied(outcome === 'copied');
      setManual(outcome === 'manual' ? url : null);
      if (outcome === 'copied')
        timer.current = setTimeout(() => {
          timer.current = null;
          setCopied(false);
        }, COPIED_MS);
    });
  };

  return (
    <span className={styles.share} data-compact={compact} ref={root}>
      <button
        type="button"
        className={[className, copied && styles.copied]
          .filter(Boolean)
          .join(' ')}
        disabled={!hasPack}
        title="Share a link to this moment"
        aria-expanded={manual !== null}
        aria-controls={manual !== null ? fieldId : undefined}
        onClick={share}
      >
        {compact ? (
          <>
            <Share />
            <span className={styles.srOnly}>{copied ? 'Copied' : 'Share'}</span>
          </>
        ) : (
          // Both words hold the width, so the bar does not shift when one swaps in.
          <span className={styles.label}>
            <span className={copied ? styles.hidden : undefined}>Share</span>
            <span className={copied ? undefined : styles.hidden}>Copied</span>
          </span>
        )}
      </button>
      {manual !== null && (
        <span
          id={fieldId}
          className={styles.panel}
          role="dialog"
          aria-label="Link to this moment"
        >
          <label className={styles.title} htmlFor={`${fieldId}-url`}>
            Copy the link
          </label>
          <input
            id={`${fieldId}-url`}
            ref={input}
            className={styles.field}
            type="text"
            readOnly
            spellCheck={false}
            value={manual}
            onFocus={(e) => e.currentTarget.select()}
          />
        </span>
      )}
    </span>
  );
}
