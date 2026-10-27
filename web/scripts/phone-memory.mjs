// The memory an iPhone's Safari spends on a page of the viewer, measured as Playwright's WebKit
// with its iPhone 13 profile (390×664 CSS px at 3×, touch, Safari's user agent: the `low`
// preset without measuring, as on a phone). It opens `url` and reads the resident memory of
// WebKit's web processes (the page's, where WebGL draws) from /proc every 0.5 s for `seconds`,
// then prints the peak and the last reading (steady), with when the 3D view was ready and drew
// first, the models it fetched, the ImageBitmaps the page made and still holds, and the
// renderer's counts (`window.__demoviewer.memory()`).
//
// Playwright's WebKit does not run on Arch; it runs in Playwright's own image, the page served
// from the host (README, Phones):
//
//   docker run --rm --network host --ipc=host -v "$PWD/scripts:/work:ro" \
//     mcr.microsoft.com/playwright:v1.63.0-noble bash -c 'cd /tmp && npm init -y >/dev/null &&
//     npm i -s playwright@1.63.0 >/dev/null 2>&1 && node /work/phone-memory.mjs
//     /tmp/node_modules/playwright/index.mjs "http://127.0.0.1:8095/d/<id>?cam=pov" 32'
//
// The first argument is Playwright's module (the image has the browsers, not the package).
// Environment:
// - BLOCK=<regex>: requests whose URL matches are answered 404 (what a part of the page costs
//   is the peak without it, against the peak with it).
// - RESTORE=<s>: at <s> seconds (the 3D view drawn by then) the replay is paused, the WebGL
//   context lost (WEBGL_lose_context) and restored 1 s later; prints the memory just before,
//   the peak from the loss to 10 s after the restore and then, how long until the view drew
//   again, and whether it draws textured: the paused frame after the restore against the one
//   before (mean difference per channel and mean luminance, 0–255, of the canvas).
// - OUT=<dir>: writes the two frames there as restore-before.png and restore-after.png.
// One JSON line ends the output.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

const [pwPath, url, secsArg] = process.argv.slice(2);
if (!pwPath || !url) {
  console.error(
    'usage: node phone-memory.mjs <playwright index.mjs> <url> [seconds=32]'
  );
  process.exit(2);
}
const secs = Number(secsArg ?? 32);
const restoreAt = process.env.RESTORE ? Number(process.env.RESTORE) : null;
const { webkit, devices } = await import(pwPath);

/** MB resident of every process whose command line matches `re`, summed. */
function rss(re) {
  let kb = 0;
  for (const pid of readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
    try {
      if (!re.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8'))) continue;
      kb += Number(
        /VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))[1]
      );
    } catch {
      // Gone between the listing and the read.
    }
  }
  return Math.round(kb / 1024);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const now = () => (Date.now() - t0) / 1000;
const sleepUntil = (s) => sleep(Math.max(0, s * 1000 - (Date.now() - t0)));

const browser = await webkit.launch();
const context = await browser.newContext({ ...devices['iPhone 13'] });
// Every ImageBitmap the page makes, to count those it still holds (a closed one is 0 wide).
await context.addInitScript(() => {
  const made = (window.__bitmaps = []);
  const create = window.createImageBitmap;
  if (create)
    window.createImageBitmap = function (...args) {
      return create.apply(this, args).then((b) => (made.push(b), b));
    };
});
const page = await context.newPage();
if (process.env.BLOCK)
  await page.route(new RegExp(process.env.BLOCK), (r) =>
    r.fulfill({ status: 404, body: '' })
  );
page.on('crash', () => console.log(`crash at ${now().toFixed(1)} s`));
page.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200)));
const models = [];
page.on('request', (r) => {
  const path = new URL(r.url()).pathname;
  if (path.endsWith('.glb')) models.push(path);
});

/** The page's state: the 3D view ready, its frames drawn, the bitmaps it holds. */
const pageState = () =>
  page
    .evaluate(() => ({
      ready:
        document.querySelector('[data-testid="viewport"]')?.dataset.ready ===
        'true',
      frames: window.__demoviewer?.stats.frames ?? 0,
      bitmaps: window.__bitmaps.length,
      held: window.__bitmaps.filter((b) => b.width > 0).length,
    }))
    .catch(() => null);

const samples = [];
let readyAt = null;
let drewAt = null;
const sampler = setInterval(() => {
  samples.push({
    t: now(),
    web: rss(/WebProcess/),
    gpu: rss(/GPUProcess/),
  });
  if (drewAt === null)
    void pageState().then((s) => {
      if (s?.ready && readyAt === null) readyAt = now();
      if (s?.frames > 0 && s.ready && drewAt === null) drewAt = now();
    });
}, 500);

page.goto(url).catch((e) => console.log('goto', String(e).slice(0, 200)));

/** The canvas of the 3D view as a screenshot, decoded. */
async function frame(name) {
  const box = await page
    .locator('[data-testid="viewport"] canvas')
    .boundingBox();
  const png = await page.screenshot({ clip: box, type: 'png' });
  if (process.env.OUT) writeFileSync(join(process.env.OUT, `${name}.png`), png);
  return decodePng(png);
}

let restore = null;
if (restoreAt !== null) {
  await sleepUntil(restoreAt);
  await page.evaluate(() => {
    window.__demoviewer.store.getState().pause();
    const canvas = document.querySelector('[data-testid="viewport"] canvas');
    window.__contextEvents = [];
    for (const type of ['webglcontextlost', 'webglcontextrestored'])
      canvas.addEventListener(type, () =>
        window.__contextEvents.push([type, performance.now()])
      );
    window.__loseContext = canvas
      .getContext('webgl2')
      .getExtension('WEBGL_lose_context');
  });
  await sleep(1000);
  const before = await frame('restore-before');
  const was = await pageState();
  const lostAt = now();
  const rssBefore = samples.at(-1)?.web ?? 0;
  await page.evaluate(() => window.__loseContext.loseContext());
  await sleep(1000);
  const restoredAt = now();
  const framesAtRestore = (await pageState()).frames;
  await page.evaluate(() => window.__loseContext.restoreContext());
  let drewAgain = null;
  while (now() - restoredAt < 15) {
    const s = await pageState();
    if (s && s.frames > framesAtRestore) {
      drewAgain = now() - restoredAt;
      break;
    }
    await sleep(100);
  }
  await sleep(2000);
  const after = await frame('restore-after');
  const is = await pageState();
  const events = await page.evaluate(() =>
    window.__contextEvents.map(([type]) => type)
  );
  await sleepUntil(restoredAt + 10);
  const around = samples.filter((s) => s.t >= lostAt).map((s) => s.web);
  const cmp = compare(before, after);
  restore = {
    lostAt: Number(lostAt.toFixed(1)),
    events,
    rssBefore,
    peakAround: Math.max(...around),
    rssAfter: samples.at(-1)?.web ?? 0,
    drewAgainS: drewAgain === null ? null : Number(drewAgain.toFixed(2)),
    heldBefore: was.held,
    heldAfter: is.held,
    ...cmp,
    textured:
      drewAgain !== null &&
      cmp.meanDiff <= 4 &&
      Math.abs(cmp.lumaAfter - cmp.lumaBefore) <= 4,
  };
}

await sleepUntil(secs);
clearInterval(sampler);
const info = await page
  .evaluate(() => ({
    canvas: [...document.querySelectorAll('canvas')].map(
      (c) => `${c.width}x${c.height}`
    ),
    memory: window.__demoviewer?.memory?.(),
    bitmaps: window.__bitmaps.length,
    held: window.__bitmaps.filter((b) => b.width > 0).length,
  }))
  .catch((e) => String(e));
await browser.close();

const web = samples.map((s) => s.web);
const peak = Math.max(...web);
const peakAt = samples[web.indexOf(peak)].t;
const steady = web.at(-1);
const gpuPeak = Math.max(...samples.map((s) => s.gpu));
console.log(
  `peak ${peak} MB at ${peakAt.toFixed(1)} s, steady ${steady} MB` +
    (gpuPeak ? ` (GPU process peak ${gpuPeak} MB)` : '') +
    `; ready at ${readyAt?.toFixed(1) ?? '-'} s, drew at ${drewAt?.toFixed(1) ?? '-'} s`
);
if (restore)
  console.log(
    `restore: ${restore.rssBefore} MB before the loss, peak ${restore.peakAround} MB, ` +
      `${restore.rssAfter} MB 10 s after; drew again ${restore.drewAgainS ?? 'never'} s ` +
      `after the restore, ${restore.textured ? 'textured' : 'NOT as before'} ` +
      `(mean difference ${restore.meanDiff}, luminance ${restore.lumaBefore} → ` +
      `${restore.lumaAfter}); bitmaps held ${restore.heldBefore} → ${restore.heldAfter}`
  );
console.log(
  JSON.stringify({
    url,
    block: process.env.BLOCK ?? null,
    peak,
    peakAt: Number(peakAt.toFixed(1)),
    steady,
    gpuPeak,
    readyAt,
    drewAt,
    models: [...new Set(models)],
    series: web.filter((_, i) => i % 4 === 0),
    info,
    restore,
  })
);

/** An 8-bit RGB or RGBA PNG, not interlaced (Playwright's screenshots), as its pixels. */
function decodePng(buf) {
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[data[9]] ?? 0;
      if (data[8] !== 8 || !channels || data[12] !== 0)
        throw new Error('not an 8-bit RGB(A) PNG');
    } else if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const prev = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, channels, px };
}

/** Two frames' mean difference per channel and mean luminance (0–255). */
function compare(a, b) {
  const n = Math.min(a.width * a.height, b.width * b.height);
  let diff = 0;
  let la = 0;
  let lb = 0;
  const luma = (f, i) =>
    0.2126 * f.px[i * f.channels] +
    0.7152 * f.px[i * f.channels + 1] +
    0.0722 * f.px[i * f.channels + 2];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++)
      diff += Math.abs(a.px[i * a.channels + k] - b.px[i * b.channels + k]);
    la += luma(a, i);
    lb += luma(b, i);
  }
  const r = (v) => Number(v.toFixed(2));
  return {
    meanDiff: r(diff / n / 3),
    lumaBefore: r(la / n),
    lumaAfter: r(lb / n),
  };
}
