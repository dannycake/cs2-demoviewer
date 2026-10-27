#!/usr/bin/env node
// node tools/check-players.mjs
//
// Checks assets/players/ct.glb and t.glb against the plan's budgets and prints a
// table of actual vs budget. Exits 0 only when every row holds. Per side: size
// ≤ 8 MB, a `.glb.gz` sibling ≤ 2.4 MB, ≥ 80 clips with every one of CLIPS_REQUIRED present, exactly one skin
// with the joint count shrink-player.mjs recorded from the raw export
// (<side>.shrink.json `joints`), JOINTS_0 and WEIGHTS_0 on every primitive of every
// skinned mesh node, and no material that lib/filters.mjs would drop. The side's phone tier
// (<side>_lo.glb, phone-tier.mjs) is optional (a SKIP row without it); when there, its record
// must name this <side>.glb and itself, it must be <side>.glb with every texture over 512 px
// fitted within it and every other byte the same (phoneProblems), no larger, with a .gz. Sizes
// are decimal MB (1 MB = 1,000,000 bytes).
import fs from 'node:fs';
import path from 'node:path';
import { isMain } from './lib/cli.mjs';
import { createIO, countTris, listMaterialsFailing } from './lib/gltf.mjs';
import { collector, exitWithReport } from './lib/report.mjs';
import { clipNames } from './lib/skin.mjs';
import { playerPaths, SIDES, CLIPS_REQUIRED, CLIPS_REQUESTED } from './lib/players.mjs';
import { phonePlayer, phoneRows } from './phone-tier.mjs';

export const BUDGET = Object.freeze({
  // Raw size matters only to a client that refuses gzip; every browser takes the
  // `.glb.gz` sibling, which is the download budget below. Measured 2026-10-22:
  // CT 231 clips 7.32 MB raw / 1.91 MB gz, T 7.27 MB / 2.09 MB (1024 px textures ≈ 1 MB).
  // CS2 build 2000935 (same day) grew both agents' textures: CT 7.71 / 2.16 MB, T 7.58 /
  // 2.26 MB, so the gzip budget went from 2.2 to 2.4 MB.
  bytes: 8e6,
  /** The `<side>.glb.gz` sibling the server sends to clients that accept gzip. */
  gzBytes: 2.4e6,
  minClips: 80,
  skins: 1,
});

/** The rows for assets/players/ (under ASSETS_DIR, read on the call), as the header says. */
export async function checkPlayers() {
  const { rows, row } = collector();
  const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

  const io = await createIO();
  for (const side of SIDES) {
    const P = playerPaths(side);
    const name = `${side}.glb`;
    if (!fs.existsSync(P.glb)) { row(name, 'missing', 'present', false); continue; }

    const size = fs.statSync(P.glb).size;
    row(`${name} size`, mb(size), `≤ ${mb(BUDGET.bytes)}`, size <= BUDGET.bytes);
    if (fs.existsSync(P.gz)) {
      const gzSize = fs.statSync(P.gz).size;
      row(`${name}.gz size`, mb(gzSize), `≤ ${mb(BUDGET.gzBytes)}`, gzSize <= BUDGET.gzBytes);
    } else row(`${name}.gz`, 'missing', 'present', false);

    const doc = await io.read(P.glb);
    const root = doc.getRoot();

    const clips = clipNames(doc);
    const missing = CLIPS_REQUIRED.filter((c) => !clips.includes(c));
    row(`${name} clips`, `${clips.length}${missing.length ? `, missing ${missing.join(' ')}` : ''}`, `≥ ${BUDGET.minClips}, all of CLIPS_REQUIRED`, clips.length >= BUDGET.minClips && missing.length === 0);
    // informational: which requested clips VRF could not match for this side
    const absent = CLIPS_REQUESTED.filter((c) => !clips.includes(c) && !CLIPS_REQUIRED.includes(c));
    rows.push([`${name} optional clips absent`, absent.length ? `${absent.length}: ${absent.join(' ')}` : '0', '—', 'OK']);

    const skins = root.listSkins();
    row(`${name} skins`, skins.length, `${BUDGET.skins}`, skins.length === BUDGET.skins);

    let rawJoints = null;
    if (fs.existsSync(P.shrinkJson)) rawJoints = JSON.parse(fs.readFileSync(P.shrinkJson, 'utf8')).joints ?? null;
    const joints = skins.map((s) => s.listJoints().length).join(', ') || 'none';
    row(`${name} joints`, joints, rawJoints === null ? `${side}.shrink.json joints (missing)` : `${rawJoints} (raw export)`, rawJoints !== null && skins.length === 1 && skins[0].listJoints().length === rawJoints);

    let prims = 0, bad = 0;
    for (const node of root.listNodes()) {
      if (!node.getMesh() || !node.getSkin()) continue;
      for (const p of node.getMesh().listPrimitives()) {
        prims++;
        if (!p.getAttribute('JOINTS_0') || !p.getAttribute('WEIGHTS_0')) bad++;
      }
    }
    row(`${name} skinned primitives`, `${prims - bad}/${prims} with JOINTS_0+WEIGHTS_0`, 'every one, at least one', prims > 0 && bad === 0);

    const failing = listMaterialsFailing(doc);
    row(`${name} materials`, failing.length ? `${failing.length} failing, e.g. ${failing[0].vmat || failing[0].shader}` : '0 failing', 'none dropped by filters.mjs', failing.length === 0);

    // informational: triangles (no budget)
    rows.push([`${name} triangles`, String(countTris(doc)), '—', 'OK']);

    for (const r of await phoneRows(P.out, phonePlayer(side), 'tools/phone-tier.mjs players')) rows.push(r);
  }
  return rows;
}

if (isMain(import.meta.url)) {
  if (process.argv.length > 2) { console.error('usage: node tools/check-players.mjs'); process.exit(1); }
  exitWithReport(`players  (${path.relative(process.cwd(), playerPaths(SIDES[0]).out) || '.'})`, await checkPlayers());
}
