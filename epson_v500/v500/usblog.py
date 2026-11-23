"""Read the transfer logs that tools/capture/usblog.c writes.

File: "V5USBLOG", then records of
  double t; u8 endpoint; u8 kind; i32 rc; u32 requested; u32 actual;
  u8 data[IN ? actual : requested]
"""

import struct
from dataclasses import dataclass
from pathlib import Path

MAGIC = b"V5USBLOG"
RECORD = struct.Struct("<dBBiII")


@dataclass(frozen=True)
class Record:
    time: float
    endpoint: int
    rc: int
    requested: int
    data: bytes

    @property
    def out(self) -> bool:
        return not self.endpoint & 0x80


def read(path: str | Path) -> list[Record]:
    raw = Path(path).read_bytes()
    if not raw.startswith(MAGIC):
        raise ValueError(f"{path}: not a usblog file")
    records, pos = [], len(MAGIC)
    while pos + RECORD.size <= len(raw):
        t, ep, _kind, rc, requested, actual = RECORD.unpack_from(raw, pos)
        pos += RECORD.size
        size = actual if ep & 0x80 else requested
        records.append(Record(t, ep, rc, requested, raw[pos:pos + size]))
        pos += size
    return records
