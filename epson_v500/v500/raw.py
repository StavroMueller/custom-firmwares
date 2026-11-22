"""Turn the V500's raw image data into an RGB image.

Measured from scans made with Epson's driver (PROTOCOL.md, "Image data").
At 200 dpi our output matches Epson's for 99.8-99.9% of pixels, colour or
grey. At 400 and 800 dpi Epson also smooths the image slightly; we don't, so
there our output differs by a few levels.

The pipeline:
1. The data comes in blocks, each followed by an 8-byte trailer that holds
   the block's length; drop the trailers.
2. The rest is lines of `raw_width` RGB pixels, 8 bits per sample,
   interleaved R G B.
   Grey scans arrive as RGB too.
3. The sensor's red, green and blue rows sit apart, so the same spot on the
   glass reaches each colour on a different line: green 5 lines after blue
   and red 10 lines after, at 200 dpi, scaling with the resolution. The
   scanner sends the extra lines.
4. Crop to the requested width.
5. Colour: Epson's colour matrix. Grey: a weighted sum of the raw channels.
   Both truncate to 0..255, computed exactly in integers.
"""

from collections.abc import Iterable

import numpy as np

TRAILER = 8  # 02 <u24 LE block length> 00 00 80 00

# From Epson's libsane-epkowa (offset 0x3ee70), out = M @ (r, g, b).
# Rows sum to 1, so greys stay grey.
COLOR_MATRIX = np.array([
    [1.247, -0.2041, -0.0429],
    [-0.192, 1.2918, -0.0998],
    [-0.01, -0.2503, 1.2603],
])

# Grey from the raw channels, no colour matrix. Fitted to Epson's grey output.
GREY_WEIGHTS = np.array([0.195, 0.61, 0.195])

# The same in exact integer arithmetic, so every implementation (web/v500 too)
# truncates identically: values that land exactly on an integer stay there.
MATRIX_SCALE = 10000
GREY_SCALE = 1000


def line_shift(dpi: int) -> tuple[int, int, int]:
    """Lines by which red, green and blue lag. Measured at 200, 400 and 800 dpi."""
    k = 5 * dpi // 200
    return (2 * k, k, 0)


def blocks(reads: Iterable[bytes]) -> list[bytes]:
    """Split the bulk reads after one `1e 47` into data blocks.

    Each block is followed by a trailer giving its length. A block can span
    several USB reads, so the reads are joined and walked from the end.
    """
    data = b"".join(reads)
    out = []
    end = len(data)
    while end > 0:
        trailer = data[end - TRAILER:end]
        if len(trailer) < TRAILER or trailer[0] != 0x02:
            raise ValueError(f"no block trailer before byte {end}: {trailer.hex(' ')}")
        length = int.from_bytes(trailer[1:4], "little")
        start = end - TRAILER - length
        if start < 0:
            raise ValueError(f"trailer claims {length} bytes, only {end - TRAILER} left")
        out.append(data[start:end - TRAILER])
        end = start
    return out[::-1]


def payload(reads: Iterable[bytes]) -> bytes:
    """The data of one `1e 47` transfer, without block trailers."""
    return b"".join(blocks(reads))


def decode(data: bytes, width: int, height: int, dpi: int = 200, grey: bool = False,
           shift: tuple[int, int, int] | None = None,
           matrix: np.ndarray | None = COLOR_MATRIX) -> np.ndarray:
    """Raw payload -> (height, width, 3) RGB, or (height, width) grey, uint8.

    `matrix=None` skips colour correction, for tests and for raw output.
    """
    shift = shift or line_shift(dpi)
    lines = height + max(shift)
    if len(data) % (lines * 3):
        raise ValueError(f"{len(data)} bytes don't split into {lines} RGB lines")
    raw_width = len(data) // (lines * 3)
    if raw_width < width:
        raise ValueError(f"raw lines are {raw_width} px, narrower than {width}")
    raw = np.frombuffer(data, np.uint8).reshape(lines, raw_width, 3)
    rgb = np.stack([raw[s:s + height, :width, c] for c, s in enumerate(shift)], axis=-1)
    if grey:
        w = np.rint(GREY_WEIGHTS * GREY_SCALE).astype(np.int64)
        return np.clip((rgb.astype(np.int64) @ w) // GREY_SCALE, 0, 255).astype(np.uint8)
    if matrix is None:
        return rgb
    m = np.rint(np.asarray(matrix) * MATRIX_SCALE).astype(np.int64)
    corrected = (rgb.astype(np.int64) @ m.T) // MATRIX_SCALE   # floor division: truncates down
    return np.clip(corrected, 0, 255).astype(np.uint8)


def scan_from_capture(path: str) -> tuple[np.ndarray, dict]:
    """Decode the image in a tools/capture usblog of Epson's driver."""
    import struct
    import sys
    from pathlib import Path
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
    from usbpcap import usblog_transfers

    trs = list(usblog_transfers(path))
    params = None
    blocks = []
    for i, t in enumerate(trs):
        if t.out and t.data == b"\x1e\x57":
            params = next(x.data for x in trs[i + 1:] if x.out and len(x.data) == 42)
        if t.out and t.data == b"\x1e\x47":
            chunks = []
            for x in trs[i + 1:]:
                if x.out:
                    break
                chunks.append(x.data)
            blocks.append(chunks)
    if params is None or not blocks:
        raise ValueError("no scan parameters or no data in this capture")
    xres, yres, _, _, width, height, mode = struct.unpack_from("<7I", params)
    grey = mode == 0x800  # 0x813 for colour; only these two seen so far
    image = decode(payload(blocks[-1]), width, height, dpi=yres, grey=grey)
    return image, {"xres": xres, "yres": yres, "width": width, "height": height, "grey": grey}


if __name__ == "__main__":
    import argparse

    from PIL import Image

    parser = argparse.ArgumentParser(description="Decode the image in a capture of Epson's driver.")
    parser.add_argument("usblog")
    parser.add_argument("out", help="PNG to write")
    parser.add_argument("--compare", help="Epson's own PNG of the same scan")
    args = parser.parse_args()

    image, info = scan_from_capture(args.usblog)
    Image.fromarray(image).save(args.out)
    print(f"{info['width']} x {info['height']} at {info['xres']} x {info['yres']} dpi -> {args.out}")
    if args.compare:
        ref = np.asarray(Image.open(args.compare)).astype(np.int16)
        diff = np.abs(image.astype(np.int16) - ref)
        diff = diff.max(-1) if diff.ndim == 3 else diff
        print(f"identical pixels {(diff == 0).mean():.3%}, off by more than 1: {(diff > 1).mean():.3%}")
