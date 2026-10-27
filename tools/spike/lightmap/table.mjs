// Spike (Task 1b): the per-tier first-load table from tiers.mjs's tiers.jsonl.
//   node tools/spike/lightmap/table.mjs
// First load = world.glb.gz + lightmap WebP + probes.bin.gz + every radar section + overview.json +
// manifest.json. "today" is the shipped build in assets/maps/<map>; the cap is today + 2.5 MB.
// Probe bytes are probes.mjs's 2.5 m floor-band grid (players need it on every tier but today).
import fs from 'node:fs';
import path from 'node:path';

const MAPS = {
  de_mirage: { label: 'Mirage', range: 8, probes: 176559 },
  de_nuke: { label: 'Nuke', range: 16, probes: 321348 },
};
const ROWS = [
  // [label, tiers.jsonl name, lightmap px or 0, probes?]
  ['today (rebuilt by tiers.mjs)', 'today', 0, false],
  ['V', 'V', 0, true],
  ['V, 6-bit light', 'V-6bit', 0, true],
  ['L1024', 'L', 1024, true],
  ['L2048', 'L', 2048, true],
  ['L1024, permissive simplify w=10 (UVs break)', 'L-perm10', 1024, true],
  ['H2 + 1024', 'H2', 1024, true],
  ['H2 + 2048', 'H2', 2048, true],
  ['H2 + 1024, 6-bit light', 'H2-6bit', 1024, true],
  ['H2 + 2048, 6-bit light', 'H2-6bit', 2048, true],
];
const MB = (b) => (b / 1e6).toFixed(2);
for (const [map, M] of Object.entries(MAPS)) {
  const dir = path.join('assets/maps', map), base = path.join('assets/spike/lm', map);
  const size = (f) => fs.statSync(f).size;
  const overview = JSON.parse(fs.readFileSync(path.join(dir, 'overview.json'), 'utf8'));
  const extra = (overview.sections ?? [{ image: 'radar.png' }]).reduce((s, x) => s + size(path.join(dir, x.image)), 0)
    + size(path.join(dir, 'overview.json')) + size(path.join(dir, 'manifest.json'));
  const shipped = JSON.parse(fs.readFileSync(path.join(dir, 'shrink.json'), 'utf8'));
  const today = shipped.gzBytes.world + extra, cap = today + 2.5e6;
  const tiers = {};
  for (const line of fs.readFileSync(path.join(base, 'tiers.jsonl'), 'utf8').split('\n')) if (line) { const t = JSON.parse(line); tiers[t.name] = t; }
  console.log(`\n### ${M.label}\n\nRadar + overview + manifest: ${extra} B. Cap = today + 2.5 MB = ${MB(cap)} MB.\n`);
  console.log('| Tier | world.glb.gz | Triangles | Lightmap | Probes | First load | vs today | Cap |');
  console.log('|---|---|---|---|---|---|---|---|');
  console.log(`| today (shipped) | ${shipped.gzBytes.world.toLocaleString('en')} | ${shipped.trisOut.toLocaleString('en')} | — | — | ${MB(today)} MB | — | ok |`);
  for (const [label, name, lm, probes] of ROWS) {
    const t = tiers[name];
    if (!t) continue;
    const lmBytes = lm ? size(path.join(base, `light_${lm}_r${M.range}_q60.webp`)) : 0;
    const pb = probes ? M.probes : 0;
    const total = t.gzBytes + lmBytes + pb + extra;
    const d = total - today;
    console.log(`| ${label} | ${t.gzBytes.toLocaleString('en')} | ${t.tris.toLocaleString('en')} | ${lm ? lmBytes.toLocaleString('en') : '—'} | ${pb ? pb.toLocaleString('en') : '—'} | ${MB(total)} MB | ${d >= 0 ? '+' : ''}${MB(d)} MB | ${total <= cap ? 'ok' : `over by ${MB(total - cap)}`} |`);
  }
}
