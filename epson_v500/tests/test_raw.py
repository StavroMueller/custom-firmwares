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
    grey = np.full((11, 2, 3), 128, np.uint8)  # 10 extra lines for the default shift
    image = raw.decode(grey.tobytes(), 2, 1)
    assert (np.abs(image.astype(int) - 128) <= 1).all()


def test_decode_rejects_data_of_the_wrong_size():
    with pytest.raises(ValueError):
        raw.decode(bytes(100), 4, 3)


CAPTURES = sorted(
    p for pattern in ("02-scan-75dpi.usblog", "02-color-200-full.usblog")
    for p in Path(__file__).parent.parent.glob(f"captures/*/{pattern}")
)


@pytest.mark.skipif(not CAPTURES, reason="needs a capture of Epson's driver (gitignored)")
def test_matches_epsons_output():
    from PIL import Image
    image, info = raw.scan_from_capture(str(CAPTURES[-1]))
    ref = np.asarray(Image.open(CAPTURES[-1].with_suffix(".png")).convert("RGB")).astype(np.int16)
    assert image.shape == ref.shape
    diff = np.abs(image.astype(np.int16) - ref).max(-1)
    assert (diff == 0).mean() > 0.998
    assert (diff > 1).mean() < 0.001
