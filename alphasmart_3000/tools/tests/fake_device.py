"""A software stand-in for the AlphaSmart 3000 updater, built from the
original source (UpdaterMain.c, usbtoud.c), for testing without hardware."""

from collections import deque

from as3k import framing
from as3k.protocol import APPLET_SIG, MACHINE_ID_SIG

FLASH_BASE = 0x400000


def make_flash(size: int = 0x100000, machine_id: int = 2, applet: bool = True) -> bytearray:
    flash = bytearray(i * 7 % 251 for i in range(size))  # recognisable filler
    flash[0x400:0x400 + 1 + len(MACHINE_ID_SIG)] = bytes([machine_id]) + MACHINE_ID_SIG
    if applet:
        sig_off = {1: 0x10000, 2: 0x20000}[machine_id]
        flash[sig_off:sig_off + len(APPLET_SIG)] = APPLET_SIG
    return flash


class FakeUpdater:
    """Payload-level device. Doubles as a Transport for protocol tests."""

    def __init__(self, flash: bytearray | None = None, version: int = 8,
                 flash_name: str = "Intel 28F008B3", drop_replies: set[int] = frozenset()):
        self.flash = flash if flash is not None else make_flash()
        self.ram = bytearray(0x40000)
        self.version = version
        self.flash_name = flash_name
        self.drop_replies = drop_replies  # indexes of requests whose reply is lost
        self.requests: list[bytes] = []
        self.baud = 9600
        self._replies: deque[bytes] = deque()

    # -- device behaviour -----------------------------------------------------

    def handle(self, req: bytes) -> bytes:
        op = req[0]
        if op == 1:
            return bytes([2, self.version])
        if op == 10:
            self.baud = int.from_bytes(req[1:5], "big")
            return bytes([11])
        if op == 20:
            return bytes([21])
        if op == 90:
            addr = int.from_bytes(req[1:5], "big")
            length = int.from_bytes(req[5:9], "big")
            if length > 50:
                raise AssertionError("real device would overflow its 53-byte buffer")
            return bytes([91]) + self._peek(addr, length)
        if op == 100:
            return bytes([101]) + self.flash_name.encode() + b"\0"
        if op == 110:
            return bytes([111]) + len(self.flash).to_bytes(4, "big")
        raise AssertionError(f"tool sent non-read-only command {op}")

    def _peek(self, addr: int, length: int) -> bytes:
        if addr >= FLASH_BASE:
            off = (addr - FLASH_BASE) % len(self.flash)  # small parts mirror
            return bytes(self.flash[off:off + length])
        return bytes(self.ram[addr:addr + length])

    # -- Transport interface --------------------------------------------------

    def send(self, payload: bytes) -> None:
        index = len(self.requests)
        self.requests.append(payload)
        reply = self.handle(payload)
        if index not in self.drop_replies:
            self._replies.append(reply)

    def recv(self, timeout: float) -> bytes:
        if not self._replies:
            raise TimeoutError
        return self._replies.popleft()


class BootstrapEcho(FakeUpdater):
    """The EZ328 boot ROM echoes every byte back."""

    def handle(self, req: bytes) -> bytes:
        return req


class FakeSerialPort:
    """pyserial-shaped port wired to a FakeUpdater through the real framer.

    Replies come back a few bytes per read() to exercise frame reassembly.
    """

    def __init__(self, device: FakeUpdater, read_size: int = 5):
        self.device = device
        self.read_size = read_size
        self.baudrate = 9600
        self._decoder = framing.Decoder()
        self._rx = bytearray()

    def write(self, raw: bytes) -> None:
        for request in self._decoder.feed(raw):
            self._rx += framing.encode(self.device.handle(request))

    def read(self, n: int) -> bytes:
        n = min(n, self.read_size)
        out, self._rx = bytes(self._rx[:n]), self._rx[n:]
        return out

    def reset_input_buffer(self) -> None:
        self._rx.clear()

    def close(self) -> None:
        pass


class FakeUsbBus:
    """Packet-level USB device, following usbtoud.c."""

    def __init__(self, device: FakeUpdater, stray_zlp: bool = False):
        self.device = device
        self.out_packets: list[bytes] = []
        self._rx = bytearray()
        self._in: deque[bytes] = deque([b""] if stray_zlp else [])

    def write(self, packet: bytes) -> None:
        assert 1 <= len(packet) <= 8
        self.out_packets.append(packet)
        self._rx += packet
        if len(packet) < 8:  # short packet ends the message
            reply = self.device.handle(bytes(self._rx))
            self._rx.clear()
            for i in range(0, len(reply), 8):
                self._in.append(reply[i:i + 8])
            self._in.append(b"")  # the device always follows with a ZLP

    def read(self, timeout: float) -> bytes:
        if not self._in:
            raise TimeoutError
        return self._in.popleft()
