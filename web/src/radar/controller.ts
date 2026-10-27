// One radar canvas: lays out its panels (the minimap's one square at the shown player's level;
// the full view's one square per level, side by side), draws the frame at the store's tick in
// the next animation frame after any change (once, however many changes come first), and turns
// pointer positions into radar positions for zoom (the wheel or a pinch), pan and picking a
// player. The React component (`components/Radar.tsx`) only wires a canvas and its events to it.

import { nearestWithin } from '../geo/pick';
import type { PlaybackStore } from '../state/store';
import { shownAt } from '../state/store';
import { browserFrames, type FrameScheduler } from '../state/clock';
import { discRadius, drawRadar, type RadarCtx } from './draw';
import { radarFrame, type RadarFrame } from './frame';
import { cropOf, type Crop, type RadarAssets } from './overview';

export type RadarMode = 'mini' | 'full';

/** The parts of a canvas the controller uses. */
export interface RadarCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): RadarCtx | null;
}

/** The full view's zoom range. */
export const ZOOM = { min: 1, max: 4 } as const;

interface Panel {
  /** Canvas pixels. */
  x: number;
  y: number;
  size: number;
  level: number;
  crop: Crop;
}

const defaultDpr = () =>
  typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1;

export class RadarController {
  /** The full view's zoom, 1 to 4. */
  zoom = 1;
  private readonly canvas: RadarCanvas;
  private readonly mode: RadarMode;
  private readonly store: PlaybackStore;
  private readonly frames: FrameScheduler;
  private readonly dpr: () => number;
  private assets: RadarAssets | null = null;
  /** The zoomed crop's centre, radar pixels; null at the whole map. */
  private centre: [number, number] | null = null;
  private cssW = 0;
  private cssH = 0;
  private handle: number | null = null;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(opts: {
    canvas: RadarCanvas;
    mode: RadarMode;
    store: PlaybackStore;
    frames?: FrameScheduler;
    dpr?: () => number;
  }) {
    this.canvas = opts.canvas;
    this.mode = opts.mode;
    this.store = opts.store;
    this.frames = opts.frames ?? browserFrames;
    this.dpr = opts.dpr ?? defaultDpr;
    this.unsubscribe = this.store.subscribe(() => this.invalidate());
  }

  setAssets(a: RadarAssets | null): void {
    this.assets = a;
    this.reset();
  }

  /** The canvas's box in CSS pixels; the drawing buffer follows it in device pixels. */
  resize(cssW: number, cssH: number): void {
    this.cssW = Math.max(0, cssW);
    this.cssH = Math.max(0, cssH);
    const dpr = this.dpr();
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.invalidate();
  }

  /** Draws in the next animation frame (once for any number of calls before it). */
  invalidate(): void {
    if (this.handle !== null || this.disposed) return;
    this.handle = this.frames.request(() => {
      this.handle = null;
      if (!this.disposed) this.draw();
    });
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribe();
    if (this.handle !== null) this.frames.cancel(this.handle);
    this.handle = null;
  }

  /** The frame at the store's tick, or null without a pack or assets. */
  frame(): RadarFrame | null {
    const s = this.store.getState();
    if (!s.pack || !this.assets) return null;
    return radarFrame(s.pack, s.round, s.tick, this.assets.ov, shownAt(s));
  }

  draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const frame = this.frame();
    if (!frame || !this.assets) return;
    const dpr = this.dpr();
    for (const p of this.panels(frame))
      drawRadar(g, frame, this.assets.images[p.level] ?? null, { ...p, dpr });
  }

  /** CSS pixels of radar point (rx, ry) as drawn for `level`, or null with nothing drawn. */
  toScreen(rx: number, ry: number, level: number): [number, number] | null {
    const p = this.panels(this.frame()).find((q) => q.level === level);
    if (!p) return null;
    const k = p.size / p.crop.w;
    const dpr = this.dpr();
    return [
      (p.x + (rx - p.crop.x) * k) / dpr,
      (p.y + (ry - p.crop.y) * k) / dpr,
    ];
  }

  /** The radar point under CSS pixel (x, y), or null off every panel. */
  toRadar(x: number, y: number): [number, number] | null {
    const p = this.panelAt(x, y, this.panels(this.frame()));
    if (!p) return null;
    const dpr = this.dpr();
    const k = p.size / p.crop.w;
    return [p.crop.x + (x * dpr - p.x) / k, p.crop.y + (y * dpr - p.y) / k];
  }

  /**
   * The player whose disc is under CSS pixel (x, y), the nearest when discs overlap. `reach`
   * (CSS pixels) widens a disc's own reach, for a finger (`PICK.radiusPx`).
   */
  pick(x: number, y: number, reach = 0): number | null {
    const frame = this.frame();
    if (!frame) return null;
    const panels = this.panels(frame);
    if (panels.length === 0) return null;
    const dpr = this.dpr();
    const discs: { index: number; x: number; y: number }[] = [];
    for (const p of panels) {
      const k = p.size / p.crop.w;
      for (const pl of frame.players)
        discs.push({
          index: pl.index,
          x: (p.x + (pl.x - p.crop.x) * k) / dpr,
          y: (p.y + (pl.y - p.crop.y) * k) / dpr,
        });
    }
    // Every panel is one size, so one disc reach serves them all.
    const disc = (discRadius(panels[0].size, dpr) * 1.6) / dpr;
    return nearestWithin(discs, x, y, Math.max(disc, reach));
  }

  /** Zooms the full view by `factor` (clamped to 1–4×), keeping the point under (x, y). */
  zoomAt(x: number, y: number, factor: number): void {
    if (!this.assets) return;
    const before = this.toRadar(x, y);
    const p = this.panelAt(x, y, this.panels(this.frame()));
    this.zoom = Math.min(ZOOM.max, Math.max(ZOOM.min, this.zoom * factor));
    if (before && p) {
      const base = cropOf(this.assets.ov);
      const w = base.w / this.zoom;
      const dpr = this.dpr();
      this.centre = [
        before[0] - ((x * dpr - p.x) * w) / p.size + w / 2,
        before[1] - ((y * dpr - p.y) * w) / p.size + w / 2,
      ];
    }
    this.invalidate();
  }

  /** A pinch: the same as `zoomAt`, about the fingers' midpoint (x, y). */
  pinch(factor: number, x: number, y: number): void {
    this.zoomAt(x, y, factor);
  }

  /** Moves the full view's map by (dx, dy) CSS pixels. */
  panBy(dx: number, dy: number): void {
    if (!this.assets) return;
    const p = this.panels(this.frame())[0];
    if (!p) return;
    const k = p.size / p.crop.w;
    const dpr = this.dpr();
    const [cx, cy] = this.centreOf(cropOf(this.assets.ov));
    this.centre = [cx - (dx * dpr) / k, cy - (dy * dpr) / k];
    this.invalidate();
  }

  /** The whole map again. */
  reset(): void {
    this.zoom = 1;
    this.centre = null;
    this.invalidate();
  }

  /** The crop's centre, held inside the whole map at the current zoom. */
  private centreOf(base: Crop): [number, number] {
    const w = base.w / this.zoom;
    const h = base.h / this.zoom;
    const [x, y] = this.centre ?? [base.x + base.w / 2, base.y + base.h / 2];
    const clamp = (v: number, lo: number, span: number, inner: number) =>
      Math.min(lo + span - inner / 2, Math.max(lo + inner / 2, v));
    return [clamp(x, base.x, base.w, w), clamp(y, base.y, base.h, h)];
  }

  private panels(frame: RadarFrame | null): Panel[] {
    if (!this.assets) return [];
    const W = this.canvas.width;
    const H = this.canvas.height;
    const base = cropOf(this.assets.ov);
    if (this.mode === 'mini') {
      const size = Math.min(W, H);
      const shown = frame?.players.find((p) => p.shown);
      return [
        {
          x: (W - size) / 2,
          y: (H - size) / 2,
          size,
          level: shown?.level ?? 0,
          crop: base,
        },
      ];
    }
    const levels = Math.max(1, this.assets.ov.sections.length);
    const size = Math.min(W / levels, H);
    const [cx, cy] = this.centreOf(base);
    const w = base.w / this.zoom;
    const h = base.h / this.zoom;
    const crop = { x: cx - w / 2, y: cy - h / 2, w, h };
    const x0 = (W - size * levels) / 2;
    return Array.from({ length: levels }, (_, level) => ({
      x: x0 + level * size,
      y: (H - size) / 2,
      size,
      level,
      crop,
    }));
  }

  private panelAt(x: number, y: number, panels: Panel[]): Panel | null {
    const dpr = this.dpr();
    const cx = x * dpr;
    const cy = y * dpr;
    return (
      panels.find(
        (p) => cx >= p.x && cx < p.x + p.size && cy >= p.y && cy < p.y + p.size
      ) ?? null
    );
  }
}
