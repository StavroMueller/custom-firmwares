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


def test_table_packs_white_above_dark():
    rng = np.random.default_rng(1)
    w = np.linspace(30000, 50000, 100)[None, :, None] + rng.normal(0, 5, (32, 100, 3))
    white = np.clip(w, 0, 65535).astype(np.uint16)
    dark = np.full((16, 100, 3), 1300, np.uint16)
    used = np.ones(100, bool)
    used[80:] = False
    cal = calibration.compute(white, dark, used)
    assert cal.dark_min.tolist() == [1300] * 3 and (cal.k, cal.d) == (3, 0)   # flat dark: 5 bits spare
    assert (cal.table[80:] == 0).all()
    white_part = (cal.table[:80].astype(int) >> (8 - cal.k)) << cal.h
    spread = np.diff(white.astype(float).mean(0)[[0, 79]], axis=0)
    assert np.allclose(np.diff(white_part[[0, 79]], axis=0), spread, atol=2 ** cal.h + 10)
    assert cal.window_bytes() == (0x83, cal.h << 4)


def test_white_shift_is_the_smallest_that_fits():
    used = np.ones(10, bool)
    dark = np.zeros((16, 10, 3), np.uint16)
    for spread, h in ((35000, 5), (15000, 3), (7000, 2)):   # white range < 2^11 << h
        white = np.zeros((32, 10, 3), np.uint16)
        white[:] = np.linspace(20000, 20000 + spread, 10)[None, :, None]
        cal = calibration.compute(white, dark, used)
        assert (cal.k, cal.h) == (3, h) and cal.table.max() <= 65535


def test_param_blocks_repeat_each_offset_twice():
    cal = calibration.Calibration(np.array([1, 2, 3]), np.array([10, 20, 30]), np.zeros((1, 3), np.uint16), 2, 6, 0)
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
    assert (ours[:3] == theirs[:3]).all()                    # white minimums: exact
    assert np.abs(ours[3:] - theirs[3:]).max() <= 2          # dark minimums
    window = [g.params[0] for g in t.groups if g.command == b"\x1e\x41"][-1]
    assert r.cal.window_bytes() == (window[11], window[15])  # how the table is packed: exact
    table = [g.params[1] for g in t.groups if g.command == b"\x1e\x84" and g.params[0][0] == 6][0]
    theirs_t = np.frombuffer(table, "<u2").reshape(-1, 3).astype(int)
    ours_t = r.cal.table.astype(int)
    shift = 8 - r.cal.k
    assert ((ours_t >> shift) == (theirs_t >> shift)).all()  # white part: exact
    assert np.abs(ours_t - theirs_t).mean() < 1.5            # dark part: within about a level
    probe = np.array(struct.unpack("<9H", epson[1])[3::2])
    assert np.abs(r.probe_off - probe).max() < 40
