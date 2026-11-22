// The whole command sequence for a scan, built from scratch: no capture of
// Epson's driver needed. (See PROTOCOL.md, "Building a scan without a template".)
//
// It is the sequence Epson's driver sends, with every table computed:
// - gamma (`1e 84` type 02): floor(65535 x (x / 4095)^(1/1.8)) >> 4, exact;
// - motor ramps (type 05): an interval going from `start` to `cruise` over
//   n steps as start / sqrt(1 + a i), a = ((start / cruise)^2 - 1) / (n - 1),
//   within 4 timer ticks of Epson's;
// - and a few per-resolution constants measured from captures.
// The area is then set by retarget() (geometry.js), the same code that
// retargets captured templates.

import { setU16, setU32 } from "./bytes.js";
import { retarget, scanSteps } from "./geometry.js";
import { lineShift } from "./raw.js";
import { CMD, POLL_READY, STATUS, Template } from "./replay.js";

const ACK = new Uint8Array([0x06]);

// Per-resolution constants: 200-800 measured from captures of Epson's driver
// (and matching Epson's tables), 1600 from the plugin's tables and formulas
// alone (static analysis: PROTOCOL.md, "Where the settings come from").
// lines: the line rate as lo/hi of 2400 steps per inch (1600 dpi: 2/3).
export const RESOLUTIONS = {
  200: { lines: [1, 12], timing: 0x0f00, afe: 4, probe: [0x15, 0x25], imageMode: 0x1b1, slowSpeed: 160,
         scanRamp: { start: 2500, cruise: 320, n: 512 }, scanRampUsed: 512, scanTail: 120, scanFlags: 0,
         ratio: 8 / 3, origin: 143, toTop: 706 },
  400: { lines: [1, 6], timing: 0x0cc0, afe: 4, probe: [0x15, 0x25], imageMode: 0x1a1, slowSpeed: 136,
         scanRamp: { start: 1249, cruise: 272, n: 512 }, scanRampUsed: 256, scanTail: 126, scanFlags: 2,
         ratio: 4 / 3, origin: 143, toTop: 956 },
  800: { lines: [1, 3], timing: 0x1500, afe: 3, probe: [0x20, 0x30], imageMode: 0x101, slowSpeed: 224,
         scanSpeed: 112, scanRampUsed: 0, scanTail: 126, scanFlags: 8,
         ratio: 1, origin: 213, toTop: 1212 },
  // Not yet checked against a capture. The origin is the plugin's 431 less
  // the 1-2 units our captures show at the other resolutions (doubled).
  1600: { lines: [2, 3], timing: 0x2a60, afe: 2, probe: [61, 109], imageMode: 0x0201, slowSpeed: 452,
          scanSpeed: 452, scanRampUsed: 0, scanTail: 30, scanFlags: 8,
          ratio: 1, origin: 427, toTop: 1308 },
};
export const MOVE_RAMP = { start: 2500, cruise: 160, n: 512 }; // the move to the top of the area
const SETTLE = new Uint8Array([0x00, 0x80, 0x00, 0x80, 0x00, 0x80, 0x84, 0x7d, 0x77, 0x7e, 0xdf, 0x7f]); // 1e 43
const SETTLE_SCAN = new Uint8Array([0x84, 0x7d, 0x77, 0x7e, 0xdf, 0x7f, 0x84, 0x7d, 0x77, 0x7e, 0xdf, 0x7f]);
// `1e 84` type 07: unknown purpose, constant in every capture. u16 pairs, then 0xff.
const TYPE07 = [0, 0, 40, 0x31c0, 200, 0x31c0, 400, 0x1000];

export function gammaTable(gamma = 1.8) {
  const out = new Uint16Array(4096);
  for (let x = 0; x < 4096; x++) out[x] = Math.floor(65535 * (x / 4095) ** (1 / gamma)) >> 4;
  return out;
}

export function ramp({ start, cruise, n }) {
  const a = ((start / cruise) ** 2 - 1) / (n - 1);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(cruise, Math.floor(start / Math.sqrt(1 + a * i)));
  return out;
}

// ---- building blocks ----

const u8 = (arr) => new Uint8Array(arr);
const bytesOf = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength).slice();
const step = (out, data, requested = data.length) => ({ out, requested, data });
const ack = () => step(false, ACK, 1);

function block(length, fields = []) {
  const b = new Uint8Array(length);
  for (const [offset, size, value] of fields) {
    if (size === 1) b[offset] = value;
    else if (size === 2) setU16(b, offset, value);
    else setU32(b, offset, value);
  }
  return b;
}

function tableHeader(prefix, length) {
  return u8([...prefix, length & 0xff, (length >> 8) & 0xff, (length >> 16) & 0xff]);
}

class Builder {
  constructor() {
    this.groups = [];
  }
  cmd(id, ...steps) {
    this.groups.push({ command: id, steps });
    return this;
  }
  query(id, size) {
    return this.cmd(id, step(false, new Uint8Array(0), size));
  }
  status() {
    return this.query(STATUS, 2);
  }
  set(id, data) {
    return this.cmd(id, ack(), step(true, data), ack());
  }
  table(prefix, data) {
    return this.cmd(CMD.TABLE, ack(), step(true, tableHeader(prefix, data.length)), step(true, data), ack());
  }
  read(sizes) {
    return this.cmd(CMD.READ, ...sizes.map((s) => step(false, new Uint8Array(0), s)));
  }
}

// ---- the sequence ----

// A base template for `dpi`: a one-line, 384 px scan at the top left. Use
// build() for a real area.
function base(dpi, { grey = false, gamma = 1.8 } = {}) {
  const r = RESOLUTIONS[dpi];
  if (!r) throw new Error(`no settings for ${dpi} dpi yet; have ${Object.keys(RESOLUTIONS).join(", ")}`);
  const [lo, hi] = r.lines;
  const probeWidth = r.probe[1] - r.probe[0];
  const width = 384, height = 1, extra = Math.max(...lineShift(dpi));
  const lines = height + extra;
  const window = Math.round(width * r.ratio);
  const start = r.origin, end = start + window;
  const perBlock = Math.min(255, Math.floor(51200 / (width * 3)));
  const b = new Builder();

  // open the session the way Epson's frontend does: status, parameters,
  // identity, and twice a reset (1b 40)
  const opening = { 0x1b03: 2, 0x1e53: 42, 0x1e65: 1, 0x1b13: 28 };
  for (const id of [0x1b03, 0x1e53, 0x1b03, 0x1e65, 0x1b13, 0x1b03, 0x1e53, 0x1b03, 0x1e65, 0x1b13, 0x1b03, 0x1b40,
    0x1e53, 0x1b03, 0x1e65, 0x1b13, 0x1b03, 0x1b40, 0x1e53, 0x1b03, 0x1e65, 0x1b13, 0x1b03, 0x1e65, 0x1b13]) {
    if (id === 0x1b40) b.cmd(id, ack());
    else b.query(id, opening[id]);
  }

  // identity lookup tables, one per colour
  const identity = u8(Array.from({ length: 256 }, (_, i) => i));
  for (const addr of [0xfc, 0xfd, 0xfe]) b.table([0x03, 0x00, addr, 0x1f, 0x02], identity);
  b.status().query(0x1e65, 1).query(0x1b13, 28).query(0x1e53, 42);

  // scan parameters
  const mode = grey ? 0x800 : 0x813;
  b.set(CMD.PARAMS, block(42, [[0, 4, dpi], [4, 4, dpi], [16, 4, width], [20, 4, height],
    [24, 4, mode], [28, 1, 0], [29, 1, 4], [32, 4, 0x8000]]));

  // lamp on, sensor state
  b.status().query(0x1ea1, 1).set(0x1ea2, u8([1])).status();
  b.cmd(0x1e87, ack(), step(true, u8([0])), step(false, new Uint8Array(0), 10));
  b.query(0x1e86, 4);

  // analog front end: let the scanner measure its levels, twice, then keep them
  const levels = block(12, [[0, 1, r.afe], [2, 2, r.timing]]);
  b.set(CMD.AFE, u8([0x80, 0, 0x80, 0, 0x80, 0, 0, 0, 0, 0, 0, 0]));
  b.set(0x1e46, levels).query(POLL_READY, 1).query(CMD.AFE_READ, 12);
  b.set(0x1e46, levels).query(POLL_READY, 1).query(CMD.AFE_READ, 12);
  b.set(0x1e11, u8([r.afe])).set(CMD.AFE, new Uint8Array(12)); // 1e 31: the measured levels, at run time

  // sensor setup and the dark probe
  b.set(0x1e21, block(26, [[0, 2, r.timing]]));
  const t07 = new Uint8Array(256).fill(0xff);
  TYPE07.forEach((v, i) => setU16(t07, i * 2, v));
  b.cmd(CMD.TABLE, ack(), step(true, u8([0x07, 0, 0, 0, 0, 0, 1, 0])), step(true, t07), ack());
  const timing = (darkFlag = 0) => block(12, [[0, 2, r.timing], [9, 1, darkFlag]]);
  b.set(0x1e22, timing());
  b.set(CMD.WINDOW, block(22, [[0, 2, r.probe[0]], [2, 2, r.probe[1]], [4, 2, 4], [9, 1, lo], [10, 1, hi], [16, 1, 0x80], [18, 1, 4]]));
  b.set(CMD.LEVELS, new Uint8Array(18)).set(0x1e43, SETTLE).status();
  b.read([probeWidth * 4 * 6 + 8]).status();

  // white reference: 32 lines, 51 steps into the bed, with the probe's offsets
  b.set(0x1e22, timing());
  b.set(CMD.WINDOW, block(22, [[0, 2, start], [2, 2, end], [4, 2, 32], [9, 1, 2], [10, 1, 3], [11, 1, 0x40], [16, 1, 0x80], [17, 1, 0x80], [18, 1, 32]]));
  b.set(CMD.LEVELS, new Uint8Array(18)).set(0x1e43, SETTLE); // 1e 42: probe offsets, at run time
  b.table([0x05, 0x00, 0x00, 0x01, 0x02], bytesOf(new Uint16Array([r.slowSpeed])));
  b.set(CMD.MOVE, block(12, [[0, 4, 51], [4, 2, 3], [10, 2, 8]])).status();
  b.read([]).status(); // sizes set by retarget()

  // dark reference: lamp off, 16 lines
  b.set(0x1ea2, u8([0])).set(0x1e22, timing(1));
  const dark = block(22, [[0, 2, start], [2, 2, end], [4, 2, 16], [9, 1, lo], [10, 1, hi], [16, 1, 0x80], [18, 1, 16]]);
  b.set(CMD.WINDOW, dark).set(CMD.LEVELS, new Uint8Array(18)).set(0x1e43, SETTLE).set(CMD.WINDOW, dark.slice()).status();
  b.read([]).status();

  // lamp on, tone curves, move to the top of the area
  b.set(0x1ea2, u8([1])).query(0x1e86, 4);
  const g = bytesOf(gammaTable(gamma));
  for (const addr of [0x00, 0x20, 0x40]) b.cmd(CMD.TABLE, ack(), step(true, u8([0x02, 0x00, addr, 0x38, 0x00, 0x00, 0x20, 0x00])), step(true, g), ack());
  b.table([0x05, 0x00, 0x00, 0x01, 0x02], bytesOf(ramp(MOVE_RAMP)));
  const n = 256;
  b.set(CMD.MOVE, block(12, [[0, 4, r.toTop - 2 * n], [6, 2, n - 1], [8, 2, n - 1], [10, 2, 0x10]]));
  b.cmd(0x1e05, ack()).status();

  // the image pass
  b.set(0x1e22, timing());
  b.set(CMD.WINDOW, block(22, [[0, 2, start], [2, 2, end], [4, 2, lines], [8, 2, r.imageMode], [10, 1, hi],
    [11, 1, 0x80], [12, 1, 0x80], [16, 1, 0x80], [17, 1, 0xa0], [18, 1, perBlock]])); // 11 and 15: at run time
  b.set(CMD.LEVELS, new Uint8Array(18)).set(0x1e43, SETTLE_SCAN); // 1e 42: calibration, at run time
  b.table([0x06, 0x00, 0x08, 0x01, 0x02], new Uint8Array(window * 6)); // shading: at run time
  const scanTable = r.scanRamp ? bytesOf(ramp(r.scanRamp)) : bytesOf(new Uint16Array([r.scanSpeed]));
  b.table([0x05, 0x00, 0x00, 0x01, 0x02], scanTable);
  const used = r.scanRampUsed ? r.scanRampUsed - 1 : 0;
  b.set(CMD.MOVE, block(12, [[0, 4, scanSteps(lines, dpi) + r.scanTail], [4, 2, r.scanTail], [6, 2, used], [8, 2, used], [10, 2, r.scanFlags]]));
  b.status().read([]);

  return new Template({
    name: `built-in ${dpi} dpi`, groups: b.groups, xres: dpi, yres: dpi, width, height, mode, grey, deep: false,
    windows: [probeWidth, window, window, window], used: new Uint8Array(window).fill(1), imageRawWidth: width,
  });
}

// The command sequence for scanning `area` (pixels, geometry.js region) at `dpi`.
export function build(dpi, area, options = {}) {
  return retarget(base(dpi, options), area);
}

export const SUPPORTED = Object.keys(RESOLUTIONS).map(Number);
