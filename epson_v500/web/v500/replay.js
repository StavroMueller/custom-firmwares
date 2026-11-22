// Scan without Epson's plugin, by replaying a template (see v500/replay.py).
//
// A template is a capture of Epson's driver making one scan. We send the same
// commands in the same order, with the calibration computed live: the analog
// levels (`1e 31` <- `1e 92`), the probe offsets (second `1e 42`), the white
// and dark minimums (last `1e 42`), the shading table (`1e 84` type 06) and
// how it is packed (image-pass `1e 41` bytes 11 and 15). Status polls are
// polled properly instead of replayed.

import { commandBytes, commandId, concat, hex, u16, u32 } from "./bytes.js";
import * as calibration from "./calibration.js";
import { lineShift, payload, StreamDecoder, TRAILER } from "./raw.js";
import { parseUsblog } from "./usblog.js";

export const POLL_READY = 0x1e04;
export const STATUS = 0x1b03;
export const BUSY = 0x40;
export const CMD = { MOVE: 0x1e01, AFE: 0x1e31, LEVELS: 0x1e42, WINDOW: 0x1e41, READ: 0x1e47, PARAMS: 0x1e57, AFE_READ: 0x1e92, TABLE: 0x1e84 };
const ACK = 0x06;

function isCommand(rec) {
  return rec.out && rec.data.length === 2 && (rec.data[0] === 0x1b || rec.data[0] === 0x1e);
}

// Commands with everything sent or read until the next command.
export function group(records) {
  const groups = [];
  for (const rec of records) {
    if (isCommand(rec)) groups.push({ command: commandId(rec.data), steps: [] });
    else if (groups.length) groups[groups.length - 1].steps.push({ out: rec.out, requested: rec.requested, data: rec.data });
  }
  return groups;
}

export const params = (g) => g.steps.filter((s) => s.out).map((s) => s.data);
export const replies = (g) => g.steps.filter((s) => !s.out).map((s) => s.data);
const dataReads = (g) => replies(g).filter((r) => !(r.length === 1 && r[0] === ACK));

export class Template {
  constructor(fields) {
    Object.assign(this, { cropX: 0 }, fields);
  }

  static fromUsblog(buffer, name = "template") {
    const groups = group(parseUsblog(buffer));
    const p57 = groups.find((g) => g.command === CMD.PARAMS);
    if (!p57) throw new Error(`${name}: no scan parameters (1e 57); is this a scan capture?`);
    const p = params(p57)[0];
    const [xres, yres, , , width, height, mode] = [0, 4, 8, 12, 16, 20, 24].map((o) => u32(p, o));
    const windows = [];
    let window = null, table = null;
    for (const g of groups) {
      if (g.command === CMD.WINDOW) window = u16(params(g)[0], 2) - u16(params(g)[0], 0);
      if (g.command === CMD.READ) windows.push(window);
      if (g.command === CMD.TABLE && params(g)[0][0] === 6) table = params(g)[1];
    }
    const reads = groups.filter((g) => g.command === CMD.READ).length;
    if (reads !== 4 || !table) throw new Error(`${name}: expected 4 data reads and a shading table, found ${reads}`);
    // pixels Epson's shading table filled
    const t16 = calibration.u16Samples(table);
    const used = new Uint8Array(t16.length / 3);
    for (let x = 0; x < used.length; x++) used[x] = Math.min(t16[x * 3], t16[x * 3 + 1], t16[x * 3 + 2]) > 0 ? 1 : 0;
    return new Template({ name, groups, xres, yres, width, height, mode, grey: mode === 0x800, deep: Boolean(mode & 0x1000), windows, used });
  }

  // Raw line width of the image pass, from the recorded data.
  rawWidth() {
    const reads = this.groups.filter((g) => g.command === CMD.READ);
    const lines = this.height + Math.max(...lineShift(this.yres));
    return payload(dataReads(reads[reads.length - 1])).length / (lines * 3);
  }
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

export class Replayer {
  // io: {write(Uint8Array), read(size) -> Uint8Array}, both async.
  // onRows({top, rows, data, width, channels}) is called as image rows decode.
  // levels: the analog levels a previous scan measured (its `afe`). With the
  // lamp warm, reusing them skips the scanner's 2.3 s self-measurement; the
  // white and dark references are still read fresh, so the image stays
  // calibrated.
  constructor(template, io, { sleep = sleepMs, log = () => {}, onRows = () => {}, onProgress = () => {},
    pollTimeoutMs = 60000, pollIntervalMs = 20, levels = null } = {}) {
    this.t = template;
    this.io = io;
    this.sleep = sleep;
    this.log = log;
    this.onRows = onRows;
    this.onProgress = onProgress;
    this.pollTimeoutMs = pollTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.reuseLevels = Boolean(levels);
    this.reads = [];
    this.afe = levels;
    this.probeOff = null;
    this.cal = null;
    this.count = new Map();
    this.imageWindow = template.groups.filter((g) => g.command === CMD.WINDOW).length - 1;
    this.totalReads = template.groups.filter((g) => g.command === CMD.READ).length;
  }

  async run() {
    const groups = this.t.groups;
    // the level measurement: from the first 1e 46 to the last 1e 92
    const measure = [groups.findIndex((g) => g.command === 0x1e46), groups.findLastIndex((g) => g.command === CMD.AFE_READ)];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (this.reuseLevels && measure[0] >= 0 && i >= measure[0] && i <= measure[1]) continue;
      if (g.command === POLL_READY || g.command === STATUS) {
        while (i + 1 < groups.length && groups[i + 1].command === g.command) i++;
        if (g.command === POLL_READY) await this.pollReady();
        else await this.waitNotBusy();
      } else {
        await this.replay(g);
      }
      this.onProgress(i + 1, groups.length);
    }
    return this.image;
  }

  async replay(g) {
    const n = this.count.get(g.command) ?? 0;
    this.count.set(g.command, n + 1);
    const isImage = g.command === CMD.READ && this.reads.length === this.totalReads - 1;
    if (isImage) this.startImage();
    await this.io.write(commandBytes(g.command));
    const sent = this.substitute(g, n);
    let p = 0;
    const got = [];
    for (const step of g.steps) {
      if (step.out) {
        await this.io.write(sent[p++]);
        continue;
      }
      const reply = await this.io.read(step.requested);
      if (reply.length !== step.requested) throw new Error(`${hex(commandBytes(g.command))}: read ${reply.length} of ${step.requested} bytes`);
      if (step.data.length === 1 && step.data[0] === ACK && !(reply.length === 1 && reply[0] === ACK)) {
        throw new Error(`${hex(commandBytes(g.command))}: scanner replied ${hex(reply)}, expected ACK`);
      }
      got.push(reply);
      if (isImage) this.imageBlock(reply);
    }
    this.after(g, n, got);
  }

  substitute(g, n) {
    const ps = params(g).map((x) => x.slice());
    if (g.command === CMD.AFE && n > 0) ps[0] = this.need(this.afe, "1e 92 reply");
    else if (g.command === CMD.LEVELS && n === 1) {
      const o = this.need(this.probeOff, "probe read");
      ps[0] = calibration.param1e42([0, 0, 0], o);
    } else if (g.command === CMD.LEVELS && n === 3) ps[0] = this.calibrate().param1e42();
    else if (g.command === CMD.TABLE && ps.length && ps[0][0] === 6) ps[1] = this.calibrate().tableBytes();
    else if (g.command === CMD.WINDOW && n === this.imageWindow) {
      const [b11, b15] = this.calibrate().windowBytes();
      ps[0][11] = b11;
      ps[0][15] = b15;
    }
    return ps;
  }

  after(g, n, got) {
    if (g.command === CMD.AFE_READ) this.afe = got[0];
    else if (g.command === CMD.READ) {
      const data = got.filter((r) => !(r.length === 1 && r[0] === ACK));
      this.reads.push(data);
      const k = this.reads.length - 1;
      this.log(`read ${k}: ${data.reduce((s, r) => s + r.length, 0)} bytes`);
      if (k === 0) this.probeOff = calibration.probeOffsets(calibration.u16Samples(payload(data)));
    }
  }

  // The image arrives one block per read; decode rows as soon as they're complete.
  startImage() {
    const t = this.t;
    const rawWidth = t.imageRawWidth ?? t.rawWidth(); // set by retarget(); else from the recording
    this.decoder = new StreamDecoder({ rawWidth, width: t.width, height: t.height, dpi: t.yres, grey: t.grey, cropX: t.cropX });
    this.image = { width: t.width, height: t.height, channels: this.decoder.channels, data: new Uint8Array(t.width * t.height * this.decoder.channels) };
    this.pendingImage = [];
  }

  imageBlock(reply) {
    // Each image read is one block plus its trailer; tolerate split blocks by
    // buffering until a trailer's length lines up.
    this.pendingImage.push(reply);
    const joined = this.pendingImage.length === 1 ? reply : concat(this.pendingImage);
    const t = joined.subarray(joined.length - TRAILER);
    const length = t[1] | (t[2] << 8) | (t[3] << 16);
    if (t[0] !== 0x02 || length !== joined.length - TRAILER) return;
    this.pendingImage = [];
    const { top, rows, data } = this.decoder.push(joined.subarray(0, length));
    if (!rows) return;
    const ch = this.decoder.channels;
    this.image.data.set(data, top * this.t.width * ch);
    this.onRows({ top, rows, data, width: this.t.width, channels: ch });
  }

  calibrate() {
    if (!this.cal) {
      if (this.reads.length < 3) throw new Error("calibration needed before the reference reads");
      const w = this.t.windows;
      const white = calibration.u16Samples(payload(this.reads[1]));
      const dark = calibration.u16Samples(payload(this.reads[2]));
      if (w[1] !== w[2]) throw new Error("white and dark reads have different windows");
      this.cal = calibration.compute(white, dark, w[1], this.t.used);
      const c = this.cal;
      this.log(`calibration: white ${c.whiteMin} dark ${c.darkMin} k ${c.k} h ${c.h} d ${c.d}`);
    }
    return this.cal;
  }

  async pollReady() {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      await this.io.write(commandBytes(POLL_READY));
      const r = await this.io.read(1);
      if (r[0] === 0x01) return;
      if (Date.now() > deadline) throw new Error("scanner never reported ready (1e 04)");
      await this.sleep(this.pollIntervalMs);
    }
  }

  async waitNotBusy() {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      await this.io.write(commandBytes(STATUS));
      const r = await this.io.read(2);
      if (!(r[0] & BUSY)) return;
      if (Date.now() > deadline) throw new Error(`scanner stayed busy (status ${hex(r)})`);
      await this.sleep(this.pollIntervalMs);
    }
  }

  need(value, what) {
    if (value == null) throw new Error(`template order unexpected: no ${what} yet`);
    return value;
  }
}
