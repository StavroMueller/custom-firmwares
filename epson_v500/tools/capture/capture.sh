#!/bin/bash
# Record the USB traffic of real V500 scans made with Epson's own driver.
#
#   sudo tools/capture/capture.sh /path/to/iscan-gt-x770-bundle-2.30.4.x64.deb.tar.gz
#
# Power-cycle the scanner first, so the capture starts from "no firmware".
# Epson's driver runs in a container (tools/capture/Dockerfile); the host
# records bus traffic with usbmon. Output goes to captures/<timestamp>/:
#   NN-step.pcap   full USB traffic of the scanner's bus (open in Wireshark)
#   NN-step.log    epkowa debug log
#   *.png          the scans
# The pcaps contain Epson's firmware bytes: they are gitignored, never commit them.
set -euo pipefail

BUNDLE_SHA256=5c10ccc8a3d17f0a5be4b36a9ca273a2e16749a50bb61dbdba71f4587bc3181e
IMAGE=v500-iscan
HERE=$(dirname "$(readlink -f "$0")")
ROOT=$(readlink -f "$HERE/../..")

[ "$(id -u)" = 0 ] || { echo "run with sudo (usbmon and docker need root)" >&2; exit 1; }
[ $# -ge 1 ] || { echo "usage: sudo $0 <bundle.tar.gz> [out-dir]" >&2; exit 2; }
BUNDLE=$(readlink -f "$1")
OUT=$(readlink -m "${2:-$ROOT/captures/$(date +%Y%m%d-%H%M%S)}")

echo "$BUNDLE_SHA256  $BUNDLE" | sha256sum --check --quiet \
    || { echo "bundle checksum mismatch" >&2; exit 1; }

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
tar xzf "$BUNDLE" -C "$ctx"
mkdir "$ctx/debs"
find "$ctx" -type f -name '*.deb' -not -path "$ctx/debs/*" -exec cp {} "$ctx/debs/" \;
cp "$HERE/Dockerfile" "$HERE/scan.sh" "$ctx/"
chmod +x "$ctx/scan.sh"
docker build -q -t "$IMAGE" "$ctx" >/dev/null
echo "built image $IMAGE"

read -r BUS DEV < <(lsusb -d 04b8:0130 | awk '{print $2, substr($4, 1, 3)}')
[ -n "${BUS:-}" ] || { echo "scanner 04b8:0130 not on USB" >&2; exit 1; }
modprobe usbmon
mkdir -p "$OUT"
[ -n "${SUDO_USER:-}" ] && trap 'rm -rf "$ctx"; chown -R "$SUDO_USER:" "$OUT"' EXIT
echo "scanner at bus $BUS device $DEV; writing to $OUT"

step() {
    local name=$1; shift
    tcpdump -q -i "usbmon$((10#$BUS))" -s 0 -U -w "$OUT/$name.pcap" 2>/dev/null &
    local pid=$!
    sleep 1
    local rc=0
    docker run --rm --device "/dev/bus/usb/$BUS/$DEV" -v "$OUT:/out" \
        -e SANE_DEBUG_EPKOWA=128 -e SANE_DEBUG_DLL=4 "$IMAGE" "$@" >"$OUT/$name.out" 2>"$OUT/$name.log" || rc=$?
    sleep 1
    kill "$pid"; wait "$pid" 2>/dev/null || true
    echo "$rc" >"$OUT/$name.exit"
    echo "$name: exit $rc, $(stat -c %s "$OUT/$name.pcap") bytes captured"
}

step 01-list list
step 02-scan-75dpi 75 02-scan-75dpi.png
step 03-scan-300dpi 300 03-scan-300dpi.png

echo "done: $OUT"
