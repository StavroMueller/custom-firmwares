// Reusing measured analog levels skips the scanner's self-measurement.
import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "../v500/protocol.js";
import { Replayer } from "../v500/replay.js";
import { GeometryScanner } from "./fakes.js";

const area = { x: 100, y: 200, width: 384, height: 20 };

async function scan(levels) {
  const dev = new GeometryScanner();
  const r = new Replayer(build(200, area), dev, { sleep: async () => {}, levels });
  const img = await r.run();
  return { dev, r, img };
}

test("a scan with reused levels skips the measurement and sends them", async () => {
  const fresh = await scan(null);
  assert.equal(fresh.dev.sent(0x1e46).length, 2); // measured twice
  const levels = Uint8Array.from([0x88, 0, 0x88, 0, 0x8e, 0, 0, 0, 0x35, 0x31, 0x34, 0]);
  const reused = await scan(levels);
  assert.equal(reused.dev.sent(0x1e46).length, 0);
  assert.deepEqual(reused.dev.sent(0x1e31).at(-1), levels);
  assert.deepEqual(reused.img.data, fresh.img.data);
  // the constant type 07 table goes with the measurement
  const type07 = (dev) => dev.sent(0x1e84).filter((d) => d.length === 8 && d[0] === 0x07).length;
  assert.equal(type07(fresh.dev), 1);
  assert.equal(type07(reused.dev), 0);
});

test("stopping a scan mid-image aborts it on the scanner", async () => {
  const dev = new GeometryScanner();
  const ac = new AbortController();
  const r = new Replayer(build(200, { x: 0, y: 0, width: 384, height: 200 }), dev, {
    sleep: async () => {}, signal: ac.signal, onRows: () => ac.abort(),
  });
  await assert.rejects(r.run(), { name: "AbortError" });
  const last = dev.writes.map((w) => Buffer.from(w).toString("hex"));
  assert.ok(last.includes("1e18"), "sent 1e 18");
  assert.equal(last.at(-1), "1b03"); // then waited for idle
});

test("1600 dpi: 1.5 motor steps per line, 48 px probe", async () => {
  const dev = new GeometryScanner();
  const area = { x: 100, y: 101, width: 640, height: 33 };
  const img = await new Replayer(build(1600, area), dev, { sleep: async () => {} }).run();
  assert.deepEqual([img.width, img.height], [640, 33]);
  const move = dev.sent(0x1e01).at(-1);
  assert.equal(new DataView(move.buffer).getUint32(0, true), Math.ceil((33 + 80) * 1.5) + 30);
  const probe = dev.sent(0x1e41)[0];
  assert.deepEqual([...probe.subarray(0, 4)], [61, 0, 109, 0]);
});

test("reusing a calibration skips the reference reads and the lamp off/on", async () => {
  const area = { x: 100, y: 200, width: 384, height: 20 };
  const first = new GeometryScanner();
  const r1 = new Replayer(build(200, area), first, { sleep: async () => {} });
  const img1 = await r1.run();
  const second = new GeometryScanner();
  const r2 = new Replayer(build(200, area), second, { sleep: async () => {}, levels: r1.afe, calibration: r1.calibration });
  const img2 = await r2.run();
  const count = (dev, hex) => dev.writes.filter((w) => Buffer.from(w).toString("hex") === hex).length;
  assert.equal(count(first, "1e47"), 4);
  assert.equal(count(second, "1e47"), 1); // only the image
  assert.equal(count(second, "1ea2"), 1); // lamp on once; never off
  const steps = (dev) => dev.sent(0x1e01).map((m) => new DataView(m.buffer).getUint32(0, true));
  assert.equal(steps(second).length, 2); // no 51-step move to the white reference
  assert.equal(steps(second)[0], steps(first)[1] + 51); // so the move to the area goes 51 further
  assert.deepEqual(second.sent(0x1e42).at(-1), first.sent(0x1e42).at(-1));
  assert.deepEqual(img2.data, img1.data);
  // a different window can't reuse it
  const r3 = new Replayer(build(200, { ...area, width: 800 }), new GeometryScanner(), { sleep: async () => {}, calibration: r1.calibration });
  assert.equal(r3.reuseCal, null);
});
