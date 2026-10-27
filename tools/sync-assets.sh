#!/usr/bin/env bash
# sync-assets.sh [--dry-run] [--allow-unlisted]
#
# Mirrors the served part of $ASSETS_DIR to $DEMOVIEWER_ASSETS_REMOTE in two passes of
#   rsync -a --delay-updates --exclude /raw --exclude /spike --exclude build.log
#         --exclude '*.tmp-*' --itemize-changes [--dry-run] "$ASSETS_DIR/" "$DEMOVIEWER_ASSETS_REMOTE/"
# the first with --exclude manifest.json --exclude manifest.json.gz (every file but the
# manifests and their gzip siblings, nothing deleted), the second with --delete --delete-delay
# (the manifests, and what the tree no longer has), so a manifest is replaced only once every
# file it lists is there.
# raw/ (VRF exports), spike/ and build.log are never sent, nor a half-written
# <target>.tmp-<pid> of a running script, nor a map's retired files (lib/maps.mjs MAP_RETIRED:
# world_hd.glb and its .gz), which are hidden from the sender only, so pass 2's --delete takes
# them off the remote even from a tree whose maps were shrunk before they retired. /raw and
# /spike are anchored at the tree's top and match a symlink too (a worktree's raw is one, to the shared raw tree), where `raw/` would
# match only a directory and send the link. --delete removes files the local tree no
# longer has (excluded paths on the remote are left alone). rsync creates the remote
# directory itself but never its parents, so a missing parent fails the sync: a server
# whose data disk is not mounted has no parent there, and a created path would land on
# its root filesystem. --dry-run prints what would change and sends nothing.
#
# DEMOVIEWER_ASSETS_REMOTE ([user@]host:/path, or a local path) comes from the environment,
# or else from the DEMOVIEWER_ASSETS_REMOTE= line of $SYNC_ASSETS_CONF (default
# tools/sync-assets.conf, read, never sourced); with neither it refuses. ASSETS_DIR defaults
# to <repo>/assets. Refuses to run while build-assets.sh holds
# $ASSETS_DIR/build.log, when $ASSETS_DIR/manifest.json is missing (build-assets.sh
# removes it when a run starts and writes it at the end), or when a map it lists
# (or an asset kind of lib/kinds.mjs KINDS, when it lists one) has no manifest.json of its
# own, or when a map's manifest lists a retired file, which the sync would delete from beside
# it. It also refuses when the root manifest leaves out a map of lib/maps.mjs MAPS or an asset
# kind of KINDS (absent or null), unless --allow-unlisted is given (a scratch remote, or a tree
# that builds only some of them): a build that failed a map or a kind leaves it unlisted with no
# manifest, and pass 2's --delete would take the remote's manifest of it, so production would
# lose a map or a kind it serves. Every served folder (maps/ and each kind's) goes with the tree.
# Needs neither CS2_DIR nor S2V_CLI, only rsync and node: it reads only what the
# build already wrote.
set -euo pipefail

die() {
  printf '%s: %s\n' "$(basename -- "$0")" "$*" >&2
  exit 1
}

usage() {
  printf 'usage: %s [--dry-run] [--allow-unlisted]\n' "$(basename -- "$0")" >&2
  exit 2
}

dry=()
allow_unlisted=0
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) dry=(--dry-run) ;;
    --allow-unlisted) allow_unlisted=1 ;;
    *) usage ;;
  esac
done

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ASSETS_DIR="${ASSETS_DIR:-$repo/assets}"
conf="${SYNC_ASSETS_CONF:-$repo/tools/sync-assets.conf}"
if [[ -z "${DEMOVIEWER_ASSETS_REMOTE:-}" && -f "$conf" ]]; then
  # The last such line wins; the value is everything after the `=`, trailing blanks dropped.
  DEMOVIEWER_ASSETS_REMOTE="$(sed -n 's/^[[:space:]]*DEMOVIEWER_ASSETS_REMOTE=\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$conf" | tail -n 1)" \
    || die "cannot read $conf"
fi
[[ -n "${DEMOVIEWER_ASSETS_REMOTE:-}" ]] \
  || die "no target: set DEMOVIEWER_ASSETS_REMOTE, or write DEMOVIEWER_ASSETS_REMOTE=[user@]host:/path in $conf"

command -v rsync > /dev/null || die "rsync is not on PATH"
command -v node > /dev/null || die "node is not on PATH"

# The lock first: a running build has removed the root manifest it will rewrite.
if [[ -f "$ASSETS_DIR/build.log" ]]; then
  exec 9< "$ASSETS_DIR/build.log"
  flock -n 9 || die "build-assets.sh is running (it holds $ASSETS_DIR/build.log); sync when it is done"
fi

[[ -f "$ASSETS_DIR/manifest.json" ]] \
  || die "ASSETS_DIR has no manifest.json ('$ASSETS_DIR'); run tools/build-assets.sh first"

retired_list="$(node --input-type=module -e '
  const { MAP_RETIRED } = await import(process.argv[1]);
  for (const f of MAP_RETIRED) console.log(f);
' "$repo/tools/lib/maps.mjs")" || die "cannot read MAP_RETIRED from $repo/tools/lib/maps.mjs"
retired=()
[[ -z "$retired_list" ]] || mapfile -t retired <<< "$retired_list"

# Every map the root manifest lists, and each asset kind (lib/kinds.mjs) when it lists one, must
# still have its own manifest.json: a listed one without it is half rebuilt.
# Every map of lib/maps.mjs MAPS and every kind must be listed: manifest.mjs root lists only the
# maps whose manifest exists (a kind without one is null), and a build removes a map's or a
# kind's manifest when it starts, so one the build failed is missing from the root, and from the
# tree the sync mirrors.
# A map manifest that lists a retired file is from before it retired: the sync deletes that file
# from the remote, and the manifest would name a file that is not there.
problems="$(node --input-type=module -e '
  const fs = await import("node:fs"), path = await import("node:path");
  const [kindsFile, mapsFile, dir, ...retired] = process.argv.slice(1);
  const { KINDS } = await import(kindsFile);
  const { MAPS } = await import(mapsFile);
  const root = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
  const want = Object.keys(root.maps ?? {}).map((m) => path.join("maps", m, "manifest.json"));
  for (const k of KINDS) if (root[k.name]) want.push(path.join(k.name, "manifest.json"));
  for (const f of want) if (!fs.existsSync(path.join(dir, f))) console.log("missing " + f);
  for (const m of MAPS) if (!Object.hasOwn(root.maps ?? {}, m)) console.log("unlisted " + m);
  for (const k of KINDS) if (!root[k.name]) console.log("unlisted " + k.name);
  for (const m of Object.keys(root.maps ?? {})) {
    const f = path.join(dir, "maps", m, "manifest.json");
    if (!fs.existsSync(f)) continue;
    const files = JSON.parse(fs.readFileSync(f, "utf8")).files ?? {};
    if (retired.some((r) => Object.hasOwn(files, r))) console.log("retired " + m);
  }
' "$repo/tools/lib/kinds.mjs" "$repo/tools/lib/maps.mjs" "$ASSETS_DIR" "${retired[@]}")" \
  || die "cannot read the manifests in $ASSETS_DIR"
absent="$(sed -n 's/^missing //p' <<< "$problems")"
[[ -z "$absent" ]] \
  || die "manifest.json lists what has no manifest of its own (${absent//$'\n'/ }); run tools/build-assets.sh"
unlisted="$(sed -n 's/^unlisted //p' <<< "$problems")"
[[ -z "$unlisted" || "$allow_unlisted" -eq 1 ]] \
  || die "manifest.json leaves out ${unlisted//$'\n'/ } (every map of tools/lib/maps.mjs MAPS and kind of tools/lib/kinds.mjs KINDS is listed), so this sync would delete the remote's manifest of each and the viewer would lose them: a build that failed one leaves it out; rebuild them with tools/build-assets.sh <map>... (every run builds every kind too), or pass --allow-unlisted to sync a tree that builds only some of them"
stale="$(sed -n 's/^retired //p' <<< "$problems")"
[[ -z "$stale" ]] \
  || die "the manifests of ${stale//$'\n'/ } list retired files (tools/lib/maps.mjs MAP_RETIRED: ${retired[*]}), which this sync would delete beside them; run node tools/manifest.mjs <map> for each, then node tools/manifest.mjs root"

printf '%s: %s/ -> %s/%s\n' "$(basename -- "$0")" "$ASSETS_DIR" "$DEMOVIEWER_ASSETS_REMOTE" "${dry[*]:+ (dry run)}"
excludes=(--exclude /raw --exclude /spike --exclude build.log --exclude '*.tmp-*')
# H: a sender-side exclude, which unlike --exclude leaves the remote's copies unprotected from
# --delete.
for f in "${retired[@]}"; do excludes+=(--filter "H /maps/*/$f" --filter "H /maps/*/$f.gz"); done
# Two passes, so a manifest is replaced only once every file it lists is in place: a viewer never
# gets a new manifest beside an old world.glb, or one naming a probes.bin or sky.webp that is not
# there yet. The first sends everything but the manifests (any manifest.json, and any
# manifest.json.gz: the server sends a client that accepts gzip the .gz in its place, as it does
# the sounds') and deletes nothing, so an old manifest still finds every file it lists; the second
# sends the manifests and deletes what the tree no longer has, which leaves the remote as one
# `rsync --delete` would.
# --delay-updates/--delete-delay: within a pass, changed files land in .~tmp~/ and are renamed
# into place together at its end, and deletions come after that, so an interrupted pass leaves
# the files it was sending on their old version.
printf '%s: pass 1 of 2, everything but the manifests\n' "$(basename -- "$0")"
rsync -a --delay-updates "${excludes[@]}" --exclude manifest.json --exclude manifest.json.gz \
  --itemize-changes "${dry[@]}" \
  "$ASSETS_DIR/" "$DEMOVIEWER_ASSETS_REMOTE/"
printf '%s: pass 2 of 2, the manifests, and deletions\n' "$(basename -- "$0")"
rsync -a --delete --delete-delay --delay-updates "${excludes[@]}" \
  --itemize-changes "${dry[@]}" \
  "$ASSETS_DIR/" "$DEMOVIEWER_ASSETS_REMOTE/"
