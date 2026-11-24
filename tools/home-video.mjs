#!/usr/bin/env node
// The homepage video: the CS2 chicken idling in CT mid on Dust 2 while pro kills happen behind it,
// the camera circling it once a loop. tools/home-video/shots.json holds every number; this
// module turns it into frames (`frameList`), captures them from a running server through the
// viewer (`capture`), and gives ffmpeg's arguments (`ffmpegArgs`). tools/home-video.sh runs it.
//
// The plan (ported from the spike that rendered the clip the site shipped with; its notes are in
// the design folder): the view's compass azimuth is azimuth0 + 360·t/L + ease·sin(6πt/L), one
// counter-clockwise turn per loop of L seconds, slowest as each moment's kill plays behind the
// chicken. Each moment fills a third of the loop: its replay shows `tick` at the third's middle,
// running at speed.kill there and speed.cut at its cuts (a cosine ramp, integrated exactly), the
// camera `R` metres from the chicken and `h` above its floor, the chicken facing `face`. The
// chicken's middle sits `lowerThird` degrees under the frame's centre. Every term is periodic,
// and the video starts at `startFrame` (mid-moment), so its last frame runs into its first as
// any two neighbours do.
//
// usage: node tools/home-video.mjs capture --base <url> --demos <dir> --frames <dir> --chicken <glb> [--limit <n>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/cli.mjs';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
export const SHOTS_FILE = 'home-video/shots.json';
/** Source units to metres. */
const UNIT = 0.0254;
/** The replay's ticks per second. */
const TICK_RATE = 64;

/** Source units → scene metres. */
const toScene = ([x, y, z]) => [y * UNIT, z * UNIT, x * UNIT];

/** A free pose looking from `eye` at `p` (scene metres). */
function looking(eye, p) {
  const [dx, dy, dz] = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]];
  const yaw = (Math.atan2(dx, dz) * 180) / Math.PI;
  const pitch = (-Math.asin(dy / Math.hypot(dx, dy, dz)) * 180) / Math.PI;
  return { x: eye[0], y: eye[1], z: eye[2], yaw, pitch };
}

/**
 * The free pose looking along compass azimuth `alpha` (degrees, Source: 0 = +X, 90 = +Y) at the
 * chicken at `c` = [x, y, floorZ] (Source units), from `R` metres away and `h` above its floor,
 * aimed `aimUp` metres above the floor at the chicken, with vertical field of view `fov`.
 */
function orbitPose(c, alpha, { R, h, aimUp, fov }) {
  const a = (alpha * Math.PI) / 180;
  const dir = [Math.cos(a), Math.sin(a)];
  const eye = [c[0] - (dir[0] * R) / UNIT, c[1] - (dir[1] * R) / UNIT, c[2] + h / UNIT];
  const aim = [c[0], c[1], c[2] + aimUp / UNIT];
  return { ...looking(toScene(eye), toScene(aim)), fov };
}

/** The chicken's prop pose (web/src/scene/prop.ts PropPose) at `c`, facing azimuth `face`. */
function chickenPose(c, face, clip, t) {
  const [x, y, z] = toScene(c);
  // Its yaw turns about the scene's up from the scene's +z (Source +x): azimuth `face` is 90 - face.
  return { x, y, z, yaw: 90 - face, clip, t };
}

/** Frame `i` of the plan (plan time, before the loop is rotated to `startFrame`). */
export function frameAt(spec, i) {
  const L = spec.seconds;
  const t = i / spec.fps;
  const within = ((t % L) + L) % L;
  const n = spec.moments.length;
  const k = Math.min(n - 1, Math.floor((n * within) / L));
  const m = spec.moments[k];
  const tm = ((k + 0.5) * L) / n;
  const w = (2 * n * Math.PI) / L;
  const azimuth = spec.orbit.azimuth0 + (360 * t) / L + spec.orbit.ease * Math.sin(w * t);
  const mean = (spec.speed.kill + spec.speed.cut) / 2;
  const amp = (spec.speed.cut - spec.speed.kill) / 2;
  // Replay seconds from the moment's middle: the integral of mean + amp·cos(w·t).
  const replay = mean * (within - tm) + (amp / w) * (Math.sin(w * within) - Math.sin(w * tm));
  const mid = spec.chicken.middle;
  const up = spec.orbit.lowerThird + (Math.atan2(mid - m.h, m.R) * 180) / Math.PI;
  const aimUp = m.h + m.R * Math.tan((up * Math.PI) / 180);
  return {
    i,
    moment: m.name,
    demo: spec.demos[m.demo],
    round: m.round,
    tick: m.tick + TICK_RATE * replay,
    pose: orbitPose(spec.chicken.at, azimuth, { R: m.R, h: m.h, aimUp, fov: spec.orbit.fov }),
    // The idle runs on through the loop on the video's clock.
    chicken: chickenPose(spec.chicken.at, m.face, spec.chicken.clip, within),
    dof: { ...spec.dof, focus: Math.hypot(m.R, m.h - mid) },
  };
}

/** The video's frames in order: the plan rotated to start at `startFrame`. */
export function frameList(spec) {
  const n = spec.fps * spec.seconds;
  return Array.from({ length: n }, (_, j) => ({ ...frameAt(spec, (spec.startFrame + j) % n), i: j }));
}

/**
 * ffmpeg's arguments to encode `framesDir/%04d.png` (60 fps) into `out`: `mp4` H.264 High,
 * yuv420p, +faststart, no audio, at `crf`; `webm` VP9 at constant quality `crf`, two passes
 * (`pass` 1 writes only the pass log, 2 the file).
 */
export function ffmpegArgs(kind, framesDir, out, crf, pass = 2) {
  const input = ['-y', '-framerate', '60', '-i', `${framesDir}/%04d.png`];
  if (kind === 'mp4') {
    return [...input, '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryslow', '-crf', String(crf),
      '-pix_fmt', 'yuv420p', '-g', '120', '-movflags', '+faststart', '-an', '-r', '60', out];
  }
  if (kind === 'webm') {
    const vp9 = ['-c:v', 'libvpx-vp9', '-crf', String(crf), '-b:v', '0', '-pix_fmt', 'yuv420p', '-g', '120',
      '-row-mt', '1', '-tile-columns', '2', '-deadline', 'good', '-cpu-used', '1', '-pass', String(pass),
      '-passlogfile', `${out}.vp9`, '-an', '-r', '60'];
    return pass === 1 ? [...input, ...vp9, '-f', 'null', '/dev/null'] : [...input, ...vp9, out];
  }
  throw new Error(`no encoding for ${kind}`);
}

// ---- capture ----------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uploads `file` to the server at `base` (its chunked upload API) and waits until it is done. */
async function upload(base, file) {
  const size = fs.statSync(file).size;
  const json = async (res) => {
    if (!res.ok) throw new Error(`${res.url}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const start = await json(await fetch(`${base}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ size, name: path.basename(file) }),
  }));
  const fd = fs.openSync(file, 'r');
  try {
    for (let n = 0, at = 0; at < size; n++, at += start.chunkSize) {
      const chunk = Buffer.alloc(Math.min(start.chunkSize, size - at));
      fs.readSync(fd, chunk, 0, chunk.length, at);
      const res = await fetch(`${base}/api/uploads/${start.uploadId}/${n}`, { method: 'PUT', body: chunk });
      if (!res.ok) throw new Error(`chunk ${n} of ${file}: ${res.status} ${await res.text()}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  const { demoId } = await json(await fetch(`${base}/api/uploads/${start.uploadId}/complete`, { method: 'POST' }));
  for (const t0 = Date.now(); ; await sleep(500)) {
    const d = await json(await fetch(`${base}/api/demos/${demoId}`));
    if (d.status === 'done') return demoId;
    if (d.status === 'error') throw new Error(`${file}: ${d.error}`);
    if (Date.now() - t0 > 10 * 60_000) throw new Error(`${file} was not parsed within 10 minutes`);
  }
}

/** Waits until the debug handle has a scene and a pack. */
async function ready(page, timeout = 120_000) {
  for (const t0 = Date.now(); ; await page.waitForTimeout(250)) {
    const ok = await page.evaluate(() => {
      const d = window.__demoviewer;
      if (!d) return false;
      try {
        d.camera();
      } catch {
        return false;
      }
      return !!d.store.getState().pack;
    });
    if (ok) return;
    if (Date.now() - t0 > timeout) throw new Error('the viewer was not ready');
  }
}

/** Waits until the scene's frame counter stands still for `ms` (everything loaded and drawn). */
async function quiet(page, ms = 1500, timeout = 120_000) {
  let [last, since] = [-1, Date.now()];
  for (const t0 = Date.now(); Date.now() - t0 < timeout; await page.waitForTimeout(100)) {
    const f = await page.evaluate(() => window.__demoviewer.stats.frames);
    if (f !== last) [last, since] = [f, Date.now()];
    else if (Date.now() - since > ms) return;
  }
}

/** Poses one frame exactly: the replay at its tick, the free camera, the chicken, the focus. */
const pose = (page, f) =>
  page.evaluate((f) => {
    const d = window.__demoviewer;
    const s = d.store.getState();
    s.pause();
    if (s.round !== f.round) s.seekRound(f.round);
    s.seekTick(f.tick);
    if (s.camera !== 'free') s.setCamera('free');
    d.setFreePose(f.pose);
    d.poseProp(f.chicken);
    d.setDof(f.dof);
    d.drawNow();
  }, f);

/**
 * Uploads the shot list's demos to the server at `base`, then shoots every frame (or the first
 * `limit`) through the viewer into `framesDir/<i>.png`, one page load per demo. The chicken is
 * served to the page from `chicken` (raw/site/chicken.glb): nothing Valve-made goes into web/.
 */
export async function capture({ base, demos, framesDir, chicken, limit = Infinity }) {
  const { chromium } = await import('playwright');
  const spec = JSON.parse(fs.readFileSync(path.join(TOOLS, SHOTS_FILE), 'utf8'));
  const frames = frameList(spec).slice(0, limit);
  const ids = {};
  for (const file of new Set(frames.map((f) => f.demo))) {
    ids[file] = await upload(base, path.join(demos, file));
    console.log(`home-video: ${file} is ${ids[file]}`);
  }
  fs.mkdirSync(framesDir, { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    // As web/playwright.config.ts: the GPU through ANGLE/Vulkan, never a live audio sink.
    args: ['--mute-audio', '--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'],
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: spec.width, height: spec.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.setItem('demoviewer.quality', 'high');
      localStorage.setItem('demoviewer.settings', JSON.stringify({
        labels: false, trails: true, damageNumbers: false, minimap: false, xray: false, nameTags: false,
        autoKillcam: false, roundSummary: false, muted: true, volume: 0,
      }));
    });
    await page.route('**/home-video/chicken.glb', (route) => route.fulfill({ path: chicken, contentType: 'model/gltf-binary' }));
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const t0 = Date.now();
    let shot = 0;
    for (const file of Object.keys(ids)) {
      const group = frames.filter((f) => f.demo === file);
      const f0 = group[0];
      await page.goto(`${base}/d/${ids[file]}?r=${f0.round + 1}&t=${Math.round(f0.tick)}&cam=free&hud=0`);
      await ready(page);
      await page.evaluate(() => window.__demoviewer.loadProp('/home-video/chicken.glb'));
      await quiet(page);
      // Pre-roll: visit the frames sparsely so every model and effect atlas they need is in.
      for (let i = 0; i < group.length; i += 6) await pose(page, group[i]);
      await pose(page, f0);
      await quiet(page, 1200);
      for (const f of group) {
        await pose(page, f);
        const png = await page.locator('canvas').first().screenshot({ type: 'png' });
        fs.writeFileSync(path.join(framesDir, `${String(f.i).padStart(4, '0')}.png`), png);
        if (++shot % 60 === 0) console.log(`home-video: ${shot}/${frames.length} frames, ${((Date.now() - t0) / shot).toFixed(0)} ms each`);
      }
    }
  } finally {
    await browser.close();
  }
  if (errors.length) throw new Error(`the page reported errors: ${errors.slice(0, 5).join(' | ')}`);
  return frames.length;
}

if (isMain(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const opt = Object.fromEntries(rest.reduce((pairs, a, i) => (a.startsWith('--') ? [...pairs, [a.slice(2), rest[i + 1]]] : pairs), []));
  if (cmd !== 'capture' || !opt.base || !opt.demos || !opt.frames || !opt.chicken) {
    console.error('usage: node tools/home-video.mjs capture --base <url> --demos <dir> --frames <dir> --chicken <glb> [--limit <n>]');
    process.exit(2);
  }
  try {
    const n = await capture({ base: opt.base, demos: opt.demos, framesDir: opt.frames, chicken: opt.chicken, limit: opt.limit ? Number(opt.limit) : Infinity });
    console.log(`home-video: ${n} frames in ${opt.frames}`);
  } catch (e) {
    console.error(`home-video: ${e.message}`);
    process.exit(1);
  }
}
