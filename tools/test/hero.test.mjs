import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from 'vitest';
import { buildHero, HERO_HEIGHT, HERO_WIDTH } from '../hero.mjs';

test('a 1080p screenshot becomes a 1200×630 opaque PNG, the same bytes every run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hero-'));
  const src = path.join(dir, 'shot.png');
  // Left half red, right half blue: the centre crop keeps both.
  const left = { r: 200, g: 40, b: 40, alpha: 1 };
  await sharp({ create: { width: 1920, height: 1080, channels: 4, background: left } })
    .composite([{ input: { create: { width: 960, height: 1080, channels: 4, background: { r: 40, g: 40, b: 200, alpha: 1 } } }, left: 960, top: 0 }])
    .png()
    .toFile(src);
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.png');
  await buildHero(src, a);
  await buildHero(src, b);
  const meta = await sharp(a).metadata();
  expect([meta.width, meta.height, meta.hasAlpha]).toEqual([HERO_WIDTH, HERO_HEIGHT, false]);
  expect(fs.readFileSync(a).equals(fs.readFileSync(b))).toBe(true);
  const { data } = await sharp(a).raw().toBuffer({ resolveWithObject: true });
  const px = (x, y) => [...data.subarray((y * HERO_WIDTH + x) * 3, (y * HERO_WIDTH + x) * 3 + 3)];
  expect(px(10, 315)).toEqual([200, 40, 40]);
  expect(px(1190, 315)).toEqual([40, 40, 200]);
  expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
});
