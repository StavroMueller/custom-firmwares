#!/bin/sh
# Runs inside the container: one scanimage step against the first epkowa device.
#   scan list            list devices (opening one uploads the firmware)
#   scan <dpi> <file>    full-bed colour scan to /out/<file> as PNG
set -eu
if [ "$1" = list ]; then
    exec scanimage -L
fi
dev=$(scanimage -f '%d%n' | grep '^epkowa' | head -n 1)
[ -n "$dev" ] || { echo "no epkowa device found" >&2; exit 1; }
echo "device: $dev" >&2
exec scanimage -d "$dev" --mode Color --resolution "$1" --format=png > "/out/$2"
