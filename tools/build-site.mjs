#!/usr/bin/env node
// node tools/build-site.mjs
//
// Builds assets/site/ from rip-site.sh's export: each rank icon (lib/site.mjs RANK_KEYS) as a
// WebP at ranks/skillgroup<N>.webp, the Steam logo as steam-logo.svg, each map's strip (lib/
// site.mjs MAP_STRIP) as a WebP at maps/<map>.webp from the hero.png tools/hero.sh made of
// CS2's screenshot of it (a map without one has none, and a strip whose hero.png is gone is
// removed), and build.json recording what it made and from which rip and hero.png. Never
// touches site/home/ (tools/home-video.sh writes it).
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { heroSha256, MAP_HERO, MAP_NAME, MAP_STRIP, mapStripFile, mapsWithHero, RANK_KEYS, rankFile, rankRaw, sitePaths, STEAM_LOGO_FILE, STEAM_LOGO_RAW } from './lib/site.mjs';
import { writeJsonAtomic } from './lib/stage.mjs';

/** Writes what `make(tmp)` writes to `dest` by way of `<dest>.tmp-<pid>`; returns what it returns. */
async function staged(dest, make) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  const info = await make(tmp);
  fs.renameSync(tmp, dest);
  return info;
}

/** Each map's strip under `P.out`, made from `P.maps`/<map>/hero.png, and the old ones removed. */
async function buildStrips(P) {
  const maps = {};
  for (const map of mapsWithHero(P.maps)) {
    const file = mapStripFile(map);
    const hero = heroSha256(P.maps, map);
    const info = await staged(path.join(P.out, file), (tmp) =>
      sharp(path.join(P.maps, map, MAP_HERO))
        .removeAlpha()
        .resize(MAP_STRIP.width, MAP_STRIP.height, { fit: 'cover', position: 'centre' })
        .webp({ quality: MAP_STRIP.quality, effort: 6 })
        .toFile(tmp),
    );
    maps[map] = { file, bytes: info.size, width: info.width, height: info.height, hero };
  }
  const dir = path.join(P.out, path.dirname(mapStripFile('x')));
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      const map = name.endsWith('.webp') ? name.slice(0, -'.webp'.length) : null;
      if (map && MAP_NAME.test(map) && !Object.hasOwn(maps, map)) fs.rmSync(path.join(dir, name));
    }
  }
  return maps;
}

/** Builds the kind at `P` (lib/site.mjs sitePaths); returns build.json's contents. */
export async function buildSite(P = sitePaths()) {
  const rip = JSON.parse(fs.readFileSync(P.ripJson, 'utf8'));
  const ranks = {};
  for (const key of RANK_KEYS) {
    const src = path.join(P.raw, rankRaw(key));
    if (!fs.existsSync(src)) throw new Error(`${src} is missing; run tools/rip-site.sh`);
    const file = rankFile(key);
    const info = await staged(path.join(P.out, file), (tmp) =>
      sharp(src).webp({ quality: 92, alphaQuality: 100, effort: 6 }).toFile(tmp),
    );
    ranks[key] = { file, bytes: info.size, width: info.width, height: info.height };
  }
  const logoSrc = path.join(P.raw, STEAM_LOGO_RAW);
  if (!fs.existsSync(logoSrc)) throw new Error(`${logoSrc} is missing; run tools/rip-site.sh`);
  const logo = path.join(P.out, STEAM_LOGO_FILE);
  await staged(logo, (tmp) => fs.copyFileSync(logoSrc, tmp));
  const maps = await buildStrips(P);
  const built = { cs2Build: rip.cs2Build, vrfVersion: rip.vrfVersion, ranks, steamLogo: { file: STEAM_LOGO_FILE, bytes: fs.statSync(logo).size }, maps };
  writeJsonAtomic(P.buildJson, built);
  return built;
}

if (isMain(import.meta.url)) {
  try {
    const built = await buildSite();
    const kb = (list) => (list.reduce((n, r) => n + r.bytes, 0) / 1e3).toFixed(1);
    const strips = Object.values(built.maps);
    console.log(`build-site: ${Object.keys(built.ranks).length} rank icons (${kb(Object.values(built.ranks))} KB), the Steam logo and ${strips.length} map strips (${kb(strips)} KB); CS2 build ${built.cs2Build}`);
  } catch (e) {
    console.error(`build-site: ${e.message}`);
    process.exit(1);
  }
}
