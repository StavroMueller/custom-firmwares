"""Scan without Epson's plugin, by replaying a template.

A template is a capture of Epson's driver making one scan
(tools/capture/capture.sh). We send the same commands in the same order,
with four changes, all computed from what the scanner reports live:

- the analog levels (`1e 31`): the scanner's own measurement (`1e 92`),
- the probe offsets (second `1e 42`): from the dark probe read,
- the base levels and offsets (last `1e 42`) and the shading table
  (`1e 84` type 06): from the white and dark reference reads.

Status polls are not replayed blindly: `1e 04` is polled until it says ready,
`1b 03` until the busy bit clears.

Everything else, including Epson's motor and tone tables, comes from the
template. Templates are captures of Epson's software, so they stay on the
user's machine (captures/ is gitignored).

    python -m v500.replay captures/<ts>/02-color-200-full.usblog scan.png --firmware esfw7C.bin
"""

import struct
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

import numpy as np

from . import calibration, raw, usblog

POLL_READY = b"\x1e\x04"
STATUS = b"\x1b\x03"
BUSY = 0x40
POLL_INTERVAL = 0.1
POLL_TIMEOUT = 60.0


class Transport(Protocol):
    def write(self, data: bytes) -> None: ...

    def read(self, size: int) -> bytes: ...


@dataclass
class Group:
    """A command and everything sent or read until the next command."""
    command: bytes
    steps: list[usblog.Record]

    @property
    def params(self) -> list[bytes]:
        return [s.data for s in self.steps if s.out]

    @property
    def replies(self) -> list[bytes]:
        return [s.data for s in self.steps if not s.out]


def is_command(rec: usblog.Record) -> bool:
    return rec.out and len(rec.data) == 2 and rec.data[0] in (0x1B, 0x1E)


def group(records: list[usblog.Record]) -> list[Group]:
    groups: list[Group] = []
    for rec in records:
        if is_command(rec):
            groups.append(Group(rec.data, []))
        elif groups:
            groups[-1].steps.append(rec)
    return groups


@dataclass
class Template:
    groups: list[Group]
    xres: int
    yres: int
    width: int
    height: int
    grey: bool
    windows: list[int] = field(default_factory=list)   # sensor width of each 1e 47 read
    used: np.ndarray | None = None                      # pixels Epson's shading table filled

    @classmethod
    def load(cls, path: str | Path) -> "Template":
        groups = group(usblog.read(path))
        params = next(g.params[0] for g in groups if g.command == b"\x1e\x57")
        xres, yres, _, _, width, height, mode = struct.unpack_from("<7I", params)
        windows, window = [], None
        table = None
        for g in groups:
            if g.command == b"\x1e\x41":
                start, end = struct.unpack_from("<2H", g.params[0])
                window = end - start
            if g.command == b"\x1e\x47":
                windows.append(window)
            if g.command == b"\x1e\x84" and g.params[0][0] == 6:
                table = g.params[1]
        reads = sum(g.command == b"\x1e\x47" for g in groups)
        if reads != 4 or table is None:
            raise ValueError(f"{path}: expected 4 data reads and a shading table, found {reads}")
        used = np.frombuffer(table, "<u2").reshape(-1, 3).min(1) > 0
        return cls(groups, xres, yres, width, height, mode == 0x800, windows, used)


class Replayer:
    def __init__(self, template: Template, io: Transport,
                 sleep: Callable[[float], None] = time.sleep, log: Callable[[str], None] = lambda s: None):
        self.t = template
        self.io = io
        self.sleep = sleep
        self.log = log
        self.reads: list[list[bytes]] = []
        self.afe: bytes | None = None
        self.probe_off: np.ndarray | None = None
        self.cal: calibration.Calibration | None = None
        self.count: dict[bytes, int] = {}

    def run(self) -> np.ndarray:
        groups = self.t.groups
        i = 0
        while i < len(groups):
            g = groups[i]
            if g.command == POLL_READY:
                while i + 1 < len(groups) and groups[i + 1].command == POLL_READY:
                    i += 1
                self.poll_ready()
            elif g.command == STATUS:
                while i + 1 < len(groups) and groups[i + 1].command == STATUS:
                    i += 1
                self.wait_not_busy()
            else:
                self.replay(g)
            i += 1
        image = raw.payload(self.reads[-1])
        return raw.decode(image, self.t.width, self.t.height, dpi=self.t.yres, grey=self.t.grey)

    def replay(self, g: Group) -> None:
        n = self.count.get(g.command, 0)
        self.count[g.command] = n + 1
        self.io.write(g.command)
        replies: list[bytes] = []
        params = iter(self.substitute(g, n))
        for step in g.steps:
            if step.out:
                self.io.write(next(params))
            else:
                reply = self.io.read(step.requested)
                if len(reply) != step.requested:
                    raise OSError(f"{g.command.hex(' ')}: read {len(reply)} of {step.requested} bytes")
                if step.data == b"\x06" and reply != b"\x06":
                    raise OSError(f"{g.command.hex(' ')}: scanner replied {reply.hex(' ')}, expected ACK")
                replies.append(reply)
        self.after(g, n, replies)

    def substitute(self, g: Group, n: int) -> list[bytes]:
        params = list(g.params)
        if g.command == b"\x1e\x31" and n > 0:
            params[0] = self.need(self.afe, "1e 92 reply")
        elif g.command == b"\x1e\x42" and n == 1:      # after the dark probe
            params[0] = calibration.offsets_param(self.need(self.probe_off, "probe read"))
        elif g.command == b"\x1e\x42" and n == 3:      # after white and dark, before the image
            params[0] = self.calibrate().param_1e42()
        elif g.command == b"\x1e\x84" and params and params[0][0] == 6:
            params[1] = self.calibrate().table_bytes()
        return params

    def after(self, g: Group, n: int, replies: list[bytes]) -> None:
        if g.command == b"\x1e\x92":
            self.afe = replies[0]
        elif g.command == b"\x1e\x47":
            data = [r for r in replies if r != b"\x06"]
            self.reads.append(data)
            k = len(self.reads) - 1
            self.log(f"read {k}: {sum(map(len, data))} bytes")
            if k == 0:
                probe = calibration.u16_rgb(raw.payload(data), self.t.windows[0])
                self.probe_off = calibration.probe_offsets(probe)

    def calibrate(self) -> calibration.Calibration:
        if self.cal is None:
            if len(self.reads) < 3:
                raise RuntimeError("calibration needed before the reference reads")
            w = self.t.windows
            white = calibration.u16_rgb(raw.payload(self.reads[1]), w[1])
            dark = calibration.u16_rgb(raw.payload(self.reads[2]), w[2])
            self.cal = calibration.compute(white, dark, self.need(self.probe_off, "probe"), self.t.used)
            self.log(f"calibration: base {self.cal.base} offsets {self.cal.offsets} scale {self.cal.scale}")
        return self.cal

    def poll_ready(self) -> None:
        deadline = time.monotonic() + POLL_TIMEOUT
        while True:
            self.io.write(POLL_READY)
            if self.io.read(1)[:1] == b"\x01":
                return
            if time.monotonic() > deadline:
                raise TimeoutError("scanner never reported ready (1e 04)")
            self.sleep(POLL_INTERVAL)

    def wait_not_busy(self) -> None:
        deadline = time.monotonic() + POLL_TIMEOUT
        while True:
            self.io.write(STATUS)
            reply = self.io.read(2)
            if not reply[0] & BUSY:
                return
            if time.monotonic() > deadline:
                raise TimeoutError(f"scanner stayed busy (status {reply.hex(' ')})")
            self.sleep(POLL_INTERVAL)

    @staticmethod
    def need(value, what: str):
        if value is None:
            raise RuntimeError(f"template order unexpected: no {what} yet")
        return value


class ReplayScanner:
    """The booth's `Scanner` backed by template replay.

    `templates` maps a resolution to a template capture. Each scan opens the
    scanner, uploads the firmware if it was power-cycled, and replays.
    """

    def __init__(self, templates: dict[int, Path], firmware_path: Path | None = None,
                 open_transport: Callable[[], "Transport"] | None = None):
        if not templates:
            raise ValueError("no templates")
        self.templates = {dpi: Template.load(path) for dpi, path in templates.items()}
        self.firmware_path = firmware_path
        self.open_transport = open_transport

    @classmethod
    def from_dir(cls, folder: Path, firmware_path: Path | None = None) -> "ReplayScanner":
        """One colour template per resolution, from a folder of captures."""
        found: dict[int, Path] = {}
        for path in sorted(Path(folder).glob("*.usblog")):
            try:
                t = Template.load(path)
            except (ValueError, StopIteration):
                continue  # not a scan: listing, options, failed step
            if not t.grey:
                found.setdefault(t.yres, path)
        return cls(found, firmware_path)

    def scan(self, settings):
        from . import firmware
        from .scanner import Scan

        template = self.templates.get(settings.dpi)
        if template is None:
            raise ValueError(f"no template for {settings.dpi} dpi; have {sorted(self.templates)}")
        if self.open_transport is None:
            from .usb import UsbTransport
            transport = UsbTransport.open()
        else:
            transport = self.open_transport()
        try:
            if self.firmware_path:
                firmware.upload(firmware.load(self.firmware_path), transport)
            image = Replayer(template, transport).run()
        finally:
            close = getattr(transport, "close", None)
            if close:
                close()
        if image.ndim == 2:
            image = np.repeat(image[..., None], 3, axis=-1)
        strips = (image[top:top + 32] for top in range(0, image.shape[0], 32))
        return Scan(image.shape[1], image.shape[0], strips)

    def close(self) -> None:
        pass


def main() -> None:
    import argparse

    from PIL import Image

    from . import firmware
    from .usb import UsbTransport

    parser = argparse.ArgumentParser(description="Scan by replaying a capture of Epson's driver.")
    parser.add_argument("template", help="usblog of one scan, from tools/capture")
    parser.add_argument("out", help="PNG to write")
    parser.add_argument("--firmware", type=Path, help="esfw7C.bin, uploaded if the scanner needs it")
    args = parser.parse_args()

    template = Template.load(args.template)
    print(f"template: {template.width} x {template.height} at {template.yres} dpi"
          f"{' grey' if template.grey else ''}, {len(template.groups)} commands")
    with UsbTransport.open() as io:
        if args.firmware:
            if firmware.upload(firmware.load(args.firmware), io):
                print("firmware uploaded")
        image = Replayer(template, io, log=print).run()
    Image.fromarray(image).save(args.out)
    print(f"saved {args.out}")


if __name__ == "__main__":
    main()
