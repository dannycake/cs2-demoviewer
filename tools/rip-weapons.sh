#!/usr/bin/env bash
# rip-weapons.sh [--force]
#
# Exports every weapon world model (WEAPON_MODELS in lib/weapons.mjs, keyed by the
# viewer's weapon name) and every item only seen on the ground (GROUND_MODELS: the
# defuse kit), together MODEL_PATHS, from pak01_dir.vpk with Source2Viewer-CLI into
# $ASSETS_DIR/raw/weapons/:
#   <name>/<file>.glb              e.g. ak47/weapon_rif_ak47.glb, with its skeleton and clips (the
#                                  `weapon` root bone's rest pose is where the game holds it)
#   <name>/*.png                   the textures it references by relative URI
#   <name>/<file>_physics.glb      written by the same export; unused
#   rip.log                        full CLI output of every export
#   rip.json                       { cs2Build, vrfVersion, exportedAt, models: { <name>: { vmdl, glb } } }
#
# Everything is written into $ASSETS_DIR/raw/weapons.tmp-<pid>/ and renamed into
# place only when every GLB exists and is non-empty; any failure removes the temp
# dir and keeps the CLI output as $ASSETS_DIR/raw/weapons.rip-failed.log (lib/rip.sh).
# When rip.json from the installed CS2 build already exists (and no --force), only the
# models without a <name>/ folder or without an entry in rip.json are exported (none:
# nothing to do), and added: their folders go in beside the others, rip.log grows, and
# rip.json gains their entries (with their own vrfVersion and exportedAt); nothing
# already there is replaced. A folder rip.json does not list (an export cut short?)
# stops the run before anything is exported, naming the move that clears it. A
# rip.json from another build, or --force, re-exports everything. About 2 s per model.
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
command -v node > /dev/null || die "node is not on PATH (needed for lib/weapons.mjs and rip.json)"

rip_vrf

# One source of truth for the models: lib/weapons.mjs.
# shellcheck disable=SC2016  # ${...} below is a JS template literal, not a shell expansion
models_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const name of m.MODEL_NAMES) console.log(`model ${name} ${m.MODEL_PATHS[name]}`);
' "$tools_dir/lib/weapons.mjs")" || die "could not read MODEL_PATHS from lib/weapons.mjs"
names=()
declare -A vmdl_of=()
while read -r kind name vmdl; do
  [[ "$kind" == model ]] || continue
  [[ "$name" =~ ^[a-z0-9_]+$ && "$vmdl" =~ ^weapons/models/([a-z0-9_/]+)/([a-z0-9_]+)\.vmdl_c$ ]] \
    || die "lib/weapons.mjs names an unexpected model for '$name': '$vmdl'"
  names+=("$name")
  vmdl_of[$name]="$vmdl"
done <<< "$models_js"
[[ "${#names[@]}" -gt 0 ]] || die "lib/weapons.mjs gave no models"

dest="$ASSETS_DIR/raw/weapons"

# full: export every model and swap the whole folder; add: export the missing ones beside it.
mode=full
todo=("${names[@]}")
if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    listed="$(node -e '
      try { for (const k of Object.keys(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).models ?? {})) console.log(k); } catch {}
    ' "$dest/rip.json")"
    declare -A in_rip=()
    while read -r name; do
      [[ -n "$name" ]] && in_rip[$name]=1
    done <<< "$listed"
    todo=()
    for name in "${names[@]}"; do
      [[ -e "$dest/$name" && -n "${in_rip[$name]:-}" ]] || todo+=("$name")
    done
    if [[ "${#todo[@]}" -eq 0 ]]; then
      printf '%s: weapons already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
        "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
      exit 0
    fi
    # A folder rip.json does not list may be an export cut short: it is never replaced.
    for name in "${todo[@]}"; do
      [[ ! -e "$dest/$name" ]] \
        || die "$dest/$name is there but rip.json does not list it, so it may be an export cut short; nothing was changed. Move it aside and run this again: mv -- '$dest/$name' '$dest/$name.unlisted'"
    done
    mode=add
    printf '%s: the rip of CS2 build %s has no folder or no rip.json entry for %s; exporting only those\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "${todo[*]}" >&2
  else
    printf '%s: WARNING: weapons were ripped from CS2 build %s but the install is build %s; re-exporting\n' \
      "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
  fi
fi

rip_begin "$dest"

start=$SECONDS
models_json=""
for name in "${todo[@]}"; do
  vmdl="${vmdl_of[$name]}"
  file="$(basename -- "$vmdl" .vmdl_c)"
  out="$rip_tmp/export-$name"
  mkdir -- "$out"
  rip_cli "$name ($vmdl)" -i "$pak" -f "$vmdl" -d -o "$out" \
    --gltf_export_format glb --gltf_export_materials --gltf_textures_adapt --gltf_export_animations \
    --game "$game_dir/gameinfo.gi"
  # VRF writes <out>/<vmdl dir>/<file>.glb with the textures beside it.
  model_dir="$out/${vmdl%/*}"
  [[ -s "$model_dir/$file.glb" ]] || die "export produced no $file.glb for $name (expected '${vmdl%/*}/$file.glb')"
  mv -- "$model_dir" "$rip_tmp/$name"
  rm -rf -- "$out"
  models_json+="$name"$'\t'"$vmdl"$'\t'"$name/$file.glb"$'\n'
done

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "$mode" == add ]]; then
  # rip.json first, so a failure after it leaves a model listed without its folder, which
  # the next run exports again; then each folder, into a name nothing holds.
  node -e '
    const fs = require("node:fs");
    const [file, out, vrfVersion, exportedAt, rows] = process.argv.slice(1);
    const rip = JSON.parse(fs.readFileSync(file, "utf8"));
    const models = { ...rip.models };
    for (const line of rows.split("\n").filter(Boolean)) {
      const [name, vmdl, glb] = line.split("\t");
      models[name] = { vmdl, glb, vrfVersion, exportedAt };
    }
    rip.models = Object.fromEntries(Object.keys(models).sort().map((k) => [k, models[k]]));
    fs.writeFileSync(out, JSON.stringify(rip, null, 2) + "\n");
  ' "$dest/rip.json" "$rip_tmp/rip.json" "$vrf_version" "$exported_at" "$models_json" \
    || die "could not add the new models to rip.json"
  mv -- "$rip_tmp/rip.json" "$dest/rip.json"
  for name in "${todo[@]}"; do
    [[ ! -e "$dest/$name" ]] || die "'$dest/$name' appeared during the export; not replacing it"
    mv -T -- "$rip_tmp/$name" "$dest/$name"
  done
  rip_added
  printf '%s: %d missing model(s) (%s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
    "$(basename -- "$0")" "${#todo[@]}" "${todo[*]}" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
  exit 0
fi

node -e '
  const [cs2Build, vrfVersion, exportedAt, rows] = process.argv.slice(1);
  const models = {};
  for (const line of rows.split("\n").filter(Boolean)) {
    const [name, vmdl, glb] = line.split("\t");
    models[name] = { vmdl, glb };
  }
  process.stdout.write(JSON.stringify({ cs2Build, vrfVersion, exportedAt, models }, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$models_json" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"

rip_commit
printf '%s: %d weapon(s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "${#names[@]}" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
