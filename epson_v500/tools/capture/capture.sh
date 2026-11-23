#!/bin/bash
# Record the USB traffic of real V500 scans made with Epson's own driver.
#
#   sudo tools/capture/capture.sh [--set 2] /path/to/iscan-gt-x770-bundle-2.30.4.x64.deb.tar.gz
#
# Set 1 (the default) is the first survey of settings. Set 2 adds 1600 dpi,
# full-width scans at 400 and 800 dpi, grey at 400 dpi, and the offset scan.
#
# Power-cycle the scanner first, so the capture starts from "no firmware".
# Epson's driver runs in a container (tools/capture/Dockerfile); the host
# records bus traffic with usbmon. Output goes to captures/<timestamp>/:
#   NN-step.usblog every bulk transfer Epson's driver made, with full data
#   NN-step.pcap   USB traffic of the scanner's bus (large transfers have no data
#                  on IOMMU machines; the usblog has them)
#   NN-step.log    epkowa debug log
#   *.png          the scans
# The pcaps contain Epson's firmware bytes: they are gitignored, never commit them.
set -euo pipefail

BUNDLE_SHA256=5c10ccc8a3d17f0a5be4b36a9ca273a2e16749a50bb61dbdba71f4587bc3181e
IMAGE=v500-iscan
HERE=$(dirname "$(readlink -f "$0")")
ROOT=$(readlink -f "$HERE/../..")

[ "$(id -u)" = 0 ] || { echo "run with sudo (usbmon and docker need root)" >&2; exit 1; }
SET=1
if [ "${1:-}" = "--set" ]; then SET=${2:-}; shift 2; fi
[[ "$SET" =~ ^[12]$ ]] || { echo "--set is 1 or 2" >&2; exit 2; }
[ $# -ge 1 ] || { echo "usage: sudo $0 [--set 2] <bundle.tar.gz> [out-dir]" >&2; exit 2; }
BUNDLE=$(readlink -f "$1")
OUT=$(readlink -m "${2:-$ROOT/captures/$(date +%Y%m%d-%H%M%S)}")

echo "$BUNDLE_SHA256  $BUNDLE" | sha256sum --check --quiet \
    || { echo "bundle checksum mismatch" >&2; exit 1; }

ctx=$(mktemp -d)
trap 'rm -rf "$ctx"' EXIT
tar xzf "$BUNDLE" -C "$ctx"
mkdir "$ctx/debs"
find "$ctx" -type f -name '*.deb' -not -path "$ctx/debs/*" -exec cp {} "$ctx/debs/" \;
cp "$HERE/Dockerfile" "$HERE/scan.sh" "$HERE/usblog.c" "$ctx/"
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
        -e SANE_DEBUG_EPKOWA=128 -e SANE_DEBUG_DLL=4 \
        -e LD_PRELOAD=/usr/local/lib/usblog.so -e "USBLOG=/out/$name.usblog" "$IMAGE" "$@" >"$OUT/$name.out" 2>"$OUT/$name.log" || rc=$?
    sleep 1
    kill "$pid"; wait "$pid" 2>/dev/null || true
    echo "$rc" >"$OUT/$name.exit"
    echo "$name: exit $rc, $(stat -c %s "$OUT/$name.pcap") bytes captured"
}

# Each scan differs from another in one setting, so its effect on the
# protocol stands out. Region scans (-l -t -x -y, in mm) keep high dpi quick.
REGION="-l 20 -t 30 -x 60 -y 40"
step 01-list list
step 01-options options
if [ "$SET" = 1 ]; then
    step 02-color-200-full 02-color-200-full.png --mode Color --resolution 200
    step 03-color-200-region 03-color-200-region.png --mode Color --resolution 200 $REGION
    step 04-color-400-region 04-color-400-region.png --mode Color --resolution 400 $REGION
    step 05-color-800-region 05-color-800-region.png --mode Color --resolution 800 $REGION
    step 06-gray-200-region 06-gray-200-region.png --mode Gray --resolution 200 $REGION
    # 16-bit scans hang the scanner until it is power-cycled: keep it near the end
    step 07-color16-200-region 07-color16-200-region.png --mode Color --depth 16 --resolution 200 $REGION
    step 08-color-200-offset 08-color-200-offset.png --mode Color --resolution 200 -l 50 -t 100 -x 60 -y 40
else
    # Same region as set 1's 03-05, so 1600 dpi lines up with 200, 400 and 800.
    step 09-color-1600-region 09-color-1600-region.png --mode Color --resolution 1600 $REGION
    # The whole width, shallow: checks the sensor-window rule on wide areas.
    step 10-color-400-fullwidth 10-color-400-fullwidth.png --mode Color --resolution 400 -l 0 -t 30 -x 215.9 -y 40
    step 11-color-800-fullwidth 11-color-800-fullwidth.png --mode Color --resolution 800 -l 0 -t 30 -x 215.9 -y 20
    step 12-gray-400-region 12-gray-400-region.png --mode Gray --resolution 400 $REGION
    step 13-color-200-offset 13-color-200-offset.png --mode Color --resolution 200 -l 50 -t 100 -x 60 -y 40
fi

echo "done: $OUT"
