import contextlib
import hashlib
import io
import os
import tempfile
import unittest
from unittest import mock

from as3k import cli
from as3k.protocol import Updater

from .fake_device import FakeUpdater, make_flash


class FakeTransport(FakeUpdater):
    def close(self) -> None:
        pass


def run(argv, device=None):
    device = device or FakeTransport()
    stdout, stderr = io.StringIO(), io.StringIO()
    with mock.patch.object(cli, "connect", return_value=(Updater(device), device)), \
            contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
        code = cli.main(argv)
    return code, stdout.getvalue(), stderr.getvalue()


class CliTest(unittest.TestCase):
    def test_info(self):
        code, out, _ = run(["--usb", "info"])
        self.assertEqual(code, 0)
        self.assertIn("Intel 28F008B3", out)
        self.assertIn("machine id      : 02", out)

    def test_dump_writes_whole_flash(self):
        device = FakeTransport(make_flash(0x80000, machine_id=1))
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "flash.bin")
            code, out, _ = run(["--usb", "dump", out_path, "--verify"], device)
            self.assertEqual(code, 0)
            with open(out_path, "rb") as f:
                data = f.read()
        self.assertEqual(data, bytes(device.flash))
        self.assertIn(hashlib.sha256(data).hexdigest(), out)

    def test_dump_outside_flash_needs_length(self):
        code, _, err = run(["--usb", "dump", "x.bin", "--start", "0x1000"])
        self.assertEqual(code, 1)
        self.assertIn("--length", err)

    def test_missing_library_gives_install_hint(self):
        stderr = io.StringIO()
        missing = ModuleNotFoundError("No module named 'usb'", name="usb")
        with mock.patch.object(cli, "connect", side_effect=missing), \
                contextlib.redirect_stderr(stderr):
            self.assertEqual(cli.main(["--usb", "info"]), 1)
        self.assertIn("pip install -r requirements.txt", stderr.getvalue())

    def test_needs_a_link(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["info"]), 2)

    def test_usb_switch_refuses_without_confirmation(self):
        with mock.patch.object(cli, "switch_keyboard_to_updater") as switch, \
                contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(cli.main(["usb-switch"]), 2)
        switch.assert_not_called()

    def test_usb_switch_with_confirmation(self):
        with mock.patch.object(cli, "switch_keyboard_to_updater") as switch, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(["usb-switch", "--files-saved"]), 0)
        switch.assert_called_once()


if __name__ == "__main__":
    unittest.main()
