#!/usr/bin/env bash
# model-poses.sh <map>... | all
#
# Writes assets/raw/<map>/model-poses.json beside each map's rip (tools/model-poses.mjs): the pose
# the game draws each skinned prop of that map's world in, which shrink-map.mjs applies to their
# geometry. It needs the CS2 install and Source2Viewer-CLI (lib/env.sh). build-assets.sh runs it
# between rip-map.sh and shrink-map.mjs; by hand, run it after a rip, before shrinking.
set -euo pipefail
tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/env.sh
source "$tools/lib/env.sh"
exec node "$tools/model-poses.mjs" "$@"
