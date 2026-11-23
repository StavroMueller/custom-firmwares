import unittest

from as3k.transports import (UPDATER_LED_SEQUENCE, UsbTransport,
                             switch_keyboard_to_updater, usb_packets)


class UsbPacketsTest(unittest.TestCase):
    def test_short_payload_is_one_packet(self):
        self.assertEqual(usb_packets(b"\x01"), [b"\x01"])

    def test_read_request_splits_8_plus_1(self):
        self.assertEqual([len(p) for p in usb_packets(bytes(9))], [8, 1])

    def test_exact_multiple_of_8_gets_padding_byte(self):
        self.assertEqual(usb_packets(bytes(16))[-1], b"\x00")
        self.assertEqual([len(p) for p in usb_packets(bytes(16))], [8, 8, 1])


class UsbRecvTest(unittest.TestCase):
    def recv(self, packets):
        queue = list(packets)
        transport = UsbTransport(write=None, read=lambda t: queue.pop(0), close=None)
        return transport.recv(timeout=1)

    def test_ends_on_short_packet(self):
        self.assertEqual(self.recv([b"A" * 8, b"BC"]), b"A" * 8 + b"BC")

    def test_ends_on_zlp_after_full_packets(self):
        self.assertEqual(self.recv([b"A" * 8, b""]), b"A" * 8)

    def test_skips_stray_zlp_from_previous_reply(self):
        self.assertEqual(self.recv([b"", b"\x15"]), b"\x15")

    def test_timeout_propagates(self):
        def read(timeout):
            raise TimeoutError
        transport = UsbTransport(write=None, read=read, close=None)
        with self.assertRaises(TimeoutError):
            transport.recv(timeout=1)


class SwitchTest(unittest.TestCase):
    def test_sends_led_sequence_and_tolerates_disconnect(self):
        sent = []

        def write_report(report):
            sent.append(report)
            if report[1] == UPDATER_LED_SEQUENCE[-1]:
                raise OSError("device gone")

        switch_keyboard_to_updater(write_report)
        self.assertEqual(sent, [bytes([0, led]) for led in UPDATER_LED_SEQUENCE])

    def test_earlier_failures_are_not_swallowed(self):
        def write_report(report):
            raise OSError("not plugged in")

        with self.assertRaises(OSError):
            switch_keyboard_to_updater(write_report)


if __name__ == "__main__":
    unittest.main()
