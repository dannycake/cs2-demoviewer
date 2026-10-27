# shellcheck shell=bash
# Sourced by every bash script in tools/. Resolves the inputs (each overridable
# from the environment), exports them, and dies naming the variable when the CS2
# install or Source2Viewer-CLI is missing.
#
# Exports: REPO_DIR CS2_DIR S2V_CLI ASSETS_DIR ACTIVE_DUTY MAPS CS2_BUILD
# Defines: die "<msg>"   (message to stderr, exit 1)

die() {
  printf '%s: %s\n' "$(basename -- "${0:-tools}")" "$*" >&2
  exit 1
}

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
CS2_DIR="${CS2_DIR:-$HOME/.local/share/Steam/steamapps/common/Counter-Strike Global Offensive}"
S2V_CLI="${S2V_CLI:-$HOME/.local/opt/source2viewer-cli/Source2Viewer-CLI}"
ASSETS_DIR="${ASSETS_DIR:-$REPO_DIR/assets}"
# Same lists as ACTIVE_DUTY and MAPS in tools/lib/maps.mjs.
ACTIVE_DUTY="de_ancient de_anubis de_dust2 de_inferno de_mirage de_nuke de_overpass de_train de_vertigo"
MAPS="$ACTIVE_DUTY de_cache"
export REPO_DIR CS2_DIR S2V_CLI ASSETS_DIR ACTIVE_DUTY MAPS

[[ -f "$CS2_DIR/game/csgo/gameinfo.gi" ]] \
  || die "CS2_DIR does not point at a CS2 install (no game/csgo/gameinfo.gi under '$CS2_DIR')"
[[ -f "$S2V_CLI" && -x "$S2V_CLI" ]] \
  || die "S2V_CLI is not an executable Source2Viewer-CLI ('$S2V_CLI')"

[[ -f "$CS2_DIR/game/csgo/steam.inf" && -r "$CS2_DIR/game/csgo/steam.inf" ]] \
  || die "CS2_DIR has no readable game/csgo/steam.inf ('$CS2_DIR')"
# `|| true`: under a caller's `set -euo pipefail` a failing pipeline here would
# exit silently before the check below could name the variable.
CS2_BUILD="$(sed -n 's/^ClientVersion=\([0-9][0-9]*\).*$/\1/p' "$CS2_DIR/game/csgo/steam.inf" | head -n 1 || true)"
[[ -n "$CS2_BUILD" ]] \
  || die "CS2_DIR has no ClientVersion= in game/csgo/steam.inf ('$CS2_DIR')"
export CS2_BUILD
