// Draws a crosshair (`sim/crosshair.ts` `CrosshairLook`, in device pixels) on a 2D canvas at a
// point: the outline first, then the colour, snapped to whole pixels so a 1 px line stays sharp.

import type { CrosshairLook, Rgba } from '../../sim/crosshair';

/** The canvas calls the drawing uses. */
export interface Draw2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  arc(x: number, y: number, r: number, start: number, end: number): void;
  stroke(): void;
}

const css = ([r, g, b, a]: Rgba) =>
  `rgba(${r},${g},${b},${+(a / 255).toFixed(3)})`;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The rectangles of the look's shape at (`cx`, `cy`), before any outline. */
function rectsOf(l: CrosshairLook, cx: number, cy: number): Rect[] {
  const t = Math.max(1, Math.round(l.thickness));
  const len = Math.round(l.length);
  const gap = Math.round(l.gap);
  const half = Math.floor(t / 2);
  const out: Rect[] = [];
  if (l.shape === 'cross') {
    if (len > 0) {
      out.push({ x: cx + gap, y: cy - half, w: len, h: t });
      out.push({ x: cx - gap - len, y: cy - half, w: len, h: t });
      out.push({ x: cx - half, y: cy + gap, w: t, h: len });
      if (!l.tStyle)
        out.push({ x: cx - half, y: cy - gap - len, w: t, h: len });
    }
  } else if (l.shape === 'quad') {
    // Four corner brackets around the gap, each arm half the length.
    const r = Math.max(gap, 1) + len;
    const arm = Math.max(1, Math.round(len / 2));
    for (const sx of [-1, 1])
      for (const sy of [-1, 1]) {
        const x = sx > 0 ? cx + r - t : cx - r;
        const y = sy > 0 ? cy + r - t : cy - r;
        out.push({ x: sx > 0 ? cx + r - arm : cx - r, y, w: arm, h: t });
        out.push({ x, y: sy > 0 ? cy + r - arm : cy - r, w: t, h: arm });
      }
  }
  if (l.dot || l.shape === 'dot')
    out.push({ x: cx - half, y: cy - half, w: t, h: t });
  return out;
}

export function drawCrosshair(
  g: Draw2D,
  l: CrosshairLook,
  centreX: number,
  centreY: number
): void {
  if (l.color[3] <= 0) return;
  const cx = Math.round(centreX);
  const cy = Math.round(centreY);
  const colour = css(l.color);
  if (l.shape === 'circle' || l.shape === 'square') {
    const t = Math.max(1, Math.round(l.thickness));
    const r = Math.max(1, Math.round(l.gap + l.length / 2));
    const outline = l.outline;
    const draw = (style: string, width: number) => {
      g.strokeStyle = style;
      g.lineWidth = width;
      if (l.shape === 'circle') {
        g.beginPath();
        g.arc(cx, cy, r, 0, Math.PI * 2);
        g.stroke();
      } else g.strokeRect(cx - r, cy - r, 2 * r, 2 * r);
    };
    if (outline) draw(css(outline.color), t + 2 * outline.width);
    draw(colour, t);
    if (l.dot) {
      const half = Math.floor(t / 2);
      g.fillStyle = colour;
      g.fillRect(cx - half, cy - half, t, t);
    }
    return;
  }
  const rects = rectsOf(l, cx, cy);
  if (l.outline) {
    const w = l.outline.width;
    g.fillStyle = css(l.outline.color);
    for (const r of rects)
      g.fillRect(r.x - w, r.y - w, r.w + 2 * w, r.h + 2 * w);
  }
  g.fillStyle = colour;
  for (const r of rects) g.fillRect(r.x, r.y, r.w, r.h);
}
