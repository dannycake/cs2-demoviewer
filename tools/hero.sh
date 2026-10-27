#!/usr/bin/env bash
# hero.sh <map>... | all
#
# CS2's own screenshot of each map, panorama/images/map_icons/screenshots/1080p/<map>_png.vtex_c
# in pak01, as assets/maps/<map>/hero.png (hero.mjs: 1200×630, cropped to cover): the background
# of the match preview card that a link pasted in Discord shows (server/crates/server/src/
# preview.rs). The browser never loads it, so it is in no manifest. A map CS2 has no screenshot
# for is reported and skipped; its card falls back to the radar. `all` is MAPS (lib/env.sh).
set -euo pipefail

[[ $# -gt 0 ]] || { printf 'usage: %s <map>... | all\n' "$(basename -- "$0")" >&2; exit 2; }
tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/env.sh
source "$tools/lib/env.sh"

maps=()
for arg in "$@"; do
  # MAPS is one space-separated string (lib/env.sh).
  # shellcheck disable=SC2206
  if [[ "$arg" == all ]]; then maps+=($MAPS); else maps+=("$arg"); fi
done

pak="$CS2_DIR/game/csgo/pak01_dir.vpk"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
tmp="$(mktemp -d)"
trap 'rm -rf -- "$tmp"' EXIT

for map in "${maps[@]}"; do
  [[ "$map" =~ ^[a-z0-9_]+$ ]] || die "map name must match [a-z0-9_]+ (got '$map')"
  out="$ASSETS_DIR/maps/$map"
  [[ -d "$out" ]] || die "$out does not exist; build the map first (build-assets.sh $map)"
  shot="panorama/images/map_icons/screenshots/1080p/${map}_png"
  "$S2V_CLI" -i "$pak" -o "$tmp" -d --vpk_filepath "$shot.vtex_c" > "$tmp/vrf.log" 2>&1 || true
  if [[ ! -s "$tmp/$shot.png" ]]; then
    printf '%s: CS2 has no screenshot of %s (%s.vtex_c); no hero.png\n' "$(basename -- "$0")" "$map" "$shot" >&2
    continue
  fi
  node "$tools/hero.mjs" "$tmp/$shot.png" "$out/hero.png"
  printf '%s: %s/hero.png\n' "$(basename -- "$0")" "$out"
done
