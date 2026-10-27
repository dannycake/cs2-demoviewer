#!/usr/bin/env bash
# rip-map.sh <map> [--force]
#
# Exports one map from the local CS2 install with Source2Viewer-CLI into
# $ASSETS_DIR/raw/<map>/:
#   world.glb                      the world (glTF metres, Y-up)
#   world_physics.glb              written by the same export: entity physics only
#                                  (props, func_brush, trigger and place volumes); unused
#   world_collision.glb            maps/<map>/world_physics.vmdl_c, the world's own
#                                  collision mesh (glTF metres, Y-up); input to hull.glb
#   *.png                          the textures world.glb references by relative URI
#   radar.png                      panorama/images/overheadmaps/<map>_radar_psd.vtex_c
#   radar_lower.png                <map>_lower_radar_psd.vtex_c, only when the VPK lists it
#   overview.txt                   resource/overviews/<map>.txt (KeyValues, Source units)
#   rip.log                        full CLI output of every export
#   rip.json                       { map, cs2Build, vrfVersion, exportedAt }
# and runs rip-entities.sh for entities/ beside them. What other scripts export into the folder
# stays when a re-rip replaces it: rip-lighting.sh's lightmaps/ and sky/, and model-poses.sh's
# model-poses.json, are carried into the new export (hard links, nothing copied), and their own
# freshness checks decide whether they are exported again.
#
# Everything is written into $ASSETS_DIR/raw/<map>.tmp-<pid>/ and renamed into
# place only when world.glb, world_physics.glb, world_collision.glb, radar.png and
# overview.txt all exist and are non-empty; any failure removes the temp dir and
# keeps the CLI output as $ASSETS_DIR/raw/<map>.rip-failed.log (lib/rip.sh). A map
# that already has rip.json from the installed CS2 build is skipped unless --force is
# given (when that rip is from another VRF than S2V_CLI, the skip says to re-export it
# with --force); one from another build is re-exported.
set -euo pipefail

usage() {
  printf 'usage: %s <map> [--force]\n' "$(basename -- "$0")" >&2
  exit 2
}

map=""
force=0
for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) [[ -z "$map" ]] || usage; map="$arg" ;;
  esac
done
[[ -n "$map" ]] || usage

# Exits 1 naming CS2_DIR or S2V_CLI when either does not resolve.
# shellcheck source=lib/env.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/env.sh"
# shellcheck source=lib/rip.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/rip.sh"

[[ "$map" =~ ^[a-z0-9_]+$ ]] || die "map name must match [a-z0-9_]+ (got '$map')"

game_dir="$CS2_DIR/game/csgo"
map_vpk="$game_dir/maps/$map.vpk"
pak="$game_dir/pak01_dir.vpk"
[[ -f "$map_vpk" ]] || die "CS2_DIR has no map VPK for '$map' ('$map_vpk')"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
command -v node > /dev/null || die "node is not on PATH (needed to write rip.json)"

# lib/vrf.mjs is the parser model-poses.mjs uses too: shrink-map.mjs compares what the two wrote.
rip_vrf

dest="$ASSETS_DIR/raw/$map"
# What other scripts export into raw/<map>/ beside the rip, and own; carried across a re-rip.
beside=(lightmaps sky model-poses.json)

# A rip from another CS2 build is stale: after a game update it is re-exported as
# --force would, so the outputs are never rebuilt from the old build's files. One from
# another VRF only is kept, but the skip says so: shrink-map.mjs stops on a pose table
# (model-poses.sh, always the installed VRF) from another VRF than the rip, and only
# --force brings the rip to the installed VRF.
if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  ripped_vrf="$(rip_field "$dest/rip.json" vrfVersion)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    printf '%s: %s already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
      "$(basename -- "$0")" "$map" "$CS2_BUILD" "$dest/rip.json" >&2
    if [[ "$ripped_vrf" != "$vrf_version" ]]; then
      printf '%s: NOTE: that rip is from VRF %s but S2V_CLI is VRF %s; shrink-map.mjs stops on a model-poses.json from another VRF than the rip, so run tools/rip-map.sh %s --force, then tools/model-poses.sh %s\n' \
        "$(basename -- "$0")" "${ripped_vrf:-unknown}" "$vrf_version" "$map" "$map" >&2
    fi
    exit 0
  fi
  printf '%s: WARNING: %s was ripped from CS2 build %s but the install is build %s; re-exporting\n' \
    "$(basename -- "$0")" "$map" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
fi

rip_begin "$dest"

# need <path> <what>: dies unless <path> is a non-empty file.
need() {
  [[ -s "$1" ]] || die "export produced no $2 for $map (expected '${1#"$rip_tmp/"}' in the export)"
}

start=$SECONDS
overheads="panorama/images/overheadmaps"

rip_cli "world" -i "$map_vpk" -o "$rip_tmp" -d -f "maps/$map/world.vwrld_c" \
  --gltf_export_format glb --gltf_export_materials --threads 8 --game "$game_dir/gameinfo.gi"
# The world's own collision. VRF writes it as maps/<map>/world_physics_physics.glb
# beside an empty world_physics.glb (the model has no render mesh) that would
# overwrite the world export's file of that name, so it gets its own folder.
collision_out="$rip_tmp/collision"
mkdir -- "$collision_out"
rip_cli "collision" -i "$map_vpk" -o "$collision_out" -d -f "maps/$map/world_physics.vmdl_c" \
  --gltf_export_format glb --game "$game_dir/gameinfo.gi"
rip_cli "radar" -i "$pak" -o "$rip_tmp" -d -f "$overheads/${map}_radar_psd.vtex_c"

lower_vtex="$overheads/${map}_lower_radar_psd.vtex_c"
listing="$("$S2V_CLI" -i "$pak" -l -f "$lower_vtex" 2>&1)" \
  || die "Source2Viewer-CLI could not list $lower_vtex in pak01_dir.vpk"
printf '\n=== lower radar listing (%s)\n%s\n' "$lower_vtex" "$listing" >> "$rip_log"
has_lower=0
if grep -qF -- "$lower_vtex" <<< "$listing"; then
  has_lower=1
  rip_cli "lower radar" -i "$pak" -o "$rip_tmp" -d -f "$lower_vtex"
fi

rip_cli "overview" -i "$pak" -o "$rip_tmp" -f "resource/overviews/$map.txt"

# Flatten VRF's layout: maps/<map>/* (world.glb, world_physics.glb and the
# textures world.glb references by relative URI) moves up to the top level.
world_dir="$rip_tmp/maps/$map"
need "$world_dir/world.glb" "world.glb"
need "$world_dir/world_physics.glb" "world_physics.glb"
shopt -s nullglob dotglob
for f in "$world_dir"/*; do
  name="$(basename -- "$f")"
  case "$name" in
    rip.log|rip.json|radar.png|radar_lower.png|overview.txt|world_collision.glb|maps|collision|panorama|resource)
      die "world export wrote '$name', which collides with a rip output name" ;;
  esac
  for b in "${beside[@]}"; do
    [[ "$name" != "$b" ]] || die "world export wrote '$name', which collides with what $map's folder keeps from other scripts"
  done
  mv -- "$f" "$rip_tmp/$name"
done
shopt -u nullglob dotglob
rmdir -- "$world_dir" "$rip_tmp/maps"

collision_dir="$collision_out/maps/$map"
need "$collision_dir/world_physics_physics.glb" "world collision mesh"
mv -- "$collision_dir/world_physics_physics.glb" "$rip_tmp/world_collision.glb"
rm -f -- "$collision_dir/world_physics.glb"
rmdir -- "$collision_dir" "$collision_out/maps" "$collision_out"

need "$rip_tmp/$overheads/${map}_radar_psd.png" "radar PNG"
mv -- "$rip_tmp/$overheads/${map}_radar_psd.png" "$rip_tmp/radar.png"
if [[ "$has_lower" -eq 1 ]]; then
  need "$rip_tmp/$overheads/${map}_lower_radar_psd.png" "lower radar PNG"
  mv -- "$rip_tmp/$overheads/${map}_lower_radar_psd.png" "$rip_tmp/radar_lower.png"
fi
rmdir -- "$rip_tmp/$overheads" "$rip_tmp/panorama/images" "$rip_tmp/panorama"

need "$rip_tmp/resource/overviews/$map.txt" "overview"
mv -- "$rip_tmp/resource/overviews/$map.txt" "$rip_tmp/overview.txt"
rmdir -- "$rip_tmp/resource/overviews" "$rip_tmp/resource"

for f in world.glb world_physics.glb world_collision.glb radar.png overview.txt; do
  need "$rip_tmp/$f" "$f"
done

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [map, cs2Build, vrfVersion, exportedAt] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ map, cs2Build, vrfVersion, exportedAt }, null, 2) + "\n");
' "$map" "$CS2_BUILD" "$vrf_version" "$exported_at" > "$rip_tmp/rip.json"
need "$rip_tmp/rip.json" "rip.json"

# The swap replaces raw/<map> whole, so what other scripts exported beside the previous rip comes
# into the new export first, hard-linked: nothing is copied, and the previous export keeps its own
# until the swap is done, so a failure that puts it back puts them back too. Each one's own check
# decides whether it is exported again (rip-lighting.sh redoes a group from another CS2 build, or
# with --force; model-poses.sh runs on every build). The swap used to delete them with the old
# export, so a re-rip dropped the map's last good bake, and when rip-lighting.sh then refused a
# VPK without a whole bake (a map of LIGHTMAP_MAPS) there was none left to keep.
for f in "${beside[@]}"; do
  [[ ! -e "$dest/$f" ]] || cp -al -- "$dest/$f" "$rip_tmp/$f"
done

rip_commit

# The entity lump, beside the export: shrink-map.mjs drops what a match starts without.
bash "$(dirname -- "${BASH_SOURCE[0]}")/rip-entities.sh" "$map" > /dev/null \
  || die "could not export the entity lump of $map"

lower_note=""
if [[ "$has_lower" -eq 1 ]]; then
  lower_note=", radar_lower.png"
fi
printf '%s: %s ripped in %ds into %s (world.glb, world_physics.glb, world_collision.glb, radar.png%s, overview.txt; CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "$map" "$((SECONDS - start))" "$dest" "$lower_note" "$CS2_BUILD" "$vrf_version"
