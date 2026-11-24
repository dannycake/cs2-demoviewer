#!/usr/bin/env bash
# rip-site.sh [--force]
#
# Exports what the site shows beside the viewer (lib/site.mjs) from pak01_dir.vpk with
# Source2Viewer-CLI into $ASSETS_DIR/raw/site/, keeping VRF's paths:
#   panorama/images/econ/status_icons/skillgroup{0..18,_none}_png.png  the Competitive rank icons
#   panorama/images/icons/ui/steam_logo_white.svg                      the Steam logo
#   models/chicken/chicken.glb                                         the chicken, every clip
#   rip.log                                                            full CLI output of every export
#   rip.json                                   { cs2Build, vrfVersion, exportedAt, files: { <source>: [<file>…] } }
#
# Everything is written into $ASSETS_DIR/raw/site.tmp-<pid>/ and renamed into place only when
# every source gave its file; any failure removes the temp dir and keeps the CLI output as
# $ASSETS_DIR/raw/site.rip-failed.log (lib/rip.sh). Skipped when rip.json from the installed
# CS2 build already exists unless --force is given; one from another build is re-exported.
# The chicken is shrunk by shrink-chicken.mjs, the icons and the logo built by build-site.mjs.
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
pak="$CS2_DIR/game/csgo/pak01_dir.vpk"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
command -v node > /dev/null || die "node is not on PATH (needed for lib/site.mjs and rip.json)"

rip_vrf

# One source of truth: lib/site.mjs. Each line: <VPK file> <the file VRF writes for it>.
# shellcheck disable=SC2016  # ${...} below are JS template literals, not shell expansions
sources_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const k of m.RANK_KEYS) console.log(`${m.rankSource(k)}.vtex_c ${m.rankRaw(k)}`);
  console.log(`${m.STEAM_LOGO_SOURCE}.vsvg_c ${m.STEAM_LOGO_RAW}`);
' "$tools_dir/lib/site.mjs")" || die "could not read the sources from lib/site.mjs"
# shellcheck disable=SC2016  # as above
chicken_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  console.log(`${m.CHICKEN_SOURCE}.vmdl_c ${m.CHICKEN_RAW}`);
' "$tools_dir/lib/site.mjs")" || die "could not read the chicken from lib/site.mjs"

dest="$ASSETS_DIR/raw/site"

if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    printf '%s: the site was already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
    exit 0
  fi
  printf '%s: WARNING: the site was ripped from CS2 build %s but the install is build %s; re-exporting\n' \
    "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
fi

rip_begin "$dest"

start=$SECONDS
files_rows=""
i=0
# export <VPK file> <expected file> [CLI options…]
export_one() {
  local src="$1" want="$2" out
  shift 2
  i=$((i + 1))
  out="$rip_tmp/export-$i"
  mkdir -- "$out"
  rip_cli "$src" -i "$pak" -o "$out" -d -f "$src" "$@"
  [[ -f "$out/$want" ]] || die "export of $src did not write $want"
  files_rows+="$src"$'\t'"$want"$'\n'
  cp -a -- "$out/." "$rip_tmp/"
  rm -rf -- "$out"
}

while read -r src want; do
  [[ "$src" =~ ^panorama/images/[a-z0-9_./]+_c$ ]] || die "lib/site.mjs names an unexpected source: '$src'"
  export_one "$src" "$want"
done <<< "$sources_js"
read -r src want <<< "$chicken_js"
[[ "$src" =~ ^models/[a-z0-9_./]+\.vmdl_c$ ]] || die "lib/site.mjs names an unexpected model: '$src'"
export_one "$src" "$want" --gltf_export_format glb --gltf_export_materials --gltf_textures_adapt --gltf_export_animations

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [cs2Build, vrfVersion, exportedAt, rows] = process.argv.slice(1);
  const files = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [src, file] = line.split("\t");
    (files[src] ??= []).push(file);
  }
  process.stdout.write(JSON.stringify({ cs2Build, vrfVersion, exportedAt, files }, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$files_rows" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"

rip_commit
printf '%s: %d file(s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "$i" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
