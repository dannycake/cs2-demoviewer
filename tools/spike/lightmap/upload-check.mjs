// Spike (D5): does Chromium hand WebGL the RGBM WebP's bytes unchanged?
//   node tools/spike/lightmap/upload-check.mjs <webp>
// Crops a 256 px corner of <webp> to a test file, draws it through upload.html in headless Chromium
// (GPU), and compares the pixels read back with sharp's decode of the same file.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import sharp from 'sharp';

const require = createRequire(path.resolve('web/package.json'));
const { chromium } = require('playwright');
const root = process.cwd();
const src = process.argv[2];
const test = path.join(path.dirname(src), 'upload-test.webp');
// A dark crop has the low alpha (multiplier) values where premultiplication would lose bits.
const meta = await sharp(src).metadata();
await sharp(src).extract({ left: 0, top: meta.height - 256, width: 256, height: 256 }).webp({ lossless: true, exact: true }).toFile(test);
const ref = await sharp(test).ensureAlpha().raw().toBuffer();
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : f.endsWith('.webp') ? 'image/webp' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.route('https://unpkg.com/three@0.186.1/**', (route) => route.fulfill({ path: path.join(root, 'tools/node_modules/three', new URL(route.request().url()).pathname.replace('/three@0.186.1/', '')), contentType: 'text/javascript' }));
await page.goto(`http://127.0.0.1:${server.address().port}/tools/spike/lightmap/upload.html?f=/${path.relative(root, test)}`);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60_000 });
for (const k of ['__img', '__bmp']) {
  const px = await page.evaluate((k) => window[k], k);
  let diff = 0, maxd = 0, lowA = 0, lowAdiff = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(px[i] - ref[i]);
    if (d) diff++; maxd = Math.max(maxd, d);
    if (i % 4 !== 3 && ref[i - (i % 4) + 3] < 16) { lowA++; if (d > 1) lowAdiff++; }
  }
  console.log(`${k === '__img' ? '<img> (TextureLoader)' : 'ImageBitmap premultiplyAlpha none'}: ${diff} of ${ref.length} bytes differ, max ${maxd}; colour bytes under alpha < 16: ${lowAdiff} of ${lowA} off by more than 1`);
}
await browser.close(); server.close();
