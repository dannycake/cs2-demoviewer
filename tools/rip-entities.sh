#!/usr/bin/env bash
# rip-entities.sh <map>... | all
#
# Decompiles a map's entity lump (maps/<map>/entities/default_ents.vents_c in the map's VPK)
# with Source2Viewer-CLI into $ASSETS_DIR/raw/<map>/entities/default_ents.vents, the text
# shrink-map.mjs reads to drop the entities a match starts with switched off (game-mode
# props such as Nuke's Wingman doors, retake blockers). rip-map.sh runs it too; this alone
# is enough for a map ripped before it existed. `all` is the Active Duty pool.
set -euo pipefail
# shellcheck source=lib/env.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/env.sh"

[[ $# -gt 0 ]] || { printf 'usage: %s <map>... | all\n' "$(basename -- "$0")" >&2; exit 2; }
maps=()
for arg in "$@"; do
  # MAPS is one space-separated string (lib/env.sh).
  # shellcheck disable=SC2206
  if [[ "$arg" == all ]]; then maps+=($MAPS); else maps+=("$arg"); fi
done

for map in "${maps[@]}"; do
  vpk="$CS2_DIR/game/csgo/maps/$map.vpk"
  [[ -f "$vpk" ]] || { printf '%s: no %s\n' "$map" "$vpk" >&2; exit 1; }
  out="$ASSETS_DIR/raw/$map"
  tmp="$(mktemp -d)"
  "$S2V_CLI" -i "$vpk" -f "maps/$map/entities/default_ents.vents_c" -d -o "$tmp" > /dev/null 2>&1
  src="$tmp/maps/$map/entities/default_ents.vents"
  [[ -s "$src" ]] || { rm -rf "$tmp"; printf '%s: the entity lump did not decompile\n' "$map" >&2; exit 1; }
  mkdir -p "$out/entities"
  mv "$src" "$out/entities/default_ents.vents"
  rm -rf "$tmp"
  printf '%s: %s\n' "$map" "$(grep -c '^====' "$out/entities/default_ents.vents") entities"
done
