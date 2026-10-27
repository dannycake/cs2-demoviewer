// Spike: screenshots of tools/spike/viewer.html through headless Chromium on the GPU.
//   node tools/spike/lightmap/shoot.mjs <name> '<viewer query>' [<name> '<query>']...
// Serves the worktree over HTTP, answers the viewer's unpkg three@0.186.1 imports from
// tools/node_modules/three, and writes assets/spike/m2a-<name>.jpg (1600x900).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(path.resolve('web/package.json'));
const { chromium } = require('playwright');
const root = process.cwd();
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await chromium.launch({ args: ['--ignore-gpu-blocklist', '--enable-gpu', '--use-angle=vulkan', '--enable-features=Vulkan'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.route('https://unpkg.com/three@0.186.1/**', (route) => {
  const rel = new URL(route.request().url()).pathname.replace('/three@0.186.1/', '');
  route.fulfill({ path: path.join(root, 'tools/node_modules/three', rel), contentType: 'text/javascript' });
});
const args = process.argv.slice(2);
for (let i = 0; i + 1 < args.length; i += 2) {
  const [name, query] = [args[i], args[i + 1]];
  const t0 = performance.now();
  await page.goto(`http://127.0.0.1:${port}/tools/spike/viewer.html?${query}`);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 300_000 });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const out = path.join(root, 'assets/spike', `m2a-${name}.jpg`);
  await page.screenshot({ path: out, type: 'jpeg', quality: 88 });
  console.log(`${out} (${((performance.now() - t0) / 1000).toFixed(1)}s) ${await page.textContent('#hud')}`);
}
await browser.close();
server.close();
