// Firmware extraction from a synthetic bundle: tar.gz > .deb (ar) > data.tar.gz.
import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";

import { findFirmware } from "../v500/bundle.js";

function tar(files) {
  const parts = [];
  for (const [name, data] of files) {
    const h = Buffer.alloc(512);
    h.write(name, 0);
    h.write(data.length.toString(8).padStart(11, "0"), 124);
    h.write("0", 156);
    h.write("ustar", 257);
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}

function ar(members) {
  const parts = [Buffer.from("!<arch>\n")];
  for (const [name, data] of members) {
    const h = Buffer.alloc(60, " ");
    h.write(name + "/", 0);
    h.write(String(data.length), 48);
    h.write("`\n", 58);
    parts.push(h, data, data.length % 2 ? Buffer.from("\n") : Buffer.alloc(0));
  }
  return Buffer.concat(parts);
}

const firmware = Buffer.concat([Buffer.from("EDLA"), Buffer.alloc(100, 7)]);

test("firmware comes out of Epson's bundle, the plugin .deb, or itself", async () => {
  const deb = ar([["debian-binary", Buffer.from("2.0\n")], ["control.tar.gz", gzipSync(tar([]))],
    ["data.tar.gz", gzipSync(tar([["./usr/share/iscan/esfw7C.bin", firmware]]))]]);
  const bundle = gzipSync(tar([["iscan-gt-x770-bundle/README.rst", Buffer.from("hi")],
    ["iscan-gt-x770-bundle/plugins/iscan-plugin-gt-x770_2.1.3-1_amd64.deb", deb]]));
  for (const input of [bundle, deb, firmware]) assert.deepEqual(Buffer.from(await findFirmware(input)), firmware);
  await assert.rejects(findFirmware(Buffer.from("hello")), /pick Epson's driver bundle/);
});
