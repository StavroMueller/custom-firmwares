"""Lend the scanner's USB endpoints to another process over stdin/stdout.

Lets the JavaScript driver (web/v500) run on the real scanner from Node,
without a browser: web/tools/scan-node.mjs starts this and speaks a tiny
binary protocol over the pipes:

  W <u32 len> <data>   write to the bulk OUT endpoint;  reply: K
  R <u32 size>         read up to `size` bytes;          reply: <u32 len> <data>
  any failure          reply: E <u32 len> <utf-8 message>, then exit
"""

import struct
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from v500.usb import UsbTransport  # noqa: E402


def main() -> None:
    inp, out = sys.stdin.buffer, sys.stdout.buffer

    def need(n: int) -> bytes:
        data = inp.read(n)
        if len(data) < n:
            raise EOFError
        return data

    with UsbTransport.open() as io:
        while True:
            try:
                op = need(1)
                n = struct.unpack("<I", need(4))[0]
                if op == b"W":
                    io.write(need(n))
                    out.write(b"K")
                elif op == b"R":
                    data = io.read(n)
                    out.write(struct.pack("<I", len(data)) + data)
                else:
                    raise ValueError(f"unknown op {op!r}")
            except EOFError:
                return
            except Exception as e:  # report, then stop: the driver decides what to do
                msg = f"{type(e).__name__}: {e}".encode()
                out.write(b"E" + struct.pack("<I", len(msg)) + msg)
                out.flush()
                return
            out.flush()


if __name__ == "__main__":
    main()
