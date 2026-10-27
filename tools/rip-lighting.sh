#!/usr/bin/env bash
# rip-lighting.sh <map> [--force]
#
# Exports what the viewer's light and sky need from the local CS2 install, beside the map's
# rip, one output group per folder of $ASSETS_DIR/raw/<map>/:
#   lightmaps/  CS2's baked light, maps/<map>/lightmaps/ in the map's VPK (lib/lightmap.mjs
#         and the light grid read it; D2–D6 in the m2a plan):
#         irradiance.exr     the lightmap: 8192², float32 channels A,B,G,R, ZIP; bounce and sky
#                            light, not the sun's direct light
#         env_light_probe_volume_atlas_z<nnn>.exr        the light probes, one EXR per z slice
#         env_light_probe_volume_atlas_dlshd_z<nnn>.png  their baked shadows, one PNG per slice
#         direct_light_shadows.png  the sun's shadow (1 = shadowed), only when the sun is baked
#                            (light_environment directlight "1"; de_cache's is dynamic)
#         debug_chart_color.png     one flat colour per lightmap chart, to validate lightmap UVs
#         lightmaps.json     { map, sunBaked, textures, atlasSlices, dlshdSlices, cs2Build,
#                            vrfVersion, exportedAt }: `textures` lists those exported
#         rip.log            full CLI output
#         A map in LIGHTMAP_MAPS (lib/maps.mjs: every map the pipeline builds) ships CS2's baked
#         light, so a VPK that lacks any of these textures fails the group: a CS2 or VRF update
#         that drops or renames one stops the build here rather than unbake the map. For a map
#         off that list, a VPK without irradiance has no baked light: nothing is exported, and
#         lightmaps.json records `textures: []` (lib/lightmap.mjs lightmapInputs: no bake, so the
#         map builds with AO); any other texture its VPK lacks is left out of `textures` with a
#         warning (lightmapInputs bakes no half-set). One the VPK lists but that does not export,
#         or a probe atlas that is not 6 z slices (one per cube face) per _dlshd slice (D6), fails
#         the group on any map.
# A file is judged absent from a VPK only after the CLI's listing of that VPK has shown a file
# it always holds (the map's entity lump; pak01's overview of the map), so a listing that
# failed fails the group instead of passing for "not there".
#   sky/  the sky CS2 draws behind the map (tools/sky.mjs turns it into sky.webp):
#         sky.json           { map, material, yaw, from, vpk, cs2Build, vrfVersion, exportedAt }:
#                            the first env_sky that does not start disabled, the map's own
#                            (from "map") or, when the map has none, its 3D skybox prefab's
#                            (from "skybox": Ancient, Anubis and Vertigo; a missing prefab VPK
#                            fails only then); material null when neither has one, and then
#                            nothing else is exported
#         sky.vmat           that material, decompiled (g_flBrightnessExposureBias, the texture)
#         sky.exr            its texture: VRF writes the BC6H cube as a 2:1 lat-long EXR
#         skybox_ents.vents  the prefab's entity lump, only when the map has no enabled env_sky
#                            of its own and a skybox_reference
#         rip.log            full CLI output
# The material is looked for in the map's VPK first (de_cache), then in pak01_dir.vpk.
#
# Reads raw/<map>/entities/default_ents.vents (rip-entities.sh). Each group is skipped on its
# own when its json is from the installed CS2 build and S2V_CLI's VRF, unless --force is given;
# one from another build or another VRF is re-exported (rip-map.sh carries the groups across a
# re-rip, so a VRF update reaches them here, not through the rip's swap). Each group is written into <group>.tmp-<pid>/ and renamed into place
# only when complete; a failure removes it and keeps the CLI output as <group>.rip-failed.log
# (lib/rip.sh).
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

tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Exits 1 naming CS2_DIR or S2V_CLI when either does not resolve.
# shellcheck source=lib/env.sh
source "$tools/lib/env.sh"
# shellcheck source=lib/rip.sh
source "$tools/lib/rip.sh"

[[ "$map" =~ ^[a-z0-9_]+$ ]] || die "map name must match [a-z0-9_]+ (got '$map')"
command -v node > /dev/null || die "node is not on PATH"

game_dir="$CS2_DIR/game/csgo"
map_vpk="$game_dir/maps/$map.vpk"
pak="$game_dir/pak01_dir.vpk"
[[ -f "$map_vpk" ]] || die "CS2_DIR has no map VPK for '$map' ('$map_vpk')"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
raw="$ASSETS_DIR/raw/$map"
ents="$raw/entities/default_ents.vents"
[[ -s "$ents" ]] || die "no entity lump for $map ('$ents'); run tools/rip-entities.sh $map"

rip_vrf
# Whether the map must ship the bake, from the one list shrink-map.mjs and check-map.mjs read.
bake_required="$(node --input-type=module -e '
  const { LIGHTMAP_MAPS } = await import(process.argv[1]);
  process.stdout.write(String(LIGHTMAP_MAPS.includes(process.argv[2])));
' "$tools/lib/maps.mjs" "$map")" || die "cannot read LIGHTMAP_MAPS from $tools/lib/maps.mjs"

# node_lib <expr> <args...>: evaluates a module snippet with E = lib/entities.mjs and argv.
node_lib() {
  local code="$1"
  shift
  node --input-type=module -e "
    import fs from 'node:fs';
    const E = await import(process.argv[1]);
    const read = (f) => (f ? E.parseEntities(fs.readFileSync(f, 'utf8')) : []);
    const argv = process.argv.slice(2);
    $code
  " "$tools/lib/entities.mjs" "$@"
}

# listed <vpk> <path>: whether <vpk> holds <path>.
listed() {
  "$S2V_CLI" -i "$1" -l -f "$2" 2>&1 | grep -qF -- "$2"
}

# listing_works <vpk> <path>: dies unless the listing of <vpk> shows <path>, a file it always
# holds; run before reading anything into a file `listed` does not find.
listing_works() {
  listed "$1" "$2" \
    || die "Source2Viewer-CLI did not list $2 in $(basename -- "$1"), which holds it: the listing failed, so a file missing from it cannot be told from one the VPK lacks"
}

# pick_sky <ents> <from>: "material \t yaw \t from" of the first enabled env_sky in <ents>,
# or nothing.
pick_sky() {
  node_lib '
    const s = E.skyOf(read(argv[0]));
    if (s) process.stdout.write([s.material, s.yaw, argv[1]].join("\t"));
  ' "$1" "$2"
}

rip_sky() {
  local start=$SECONDS
  rip_begin "$raw/sky"

  # The map's own env_sky first; only without one is the 3D skybox prefab (a map of its own
  # in maps/prefabs/, with its own entity lump) decompiled for its env_sky.
  local pick material="" yaw="0" from=""
  pick="$(pick_sky "$ents" map)"
  if [[ -z "$pick" ]]; then
    local prefab
    prefab="$(node_lib 'process.stdout.write(E.skyboxMapOf(read(argv[0])) ?? "")' "$ents")"
    if [[ -n "$prefab" ]]; then
      [[ "$prefab" =~ ^maps/prefabs/[A-Za-z0-9_/]+\.vmap$ ]] || die "unexpected skybox_reference map '$prefab' in $ents"
      local base="${prefab%.vmap}"
      local prefab_vpk="$game_dir/$base.vpk"
      [[ -f "$prefab_vpk" ]] || die "$map has no enabled env_sky of its own, and its 3D skybox '$prefab' has no VPK ('$prefab_vpk')"
      mkdir -- "$rip_tmp/prefab"
      rip_cli "skybox entities" -i "$prefab_vpk" -f "$base/entities/default_ents.vents_c" -d -o "$rip_tmp/prefab"
      [[ -s "$rip_tmp/prefab/$base/entities/default_ents.vents" ]] || die "the entity lump of '$prefab' did not decompile"
      mv -- "$rip_tmp/prefab/$base/entities/default_ents.vents" "$rip_tmp/skybox_ents.vents"
      rm -rf -- "$rip_tmp/prefab"
      pick="$(pick_sky "$rip_tmp/skybox_ents.vents" skybox)"
    fi
  fi
  [[ -z "$pick" ]] || IFS=$'\t' read -r material yaw from <<< "$pick"

  local vpk=""
  if [[ -n "$material" ]]; then
    [[ "$material" =~ ^materials/[A-Za-z0-9_./-]+\.vmat$ ]] || die "unexpected sky material '$material'"
    local file="${material}_c"
    listing_works "$map_vpk" "maps/$map/entities/default_ents.vents_c"
    listing_works "$pak" "resource/overviews/$map.txt"
    if listed "$map_vpk" "$file"; then
      vpk="$map_vpk"
    elif listed "$pak" "$file"; then
      vpk="$pak"
    else
      die "$map's sky '$material' is in neither $map.vpk nor pak01_dir.vpk"
    fi
    mkdir -- "$rip_tmp/export"
    rip_cli "sky material" -i "$vpk" -f "$file" -d -o "$rip_tmp/export" --game "$game_dir/gameinfo.gi"
    [[ -s "$rip_tmp/export/$material" ]] || die "the sky material '$material' did not decompile"
    mv -- "$rip_tmp/export/$material" "$rip_tmp/sky.vmat"
    local exrs=()
    mapfile -t exrs < <(find "$rip_tmp/export" -type f -name '*.exr')
    [[ ${#exrs[@]} -eq 1 ]] || die "the sky material '$material' exported ${#exrs[@]} EXR textures, not 1"
    mv -- "${exrs[0]}" "$rip_tmp/sky.exr"
    rm -rf -- "$rip_tmp/export"
  fi

  node -e '
    const [map, material, yaw, from, vpk, cs2Build, vrfVersion, exportedAt] = process.argv.slice(1);
    const out = material
      ? { map, material, yaw: Number(yaw), from, vpk, cs2Build, vrfVersion, exportedAt }
      : { map, material: null, cs2Build, vrfVersion, exportedAt };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  ' "$map" "$material" "$yaw" "$from" "${vpk#"$game_dir/"}" "$CS2_BUILD" "$vrf_version" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$rip_tmp/sky.json"
  rip_commit

  if [[ -n "$material" ]]; then
    printf '%s: %s sky %s (yaw %s, from the %s) exported in %ds into %s\n' \
      "$(basename -- "$0")" "$map" "$material" "$yaw" "$from" "$((SECONDS - start))" "$raw/sky"
  else
    printf '%s: %s has no enabled env_sky; %s records none\n' "$(basename -- "$0")" "$map" "$raw/sky/sky.json"
  fi
}

rip_lightmaps() {
  local start=$SECONDS
  rip_begin "$raw/lightmaps"

  local sun_baked
  sun_baked="$(node_lib 'process.stdout.write(String(E.sunOf(read(argv[0]))?.baked ?? false))' "$ents")"
  local wanted=(irradiance env_light_probe_volume_atlas env_light_probe_volume_atlas_dlshd debug_chart_color)
  if [[ "$sun_baked" == "true" ]]; then wanted+=(direct_light_shadows); fi

  # What the VPK has: without irradiance there is no baked light to export at all.
  local dir="maps/$map/lightmaps" t textures=() absent=() files=()
  listing_works "$map_vpk" "maps/$map/entities/default_ents.vents_c"
  if listed "$map_vpk" "$dir/irradiance.vtex_c"; then
    for t in "${wanted[@]}"; do
      if listed "$map_vpk" "$dir/$t.vtex_c"; then
        textures+=("$t")
        files+=("$dir/$t.vtex_c")
      else
        absent+=("$t")
      fi
    done
  fi

  # A map that must ship the bake fails before anything is exported, and its last export stays
  # (rip-map.sh carries it across a re-rip of the map).
  if [[ "$bake_required" == true ]]; then
    local missing=("${absent[@]}")
    [[ ${#textures[@]} -gt 0 ]] || missing=(irradiance)
    [[ ${#missing[@]} -eq 0 ]] \
      || die "$map.vpk has no ${missing[*]} in $dir, so $map would build without CS2's baked light; it is in LIGHTMAP_MAPS (tools/lib/maps.mjs), which ships the bake: find what CS2 build $CS2_BUILD or VRF $vrf_version changed, or take $map off LIGHTMAP_MAPS to build it with AO"
  fi

  local atlas=0 dlshd=0
  if [[ ${#files[@]} -gt 0 ]]; then
    mkdir -- "$rip_tmp/export"
    rip_cli "lightmaps" -i "$map_vpk" -f "$(IFS=,; printf '%s' "${files[*]}")" -d -o "$rip_tmp/export" --threads 4
    [[ -d "$rip_tmp/export/$dir" ]] || die "Source2Viewer-CLI exported nothing from $dir"
    local f
    for f in "$rip_tmp/export/$dir"/*; do mv -- "$f" "$rip_tmp/"; done
    rm -rf -- "$rip_tmp/export"

    atlas="$(find "$rip_tmp" -maxdepth 1 -name 'env_light_probe_volume_atlas_z[0-9]*.exr' | wc -l)"
    dlshd="$(find "$rip_tmp" -maxdepth 1 -name 'env_light_probe_volume_atlas_dlshd_z[0-9]*.png' | wc -l)"
    for t in "${textures[@]}"; do
      case "$t" in
        irradiance) [[ -s "$rip_tmp/irradiance.exr" ]] || die "irradiance did not export as $dir/irradiance.exr" ;;
        env_light_probe_volume_atlas) [[ "$atlas" -gt 0 ]] || die "env_light_probe_volume_atlas exported no EXR slices" ;;
        env_light_probe_volume_atlas_dlshd) [[ "$dlshd" -gt 0 ]] || die "env_light_probe_volume_atlas_dlshd exported no PNG slices" ;;
        *) [[ -s "$rip_tmp/$t.png" ]] || die "$t did not export as a PNG" ;;
      esac
    done
    if [[ "$atlas" -gt 0 && "$dlshd" -gt 0 && "$atlas" -ne $((6 * dlshd)) ]]; then
      die "env_light_probe_volume_atlas exported $atlas z slices, not 6 × $dlshd (one per cube face of each _dlshd slice, D6): a truncated probe export"
    fi
  fi

  node -e '
    const [map, sunBaked, textures, atlas, dlshd, cs2Build, vrfVersion, exportedAt] = process.argv.slice(1);
    const out = {
      map, sunBaked: sunBaked === "true", textures: textures ? textures.split(" ") : [],
      atlasSlices: Number(atlas), dlshdSlices: Number(dlshd), cs2Build, vrfVersion, exportedAt,
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  ' "$map" "$sun_baked" "${textures[*]}" "$atlas" "$dlshd" "$CS2_BUILD" "$vrf_version" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$rip_tmp/lightmaps.json"
  rip_commit

  if [[ ${#textures[@]} -eq 0 ]]; then
    printf '%s: %s has no irradiance in %s.vpk, so no baked light: %s records none, and the map builds without a bake\n' \
      "$(basename -- "$0")" "$map" "$map" "$raw/lightmaps/lightmaps.json"
    return
  fi
  if [[ ${#absent[@]} -gt 0 ]]; then
    printf '%s: WARNING: %s.vpk has no %s; lightmaps.json leaves it out\n' \
      "$(basename -- "$0")" "$map" "${absent[*]}" >&2
  fi
  printf '%s: %s lightmaps (%s; %s probe slices) exported in %ds into %s (%s)\n' \
    "$(basename -- "$0")" "$map" "${textures[*]}" "$atlas" "$((SECONDS - start))" "$raw/lightmaps" \
    "$(du -sh -- "$raw/lightmaps" | cut -f1)"
}

# Each output group is skipped or exported on its own: a new group is exported for a map whose
# other groups are already there.
if [[ "$force" -eq 0 ]] && rip_fresh "$raw/sky/sky.json" "$vrf_version"; then
  printf '%s: %s sky already exported from CS2 build %s and VRF %s (%s exists); pass --force to re-export\n' \
    "$(basename -- "$0")" "$map" "$CS2_BUILD" "$vrf_version" "$raw/sky/sky.json" >&2
else
  rip_sky
fi

if [[ "$force" -eq 0 ]] && rip_fresh "$raw/lightmaps/lightmaps.json" "$vrf_version"; then
  printf '%s: %s lightmaps already exported from CS2 build %s and VRF %s (%s exists); pass --force to re-export\n' \
    "$(basename -- "$0")" "$map" "$CS2_BUILD" "$vrf_version" "$raw/lightmaps/lightmaps.json" >&2
else
  rip_lightmaps
fi
