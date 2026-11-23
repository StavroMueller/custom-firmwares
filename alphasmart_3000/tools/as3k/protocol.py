"""Read-only client for the AlphaSmart 3000 updater protocol.

This client deliberately implements no write, erase, program or execute
command. Nothing it sends can change flash.

Every request is one command byte plus big-endian arguments. The reply's
first byte is the request + 1 on success, or request + 2 on error.
Ref: S00/Software/ModuleSources/UpdaterCommands.h,
     S00/Software/AlphaSmartApps/Updater/UpdaterMain.c
"""

import time
from dataclasses import dataclass
from enum import IntEnum
from typing import Callable, Protocol


class Op(IntEnum):
    VERSION = 1       # reply 2: one version byte (1 in 2000, 8 in 2003)
    BAUD = 10         # u32 baud; reply 11, then the device switches rate
    STATUS = 20       # reply 21 = idle
    READ = 90         # u32 addr, u32 len; reply 91 + data
    FLASH_NAME = 100  # reply 101 + NUL-terminated ASCII
    FLASH_SIZE = 110  # reply 111 + u32


# The device copies READ data into a 53-byte buffer without checking the
# length (UpdaterMain.c: DebugBreakIfTrue only). Never ask for more.
READ_MAX = 50

RAM = range(0x000000, 0x040000)
FLASH = range(0x400000, 0x500000)  # CSA window; 512 KB parts mirror in it
# Only memory, never the EZ328 registers at 0xFFFFF000: reading some of
# them has side effects (e.g. pops the UART receive FIFO).
READABLE = (RAM, FLASH)

MACHINE_ID_ADDR = 0x400400        # u8 id, then "MachineID Sig"
MACHINE_ID_SIG = b"MachineID Sig"
APPLET_SIG = b"Valid Applet Sig"  # at the end of the boot sectors
APPLET_SIG_ADDR = {1: 0x410000, 2: 0x420000}  # by machine id

BAUD_RATES = (9600, 19200, 38400, 57600, 115200)
BAUD_SETTLE_S = 0.02     # "the host should delay 20 milliseconds"
UPDATER_BOOT_S = 0.5     # the SM copies the updater to RAM after STATUS


class Transport(Protocol):
    def send(self, payload: bytes) -> None: ...
    def recv(self, timeout: float) -> bytes: ...  # raises TimeoutError


class UpdaterError(Exception):
    pass


class BootstrapModeError(UpdaterError):
    """The EZ328 boot ROM is answering: it echoes what we send."""


@dataclass
class DeviceInfo:
    updater_version: int
    flash_name: str
    flash_size: int
    machine_id: int | None   # None if the machine ID signature is missing
    applet_installed: bool | None


def is_readable(addr: int, length: int) -> bool:
    last = addr + length - 1
    return length > 0 and any(addr in r and last in r for r in READABLE)


class Updater:
    def __init__(self, transport: Transport, timeout: float = 1.0,
                 retries: int = 3) -> None:
        self.transport = transport
        self.timeout = timeout
        self.retries = retries

    # -- commands -----------------------------------------------------------

    def status(self) -> None:
        self._transact(bytes([Op.STATUS]))

    def version(self) -> int:
        return self._transact(bytes([Op.VERSION]), reply_op=2)[0]

    def flash_name(self) -> str:
        raw = self._transact(bytes([Op.FLASH_NAME]))
        return raw.split(b"\0", 1)[0].decode("ascii", "replace")

    def flash_size(self) -> int:
        return int.from_bytes(self._transact(bytes([Op.FLASH_SIZE]))[:4], "big")

    def read(self, addr: int, length: int) -> bytes:
        if not 1 <= length <= READ_MAX:
            raise ValueError(f"read length must be 1..{READ_MAX}, got {length}")
        if not is_readable(addr, length):
            raise ValueError(f"0x{addr:06X}+{length} is outside RAM and flash")
        request = bytes([Op.READ]) + addr.to_bytes(4, "big") + length.to_bytes(4, "big")
        data = self._transact(request)
        if len(data) != length:
            raise UpdaterError(f"asked for {length} bytes at 0x{addr:06X}, got {len(data)}")
        return data

    def read_range(self, addr: int, length: int,
                   progress: Callable[[int, int], None] | None = None) -> bytes:
        out = bytearray()
        while len(out) < length:
            chunk = min(READ_MAX, length - len(out))
            out += self.read(addr + len(out), chunk)
            if progress:
                progress(len(out), length)
        return bytes(out)

    def set_baud(self, baud: int, apply_locally: Callable[[int], None]) -> None:
        """Serial only. Not retried: a lost reply leaves the rates unknown."""
        if baud not in BAUD_RATES:
            raise ValueError(f"baud must be one of {BAUD_RATES}")
        self._transact(bytes([Op.BAUD]) + baud.to_bytes(4, "big"), retries=1)
        time.sleep(BAUD_SETTLE_S)
        apply_locally(baud)

    def info(self) -> DeviceInfo:
        version = self.version()
        name, size = self.flash_name(), self.flash_size()

        raw = self.read(MACHINE_ID_ADDR, 1 + len(MACHINE_ID_SIG))
        machine_id = raw[0] if raw[1:] == MACHINE_ID_SIG else None

        applet = None
        if machine_id in APPLET_SIG_ADDR:
            sig = self.read(APPLET_SIG_ADDR[machine_id], len(APPLET_SIG))
            applet = sig == APPLET_SIG
        return DeviceInfo(version, name, size, machine_id, applet)

    # -- plumbing -----------------------------------------------------------

    def _transact(self, request: bytes, reply_op: int | None = None,
                  retries: int | None = None) -> bytes:
        """Send, wait for the matching reply, return its body (sans opcode).

        Retrying is safe: every command this client sends is read-only.
        """
        expected = request[0] + 1 if reply_op is None else reply_op
        for _ in range(retries or self.retries):
            self.transport.send(request)
            try:
                reply = self.transport.recv(self.timeout)
            except TimeoutError:
                continue
            if reply[0] == expected:
                return reply[1:]
            if reply == request:
                raise BootstrapModeError(
                    "device echoed the request: it is in EZ328 bootstrap mode, "
                    "which this tool does not speak yet")
            raise UpdaterError(
                f"command {request[0]}: expected reply {expected}, got {reply[0]}")
        raise TimeoutError(f"no reply to command {request[0]}")
