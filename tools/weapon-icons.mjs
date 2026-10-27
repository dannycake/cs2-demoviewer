#!/usr/bin/env node
// node tools/weapon-icons.mjs
//
// assets/weapons/<name>.glb (every WEAPON_NAMES entry that exists) → web/public/weapons.png
// (a sprite sheet of white-on-transparent side silhouettes, CELL_W × CELL_H each, COLUMNS
// wide) + web/src/components/weapon-icons.json ({ cell, columns, width, height, icons: {
// <name>: { x, y, w, h } } }, x and w the drawing's own columns in its cell). Both are
// committed: the HUD's killfeed, player card and
// player list draw from them.
//
// The silhouettes are derived from the ripped models (the "match" side of the phase 3c design's
// line), never from Valve's own icon art. Each model is projected side-on: its longest axis runs
// left to right and its second longest is up (a gun: barrel across, height up; a knife, modelled
// standing, lies down), except grenades and the C4, which keep glTF +Y up and stand as they
// would on the ground. The thinner end (the muzzle or the blade tip, judged by the vertical
// extent of the last 15% at each end) points right, towards the victim in a killfeed line.
// Small parts that float apart from the body (a loose shell, a placeholder) are dropped: they
// would shrink the silhouette to fit them in. Triangles are filled into a 4× supersampled mask and
// box-filtered down, so the output depends only on the GLB bytes: byte-stable across runs.
// (The phase 3c plan proposed a headless-Chromium render; a software fill needs no GPU and
// gives the same silhouette.)
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { isMain } from './lib/cli.mjs';
import { createIO } from './lib/gltf.mjs';
import { REPO_DIR } from './lib/paths.mjs';
import { weaponPaths, WEAPON_NAMES } from './lib/weapons.mjs';

export const CELL_W = 160;
export const CELL_H = 64;
export const PAD = 2;
export const COLUMNS = 6;
const SS = 4;
const END_FRACTION = 0.15;
/** Drawn standing, as they rest on the ground. */
export const UPRIGHT = new Set(['flashbang', 'hegrenade', 'smokegrenade', 'molotov', 'incendiary', 'decoy', 'c4']);

/**
 * Side-on triangles of a document in 2D: `u` along the long horizontal axis (flipped so the
 * thinner end has the larger u), `v` up. Returns the flat [u0, v0, u1, v1, u2, v2, ...] list
 * and the bounds.
 */
export function sideTriangles(doc, { upright = false } = {}) {
  let tris = [];
  let pts = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (!pos) continue;
      const ind = prim.getIndices();
      const local = [0, 0, 0];
      const world = [];
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, local);
        const [x, y, z] = local;
        world.push([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]]);
      }
      const count = ind ? ind.getCount() : world.length;
      for (let t = 0; t + 2 < count; t += 3) {
        const a = world[ind ? ind.getScalar(t) : t];
        const b = world[ind ? ind.getScalar(t + 1) : t + 1];
        const c = world[ind ? ind.getScalar(t + 2) : t + 2];
        tris.push(a, b, c);
      }
      for (const p of world) pts.push(p);
    }
  }
  if (!pts.length) throw new Error('no geometry');
  ({ tris, pts } = dropFloaters(tris));
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]); }
  const ext = [0, 1, 2].map((k) => max[k] - min[k]);
  // Across: the longest axis (the longer horizontal one when upright); up: the next longest, or +Y.
  const order = [0, 1, 2].sort((a, b) => ext[b] - ext[a] || a - b);
  const long = upright ? (ext[0] >= ext[2] ? 0 : 2) : order[0];
  const up = upright ? 1 : order[1];
  const len = ext[long] || 1;
  const extentNear = (lo) => {
    let a = Infinity;
    let b = -Infinity;
    for (const p of pts) {
      const f = (p[long] - min[long]) / len;
      if (lo ? f <= END_FRACTION : f >= 1 - END_FRACTION) { a = Math.min(a, p[up]); b = Math.max(b, p[up]); }
    }
    return b > a ? b - a : 0;
  };
  // The thinner end goes right (larger u).
  const flip = extentNear(true) < extentNear(false);
  const u = (p) => (flip ? max[long] - p[long] : p[long] - min[long]);
  const out = new Float64Array(tris.length * 2);
  for (let i = 0; i < tris.length; i++) { out[2 * i] = u(tris[i]); out[2 * i + 1] = tris[i][up] - min[up]; }
  return { tris: out, width: len, height: ext[up] || 1, flipped: flip, axis: 'xyz'[long], up: 'xyz'[up] };
}

/**
 * Drops parts that float apart from the body. A part is a set of triangles joined by shared
 * vertex positions; a weapon is assembled from many (receiver, barrel, magazine, stock) whose
 * bounds touch. Starting from the largest part, every part whose bounds touch the kept bounds
 * (grown by 2% of the largest extent) is kept, repeatedly; what never touches (a loose shell
 * or placeholder beside the model) is dropped.
 */
export function dropFloaters(tris) {
  const n = tris.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const owner = new Map();
  const keyOf = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < 3; k++) {
      const key = keyOf(tris[3 * t + k]);
      const o = owner.get(key);
      if (o === undefined) owner.set(key, t);
      else { const a = find(o); const b = find(t); if (a !== b) parent[a] = b; }
    }
  }
  const parts = new Map();
  for (let t = 0; t < n; t++) {
    const r = find(t);
    let part = parts.get(r);
    if (!part) parts.set(r, (part = { tris: [], min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }));
    part.tris.push(t);
    for (let k = 0; k < 3; k++) {
      const p = tris[3 * t + k];
      for (let a = 0; a < 3; a++) { part.min[a] = Math.min(part.min[a], p[a]); part.max[a] = Math.max(part.max[a], p[a]); }
    }
  }
  const list = [...parts.values()].sort((a, b) => b.tris.length - a.tris.length);
  const size = Math.max(...[0, 1, 2].map((a) => list[0].max[a] - list[0].min[a]));
  const pad = 0.02 * size;
  const min = [...list[0].min];
  const max = [...list[0].max];
  const kept = new Set([list[0]]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const q of list) {
      if (kept.has(q)) continue;
      if (![0, 1, 2].every((a) => q.min[a] <= max[a] + pad && q.max[a] >= min[a] - pad)) continue;
      kept.add(q);
      grew = true;
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], q.min[a]); max[a] = Math.max(max[a], q.max[a]); }
    }
  }
  const ids = [...kept].flatMap((q) => q.tris).sort((a, b) => a - b);
  const outTris = [];
  for (const t of ids) outTris.push(tris[3 * t], tris[3 * t + 1], tris[3 * t + 2]);
  return { tris: outTris, pts: outTris, dropped: list.length - kept.size };
}

/** Fills the triangles into a w × h alpha mask (0..255), fitted with `pad` pixels of margin. */
export function rasterize(side, w = CELL_W, h = CELL_H, pad = PAD) {
  const W = w * SS;
  const H = h * SS;
  const scale = Math.min((W - 2 * pad * SS) / side.width, (H - 2 * pad * SS) / side.height);
  const ox = (W - side.width * scale) / 2;
  const oy = (H - side.height * scale) / 2;
  const hi = new Uint8Array(W * H);
  const t = side.tris;
  for (let i = 0; i + 5 < t.length; i += 6) {
    // Screen space: x right, y down.
    const x0 = ox + t[i] * scale, y0 = H - (oy + t[i + 1] * scale);
    const x1 = ox + t[i + 2] * scale, y1 = H - (oy + t[i + 3] * scale);
    const x2 = ox + t[i + 4] * scale, y2 = H - (oy + t[i + 5] * scale);
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const s = area > 0 ? 1 : -1;
    for (let y = minY; y <= maxY; y++) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x++) {
        const px = x + 0.5;
        const e0 = s * ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0));
        const e1 = s * ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1));
        const e2 = s * ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2));
        if (e0 >= 0 && e1 >= 0 && e2 >= 0) hi[y * W + x] = 1;
      }
    }
  }
  const alpha = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) n += hi[(y * SS + j) * W + x * SS + i];
      alpha[y * w + x] = Math.round((255 * n) / (SS * SS));
    }
  }
  return alpha;
}

/** The margin kept either side of a drawing when its cell is trimmed. */
export const TRIM_PAD = 2;

/**
 * The columns of a w × h alpha mask its drawing covers, with `TRIM_PAD` either side inside the
 * cell: `{ x, w }` in the cell. The whole cell when it is empty.
 */
export function trim(alpha, w, h) {
  let x0 = w;
  let x1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (alpha[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
  if (x1 < 0) return { x: 0, w };
  const from = Math.max(0, x0 - TRIM_PAD);
  const to = Math.min(w - 1, x1 + TRIM_PAD);
  return { x: from, w: to - from + 1 };
}

/** The sheet layout for `names`, in order. */
export function layout(names, columns = COLUMNS) {
  const rows = Math.ceil(names.length / columns);
  const icons = {};
  names.forEach((n, i) => { icons[n] = { x: (i % columns) * CELL_W, y: Math.floor(i / columns) * CELL_H, w: CELL_W, h: CELL_H }; });
  return { cell: [CELL_W, CELL_H], columns, width: columns * CELL_W, height: Math.max(1, rows) * CELL_H, icons };
}

async function main() {
  if (process.argv.length > 2) { console.error('usage: node tools/weapon-icons.mjs'); process.exit(1); }
  const io = await createIO();
  const names = WEAPON_NAMES.filter((n) => fs.existsSync(weaponPaths(n).glb));
  if (!names.length) { console.error('weapon-icons: no assets/weapons/*.glb; run tools/build-assets.sh first'); process.exit(1); }
  const missing = WEAPON_NAMES.filter((n) => !names.includes(n));
  const sheet = layout(names);
  const rgba = Buffer.alloc(sheet.width * sheet.height * 4);
  for (const name of names) {
    const side = sideTriangles(await io.read(weaponPaths(name).glb), { upright: UPRIGHT.has(name) });
    const alpha = rasterize(side);
    const { x, y } = sheet.icons[name];
    // The JSON names the drawing's own columns, so a narrow grenade is not drawn as wide as a rifle.
    const t = trim(alpha, CELL_W, CELL_H);
    sheet.icons[name] = { ...sheet.icons[name], x: x + t.x, w: t.w };
    for (let j = 0; j < CELL_H; j++) {
      for (let i = 0; i < CELL_W; i++) {
        const o = ((y + j) * sheet.width + x + i) * 4;
        const a = alpha[j * CELL_W + i];
        rgba[o] = rgba[o + 1] = rgba[o + 2] = a ? 255 : 0;
        rgba[o + 3] = a;
      }
    }
  }
  const png = path.join(REPO_DIR, 'web', 'public', 'weapons.png');
  const json = path.join(REPO_DIR, 'web', 'src', 'components', 'weapon-icons.json');
  const bytes = await sharp(rgba, { raw: { width: sheet.width, height: sheet.height, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
  fs.writeFileSync(png, bytes);
  fs.writeFileSync(json, JSON.stringify(sheet, null, 2) + '\n');
  console.log(`weapon-icons: ${names.length} icons → ${path.relative(process.cwd(), png)} (${sheet.width}×${sheet.height}, ${(bytes.length / 1e3).toFixed(0)} KB) + ${path.relative(process.cwd(), json)}${missing.length ? `; missing ${missing.join(' ')}` : ''}`);
}

if (isMain(import.meta.url)) await main();
