#!/usr/bin/env bash
# rip-effects.sh [--force]
#
# Exports every source texture of the effect atlases (EFFECT_SOURCES in lib/effects.mjs) from
# pak01_dir.vpk with Source2Viewer-CLI into $ASSETS_DIR/raw/effects/, keeping VRF's paths:
#   materials/.../<name>_seq<S>_<F>.png  one PNG per flipbook frame, cropped to its content
#   materials/.../<name>.mks             the sheet's sequences (a texture without one is <name>.png)
#   rip.log                              full CLI output of every export
#   rip.json                             { cs2Build, vrfVersion, exportedAt, files: { <vtex>: [<file>…] } }
#
# Everything is written into $ASSETS_DIR/raw/effects.tmp-<pid>/ and renamed into place only
# when every texture gave at least one PNG; any failure removes the temp dir and keeps the CLI
# output as $ASSETS_DIR/raw/effects.rip-failed.log (lib/rip.sh). Skipped when rip.json from the
# installed CS2 build already exists unless --force is given; one from another build is
# re-exported. About 1 s per texture.
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
command -v node > /dev/null || die "node is not on PATH (needed for lib/effects.mjs and rip.json)"

rip_vrf

# One source of truth for the textures: lib/effects.mjs.
sources_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const v of m.EFFECT_SOURCES) console.log(v);
' "$tools_dir/lib/effects.mjs")" || die "could not read EFFECT_SOURCES from lib/effects.mjs"
sources=()
while read -r vtex; do
  [[ -n "$vtex" ]] || continue
  [[ "$vtex" =~ ^materials/[a-z0-9_./]+$ ]] || die "lib/effects.mjs names an unexpected texture: '$vtex'"
  sources+=("$vtex")
done <<< "$sources_js"
[[ "${#sources[@]}" -gt 0 ]] || die "lib/effects.mjs gave no textures"

dest="$ASSETS_DIR/raw/effects"

if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    printf '%s: effects already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
    exit 0
  fi
  printf '%s: WARNING: effects were ripped from CS2 build %s but the install is build %s; re-exporting\n' \
    "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
fi

rip_begin "$dest"

start=$SECONDS
files_rows=""
i=0
for vtex in "${sources[@]}"; do
  i=$((i + 1))
  out="$rip_tmp/export-$i"
  mkdir -- "$out"
  rip_cli "$vtex" -i "$pak" -o "$out" -d -f "$vtex.vtex_c"
  # VRF writes <out>/<vtex dir>/<name>[_seq<S>_<F>].png (and <name>.mks for a sheet).
  listing="$(cd -- "$out" && find . -type f \( -name '*.png' -o -name '*.mks' \) | sed 's|^\./||' | LC_ALL=C sort)"
  grep -q '\.png$' <<< "$listing" || die "export of $vtex produced no PNG (expected under '${vtex%/*}/')"
  while read -r f; do
    files_rows+="$vtex"$'\t'"$f"$'\n'
  done <<< "$listing"
  cp -a -- "$out/." "$rip_tmp/"
  rm -rf -- "$out"
done

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [cs2Build, vrfVersion, exportedAt, rows] = process.argv.slice(1);
  const files = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [vtex, file] = line.split("\t");
    (files[vtex] ??= []).push(file);
  }
  process.stdout.write(JSON.stringify({ cs2Build, vrfVersion, exportedAt, files }, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$files_rows" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"

rip_commit
printf '%s: %d texture(s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "${#sources[@]}" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
