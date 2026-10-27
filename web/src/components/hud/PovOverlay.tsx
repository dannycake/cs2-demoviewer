// First person, over the scene: the followed player's own crosshair (decoded from their share
// code, at the size they set it for their screen height), or the scope's lens when they are
// scoped in. Nothing in the other cameras.

import { useEffect, useMemo, useRef } from 'react';
import { crosshairLook, decodeCrosshair } from '../../sim/crosshair';
import { countRender, useDerived } from '../../state/derive';
import { shownAt } from '../../state/store';
import { drawCrosshair } from './crosshair-draw';
import { povOverlay, sameOverlay } from './pov';
import styles from './hud.module.css';

function Crosshair({ code }: { code: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const decoded = useMemo(() => (code ? decodeCrosshair(code) : null), [code]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(c.clientWidth * dpr));
      const h = Math.max(1, Math.round(c.clientHeight * dpr));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      const g = c.getContext('2d');
      if (!g) return;
      g.clearRect(0, 0, w, h);
      drawCrosshair(g, crosshairLook(decoded, h), w / 2, h / 2);
    };
    draw();
    const ro =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(draw);
    ro?.observe(c);
    return () => ro?.disconnect();
  }, [decoded]);

  return (
    <canvas ref={canvas} className={styles.crosshair} aria-hidden="true" />
  );
}

export default function PovOverlay() {
  countRender('PovOverlay');
  // Renders only when the overlay changes (scoped in or out, someone else shown).
  const overlay = useDerived(
    (s) =>
      povOverlay({
        pack: s.pack,
        round: s.round,
        tick: s.tick,
        camera: s.camera,
        follow: shownAt(s),
      }),
    [],
    sameOverlay
  );
  if (overlay.kind === 'crosshair') return <Crosshair code={overlay.code} />;
  if (overlay.kind === 'scope')
    return (
      <div
        className={styles.scope}
        data-zoom={overlay.zoom}
        aria-hidden="true"
      />
    );
  return null;
}
