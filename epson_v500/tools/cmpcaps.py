"""Line up the V500's command parameters across several captures.

    python tools/cmpcaps.py captures/<ts>/*.usblog
    python tools/cmpcaps.py captures/<ts>/*.usblog --cmd "1e 41" --cmd "1e 01"

For each command, prints the parameter block (or reply) of its n-th use in
every capture, one row per capture, so the bytes that change with a setting
line up in columns.
"""

import argparse
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from usbpcap import usblog_transfers  # noqa: E402

NOISE = {"1b 03", "1e 04", "1e 65", "1b 13"}  # polls and identity, same every time


def commands(path: str) -> list[tuple[str, list[bytes], bytes | None]]:
    """[(command, parameter blocks sent, first non-ACK reply)] in order."""
    trs = list(usblog_transfers(path))
    out = []
    i = 0
    while i < len(trs):
        t = trs[i]
        if t.out and len(t.data) == 2 and t.data[0] in (0x1B, 0x1E):
            params, reply = [], None
            j = i + 1
            while j < len(trs) and not (trs[j].out and len(trs[j].data) == 2 and trs[j].data[0] in (0x1B, 0x1E)):
                x = trs[j]
                if x.out:
                    params.append(x.data)
                elif reply is None and x.data != b"\x06":
                    reply = x.data
                j += 1
            out.append((t.data.hex(" "), params, reply))
            i = j
        else:
            i += 1
    return out


def show(block: bytes | None, limit: int) -> str:
    if block is None:
        return "-"
    text = block[:limit].hex(" ")
    return text + (f" ... ({len(block)} B)" if len(block) > limit else "")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("usblogs", nargs="+")
    parser.add_argument("--cmd", action="append", help='only these commands, e.g. "1e 41"')
    parser.add_argument("--max-bytes", type=int, default=42)
    args = parser.parse_args()

    names = [Path(p).stem for p in args.usblogs]
    width = max(map(len, names))
    table: dict[tuple[str, int], dict[str, str]] = defaultdict(dict)
    order: list[tuple[str, int]] = []
    for name, path in zip(names, args.usblogs):
        seen: dict[str, int] = defaultdict(int)
        for cmd, params, reply in commands(path):
            if cmd in NOISE or (args.cmd and cmd not in args.cmd):
                continue
            key = (cmd, seen[cmd])
            seen[cmd] += 1
            if key not in table:
                order.append(key)
            parts = [show(p, args.max_bytes) for p in params]
            if reply is not None:
                parts.append("=> " + show(reply, args.max_bytes))
            table[key][name] = " | ".join(parts) or "(no data)"
    for key in order:
        rows = table[key]
        same = len(set(rows.values())) == 1 and len(rows) == len(names)
        print(f"{key[0]} #{key[1]}" + ("   (same in all)" if same else ""))
        if same:
            print(f"  {'':{width}}  {next(iter(rows.values()))}")
            continue
        for name in names:
            print(f"  {name:{width}}  {rows.get(name, '(absent)')}")


if __name__ == "__main__":
    main()
