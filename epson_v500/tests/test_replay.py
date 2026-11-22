import glob
from pathlib import Path
import struct

import numpy as np
import pytest
from fake_template_scanner import TemplateScanner

from v500 import raw, replay, usblog

ACK = b"\x06"


def trailer(n: int) -> bytes:
    return b"\x02" + n.to_bytes(3, "little") + b"\x00\x00\x80\x00"


def write_template(path, width=4, height=2, window=8):
    """A minimal template with the shape of a real one."""
    recs = []

    def out(d):
        recs.append((0x02, d))

    def inp(d):
        recs.append((0x81, d))

    def cmd(c, *steps):
        out(c)
        for direction, data in steps:
            (out if direction == "out" else inp)(data)

    def window_41(lines, start=0, end=window):
        return struct.pack("<3H", start, end, lines) + bytes(16)

    def u16_block(lines, value, width=window):
        d = (np.full((lines, width, 3), value, "<u2")).tobytes()
        return d + trailer(len(d))

    lines = height + 10
    params = struct.pack("<10I", 200, 200, 0, 0, width, height, 0x813, 0, 0x8000, 0) + bytes(2)
    cmd(b"\x1e\x57", ("in", ACK), ("out", params), ("in", ACK))
    cmd(b"\x1b\x03", ("in", b"\x18\x81"))
    cmd(b"\x1e\x31", ("in", ACK), ("out", bytes(12)), ("in", ACK))
    cmd(b"\x1e\x04", ("in", b"\x02"))
    cmd(b"\x1e\x04", ("in", b"\x01"))
    cmd(b"\x1e\x92", ("in", b"\x8a\x00" * 3 + bytes(6)))
    cmd(b"\x1e\x31", ("in", ACK), ("out", b"TEMPLATE-AFE"), ("in", ACK))
    cmd(b"\x1e\x42", ("in", ACK), ("out", bytes(18)), ("in", ACK))
    cmd(b"\x1e\x41", ("in", ACK), ("out", window_41(4, 21, 37)), ("in", ACK))   # the dark probe
    cmd(b"\x1e\x47", ("in", u16_block(4, 1200, 16)))
    cmd(b"\x1e\x42", ("in", ACK), ("out", b"TEMPLATE-OFFSETS!!"), ("in", ACK))
    cmd(b"\x1e\x41", ("in", ACK), ("out", window_41(32)), ("in", ACK))
    cmd(b"\x1e\x47", ("in", u16_block(32, 40000)))
    cmd(b"\x1e\x42", ("in", ACK), ("out", bytes(18)), ("in", ACK))
    cmd(b"\x1e\x41", ("in", ACK), ("out", window_41(16)), ("in", ACK))
    cmd(b"\x1e\x47", ("in", u16_block(16, 1300)))
    cmd(b"\x1e\x42", ("in", ACK), ("out", b"TEMPLATE-FINAL!!!!"), ("in", ACK))
    table = np.ones((window, 3), "<u2").tobytes()
    cmd(b"\x1e\x84", ("in", ACK), ("out", b"\x06\x00\x08\x01\x02" + (window * 6).to_bytes(3, "little")),
        ("out", table), ("in", ACK))
    ramp = np.linspace(2500, 300, 512).astype("<u2").tobytes()
    cmd(b"\x1e\x84", ("in", ACK), ("out", b"\x05\x00\x00\x01\x02\x00\x04\x00"), ("out", ramp), ("in", ACK))
    cmd(b"\x1e\x01", ("in", ACK), ("out", struct.pack("<I4H", 194, 0, 255, 255, 0x10)), ("in", ACK))
    cmd(b"\x1e\x41", ("in", ACK), ("out", window_41(lines)), ("in", ACK))
    cmd(b"\x1e\x01", ("in", ACK), ("out", struct.pack("<I4H", lines * 12 + 120, 120, 511, 511, 0)), ("in", ACK))
    image = (np.arange(lines * window * 3) % 251).astype(np.uint8).tobytes()
    cmd(b"\x1e\x47", ("in", image + trailer(len(image))))
    cmd(b"\x1b\x03", ("in", b"\x18\x81"))

    with open(path, "wb") as f:
        f.write(usblog.MAGIC)
        for ep, data in recs:
            f.write(usblog.RECORD.pack(0.0, ep, ord("B"), 0, len(data), len(data)))
            f.write(data)
    return image


class Device(TemplateScanner):
    """Busy for the first status polls and slow to become ready."""

    def __init__(self, template, busy=2, not_ready=3):
        super().__init__(template)
        self.busy, self.not_ready = busy, not_ready

    def read(self, size):
        if self.last_command == replay.STATUS and self.busy:
            self.busy -= 1
            return b"\x58\x81"
        if self.last_command == replay.POLL_READY and self.not_ready:
            self.not_ready -= 1
            return b"\x02"
        return super().read(size)


def test_replay_substitutes_live_calibration_and_waits_for_the_scanner(tmp_path):
    path = tmp_path / "t.usblog"
    image = write_template(path)
    t = replay.Template.load(path)
    dev = Device(t)
    out = replay.Replayer(t, dev, sleep=lambda s: None).run()

    sent = dev.writes
    assert b"TEMPLATE-AFE" not in sent and b"\x8a\x00" * 3 + bytes(6) in sent   # 1e 31 <- 1e 92
    assert b"TEMPLATE-OFFSETS!!" not in sent and b"TEMPLATE-FINAL!!!!" not in sent
    offsets = sent[sent.index(b"\x1e\x42", sent.index(b"\x1e\x42") + 1) + 1]
    assert struct.unpack("<9H", offsets)[3::2] == (1200, 1200, 1200)
    assert sent.count(replay.POLL_READY) == 4          # polled until ready
    assert sent.count(replay.STATUS) == 4              # waited out "busy"
    expected = raw.decode(image, 4, 2)
    assert np.array_equal(out, expected)


def test_replay_stops_when_the_scanner_refuses(tmp_path):
    path = tmp_path / "t.usblog"
    write_template(path)
    t = replay.Template.load(path)

    class Refuses(TemplateScanner):
        def read(self, size):
            reply = super().read(size)
            return b"\x15" if reply == ACK else reply

    with pytest.raises(OSError, match="expected ACK"):
        replay.Replayer(t, Refuses(t), sleep=lambda s: None).run()


TEMPLATES = sorted(glob.glob(str(Path(__file__).parent.parent / "captures/*/0[2-6]*.usblog")))


@pytest.mark.skipif(not TEMPLATES, reason="needs captures of Epson's driver (gitignored)")
@pytest.mark.parametrize("path", TEMPLATES)
def test_replaying_a_real_capture(path):
    t = replay.Template.load(path)
    dev = TemplateScanner(t)
    image = replay.Replayer(t, dev, sleep=lambda s: None).run()
    ref, _ = raw.scan_from_capture(path)
    assert np.array_equal(image, ref)
    assert not dev.replies, "replay skipped some of the template's reads"


def test_booth_backend_scans_through_a_template(tmp_path):
    from v500.scanner import ScanSettings

    from fake_geometry_scanner import GeometryScanner

    write_template(tmp_path / "t.usblog")
    scanner = replay.ReplayScanner.from_dir(tmp_path)
    scanner.open_transport = lambda: GeometryScanner(ratio=1)
    scan = scanner.scan(ScanSettings(dpi=200, area_mm=(1, 2, 0.5, 0.4)))   # 3 x 3 px
    strips = list(scan.strips)
    assert (scan.width, scan.height) == (3, 3)
    assert sum(s.shape[0] for s in strips) == 3 and strips[0].shape[1:] == (3, 3)
    with pytest.raises(ValueError, match="no template for 400"):
        scanner.scan(ScanSettings(dpi=400))
