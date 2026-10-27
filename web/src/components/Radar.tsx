// The radar (radar/): `mini` is the corner map at the top of the HUD's left column, a button that
// opens the full view; `full` fills the viewport in place of the 3D view, with wheel zoom about
// the cursor, drag to pan, double-click to reset and a click on a player to follow them; on a
// touch screen a two-finger pinch zooms, one finger pans, and a tap follows the player whose
// disc is within a finger's reach (`PICK`). A press that closed an open panel only closes it.
// Both draw through a `RadarController`, which redraws from the store; React renders this once.
// A map without a radar (no assets, or an overview that does not load) shows no minimap.

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { PICK } from '../geo/pick';
import { RadarController, type RadarMode } from '../radar/controller';
import { loadRadar, type RadarAssets } from '../radar/overview';
import { isDismissal } from '../state/dismiss';
import { playbackStore, usePlayback } from '../state/store';
import styles from './Radar.module.css';

/**
 * One load per map, shared by the minimap and the full view; a load that came to nothing is
 * forgotten, so the next mount tries again.
 */
const loads = new Map<string, Promise<RadarAssets | null>>();

function radarFor(map: string): Promise<RadarAssets | null> {
  let p = loads.get(map);
  if (!p) {
    p = loadRadar(map).then((a) => {
      if (!a) loads.delete(map);
      return a;
    });
    loads.set(map, p);
  }
  return p;
}

/** A press that moves less than this (CSS pixels) is a click, not a drag. */
const CLICK_SLOP = 4;
/** A finger's slop is a tap's (`PICK.tapPx`); the mouse's and a pen's, `CLICK_SLOP`. */
const slopOf = (e: { pointerType: string }) =>
  e.pointerType === 'touch' ? PICK.tapPx : CLICK_SLOP;
/** Zoom per wheel notch. */
const WHEEL_STEP = 1.2;

export default function Radar({ mode }: { mode: RadarMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctl = useRef<RadarController | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  /**
   * The press since the first pointer went down: how far it moved, whether it was a gesture
   * (it pinched, or was cancelled), which picks nobody, and its first `pointerdown`, which may
   * have closed a panel (`state/dismiss`) and then picks nobody either.
   */
  const press = useRef<{
    moved: number;
    gesture: boolean;
    down: Event;
  } | null>(null);
  const map = usePlayback((s) => s.map);
  const missing = usePlayback((s) => s.assetsMissing);
  /** Null once a load came to nothing (no overview, an image that failed). */
  const [assets, setAssets] = useState<RadarAssets | null | 'loading'>(
    'loading'
  );
  const ready = assets !== null && assets !== 'loading';

  useEffect(() => {
    if (!map || missing) {
      setAssets(null);
      return;
    }
    setAssets('loading');
    let live = true;
    void radarFor(map).then((a) => {
      if (live) setAssets(a);
    });
    return () => {
      live = false;
    };
  }, [map, missing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const c = new RadarController({ canvas, mode, store: playbackStore });
    ctl.current = c;
    const box = () => {
      const r = canvas.getBoundingClientRect();
      c.resize(r.width, r.height);
    };
    const ro = new ResizeObserver(box);
    ro.observe(canvas);
    box();
    return () => {
      ro.disconnect();
      c.dispose();
      ctl.current = null;
    };
  }, [mode]);

  useEffect(() => {
    ctl.current?.setAssets(ready ? assets : null);
  }, [assets, ready]);

  const name = ready ? assets.ov.map.replace(/^de_/, '') : 'the map';

  if (mode === 'mini')
    return (
      <button
        type="button"
        className={styles.mini}
        hidden={!ready}
        title="Radar: open the full view (R)"
        aria-label={`Radar of ${name}: open the full view (R)`}
        onClick={() => playbackStore.getState().setRadar(true)}
      >
        <canvas ref={canvasRef} className={styles.canvas} />
      </button>
    );

  const at = (e: { clientX: number; clientY: number }) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top] as const;
  };
  // Pointers down on the canvas, where each was last. One pans once it has moved past the
  // slop; two pinch (the first two down), zooming about their midpoint and panning with it.
  // A press that was a gesture, or moved past the slop, picks nobody when the last one lifts.
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ps = pointers.current;
    ps.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ps.size === 1)
      press.current = { moved: 0, gesture: false, down: e.nativeEvent };
    else if (press.current) press.current.gesture = true;
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    const ps = pointers.current;
    const p = ps.get(e.pointerId);
    const pr = press.current;
    if (!p || !pr) return;
    const [a, b] = ps.values();
    if (b && (p === a || p === b)) {
      const d0 = Math.hypot(a.x - b.x, a.y - b.y);
      const m0 = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      p.x = e.clientX;
      p.y = e.clientY;
      const d1 = Math.hypot(a.x - b.x, a.y - b.y);
      const m1 = { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 };
      const c = ctl.current;
      c?.panBy(m1.clientX - m0.clientX, m1.clientY - m0.clientY);
      if (d0 > 0 && d1 > 0) c?.pinch(d1 / d0, ...at(m1));
      return;
    }
    if (b) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    pr.moved += Math.hypot(dx, dy);
    p.x = e.clientX;
    p.y = e.clientY;
    if (pr.gesture || pr.moved >= slopOf(e)) ctl.current?.panBy(dx, dy);
  };
  const up = (e: PointerEvent<HTMLCanvasElement>) => {
    const ps = pointers.current;
    if (!ps.delete(e.pointerId) || ps.size > 0) return;
    const pr = press.current;
    press.current = null;
    if (!pr || pr.gesture || pr.moved >= slopOf(e) || isDismissal(pr.down))
      return;
    const [x, y] = at(e);
    const touch = e.pointerType === 'touch';
    const i = ctl.current?.pick(x, y, touch ? PICK.radiusPx : 0) ?? null;
    if (i !== null) playbackStore.getState().setFollow(i);
  };
  const cancel = (e: PointerEvent<HTMLCanvasElement>) => {
    const ps = pointers.current;
    ps.delete(e.pointerId);
    if (press.current) press.current.gesture = true;
    if (ps.size === 0) press.current = null;
  };

  return (
    <div className={styles.full}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        aria-label={`Radar of ${name}. Wheel or pinch to zoom, drag to pan, click or tap a player to follow them.`}
        onWheel={(e) => {
          const [x, y] = at(e);
          ctl.current?.zoomAt(x, y, e.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP);
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={cancel}
        onDoubleClick={() => ctl.current?.reset()}
      />
      {!ready && (
        <p className={styles.none} role="status">
          {assets === 'loading'
            ? 'Loading the radar'
            : 'This map has no radar.'}
        </p>
      )}
    </div>
  );
}
