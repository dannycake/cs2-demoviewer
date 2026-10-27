import { Document } from '@gltf-transform/core';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { bakeTint, tintMaskPng } from '../lib/tint.mjs';

const png = (w, h, rgba) =>
  sharp(Buffer.from(rgba), { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
const gray = (w, h, values) =>
  sharp(Buffer.from(values), { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();

describe('bakeTint', () => {
  it('tints only where the mask is set, in linear light, keeping alpha', async () => {
    // Two white pixels: the left masked, the right not.
    const color = await png(2, 1, [255, 255, 255, 200, 255, 255, 255, 100]);
    const mask = await gray(2, 1, [255, 0]);
    const out = await bakeTint(color, mask, [0.25, 0.5, 1]);
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    // linear 0.25 → sRGB 137, 0.5 → 188, 1 → 255.
    expect([...data.subarray(0, 4)]).toEqual([137, 188, 255, 200]);
    expect([...data.subarray(4, 8)]).toEqual([255, 255, 255, 100]);
  });

  it('scales a mask of another size to the colour texture', async () => {
    const color = await png(4, 4, new Array(16).fill([255, 255, 255, 255]).flat());
    const mask = await gray(2, 2, [255, 255, 255, 255]);
    const out = await bakeTint(color, mask, [0, 0, 0]);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(4);
    expect(data[0]).toBe(0);
  });
});

describe('tintMaskPng', () => {
  const material = (int, tex, factor) => {
    const m = new Document().createMaterial('m').setBaseColorFactor(factor);
    m.setExtras({ vmat: { IntParams: int, TextureParams: tex } });
    return m;
  };
  it("names a tinted material's mask image in the raw folder", () => {
    const m = material({ F_TINT_MASK: 1 }, { g_tTintMask: 'metal_door_001_mask_psd_1.vtex' }, [0.85, 0.45, 0.05, 1]);
    expect(tintMaskPng(m, '/raw/de_nuke')).toBe('/raw/de_nuke/metal_door_001_mask_psd_1.png');
  });
  it('is null without the mask flag, without a mask, or with no tint to apply', () => {
    expect(tintMaskPng(material({}, { g_tTintMask: 'a.vtex' }, [0.5, 0.5, 0.5, 1]), '/r')).toBeNull();
    expect(tintMaskPng(material({ F_TINT_MASK: 1 }, {}, [0.5, 0.5, 0.5, 1]), '/r')).toBeNull();
    expect(tintMaskPng(material({ F_TINT_MASK: 1 }, { g_tTintMask: 'a.vtex' }, [1, 1, 1, 1]), '/r')).toBeNull();
  });
});
