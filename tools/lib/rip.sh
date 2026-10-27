# shellcheck shell=bash
# The rip protocol, sourced after lib/env.sh by every rip-*.sh script that exports into
# $ASSETS_DIR/raw. An export is written into <dest>.tmp-<pid>/ (the temp name lib/stage.mjs
# reads back) and swapped into place only when it is complete: the previous export is moved
# aside to <dest>.old-<pid>/ first and put back if the swap fails, so <dest> is never
# half-written. Any failure (die, a failed command under set -e, a signal) removes the temp dir
# and keeps the CLI's output as <dest>.rip-failed.log. A rip killed outright leaves its temp dir
# (and, mid-swap, the previous export moved aside), which build-assets.sh reclaims when it next
# starts.
#
# Defines:
#   rip_begin <dest>          a fresh, empty <dest>.tmp-<pid>/ ($rip_tmp) holding an empty
#                             rip.log ($rip_log); <dest>'s parent is made if missing
#   rip_cli <what> <args...>  Source2Viewer-CLI <args...>, its command line and output appended
#                             to rip.log; on a non-zero exit, dies with the tail of that output
#   rip_cli_output            the last rip_cli's command line and output, from rip.log
#   rip_commit                swaps $rip_tmp into place as <dest> and forgets it
#   rip_added                 for an export added beside <dest> rather than swapped in (rip-weapons.sh,
#                             rip-sounds.sh): appends rip.log to <dest>/rip.log and forgets the
#                             temp dir, which the caller has moved what it needs out of
#   rip_field <json> <key>    a top-level field of <json>, nothing when it is absent or unreadable
#   rip_fresh <json> [<vrf>]  whether <json> exists and records the installed CS2 build (and,
#                             given <vrf>, that VRF version)
#   rip_vrf                   sets vrf_version to S2V_CLI's VRF version (lib/vrf.mjs, the parser
#                             model-poses.mjs uses too), or dies
# and the one EXIT trap that cleans up after a failure, with INT and TERM exiting 130 and 143
# through it.

rip_tools="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

# The export being written: rip_begin sets these and rip_commit and rip_added clear them.
rip_dest=""
rip_tmp=""
rip_old=""
rip_log=""
rip_failed_log=""
rip_cli_from=0

rip_begin() {
  rip_dest="$1"
  rip_tmp="$1.tmp-$$"
  rip_old="$1.old-$$"
  rip_log="$rip_tmp/rip.log"
  rip_failed_log="$1.rip-failed.log"
  rm -rf -- "$rip_tmp"
  # Must exist before the first export: with a single-file filter and a missing -o directory,
  # the CLI treats -o as the output file name instead of a folder.
  mkdir -p -- "$rip_tmp"
  : > "$rip_log"
}

rip_cli() {
  local what="$1" rc=0
  shift
  rip_cli_from="$(wc -c < "$rip_log")"
  {
    printf '\n=== %s\n=== %q' "$what" "$S2V_CLI"
    printf ' %q' "$@"
    printf '\n'
  } >> "$rip_log"
  "$S2V_CLI" "$@" < /dev/null >> "$rip_log" 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    rip_cli_output | tail -n 15 >&2 || true
    die "Source2Viewer-CLI exited $rc exporting $what for ${rip_dest#"$ASSETS_DIR/"}"
  fi
}

rip_cli_output() {
  tail -c "+$((rip_cli_from + 1))" -- "$rip_log"
}

rip_forget() {
  rip_dest=""
  rip_tmp=""
  rip_old=""
  rip_log=""
  rip_failed_log=""
}

rip_commit() {
  if [[ -e "$rip_dest" ]]; then
    mv -- "$rip_dest" "$rip_old"
  fi
  if ! mv -- "$rip_tmp" "$rip_dest"; then
    [[ ! -e "$rip_old" ]] || mv -- "$rip_old" "$rip_dest"
    die "could not move the export into place at '$rip_dest'"
  fi
  rm -rf -- "$rip_old"
  rm -f -- "$rip_failed_log"
  rip_forget
}

rip_added() {
  cat -- "$rip_log" >> "$rip_dest/rip.log"
  rm -f -- "$rip_failed_log"
  rm -rf -- "$rip_tmp"
  rip_forget
}

rip_field() {
  node -e '
    try {
      const v = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]];
      process.stdout.write(String(v ?? ""));
    } catch {}
  ' "$1" "$2"
}

rip_fresh() {
  [[ -f "$1" && "$(rip_field "$1" cs2Build)" == "$CS2_BUILD" ]] \
    && [[ $# -lt 2 || "$(rip_field "$1" vrfVersion)" == "$2" ]]
}

rip_vrf() {
  # shellcheck disable=SC2034  # the rip script that sources this reads it
  vrf_version="$(node "$rip_tools/lib/vrf.mjs" "$S2V_CLI")" \
    || die "could not read the VRF version of S2V_CLI ('$S2V_CLI')"
}

# EXIT (not only ERR) so that die, a failed command under set -e and a signal all leave no
# partial directory. A previous export still moved aside (a failure mid-swap) goes back.
rip_cleanup() {
  local rc=$?
  if [[ "$rc" -ne 0 && -n "$rip_tmp" && -s "$rip_log" ]]; then
    cp -- "$rip_log" "$rip_failed_log" 2> /dev/null \
      && printf '%s: CLI output kept in %s\n' "$(basename -- "$0")" "$rip_failed_log" >&2
  fi
  [[ -z "$rip_tmp" ]] || rm -rf -- "$rip_tmp"
  if [[ -n "$rip_old" && -e "$rip_old" ]]; then
    if [[ -e "$rip_dest" ]]; then
      rm -rf -- "$rip_old"
    else
      mv -- "$rip_old" "$rip_dest"
    fi
  fi
  return "$rc"
}
trap rip_cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
