import unittest

from as3k import framing


class EncodeTest(unittest.TestCase):
    def test_matches_hardcoded_packets_in_original_source(self):
        # UpdaterInfo.h: UPDATER_STAUS_REQUEST_PACKET / _RESPONSE_PACKET
        self.assertEqual(framing.encode(b"\x14"), bytes.fromhex("C0 14 00 14 C1"))
        self.assertEqual(framing.encode(b"\x15"), bytes.fromhex("C0 15 00 15 C1"))

    def test_escapes_special_bytes_in_payload(self):
        self.assertEqual(framing.encode(b"\x5a\xc0"),
                         bytes.fromhex("C0 5A 7D E0 01 1A C1"))

    def test_escapes_special_bytes_in_checksum(self):
        # sum = 0x00C0, so the checksum's low byte needs escaping
        self.assertEqual(framing.encode(b"\x60\x60"),
                         bytes.fromhex("C0 60 60 00 7D E0 C1"))

    def test_checksum_wraps_at_16_bits(self):
        self.assertEqual(framing.checksum(b"\xff" * 300), (0xFF * 300) & 0xFFFF)

    def test_rejects_empty_payload(self):
        with self.assertRaises(ValueError):
            framing.encode(b"")


class DecoderTest(unittest.TestCase):
    def test_round_trips_every_byte_value(self):
        payload = bytes(range(256))
        self.assertEqual(framing.Decoder().feed(framing.encode(payload)), [payload])

    def test_reassembles_frames_split_across_reads(self):
        raw = framing.encode(b"\x5b\x7d\xc1") + framing.encode(b"\x15")
        decoder = framing.Decoder()
        out = []
        for i in range(len(raw)):
            out += decoder.feed(raw[i:i + 1])
        self.assertEqual(out, [b"\x5b\x7d\xc1", b"\x15"])

    def test_ignores_noise_between_frames(self):
        raw = b"\x00\xff" + framing.encode(b"\x15") + b"\x13"
        self.assertEqual(framing.Decoder().feed(raw), [b"\x15"])

    def test_drops_bad_checksum(self):
        decoder = framing.Decoder()
        self.assertEqual(decoder.feed(bytes.fromhex("C0 15 00 16 C1")), [])
        self.assertEqual(decoder.bad_frames, 1)

    def test_new_start_byte_restarts_frame(self):
        raw = bytes.fromhex("C0 99 99") + framing.encode(b"\x15")
        self.assertEqual(framing.Decoder().feed(raw), [b"\x15"])

    def test_drops_frame_too_short_for_a_checksum(self):
        decoder = framing.Decoder()
        self.assertEqual(decoder.feed(bytes.fromhex("C0 15 C1")), [])
        self.assertEqual(decoder.bad_frames, 1)


if __name__ == "__main__":
    unittest.main()
