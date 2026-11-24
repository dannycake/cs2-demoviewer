import { describe, expect, it, vi } from 'vitest';
import {
  LABEL_SIZE,
  LabelSprites,
  NAME_EM,
  shortName,
  type LabelCanvas,
} from '../src/scene/labels';

/** Canvases that record the text drawn on them. */
function canvases() {
  const drawn: string[][] = [];
  const make = (width: number, height: number): LabelCanvas => {
    const texts: string[] = [];
    drawn.push(texts);
    const g = {
      clearRect() {},
      fillText(t: string) {
        texts.push(t);
      },
      strokeText() {},
      font: '',
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      textAlign: '',
      textBaseline: '',
      lineJoin: '',
    };
    return { width, height, getContext: () => g };
  };
  return { drawn, make };
}

describe('shortName', () => {
  it('keeps a name of up to 16 characters and cuts a longer one with an ellipsis', () => {
    expect(shortName('Milo')).toBe('Milo');
    expect(shortName('[]VanDeepDarkFantasies[]')).toBe('[]VanDeepDarkFa…');
    expect([...shortName('Мегаанус Калл и ещё кто-то')]).toHaveLength(16);
  });
});

describe('LabelSprites', () => {
  it('draws a label once and hands the same material back for the same content', () => {
    const c = canvases();
    const labels = new LabelSprites(c.make);
    const a = labels.material('SMOKE', 'Milo', '#d8dde3');
    expect(labels.material('SMOKE', 'Milo', '#d8dde3')).toBe(a);
    expect(c.drawn).toEqual([['SMOKE', 'Milo']]);
    expect(labels.material('SMOKE', 'eclipse', '#d8dde3')).not.toBe(a);
    expect(labels.material('FLASH', '', '#fff3b0')).not.toBe(a);
    expect(c.drawn.at(-1)).toEqual(['FLASH']);
    expect(labels.aspect).toBeCloseTo(LABEL_SIZE.width / LABEL_SIZE.height, 9);
  });

  it('frees the least recently used label beyond its capacity, never one just used', () => {
    const labels = new LabelSprites(canvases().make, 2);
    const a = labels.material('A', '', '#fff');
    const b = labels.material('B', '', '#fff');
    const freedA = vi.fn();
    const freedB = vi.fn();
    a.addEventListener('dispose', freedA);
    b.addEventListener('dispose', freedB);
    labels.material('A', '', '#fff'); // A is now the most recent
    labels.material('C', '', '#fff');
    expect(freedB).toHaveBeenCalledTimes(1);
    expect(freedA).not.toHaveBeenCalled();
    labels.dispose();
    expect(freedA).toHaveBeenCalledTimes(1);
  });

  it('sets a name as one line across the middle of a canvas of any size, smaller when it would not fit', () => {
    // Monospaced type: every character is 0.6 of the type's size across.
    const lines: { text: string; font: string; x: number; y: number }[] = [];
    const sizes: [number, number][] = [];
    const make = (width: number, height: number): LabelCanvas => {
      sizes.push([width, height]);
      const g = {
        clearRect() {},
        fillText(text: string, x: number, y: number) {
          lines.push({ text, font: g.font, x, y });
        },
        strokeText() {},
        measureText(t: string) {
          return {
            width: [...t].length * 0.6 * parseInt(/(\d+)px/.exec(g.font)![1]),
          };
        },
        font: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        textAlign: '',
        textBaseline: '',
        lineJoin: '',
      };
      return { width, height, getContext: () => g };
    };
    const labels = new LabelSprites(make, 16, { width: 512, height: 64 });
    expect(labels.aspect).toBe(8);
    labels.material('Milo', '', '#ffffff', 'name');
    labels.material('[]VanDeepDarkFantasies[]', '', '#ffffff', 'name');
    expect(sizes).toEqual([
      [512, 64],
      [512, 64],
    ]);
    const px = (font: string) => parseInt(/(\d+)px/.exec(font)![1]);
    expect(lines[0]).toMatchObject({ text: 'Milo', x: 256, y: 32 });
    expect(px(lines[0].font)).toBe(Math.round(64 * NAME_EM));
    // 24 characters at 48 px would be 691 px across: smaller, to fit.
    expect(lines[1].text).toBe('[]VanDeepDarkFantasies[]');
    expect(24 * 0.6 * px(lines[1].font)).toBeLessThanOrEqual(512);
    expect(px(lines[1].font)).toBeGreaterThan(24);
    // Names are words: Archivo, as the interface sets them.
    expect(lines[0].font).toMatch(/Archivo/);
    expect(lines[0].font).not.toMatch(/Mono/);
  });

  it('sets a grenade label in Archivo, smaller when the word would not fit, and figures in mono', () => {
    const lines: { text: string; font: string }[] = [];
    const make = (width: number, height: number): LabelCanvas => {
      const g = {
        clearRect() {},
        fillText(text: string) {
          lines.push({ text, font: g.font });
        },
        strokeText() {},
        measureText(t: string) {
          return {
            width: [...t].length * 0.6 * parseInt(/(\d+)px/.exec(g.font)![1]),
          };
        },
        font: '',
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 0,
        textAlign: '',
        textBaseline: '',
        lineJoin: '',
      };
      return { width, height, getContext: () => g };
    };
    const labels = new LabelSprites(make);
    labels.material('Smoke', 'Milo', '#d8dde3');
    labels.material('Incendiary', '', '#ff9a3a');
    labels.material('-27', '', '#ffffff', 'mono');
    const px = (font: string) => parseInt(/(\d+)px/.exec(font)![1]);
    expect(lines[0]).toMatchObject({ text: 'Smoke' });
    expect(lines[0].font).toMatch(/^700 44px Archivo/);
    expect(lines[1].font).toMatch(/Archivo/);
    // Ten characters at 44 px would be 264 px across the 256 px label: smaller, to fit.
    const inc = lines.find((l) => l.text === 'Incendiary')!;
    expect(10 * 0.6 * px(inc.font)).toBeLessThanOrEqual(256 - 16);
    expect(lines.at(-1)!.font).toMatch(/JetBrains Mono/);
  });
});
