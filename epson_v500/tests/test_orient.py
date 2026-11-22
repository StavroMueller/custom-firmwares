import numpy as np
import pytest

from booth.orient import place_strip, upright, upright_size


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_placed_strips_rebuild_the_upright_image(rotate):
    height, width, strip_rows = 100, 60, 32  # last strip is short on purpose
    scan = np.random.default_rng(1).integers(0, 255, (height, width, 3), dtype=np.uint8)

    out_w, out_h = upright_size(width, height, rotate)
    canvas = np.zeros((out_h, out_w, 3), np.uint8)
    for top in range(0, height, strip_rows):
        pixels, x, y = place_strip(scan[top : top + strip_rows], top, height, rotate)
        canvas[y : y + pixels.shape[0], x : x + pixels.shape[1]] = pixels

    np.testing.assert_array_equal(canvas, upright(scan, rotate))


def test_upright_turns_clockwise():
    scan = np.array([[[1], [2]]])  # one row: 1 then 2, left to right
    assert upright(scan, 90).squeeze().tolist() == [1, 2]   # now top to bottom
