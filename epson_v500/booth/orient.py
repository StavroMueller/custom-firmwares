"""Turn scans upright when the scanner is mounted on its edge.

The head produces rows in its own direction of travel. The booth rotates each
strip as it arrives and works out where it lands in the upright image. That
way the live preview paints in the direction the head really moves.
"""

import numpy as np


def upright_size(width: int, height: int, rotate: int) -> tuple[int, int]:
    return (height, width) if rotate in (90, 270) else (width, height)


def place_strip(strip: np.ndarray, top: int, height: int, rotate: int):
    """Rotate a strip of scan rows [top, top + len(strip)) clockwise by `rotate`.

    `height` is the full scan's height in rows. Returns (pixels, x, y): the
    rotated strip and its top-left corner in the upright image.
    """
    rows = strip.shape[0]
    bottom = top + rows
    if rotate == 0:
        return strip, 0, top
    if rotate == 90:
        return np.rot90(strip, k=-1), height - bottom, 0
    if rotate == 180:
        return np.rot90(strip, k=2), 0, height - bottom
    if rotate == 270:
        return np.rot90(strip, k=1), top, 0
    raise ValueError(f"rotate must be 0, 90, 180 or 270, not {rotate}")


def upright(image: np.ndarray, rotate: int) -> np.ndarray:
    return np.rot90(image, k=-(rotate // 90))
