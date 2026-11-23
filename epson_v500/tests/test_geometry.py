import glob
import struct
from pathlib import Path

import numpy as np
import pytest
from fake_geometry_scanner import GeometryScanner
from test_replay import write_template

from v500 import geometry, raw, replay


def scan(t: replay.Template, area: geometry.Region, ratio=None):
    g = geometry.retarget(t, area)
    dev = GeometryScanner(ratio)
    image = replay.Replayer(g, dev, sleep=lambda s: None).run()
    return g, dev, image


def move(dev, n):
    steps, tail, up, down, flags = struct.unpack("<I4H", dev.sent(b"\x1e\x01")[n])
    return steps, tail, up + 1


def test_region_on_a_synthetic_template(tmp_path):
    write_template(tmp_path / "t.usblog", width=4, height=2, window=8)
    t = replay.Template.load(tmp_path / "t.usblog")
    g, dev, image = scan(t, geometry.Region(x=2, y=100, width=3, height=7), ratio=1)

    assert image.shape == (7, 3, 3)
    params = struct.unpack_from("<6I", dev.sent(b"\x1e\x57")[0])
    assert params[2:] == (2, 100, 3, 7)
    start, end, lines = struct.unpack_from("<3H", dev.sent(b"\x1e\x41")[-1])
    assert (start, end - start, lines) == (2, 32, 17)         # x offset, width padded to 32, height + line shift
    pre_steps, _, pre_ramp = move(dev, 0)
    assert pre_steps + 2 * pre_ramp == 194 + 2 * 256 + 100 * 12  # same start, 100 lines further
    assert move(dev, 1)[0] == 17 * 12 + 120
    expected = raw.decode(dev.image, 3, 7)
    assert np.array_equal(image, expected)


def test_area_outside_the_bed_is_refused(tmp_path):
    write_template(tmp_path / "t.usblog")
    t = replay.Template.load(tmp_path / "t.usblog")
    with pytest.raises(ValueError, match="outside the bed"):
        geometry.retarget(t, geometry.Region(0, 2300, 100, 100))


def test_from_mm_matches_epsons_rounding():
    assert geometry.Region.from_mm(200, 20, 30, 60, 40) == geometry.Region(157, 236, 472, 314)
    assert geometry.Region.full_bed(200) == geometry.Region(0, 0, 1696, 2339)
    assert geometry.Region.from_mm(400, 20, 30, 60, 40) == geometry.Region(315, 472, 944, 629)
    assert geometry.Region.from_mm(800, 20, 30, 60, 40) == geometry.Region(630, 945, 1888, 1259)


TEMPLATES = sorted(glob.glob(str(Path(__file__).parent.parent / "captures/*/0[2-6]*.usblog")))
needs_captures = pytest.mark.skipif(not TEMPLATES, reason="needs captures of Epson's driver (gitignored)")
SKIP = {b"\x1e\x04", b"\x1b\x03"}


def area_of(t: replay.Template) -> geometry.Region:
    p = next(g.params[0] for g in t.groups if g.command == b"\x1e\x57")
    return geometry.Region(*struct.unpack_from("<4I", p, 8))


def commands(t: replay.Template):
    """Each command's parameters (shading table data left out) and read sizes."""
    return [(g.command, g.params[:1] if g.command == b"\x1e\x84" and g.params[0][0] == 6 else g.params,
             [s.requested for s in g.steps if not s.out])
            for g in t.groups if g.command not in SKIP]


@needs_captures
@pytest.mark.parametrize("path", TEMPLATES)
def test_retargeting_to_the_same_area_changes_nothing(path):
    t = replay.Template.load(path)
    g = geometry.retarget(t, area_of(t))
    assert commands(g) == commands(t)
    assert np.array_equal(g.used, t.used)


def by_name(name: str) -> replay.Template:
    path = next((p for p in TEMPLATES if Path(p).stem.startswith(name)), None)
    if path is None:
        pytest.skip(f"needs capture {name}")
    return replay.Template.load(path)


@needs_captures
def test_full_bed_from_a_region_template_matches_epson():
    region, full = by_name("03-"), by_name("02-")
    g = geometry.retarget(region, area_of(full))
    gen, epson = commands(g), commands(full)
    for (c, gp, gr), (_, ep, er) in zip(gen, epson, strict=True):
        assert gr == er, f"{c.hex(' ')} reads"                  # every read the same size
        if c == b"\x1e\x01":
            assert gp == ep                                      # moves identical
        if c == b"\x1e\x41":
            gs, ge, gl = struct.unpack_from("<3H", gp[0])
            es, ee, el = struct.unpack_from("<3H", ep[0])
            assert (ge - gs, gl) == (ee - es, el) and abs(gs - es) <= 3
    assert g.used.sum() == full.used.sum()


@needs_captures
@pytest.mark.parametrize("name", ["02-", "04-", "05-"])
def test_any_area_runs_against_a_simulated_scanner(name):
    t = by_name(name)
    area = geometry.Region.from_mm(t.yres, 50, 100, 120, 70)
    g, dev, image = scan(t, area)
    assert image.shape == (area.height, area.width, 3)
    pre_steps, _, ramp = move(dev, 1)                            # move 0 is the 51-step one
    tp = next(gr.params[0] for gr in t.groups if gr.command == b"\x1e\x01" and gr.params[0][:4] != b"\x33\0\0\0")
    t_steps, t_ramp = struct.unpack_from("<I", tp)[0], struct.unpack_from("<H", tp, 6)[0] + 1
    spl = 2400 // t.yres
    assert pre_steps + 2 * ramp == t_steps + 2 * t_ramp + (area.y - area_of(t).y) * spl


@needs_captures
def test_right_edge_is_cropped_on_the_host():
    t = by_name("02-")
    area = geometry.Region(x=1600, y=0, width=96, height=50)
    g, dev, image = scan(t, area)
    assert g.crop_x > 0 and image.shape == (50, 96, 3)
    start, end = struct.unpack_from("<2H", dev.sent(b"\x1e\x41")[-1])
    assert end <= 143 + 5120
