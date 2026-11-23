"""A scanner that answers from the geometry it's told, not from a recording.

It models what PROTOCOL.md describes: the reads after `1e 47` are sized by
the last `1e 41` window and line count. The first three reads are 16-bit
references; the fourth is the 8-bit image, in blocks of `1e 41` byte 18 lines.
"""

import struct

import numpy as np

from v500 import replay

ACK = b"\x06"
RATIO = {200: 8 / 3, 400: 4 / 3, 800: 1}   # sensor units per pixel; the template decides


def trailer(n: int) -> bytes:
    return b"\x02" + n.to_bytes(3, "little") + b"\x00\x00\x80\x00"


def reference(level: int, lines: int, window: int) -> np.ndarray:
    """A deterministic 16-bit reference read, so other implementations can match it."""
    l, x, c = np.meshgrid(np.arange(lines), np.arange(window), np.arange(3), indexing="ij")
    return (level + (l * 7 + x * 13 + c * 5) % 50 + x * 3 % 40).astype("<u2")


class GeometryScanner:
    def __init__(self, ratio: float | None = None):
        self.ratio = ratio
        self.writes: list[bytes] = []
        self.command = b""
        self.params: dict[bytes, list[bytes]] = {}
        self.pending = b""
        self.reads = 0
        self.dpi = 200

    def write(self, data: bytes) -> None:
        data = bytes(data)
        self.writes.append(data)
        if len(data) == 2 and data[0] in (0x1B, 0x1E):
            self.command = data
            if data == b"\x1e\x47":
                self.pending = self.data_for_read()
                self.reads += 1
        else:
            self.params.setdefault(self.command, []).append(data)
            if self.command == b"\x1e\x57":
                self.dpi = struct.unpack_from("<I", data, 4)[0]

    def read(self, size: int) -> bytes:
        if self.command == b"\x1e\x47":
            out, self.pending = self.pending[:size], self.pending[size:]
            return out
        if self.command == replay.POLL_READY:
            return b"\x01"
        if self.command == replay.STATUS:
            return b"\x18\x81"
        if size == 1:
            return ACK
        return bytes(size)

    def data_for_read(self) -> bytes:
        p = self.params[b"\x1e\x41"][-1]
        start, end, lines = struct.unpack_from("<3H", p)
        window = end - start
        if self.reads < 3:
            level = (1200, 40000, 1300)[self.reads]
            d = reference(level, lines, window).tobytes()
            return d + trailer(len(d))
        ratio = self.ratio or RATIO[self.dpi]
        width = round(window / ratio)
        per_block = p[18]
        image = (np.arange(lines * width * 3) % 251).astype(np.uint8).tobytes()
        line = width * 3
        out = b""
        for top in range(0, lines, per_block):
            block = image[top * line:min(lines, top + per_block) * line]
            out += block + trailer(len(block))
        self.image = image
        self.raw_width = width
        return out

    def sent(self, command: bytes) -> list[bytes]:
        return self.params.get(command, [])
