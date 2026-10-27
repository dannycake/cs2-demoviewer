#!/usr/bin/env node
// node tools/hero.mjs <screenshot.png> <out.png>
//
// CS2's own screenshot of a map (tools/hero.sh extracts it from pak01) as the background of the
// match preview card the server draws (server/crates/server/src/preview.rs): 1200×630, cropped
// to cover from the centre, PNG (the server decodes PNG only). Written to <out>.tmp-<pid> and
// renamed (lib/stage.mjs), so a reader never sees half a file. Byte-identical across runs.
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { writeFileAtomic } from './lib/stage.mjs';
import { PNG_OPTIONS } from './radar.mjs';

/** The preview card's size (server/crates/server/src/preview.rs `WIDTH` × `HEIGHT`). */
export const HERO_WIDTH = 1200;
export const HERO_HEIGHT = 630;

/** Writes `src` cropped and scaled to cover HERO_WIDTH × HERO_HEIGHT as the PNG `out`. */
export async function buildHero(src, out) {
  const png = await sharp(src)
    .removeAlpha()
    .resize(HERO_WIDTH, HERO_HEIGHT, { fit: 'cover', position: 'centre' })
    .png(PNG_OPTIONS)
    .toBuffer();
  writeFileAtomic(out, png);
}

if (isMain(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) {
    console.error('usage: node tools/hero.mjs <screenshot.png> <out.png>');
    process.exit(2);
  }
  buildHero(src, out).catch((e) => {
    console.error(`hero.mjs: ${e.message}`);
    process.exit(1);
  });
}
