// The flash whiteout: the screen goes white while the followed player is blind, in POV, held
// for the first 40 % of the blindness and then fading (`sim/impacts.ts`). Whether it shows is
// a render; how white is written to the element every frame.

import { useRef } from 'react';
import { timelineFor } from '../../sim/timeline';
import { countRender, useDerived, useFrameWriter } from '../../state/derive';
import { shownAt, type Playback } from '../../state/store';
import { whiteoutAlpha } from './models';
import styles from './hud.module.css';

function alphaOf(s: Playback): number {
  return s.pack
    ? whiteoutAlpha(timelineFor(s.pack), s.round, s.tick, shownAt(s), s.camera)
    : 0;
}

export default function Whiteout() {
  countRender('Whiteout');
  const shown = useDerived((s) => alphaOf(s) > 0, []);
  const el = useRef<HTMLDivElement>(null);
  // Taken again when it shows, so the element has its opacity before it is first painted.
  useFrameWriter(
    (s) => {
      if (shown && el.current) el.current.style.opacity = String(alphaOf(s));
    },
    [shown]
  );
  if (!shown) return null;
  return (
    <div
      ref={el}
      className={styles.whiteout}
      data-testid="whiteout"
      aria-hidden="true"
    />
  );
}
