from pathlib import Path

import numpy as np
import pytest

from v500 import raw


def chunked(data: bytes, size: int) -> list[bytes]:
    parts = [data[i:i + size] for i in range(0, len(data), size)]
    trailers = [b"\x02\x00\xb4\x00\x00\x00\x80\x00"] * (len(parts) - 1) + [b"\x02\x80\x70\x00\x00\x00\x80\x00"]
    return [p + t for p, t in zip(parts, trailers)]


def test_payload_drops_trailers_and_marks_last_chunk():
    chunks = chunked(bytes(range(200)) * 10, 700)
    assert raw.payload(chunks) == bytes(range(200)) * 10
    assert [raw.is_last(c) for c in chunks] == [False, False, True]


def test_decode_undoes_the_line_shift_and_crops():
    height, width, raw_width, shift = 6, 4, 5, (2, 1, 0)
    lines = height + 2
    data = np.zeros((lines, raw_width, 3), np.uint8)
    # A spot on line y of the glass reaches blue on raw line y, green y+1, red y+2.
    for y in range(height):
        data[y + 2, :, 0] = 10 + y
        data[y + 1, :, 1] = 20 + y
        data[y, :, 2] = 30 + y
    image = raw.decode(data.tobytes(), width, height, shift=shift, matrix=None)
    assert image.shape == (height, width, 3)
    assert (image[:, 0] == [[10 + y, 20 + y, 30 + y] for y in range(height)]).all()


def test_colour_matrix_keeps_greys_and_truncates():
    grey = np.full((11, 2, 3), 128, np.uint8)  # 10 extra lines for the 200 dpi shift
    image = raw.decode(grey.tobytes(), 2, 1)
    assert (np.abs(image.astype(int) - 128) <= 1).all()


def test_line_shift_scales_with_resolution():
    assert raw.line_shift(200) == (10, 5, 0)
    assert raw.line_shift(400) == (20, 10, 0)
    assert raw.line_shift(800) == (40, 20, 0)


def test_grey_is_a_weighted_sum_of_the_raw_channels():
    lines = np.zeros((11, 1, 3), np.uint8)
    lines[10, 0, 0], lines[5, 0, 1], lines[0, 0, 2] = 100, 200, 50  # one spot, line-shifted
    image = raw.decode(lines.tobytes(), 1, 1, grey=True)
    assert image.shape == (1, 1)
    assert image[0, 0] == int(0.195 * 100 + 0.61 * 200 + 0.195 * 50)


def test_decode_rejects_data_of_the_wrong_size():
    with pytest.raises(ValueError):
        raw.decode(bytes(100), 4, 3)


HERE = Path(__file__).parent.parent
# 200 dpi captures match Epson's output almost exactly. At 400 and 800 dpi
# Epson smooths the image and we don't, so those aren't compared here.
GOLDEN = sorted(
    p for pattern in ("02-scan-75dpi", "02-color-200-full", "03-color-200-region", "06-gray-200-region")
    for p in HERE.glob(f"captures/*/{pattern}.usblog")
    if p.with_suffix(".png").exists()
)


@pytest.mark.skipif(not GOLDEN, reason="needs a capture of Epson's driver (gitignored)")
@pytest.mark.parametrize("usblog", GOLDEN, ids=lambda p: f"{p.parent.name}/{p.stem}")
def test_matches_epsons_output(usblog):
    from PIL import Image
    image, info = raw.scan_from_capture(str(usblog))
    ref = np.asarray(Image.open(usblog.with_suffix(".png"))).astype(np.int16)
    assert image.shape == ref.shape
    diff = np.abs(image.astype(np.int16) - ref)
    diff = diff.max(-1) if diff.ndim == 3 else diff
    assert (diff == 0).mean() > 0.995
    assert (diff > 1).mean() < 0.002
