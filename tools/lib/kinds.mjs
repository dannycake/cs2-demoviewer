// The asset kinds built once a run, after the maps: one entry each, in the order build-assets.sh
// builds them. Adding a kind is an entry here (with its scripts, and its manifest builder in
// manifest.mjs KIND_MANIFESTS, which a test holds to this list), and a route for its folder in
// the server, which serves each kind by name (server/crates/server/src/app.rs, and config.rs's
// list of what DEMOVIEWER_ASSETS serves); nothing else in tools/ lists the kinds:
// - build-assets.sh runs each kind's plan (`node tools/lib/kinds.mjs plan`): its manifest
//   removed, its steps (a rip-*.sh step gets the run's --force), its check, then
//   `manifest.mjs <kind>`, which writes the manifest only once the check passed;
// - manifest.mjs writes `<kind>/manifest.json` (and its .gz with `gz`) and the kind's line in
//   the root manifest (`root`, printed by `rootLine`);
// - sync-assets.sh refuses a root manifest that lists a kind without its own manifest, or leaves
//   a kind out (null: its build failed), unless --allow-unlisted.
// Every kind lives in ASSETS_DIR/<name>/ from ASSETS_DIR/raw/<name>/ (kindPaths).
import path from 'node:path';
import { isMain } from './cli.mjs';
import { assetsDir } from './paths.mjs';

const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
const count = (o) => Object.keys(o ?? {}).length;

/**
 * @typedef {object} Kind
 * @property {string} name  the folder under ASSETS_DIR and the argument to manifest.mjs
 * @property {string[][]} steps  the build, each `[script, ...args]` in tools/; a rip-*.sh gets --force
 * @property {string} check  the gate script: the manifest is written only when it exits 0
 * @property {boolean} gz  the manifest has a gzip sibling, removed and written with it (the server
 *   would still send a gzip client a stale one)
 * @property {(m: object) => object} root  the kind's entry in the root manifest, from its manifest
 * @property {(r: object) => string} rootLine  that entry as manifest.mjs root logs it
 */

/** @type {readonly Kind[]} */
export const KINDS = Object.freeze([
  {
    name: 'players',
    steps: [['rip-players.sh'], ['shrink-player.mjs', 'ct'], ['shrink-player.mjs', 't'], ['phone-tier.mjs', 'players']],
    check: 'check-players.mjs',
    gz: false,
    root: (m) => ({ cs2Build: m.cs2Build }),
    rootLine: (r) => `build ${r.cs2Build}`,
  },
  {
    name: 'weapons',
    steps: [['rip-weapons.sh'], ['shrink-weapon.mjs', 'all']],
    check: 'check-weapons.mjs',
    gz: false,
    root: (m) => ({ cs2Build: m.cs2Build, count: count(m.weapons) }),
    rootLine: (r) => `${r.count} (build ${r.cs2Build})`,
  },
  // After the players: the arms come from the players' raw export.
  {
    name: 'viewmodels',
    steps: [['rip-viewmodels.sh'], ['shrink-arms.mjs', 'all'], ['shrink-viewmodel-clips.mjs', 'all']],
    check: 'check-viewmodels.mjs',
    gz: false,
    root: (m) => ({ cs2Build: m.cs2Build, arms: Object.keys(m.arms ?? {}).sort(), count: count(m.weapons) }),
    rootLine: (r) => `${r.arms.join('+')} arms, ${r.count} clip files (build ${r.cs2Build})`,
  },
  {
    name: 'effects',
    steps: [['rip-effects.sh'], ['build-effects.mjs']],
    check: 'check-effects.mjs',
    gz: false,
    root: (m) => {
      const list = Object.values(m.atlases ?? {});
      return { cs2Build: m.cs2Build, count: list.length, bytes: list.reduce((n, a) => n + a.bytes, 0) };
    },
    rootLine: (r) => `${r.count} atlases, ${mb(r.bytes)} (build ${r.cs2Build})`,
  },
  // check-sounds.mjs counts the step sets of de_mirage's hull.glb, so this runs after the maps
  // (as every kind does).
  {
    name: 'sounds',
    steps: [['rip-sounds.sh'], ['build-sounds.mjs']],
    check: 'check-sounds.mjs',
    gz: true,
    root: (m) => ({ cs2Build: m.cs2Build, banks: count(m.banks) }),
    rootLine: (r) => `${r.banks} banks (build ${r.cs2Build})`,
  },
  // The site's own images (lib/site.mjs). The homepage video under site/home/ is made apart, by
  // tools/home-video.sh, which writes this manifest again once it is there. Each map's strip is
  // made from its hero.png, so this runs after the maps (as every kind does).
  {
    name: 'site',
    steps: [['rip-site.sh'], ['build-site.mjs'], ['shrink-chicken.mjs']],
    check: 'check-site.mjs',
    gz: false,
    root: (m) => ({ cs2Build: m.cs2Build, ranks: count(m.ranks), maps: count(m.maps), home: Boolean(m.home) }),
    rootLine: (r) => `${r.ranks} rank icons, ${r.maps} map strips, ${r.home ? 'with' : 'no'} homepage video (build ${r.cs2Build})`,
  },
].map((k) => Object.freeze({ ...k, steps: Object.freeze(k.steps.map((s) => Object.freeze(s))) })));

/** The kind named `name`, or undefined. */
export const kindOf = (name) => KINDS.find((k) => k.name === name);

/** Where `kind` lives: `out` (ASSETS_DIR/<name>), `raw` (ASSETS_DIR/raw/<name>), `manifest` and its `.gz` with `gz`. */
export function kindPaths(kind) {
  const out = path.join(assetsDir(), kind.name);
  const manifest = path.join(out, 'manifest.json');
  return { out, raw: path.join(assetsDir(), 'raw', kind.name), manifest, manifests: kind.gz ? [manifest, `${manifest}.gz`] : [manifest] };
}

/**
 * build-assets.sh's plan, one line per action in order, each `<kind> <action> <words…>`:
 * `rm <file>` (the manifest and its .gz, relative to ASSETS_DIR), then `rip <script> <args…>` or
 * `step <script> <args…>` for each step (a rip-*.sh is a `rip`, which takes --force), the check,
 * and `manifest.mjs <kind>`.
 * @param {readonly Kind[]} [kinds]
 * @returns {string[]}
 */
export function buildPlan(kinds = KINDS) {
  const lines = [];
  for (const k of kinds) {
    for (const f of k.gz ? ['manifest.json', 'manifest.json.gz'] : ['manifest.json']) lines.push(`${k.name} rm ${k.name}/${f}`);
    for (const [script, ...args] of k.steps) lines.push([k.name, /^rip-.*\.sh$/.test(script) ? 'rip' : 'step', script, ...args].join(' '));
    lines.push(`${k.name} step ${k.check}`, `${k.name} step manifest.mjs ${k.name}`);
  }
  return lines;
}

if (isMain(import.meta.url)) {
  const [what, ...rest] = process.argv.slice(2);
  if (what === 'names' && !rest.length) console.log(KINDS.map((k) => k.name).join(' '));
  else if (what === 'plan' && !rest.length) console.log(buildPlan().join('\n'));
  else {
    console.error('usage: node tools/lib/kinds.mjs names|plan');
    process.exit(2);
  }
}
