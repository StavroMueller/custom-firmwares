// Run the JS driver on a capture against a simulated scanner and print what it
// did, for tests/test_web.py to compare with the Python driver.
//
//   node web/tools/parity.mjs <capture.usblog> [x y width height]
//
// Without an area: replays the template against its own recorded replies.
// With an area (px): retargets it and runs against the geometry fake.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { retarget } from "../v500/geometry.js";
import { Replayer, Template } from "../v500/replay.js";
import { GeometryScanner, TemplateScanner } from "../test/fakes.js";

const [path, ...area] = process.argv.slice(2);
const buf = readFileSync(path);
let t = Template.fromUsblog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path);
let dev;
if (area.length) {
  const [x, y, width, height] = area.map(Number);
  t = retarget(t, { x, y, width, height });
  dev = new GeometryScanner();
} else {
  dev = new TemplateScanner(t);
}
const r = new Replayer(t, dev, { sleep: async () => {} });
const image = await r.run();

const hash = createHash("sha256");
for (const w of dev.writes) {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(w.length);
  hash.update(len).update(w);
}
const c = r.cal;
console.log(JSON.stringify({
  writes: hash.digest("hex"),
  count: dev.writes.length,
  image: createHash("sha256").update(image.data).digest("hex"),
  shape: [image.height, image.width, image.channels],
  calibration: { white: c.whiteMin, dark: c.darkMin, k: c.k, h: c.h, d: c.d },
}));
