"""Serial framing used by the AlphaSmart 3000 updater.

    C0 | escape(payload + checksum) | C1

- checksum: 16-bit sum of the payload bytes (not a CRC), big-endian
- escape:   C0, C1 and 7D are sent as 7D, byte ^ 0x20

USB carries bare payloads; only the serial link is framed.
Ref: S00/Software/AlphaSmartApps/Updater/RS232Framer.c
"""

BOF = 0xC0
EOF = 0xC1
ESC = 0x7D
ESC_MASK = 0x20
_SPECIAL = (BOF, EOF, ESC)


def checksum(payload: bytes) -> int:
    return sum(payload) & 0xFFFF


def encode(payload: bytes) -> bytes:
    if not payload:
        raise ValueError("payload must hold at least the command byte")
    body = payload + checksum(payload).to_bytes(2, "big")
    out = bytearray([BOF])
    for byte in body:
        if byte in _SPECIAL:
            out += bytes([ESC, byte ^ ESC_MASK])
        else:
            out.append(byte)
    out.append(EOF)
    return bytes(out)


class Decoder:
    """Turns a raw serial byte stream into payloads with valid checksums.

    Bytes outside a frame are ignored, a new C0 restarts the frame (as on the
    device), and frames with a bad checksum are dropped and counted.
    """

    def __init__(self) -> None:
        self._frame: bytearray | None = None
        self._escaped = False
        self.bad_frames = 0

    def feed(self, data: bytes) -> list[bytes]:
        payloads = []
        for byte in data:
            if byte == BOF:
                self._frame, self._escaped = bytearray(), False
            elif self._frame is None:
                continue  # line noise between frames
            elif byte == EOF:
                payload = self._finish()
                if payload is not None:
                    payloads.append(payload)
            elif byte == ESC:
                self._escaped = True
            else:
                if self._escaped:
                    byte ^= ESC_MASK
                    self._escaped = False
                self._frame.append(byte)
        return payloads

    def _finish(self) -> bytes | None:
        frame, self._frame = self._frame, None
        if len(frame) < 3:  # command byte + 2 checksum bytes at minimum
            self.bad_frames += 1
            return None
        payload, received = bytes(frame[:-2]), int.from_bytes(frame[-2:], "big")
        if checksum(payload) != received:
            self.bad_frames += 1
            return None
        return payload
