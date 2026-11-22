"""Turn a USB capture into a readable list of the V500's bulk transfers.

    python tools/usbpcap.py captures/<ts>/02-scan-75dpi.usblog
    python tools/usbpcap.py captures/<ts>/02-scan-75dpi.pcap --device 5 --max-bytes 64

Only the standard library. Reads two formats:
- `.usblog` from tools/capture/usblog.c: every transfer with full data.
- `.pcap` that tcpdump writes from usbmonN (link type 220 or 189). On IOMMU
  machines large transfers come with no data; their size is still shown.
"""

import argparse
import struct
import sys
from collections.abc import Iterator
from dataclasses import dataclass

LINKTYPE_USB_LINUX = 189          # 48-byte header
LINKTYPE_USB_LINUX_MMAPPED = 220  # 64-byte header
BULK = 3


@dataclass
class Transfer:
    time: float
    device: int
    endpoint: int
    out: bool
    data: bytes


def packets(path: str) -> Iterator[tuple[int, float, bytes]]:
    with open(path, "rb") as f:
        head = f.read(24)
        magic = head[:4]
        if magic in (b"\xd4\xc3\xb2\xa1", b"\x4d\x3c\xb2\xa1"):
            end = "<"
        elif magic in (b"\xa1\xb2\xc3\xd4", b"\xa1\xb2\x3c\x4d"):
            end = ">"
        else:
            raise SystemExit(f"{path}: not a pcap file (pcapng is not supported)")
        nano = magic in (b"\x4d\x3c\xb2\xa1", b"\xa1\xb2\x3c\x4d")
        linktype = struct.unpack(end + "I", head[20:24])[0]
        while rec := f.read(16):
            sec, frac, caplen, _ = struct.unpack(end + "IIII", rec)
            yield linktype, sec + frac / (1e9 if nano else 1e6), f.read(caplen)


def header_len(linktype: int) -> int:
    if linktype == LINKTYPE_USB_LINUX_MMAPPED:
        return 64
    if linktype == LINKTYPE_USB_LINUX:
        return 48
    raise SystemExit(f"link type {linktype} is not usbmon")


def transfers(path: str) -> Iterator[Transfer]:
    """Every bulk transfer that carries data."""
    for linktype, t, pkt in packets(path):
        kind, xfer, ep, dev = chr(pkt[8]), pkt[9], pkt[10], pkt[11]
        is_in = bool(ep & 0x80)
        # Data rides on the submit for OUT and on the completion for IN.
        if xfer == BULK and ((kind == "S" and not is_in) or (kind == "C" and is_in)):
            yield Transfer(t, dev, ep & 0x7F, not is_in, pkt[header_len(linktype):])


USBLOG_MAGIC = b"V5USBLOG"
USBLOG_RECORD = struct.Struct("<dBBiII")


def usblog_transfers(path: str) -> Iterator[Transfer]:
    with open(path, "rb") as f:
        if f.read(8) != USBLOG_MAGIC:
            raise SystemExit(f"{path}: not a usblog file")
        while head := f.read(USBLOG_RECORD.size):
            if len(head) < USBLOG_RECORD.size:
                break  # the writer was killed mid-record
            t, ep, _kind, _rc, requested, actual = USBLOG_RECORD.unpack(head)
            is_in = bool(ep & 0x80)
            data = f.read(actual if is_in else requested)
            yield Transfer(t, 0, ep & 0x7F, not is_in, data)


def is_usblog(path: str) -> bool:
    with open(path, "rb") as f:
        return f.read(8) == USBLOG_MAGIC


def find_v500(path: str) -> int | None:
    """The device number that answered with vendor 04b8 product 0130."""
    for linktype, _, pkt in packets(path):
        data = pkt[header_len(linktype):]
        if chr(pkt[8]) == "C" and len(data) >= 12 and data[1] == 1 and data[8:12] == b"\xb8\x04\x30\x01":
            return pkt[11]
    devices = {}
    for tr in transfers(path):
        devices[tr.device] = devices.get(tr.device, 0) + len(tr.data)
    # No descriptor seen: fall back to the device moving the most bulk data.
    return max(devices, key=devices.get) if devices else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("pcap")
    parser.add_argument("--device", type=int, help="USB device number (default: find the V500)")
    parser.add_argument("--max-bytes", type=int, default=32, help="hex bytes to show per transfer")
    args = parser.parse_args()

    if is_usblog(args.pcap):
        source, device = usblog_transfers(args.pcap), 0  # only the scanner is logged
    else:
        device = args.device or find_v500(args.pcap)
        if device is None:
            raise SystemExit("no bulk traffic found")
        source = transfers(args.pcap)
    print(f"# device {device}")
    start = None
    total = {True: 0, False: 0}
    for tr in source:
        if tr.device != device or not tr.data:
            continue
        start = start if start is not None else tr.time
        total[tr.out] += len(tr.data)
        shown = tr.data[: args.max_bytes].hex(" ")
        more = " ..." if len(tr.data) > args.max_bytes else ""
        arrow = "->" if tr.out else "<-"
        print(f"{tr.time - start:9.4f} {arrow} {len(tr.data):7d}: {shown}{more}")
    print(f"# {total[True]} bytes out, {total[False]} bytes in", file=sys.stderr)


if __name__ == "__main__":
    main()
