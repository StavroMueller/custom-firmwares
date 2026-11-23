// The built-in sequence against captures of Epson's driver (skipped without them).
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { u16, u32 } from "../v500/bytes.js";
import { build, gammaTable, ramp } from "../v500/protocol.js";
import { CMD, params, POLL_READY, STATUS, Template } from "../v500/replay.js";

const CAPTURES = join(import.meta.dirname, "../../captures");
const files = existsSync(CAPTURES)
  ? readdirSync(CAPTURES).flatMap((d) => readdirSync(join(CAPTURES, d)).filter((f) => /^0[2-6].*\.usblog$/.test(f)).map((f) => join(CAPTURES, d, f)))
  : [];

function load(path) {
  const b = readFileSync(path);
  return Template.fromUsblog(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), path);
}

// commands with consecutive polls collapsed, as the replayer runs them
function sequence(t) {
  const out = [];
  for (const g of t.groups) {
    if ((g.command === POLL_READY || g.command === STATUS) && out.at(-1)?.command === g.command) continue;
    out.push(g);
  }
  return out;
}

const reads = (g) => g.steps.filter((s) => !s.out).map((s) => s.requested);

test("gamma and ramps match Epson's tables", { skip: !files.length }, () => {
  const t = load(files.find((f) => f.includes("03-color-200")) ?? files[0]);
  const tables = t.groups.filter((g) => g.command === CMD.TABLE);
  const g02 = new Uint16Array(params(tables.find((g) => params(g)[0][0] === 2))[1].slice().buffer);
  assert.deepEqual(g02, gammaTable(1.8));
  const ramps = tables.filter((g) => params(g)[0][0] === 5).map((g) => new Uint16Array(params(g)[1].slice().buffer));
  const move = ramp({ start: 2500, cruise: 160, n: 512 });
  const close = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 4);
  assert.ok(ramps.some((r) => close(r, move)), "move ramp");
});

for (const path of files) {
  test(`built from scratch: ${path.split("/").slice(-2).join("/")}`, () => {
    const epson = load(path);
    const p = params(epson.groups.find((g) => g.command === CMD.PARAMS))[0];
    const area = { x: u32(p, 8), y: u32(p, 12), width: u32(p, 16), height: u32(p, 20) };
    const ours = build(epson.yres, area, { grey: epson.grey });
    const a = sequence(ours), b = sequence(epson);
    assert.deepEqual(a.map((g) => g.command), b.map((g) => g.command), "command order");
    const counts = new Map();
    a.forEach((g, i) => {
      const e = b[i];
      const n = counts.get(g.command) ?? 0;
      counts.set(g.command, n + 1);
      const name = `${g.command.toString(16)} #${n}`;
      if (g.command === CMD.READ) return assert.deepEqual(reads(g), reads(e), `${name} read sizes`);
      const [gp, ep] = [params(g), params(e)];
      assert.equal(gp.length, ep.length, name);
      if (g.command === CMD.AFE && n > 0) return; // measured live
      if (g.command === CMD.LEVELS && (n === 1 || n === 3)) return; // computed live
      if (g.command === CMD.TABLE && ep[0][0] === 6) return assert.deepEqual(gp[0], ep[0], `${name} header`);
      if (g.command === CMD.TABLE && ep[0][0] === 5) {
        assert.deepEqual(gp[0].subarray(0, 5), ep[0].subarray(0, 5), `${name} header`);
        // the move ramp: Epson sends a shorter table for short moves; ours is one table
        if (gp[1].length !== ep[1].length) return;
        const x = new Uint16Array(gp[1].slice().buffer), y = new Uint16Array(ep[1].slice().buffer);
        return assert.ok(x.every((v, i) => Math.abs(v - y[i]) <= 4), `${name} ramp`);
      }
      if (g.command === CMD.MOVE && n === 1) {
        // the move to the area: same distance, maybe a different ramp length
        const dist = (m) => u32(m, 0) + 2 * (u16(m, 6) + 1);
        return assert.equal(dist(gp[0]), dist(ep[0]), `${name} distance`);
      }
      if (g.command === CMD.WINDOW) {
        const [x, y] = [gp[0].slice(), ep[0].slice()];
        for (const q of [x, y]) q[11] = q[15] = 0; // packing: computed live
        assert.ok(Math.abs(u16(x, 0) - u16(y, 0)) <= 3, `${name} start`); // Epson's own rounding at 200 dpi
        for (const q of [x, y]) q.fill(0, 0, 4);
        return assert.deepEqual(x, y, name);
      }
      gp.forEach((d, j) => assert.deepEqual(d, ep[j], `${name} block ${j}`));
    });
  });
}
