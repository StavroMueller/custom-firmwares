"""The interface every scanner backend implements.

The booth only talks to `Scanner`. Backends (fake, Epson plugin, our own open
code) can be swapped without the booth noticing.
"""

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Protocol

import numpy as np

# The V500's flatbed is 216 x 297 mm (A4).
BED_WIDTH_IN = 216 / 25.4
BED_HEIGHT_IN = 297 / 25.4


@dataclass(frozen=True)
class ScanSettings:
    dpi: int = 150
    area_mm: tuple[float, float, float, float] | None = None   # left, top, width, height; None = full bed


@dataclass
class Scan:
    """One scan in progress.

    `strips` yields uint8 RGB arrays of shape (rows, width, 3) in the order the
    scan head produces them. Together they make up `height` rows.
    """

    width: int
    height: int
    strips: Iterator[np.ndarray]


class Scanner(Protocol):
    def scan(self, settings: ScanSettings) -> Scan: ...

    def close(self) -> None: ...


def bed_size_px(dpi: int) -> tuple[int, int]:
    """Full-bed (width, height) in pixels at `dpi`."""
    return round(BED_WIDTH_IN * dpi), round(BED_HEIGHT_IN * dpi)
