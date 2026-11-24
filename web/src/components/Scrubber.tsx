// A range input across the current round, stepping one sample, with the freeze time shaded
// and its end marked, and the round's events marked along it (kills, the followed player's
// death, plant, defuse, grenades). Dragging seeks; playback carries on if it was playing.
// The round's scale and events are a render; the position (the fill and the input's value)
// is written to the elements, in the frame after it changes.

import { useRef, type CSSProperties } from 'react';
import { timelineFor } from '../sim/timeline';
import { countRender, useDerived, useFrameWriter } from '../state/derive';
import { playbackStore } from '../state/store';
import { markers } from './hud/models';
import { fractionOf, scrubberModel, stepTick } from './scrubber-model';
import styles from './Scrubber.module.css';

export default function Scrubber() {
  countRender('Scrubber');
  // Changes with the round and the followed player, not with the frame.
  const model = useDerived((s) => {
    const info = s.pack?.header.rounds[s.round];
    if (!s.pack || !info) return null;
    const m = scrubberModel(info, s.pack.header.tick_step);
    return {
      m,
      events: markers(timelineFor(s.pack), s.round, s.follow).flatMap((e, i) =>
        e.tick < m.min || e.tick > m.max
          ? []
          : [
              {
                key: `${e.kind}${e.tick}:${i}`,
                kind: e.kind,
                team: e.team ?? 0,
                left: `${fractionOf(m, e.tick) * 100}%`,
              },
            ]
      ),
    };
  }, []);
  const m = model?.m ?? null;
  const fill = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The position, written in the frame after a store change, and only where it changed. The
  // input shows the tick at its step (the browser rounds a value to one) and the fill ends
  // there too, so both move when the position crosses a step. `--pos` is set on the fill, which alone reads it: changed on
  // the scrubber, an inherited custom property would restyle everything under it (the input's
  // slider too).
  useFrameWriter(
    (s) => {
      const f = fill.current;
      const i = input.current;
      if (!m || !f || !i) return;
      const at = stepTick(m, s.tick);
      const pos = `${fractionOf(m, at) * 100}%`;
      if (f.style.getPropertyValue('--pos') !== pos)
        f.style.setProperty('--pos', pos);
      if (i.value !== String(at)) i.value = String(at);
      const text = `tick ${Math.round(s.tick)}`;
      if (i.getAttribute('aria-valuetext') !== text)
        i.setAttribute('aria-valuetext', text);
    },
    [m]
  );

  if (!model || !m) {
    return (
      <div className={styles.scrubber}>
        <input
          className={styles.input}
          type="range"
          disabled
          aria-label="Position in the round"
        />
      </div>
    );
  }

  const vars = {
    '--freeze': `${fractionOf(m, m.freezeEnd) * 100}%`,
    '--end': `${fractionOf(m, m.end) * 100}%`,
  } as CSSProperties;

  return (
    <div className={styles.scrubber} style={vars}>
      <div className={styles.track} aria-hidden="true">
        <div className={styles.freeze} />
        <div ref={fill} className={styles.fill} />
        <div className={styles.marker} title="Freeze time ends" />
        {m.end < m.max && (
          <div className={styles.roundEnd} title="Round decided" />
        )}
        <div className={styles.events}>
          {model.events.map((e) => (
            <i
              key={e.key}
              className={styles.event}
              data-kind={e.kind}
              data-team={e.team}
              style={{ left: e.left }}
            />
          ))}
        </div>
      </div>
      <input
        ref={input}
        className={styles.input}
        type="range"
        min={m.min}
        max={m.max}
        step={m.step}
        aria-label="Position in the round"
        onChange={(e) =>
          playbackStore.getState().seekTick(Number(e.currentTarget.value))
        }
      />
    </div>
  );
}
