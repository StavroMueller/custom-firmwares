import { test } from "node:test";
import assert from "node:assert/strict";
import { position, ready } from "../v500/device.js";

// A scanner that answers status, position, abort and home from a script.
function fakeScanner({ busyFor = 0, at = 0, stuck = false, deaf = false }) {
  const sent = [];
  let polls = 0, pending = [];
  return {
    sent,
    async write(d) {
      const cmd = Array.from(d).map((b) => b.toString(16).padStart(2, "0")).join(" ");
      sent.push(cmd);
      if (cmd === "1b 03") {
        const busy = stuck || polls++ < busyFor;
        pending.push([busy ? 0x58 : 0x18, 0x81]);
      } else if (cmd === "1e 86") { if (!deaf) pending.push([at & 0xff, at >> 8, 0, 0]); }
      else if (cmd === "1e 18") { stuck = deaf = false; pending.push([0x06]); }
      else if (cmd === "1e fa") { at = 0; pending.push([0x06]); }
    },
    async read() {
      if (!pending.length) throw new Error("read timed out");
      return new Uint8Array(pending.shift());
    },
  };
}
const sleep = async () => {};

test("position decodes a u32", async () => {
  assert.equal(await position(fakeScanner({ at: 0x1234 })), 0x1234);
});

test("ready waits out the drive home without calling it stuck", async () => {
  const s = fakeScanner({ busyFor: 5 });
  await ready(s, { sleep });
  assert.ok(!s.sent.includes("1e 18"), "no abort for a scanner that's just homing");
});

test("ready aborts a scan that never finished, then re-homes", async () => {
  const s = fakeScanner({ stuck: true, at: 51 });
  await ready(s, { sleep, settleMs: 0 });
  assert.ok(s.sent.includes("1e 18"));
  assert.ok(s.sent.includes("1e fa"));
});

test("ready leaves a homed scanner alone", async () => {
  const s = fakeScanner({});
  await ready(s, { sleep });
  assert.deepEqual(s.sent, ["1b 03", "1e 86"]);
});

test("ready frees a scanner that reports idle but ignores motor commands", async () => {
  const s = fakeScanner({ deaf: true });
  await ready(s, { sleep });
  assert.deepEqual(s.sent, ["1b 03", "1e 86", "1e 18", "1b 03", "1e 86"]);
});
