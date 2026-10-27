import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { KINDS } from '../lib/kinds.mjs';
import { MAPS } from '../lib/maps.mjs';

const SYNC_ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'sync-assets.sh');

let root;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-assets-test-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/** The asset kinds (lib/kinds.mjs), each a folder of the tree with its own manifest. */
const KIND_NAMES = KINDS.map((k) => k.name);

/**
 * A root manifest listing every map of MAPS and every kind, which the sync requires by default,
 * and `extra`'s fields.
 */
const rootManifest = (extra = {}) => `${JSON.stringify({
  maps: Object.fromEntries(MAPS.map((m) => [m, {}])),
  ...Object.fromEntries(KIND_NAMES.map((k) => [k, { cs2Build: '2000935' }])),
  ...extra,
})}\n`;

/**
 * <root>/assets: a built tree, every map of MAPS and every kind listed with its manifest and
 * de_mirage with its world, plus raw/ and a half-written file that never go.
 */
function fakeAssets() {
  const assets = path.join(root, 'assets');
  write(path.join(assets, 'manifest.json'), rootManifest());
  for (const m of MAPS) write(path.join(assets, 'maps', m, 'manifest.json'), '{}\n');
  for (const k of KIND_NAMES) write(path.join(assets, k, 'manifest.json'), '{}\n');
  write(path.join(assets, 'maps', 'de_mirage', 'world.glb'), 'glb');
  write(path.join(assets, 'maps', 'de_mirage', 'world.glb.tmp-123'), 'half');
  write(path.join(assets, 'raw', 'de_mirage', 'rip.json'), '{}\n');
  return assets;
}

// A local path stands in for a server's [user@]host:/path: rsync treats both alike. The target
// comes from the environment here; the tests of sync-assets.conf blank it.
const sync = (assets, remote, args = [], env = {}) => spawnSync('bash', [SYNC_ASSETS, ...args], {
  env: { ...process.env, ASSETS_DIR: assets, DEMOVIEWER_ASSETS_REMOTE: remote, ...env },
  encoding: 'utf8',
});

const REAL_RSYNC = spawnSync('bash', ['-c', 'command -v rsync'], { encoding: 'utf8' }).stdout.trim();

/**
 * PATH with an rsync first that runs the real one, then logs its arguments and what the remote
 * holds after it: the manifest's text, world.glb's, whether the gone map's file is there, and the
 * sounds manifest's, its .gz sibling's and a bank's text.
 */
function loggingRsync(remote) {
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'rsync.log');
  write(path.join(bin, 'rsync'), `#!/usr/bin/env bash
${REAL_RSYNC} "$@"
rc=$?
r=${JSON.stringify(remote)}
{
  echo "args: $*"
  echo "manifest: $(cat "$r/manifest.json" 2>/dev/null)"
  echo "world: $(cat "$r/maps/de_mirage/world.glb" 2>/dev/null)"
  echo "gone: $([ -e "$r/maps/de_gone/world.glb" ] && echo there || echo deleted)"
  echo "sounds: $(cat "$r/sounds/manifest.json" 2>/dev/null) | $(cat "$r/sounds/manifest.json.gz" 2>/dev/null) | $(cat "$r/sounds/weapon_ak47.webm" 2>/dev/null)"
} >> ${JSON.stringify(log)}
exit $rc
`);
  fs.chmodSync(path.join(bin, 'rsync'), 0o755);
  return { env: { PATH: `${bin}:${process.env.PATH}` }, calls: () => fs.readFileSync(log, 'utf8').trim().split(/\n(?=args: )/) };
}

/**
 * A remote synced from an older tree: older manifests (every map's and kind's) and world.glb, a
 * map since gone, raw/.
 */
function oldRemote() {
  const remote = path.join(root, 'remote');
  write(path.join(remote, 'manifest.json'), 'old manifest\n');
  for (const m of MAPS) write(path.join(remote, 'maps', m, 'manifest.json'), 'old\n');
  for (const k of KIND_NAMES) write(path.join(remote, k, 'manifest.json'), 'old\n');
  write(path.join(remote, 'maps', 'de_mirage', 'world.glb'), 'old glb');
  write(path.join(remote, 'maps', 'de_gone', 'world.glb'), 'gone');
  write(path.join(remote, 'raw', 'keep.txt'), 'left alone\n');
  return remote;
}

test('sends the served tree into the remote directory, made when its parent exists', () => {
  const assets = fakeAssets();
  fs.mkdirSync(path.join(root, 'disk', 'demoviewer'), { recursive: true });
  const remote = path.join(root, 'disk', 'demoviewer', 'assets');
  const r = sync(assets, remote);
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_mirage', 'world.glb'), 'utf8')).toBe('glb');
  expect(fs.existsSync(path.join(remote, 'manifest.json'))).toBe(true);
  expect(fs.existsSync(path.join(remote, 'raw'))).toBe(false);
  expect(fs.existsSync(path.join(remote, 'maps', 'de_mirage', 'world.glb.tmp-123'))).toBe(false);
});

test('a remote whose parent is missing (the data disk not mounted) fails and creates nothing', () => {
  const assets = fakeAssets();
  const r = sync(assets, path.join(root, 'disk', 'demoviewer', 'assets'));
  expect(r.status).not.toBe(0);
  expect(r.stderr).toMatch(/mkdir .*disk\/demoviewer\/assets.* failed/);
  expect(fs.existsSync(path.join(root, 'disk'))).toBe(false);
});

test('without DEMOVIEWER_ASSETS_REMOTE the target is the last DEMOVIEWER_ASSETS_REMOTE= line of sync-assets.conf', () => {
  const assets = fakeAssets();
  const remote = path.join(root, 'from-conf');
  const conf = path.join(root, 'sync-assets.conf');
  write(conf, `# a comment\nDEMOVIEWER_ASSETS_REMOTE=${path.join(root, 'older')}\nDEMOVIEWER_ASSETS_REMOTE=${remote}  \r\n`);
  const r = sync(assets, '', [], { SYNC_ASSETS_CONF: conf });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).toContain(`-> ${remote}/`);
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_mirage', 'world.glb'), 'utf8')).toBe('glb');
  expect(fs.existsSync(path.join(root, 'older'))).toBe(false);
});

test('DEMOVIEWER_ASSETS_REMOTE in the environment wins over sync-assets.conf', () => {
  const assets = fakeAssets();
  const conf = path.join(root, 'sync-assets.conf');
  write(conf, `DEMOVIEWER_ASSETS_REMOTE=${path.join(root, 'from-conf')}\n`);
  const remote = path.join(root, 'from-env');
  const r = sync(assets, remote, [], { SYNC_ASSETS_CONF: conf });
  expect(r.status, r.stderr).toBe(0);
  expect(fs.existsSync(path.join(remote, 'manifest.json'))).toBe(true);
  expect(fs.existsSync(path.join(root, 'from-conf'))).toBe(false);
});

test('refuses with no target in the environment or sync-assets.conf, and sends nothing', () => {
  const assets = fakeAssets();
  const missing = path.join(root, 'no-such.conf');
  const empty = path.join(root, 'empty.conf');
  write(empty, '# DEMOVIEWER_ASSETS_REMOTE=commented out\nDEMOVIEWER_ASSETS_REMOTE=\n');
  for (const conf of [missing, empty]) {
    const r = sync(assets, '', [], { SYNC_ASSETS_CONF: conf });
    expect(r.status, conf).toBe(1);
    expect(r.stderr).toBe(
      `sync-assets.sh: no target: set DEMOVIEWER_ASSETS_REMOTE, or write DEMOVIEWER_ASSETS_REMOTE=[user@]host:/path in ${conf}\n`
    );
  }
});

test('leaves out raw and spike when they are symlinks, as in a worktree that shares the raw tree', () => {
  const assets = fakeAssets();
  fs.rmSync(path.join(assets, 'raw'), { recursive: true });
  write(path.join(root, 'shared', 'raw', 'de_mirage', 'rip.json'), '{}\n');
  write(path.join(root, 'shared', 'spike', 'notes.txt'), 'spike\n');
  fs.symlinkSync(path.join(root, 'shared', 'raw'), path.join(assets, 'raw'));
  fs.symlinkSync(path.join(root, 'shared', 'spike'), path.join(assets, 'spike'));
  const remote = path.join(root, 'remote');
  const r = sync(assets, remote);
  expect(r.status, r.stderr).toBe(0);
  expect(fs.readdirSync(remote).sort()).toEqual(['manifest.json', 'maps', ...KIND_NAMES].sort());
});

test('sends every file but the manifests first, deleting nothing, then the manifests and the deletions', () => {
  const assets = fakeAssets();
  const remote = oldRemote();
  const rsync = loggingRsync(remote);
  const r = sync(assets, remote, [], rsync.env);
  expect(r.status, r.stderr).toBe(0);
  const [first, second, ...more] = rsync.calls();
  expect(more).toEqual([]);
  // Pass 1: the new world.glb beside the old manifest, and the gone map still there for it.
  expect(first).toMatch(/--exclude manifest\.json/);
  expect(first).not.toMatch(/--delete/);
  expect(first).toContain('manifest: old manifest');
  expect(first).toContain('world: glb');
  expect(first).toContain('gone: there');
  // Pass 2: the manifests, then what the tree no longer has goes.
  expect(second).not.toMatch(/manifest\.json/);
  expect(second).toMatch(/--delete --delete-delay/);
  expect(second).toContain(`manifest: ${rootManifest().trim()}`);
  expect(second).toContain('gone: deleted');
  for (const call of [first, second]) {
    expect(call).toMatch(/--delay-updates/);
    expect(call).toMatch(/--exclude \/raw --exclude \/spike --exclude build\.log --exclude \*\.tmp-\*/);
  }
  // The remote is what one rsync --delete would leave: the tree, and the excluded raw/ untouched.
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_mirage', 'manifest.json'), 'utf8')).toBe('{}\n');
  expect(fs.existsSync(path.join(remote, 'maps', 'de_gone'))).toBe(false);
  expect(fs.readFileSync(path.join(remote, 'raw', 'keep.txt'), 'utf8')).toBe('left alone\n');
  expect(fs.existsSync(path.join(remote, 'maps', 'de_mirage', 'world.glb.tmp-123'))).toBe(false);
});

test("never sends a map's retired world_hd.glb, and the deletion pass takes the remote's copies off", () => {
  const assets = fakeAssets();
  // A map shrunk before world_hd.glb retired still holds it, and the remote has it from then.
  write(path.join(assets, 'maps', 'de_mirage', 'world_hd.glb'), 'hd');
  write(path.join(assets, 'maps', 'de_mirage', 'world_hd.glb.gz'), 'hd gz');
  const remote = oldRemote();
  write(path.join(remote, 'maps', 'de_mirage', 'world_hd.glb'), 'old hd glb');
  write(path.join(remote, 'maps', 'de_mirage', 'world_hd.glb.gz'), 'old hd gz');
  const r = sync(assets, remote);
  expect(r.status, r.stderr).toBe(0);
  expect(r.stdout).not.toMatch(/^>f\S* +maps\/de_mirage\/world_hd/m);
  expect(r.stdout).toMatch(/pass 2 of 2[\s\S]*\*deleting +maps\/de_mirage\/world_hd\.glb\.gz\n[^\n]*\*deleting +maps\/de_mirage\/world_hd\.glb\n/);
  expect(fs.readdirSync(path.join(remote, 'maps', 'de_mirage')).sort()).toEqual(['manifest.json', 'world.glb']);
  // A fresh remote never gets them either; the next shrink of the map removes the local copies.
  const fresh = path.join(root, 'fresh');
  expect(sync(assets, fresh).status).toBe(0);
  expect(fs.readdirSync(path.join(fresh, 'maps', 'de_mirage')).sort()).toEqual(['manifest.json', 'world.glb']);
});

test('refuses while a map manifest from before world_hd.glb retired still lists it, which the sync would delete', () => {
  const assets = fakeAssets();
  write(path.join(assets, 'maps', 'de_mirage', 'manifest.json'), JSON.stringify({ files: { 'world.glb': {}, 'world_hd.glb': {} }, hd: { textureSize: 1024 } }));
  const remote = path.join(root, 'remote');
  const r = sync(assets, remote);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/the manifests of de_mirage list retired files \(tools\/lib\/maps\.mjs MAP_RETIRED: world_hd\.glb\).*node tools\/manifest\.mjs <map> for each, then node tools\/manifest\.mjs root/);
  expect(fs.existsSync(remote)).toBe(false);
  // Written again by manifest.mjs, it lists world.glb alone, and the sync goes ahead.
  write(path.join(assets, 'maps', 'de_mirage', 'manifest.json'), JSON.stringify({ files: { 'world.glb': {} } }));
  expect(sync(assets, remote).status).toBe(0);
});

test('--dry-run runs both passes and changes nothing', () => {
  const assets = fakeAssets();
  const remote = oldRemote();
  const rsync = loggingRsync(remote);
  const r = sync(assets, remote, ['--dry-run'], rsync.env);
  expect(r.status, r.stderr).toBe(0);
  const calls = rsync.calls();
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    expect(call).toMatch(/--dry-run/);
    expect(call).toContain('manifest: old manifest');
    expect(call).toContain('world: old glb');
    expect(call).toContain('gone: there');
  }
  // Pass 1 lists world.glb alone; pass 2 lists it again (nothing was sent), the manifests, and
  // the deletions last.
  expect(r.stdout).toMatch(/pass 1 of 2.*\n[^\n]* maps\/de_mirage\/world\.glb\n[^\n]*pass 2 of 2/);
  expect(r.stdout).toMatch(/pass 2 of 2[\s\S]* manifest\.json[\s\S]*\*deleting +maps\/de_gone\/world\.glb/);
});

test('holds the sounds manifest and its .gz sibling back to the second pass, after the banks', () => {
  const assets = fakeAssets();
  write(path.join(assets, 'manifest.json'), rootManifest({ sounds: { cs2Build: '2000935', banks: 1 } }));
  write(path.join(assets, 'sounds', 'manifest.json'), 'new manifest');
  write(path.join(assets, 'sounds', 'manifest.json.gz'), 'the new gz');
  write(path.join(assets, 'sounds', 'weapon_ak47.webm'), 'new bank');
  const remote = oldRemote();
  // Sizes differ from the new files': rsync's quick check skips a file of the same size and second.
  write(path.join(remote, 'sounds', 'manifest.json'), 'an old manifest');
  write(path.join(remote, 'sounds', 'manifest.json.gz'), 'an old gz');
  const rsync = loggingRsync(remote);
  const r = sync(assets, remote, [], rsync.env);
  expect(r.status, r.stderr).toBe(0);
  const [first, second] = rsync.calls();
  // A gzip client is sent the .gz in place of the manifest, so it waits for the second pass too.
  expect(first).toMatch(/--exclude manifest\.json --exclude manifest\.json\.gz/);
  expect(first).toContain('sounds: an old manifest | an old gz | new bank');
  expect(second).toContain('sounds: new manifest | the new gz | new bank');
});

test('refuses when the root manifest lists the sounds and sounds/ has no manifest.json', () => {
  const assets = fakeAssets();
  write(path.join(assets, 'manifest.json'), rootManifest({ sounds: { cs2Build: '2000935', banks: 90 } }));
  fs.rmSync(path.join(assets, 'sounds', 'manifest.json'));
  write(path.join(assets, 'sounds', 'manifest.json.gz'), 'gz'); // a .gz alone is not a manifest
  const remote = path.join(root, 'remote');
  const r = sync(assets, remote);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/lists what has no manifest of its own \(sounds\/manifest\.json\)/);
  expect(fs.existsSync(remote)).toBe(false);
});

test('refuses when the root manifest leaves out a map of MAPS, whose remote manifest pass 2 would delete, unless --allow-unlisted', () => {
  const assets = fakeAssets();
  // A build that failed two maps: their manifests removed when their builds started, and the root
  // written from the manifests left.
  const failed = ['de_nuke', 'de_train'];
  for (const m of failed) fs.rmSync(path.join(assets, 'maps', m, 'manifest.json'));
  const listed = JSON.parse(rootManifest());
  for (const m of failed) delete listed.maps[m];
  write(path.join(assets, 'manifest.json'), `${JSON.stringify(listed)}\n`);
  const remote = oldRemote();
  const before = fs.readdirSync(remote, { recursive: true }).map(String).sort();
  const r = sync(assets, remote);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/manifest\.json leaves out de_nuke de_train \(every map of tools\/lib\/maps\.mjs MAPS and kind of tools\/lib\/kinds\.mjs KINDS is listed\), so this sync would delete the remote's manifest of each.*tools\/build-assets\.sh <map>\.\.\..*--allow-unlisted/);
  expect(r.stdout).toBe('');
  // Nothing sent and nothing deleted: production still serves both maps.
  expect(fs.readdirSync(remote, { recursive: true }).map(String).sort()).toEqual(before);
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_nuke', 'manifest.json'), 'utf8')).toBe('old\n');
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_mirage', 'world.glb'), 'utf8')).toBe('old glb');
  // A tree that builds only some maps, said so: the sync goes ahead, and mirrors it.
  const partial = sync(assets, remote, ['--allow-unlisted']);
  expect(partial.status, partial.stderr).toBe(0);
  for (const m of failed) expect(fs.existsSync(path.join(remote, 'maps', m, 'manifest.json')), m).toBe(false);
  expect(fs.readFileSync(path.join(remote, 'maps', 'de_mirage', 'world.glb'), 'utf8')).toBe('glb');
  // The flag is spelled out; anything else is a usage error.
  const typo = sync(assets, remote, ['--allow']);
  expect(typo.status).toBe(2);
  expect(typo.stderr).toMatch(/^usage: sync-assets\.sh \[--dry-run\] \[--allow-unlisted\]/);
});

test('refuses when the root manifest lists a kind as null (its build failed) or not at all, unless --allow-unlisted', () => {
  const assets = fakeAssets();
  // A run whose sounds build failed: its manifest removed when the kind started, and the root
  // written with sounds null; an older root without the effects key at all.
  fs.rmSync(path.join(assets, 'sounds', 'manifest.json'));
  const kinds = JSON.parse(rootManifest({ sounds: null }));
  delete kinds.effects;
  write(path.join(assets, 'manifest.json'), `${JSON.stringify(kinds)}\n`);
  const remote = oldRemote();
  const before = fs.readdirSync(remote, { recursive: true }).map(String).sort();
  const r = sync(assets, remote);
  expect(r.status).toBe(1);
  expect(r.stderr).toMatch(/manifest\.json leaves out effects sounds \(every map .* KINDS is listed\), so this sync would delete the remote's manifest of each/);
  expect(fs.readdirSync(remote, { recursive: true }).map(String).sort()).toEqual(before);
  expect(fs.readFileSync(path.join(remote, 'sounds', 'manifest.json'), 'utf8')).toBe('old\n');
  const partial = sync(assets, remote, ['--allow-unlisted']);
  expect(partial.status, partial.stderr).toBe(0);
  expect(fs.existsSync(path.join(remote, 'sounds', 'manifest.json'))).toBe(false);
  expect(fs.readFileSync(path.join(remote, 'effects', 'manifest.json'), 'utf8')).toBe('{}\n');
});
