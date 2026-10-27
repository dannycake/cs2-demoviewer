// Spike: irradiance.exr -> sRGB PNG previews for viewer.html's lm= mode.
//   node tools/spike/lightmap/preview.mjs <map> <size>... [--scale S] [--channel shadow]
// Box-downscales 8192 -> <size> and writes assets/spike/lm/<map>/irr_<size>.png holding
// sRGB(irradiance / S) (default S = 4), so the viewer needs lmscale=S. --channel shadow writes
// direct_light_shadows.png downscaled instead (shadow_<size>.png).
import path from 'node:path';
import sharp from 'sharp';
import { readExr } from './exr.mjs';

const args = process.argv.slice(2);
const map = args[0];
const scale = args.includes('--scale') ? Number(args[args.indexOf('--scale') + 1]) : 4;
const sizes = args.slice(1).filter((a, i, all) => /^\d+$/.test(a) && all[i] !== String(scale)).map(Number);
const base = path.join('assets/spike/lm', map);
const dir = path.join(base, 'maps', map, 'lightmaps');
const srgb = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

if (args.includes('--channel')) {
  for (const size of sizes) {
    const out = path.join(base, `shadow_${size}.png`);
    await sharp(path.join(dir, 'direct_light_shadows.png')).resize(size, size, { kernel: 'cubic' }).png().toFile(out);
    console.log(out);
  }
} else {
  const { width, data } = readExr(path.join(dir, 'irradiance.exr'));
  for (const size of sizes) {
    const k = width / size, img = Buffer.alloc(size * size * 3);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) { const o = 4 * ((y * k + j) * width + x * k + i); r += data[o]; g += data[o + 1]; b += data[o + 2]; }
      const n = k * k * scale, o = 3 * (y * size + x);
      img[o] = Math.round(255 * srgb(Math.min(1, r / n))); img[o + 1] = Math.round(255 * srgb(Math.min(1, g / n))); img[o + 2] = Math.round(255 * srgb(Math.min(1, b / n)));
    }
    const out = path.join(base, `irr_${size}.png`);
    await sharp(img, { raw: { width: size, height: size, channels: 3 } }).png({ compressionLevel: 3 }).toFile(out);
    console.log(out);
  }
}
