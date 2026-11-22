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
