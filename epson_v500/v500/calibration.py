"""Calibration values for a scan, computed from the scanner's reference reads.

Epson's driver reads three 16-bit RGB references before every scan
(PROTOCOL.md, "Calibration"):

1. a dark probe: 16 pixels x 4 lines at the left edge of the sensor,
2. white: the full sensor window x 32 lines, lamp on, with the probe's
   offsets already subtracted by the scanner,
3. dark: the full window x 16 lines, lamp off, no offsets.

From them it sends `1e 42` (per-colour base white level and black offsets)
and a shading table (`1e 84` type 06): for each sensor pixel and colour, how
far that pixel's white sits above the base, times a power-of-two scale.

These functions reproduce Epson's values to within sensor noise, checked on
seven scans (tests/test_calibration.py). The constants are fitted, not
understood: Epson's exact statistics are not known.
"""

import struct
from dataclasses import dataclass

import numpy as np

OFFSET_BELOW_DARK = 11   # final offsets sit 8..16 below the dark read's mean
BASE_ABOVE_MIN = 165     # base sits 65..300 above the dimmest white pixel
TABLE_LIFT = 190         # the table crosses zero about this far below the base


def u16_rgb(data: bytes, width: int) -> np.ndarray:
    """A 16-bit reference read -> (lines, width, 3) array."""
    return np.frombuffer(data, "<u2").reshape(-1, width, 3)


def probe_offsets(probe: np.ndarray) -> np.ndarray:
    """Black offsets from the dark probe: its mean per colour."""
    return np.rint(probe.reshape(-1, 3).mean(0)).astype(int)


@dataclass(frozen=True)
class Calibration:
    base: np.ndarray      # 3 ints
    offsets: np.ndarray   # 3 ints
    table: np.ndarray     # (width, 3) uint16
    scale: int

    def param_1e42(self) -> bytes:
        o = self.offsets
        return struct.pack("<9H", *self.base, o[0], o[0], o[1], o[1], o[2], o[2])

    def table_bytes(self) -> bytes:
        return self.table.astype("<u2").tobytes()


def offsets_param(offsets: np.ndarray) -> bytes:
    """The `1e 42` block that sets offsets only (bases zero)."""
    o = offsets
    return struct.pack("<9H", 0, 0, 0, o[0], o[0], o[1], o[1], o[2], o[2])


def compute(white: np.ndarray, dark: np.ndarray, probe_off: np.ndarray, used: np.ndarray) -> Calibration:
    """white (32, W, 3), dark (16, W, 3) as read; `used` marks the sensor
    pixels the scan needs (W bools). Pixels outside it get a zero entry."""
    offsets = np.rint(dark.reshape(-1, 3).mean(0)).astype(int) - OFFSET_BELOW_DARK
    w = white.astype(np.float64).mean(0)              # in read units: probe offsets removed
    wu = w[used]
    base_w = wu.min(0) + BASE_ABOVE_MIN               # base, in read units
    span = (wu.max(0) - base_w + TABLE_LIFT).max()
    scale = int(2 ** np.floor(np.log2(65535 / span)))
    table = np.clip(np.rint(scale * (w - base_w + TABLE_LIFT)), 0, 65535).astype(np.uint16)
    table[~used] = 0
    base = np.rint(base_w + probe_off - offsets).astype(int)
    return Calibration(base=base, offsets=offsets, table=table, scale=scale)
