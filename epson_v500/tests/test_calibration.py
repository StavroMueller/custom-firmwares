import glob
from pathlib import Path
import struct

import numpy as np
import pytest

from v500 import calibration, raw, replay


def test_probe_offsets_are_the_mean_per_colour():
    probe = np.zeros((4, 16, 3), np.uint16)
    probe[..., 0], probe[..., 1], probe[..., 2] = 1200, 1500, 1450
    assert calibration.probe_offsets(probe).tolist() == [1200, 1500, 1450]


def test_table_holds_each_pixels_white_above_the_base():
    rng = np.random.default_rng(1)
    w = np.linspace(30000, 50000, 100)[None, :, None] + rng.normal(0, 5, (32, 100, 3))
    white = np.clip(w, 0, 65535).astype(np.uint16)
    dark = np.full((16, 100, 3), 1300, np.uint16)
    used = np.ones(100, bool)
    used[80:] = False
    cal = calibration.compute(white, dark, np.array([1250, 1250, 1250]), used)
    assert cal.offsets.tolist() == [1300 - calibration.OFFSET_BELOW_DARK] * 3
    assert (cal.table[80:] == 0).all()
    # The table rises with the white level, and scaled back it spans the same range.
    mean = white.astype(float).mean(0)
    span = (cal.table[:80].astype(float) / cal.scale)
    assert np.allclose(np.diff(span[[0, 79]], axis=0), np.diff(mean[[0, 79]], axis=0), atol=2)
    assert cal.table.max() <= 65535


def test_scale_is_the_largest_power_of_two_that_fits():
    used = np.ones(10, bool)
    dark = np.zeros((16, 10, 3), np.uint16)
    for spread, scale in ((35000, 1), (15000, 4), (7000, 8)):
        white = np.zeros((32, 10, 3), np.uint16)
        white[:] = np.linspace(20000, 20000 + spread, 10)[None, :, None]
        assert calibration.compute(white, dark, np.zeros(3), used).scale == scale


def test_param_blocks_repeat_each_offset_twice():
    cal = calibration.Calibration(np.array([1, 2, 3]), np.array([10, 20, 30]), np.zeros((1, 3), np.uint16), 1)
    assert struct.unpack("<9H", cal.param_1e42()) == (1, 2, 3, 10, 10, 20, 20, 30, 30)
    assert struct.unpack("<9H", calibration.offsets_param(np.array([10, 20, 30]))) == (0, 0, 0, 10, 10, 20, 20, 30, 30)


TEMPLATES = sorted(glob.glob(str(Path(__file__).parent.parent / "captures/*/0[2-6]*.usblog")))


@pytest.mark.skipif(not TEMPLATES, reason="needs captures of Epson's driver (gitignored)")
@pytest.mark.parametrize("path", TEMPLATES)
def test_close_to_epsons_values(path):
    from fake_template_scanner import TemplateScanner

    t = replay.Template.load(path)
    r = replay.Replayer(t, TemplateScanner(t), sleep=lambda s: None)
    r.run()
    epson = [g.params[0] for g in t.groups if g.command == b"\x1e\x42"]
    ours = np.array(struct.unpack("<9H", r.cal.param_1e42()), int)
    theirs = np.array(struct.unpack("<9H", epson[3]), int)
    assert np.abs(ours[:3] - theirs[:3]).max() < 250        # base, of 25,000-44,000
    assert np.abs(ours[3:] - theirs[3:]).max() < 10         # black offsets
    table = [g.params[1] for g in t.groups if g.command == b"\x1e\x84" and g.params[0][0] == 6][0]
    theirs_t = np.frombuffer(table, "<u2").reshape(-1, 3).astype(int)
    diff = np.abs(r.cal.table.astype(int) - theirs_t)[t.used] / r.cal.scale
    assert diff.mean() < 200                                 # of ~30,000: sensor noise
    assert ((r.cal.table == 0) == (theirs_t == 0)).all()
    probe = np.array(struct.unpack("<9H", epson[1])[3::2])
    assert np.abs(r.probe_off - probe).max() < 40
