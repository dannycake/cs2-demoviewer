// Tint masks. A csgo_complex material with F_TINT_MASK tints its colour only where its tint
// mask (g_tTintMask) is set: a door painted yellow keeps its grey hinges and dark seals.
// VRF exports the tint as the material's baseColorFactor, which multiplies the whole texture,
// so on Nuke a third of the materials came out solid black, solid orange or flat dark red.
// shrink-map.mjs bakes the tint into the colour through the mask and resets the factor.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

/** The mask image of a material that needs its tint baked, or null. */
export function tintMaskPng(material, rawDir) {
  const v = material.getExtras()?.vmat;
  if (!v?.IntParams?.F_TINT_MASK) return null;
  const vtex = v.TextureParams?.g_tTintMask;
  if (typeof vtex !== 'string' || !vtex) return null;
  const f = material.getBaseColorFactor();
  if (f.slice(0, 3).every((x) => Math.abs(x - 1) < 1e-3)) return null;
  return path.join(rawDir, path.basename(vtex).replace(/\.vtex$/, '.png'));
}

/** Whether `tintMaskPng`'s image is on disk. */
export const hasMask = (file) => !!file && fs.existsSync(file);

/** sRGB (0..1) to linear light. */
export const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toSrgb = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * `color` (an image) with `tint` (linear RGB, the material's factor) multiplied in where
 * `mask` (an image; its first channel, scaled to the colour's size) is set:
 * `linear(c) · mix(1, tint, mask)`, alpha kept. Returns a PNG.
 */
export async function bakeTint(color, mask, tint) {
  const { data, info } = await sharp(color)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const m = await sharp(mask)
    .extractChannel(0)
    .resize(info.width, info.height, { fit: 'fill' })
    .raw()
    .toBuffer();
  const lut = new Float64Array(256);
  for (let i = 0; i < 256; i++) lut[i] = toLinear(i / 255);
  const out = Buffer.alloc(data.length);
  for (let p = 0, q = 0; q < m.length; p += 4, q++) {
    const k = m[q] / 255;
    for (let c = 0; c < 3; c++) {
      const v = lut[data[p + c]] * (1 + (tint[c] - 1) * k);
      out[p + c] = Math.round(toSrgb(Math.min(1, Math.max(0, v))) * 255);
    }
    out[p + 3] = data[p + 3];
  }
  return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
    .png()
    .toBuffer();
}
