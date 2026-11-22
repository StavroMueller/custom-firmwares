"""Retarget a template to any scan area at the template's resolution.

A template (v500/replay.py) is Epson's command sequence for one scan. Each
command that depends on the scan area is rewritten here. The rules were
measured from captures of Epson's driver at 200, 400 and 800 dpi
(PROTOCOL.md, "Scan geometry"):

- `1e 57`: x, y, width and height in pixels.
- `1e 41`, the sensor window: bytes 0-3 are the start and end in sensor
  units. One pixel is `ratio` sensor units: 8/3 at 200 dpi, 4/3 at 400 and 1
  at 800, read off the template. When `ratio` isn't 1, Epson rounds the raw
  line up to a multiple of 384 pixels. The image pass also gives the line
  count (bytes 4-5) and how many lines fit in one 51,200-byte block (byte 18).
- The reference reads and the shading table are window-sized.
- `1e 01`: a move covers its step count plus twice its ramp length. The
  ramp length is bytes 6-7 plus 1, an entry count taken from the start of
  the ramp table uploaded just before the move. The move to the top of the
  area keeps its total distance and picks the longest ramp that fits.
- The scan move is lines x (2400 / dpi) steps, plus a tail kept from the
  template (bytes 4-5).

- `1e 57` byte 28: lines per transfer, which Epson's frontend picks. It
  fits floor(65,536 / bytes per output line), rounded down to even, on all
  captures. Byte 29 is the gamma setting, kept.

Everything else is kept from the template. Image-pass `1e 41` bytes 11 and
15 come from calibration, at scan time (v500/replay.py).
"""

import math
import struct
from dataclasses import dataclass, replace

import numpy as np

from . import raw, usblog
from .replay import Group, Template

STEPS_PER_INCH = 2400
BLOCK_BYTES = 51200      # Epson reads in chunks of this size; image blocks fit in it
RAW_QUANTUM = 384        # raw line widths when the sensor runs faster than the scan
USED_MARGIN = 3          # extra sensor pixels Epson's shading table covers
BED_IN = 8.48           # the scanner's maximum width (1e 53 at power-on: 848 px at 100 dpi)
BED_MM = 297.18         # and the driver's maximum height
SENSOR_SPAN_IN = 9.6     # widest window Epson used: 5,120 units at 200 dpi

MOVE, READ, TABLE, WINDOW, PARAMS = b"\x1e\x01", b"\x1e\x47", b"\x1e\x84", b"\x1e\x41", b"\x1e\x57"


@dataclass(frozen=True)
class Region:
    """A scan area in pixels at the scan resolution."""
    x: int
    y: int
    width: int
    height: int

    @classmethod
    def from_mm(cls, dpi: int, left: float, top: float, width: float, height: float) -> "Region":
        # through SANE's fixed point (1/65536 mm), as Epson's driver gets them
        px = [math.floor(math.floor(v * 65536) / 65536 / 25.4 * dpi) for v in (left, top, width, height)]
        return cls(*px)

    @classmethod
    def full_bed(cls, dpi: int) -> "Region":
        """Epson's full bed: 1696 x 2339 px at 200 dpi."""
        return cls(0, 0, math.floor(BED_IN * dpi + 1e-6), cls.from_mm(dpi, 0, 0, 0, BED_MM).height)


def retarget(t: Template, area: Region) -> Template:
    """The template's command sequence, rewritten to scan `area`."""
    dpi = t.yres
    if t.xres != dpi:
        raise ValueError("templates with different x and y resolutions aren't supported")
    full = Region.full_bed(dpi)
    if area.width <= 0 or area.height <= 0 or area.x < 0 or area.y < 0 \
            or area.x + area.width > full.width or area.y + area.height > full.height:
        raise ValueError(f"{area} is outside the bed ({full.width} x {full.height} px at {dpi} dpi)")

    groups = t.groups
    image_window = _last(groups, WINDOW)
    start_t, end_t = struct.unpack_from("<2H", groups[image_window].params[0])
    window_t = end_t - start_t
    tx = struct.unpack_from("<I", groups[_first(groups, PARAMS)].params[0], 8)[0]
    lines_t = t.height + max(raw.line_shift(dpi))
    raw_w_t = len(raw.payload(_reads(groups[_last(groups, READ)]))) // (lines_t * 3)
    ratio = window_t / raw_w_t
    origin = start_t - round(tx * ratio)

    raw_w = area.width if ratio == 1 else math.ceil(area.width / RAW_QUANTUM) * RAW_QUANTUM
    window = round(raw_w * ratio)
    start = origin + round(area.x * ratio)
    crop_x = 0
    limit = origin + round(SENSOR_SPAN_IN * dpi * ratio)
    if start + window > limit:           # near the right edge: start earlier, crop on the host
        shift = math.ceil((start + window - limit) / ratio)
        start -= round(shift * ratio)
        crop_x = shift
    used_px = min(window, math.ceil((crop_x + area.width) * ratio) + (USED_MARGIN if ratio != 1 else 0))
    lines = area.height + max(raw.line_shift(dpi))
    per_block = min(255, BLOCK_BYTES // (raw_w * 3))
    if per_block < 1:
        raise ValueError(f"a {raw_w} px line doesn't fit in one block")

    spl = STEPS_PER_INCH // dpi
    moves = [i for i, g in enumerate(groups) if g.command == MOVE]
    if len(moves) < 2:
        raise ValueError("template has no move to the scan area")
    to_top, scan_move = moves[-2], moves[-1]
    ramp = _last(groups[:to_top], TABLE)

    out = list(groups)

    p = bytearray(groups[_first(groups, PARAMS)].params[0])
    struct.pack_into("<4I", p, 8, area.x, area.y, area.width, area.height)
    channels = 1 if t.grey else 3 * (2 if p[25] & 0x10 else 1)   # mode 0x1013: 16-bit
    p[28] = min(254, 65536 // (area.width * channels) // 2 * 2)
    out[_first(groups, PARAMS)] = _with_params(groups[_first(groups, PARAMS)], [bytes(p)])

    for i, g in enumerate(groups):
        if g.command == WINDOW and struct.unpack_from("<2H", g.params[0]) == (start_t, end_t):
            p = bytearray(g.params[0])
            struct.pack_into("<2H", p, 0, start, start + window)
            if i == image_window:
                struct.pack_into("<H", p, 4, lines)
                p[18] = per_block
            out[i] = _with_params(g, [bytes(p)])
        elif g.command == TABLE and g.params[0][0] == 6:
            header = bytearray(g.params[0])
            header[5:8] = (window * 6).to_bytes(3, "little")
            out[i] = _with_params(g, [bytes(header), bytes(window * 6)])

    reads = [i for i, g in enumerate(groups) if g.command == READ]
    for n, i in enumerate(reads[1:], 1):   # the probe read is fixed-size
        if n < len(reads) - 1:
            ref_lines = struct.unpack_from("<H", out[_last(out[:i], WINDOW)].params[0], 4)[0]
            sizes = _chunks(ref_lines * window * 6 + 8)
        else:
            line = raw_w * 3
            sizes = [per_block * line + 8] * (lines // per_block)
            if lines % per_block:
                sizes.append(lines % per_block * line + 8)
        out[i] = Group(READ, [usblog.Record(0.0, 0x81, 0, s, b"") for s in sizes])

    # the move to the top of the area: same total distance plus the y change
    m = groups[to_top].params[0]
    steps_t, ramp_t = struct.unpack_from("<I", m)[0], struct.unpack_from("<H", m, 6)[0] + 1
    distance = steps_t + 2 * ramp_t + (area.y - _ty(groups)) * spl
    n = len(groups[ramp].params[1]) // 2
    while n > 1 and distance - 2 * n < 0:
        n //= 2
    if distance - 2 * n < 0:
        raise ValueError(f"can't reach line {area.y}: move of {distance} steps")
    p = bytearray(m)
    struct.pack_into("<I", p, 0, distance - 2 * n)
    struct.pack_into("<2H", p, 6, n - 1, n - 1)
    out[to_top] = _with_params(groups[to_top], [bytes(p)])

    # the scan move
    m = groups[scan_move].params[0]
    tail = struct.unpack_from("<H", m, 4)[0]
    if struct.unpack_from("<I", m)[0] != lines_t * spl + tail:
        raise ValueError("template's scan move doesn't match its line count")
    p = bytearray(m)
    struct.pack_into("<I", p, 0, lines * spl + tail)
    out[scan_move] = _with_params(groups[scan_move], [bytes(p)])

    windows = [t.windows[0]] + [window] * (len(t.windows) - 1)
    used = np.arange(window) < used_px
    return replace(t, groups=out, width=area.width, height=area.height,
                   windows=windows, used=used, crop_x=crop_x)


def _with_params(g: Group, params: list[bytes]) -> Group:
    it = iter(params)
    steps = []
    for s in g.steps:
        if s.out:
            data = next(it)
            s = replace(s, data=data, requested=len(data))
        steps.append(s)
    return Group(g.command, steps)


def _chunks(total: int) -> list[int]:
    return [BLOCK_BYTES] * (total // BLOCK_BYTES) + ([total % BLOCK_BYTES] if total % BLOCK_BYTES else [])


def _reads(g: Group) -> list[bytes]:
    return [r for r in g.replies if r != b"\x06"]


def _ty(groups: list[Group]) -> int:
    return struct.unpack_from("<I", groups[_first(groups, PARAMS)].params[0], 12)[0]


def _first(groups: list[Group], command: bytes) -> int:
    return next(i for i, g in enumerate(groups) if g.command == command)


def _last(groups: list[Group], command: bytes) -> int:
    return max(i for i, g in enumerate(groups) if g.command == command)
