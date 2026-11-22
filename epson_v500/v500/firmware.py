"""Parse Epson's `esfw7C.bin` and upload it to the scanner.

The V500 keeps no firmware in flash. The host uploads it on every power-on.
File layout and the byte-level sequence are in PROTOCOL.md. They were captured
by running Epson's plugin against a fake scanner (tools/trace.c).

Users supply their own copy of the file; Epson's licence forbids
redistributing it.
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

MAGIC = b"EDLA"
UPLOAD_HEADER = slice(0x4C, 0x50)
BODY = slice(0x100, 0x10100)

ACK = 0x06
STATUS = b"\x1b\x03"
BEGIN_UPLOAD = b"\x1b\x06"
RUN = b"\x1b\x16"  # meaning inferred: sent right after the upload
RUN_PARAM = b"\x80"


class Transport(Protocol):
    def write(self, data: bytes) -> None: ...

    def read(self, size: int) -> bytes: ...


class FirmwareError(Exception):
    pass


@dataclass(frozen=True)
class Firmware:
    upload_header: bytes
    body: bytes

    @property
    def checksum(self) -> int:
        return sum(self.body) & 0xFF

    @property
    def ident(self) -> str:
        """The model and version string inside the body, e.g. 'EPSON GT-X770 1.02'."""
        found = re.search(rb"EPSON[ -~]{10,40}", self.body)
        return " ".join(found.group().decode().split()) if found else "unknown"


def parse(data: bytes) -> Firmware:
    if not data.startswith(MAGIC):
        raise FirmwareError(f"not an Epson firmware file (magic {data[:4]!r})")
    if len(data) < BODY.stop:
        raise FirmwareError(f"file is {len(data)} bytes, expected at least {BODY.stop}")
    return Firmware(upload_header=data[UPLOAD_HEADER], body=data[BODY])


def load(path: Path) -> Firmware:
    return parse(Path(path).read_bytes())


def upload(firmware: Firmware, io: Transport) -> None:
    """Run the upload sequence. Raises FirmwareError if the scanner doesn't ACK."""
    io.write(STATUS)
    _expect_ack(io, reply_size=2)  # second byte is a status we don't decode yet

    io.write(BEGIN_UPLOAD)
    _expect_ack(io)

    io.write(firmware.upload_header)
    io.write(firmware.body)
    io.write(bytes([firmware.checksum]))
    _expect_ack(io)

    io.write(RUN)
    _expect_ack(io)
    io.write(RUN_PARAM)
    _expect_ack(io)


def _expect_ack(io: Transport, reply_size: int = 1) -> None:
    reply = io.read(reply_size)
    if not reply or reply[0] != ACK:
        raise FirmwareError(f"expected ACK, scanner replied {reply.hex(' ') or 'nothing'}")


if __name__ == "__main__":
    import argparse

    from .usb import UsbTransport

    parser = argparse.ArgumentParser(description="Upload esfw7C.bin to a V500.")
    parser.add_argument("firmware", type=Path, help="path to your esfw7C.bin")
    args = parser.parse_args()

    fw = load(args.firmware)
    print(f"uploading {fw.ident} ({len(fw.body)} bytes, checksum {fw.checksum:02x})")
    with UsbTransport.open() as io:
        upload(fw, io)
    print("done; the scanner should now re-enumerate")
