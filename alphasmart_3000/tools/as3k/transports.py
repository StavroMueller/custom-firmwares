"""Serial and USB links to the AlphaSmart 3000 updater, plus the USB switch
from keyboard mode into updater mode.

Hardware libraries are imported lazily so the protocol and the tests need
nothing outside the standard library.
"""

import time
from typing import Callable

from . import framing

VENDOR_ID = 0x081E
PID_KEYBOARD = 0xBD04  # normal mode: HID boot keyboard
PID_UPDATER = 0xBD01   # updater / "Get Utility" mode: bulk EP 0x01 out, 0x81 in
USB_PACKET = 8

# HID output (keyboard LED) reports that tell the OS to jump to the updater.
# Ref: S00/Utilities/HostUpdater/UsbInterface.c:239-288,
#      S00/Software/ModuleSources/UsbRequestResponse.c:1220-1330
UPDATER_LED_SEQUENCE = (0xF0, 0xF1, 0xF2, 0xF3, 0xF4)


class SerialTransport:
    """Framed link on the left ("printer") port. Starts at 9600 8N1."""

    def __init__(self, port) -> None:
        self.port = port  # a pyserial Serial, or anything with the same API
        self._decoder = framing.Decoder()
        self._pending: list[bytes] = []

    @classmethod
    def open(cls, path: str) -> "SerialTransport":
        import serial  # pyserial
        return cls(serial.Serial(path, 9600, timeout=0.05))

    def send(self, payload: bytes) -> None:
        self._pending.clear()  # anything unread belongs to an earlier request
        self.port.reset_input_buffer()
        self.port.write(framing.encode(payload))

    def recv(self, timeout: float) -> bytes:
        deadline = time.monotonic() + timeout
        while not self._pending:
            if time.monotonic() > deadline:
                raise TimeoutError
            self._pending += self._decoder.feed(self.port.read(64))
        return self._pending.pop(0)

    def set_baud(self, baud: int) -> None:
        self.port.baudrate = baud

    def close(self) -> None:
        self.port.close()


def usb_packets(payload: bytes) -> list[bytes]:
    """Split a request into 8-byte packets the way the device expects.

    The device treats a short packet as end-of-message, so a payload that is
    an exact multiple of 8 gets one extra padding byte (as the stock host does).
    """
    packets = [payload[i:i + USB_PACKET] for i in range(0, len(payload), USB_PACKET)]
    if len(payload) % USB_PACKET == 0:
        packets.append(b"\x00")
    return packets


class UsbTransport:
    """Bare payloads over bulk endpoints, 8 bytes per packet."""

    def __init__(self, write: Callable[[bytes], None],
                 read: Callable[[float], bytes], close: Callable[[], None]) -> None:
        self._write = write
        self._read = read  # one packet; raises TimeoutError
        self._close = close

    @classmethod
    def open(cls) -> "UsbTransport":
        import usb.core
        import usb.util

        dev = usb.core.find(idVendor=VENDOR_ID, idProduct=PID_UPDATER)
        if dev is None:
            raise RuntimeError(
                f"no device {VENDOR_ID:04x}:{PID_UPDATER:04x}; is it in updater mode?")
        try:
            # Class 0x02 can make the OS bind a CDC driver; take it back.
            if dev.is_kernel_driver_active(0):
                dev.detach_kernel_driver(0)
        except (NotImplementedError, usb.core.USBError):
            pass
        dev.set_configuration()
        usb.util.claim_interface(dev, 0)

        def read(timeout: float) -> bytes:
            try:
                return bytes(dev.read(0x81, USB_PACKET, timeout=int(timeout * 1000)))
            except usb.core.USBTimeoutError as exc:
                raise TimeoutError from exc

        def close() -> None:
            usb.util.dispose_resources(dev)

        return cls(lambda pkt: dev.write(0x01, pkt), read, close)

    def send(self, payload: bytes) -> None:
        for packet in usb_packets(payload):
            self._write(packet)

    def recv(self, timeout: float) -> bytes:
        """Collect packets until a short one.

        The device sends a zero-length packet after every reply, even one
        that already ended short, so a leftover ZLP can arrive first; no reply
        is ever empty, so skip it.
        """
        deadline = time.monotonic() + timeout
        message = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError
            packet = self._read(remaining)
            if not packet and not message:
                continue
            message += packet
            if len(packet) < USB_PACKET:
                return bytes(message)

    def close(self) -> None:
        self._close()


def switch_keyboard_to_updater(write_report: Callable[[bytes], None] | None = None) -> None:
    """Send the LED sequence that moves a USB-connected unit into updater mode.

    WARNING: the updater is copied over the RAM that holds the user's files.
    Get the files off the device first.
    """
    close = None
    if write_report is None:
        import hid  # pip install hidapi
        dev = hid.device()
        dev.open(VENDOR_ID, PID_KEYBOARD)

        def write_report(report: bytes) -> None:
            if dev.write(list(report)) < 0:  # hidapi signals errors with -1
                raise OSError(dev.error())

        close = dev.close

    try:
        *first, last = UPDATER_LED_SEQUENCE
        for led in first:
            write_report(bytes([0x00, led]))  # report ID 0, LED byte
        try:
            write_report(bytes([0x00, last]))
        except OSError:
            pass  # the device drops off the bus as it switches; expected
    finally:
        if close:
            close()
