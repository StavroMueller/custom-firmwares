#!/bin/sh
# Runs inside the container: one scanimage step against the first epkowa device.
#   scan list            list devices (opening one uploads the firmware)
#   scan <dpi> <file>    full-bed colour scan to /out/<file> as PNG
set -eu
# stdbuf: if scanimage crashes on exit, its output is still written.
if [ "$1" = list ]; then
    exec stdbuf -oL scanimage -L
fi
dev=$(stdbuf -oL scanimage -f '%d%n' 2>/dev/null | grep '^epkowa' | head -n 1 || true)
[ -n "$dev" ] || { echo "no epkowa device found" >&2; exit 1; }
echo "device: $dev" >&2
exec scanimage -d "$dev" --mode Color --resolution "$1" --format=png -o "/out/$2"
