// Text labels as sprites: a line of text over a smaller line (or one line of monospaced text,
// left-aligned, or one name filling the canvas), drawn once on a canvas and kept by content, so
// a label that shows every frame costs one cached material. The cache holds
// `capacity` labels (`reserve` raises it) and frees the least recently used one beyond that;
// with fewer labels on screen than that at once, a label in use is never the one freed.

import * as THREE from 'three';

export interface LabelCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): unknown;
}

export type CanvasFactory = (width: number, height: number) => LabelCanvas;

/** The longest name a label shows whole; longer ones end in an ellipsis. */
export const LABEL_NAME_CHARS = 16;

/** `name` cut to `LABEL_NAME_CHARS`, with an ellipsis when cut. */
export function shortName(name: string): string {
  const chars = [...name];
  return chars.length <= LABEL_NAME_CHARS
    ? name
    : `${chars.slice(0, LABEL_NAME_CHARS - 1).join('')}…`;
}

/** Width and height of a label's canvas, in pixels. */
export const LABEL_SIZE = { width: 256, height: 96 } as const;

/**
 * How a label is set: `label` centred in the interface's face over an optional name; `mono` one line of
 * monospaced text from the left edge, its middle `MONO_CENTER_Y` up the canvas; `name` one line
 * centred on the canvas, its type `NAME_EM` of the canvas's height, smaller when the text would
 * not fit across. `label` and `mono` are laid out for `LABEL_SIZE`, `name` for any size.
 */
export type LabelStyle = 'label' | 'mono' | 'name';
/** A `name` label's type size, as a share of its canvas's height. */
export const NAME_EM = 0.75;
/** The interface's one face (styles/global.css), with the system monospace fonts behind it. */
const FACE =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const MONO_FONT = `600 40px ${FACE}`;
/** Where a mono label's line sits, as a sprite `center.y` (0 bottom, 1 top). */
export const MONO_CENTER_Y = 1 - 32 / LABEL_SIZE.height;

function browserCanvas(width: number, height: number): LabelCanvas {
  if (typeof OffscreenCanvas !== 'undefined')
    return new OffscreenCanvas(width, height);
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

/** The 2D drawing calls a label makes. */
interface Draw {
  clearRect(x: number, y: number, w: number, h: number): void;
  fillText(text: string, x: number, y: number): void;
  measureText?(text: string): { width: number };
  strokeText(text: string, x: number, y: number): void;
  font: string;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  textAlign: string;
  textBaseline: string;
  lineJoin: string;
}

/** `text` in one line across the middle of the canvas, as big as `NAME_EM` allows and fits. */
function drawName(
  g: Draw,
  text: string,
  color: string,
  width: number,
  height: number
): void {
  const font = (px: number) => `700 ${px}px ${FACE}`;
  let px = Math.round(height * NAME_EM);
  g.font = font(px);
  // Room for the outline, which reaches px / 12 past each end, and a little more.
  while (
    px > height / 4 &&
    g.measureText &&
    g.measureText(text).width > width - px / 3
  )
    g.font = font((px -= 2));
  g.textAlign = 'center';
  g.lineWidth = px / 6;
  g.strokeText(text, width / 2, height / 2);
  g.fillStyle = color;
  g.fillText(text, width / 2, height / 2);
}

export class LabelSprites {
  private readonly make: CanvasFactory;
  private capacity: number;
  /** Every label's canvas, in pixels. */
  private readonly size: { readonly width: number; readonly height: number };
  /** In use order, oldest first. */
  private readonly cache = new Map<string, THREE.SpriteMaterial>();

  constructor(
    make: CanvasFactory = browserCanvas,
    capacity = 32,
    size: { readonly width: number; readonly height: number } = LABEL_SIZE
  ) {
    this.make = make;
    this.capacity = capacity;
    this.size = size;
  }

  /** The material of a label reading `text` in `color` over `sub` (may be empty). */
  material(
    text: string,
    sub: string,
    color: string,
    style: LabelStyle = 'label'
  ): THREE.SpriteMaterial {
    const key = `${text}\u0000${sub}\u0000${color}\u0000${style}`;
    const have = this.cache.get(key);
    if (have) {
      this.cache.delete(key);
      this.cache.set(key, have);
      return have;
    }
    const { width, height } = this.size;
    const canvas = this.make(width, height);
    const g = canvas.getContext('2d') as Draw | null;
    if (g) {
      g.clearRect(0, 0, width, height);
      g.textBaseline = 'middle';
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0, 0, 0, 0.85)';
    }
    if (g && style === 'name') drawName(g, text, color, width, height);
    else if (g) {
      const mono = style === 'mono';
      g.textAlign = mono ? 'left' : 'center';
      g.font = mono ? MONO_FONT : `700 44px ${FACE}`;
      g.lineWidth = mono ? 7 : 8;
      const x = mono ? 6 : width / 2;
      g.strokeText(text, x, 32);
      g.fillStyle = color;
      g.fillText(text, x, 32);
      if (sub && !mono) {
        const name = shortName(sub);
        // Smaller type for a name that would not fit across the label.
        let px = 26;
        for (; px > 14; px -= 2) {
          g.font = `500 ${px}px ${FACE}`;
          if (!g.measureText || g.measureText(name).width <= width - 12) break;
        }
        g.lineWidth = 6;
        g.strokeText(name, width / 2, 74);
        g.fillStyle = '#ffffff';
        g.fillText(name, width / 2, 74);
      }
    }
    const map = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    map.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.SpriteMaterial({
      map,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.cache.set(key, m);
    while (this.cache.size > this.capacity) {
      const [oldest, gone] = this.cache.entries().next().value!;
      this.cache.delete(oldest);
      gone.map?.dispose();
      gone.dispose();
    }
    return m;
  }

  /** Holds at least `n` labels from now on: room for every label on screen at once. */
  reserve(n: number): void {
    if (n > this.capacity) this.capacity = n;
  }

  /** Width over height of every label. */
  get aspect(): number {
    return this.size.width / this.size.height;
  }

  dispose(): void {
    for (const m of this.cache.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.cache.clear();
  }
}
