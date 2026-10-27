#!/usr/bin/env bash
# rip-sounds.sh [--force]
#
# Exports what build-sounds.mjs packs from pak01_dir.vpk with Source2Viewer-CLI into
# $ASSETS_DIR/raw/sounds/, each file at its VPK path:
#   soundevents/.../<name>.vsndevts            SOUNDEVENT_FILES (lib/sounds.mjs), decompiled to KV3 text
#   surfaceproperties/surfaceproperties.vsurf  the surface properties, decompiled
#   scripts/surfaceproperties_footsteps.txt    each surface's footstep events, per team
#   sounds/.../<name>.wav or .mp3              every sound under SOUND_DIRS (lib/sounds.mjs), then
#                                              each sound elsewhere that `build-sounds.mjs
#                                              --list-missing` names (announcer lines, UI beeps,
#                                              grenade and landing impacts); VRF writes a .vsnd
#                                              sidecar beside most
#   rip.log                                    full CLI output of every export
#   rip.json                                   { cs2Build, vrfVersion, exportedAt, absent: [<vpk path>…] }
#
# Everything is written into $ASSETS_DIR/raw/sounds.tmp-<pid>/ and renamed into place only when
# every soundevents and surface file exported and every SOUND_DIRS folder gave a sound; any
# failure removes the temp dir and keeps the CLI output as $ASSETS_DIR/raw/sounds.rip-failed.log
# (lib/rip.sh).
# A file --list-missing still names after its export (the VPK does not have it) is reported,
# not fatal: rip.json lists it as `absent`, --list-missing stops naming it, and build-sounds.mjs
# lists the keys that play it as missing. When rip.json from the installed CS2 build already
# exists (and no --force), only the files --list-missing names are exported (none: nothing to
# do) and added beside the others: nothing already there is replaced, rip.log grows, and
# rip.json changes only to list a newly absent file. A rip.json from another build, or
# --force, re-exports everything, the absent files included. About 15 s for the whole rip
# (200 MB).
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
# shellcheck source=lib/env.sh disable=SC1091  # followed with shellcheck -x
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/env.sh"
# shellcheck source=lib/rip.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/lib/rip.sh"

tools_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
pak="$CS2_DIR/game/csgo/pak01_dir.vpk"
[[ -f "$pak" ]] || die "CS2_DIR has no game/csgo/pak01_dir.vpk ('$CS2_DIR')"
command -v node > /dev/null || die "node is not on PATH (needed for lib/sounds.mjs, build-sounds.mjs and rip.json)"

rip_vrf

# One source of truth for the soundevents and the folders: lib/sounds.mjs.
# shellcheck disable=SC2016  # ${...} below is a JS template literal, not a shell expansion
lists_js="$(node --input-type=module -e '
  const m = await import(process.argv[1]);
  for (const f of m.SOUNDEVENT_FILES) console.log(`events ${f}`);
  for (const d of m.SOUND_DIRS) console.log(`dir ${d}`);
' "$tools_dir/lib/sounds.mjs")" || die "could not read SOUNDEVENT_FILES and SOUND_DIRS from lib/sounds.mjs"
sources=()
dirs=()
while read -r kind value; do
  case "$kind" in
    events)
      [[ "$value" =~ ^soundevents/[a-z0-9_/]+$ ]] || die "lib/sounds.mjs names an unexpected soundevents file: '$value'"
      sources+=("$value.vsndevts_c") ;;
    dir)
      [[ "$value" =~ ^sounds/[a-z0-9_/]+/$ ]] || die "lib/sounds.mjs names an unexpected sound folder: '$value'"
      dirs+=("$value") ;;
  esac
done <<< "$lists_js"
[[ "${#sources[@]}" -gt 0 && "${#dirs[@]}" -gt 0 ]] || die "lib/sounds.mjs gave no soundevents files or no sound folders"
sources+=(surfaceproperties/surfaceproperties.vsurf_c scripts/surfaceproperties_footsteps.txt)

# What --list-missing may name: build-sounds.mjs's VPK_PATH, the one pattern both check. The
# module comes in the environment, not argv[1]: there it would take itself for the CLI and build.
vpk_path="$(BUILD_SOUNDS="$tools_dir/build-sounds.mjs" node --input-type=module -e '
  const m = await import(process.env.BUILD_SOUNDS);
  process.stdout.write(m.VPK_PATH.source);
')" || die "could not read VPK_PATH from build-sounds.mjs"
[[ -n "$vpk_path" ]] || die "build-sounds.mjs gave an empty VPK_PATH"

dest="$ASSETS_DIR/raw/sounds"

# The VPK paths build-sounds.mjs still needs for the raw dir $1, one per line.
list_missing() {
  SOUNDS_RAW_DIR="$1" node "$tools_dir/build-sounds.mjs" --list-missing
}

# full: export everything and swap the whole folder; add: export what is missing beside it.
mode=full
if [[ -f "$dest/rip.json" && "$force" -eq 0 ]]; then
  ripped_build="$(rip_field "$dest/rip.json" cs2Build)"
  if [[ "$ripped_build" == "$CS2_BUILD" ]]; then
    todo="$(list_missing "$dest")" || die "build-sounds.mjs --list-missing failed for $dest"
    if [[ -z "$todo" ]]; then
      printf '%s: sounds already ripped from CS2 build %s (%s exists); pass --force to re-export\n' \
        "$(basename -- "$0")" "$CS2_BUILD" "$dest/rip.json" >&2
      exit 0
    fi
    mode=add
    printf '%s: the rip of CS2 build %s lacks %d file(s) the build needs; exporting only those\n' \
      "$(basename -- "$0")" "$CS2_BUILD" "$(wc -l <<< "$todo")" >&2
  else
    printf '%s: WARNING: sounds were ripped from CS2 build %s but the install is build %s; re-exporting\n' \
      "$(basename -- "$0")" "${ripped_build:-unknown}" "$CS2_BUILD" >&2
  fi
fi

rip_begin "$dest"

# Add mode: moves each file exported into $rip_tmp/add to the same path under $dest; a file already
# there (a .vsnd sidecar) is kept.
add_exported() {
  local f
  while IFS= read -r -d '' f; do
    f="${f#./}"
    [[ ! -e "$dest/$f" ]] || continue
    mkdir -p -- "$dest/$(dirname -- "$f")"
    mv -- "$rip_tmp/add/$f" "$dest/$f"
  done < <(cd -- "$rip_tmp/add" && find . -type f -print0)
  rm -rf -- "$rip_tmp/add"
}

start=$SECONDS
if [[ "$mode" == full ]]; then
  # The soundevents and the surface files, in one run; VRF writes <name>.vsndevts for <name>.vsndevts_c.
  rip_cli "soundevents and surface properties" -i "$pak" -o "$rip_tmp" -d -f "$(IFS=,; printf '%s' "${sources[*]}")"
  for f in "${sources[@]}"; do
    [[ -s "$rip_tmp/${f%_c}" ]] || die "export produced no ${f%_c}"
  done
  # Every sound under the folders, in one threaded run.
  rip_cli "sounds under ${dirs[*]}" -i "$pak" -o "$rip_tmp" -d -e vsnd_c --threads 16 -f "$(IFS=,; printf '%s' "${dirs[*]}")"
  for d in "${dirs[@]}"; do
    [[ -n "$(find "$rip_tmp/$d" -type f \( -name '*.wav' -o -name '*.mp3' \) -print -quit 2> /dev/null)" ]] \
      || die "export produced no .wav or .mp3 under $d"
  done
  check="$rip_tmp"
  into="$rip_tmp"
else
  check="$dest"
  into="$rip_tmp/add"
fi

# Then one run per file --list-missing names, each file once, until it names none not yet
# tried: a missing soundevents file first, then the sounds it names (two or three rounds in
# practice; capped at five). `todo` is listed afresh whenever the loop ends.
declare -A tried=()
todo=""
exported=0
rounds=0
while :; do
  todo="$(list_missing "$check")" || die "build-sounds.mjs --list-missing failed for $check"
  new=()
  while read -r file; do
    [[ -n "$file" ]] || continue
    [[ "$file" =~ $vpk_path && "/$file/" != */../* ]] \
      || die "build-sounds.mjs --list-missing named an unexpected path: '$file'"
    [[ -n "${tried[$file]:-}" ]] || new+=("$file")
  done <<< "$todo"
  [[ "${#new[@]}" -gt 0 && "$rounds" -lt 5 ]] || break
  rounds=$((rounds + 1))
  mkdir -p -- "$into"
  for file in "${new[@]}"; do
    tried[$file]=1
    rip_cli "$file" -i "$pak" -o "$into" -d -f "$file"
    exported=$((exported + 1))
  done
  [[ "$mode" == full ]] || add_exported
done
# Still named: tried and the VPK gave nothing (absent), or not tried before the cap.
absent=()
untried=()
while read -r file; do
  [[ -n "$file" ]] || continue
  if [[ -n "${tried[$file]:-}" ]]; then absent+=("$file"); else untried+=("$file"); fi
done <<< "$todo"
if [[ "${#absent[@]}" -gt 0 ]]; then
  printf '%s: WARNING: the VPK gave nothing for %d file(s); rip.json lists them as absent (--force tries them again) and build-sounds.mjs leaves out the keys that play them: %s\n' \
    "$(basename -- "$0")" "${#absent[@]}" "${absent[*]}" >&2
fi
if [[ "${#untried[@]}" -gt 0 ]]; then
  printf '%s: WARNING: %d file(s) still to export after %d rounds; run this again: %s\n' \
    "$(basename -- "$0")" "${#untried[@]}" "$rounds" "${untried[*]}" >&2
fi
absent_rows="$(printf '%s\n' "${absent[@]}")"

if [[ "$mode" == add ]]; then
  if [[ "${#absent[@]}" -gt 0 ]]; then
    node -e '
      const fs = require("node:fs");
      const [file, out, rows] = process.argv.slice(1);
      const rip = JSON.parse(fs.readFileSync(file, "utf8"));
      const absent = new Set(Array.isArray(rip.absent) ? rip.absent : []);
      for (const f of rows.split("\n").filter(Boolean)) absent.add(f);
      rip.absent = [...absent].sort();
      fs.writeFileSync(out, JSON.stringify(rip, null, 2) + "\n");
    ' "$dest/rip.json" "$rip_tmp/rip.json" "$absent_rows" || die "could not add the absent files to rip.json"
    mv -- "$rip_tmp/rip.json" "$dest/rip.json"
  fi
  rip_added
  printf '%s: %d missing file(s) exported in %ds into %s (CS2 build %s, VRF %s)\n' \
    "$(basename -- "$0")" "$exported" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
  exit 0
fi

exported_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
node -e '
  const [cs2Build, vrfVersion, exportedAt, rows] = process.argv.slice(1);
  const absent = rows.split("\n").filter(Boolean).sort();
  process.stdout.write(JSON.stringify({ cs2Build, vrfVersion, exportedAt, absent }, null, 2) + "\n");
' "$CS2_BUILD" "$vrf_version" "$exported_at" "$absent_rows" > "$rip_tmp/rip.json"
[[ -s "$rip_tmp/rip.json" ]] || die "could not write rip.json"
sounds="$(find "$rip_tmp/sounds" -type f \( -name '*.wav' -o -name '*.mp3' \) | wc -l)"

rip_commit
printf '%s: %d sound(s) and %d soundevents/surface file(s) ripped in %ds into %s (CS2 build %s, VRF %s)\n' \
  "$(basename -- "$0")" "$sounds" "${#sources[@]}" "$((SECONDS - start))" "$dest" "$CS2_BUILD" "$vrf_version" >&2
