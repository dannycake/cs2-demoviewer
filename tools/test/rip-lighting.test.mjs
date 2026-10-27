// rip-lighting.sh's lightmaps/ group against a stand-in CS2 install and Source2Viewer-CLI: what
// it exports, the D6 probe-slice invariant, and a map whose VPK has no baked light, which fails
// for a map in LIGHTMAP_MAPS and records no bake for one outside it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { lightmapInputs } from '../lib/lightmap.mjs';
import { LIGHTMAP_MAPS } from '../lib/maps.mjs';

const RIP_LIGHTING = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'rip-lighting.sh');
/** A map outside LIGHTMAP_MAPS, and one on it (every map the pipeline builds). */
const MAP = 'de_test';
const BAKED = 'de_mirage';
const ALL = ['irradiance', 'env_light_probe_volume_atlas', 'env_light_probe_volume_atlas_dlshd', 'debug_chart_color', 'direct_light_shadows'];

// The CLI: `--version`; `-l -f <path>` prints <path> when FAKE_LIST names it; an export writes
// what VRF writes for each requested texture (FAKE_D z slices of _dlshd and FAKE_ATLAS of the atlas).
const FAKE_CLI = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == --version ]]; then echo "Version: 0.0-test"; exit 0; fi
filter="" out="" list=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -f) filter="$2"; shift 2 ;;
    -o) out="$2"; shift 2 ;;
    -l) list=1; shift ;;
    *) shift ;;
  esac
done
if [[ "$list" -eq 1 ]]; then grep -xF -- "$filter" "$FAKE_LIST" || true; exit 0; fi
IFS=, read -r -a files <<< "$filter"
for f in "\${files[@]}"; do
  d="$out/$(dirname -- "$f")"; base="$(basename -- "$f" .vtex_c)"; mkdir -p -- "$d"
  case "$base" in
    irradiance) echo exr > "$d/irradiance.exr" ;;
    env_light_probe_volume_atlas) for ((z = 0; z < FAKE_ATLAS; z++)); do printf -v n '%03d' "$z"; echo exr > "$d/\${base}_z$n.exr"; done ;;
    env_light_probe_volume_atlas_dlshd) for ((z = 0; z < FAKE_D; z++)); do printf -v n '%03d' "$z"; echo png > "$d/\${base}_z$n.png"; done ;;
    *) echo png > "$d/$base.png" ;;
  esac
done
`;

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'rip-lighting-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// A path every map VPK holds: rip-lighting.sh's check that the CLI's listing works at all.
const control = (map) => `maps/${map}/entities/default_ents.vents_c`;
const SKY = '====1====\nskyname resource_name:"materials/skybox/sky_test.vmat"\nclassname "env_sky"\nangles [ 0.0, 0.0, 0.0 ]\n';

/**
 * Runs rip-lighting.sh `map` against a stand-in install whose map VPK lists `listed` textures
 * (and its entity lump unless `listing` is false); `sky` adds an enabled env_sky to the entities.
 */
function rip({ map = MAP, listed = ALL, directlight = '1', d = 2, atlas = 6 * d, listing = true, sky = false } = {}) {
  const cs2 = path.join(root, 'cs2');
  write(path.join(cs2, 'game/csgo/gameinfo.gi'), 'GameInfo {}\n');
  write(path.join(cs2, 'game/csgo/steam.inf'), 'ClientVersion=1234567\n');
  write(path.join(cs2, `game/csgo/maps/${map}.vpk`), 'vpk');
  write(path.join(cs2, 'game/csgo/pak01_dir.vpk'), 'vpk');
  const cli = path.join(root, 'bin', 'Source2Viewer-CLI');
  write(cli, FAKE_CLI);
  fs.chmodSync(cli, 0o755);
  const list = path.join(root, 'list.txt');
  write(list, [...listed.map((t) => `maps/${map}/lightmaps/${t}.vtex_c`), ...(listing ? [control(map)] : [])].map((l) => `${l}\n`).join(''));
  const assets = path.join(root, 'assets');
  write(
    path.join(assets, 'raw', map, 'entities', 'default_ents.vents'),
    `====0====\nbakedshadowindex "0"\nenabled true\ncolor [ 255, 255, 255 ]\nbrightness 2.0\ndirectlight "${directlight}"\nclassname "light_environment"\nangles [ 60.0, 0.0, 0.0 ]\n${sky ? SKY : ''}`
  );
  const r = spawnSync('bash', [RIP_LIGHTING, map], {
    env: { ...process.env, CS2_DIR: cs2, S2V_CLI: cli, ASSETS_DIR: assets, FAKE_LIST: list, FAKE_D: String(d), FAKE_ATLAS: String(atlas) },
    encoding: 'utf8',
  });
  return { ...r, lightmaps: path.join(assets, 'raw', map, 'lightmaps') };
}

const json = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'lightmaps.json'), 'utf8'));

test('exports the textures, the probe slices and lightmaps.json; the shrink side gets their paths', () => {
  const r = rip();
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(json(r.lightmaps)).toMatchObject({ map: MAP, sunBaked: true, textures: ALL, atlasSlices: 12, dlshdSlices: 2, cs2Build: '1234567' });
  for (const f of ['irradiance.exr', 'direct_light_shadows.png', 'debug_chart_color.png', 'env_light_probe_volume_atlas_z011.exr', 'env_light_probe_volume_atlas_dlshd_z001.png']) {
    expect(fs.existsSync(path.join(r.lightmaps, f))).toBe(true);
  }
  expect(lightmapInputs(r.lightmaps)).toMatchObject({ irradiance: path.join(r.lightmaps, 'irradiance.exr'), probes: true });
});

test('leaves out direct_light_shadows when the sun is dynamic', () => {
  const r = rip({ directlight: '3' });
  expect(r.status).toBe(0);
  expect(json(r.lightmaps)).toMatchObject({ sunBaked: false, textures: ALL.slice(0, 4) });
  expect(fs.existsSync(path.join(r.lightmaps, 'direct_light_shadows.png'))).toBe(false);
});

test('a map outside LIGHTMAP_MAPS whose VPK has no baked light succeeds, records none, and the shrink side bakes nothing', () => {
  const r = rip({ listed: [] });
  expect(r.status).toBe(0);
  expect(r.stdout).toMatch(/no irradiance/);
  expect(json(r.lightmaps)).toMatchObject({ map: MAP, textures: [], atlasSlices: 0, dlshdSlices: 0 });
  expect(fs.readdirSync(r.lightmaps).sort()).toEqual(['lightmaps.json', 'rip.log']);
  expect(lightmapInputs(r.lightmaps)).toBeNull();
});

test('a probe export that is not 6 atlas slices per shadow slice fails, and nothing replaces the group', () => {
  const r = rip({ d: 2, atlas: 11 });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/11 .*6 × 2/);
  expect(fs.existsSync(r.lightmaps)).toBe(false);
  expect(fs.existsSync(path.join(path.dirname(r.lightmaps), 'lightmaps.rip-failed.log'))).toBe(true);
});

test('on a map outside LIGHTMAP_MAPS, a texture the VPK lacks is left out with a warning, and that half-set is no bake', () => {
  const r = rip({ listed: ALL.filter((t) => t !== 'debug_chart_color') });
  expect(r.status).toBe(0);
  expect(r.stderr).toMatch(/WARNING: de_test\.vpk has no debug_chart_color/);
  expect(json(r.lightmaps).textures).toEqual(ALL.filter((t) => t !== 'debug_chart_color'));
  expect(fs.existsSync(path.join(r.lightmaps, 'debug_chart_color.png'))).toBe(false);
  expect(lightmapInputs(r.lightmaps)).toBeNull();
});

/** An export of `map` from an earlier CS2 build, which the next rip re-exports; returns its lightmaps.json. */
const earlier = (map) => {
  const file = path.join(root, 'assets', 'raw', map, 'lightmaps', 'lightmaps.json');
  write(file, `${JSON.stringify({ map, sunBaked: true, textures: ALL, cs2Build: '1111111' })}\n`);
  return file;
};

test('a map in LIGHTMAP_MAPS whose VPK has no baked light fails before exporting anything, and its last export stays', () => {
  expect(LIGHTMAP_MAPS).toContain(BAKED);
  const last = earlier(BAKED);
  const before = fs.readFileSync(last, 'utf8');
  const r = rip({ map: BAKED, listed: [] });
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/de_mirage\.vpk has no irradiance in maps\/de_mirage\/lightmaps, so de_mirage would build without CS2's baked light; it is in LIGHTMAP_MAPS/);
  expect(fs.readFileSync(last, 'utf8')).toBe(before);
  expect(fs.readdirSync(r.lightmaps)).toEqual(['lightmaps.json']);
});

test('a map in LIGHTMAP_MAPS whose VPK lacks any one texture of the bake fails naming it, rather than record a half-set', () => {
  for (const t of ALL.slice(1)) {
    const r = rip({ map: BAKED, listed: ALL.filter((x) => x !== t) });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(new RegExp(`de_mirage\\.vpk has no ${t} in .*LIGHTMAP_MAPS`));
    expect(fs.existsSync(r.lightmaps)).toBe(false);
  }
});

test('a map in LIGHTMAP_MAPS with the whole bake exports it; a dynamic sun needs no direct_light_shadows', () => {
  let r = rip({ map: BAKED });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(json(r.lightmaps)).toMatchObject({ map: BAKED, sunBaked: true, textures: ALL });
  fs.rmSync(r.lightmaps, { recursive: true });
  r = rip({ map: BAKED, directlight: '3', listed: ALL.slice(0, 4) });
  expect(r.status).toBe(0);
  expect(json(r.lightmaps)).toMatchObject({ sunBaked: false, textures: ALL.slice(0, 4) });
  expect(lightmapInputs(r.lightmaps)).toMatchObject({ shadow: null, probes: true });
});

test('a listing that does not show the entity lump fails rather than recording no baked light', () => {
  const r = rip({ listed: [], listing: false });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/did not list maps\/de_test\/entities\/default_ents\.vents_c/);
  expect(fs.existsSync(r.lightmaps)).toBe(false);
});

test('the sky lookup fails the same way rather than guessing which VPK holds the material', () => {
  const r = rip({ sky: true, listing: false });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/did not list maps\/de_test\/entities\/default_ents\.vents_c/);
  expect(fs.existsSync(path.join(path.dirname(r.lightmaps), 'sky'))).toBe(false);
});
