#!/usr/bin/env bash
# rip-viewmodels.sh [--force]
#
# Exports every viewmodel clip folder the viewer uses (VIEWMODEL_DIR_LIST in lib/viewmodels.mjs,
# e.g. rifle/rifle_ak) from pak01_dir.vpk with Source2Viewer-CLI, one GLB per clip
# (`-f animation/anims/viewmodel/<dir>/ -e vnmclip_c`), into $ASSETS_DIR/raw/viewmodels/:
#   <dir>/<clip>.glb   e.g. rifle/rifle_ak/idle_ak.glb: the clip on the viewmodel skeleton
#                      (animation/skeletons/characters/viewmodel.vnmskel) plus the weapon's
#                      own skeleton, each with a placeholder mesh
#   rip.log            full CLI output of every export
#   rip.json           { cs2Build, vrfVersion, exportedAt, dirs: { <dir>: [<clip>...] } }
#
# Everything is written into $ASSETS_DIR/raw/viewmodels.tmp-<pid>/ and renamed into place only
# when every folder produced at least one GLB; any failure removes the temp dir and keeps the
# CLI output as $ASSETS_DIR/raw/viewmodels.rip-failed.log (lib/rip.sh). Skipped when rip.json
# from the installed CS2 build already exists unless --force is given; one from another build
# is re-exported. About 30 s for the 45 folders (362 clips, 55 MB).
set -euo pipefail

usage() {
  printf 'usage: %s [--force]\n' "$(basename -- "$0")" >&2
  exit 2
}

force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    *) usage ;;
  esac
done

# Exits 1 naming CS2_DIR or S2V_CLI when either does not resolve.
# shellcheck source=lib/env.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/env.sh"
# shellcheck source=lib/rip.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/rip.sh"

tools_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
game_dir="$CS2_DIR/game/csgo"
pak="$game_dir/pak01_dir.vpk"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
command -v node > /dev/null || die "node is not on PATH (needed for lib/viewmodels.mjs and rip.json)"

rip_vrf

# One source of truth for the folders: lib/viewmodels.mjs.
dirs_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const d of m.VIEWMODEL_DIR_LIST) console.log(d);
' "$tools_dir/lib/viewmodels.mjs")" || die "could not read VIEWMODEL_DIR_LIST from lib/viewmodels.mjs"
dirs=()
while read -r d; do
  [[ -n "$d" ]] || continue
  [[ "$d" =~ ^[a-z0-9_]+/[a-z0-9_]+$ ]] || die "lib/viewmodels.mjs names an unexpected folder: '$d'"
  dirs+=("$d")
done <<< "$dirs_js"
[[ "${#dirs[@]}" -gt 0 ]] || die "lib/viewmodels.mjs gave no folders"

dest="$ASSETS_DIR/raw/viewmodels"

if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    printf '%s: viewmodel clips already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
    exit 0
  fi
  printf '%s: WARNING: viewmodel clips were ripped from CS2 build %s but the install is build %s; re-exporting\n' \
    "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
fi

rip_begin "$dest"

start=$SECONDS
clips=0
for d in "${dirs[@]}"; do
  out="$rip_tmp/export"
  rm -rf -- "$out"
  mkdir -- "$out"
  rip_cli "animation/anims/viewmodel/$d/" -i "$pak" -f "animation/anims/viewmodel/$d/" -e vnmclip_c -d -o "$out" \
    --gltf_export_format glb --game "$game_dir/gameinfo.gi"
  # VRF writes <out>/animation/anims/viewmodel/<dir>/<clip>.glb.
  src="$out/animation/anims/viewmodel/$d"
  n="$(find "$src" -maxdepth 1 -name '*.glb' -size +0 2> /dev/null | wc -l)"
  [[ "$n" -gt 0 ]] || die "export produced no clip GLB for $d"
  mkdir -p -- "$rip_tmp/${d%/*}"
  mv -- "$src" "$rip_tmp/$d"
  rm -rf -- "$out"
  clips=$((clips + n))
done

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node --input-type=module -e '
  const fs = await import("node:fs");
  const path = await import("node:path");
  const [cs2Build, vrfVersion, exportedAt, root, ...dirs] = process.argv.slice(1);
  const out = {};
  for (const d of dirs) out[d] = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(".glb")).map((f) => f.slice(0, -4)).sort();
  process.stdout.write(JSON.stringify({ cs2Build, vrfVersion, exportedAt, dirs: out }, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$rip_tmp" "${dirs[@]}" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"

rip_commit
printf '%s: %d folder(s), %d clip(s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "${#dirs[@]}" "$clips" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
