#!/usr/bin/env bash
# build-assets.sh <map>... | all [--force]
#
# Builds the served assets/ tree. Per map, in order, stopping at the first failure:
#   rip-map.sh <map> [--force] → rip-lighting.sh <map> [--force] → model-poses.sh <map>
#   → radar.mjs → sky.mjs → shrink-map.mjs → phone-tier.mjs <map> → hero.sh
#   → check-map.mjs <map> --budget-override → manifest.mjs <map>
# (radar.mjs and sky.mjs read only the raw export; they run before shrink-map.mjs, whose
# first-load cap counts the radars, overview and sky they write; phone-tier.mjs makes
# world_lo.glb from the world.glb shrink-map.mjs wrote, and skips it when it is up to date)
# then once each asset kind of lib/kinds.mjs KINDS (players, weapons, … in its order), by its
# plan (`node tools/lib/kinds.mjs plan` prints them all): its steps, the first a rip-*.sh
# [--force], then its check-*.mjs → manifest.mjs <kind>; and finally manifest.mjs root, which
# lists the maps whose manifest.json exists and the kinds whose manifest does.
#
# `all` is every map the pipeline builds (MAPS in lib/env.sh: Active Duty and de_cache). --force is passed to the
# rip steps only (they otherwise skip a map or players already ripped); the shrink,
# radar, check and manifest steps always run, and their outputs are byte-identical
# when the raw export did not change. check-map.mjs gets --budget-override, so a map
# with an entry in lib/budgets.mjs BUDGET_OVERRIDES (the design doc's per-map ladder)
# is held to that entry; Mirage has none and is held to the plan's budgets.
#
# A map's manifest.json (and each kind's, the sounds' with its .gz) is removed
# when its build starts, before any step can change the files it describes, and
# rewritten only when the build finishes; a build that fails or is interrupted
# (Ctrl-C, kill, power loss) leaves the map unlisted rather than described by a
# manifest of older files. The root
# manifest ($ASSETS_DIR/manifest.json) is removed when the run starts and written
# at its end from the per-map manifests that exist, so it leaves a failed map out;
# an interrupted run, or a failed `manifest.mjs root`, leaves none, and
# sync-assets.sh refuses until a run finishes (`node tools/manifest.mjs root`
# rewrites it from what is there). A failing map (or kind)
# is reported and skipped, and the next map goes ahead. Exit 1 at the end if
# anything failed, 2 on a usage error, and 1 at once (naming the variable, before
# anything is written) when CS2_DIR or S2V_CLI does not resolve. Every step's full
# output goes to $ASSETS_DIR/build.log, which each run starts afresh, with one
# `OK <map>` or `FAIL <map> at <step>` line per map; the terminal gets one line per
# step and the tail of a failing step's output. The log is also a lock: a second
# build-assets.sh (or sync-assets.sh) refuses to start.
set -euo pipefail

usage() {
  printf 'usage: %s <map>... | all [--force]\n' "$(basename -- "$0")" >&2
  exit 2
}

maps=()
force=()
for arg in "$@"; do
  case "$arg" in
    --force) force=(--force) ;;
    -h|--help) usage ;;
    -*) usage ;;
    *) maps+=("$arg") ;;
  esac
done
[[ ${#maps[@]} -gt 0 ]] || usage

tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Exits 1 naming CS2_DIR or S2V_CLI when either does not resolve.
# shellcheck source=lib/env.sh
source "$tools/lib/env.sh"

# Expand `all`, drop repeats (first occurrence wins), validate names.
declare -A seen=()
list=()
for m in "${maps[@]}"; do
  if [[ "$m" == all ]]; then
    read -r -a expanded <<< "$MAPS"
  else
    expanded=("$m")
  fi
  for x in "${expanded[@]}"; do
    [[ "$x" =~ ^[a-z0-9_]+$ ]] || die "map name must match [a-z0-9_]+ or be 'all' (got '$x')"
    [[ -n "${seen[$x]:-}" ]] && continue
    seen[$x]=1
    list+=("$x")
  done
done

command -v node > /dev/null || die "node is not on PATH"
[[ -d "$tools/node_modules" ]] || die "tools/node_modules is missing; run 'npm install' in $tools"

# The asset kinds and each one's plan (lib/kinds.mjs), read before anything is written: the
# lines are `<kind> rm <file>`, `<kind> rip <script> <args…>` and `<kind> step <script> <args…>`.
plan_text="$(node "$tools/lib/kinds.mjs" plan)" || die "cannot read the asset kinds from $tools/lib/kinds.mjs"
kinds=()
declare -A plan=()
while read -r kind rest; do
  [[ -n "$kind" ]] || continue
  [[ -n "${plan[$kind]+set}" ]] || kinds+=("$kind")
  plan[$kind]+="$rest"$'\n'
done <<< "$plan_text"
((${#kinds[@]} > 0)) || die "lib/kinds.mjs lists no asset kinds"

mkdir -p "$ASSETS_DIR"
log="$ASSETS_DIR/build.log"
exec 9>> "$log"
flock -n 9 || die "another build-assets.sh is running (it holds $log)"
: > "$log"
# Until this run writes a new one, the old root manifest would list maps whose
# manifest.json the steps below remove; sync-assets.sh refuses without it.
rm -f -- "$ASSETS_DIR/manifest.json"

trap 'exit 130' INT
trap 'exit 143' TERM

# say <line>: to the terminal and the log.
say() {
  printf '%s\n' "$*"
  printf '%s\n' "$*" >> "$log"
}

# Reclaim what a killed run left behind: a forced kill (or a signal during
# shrink-map.mjs, which has no handler) skips a script's own cleanup. Every step
# writes through <target>.tmp-<pid> (lib/stage.mjs; the rips through lib/rip.sh), and
# lib/stage.mjs's sweep reads the pid back from that name anywhere under
# $ASSETS_DIR: a leftover of a process that is gone is removed, and a rip's
# <x>.old-<pid> (the previous export moved aside mid-swap) goes back to <x> if that
# is missing. The lock means no other build is running; a leftover whose pid is
# still alive belongs to a script started by hand, so it is left alone.
swept="$(node "$tools/lib/stage.mjs" sweep "$ASSETS_DIR")" \
  || die "could not reclaim the leftovers of killed runs under $ASSETS_DIR"
[[ -z "$swept" ]] || say "$swept"

failed_step=""
# step <label> <cmd>...: runs cmd with its output appended to the log; prints one
# status line, and on failure the last lines of that output. Returns cmd's status.
step() {
  local label="$1"
  shift
  local t0=$SECONDS rc=0 offset
  offset=$(stat -c %s "$log")
  printf -- '--- %s %s: %s\n' "$(date -u +%FT%TZ)" "$label" "$*" >> "$log"
  "$@" >> "$log" 2>&1 || rc=$?
  local secs=$((SECONDS - t0))
  if ((rc == 0)); then
    say "  $label: ok (${secs}s)"
  else
    failed_step="$label"
    local out
    out="$(tail -c +"$((offset + 1))" "$log" | tail -n 15 || true)"
    say "  $label: FAILED, exit $rc (${secs}s)"
    printf '%s\n' "$out" | sed 's/^/    | /'
  fi
  return "$rc"
}

build_map() {
  local map="$1"
  rm -f -- "$ASSETS_DIR/maps/$map/manifest.json"
  step "rip-map.sh $map" bash "$tools/rip-map.sh" "$map" "${force[@]}" \
    && step "rip-lighting.sh $map" bash "$tools/rip-lighting.sh" "$map" "${force[@]}" \
    && step "model-poses.sh $map" bash "$tools/model-poses.sh" "$map" \
    && step "radar.mjs $map" node "$tools/radar.mjs" "$map" \
    && step "sky.mjs $map" node "$tools/sky.mjs" "$map" \
    && step "shrink-map.mjs $map" node "$tools/shrink-map.mjs" "$map" \
    && step "phone-tier.mjs $map" node "$tools/phone-tier.mjs" "$map" \
    && step "hero.sh $map" bash "$tools/hero.sh" "$map" \
    && step "check-map.mjs $map" node "$tools/check-map.mjs" "$map" --budget-override \
    && step "manifest.mjs $map" node "$tools/manifest.mjs" "$map"
}

# build_kind <kind>: its plan (lib/kinds.mjs): the manifest (and its .gz) removed before any
# step can change the files it describes, then each step, a rip with the run's --force, stopping
# at the first failure; the last two are its check and manifest.mjs <kind>. The plan is read on
# fd 3, so no step can read it from stdin.
build_kind() {
  local kind="$1" words
  while read -r -u 3 -a words; do
    ((${#words[@]} > 0)) || continue
    local action="${words[0]}" script="${words[1]}"
    local -a args=("${words[@]:2}") run
    case "$action" in
      rm) rm -f -- "$ASSETS_DIR/$script"; continue ;;
      rip) args+=("${force[@]}") ;;
      step) ;;
      *) failed_step="lib/kinds.mjs plan ($action)"; return 1 ;;
    esac
    case "$script" in
      *.sh) run=(bash "$tools/$script") ;;
      *.mjs) run=(node "$tools/$script") ;;
      *) failed_step="lib/kinds.mjs plan ($script)"; return 1 ;;
    esac
    step "${words[*]:1}" "${run[@]}" "${args[@]}" || return 1
  done 3<<< "${plan[$kind]}"
}

run0=$SECONDS
say "build-assets.sh $(date -u +%FT%TZ): ${list[*]}$(printf ' + %s' "${kinds[@]}"); CS2 build $CS2_BUILD; ASSETS_DIR=$ASSETS_DIR${force[*]:+ (--force)}"
ok=()
failed=()

for map in "${list[@]}"; do
  t0=$SECONDS
  say "$map"
  if build_map "$map"; then
    say "OK $map ($((SECONDS - t0))s)"
    ok+=("$map")
  else
    say "FAIL $map at $failed_step ($((SECONDS - t0))s)"
    failed+=("$map")
  fi
done

for kind in "${kinds[@]}"; do
  t0=$SECONDS
  say "$kind"
  if build_kind "$kind"; then
    say "OK $kind ($((SECONDS - t0))s)"
  else
    say "FAIL $kind at $failed_step ($((SECONDS - t0))s)"
    failed+=("$kind")
  fi
done

if ! step "manifest.mjs root" node "$tools/manifest.mjs" root; then
  say "FAIL root manifest"
  failed+=(root)
fi

say "done in $((SECONDS - run0))s: ok ${ok[*]:-none}; failed ${failed[*]:-none}; log $log"
((${#failed[@]} == 0)) || exit 1
