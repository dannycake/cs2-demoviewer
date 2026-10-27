#!/usr/bin/env node
// node tools/sky.mjs <map>... | all
//
// assets/raw/<map>/sky/sky.exr + sky.json  →  assets/maps/<map>/sky.webp
//
// The sky CS2 draws behind the map (rip-lighting.sh exports it: the material of the first
// enabled env_sky, the map's own or its 3D skybox prefab's, with the env_sky's yaw), as the
// equirect texture the viewer's background samples: 2048×1024, WebP q75, sRGB.
//
// D11 (milestone 2a): the sky textures are BC6H cubes, 256² a face (Nuke) to 2048²
// (Ancient). VRF exports a cube as a 2:1 lat-long EXR, row 0 the zenith, whose column u looks
// along Source azimuth −360°·u; an env_sky turned `yaw` adds it. Measured against each
// light_environment sun this way, Overpass's sun disc and Cache's brightest cloud sit 6° off,
// Inferno's horizon glow 0.4° and Ancient's lighting sky 12°, where a mirror or a quarter turn
// misses by 50° or more. The viewer samples
// with three.js's equirect lookup, u = atan2(z, x) / 2π + 0.5 in glTF space (Source x, y, z
// = glTF z, x, y), which comes out as the same sky rolled by (yaw − 270°) of the width
// (`skyShift`): no mirror, no resampling.
//
// Below the horizon a sky texture holds whatever its author put there (Mirage's sand, Cache's
// dark sea, a mirrored sky on Nuke and Train, a white glare on Anubis, Inferno and Vertigo):
// CS2 never shows it, as the 3D skybox (not exported) covers it, but the viewer's overview
// looks straight into it. So it is replaced by the sky's own horizon colour, the mean of the
// HORIZON_BAND_DEG just above the horizon, which also fades in over the BLEND_DEG above it
// (smoothstep), so there is no line; the viewer gives its fog that colour too (sky.json
// `horizon`, which manifest.mjs copies into the map's manifest).
//
// The values are linear radiance with no fixed scale: CS2's auto exposure meters each scene,
// so a sky's own brightness (`g_flBrightnessExposureBias`, the env_sky's brightnessscale)
// says little about how it reads on screen (as authored, Cache's sky ×4 is white and
// Anubis's ×1.45 clips to cyan, where CS2's screenshots show grey cloud and deep blue). The
// exposure here meters the sky instead: the median luminance of the pixels above the
// horizon comes to SKY_MEDIAN, Mirage's own median (Mirage keeps ×0.99). Against CS2's
// 1080p map screenshots that read right on every map, where a 95th or 99th percentile
// left Anubis and Vertigo dark, and a median weighted by solid angle (which counts the
// bright band at Mirage's horizon more) brightened every other map against Mirage, Train's
// dark overcast and Cache's clouds most. Then everything is clamped at 1 and encoded sRGB.
// The atmosphere's `skyIntensity` scales it again in the viewer.
//
// sky.webp comes with assets/maps/<map>/sky.json { map, material, yaw, from, exposure,
// horizon } (horizon an sRGB '#rrggbb'). A map whose raw sky.json names no material (no
// enabled env_sky) gets neither, and ones left from an earlier build are removed: the viewer
// keeps its colour sky. Each file is written to <file>.tmp-<pid> and renamed into place
// (lib/stage.mjs);
// output is byte-identical across runs.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { readExr } from './lib/exr.mjs';
import { MAPS } from './lib/maps.mjs';
import { paths } from './lib/paths.mjs';
import { writeFileAtomic } from './lib/stage.mjs';

export const SKY_WIDTH = 2048;
export const SKY_HEIGHT = 1024;
export const SKY_QUALITY = 75;
/** The plan's budget for sky.webp (decimal bytes), which check-map.mjs holds every map to. */
export const SKY_MAX_BYTES = 1e6;
/** The median linear luminance above the horizon that a sky is exposed to (Mirage's own). */
export const SKY_MEDIAN = 0.43;
/** Degrees above the horizon whose mean is the sky's horizon colour. */
export const HORIZON_BAND_DEG = 3;
/** Degrees above the horizon over which the sky fades into its horizon colour. */
export const BLEND_DEG = 3;

/** Histogram bins per stop of luminance for the median, and the stops it spans. */
const BINS_PER_STOP = 256;
const MIN_STOP = -24;
const MAX_STOP = 24;

/** Columns to roll VRF's lat-long by for three.js's equirect lookup, `width` wide. */
export function skyShift(yaw, width) {
  const turn = (((yaw - 270) / 360) % 1 + 1) % 1;
  return Math.round(turn * width) % width;
}

/**
 * The exposure that brings the median luminance (Rec. 709) of `exr`'s pixels above the
 * horizon to SKY_MEDIAN, read off a histogram of 1/256-stop bins (to 0.3 %).
 */
export function skyExposure({ width, height, data }) {
  const bins = new Float64Array((MAX_STOP - MIN_STOP) * BINS_PER_STOP);
  const total = width * (height >> 1);
  for (let i = 0; i < total * 4; i += 4) {
    const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    const stop = l > 0 ? Math.log2(l) : MIN_STOP;
    bins[Math.min(bins.length - 1, Math.max(0, Math.floor((stop - MIN_STOP) * BINS_PER_STOP)))]++;
  }
  let seen = 0;
  for (let b = 0; b < bins.length; b++) {
    if (seen + bins[b] >= total / 2) {
      // Where in the bin the half-way weight falls, in stops.
      const f = bins[b] > 0 ? (total / 2 - seen) / bins[b] : 0.5;
      return SKY_MEDIAN / 2 ** (MIN_STOP + (b + f) / BINS_PER_STOP);
    }
    seen += bins[b];
  }
  return 1;
}

/** The elevation in degrees of the centre of lat-long row `y` of `h`. */
const elevationOf = (y, h) => 90 - ((y + 0.5) / h) * 180;

/** 0 at `a`, 1 at `b`, smooth between. */
function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** sRGB encoding of linear `c`, clamped to [0, 1], as a byte. */
function srgbByte(c) {
  const v = c <= 0 ? 0 : c >= 1 ? 1 : c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(v * 255);
}

/**
 * sky.webp from VRF's lat-long `exr` (RGBA float, rows top-down) and the env_sky's `yaw`:
 * exposed (`skyExposure`), averaged down to 2048 wide in linear light when larger (by a
 * whole factor) or scaled up after encoding when smaller, clamped, the horizon colour
 * below the horizon, sRGB, rolled by `skyShift`, WebP q75.
 * @returns {Promise<{ webp: Buffer, exposure: number, horizon: string }>}
 */
export async function buildSky(exr, { yaw }) {
  const { width, height, data } = exr;
  if (width !== height * 2) throw new Error(`the sky is ${width}×${height}; a lat-long sky is 2:1`);
  const exposure = skyExposure(exr);
  // Average k×k blocks when the sky is k times larger than the output.
  const k = width > SKY_WIDTH ? width / SKY_WIDTH : 1;
  if (!Number.isInteger(k)) throw new Error(`the sky is ${width} wide, not a whole multiple of ${SKY_WIDTH}`);
  const w = width / k;
  const h = height / k;
  // Exposed and clamped, in linear light.
  const lin = new Float32Array(w * h * 3);
  const scale = exposure / (k * k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < k; dy++) {
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * width + x * k + dx) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
        }
      }
      const o = (y * w + x) * 3;
      lin[o] = Math.min(1, Math.max(0, r * scale));
      lin[o + 1] = Math.min(1, Math.max(0, g * scale));
      lin[o + 2] = Math.min(1, Math.max(0, b * scale));
    }
  }
  // The horizon colour: the mean of the rows just above the horizon.
  const mean = [0, 0, 0];
  let rows = 0;
  for (let y = 0; y < h; y++) {
    const e = elevationOf(y, h);
    if (e <= 0 || e > HORIZON_BAND_DEG) continue;
    rows++;
    for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) mean[c] += lin[(y * w + x) * 3 + c];
  }
  if (rows === 0) throw new Error(`the sky is ${width}×${height}; too few rows for a horizon band`);
  const horizonLin = mean.map((v) => v / (rows * w));
  const horizonBytes = horizonLin.map(srgbByte);
  const horizon = `#${horizonBytes.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  let rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    // 1 at and below the horizon, fading to 0 BLEND_DEG above it.
    const t = 1 - smoothstep(0, BLEND_DEG, elevationOf(y, h));
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        rgb[o + c] = t >= 1 ? horizonBytes[c] : srgbByte(lin[o + c] + (horizonLin[c] - lin[o + c]) * t);
      }
    }
  }
  if (w !== SKY_WIDTH) {
    rgb = await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
      .resize(SKY_WIDTH, SKY_HEIGHT, { kernel: 'lanczos3' })
      .raw()
      .toBuffer();
  }
  // Column j of the output is column j + shift of VRF's.
  const shift = skyShift(yaw, SKY_WIDTH);
  const rolled = Buffer.alloc(rgb.length);
  const row = SKY_WIDTH * 3;
  for (let y = 0; y < SKY_HEIGHT; y++) {
    const r0 = y * row;
    rgb.copy(rolled, r0, r0 + shift * 3, r0 + row);
    rgb.copy(rolled, r0 + (SKY_WIDTH - shift) * 3, r0, r0 + shift * 3);
  }
  const webp = await sharp(rolled, { raw: { width: SKY_WIDTH, height: SKY_HEIGHT, channels: 3 } })
    .webp({ quality: SKY_QUALITY, effort: 6 })
    .toBuffer();
  return { webp, exposure, horizon };
}

/** exitCode 1 with a message naming what to run. */
class SkyError extends Error {}

function readSkyJson(file, map) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new SkyError(`${file}: ${e.code === 'ENOENT' ? 'missing' : e.message}; run tools/rip-lighting.sh ${map}`);
  }
}

/**
 * Writes assets/maps/<map>/sky.webp and sky.json from the raw sky export, or removes them
 * when the map has no sky. Returns a one-line summary.
 */
export async function skyMap(map) {
  const P = paths(map);
  const skyJson = path.join(P.out, 'sky.json');
  const sky = readSkyJson(path.join(P.rawSky, 'sky.json'), map);
  if (!sky.material) {
    fs.rmSync(P.sky, { force: true });
    fs.rmSync(skyJson, { force: true });
    return `${map}: no enabled env_sky; no sky.webp (the viewer keeps its colour sky)`;
  }
  if (!Number.isFinite(sky.yaw)) throw new SkyError(`${P.rawSky}/sky.json has no yaw; run tools/rip-lighting.sh ${map}`);
  const exrFile = path.join(P.rawSky, 'sky.exr');
  if (!fs.existsSync(exrFile)) throw new SkyError(`${exrFile} is missing; run tools/rip-lighting.sh ${map}`);
  const { webp, exposure, horizon } = await buildSky(readExr(exrFile), { yaw: sky.yaw });
  fs.mkdirSync(P.out, { recursive: true });
  const record = { map, material: sky.material, yaw: sky.yaw, from: sky.from, exposure: Number(exposure.toFixed(4)), horizon };
  // The image first: a sky.json never describes a sky.webp that is not there.
  writeFileAtomic(P.sky, webp);
  writeFileAtomic(skyJson, JSON.stringify(record, null, 2) + '\n');
  return `${map}: sky.webp ${SKY_WIDTH}×${SKY_HEIGHT}, ${webp.length} B (${sky.material}, yaw ${sky.yaw}, from the ${sky.from}; exposure ×${exposure.toFixed(3)}, horizon ${horizon})`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('usage: node tools/sky.mjs <map>... | all');
    process.exit(2);
  }
  const maps = [...new Set(args.flatMap((a) => (a === 'all' ? MAPS : [a])))];
  let failed = 0;
  for (const map of maps) {
    try {
      console.log(await skyMap(map));
    } catch (e) {
      failed++;
      console.error(`sky: ${e instanceof SkyError ? e.message : e.stack ?? e}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

if (isMain(import.meta.url)) await main();
