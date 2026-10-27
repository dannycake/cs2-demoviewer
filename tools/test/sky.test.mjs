// sky.mjs: CS2's sky as the viewer's equirect sky.webp. The lat-long EXR VRF exports from a
// sky cube puts Source azimuth −360°·u at column u (D11, from the sun on Overpass, Ancient,
// Cache and Inferno against their light_environment); an env_sky turned `yaw` adds it. The
// viewer samples sky.webp with three.js's equirect lookup, u = atan2(z, x) / 2π + 0.5, in
// glTF space, where Source (x, y, z) is glTF (y, z, x).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSky,
  skyExposure,
  skyMap,
  skyShift,
  HORIZON_BAND_DEG,
  SKY_HEIGHT,
  SKY_MEDIAN,
  SKY_WIDTH,
} from '../sky.mjs';

// skyMap reads the EXR through lib/exr.mjs: a test sky stands in for the file.
const readExr = vi.hoisted(() => vi.fn());
vi.mock('../lib/exr.mjs', () => ({ readExr }));

/** A lat-long sky `w`×`h` (RGBA float, rows top-down): `up` above the horizon, `down` below. */
function sky(w, h, up, down = 0.05) {
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = y < h / 2 ? up : down;
      data.set([v, v, v, 1], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

/** Lights the column at Source texture azimuth `az` degrees, above the horizon. */
function lightAzimuth(exr, az, value = 8) {
  const u = (((-az / 360) % 1) + 1) % 1;
  const x = Math.floor(u * exr.width);
  for (let y = 0; y < exr.height / 2; y++) exr.data.fill(value, (y * exr.width + x) * 4, (y * exr.width + x) * 4 + 3);
}

/** three.js's equirect u of the Source world azimuth `az` degrees, on the horizon. */
function threeU(az) {
  const a = (az * Math.PI) / 180;
  // Source (cos a, sin a, 0) is glTF (sin a, 0, cos a).
  const [x, z] = [Math.sin(a), Math.cos(a)];
  return Math.atan2(z, x) / (2 * Math.PI) + 0.5;
}

/** The brightest column of row `y` of the decoded sky.webp. */
async function brightestColumn(webp, y) {
  const { data, info } = await sharp(webp).raw().toBuffer({ resolveWithObject: true });
  let best = -1;
  let at = -1;
  for (let x = 0; x < info.width; x++) {
    const v = data[(y * info.width + x) * info.channels + 1];
    if (v > best) [best, at] = [v, x];
  }
  return { at, best, info };
}

/** Columns between two u's on the ring of `w` columns. */
const ringDistance = (a, b, w) => Math.min(Math.abs(a - b), w - Math.abs(a - b));

describe('skyShift', () => {
  it('rolls by (yaw − 270°) of the width, on a ring', () => {
    expect(skyShift(270, 2048)).toBe(0);
    expect(skyShift(0, 2048)).toBe(512);
    expect(skyShift(90, 2048)).toBe(1024);
    expect(skyShift(-90, 2048)).toBe(0);
    expect(skyShift(244.999985, 2048)).toBe(1906);
  });
});

describe('skyExposure', () => {
  it('brings the median of the sky above the horizon to SKY_MEDIAN, whatever is below it', () => {
    expect(skyExposure(sky(64, 32, 0.2, 9))).toBeCloseTo(SKY_MEDIAN / 0.2, 2);
    expect(skyExposure(sky(64, 32, 4))).toBeCloseTo(SKY_MEDIAN / 4, 2);
  });

  it('counts every pixel above the horizon once, wherever it is', () => {
    // 6 of the 16 rows above the horizon at 2, at the zenith or at the horizon: the median
    // stays 0.2; 10 of them, it is 2.
    for (const rows of [[0, 6], [10, 16]]) {
      const s = sky(64, 32, 0.2);
      for (let y = rows[0]; y < rows[1]; y++) s.data.fill(2, y * 64 * 4, (y + 1) * 64 * 4);
      expect(skyExposure(s)).toBeCloseTo(SKY_MEDIAN / 0.2, 2);
    }
    const most = sky(64, 32, 0.2);
    most.data.fill(2, 0, 10 * 64 * 4);
    expect(skyExposure(most)).toBeCloseTo(SKY_MEDIAN / 2, 2);
  });
});

describe('skyMap', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-test-'));
    vi.stubEnv('ASSETS_DIR', root);
    readExr.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const raw = (json) => {
    fs.mkdirSync(path.join(root, 'raw', 'de_mirage', 'sky'), { recursive: true });
    fs.writeFileSync(path.join(root, 'raw', 'de_mirage', 'sky', 'sky.json'), JSON.stringify(json));
  };
  const out = (f) => path.join(root, 'maps', 'de_mirage', f);

  it('writes sky.webp and sky.json (material, yaw, exposure, horizon) from the raw export', async () => {
    raw({ map: 'de_mirage', material: 'materials/skybox/sky_de_mirage.vmat', yaw: 0, from: 'map' });
    fs.writeFileSync(path.join(root, 'raw', 'de_mirage', 'sky', 'sky.exr'), 'stand-in');
    readExr.mockReturnValue(sky(2048, 1024, 0.2));
    expect(await skyMap('de_mirage')).toMatch(/^de_mirage: sky\.webp 2048×1024, \d+ B/);
    expect(readExr).toHaveBeenCalledWith(path.join(root, 'raw', 'de_mirage', 'sky', 'sky.exr'));
    expect((await sharp(out('sky.webp')).metadata()).width).toBe(SKY_WIDTH);
    const json = JSON.parse(fs.readFileSync(out('sky.json'), 'utf8'));
    expect(json).toMatchObject({ map: 'de_mirage', material: 'materials/skybox/sky_de_mirage.vmat', yaw: 0, from: 'map' });
    expect(json.exposure).toBeCloseTo(SKY_MEDIAN / 0.2, 2);
    expect(json.horizon).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('removes a stale sky.webp and sky.json when the map has no enabled env_sky', async () => {
    raw({ map: 'de_mirage', material: null });
    fs.mkdirSync(path.dirname(out('sky.webp')), { recursive: true });
    fs.writeFileSync(out('sky.webp'), 'old');
    fs.writeFileSync(out('sky.json'), '{}');
    expect(await skyMap('de_mirage')).toMatch(/no enabled env_sky/);
    expect(fs.existsSync(out('sky.webp'))).toBe(false);
    expect(fs.existsSync(out('sky.json'))).toBe(false);
    expect(readExr).not.toHaveBeenCalled();
  });

  it('names what to run when the raw export is missing, or lacks the EXR or the yaw', async () => {
    await expect(skyMap('de_mirage')).rejects.toThrow(/sky\.json: missing; run tools\/rip-lighting\.sh de_mirage/);
    raw({ map: 'de_mirage', material: 'materials/skybox/sky_de_mirage.vmat', yaw: 0 });
    await expect(skyMap('de_mirage')).rejects.toThrow(/sky\.exr is missing; run tools\/rip-lighting\.sh de_mirage/);
    raw({ map: 'de_mirage', material: 'materials/skybox/sky_de_mirage.vmat' });
    await expect(skyMap('de_mirage')).rejects.toThrow(/has no yaw; run tools\/rip-lighting\.sh de_mirage/);
    expect(fs.existsSync(out('sky.webp'))).toBe(false);
  });
});

describe('buildSky', () => {
  it('writes a 2048×1024 WebP exposed to SKY_MEDIAN, sRGB, clamped at white', async () => {
    const s = sky(2048, 1024, 0.2, 9);
    // A band at 9 high in the sky: clamped.
    s.data.fill(9, 100 * 2048 * 4, 110 * 2048 * 4);
    const out = await buildSky(s, { yaw: 0 });
    expect(out.exposure).toBeCloseTo(SKY_MEDIAN / 0.2, 2);
    const meta = await sharp(out.webp).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', SKY_WIDTH, SKY_HEIGHT]);
    const { data, info } = await sharp(out.webp).raw().toBuffer({ resolveWithObject: true });
    const at = (y) => data[(y * info.width + 100) * info.channels];
    // 0.43 linear is sRGB 0.68 (175); 9 × 2.15 clamps to 255.
    expect(at(300)).toBeGreaterThanOrEqual(172);
    expect(at(300)).toBeLessThanOrEqual(177);
    expect(at(105)).toBe(255);
  });

  it("fills the sky below the horizon with its horizon colour, blended over a few degrees", async () => {
    // Above: 0.2 grey, but the band just over the horizon is blue; below: a bright white.
    const s = sky(2048, 1024, 0.2, 9);
    const band = Math.ceil((HORIZON_BAND_DEG / 180) * 1024);
    for (let y = 512 - band; y < 512; y++) {
      for (let x = 0; x < 2048; x++) s.data.set([0.05, 0.1, 0.4], (y * 2048 + x) * 4);
    }
    const out = await buildSky(s, { yaw: 0 });
    const e = out.exposure;
    const enc = (c) => {
      const v = Math.min(1, c * e);
      return Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
    };
    const want = [enc(0.05), enc(0.1), enc(0.4)];
    expect(out.horizon).toBe(`#${want.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
    const { data, info } = await sharp(out.webp).raw().toBuffer({ resolveWithObject: true });
    const px = (y) => [0, 1, 2].map((c) => data[(y * info.width + 700) * info.channels + c]);
    const rowAt = (deg) => Math.floor(((90 - deg) / 180) * 1024);
    // Well below the horizon: the horizon colour, never the white.
    for (const deg of [-10, -45, -89]) {
      px(rowAt(deg)).forEach((v, c) => expect(Math.abs(v - want[c])).toBeLessThanOrEqual(4));
    }
    // The sky above the blend is left alone.
    expect(px(rowAt(30))[0]).toBeGreaterThanOrEqual(172);
    // In the blend, between the two, with no step of more than a few levels a row.
    let worst = 0;
    for (let y = rowAt(2); y < rowAt(-5); y++)
      for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px(y + 1)[c] - px(y)[c]));
    expect(worst).toBeLessThanOrEqual(24);
  });

  it("turns the sky so a feature at Source azimuth A under an env_sky of yaw Y shows at A + Y in the viewer", async () => {
    for (const [az, yaw] of [[0, 0], [30, 70], [229.1 - 360, 125], [180, 244.999985]]) {
      const exr = sky(2048, 1024, 0.2);
      lightAzimuth(exr, az);
      const { webp } = await buildSky(exr, { yaw });
      const { at } = await brightestColumn(webp, 300);
      const want = threeU(az + yaw) * SKY_WIDTH - 0.5;
      expect(ringDistance(at, want, SKY_WIDTH)).toBeLessThanOrEqual(1.5);
    }
  });

  it('keeps the turn when it scales a smaller or larger sky to 2048×1024', async () => {
    for (const [w, h] of [[512, 256], [4096, 2048]]) {
      const exr = sky(w, h, 0.2);
      lightAzimuth(exr, 40);
      const { webp } = await buildSky(exr, { yaw: 116 });
      const { at, info } = await brightestColumn(webp, 300);
      expect([info.width, info.height]).toEqual([SKY_WIDTH, SKY_HEIGHT]);
      const want = threeU(40 + 116) * SKY_WIDTH - 0.5;
      // One source column is 4 output columns at 512.
      expect(ringDistance(at, want, SKY_WIDTH)).toBeLessThanOrEqual((SKY_WIDTH / w) * 1.5);
    }
  });

  it('refuses a sky that is not 2:1', async () => {
    await expect(buildSky(sky(300, 100, 0.2), { yaw: 0 })).rejects.toThrow(/2:1/);
  });
});
