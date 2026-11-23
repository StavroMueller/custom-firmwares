#!/bin/sh
# Runs inside the container: one scanimage step against the first epkowa device.
#   scan list                       list devices (opening one uploads the firmware)
#   scan options                    print the scanner's options (resolutions, modes, ...)
#   scan <file> [scanimage args]    scan to /out/<file> as PNG, e.g.
#                                   scan a.png --mode Color --resolution 400 -l 20 -t 30 -x 60 -y 40
set -eu
# stdbuf: if scanimage crashes on exit, its output is still written.
if [ "$1" = list ]; then
    exec stdbuf -oL scanimage -L
fi
dev=$(stdbuf -oL scanimage -f '%d%n' 2>/dev/null | grep '^epkowa' | head -n 1 || true)
[ -n "$dev" ] || { echo "no epkowa device found" >&2; exit 1; }
echo "device: $dev" >&2
if [ "$1" = options ]; then
    exec stdbuf -oL scanimage -d "$dev" --all-options
fi
file=$1; shift
exec scanimage -d "$dev" --format=png -o "/out/$file" "$@"
