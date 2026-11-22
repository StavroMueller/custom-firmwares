import pytest

from v500 import firmware


def make_file(body: bytes = bytes(range(256)) * 256) -> bytes:
    """A synthetic file with the same layout as esfw7C.bin (see PROTOCOL.md)."""
    header = bytearray(0x100)
    header[0:4] = b"EDLA"
    header[0x4C:0x50] = b"\x01\x00\x01\x00"
    return bytes(header) + body + b"\x10"


class FakeScanner:
    """Records writes. Answers the status query with `status`, then `reply` to every read."""

    def __init__(self, reply: int = firmware.ACK, status: bytes = b"\x28\x00"):
        self.writes: list[bytes] = []
        self.reply = reply
        self.status = status  # 28 00 is what a real V500 sent with no firmware

    def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))

    def read(self, size: int) -> bytes:
        if self.writes[-1] == firmware.STATUS:
            return self.status
        return bytes([self.reply]) + bytes(size - 1)


def test_parse_splits_header_and_body():
    fw = firmware.parse(make_file())
    assert fw.upload_header == b"\x01\x00\x01\x00"
    assert len(fw.body) == 65536
    assert fw.checksum == sum(fw.body) & 0xFF


def test_ident_reads_the_version_string():
    body = bytearray(65536)
    body[100:128] = b"EPSON   GT-X770         1.02"
    assert firmware.parse(make_file(bytes(body))).ident == "EPSON GT-X770 1.02"


def test_upload_matches_the_captured_sequence():
    # The sequence tools/trace.c captured from Epson's plugin.
    fw = firmware.parse(make_file())
    scanner = FakeScanner()
    assert firmware.upload(fw, scanner) is True
    assert scanner.writes == [
        b"\x1b\x03",
        b"\x1b\x06",
        b"\x01\x00\x01\x00",
        fw.body,
        bytes([fw.checksum]),
        b"\x1b\x16",
        b"\x80",
    ]


def test_upload_skips_when_firmware_is_loaded():
    scanner = FakeScanner(status=b"\x38\x00")  # bit 0x10 set
    assert firmware.upload(firmware.parse(make_file()), scanner) is False
    assert scanner.writes == [b"\x1b\x03"]


def test_upload_header_is_body_plus_checksum_length():
    # The plugin builds these 4 bytes from the length it sends: body + checksum.
    fw = firmware.parse(make_file())
    assert int.from_bytes(fw.upload_header, "little") == len(fw.body) + 1


def test_upload_stops_when_scanner_refuses():
    with pytest.raises(firmware.FirmwareError, match="expected ACK"):
        firmware.upload(firmware.parse(make_file()), FakeScanner(reply=0x15))


@pytest.mark.parametrize("data", [b"NOPE" + bytes(70000), b"EDLA" + bytes(100)])
def test_parse_rejects_bad_files(data):
    with pytest.raises(firmware.FirmwareError):
        firmware.parse(data)
