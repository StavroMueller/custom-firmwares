import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFirmware } from "../v500/firmware.js";
import { decodeBuiltIn, firmwareFile, withFirmware } from "../selfcopy.js";

test("a page copy carries the firmware, once, and gives it back intact", () => {
  const file = new Uint8Array(0x10100).map((_, i) => (i * 7) & 0xff);
  file.set([0x45, 0x44, 0x4c, 0x41]);
  const fw = parseFirmware(file.buffer);
  const page = "<!doctype html><html><body><p>hi</p></body></html>";
  const once = withFirmware(page, firmwareFile(fw));
  const twice = withFirmware(once, firmwareFile(fw));
  assert.equal(twice, once); // copying a copy doesn't stack firmware
  const text = once.match(/<script id="v500-firmware"[^>]*>([^<]*)</)[1];
  // the real page holds this code too: copying it must not touch the code
  const self = `<html><body><script type="module">const x = "<script id=\\"v500-" + "firmware\\"";<\/script></body></html>`;
  assert.ok(withFirmware(self, firmwareFile(fw)).startsWith(self.slice(0, self.lastIndexOf("</body>"))));
  const back = parseFirmware(decodeBuiltIn(text).buffer);
  assert.deepEqual(back.body, fw.body);
  assert.equal(back.checksum, fw.checksum);
});
