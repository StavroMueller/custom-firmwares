import unittest

from as3k.protocol import (READ_MAX, BootstrapModeError, Op, Updater,
                           UpdaterError, is_readable)
from as3k.transports import SerialTransport, UsbTransport

from .fake_device import (BootstrapEcho, FakeSerialPort, FakeUpdater,
                          FakeUsbBus, make_flash)

READ_ONLY_OPS = {int(op) for op in Op}


class InfoTest(unittest.TestCase):
    def test_reports_part_machine_id_and_applet(self):
        info = Updater(FakeUpdater()).info()
        self.assertEqual(info.updater_version, 8)
        self.assertEqual(info.flash_name, "Intel 28F008B3")
        self.assertEqual(info.flash_size, 0x100000)
        self.assertEqual(info.machine_id, 2)
        self.assertTrue(info.applet_installed)

    def test_machine_id_01_checks_applet_at_0x410000(self):
        device = FakeUpdater(make_flash(0x80000, machine_id=1, applet=False))
        info = Updater(device).info()
        self.assertEqual(info.machine_id, 1)
        self.assertFalse(info.applet_installed)

    def test_missing_machine_id_signature(self):
        flash = make_flash()
        flash[0x401:0x40E] = b"\xff" * 13
        info = Updater(FakeUpdater(flash)).info()
        self.assertIsNone(info.machine_id)
        self.assertIsNone(info.applet_installed)


class ReadTest(unittest.TestCase):
    def test_read_range_returns_exact_bytes_in_capped_chunks(self):
        device = FakeUpdater()
        data = Updater(device).read_range(0x400000, 1234)
        self.assertEqual(data, bytes(device.flash[:1234]))
        lengths = [int.from_bytes(r[5:9], "big") for r in device.requests]
        self.assertTrue(all(n <= READ_MAX for n in lengths))

    def test_refuses_oversized_read(self):
        with self.assertRaises(ValueError):
            Updater(FakeUpdater()).read(0x400000, READ_MAX + 1)

    def test_refuses_registers_and_unmapped_space(self):
        for addr in (0xFFFFF000, 0x600000, 0x3FFF0 + 0x20):
            with self.subTest(addr=hex(addr)), self.assertRaises(ValueError):
                Updater(FakeUpdater()).read(addr, 32)

    def test_is_readable_bounds(self):
        self.assertTrue(is_readable(0x3FFCE, 50))
        self.assertFalse(is_readable(0x3FFCF, 50))   # runs past the end of RAM
        self.assertTrue(is_readable(0x4FFFCE, 50))
        self.assertFalse(is_readable(0x400000, 0))


class RobustnessTest(unittest.TestCase):
    def test_retries_a_lost_reply(self):
        device = FakeUpdater(drop_replies={0})
        self.assertEqual(Updater(device).version(), 8)
        self.assertEqual(len(device.requests), 2)

    def test_gives_up_after_retries(self):
        device = FakeUpdater(drop_replies={0, 1, 2})
        with self.assertRaises(TimeoutError):
            Updater(device, retries=3).version()

    def test_baud_change_is_not_retried(self):
        device = FakeUpdater(drop_replies={0})
        with self.assertRaises(TimeoutError):
            Updater(device).set_baud(115200, lambda baud: None)
        self.assertEqual(len(device.requests), 1)

    def test_detects_bootstrap_echo(self):
        with self.assertRaises(BootstrapModeError):
            Updater(BootstrapEcho()).status()

    def test_unexpected_reply_is_an_error(self):
        device = FakeUpdater()
        device.handle = lambda req: bytes([req[0] + 2])  # device says "error"
        with self.assertRaises(UpdaterError):
            Updater(device).flash_size()


class SafetyTest(unittest.TestCase):
    def test_full_session_sends_only_read_only_commands(self):
        device = FakeUpdater()
        updater = Updater(device)
        updater.status()
        updater.set_baud(115200, lambda baud: None)
        updater.info()
        updater.read_range(0x400000, 4096)
        self.assertLessEqual({r[0] for r in device.requests}, READ_ONLY_OPS)


class SerialTransportTest(unittest.TestCase):
    def test_dump_through_real_framer(self):
        device = FakeUpdater()
        port = FakeSerialPort(device, read_size=3)
        updater = Updater(SerialTransport(port))
        updater.status()
        updater.set_baud(115200, SerialTransport(port).set_baud)
        self.assertEqual(port.baudrate, 115200)
        self.assertEqual(device.baud, 115200)
        self.assertEqual(updater.read_range(0x41FFF0, 100), bytes(device.flash[0x1FFF0:0x20054]))


class UsbTransportTest(unittest.TestCase):
    def test_session_over_packets(self):
        device = FakeUpdater()
        bus = FakeUsbBus(device, stray_zlp=True)
        updater = Updater(UsbTransport(bus.write, bus.read, close=lambda: None))
        self.assertEqual(updater.info().machine_id, 2)
        self.assertEqual(updater.read_range(0x400000, 200), bytes(device.flash[:200]))
        self.assertTrue(all(len(p) <= 8 for p in bus.out_packets))


if __name__ == "__main__":
    unittest.main()
