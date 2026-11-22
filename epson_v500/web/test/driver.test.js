// Unit tests for the JS driver that need no captures: node --test web/test/
import assert from "node:assert/strict";
import { test } from "node:test";

import * as calibration from "../v500/calibration.js";
import { parseFirmware, upload } from "../v500/firmware.js";
import { fromMm, fullBed } from "../v500/geometry.js";
import { blocks, decode, lineShift, StreamDecoder } from "../v500/raw.js";

const trailer = (n) => [0x02, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, 0, 0x80, 0];

test("blocks are split by their trailers, even across reads", () => {
  const a = [1, 2, 3], b = [4, 5];
  const all = new Uint8Array([...a, ...trailer(3), ...b, ...trailer(2)]);
  const got = blocks([all.subarray(0, 5), all.subarray(5)]);
  assert.deepEqual(got.map((x) => [...x]), [a, b]);
});

test("line shift and colour decode", () => {
  assert.deepEqual(lineShift(200), [10, 5, 0]);
  assert.deepEqual(lineShift(800), [40, 20, 0]);
  // 1 px wide, 2 rows: grey 100 everywhere stays 100 through the matrix (rows sum to 1)
  const lines = 2 + 10;
  const data = new Uint8Array(lines * 3).fill(100);
  const img = decode(data, 1, 2, { dpi: 200 });
  assert.deepEqual([...img.data], [100, 100, 100, 100, 100, 100]); // exact: rows of the matrix sum to 1
});

test("streaming decode gives the same rows as a whole decode", () => {
  const width = 4, height = 7, rawWidth = 5, lines = height + 10;
  const data = new Uint8Array(lines * rawWidth * 3).map((_, i) => (i * 37) % 256);
  const whole = decode(data, width, height, { dpi: 200 });
  const dec = new StreamDecoder({ rawWidth, width, height, dpi: 200 });
  const out = new Uint8Array(width * height * 3);
  for (let pos = 0; pos < data.length; pos += 17) {
    const { top, data: rows } = dec.push(data.subarray(pos, pos + 17));
    out.set(rows, top * width * 3);
  }
  assert.ok(dec.complete);
  assert.deepEqual(out, whole.data);
});

test("flat dark leaves 5 bits for dark; white shift is the smallest that fits", () => {
  const W = 10;
  const white = new Uint16Array(32 * W * 3), dark = new Uint16Array(16 * W * 3);
  for (let l = 0; l < 32; l++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) white[(l * W + x) * 3 + c] = 20000 + x * 3500;
  const cal = calibration.compute(white, dark, W, new Uint8Array(W).fill(1));
  assert.equal(cal.k, 3);
  assert.equal(cal.h, 4); // range 31,500 < 2^11 << 4
  assert.deepEqual(cal.windowBytes(), [0x83, 0x40]);
  assert.deepEqual([...new Uint16Array(cal.param1e42().buffer)], [20000, 20000, 20000, 0, 0, 0, 0, 0, 0]);
});

test("mm to pixels matches Epson's rounding", () => {
  assert.deepEqual(fromMm(200, 20, 30, 60, 40), { x: 157, y: 236, width: 472, height: 314 });
  assert.deepEqual(fullBed(200), { x: 0, y: 0, width: 1696, height: 2339 });
  assert.deepEqual(fromMm(400, 20, 30, 60, 40), { x: 315, y: 472, width: 944, height: 629 });
  assert.deepEqual(fromMm(800, 20, 30, 60, 40), { x: 630, y: 945, width: 1888, height: 1259 });
});

test("firmware upload talks the protocol", async () => {
  const file = new Uint8Array(0x10100);
  file.set([0x45, 0x44, 0x4c, 0x41]); // EDLA
  file.set([1, 0, 1, 0], 0x4c);
  file[0x100] = 5;
  file[0x101] = 7;
  const fw = parseFirmware(file.buffer);
  assert.equal(fw.checksum, 12);
  const writes = [];
  let loaded = false;
  const io = {
    async write(d) {
      writes.push([...d]);
      if (d.length === 1 && d[0] === 0x80) loaded = true;
    },
    async read(n) {
      const last = writes.at(-1);
      if (last.length === 2 && last[0] === 0x1b && last[1] === 0x03) return new Uint8Array([loaded ? 0x18 : 0x08, 0]);
      return new Uint8Array([0x06]);
    },
  };
  assert.equal(await upload(fw, io), true);
  assert.deepEqual(writes.slice(1, 3), [[0x1b, 0x06], [1, 0, 1, 0]]);
  assert.equal(writes[3].length, 0x10000);
  assert.deepEqual(writes.slice(4, 7), [[12], [0x1b, 0x16], [0x80]]);
  assert.equal(await upload(fw, io), false); // already running
});
