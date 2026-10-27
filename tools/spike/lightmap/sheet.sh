#!/usr/bin/env bash
# Spike (Task 1b): a phone-readable contact sheet, one labelled panel per image, stacked in a column.
#   tools/spike/lightmap/sheet.sh <out.jpg> <title> <image> <label> [<image> <label>]...
set -euo pipefail
[[ $# -ge 4 && $(( ($# - 2) % 2 )) -eq 0 ]] || { echo "usage: $0 <out.jpg> <title> (<image> <label>)..." >&2; exit 2; }
out=$1 title=$2
shift 2
args=(-size 900x56 -background '#0b0d10' -fill '#ffffff' -font DejaVu-Sans-Bold -pointsize 30 -gravity center "label:$title")
while [[ $# -gt 0 ]]; do
  args+=( \( "$1" -resize 900x -gravity north -background '#16181c' -fill '#f2f2f2' -font DejaVu-Sans -pointsize 25 -splice 0x44 -gravity northwest -annotate +12+8 "$2" -bordercolor '#0b0d10' -border 0x6 \) )
  shift 2
done
magick "${args[@]}" -background '#0b0d10' -append -quality 82 "$out"
echo "$out $(magick identify -format '%wx%h' "$out")"
