#!/usr/bin/env bash
# rip-players.sh [--force]
#
# Exports the CT and T player models (PLAYER_MODELS in lib/players.mjs) with
# their animation clips (CLIPS_REQUESTED there) from pak01_dir.vpk with
# Source2Viewer-CLI into $ASSETS_DIR/raw/players/:
#   ct/ctm_sas.glb                 agents/models/ctm_sas/ctm_sas.vmdl_c, skinned, with clips
#   ct/*.png                       the textures it references by relative URI
#   ct/ctm_sas_physics.glb         written by the same export: hitbox physics; unused
#   t/tm_phoenix.glb, t/*.png, t/tm_phoenix_physics.glb   the same for T
#   rip.log                        full CLI output of both exports
#   rip.json                       { cs2Build, vrfVersion, exportedAt, clipsRequested,
#                                    models: { ct|t: { vmdl, glb, unmatchedClips } } }
#                                  unmatchedClips: the clips VRF's "animation filter matched
#                                  no animations for:" line names (shrink-player.mjs checks
#                                  the GLB itself)
#
# Everything is written into $ASSETS_DIR/raw/players.tmp-<pid>/ and renamed into
# place only when both GLBs exist and are non-empty; any failure removes the temp
# dir and keeps the CLI output as $ASSETS_DIR/raw/players.rip-failed.log (lib/rip.sh).
# Skipped when rip.json from the installed CS2 build already exists unless --force is
# given; one from another build is re-exported.
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
command -v node > /dev/null || die "node is not on PATH (needed for lib/players.mjs and rip.json)"

rip_vrf

# One source of truth for the models and the clip list: lib/players.mjs.
# shellcheck disable=SC2016  # ${...} below is a JS template literal, not a shell expansion
players_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const [side, vmdl] of Object.entries(m.PLAYER_MODELS)) console.log(`model ${side} ${vmdl}`);
  console.log(`clips ${m.CLIPS_REQUESTED.join(",")}`);
' "$tools_dir/lib/players.mjs")" || die "could not read PLAYER_MODELS / CLIPS_REQUESTED from lib/players.mjs"
clips="$(sed -n 's/^clips //p' <<< "$players_js")"
sides=()
declare -A vmdl_of=()
while read -r kind side vmdl; do
  [[ "$kind" == model ]] || continue
  [[ "$side" =~ ^[a-z]+$ && "$vmdl" =~ ^agents/models/([a-z0-9_]+)/([a-z0-9_]+)\.vmdl_c$ ]] \
    || die "lib/players.mjs names an unexpected model for '$side': '$vmdl'"
  sides+=("$side")
  vmdl_of[$side]="$vmdl"
done <<< "$players_js"
[[ "${#sides[@]}" -gt 0 && -n "$clips" ]] || die "lib/players.mjs gave no models or no clips"

dest="$ASSETS_DIR/raw/players"

# A rip from another CS2 build is stale: after a game update it is re-exported as
# --force would, so the outputs are never rebuilt from the old build's files.
if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    printf '%s: players already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
    exit 0
  fi
  printf '%s: WARNING: players were ripped from CS2 build %s but the install is build %s; re-exporting\n' \
    "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
fi

rip_begin "$dest"

start=$SECONDS
models_json=""
for side in "${sides[@]}"; do
  vmdl="${vmdl_of[$side]}"
  name="$(basename -- "$vmdl" .vmdl_c)"
  # Must exist before the export: with a single-file filter and a missing -o
  # directory, the CLI treats -o as the output file name instead of a folder.
  out="$rip_tmp/export-$side"
  mkdir -- "$out"
  rip_cli "$side ($vmdl)" -i "$pak" -f "$vmdl" -d -o "$out" \
    --gltf_export_format glb --gltf_export_materials --gltf_textures_adapt --gltf_export_animations \
    --gltf_animation_list "$clips" \
    --gltf_compose_additive --game "$game_dir/gameinfo.gi"

  # VRF writes <out>/agents/models/<name>/<name>.glb with the textures beside it.
  model_dir="$out/${vmdl%/*}"
  [[ -s "$model_dir/$name.glb" ]] || die "export produced no $name.glb for $side (expected '${vmdl%/*}/$name.glb')"
  mv -- "$model_dir" "$rip_tmp/$side"
  # Fails (and so dies under set -e) if VRF wrote anything outside the model folder.
  rmdir -- "$out/agents/models" "$out/agents" "$out"

  unmatched="$(rip_cli_output | sed -n 's/^.*animation filter matched no animations for: *//p' | head -n 1 || true)"
  models_json+="$side"$'\t'"$vmdl"$'\t'"$side/$name.glb"$'\t'"$unmatched"$'\n'
  if [[ -n "$unmatched" ]]; then
    printf '%s: %s: VRF matched no animations for: %s\n' "$(basename -- "$0")" "$side" "$unmatched" >&2
  fi
done

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [cs2Build, vrfVersion, exportedAt, clips, rows] = process.argv.slice(1);
  const models = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [side, vmdl, glb, unmatched] = line.split("\t");
    models[side] = { vmdl, glb, unmatchedClips: unmatched ? unmatched.split(",").map((s) => s.trim()).filter(Boolean) : [] };
  }
  const out = { cs2Build, vrfVersion, exportedAt, clipsRequested: clips.split(","), models };
  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$clips" "$models_json" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"

rip_commit

printf '%s: %s ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "${sides[*]}" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version"
