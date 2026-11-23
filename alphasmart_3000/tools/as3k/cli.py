"""as3k: read-only tool for the AlphaSmart 3000 updater.

    python3 -m as3k --serial /dev/ttyUSB0 info
    python3 -m as3k --usb dump flash.bin --verify
    python3 -m as3k usb-switch --files-saved
"""

import argparse
import hashlib
import os
import sys
import time

from .protocol import FLASH, UPDATER_BOOT_S, DeviceInfo, Updater, UpdaterError
from .transports import SerialTransport, UsbTransport, switch_keyboard_to_updater

GETTING_INTO_UPDATER = """\
The device must be in updater mode first. Either:
  USB:    python3 -m as3k usb-switch --files-saved
  serial: in AlphaWord press Cmd+Ctrl+U, then run this command
Entering updater mode can wipe the files in the device's RAM. Save them first."""


def connect(args) -> tuple[Updater, object]:
    if args.serial:
        transport = SerialTransport.open(args.serial)
        updater = Updater(transport)
        # Answers the updater, or wakes AlphaWord's Cmd+Ctrl+U listener, which
        # then jumps to the Startup Manager to load the updater.
        updater.status()
        time.sleep(UPDATER_BOOT_S)
        if args.baud != 9600:
            updater.set_baud(args.baud, transport.set_baud)
    else:
        transport = UsbTransport.open()
        updater = Updater(transport)
    return updater, transport


def print_info(info: DeviceInfo) -> None:
    machine = {1: "01 (AMD/ST/Fujitsu, 64 KB boot area)",
               2: "02 (Intel/Micron, 128 KB boot area)"}
    print(f"updater version : {info.updater_version}")
    print(f"flash part      : {info.flash_name}")
    print(f"flash size      : {info.flash_size} bytes ({info.flash_size // 1024} KB)")
    print(f"machine id      : {machine.get(info.machine_id, 'not found')}")
    applet = {True: "yes", False: "no (unit will boot into the updater)", None: "unknown"}
    print(f"applet installed: {applet[info.applet_installed]}")


def cmd_info(args) -> int:
    updater, transport = connect(args)
    try:
        print_info(updater.info())
    finally:
        transport.close()
    return 0


def cmd_dump(args) -> int:
    updater, transport = connect(args)
    try:
        info = updater.info()
        print_info(info)
        start = args.start
        if args.length is None and start not in FLASH:
            raise ValueError("--length is required outside flash")
        length = args.length or min(info.flash_size, FLASH.stop - start)

        print(f"reading 0x{start:06X}..0x{start + length - 1:06X}", file=sys.stderr)
        data = updater.read_range(start, length, progress=Progress())
        if args.verify:
            print("verifying (second pass)", file=sys.stderr)
            again = updater.read_range(start, length, progress=Progress())
            if again != data:
                diffs = sum(a != b for a, b in zip(data, again))
                print(f"verify FAILED: {diffs} bytes differ; not writing", file=sys.stderr)
                return 1
    finally:
        transport.close()

    tmp = args.out + ".partial"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, args.out)
    print(f"wrote {args.out}  sha256 {hashlib.sha256(data).hexdigest()}")
    return 0


def cmd_usb_switch(args) -> int:
    if not args.files_saved:
        print("Refusing: entering updater mode can wipe the files in the device's\n"
              "RAM. Send them to the computer first, then pass --files-saved.",
              file=sys.stderr)
        return 2
    switch_keyboard_to_updater()
    print("sent; the device should re-enumerate as 081e:bd01 within a few seconds")
    return 0


class Progress:
    """Prints a percentage to stderr each time it changes."""

    def __init__(self) -> None:
        self.last = -1

    def __call__(self, done: int, total: int) -> None:
        percent = done * 100 // total
        if percent != self.last:
            self.last = percent
            print(f"\r  {percent:3d}%  {done}/{total}", end="", file=sys.stderr)
        if done == total:
            print(file=sys.stderr)


def _int(text: str) -> int:
    return int(text, 0)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="as3k", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    link = parser.add_mutually_exclusive_group()
    link.add_argument("--serial", metavar="PORT", help="serial port on the printer connector")
    link.add_argument("--usb", action="store_true", help="USB, device already in updater mode")
    parser.add_argument("--baud", type=int, default=115200,
                        help="serial speed after connecting (default 115200)")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("info", help="show updater version, flash part and machine id")

    dump = sub.add_parser("dump", help="read flash (or RAM) to a file")
    dump.add_argument("out")
    dump.add_argument("--start", type=_int, default=FLASH.start, help="default 0x400000")
    dump.add_argument("--length", type=_int, help="default: the whole flash part")
    dump.add_argument("--verify", action="store_true", help="read twice and compare")

    switch = sub.add_parser("usb-switch", help="move a USB keyboard-mode unit into updater mode")
    switch.add_argument("--files-saved", action="store_true",
                        help="confirm the device's files are already saved elsewhere")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    commands = {"info": cmd_info, "dump": cmd_dump, "usb-switch": cmd_usb_switch}
    if args.command != "usb-switch" and not (args.serial or args.usb):
        print("pick a link: --serial PORT or --usb", file=sys.stderr)
        return 2
    try:
        return commands[args.command](args)
    except ModuleNotFoundError as exc:
        print(f"error: missing {exc.name}; run: pip install -r requirements.txt",
              file=sys.stderr)
        return 1
    except (TimeoutError, RuntimeError) as exc:
        print(f"error: {exc}\n\n{GETTING_INTO_UPDATER}", file=sys.stderr)
        return 1
    except (UpdaterError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
