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
import { abortScan } from "./device.js";
import { lineShift, payload, StreamDecoder, TRAILER } from "./raw.js";
import { parseUsblog } from "./usblog.js";

export const POLL_READY = 0x1e04;
export const STATUS = 0x1b03;
export const BUSY = 0x40;
const TABLE_MAX = 255 * 256; // bytes per 1e 84 upload: whole 256-byte units, and whole pixels (6 bytes)
const isType07 = (g) => g.command === 0x1e84 && g.steps[1]?.out && g.steps[1].data[0] === 0x07;

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
  // calibration: {key, cal} from a previous scan of the same window and line
  // period (its `calibration` property). Reusing it skips the dark probe, the
  // white and dark reference reads and the lamp off/on: about 1 s.
  constructor(template, io, { sleep = sleepMs, log = () => {}, onRows = () => {}, onProgress = () => {},
    pollTimeoutMs = 60000, pollIntervalMs = 20, levels = null, signal = null, calibration: reuse = null } = {}) {
    this.t = template;
    this.io = io;
    this.sleep = sleep;
    this.log = log;
    this.onRows = onRows;
    this.onProgress = onProgress;
    this.pollTimeoutMs = pollTimeoutMs;
    this.pollIntervalMs = pollIntervalMs;
    this.reuseLevels = Boolean(levels);
    this.signal = signal; // an AbortSignal: stops the scan and aborts it on the scanner
    this.sentAny = false; // a command went out: stopping now needs an abort
    this.reads = [];
    this.afe = levels;
    this.probeOff = null;
    this.cal = null;
    // each group's occurrence among groups of its command, and each read's
    // number, fixed up front so skipping groups doesn't shift them
    const seen = new Map();
    this.occurrence = template.groups.map((g) => {
      const n = seen.get(g.command) ?? 0;
      seen.set(g.command, n + 1);
      return n;
    });
    this.imageWindow = (seen.get(CMD.WINDOW) ?? 0) - 1;
    this.totalReads = seen.get(CMD.READ) ?? 0;
    this.moves = seen.get(CMD.MOVE) ?? 0;
    this.key = this.calibrationKey();
    this.reuseCal = reuse && reuse.key === this.key ? reuse.cal : null;
    if (this.reuseCal) this.cal = this.reuseCal;
  }

  // What a calibration depends on: the sensor window, line period and the
  // pixels used. Scans that share it can share a calibration.
  calibrationKey() {
    const g = this.t.groups;
    const white = g.filter((x) => x.command === CMD.WINDOW)[1];
    const timing = g.find((x) => x.command === 0x1e21);
    const used = this.t.used.reduce((a, b) => a + b, 0);
    return [white && hex(params(white)[0].subarray(0, 4)), timing && hex(params(timing)[0].subarray(0, 2)), used].join("|");
  }

  // The calibration this scan used, for the next scan to reuse.
  get calibration() {
    return this.cal ? { key: this.key, cal: this.cal } : null;
  }

  // Groups to skip when the calibration is reused: from the dark probe's
  // window to the lamp coming back on after the dark reference.
  calibrationSpan() {
    const g = this.t.groups;
    const start = g.findIndex((x) => x.command === CMD.WINDOW);
    let darkRead = -1;
    g.forEach((x, i) => { if (x.command === CMD.READ && this.occurrence[i] === this.totalReads - 2) darkRead = i; });
    const lampOn = g.findIndex((x, i) => i > darkRead && x.command === 0x1ea2);
    return start >= 0 && darkRead >= 0 && lampOn >= 0 ? [start, lampOn] : null;
  }

  // Runs the scan. If it's stopped (signal) or fails, the scanner is told
  // to abort (`1e 18`), so it ends up idle instead of stuck.
  async run() {
    try {
      return await this.steps();
    } catch (e) {
      if (this.sentAny) {
        this.log(`stopping the scanner after: ${e.message}`);
        try {
          await abortScan(this.io, { sleep: this.sleep });
          this.log("scanner aborted and idle");
        } catch (e2) {
          this.log(`abort failed too: ${e2.message}`);
          e.message += " (and the scanner didn't confirm the abort: if it stays busy, switch it off and on)";
        }
      }
      throw e;
    }
  }

  checkStop() {
    if (this.signal?.aborted) throw Object.assign(new Error("scan cancelled"), { name: "AbortError" });
  }

  async steps() {
    const groups = this.t.groups;
    // the level measurement: from the first 1e 46 to the last 1e 92
    const measure = [groups.findIndex((g) => g.command === 0x1e46), groups.findLastIndex((g) => g.command === CMD.AFE_READ)];
    const calSpan = this.reuseCal ? this.calibrationSpan() : null;
    if (this.reuseCal && !calSpan) throw new Error("template has no calibration to skip");
    // skipping the white reference also skips its move: the move to the area goes that much further
    this.extraSteps = 0;
    if (calSpan) {
      const whiteMove = groups.findIndex((g, i) => g.command === CMD.MOVE && i > calSpan[0] && i < calSpan[1]);
      if (whiteMove >= 0) this.extraSteps = u32(params(groups[whiteMove])[0], 0);
      this.log("reusing the calibration from an earlier scan");
    }
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (this.reuseLevels && measure[0] >= 0 && i >= measure[0] && i <= measure[1]) continue;
      // the constant type 07 table costs ~190 ms (the scanner works before it
      // ACKs) and survives between scans, even the 1b 40 resets: send it with
      // the level measurement only (checked: same image, 0.2 s faster)
      if (this.reuseLevels && isType07(g)) continue;
      if (calSpan && i >= calSpan[0] && i <= calSpan[1]) continue;
      this.checkStop();
      if (g.command === POLL_READY || g.command === STATUS) {
        while (i + 1 < groups.length && groups[i + 1].command === g.command) i++;
        if (g.command === POLL_READY) await this.pollReady();
        else await this.waitNotBusy();
      } else {
        await this.replay(g, i);
      }
      this.onProgress(i + 1, groups.length);
    }
    return this.image;
  }

  async replay(g, i) {
    const n = this.occurrence[i];
    const isImage = g.command === CMD.READ && n === this.totalReads - 1;
    if (isImage) this.startImage();
    // Epson aborts only once the image read has started, but a scan that
    // fails before it (checked: a read timing out during setup) leaves the
    // scanner reporting idle while it ignores motor commands (1e 86, 1e fa)
    // until a 1e 18. An abort on an idle scanner is harmless (checked).
    this.sentAny = true;
    const sent = this.substitute(g, n);
    if (g.command === CMD.TABLE && sent[1]?.length > TABLE_MAX) return this.splitTable(sent);
    await this.io.write(commandBytes(g.command));
    let p = 0;
    const got = [];
    for (const step of g.steps) {
      if (step.out) {
        await this.io.write(sent[p++]);
        continue;
      }
      if (isImage) this.checkStop();
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

  // One 1e 84 upload must stay under 64 KiB (checked at 1600 dpi: a 65,472
  // byte shading table works, 65,664 times out). Send a bigger table as
  // consecutive pieces: header bytes 2-3 are the address in 256-byte units.
  async splitTable([header, data]) {
    const base = header[2] | (header[3] << 8);
    for (let off = 0; off < data.length; off += TABLE_MAX) {
      const piece = data.subarray(off, off + TABLE_MAX);
      const h = header.slice();
      const addr = base + off / 256;
      h[2] = addr & 0xff;
      h[3] = addr >> 8;
      h[5] = piece.length & 0xff;
      h[6] = (piece.length >> 8) & 0xff;
      h[7] = piece.length >> 16;
      await this.io.write(commandBytes(CMD.TABLE));
      await this.expectAck(CMD.TABLE);
      await this.io.write(h);
      await this.io.write(piece);
      await this.expectAck(CMD.TABLE);
    }
  }

  async expectAck(cmd) {
    const r = await this.io.read(1);
    if (!(r.length === 1 && r[0] === ACK)) throw new Error(`${hex(commandBytes(cmd))}: scanner replied ${hex(r)}, expected ACK`);
  }

  substitute(g, n) {
    const ps = params(g).map((x) => x.slice());
    if (g.command === CMD.AFE && n > 0) ps[0] = this.need(this.afe, "1e 92 reply");
    else if (g.command === CMD.LEVELS && n === 1) {
      const o = this.need(this.probeOff, "probe read");
      ps[0] = calibration.param1e42([0, 0, 0], o);
    } else if (g.command === CMD.LEVELS && n === 3) ps[0] = this.calibrate().param1e42();
    else if (g.command === CMD.MOVE && n === this.moves - 2 && this.extraSteps) {
      ps[0] = ps[0].slice(); // the move to the area, from home instead of the white reference
      new DataView(ps[0].buffer).setUint32(0, u32(ps[0], 0) + this.extraSteps, true);
    }
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
      const k = n;
      this.reads[k] = data;
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
