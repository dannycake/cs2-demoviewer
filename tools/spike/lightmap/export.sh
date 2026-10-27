#!/usr/bin/env bash
# Spike (M2a Task 1): export a map's baked lighting from its VPK.
#   tools/spike/lightmap/export.sh <map>...
# Writes assets/spike/lm/<map>/maps/<map>/lightmaps/* (S2V decompiles irradiance to EXR,
# the LDR textures to PNG, volume textures to one file per z slice) and the world node
# (worldnodes/n0.vwnod -> scene objects) beside it. Never touches assets/raw.
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../../lib/env.sh
source "$here/../../lib/env.sh"
[[ $# -gt 0 ]] || { echo "usage: $0 <map>..." >&2; exit 2; }
for map in "$@"; do
  vpk="$CS2_DIR/game/csgo/maps/$map.vpk"
  out="$ASSETS_DIR/spike/lm/$map"
  mkdir -p "$out"
  "$S2V_CLI" -i "$vpk" -f "maps/$map/lightmaps/" -d -o "$out" --threads 4 > "$out/export.log" 2>&1
  "$S2V_CLI" -i "$vpk" -f "maps/$map/worldnodes/n0.vwnod_c" -d -o "$out" >> "$out/export.log" 2>&1
  printf '%s: %s\n' "$map" "$(du -sh "$out" | cut -f1)"
done
