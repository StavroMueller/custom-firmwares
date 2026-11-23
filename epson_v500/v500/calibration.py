"""Calibration values for a scan, computed from the scanner's reference reads.

Epson's driver reads three 16-bit RGB references before every scan
(PROTOCOL.md, "Calibration"):

1. a dark probe: 16 pixels x 4 lines at the left edge of the sensor,
2. white: the full sensor window x 32 lines, lamp on, with the probe's
   offsets already subtracted by the scanner,
3. dark: the full window x 16 lines, lamp off, no offsets.

From the white and dark reads it builds a packed shading table (`1e 84`
type 06), the per-colour minimums (`1e 42`), and two bytes of the image
pass's `1e 41` that say how the table is packed. The method comes from
Epson's plugin (found by static analysis); it reproduces Epson's packing
bytes and the white half of every table entry exactly on seven captures.
The dark half is within about one level (tests/test_calibration.py).
"""

import struct
from dataclasses import dataclass

import numpy as np

DARK_SMOOTHING = 51      # moving-average width that best matches Epson's dark line (fitted)


def u16_rgb(data: bytes, width: int) -> np.ndarray:
    """A 16-bit reference read -> (lines, width, 3) array."""
    return np.frombuffer(data, "<u2").reshape(-1, width, 3)


def probe_offsets(probe: np.ndarray) -> np.ndarray:
    """Black offsets from the dark probe: its mean per colour."""
    return np.rint(probe.reshape(-1, 3).mean(0)).astype(int)


@dataclass(frozen=True)
class Calibration:
    white_min: np.ndarray   # 3 ints, per colour
    dark_min: np.ndarray    # 3 ints, per colour
    table: np.ndarray       # (window, 3) uint16
    k: int                  # bits 8-k.. hold white, the low 8-k bits dark
    h: int                  # white is shifted right by h
    d: int                  # dark is shifted right by d

    @property
    def scale(self) -> int:
        """How much the white part is magnified: 2^(8-k-h)."""
        return 2.0 ** (8 - self.k - self.h)

    def param_1e42(self) -> bytes:
        o = self.dark_min
        return struct.pack("<9H", *self.white_min, o[0], o[0], o[1], o[1], o[2], o[2])

    def table_bytes(self) -> bytes:
        return self.table.astype("<u2").tobytes()

    def window_bytes(self) -> tuple[int, int]:
        """Bytes 11 and 15 of the image pass's `1e 41`."""
        return 0x80 | self.k, (self.h << 4) | self.d


def offsets_param(offsets: np.ndarray) -> bytes:
    """The `1e 42` block that sets offsets only (white zero)."""
    o = offsets
    return struct.pack("<9H", 0, 0, 0, o[0], o[0], o[1], o[1], o[2], o[2])


def smooth(line: np.ndarray, width: int = DARK_SMOOTHING) -> np.ndarray:
    """Centred moving average along the line, narrower at the ends."""
    n, r = len(line), width // 2
    sums = np.vstack([np.zeros((1, line.shape[1])), np.cumsum(line, 0)])
    lo = np.clip(np.arange(n) - r, 0, n)
    hi = np.clip(np.arange(n) + r + 1, 0, n)
    return (sums[hi] - sums[lo]) / (hi - lo)[:, None]


def compute(white: np.ndarray, dark: np.ndarray, used: np.ndarray) -> Calibration:
    """white (32, W, 3) and dark (16, W, 3) as read; `used` marks the sensor
    pixels the scan needs (W bools). Pixels outside it get a zero entry."""
    # white: 4 groups of 8 lines averaged, then the brightest of the 4
    w = np.floor(white.astype(np.float64).reshape(4, 8, *white.shape[1:]).mean(1).max(0))[used]
    d = np.floor(smooth(dark.astype(np.float64).mean(0)))[used]   # smoothed across the whole window
    dark_min, white_min = d.min(0), w.min(0)

    dark_range = (d - dark_min).max()
    k, dshift = 0, 0
    for bits, limit in ((3, 0x1F), (2, 0x3F), (1, 0x7F), (0, 0xFF)):
        if dark_range <= limit:
            k = bits
            break
    else:
        while dark_range >= 0x100 << dshift:
            dshift += 1
    white_range = (w - white_min).max()
    h = 0
    while white_range >= (1 << (k + 8)) << h and h < 8:
        h += 1

    packed = (((w - white_min).astype(int) >> h) << (8 - k)) | ((d - dark_min).astype(int) >> dshift)
    table = np.zeros((len(used), 3), np.uint16)
    table[used] = np.clip(packed, 0, 65535)
    return Calibration(white_min.astype(int), dark_min.astype(int), table, k, h, dshift)
