from pathlib import Path

import numpy as np
import pytest

from v500 import raw


def trailer(length: int) -> bytes:
    return b"\x02" + length.to_bytes(3, "little") + b"\x00\x00\x80\x00"


def test_blocks_are_split_by_their_trailers():
    # The real trailers seen: 46,080 and 28,800 bytes.
    assert trailer(46080) == bytes.fromhex("02 00 b4 00 00 00 80 00")
    assert trailer(28800) == bytes.fromhex("02 80 70 00 00 00 80 00")
    a, b = bytes(range(256)) * 3, b"\xaa" * 100
    reads = [a + trailer(len(a)), b + trailer(len(b))]
    assert raw.blocks(reads) == [a, b]
    assert raw.payload(reads) == a + b


def test_a_block_can_span_several_reads():
    block = bytes(range(256)) * 40
    stream = block + trailer(len(block))
    reads = [stream[i:i + 1000] for i in range(0, len(stream), 1000)]
    assert raw.blocks(reads) == [block]


def test_bad_trailer_is_an_error():
    with pytest.raises(ValueError):
        raw.blocks([b"\x00" * 50])


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
