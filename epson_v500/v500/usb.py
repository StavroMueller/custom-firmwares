"""Bulk USB transport to the V500, via pyusb.

Not yet run against real hardware.
"""

import usb.core
import usb.util

VENDOR_ID = 0x04B8
PRODUCT_ID = 0x0130
TIMEOUT_MS = 10_000


class UsbTransport:
    def __init__(self, device: usb.core.Device):
        self.device = device
        interface = device.get_active_configuration()[(0, 0)]
        self.out_ep = _endpoint(interface, usb.util.ENDPOINT_OUT)
        self.in_ep = _endpoint(interface, usb.util.ENDPOINT_IN)

    @classmethod
    def open(cls) -> "UsbTransport":
        device = usb.core.find(idVendor=VENDOR_ID, idProduct=PRODUCT_ID)
        if device is None:
            raise OSError(f"no scanner at {VENDOR_ID:04x}:{PRODUCT_ID:04x}")
        if device.is_kernel_driver_active(0):
            device.detach_kernel_driver(0)
        device.set_configuration()
        return cls(device)

    def write(self, data: bytes) -> None:
        written = self.out_ep.write(data, timeout=TIMEOUT_MS)
        if written != len(data):
            raise OSError(f"short write: {written} of {len(data)} bytes")

    def read(self, size: int) -> bytes:
        return bytes(self.in_ep.read(size, timeout=TIMEOUT_MS))

    def close(self) -> None:
        usb.util.dispose_resources(self.device)

    def __enter__(self) -> "UsbTransport":
        return self

    def __exit__(self, *exc) -> None:
        self.close()


def _endpoint(interface, direction):
    def is_bulk(ep):
        return (usb.util.endpoint_direction(ep.bEndpointAddress) == direction
                and usb.util.endpoint_type(ep.bmAttributes) == usb.util.ENDPOINT_TYPE_BULK)

    ep = usb.util.find_descriptor(interface, custom_match=is_bulk)
    if ep is None:
        raise OSError("scanner has no bulk endpoint in that direction")
    return ep
