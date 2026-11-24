#!/usr/bin/env bash
# home-video.sh
#
# Renders the homepage video (home-video/shots.json, home-video.mjs) into
# $ASSETS_DIR/site/home/: hero.mp4 (H.264 High, yuv420p, +faststart, no audio, 60 fps, at most
# 4 MB: its quality is lowered until it fits), hero.webm (VP9, two passes) and poster.jpg (the
# first frame), then writes the site manifest again (node tools/manifest.mjs site).
#
# Builds nothing. It needs:
#   HOME_VIDEO_DEMOS    the folder holding the demos shots.json names (no default)
#   HOME_VIDEO_SERVER   a release server binary (default server/target/release/demoviewer-server)
#   web/dist            the built web app
#   raw/site/chicken.glb  from the site kind (lib/kinds.mjs)
#   ffmpeg              with libx264 and libvpx
# It starts the server on a free port with a temp data dir, uploads the demos through the API,
# captures every frame through the viewer, encodes, puts the three files in place together
# (written into site/home.tmp-<pid>/ and renamed), and stops the server by its PID. The frames
# and the data dir are deleted either way. About 5 minutes to capture, a few to encode.
set -euo pipefail

die() {
  printf '%s: %s\n' "$(basename -- "$0")" "$*" >&2
  exit 1
}

tools_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$tools_dir/.." && pwd)"
ASSETS_DIR="${ASSETS_DIR:-$repo_dir/assets}"
: "${HOME_VIDEO_DEMOS:?set HOME_VIDEO_DEMOS to the folder holding the demos tools/home-video/shots.json names}"
server="${HOME_VIDEO_SERVER:-$repo_dir/server/target/release/demoviewer-server}"
web="$repo_dir/web/dist"
chicken="$ASSETS_DIR/raw/site/chicken.glb"
max_mp4=4000000

[[ -x "$server" ]] || die "no server binary at $server (cargo build --release -p demoviewer-server, or set HOME_VIDEO_SERVER)"
[[ -f "$web/index.html" ]] || die "no web build at $web (cd web && npm run build)"
[[ -f "$chicken" ]] || die "no $chicken (build the site kind: tools/rip-site.sh, then node tools/shrink-chicken.mjs)"
command -v ffmpeg > /dev/null || die "ffmpeg is not on PATH"
command -v node > /dev/null || die "node is not on PATH"
while read -r demo; do
  [[ -f "$HOME_VIDEO_DEMOS/$demo" ]] || die "no $demo in HOME_VIDEO_DEMOS ($HOME_VIDEO_DEMOS)"
done < <(node -e 'for (const d of Object.values(require(process.argv[1]).demos)) console.log(d)' "$tools_dir/home-video/shots.json")

work="$(mktemp -d "${TMPDIR:-/tmp}/home-video.XXXXXX")"
stage="$ASSETS_DIR/site/home.tmp-$$"
pid=""
cleanup() {
  if [[ -n "$pid" ]] && kill -0 "$pid" 2> /dev/null; then
    kill "$pid" || true
    wait "$pid" 2> /dev/null || true
  fi
  rm -rf -- "$work" "$stage"
}
trap cleanup EXIT

port="$(node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
mkdir -p -- "$work/data"
DEMOVIEWER_PORT="$port" DEMOVIEWER_DATA="$work/data" DEMOVIEWER_ASSETS="$ASSETS_DIR" DEMOVIEWER_WEB="$web" \
  DEMOVIEWER_PREVIEWS=0 "$server" > "$work/server.log" 2>&1 &
pid=$!
base="http://127.0.0.1:$port"
for _ in $(seq 1 100); do
  node -e 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))' "$base/healthz" && break
  kill -0 "$pid" 2> /dev/null || { tail -n 20 "$work/server.log" >&2; die "the server stopped"; }
  sleep 0.2
done

node "$tools_dir/home-video.mjs" capture --base "$base" --demos "$HOME_VIDEO_DEMOS" --frames "$work/frames" --chicken "$chicken"

mkdir -p -- "$stage"
args() { node --input-type=module -e '
  const { ffmpegArgs } = await import(process.argv[1]);
  console.log(ffmpegArgs(process.argv[2], process.argv[3], process.argv[4], Number(process.argv[5]), Number(process.argv[6])).join("\n"));
' "$tools_dir/home-video.mjs" "$@"; }
crf=23
while :; do
  mapfile -t a < <(args mp4 "$work/frames" "$stage/hero.mp4" "$crf" 2)
  ffmpeg -loglevel error "${a[@]}"
  size="$(stat -c %s "$stage/hero.mp4")"
  [[ "$size" -le "$max_mp4" ]] && break
  printf '%s: hero.mp4 is %d bytes at CRF %d; trying %d\n' "$(basename -- "$0")" "$size" "$crf" "$((crf + 1))" >&2
  crf=$((crf + 1))
  [[ "$crf" -le 35 ]] || die "hero.mp4 does not fit $max_mp4 bytes even at CRF 35"
done
for pass in 1 2; do
  mapfile -t a < <(args webm "$work/frames" "$stage/hero.webm" 32 "$pass")
  (cd -- "$stage" && ffmpeg -loglevel error "${a[@]}")
done
rm -f -- "$stage"/hero.webm.vp9*
ffmpeg -loglevel error -y -i "$work/frames/0000.png" -q:v 3 "$stage/poster.jpg"

mkdir -p -- "$ASSETS_DIR/site/home"
for f in hero.mp4 hero.webm poster.jpg; do
  mv -f -- "$stage/$f" "$ASSETS_DIR/site/home/$f"
done
ASSETS_DIR="$ASSETS_DIR" node "$tools_dir/manifest.mjs" site
printf '%s: hero.mp4 %d bytes (CRF %d), hero.webm %d bytes, poster.jpg %d bytes\n' "$(basename -- "$0")" \
  "$(stat -c %s "$ASSETS_DIR/site/home/hero.mp4")" "$crf" "$(stat -c %s "$ASSETS_DIR/site/home/hero.webm")" \
  "$(stat -c %s "$ASSETS_DIR/site/home/poster.jpg")" >&2
