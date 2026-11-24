#!/usr/bin/env node
// node tools/shrink-chicken.mjs
//
// Shrinks rip-site.sh's chicken (raw/site/models/chicken/chicken.glb, every clip, ~117 MB) to
// raw/site/chicken.glb (~0.6 MB): only the clips the homepage video plays (CHICKEN_CLIPS, the world
// chicken's, under CHICKEN_CLIP_DIR, named without it), textures as 512 px WebP, meshopt. It stays under raw/: it is never
// served, only rendered into the homepage video (tools/home-video.sh).
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, textureCompress, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { CHICKEN_CLIP_DIR, CHICKEN_CLIPS, CHICKEN_FILE, CHICKEN_RAW, sitePaths } from './lib/site.mjs';

/** Writes the shrunk chicken under `P.raw`; returns its clip names and size. */
export async function shrinkChicken(P = sitePaths()) {
  const src = path.join(P.raw, CHICKEN_RAW);
  if (!fs.existsSync(src)) throw new Error(`${src} is missing; run tools/rip-site.sh`);
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(src);
  const keep = new Set(CHICKEN_CLIPS.map((c) => `${CHICKEN_CLIP_DIR}${c}`));
  for (const a of doc.getRoot().listAnimations()) {
    if (keep.has(a.getName())) {
      a.setName(a.getName().slice(CHICKEN_CLIP_DIR.length));
      continue;
    }
    for (const c of a.listChannels()) c.dispose();
    for (const s of a.listSamplers()) s.dispose();
    a.dispose();
  }
  const clips = doc.getRoot().listAnimations().map((a) => a.getName()).sort();
  const missing = CHICKEN_CLIPS.filter((c) => !clips.includes(c));
  if (missing.length) throw new Error(`${src} has no clip ${missing.join(', ')}`);
  await doc.transform(
    resample(), prune(), dedup(), weld(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [512, 512], quality: 80 }),
    meshopt({ encoder: MeshoptEncoder, level: 'medium' }),
  );
  const dest = path.join(P.raw, CHICKEN_FILE);
  const tmp = `${dest}.tmp-${process.pid}`;
  // writeBinary, not write: write picks the format from the name, and the temp name is not .glb.
  fs.writeFileSync(tmp, await io.writeBinary(doc));
  fs.renameSync(tmp, dest);
  return { clips, bytes: fs.statSync(dest).size };
}

if (isMain(import.meta.url)) {
  try {
    const { clips, bytes } = await shrinkChicken();
    console.log(`shrink-chicken: ${(bytes / 1e6).toFixed(2)} MB with ${clips.join(', ')}`);
  } catch (e) {
    console.error(`shrink-chicken: ${e.message}`);
    process.exit(1);
  }
}
