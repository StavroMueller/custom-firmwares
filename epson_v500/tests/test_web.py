"""The JavaScript driver (web/v500) must do exactly what the Python one does.

For each capture, both replay it (and retarget it to other areas) against the
same simulated scanners; every byte sent, the calibration and the decoded image
must match. Needs Node and the captures; skipped otherwise.
"""

import glob
import hashlib
import json
import shutil
import struct
import subprocess
from pathlib import Path

import numpy as np
import pytest
from fake_geometry_scanner import GeometryScanner
from fake_template_scanner import TemplateScanner

from v500 import geometry, replay

ROOT = Path(__file__).parent.parent
TEMPLATES = sorted(glob.glob(str(ROOT / "captures/*/0[2-6]*.usblog")))
NODE = shutil.which("node")

needs_node = pytest.mark.skipif(not NODE, reason="needs Node")
needs_captures = pytest.mark.skipif(not (TEMPLATES and NODE), reason="needs Node and captures of Epson's driver")


def node(*args) -> dict:
    out = subprocess.run([NODE, str(ROOT / "web/tools/parity.mjs"), *map(str, args)],
                         capture_output=True, text=True, check=True, cwd=ROOT)
    return json.loads(out.stdout)


def python(path: str, area: geometry.Region | None) -> dict:
    t = replay.Template.load(path)
    if area:
        t = geometry.retarget(t, area)
        dev = GeometryScanner()
    else:
        dev = TemplateScanner(t)
    r = replay.Replayer(t, dev, sleep=lambda s: None)
    image = r.run()
    h = hashlib.sha256()
    for w in dev.writes:
        h.update(struct.pack("<I", len(w)) + w)
    shape = list(image.shape) + ([1] if image.ndim == 2 else [])
    c = r.cal
    return {
        "writes": h.hexdigest(),
        "count": len(dev.writes),
        "image": hashlib.sha256(np.ascontiguousarray(image).tobytes()).hexdigest(),
        "shape": shape,
        "calibration": {"white": c.white_min.tolist(), "dark": c.dark_min.tolist(), "k": c.k, "h": c.h, "d": c.d},
    }


@needs_captures
@pytest.mark.parametrize("path", TEMPLATES)
def test_replay_matches_python(path):
    assert node(path) == python(path, None)


@needs_captures
@pytest.mark.parametrize("path", TEMPLATES)
def test_retarget_matches_python(path):
    t = replay.Template.load(path)
    area = geometry.Region.from_mm(t.yres, 50, 100, 30, 12)
    assert node(path, area.x, area.y, area.width, area.height) == python(path, area)


@needs_node
def test_js_unit_tests():
    out = subprocess.run([NODE, "--test"], capture_output=True, text=True, cwd=ROOT / "web")
    assert out.returncode == 0, out.stdout + out.stderr
