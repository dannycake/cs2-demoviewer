import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import {
  decalAlpha, EFFECT_KEYS, EFFECTS, EFFECTS_BUDGET, effectsPaths, layoutAtlas, parseMks, placeFrame, selectFrames,
} from '../lib/effects.mjs';

/** An `.mks` as VRF 20.1 writes it: a comment, then `sequence N` blocks of `frame <png> 1` lines. */
function mksText(name, lengths) {
  const lines = ['// Reconstructed with Source 2 Viewer 20.1.0.0 - https://valveresourceformat.github.io', ''];
  lengths.forEach((n, s) => {
    lines.push('', `sequence ${s}`);
    for (let f = 0; f < n; f++) lines.push(`frame ${name}_seq${s}_${f}.png 1`);
  });
  return lines.join('\n') + '\n';
}

/** Parsed `.mks` per source of `effect`: `lengths[i]` frames per sequence of source i (a number = one sequence). */
function fakeSheets(effect, lengths) {
  const out = {};
  effect.sources.forEach((s, i) => {
    const name = path.basename(s.vtex);
    out[s.vtex] = parseMks(mksText(name, [].concat(lengths[i])));
  });
  return out;
}

describe('parseMks', () => {
  test('two sequences of 12 and 11 frames', () => {
    const m = parseMks(mksText('fire_burning_character', [12, 11]));
    expect(m.sequences.length).toBe(2);
    expect(m.sequences.map((s) => s.frames.length)).toEqual([12, 11]);
    expect(m.sequences[0].frames[0]).toBe('fire_burning_character_seq0_0.png');
    expect(m.sequences[1].frames[10]).toBe('fire_burning_character_seq1_10.png');
  });

  test('frames keep the order the file lists them in, not the file names’ order', () => {
    const m = parseMks('sequence 0\nframe a_seq0_10.png 1\nframe a_seq0_2.png 1\n');
    expect(m.sequences[0].frames).toEqual(['a_seq0_10.png', 'a_seq0_2.png']);
  });

  test('a frame before any sequence is an error', () => {
    expect(() => parseMks('frame a.png 1\n')).toThrow(/before any sequence/);
  });
});

describe('layout', () => {
  test('layoutAtlas fills rows of 1024 px', () => {
    expect(layoutAtlas(131, [64, 112])).toEqual({ cols: 16, rows: 9, width: 1024, height: 1008 });
    expect(layoutAtlas(40, [128, 128])).toEqual({ cols: 8, rows: 5, width: 1024, height: 640 });
    expect(layoutAtlas(1, [128, 128])).toEqual({ cols: 8, rows: 1, width: 1024, height: 128 });
  });

  test('placeFrame scales by the sequence’s largest frame and stands it on the cell’s bottom', () => {
    expect(placeFrame(80, 34, 135, 124, [64, 64], 'bottom')).toEqual({ left: 13, top: 48, width: 38, height: 16 });
    expect(placeFrame(80, 34, 135, 124, [64, 64], 'center')).toEqual({ left: 13, top: 24, width: 38, height: 16 });
    expect(placeFrame(135, 124, 135, 124, [64, 64], 'center')).toEqual({ left: 0, top: 3, width: 64, height: 59 });
  });
});

describe('selectFrames', () => {
  test('every 2 over one 80-frame sequence keeps 40 frames from frame 0', () => {
    const effect = EFFECTS.explosion;
    expect(effect.every).toBe(2);
    const sel = selectFrames(effect, fakeSheets(effect, [80]));
    expect(sel.frames.length).toBe(40);
    expect(sel.frames[0].file).toBe('explosion_fireball_01_flame_seq0_0.png');
    expect(sel.frames[1].file).toBe('explosion_fireball_01_flame_seq0_2.png');
    expect(sel.sequences).toEqual([[0, 40]]);
  });

  test('group sequence keeps each authored sequence', () => {
    const effect = EFFECTS.fire;
    const lengths = [[12, 11, 18, 15, 13, 17, 14, 16, 15]];
    const sel = selectFrames(effect, fakeSheets(effect, lengths));
    expect(sel.frames.length).toBe(131);
    expect(sel.sequences.length).toBe(9);
    expect(sel.sequences[0]).toEqual([0, 12]);
    expect(sel.sequences[1]).toEqual([12, 11]);
    expect(sel.sequences[8]).toEqual([116, 15]);
  });

  test('chosen sequences of a source make one atlas sequence; a source without an .mks is one frame', () => {
    const sparks = EFFECTS.sparks;
    const sheets = fakeSheets(sparks, [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]);
    sheets[sparks.sources[1].vtex] = null;
    const sel = selectFrames(sparks, sheets);
    expect(sel.sequences).toEqual([[0, 9], [9, 1]]);
    expect(sel.frames[8].file).toBe('sparks_seq8_0.png');
    expect(sel.frames[9]).toEqual({ vtex: 'materials/effects/spark', file: 'spark.png', sequence: 1 });
  });

  test('blood and the decals group their sources as the table says', () => {
    const blood = EFFECTS.blood;
    const b = selectFrames(blood, fakeSheets(blood, [[1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]]));
    expect(b.sequences).toEqual([[0, 6], [6, 4]]);
    expect(b.frames.map((f) => f.file)).toEqual([
      'headshot_seq0_0.png', 'headshot_seq2_0.png', 'headshot_seq3_0.png', 'headshot_seq4_0.png', 'headshot_seq5_0.png', 'headshot_seq6_0.png',
      'bloodsplatter_seq0_0.png', 'bloodsplatter_seq7_0.png', 'bloodsplatter_seq8_0.png', 'bloodsplatter_seq9_0.png',
    ]);
    const decals = EFFECTS.decals;
    const d = selectFrames(decals, Object.fromEntries(decals.sources.map((s) => [s.vtex, null])));
    expect(d.sequences).toEqual([[0, 4], [4, 3], [7, 3], [10, 3], [13, 6]]);
    expect(d.frames[4].file).toBe('bullethole_metal_1_color_psd_dd6383dc.png');
  });

  test('a sequence the table names that the sheet lacks is an error naming the texture', () => {
    const blood = EFFECTS.blood;
    expect(() => selectFrames(blood, fakeSheets(blood, [[1, 1, 1], [1]]))).toThrow(/headshot.*sequence 3/);
  });
});

describe('the table', () => {
  test('eleven atlases within the 1.5 MB budget together', () => {
    expect(EFFECT_KEYS).toEqual(['fire', 'fireburst', 'explosion', 'smoke', 'dust', 'muzzle', 'flare', 'sparks', 'debris', 'blood', 'decals']);
    expect(EFFECTS_BUDGET).toBe(1_500_000);
    const total = EFFECT_KEYS.reduce((n, k) => n + EFFECTS[k].budget, 0);
    expect(total).toBeLessThanOrEqual(EFFECTS_BUDGET);
    for (const k of EFFECT_KEYS) {
      const e = EFFECTS[k];
      expect(1024 % e.cell[0], k).toBe(0);
      expect(e.sources.length, k).toBeGreaterThan(0);
      for (const s of e.sources) expect(s.vtex, k).toMatch(/^materials\/[a-z0-9_./]+$/);
    }
    expect(Object.isFrozen(EFFECTS.fire.sources[0])).toBe(true);
  });

  test('an opaque decal takes its alpha from how far it is darker than the grey it sits on', () => {
    // Five opaque pixels: three of the neutral grey, one darker, one lighter.
    const px = (v) => [v, v, v, 255];
    const data = Buffer.from([...px(128), ...px(128), ...px(28), ...px(128), ...px(200)]);
    expect(decalAlpha(data)).toBe(true);
    expect([3, 7, 11, 15, 19].map((i) => data[i])).toEqual([0, 0, 255, 0, 0]);
    const cutout = Buffer.from([0, 0, 0, 0, 90, 60, 40, 200]);
    expect(decalAlpha(cutout)).toBe(false);
    expect([cutout[3], cutout[7]]).toEqual([0, 200]);
  });
});

describe('the built atlases', () => {
  const P = effectsPaths();
  const built = !!process.env.CS2_DIR && fs.existsSync(P.manifest);
  test.skipIf(!built)('fire.webp is 1024×1008 and the manifest lists eleven atlases within the budget', async () => {
    const meta = await sharp(path.join(P.out, 'fire.webp')).metadata();
    expect([meta.width, meta.height]).toEqual([1024, 1008]);
    const m = JSON.parse(fs.readFileSync(P.manifest, 'utf8'));
    expect(Object.keys(m.atlases)).toEqual(EFFECT_KEYS);
    const total = Object.values(m.atlases).reduce((n, a) => n + a.bytes, 0);
    expect(total).toBeLessThanOrEqual(1_500_000);
    expect(m.atlases.fire).toMatchObject({ file: 'fire.webp', width: 1024, height: 1008, cell: [64, 112], cols: 16, frames: 131 });
  });
});
