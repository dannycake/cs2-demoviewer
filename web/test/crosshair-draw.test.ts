import { describe, expect, it } from 'vitest';
import {
  drawCrosshair,
  type Draw2D,
} from '../src/components/hud/crosshair-draw';
import type { CrosshairLook } from '../src/sim/crosshair';

/** A context that records the rectangles and arcs it is asked to fill or stroke. */
function recorder() {
  const rects: { x: number; y: number; w: number; h: number; style: string }[] =
    [];
  const arcs: { r: number; width: number; style: string }[] = [];
  const g: Draw2D & {
    fillStyle: string;
    strokeStyle: string;
    lineWidth: number;
  } = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, style: g.fillStyle });
    },
    beginPath() {},
    arc(_x, _y, r) {
      arcs.push({ r, width: g.lineWidth, style: g.strokeStyle });
    },
    stroke() {},
    strokeRect(x, y, w, h) {
      rects.push({ x, y, w, h, style: `stroke ${g.strokeStyle}` });
    },
  };
  return { g, rects, arcs };
}

const cross: CrosshairLook = {
  shape: 'cross',
  gap: 4,
  length: 8,
  thickness: 2,
  color: [0, 255, 0, 255],
  outline: null,
  dot: false,
  tStyle: false,
};

describe('drawCrosshair', () => {
  it('draws four arms from the gap out, centred on the screen centre', () => {
    const r = recorder();
    drawCrosshair(r.g, cross, 100, 100);
    expect(r.rects).toHaveLength(4);
    expect(r.rects).toContainEqual({
      x: 104,
      y: 99,
      w: 8,
      h: 2,
      style: 'rgba(0,255,0,1)',
    });
    expect(r.rects).toContainEqual({
      x: 88,
      y: 99,
      w: 8,
      h: 2,
      style: 'rgba(0,255,0,1)',
    });
    expect(r.rects).toContainEqual({
      x: 99,
      y: 104,
      w: 2,
      h: 8,
      style: 'rgba(0,255,0,1)',
    });
    expect(r.rects).toContainEqual({
      x: 99,
      y: 88,
      w: 2,
      h: 8,
      style: 'rgba(0,255,0,1)',
    });
  });

  it('leaves the top arm out in T style, adds the dot, and outlines under the colour', () => {
    const r = recorder();
    drawCrosshair(
      r.g,
      {
        ...cross,
        tStyle: true,
        dot: true,
        outline: { width: 1, color: [0, 0, 0, 255] },
      },
      100,
      100
    );
    const colour = r.rects.filter((x) => x.style === 'rgba(0,255,0,1)');
    const outline = r.rects.filter((x) => x.style === 'rgba(0,0,0,1)');
    expect(colour).toHaveLength(4); // three arms and the dot
    expect(colour).toContainEqual({
      x: 99,
      y: 99,
      w: 2,
      h: 2,
      style: 'rgba(0,255,0,1)',
    });
    expect(colour.some((x) => x.y < 99)).toBe(false);
    expect(outline).toHaveLength(4);
    // Each outline is the arm grown by its width on every side, drawn first.
    expect(r.rects.indexOf(outline[0])).toBeLessThan(
      r.rects.indexOf(colour[0])
    );
    expect(outline).toContainEqual({
      x: 103,
      y: 98,
      w: 10,
      h: 4,
      style: 'rgba(0,0,0,1)',
    });
  });

  it('draws a circle, a lone dot, a square and four corners for those styles', () => {
    const circle = recorder();
    drawCrosshair(circle.g, { ...cross, shape: 'circle' }, 50, 50);
    expect(circle.arcs).toEqual([{ r: 8, width: 2, style: 'rgba(0,255,0,1)' }]);
    const dot = recorder();
    drawCrosshair(dot.g, { ...cross, shape: 'dot' }, 50, 50);
    expect(dot.rects).toEqual([
      { x: 49, y: 49, w: 2, h: 2, style: 'rgba(0,255,0,1)' },
    ]);
    const square = recorder();
    drawCrosshair(square.g, { ...cross, shape: 'square' }, 50, 50);
    expect(square.rects).toEqual([
      { x: 42, y: 42, w: 16, h: 16, style: 'stroke rgba(0,255,0,1)' },
    ]);
    const quad = recorder();
    drawCrosshair(quad.g, { ...cross, shape: 'quad' }, 50, 50);
    expect(quad.rects).toHaveLength(8);
  });

  it('draws nothing it cannot see', () => {
    const r = recorder();
    drawCrosshair(r.g, { ...cross, color: [0, 255, 0, 0] }, 10, 10);
    expect(r.rects).toEqual([]);
  });
});
