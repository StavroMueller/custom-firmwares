// Scanner controls outside a scan: front-panel buttons, aborting a scan,
// sending the carriage home. From static analysis of Epson's plugin
// (PROTOCOL.md, "Buttons, abort and home").

import { hex } from "./bytes.js";

const ACK = 0x06;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// The front-panel button pressed since the last query: 1-4, or 0 for none.
// `1e 85`, no ACK, one byte. 1-4 are likely Start, Copy, E-mail, PDF.
export async function pressedButton(io) {
  await io.write(new Uint8Array([0x1e, 0x85]));
  const r = await io.read(1);
  return r[0] >= 1 && r[0] <= 4 ? r[0] : 0;
}

export async function status(io) {
  await io.write(new Uint8Array([0x1b, 0x03]));
  return io.read(2);
}

export const busy = (s) => Boolean(s[0] & 0x40);

// Wait until `1b 03` says neither busy (0x40) nor 0x02, like Epson's plugin.
export async function waitIdle(io, { timeoutMs = 30000, sleep = sleepMs } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await status(io);
    if (!(s[0] & 0x42)) return s;
    if (Date.now() > deadline) throw new Error(`scanner stayed busy (status ${hex(s)})`);
    await sleep(s[0] & 0x40 ? 200 : 50);
  }
}

// Abort a scan in progress, as Epson's plugin does on cancel: `1e 18`,
// wait a second, read one byte (not checked), then wait until idle. Any
// image data still queued is read and dropped first.
export async function abortScan(io, { sleep = sleepMs } = {}) {
  await io.write(new Uint8Array([0x1e, 0x18]));
  await sleep(1000);
  await io.read(1).catch(() => {});
  return waitIdle(io, { sleep });
}

// Send the carriage home (`1e fa`), as the plugin does before a scan when
// the carriage isn't at position 0.
export async function home(io, { sleep = sleepMs } = {}) {
  await io.write(new Uint8Array([0x1e, 0xfa]));
  const r = await io.read(1);
  if (r[0] !== ACK) throw new Error(`home: scanner replied ${hex(r)}`);
  return waitIdle(io, { sleep });
}

// Is the lamp on? `1e a1`, no ACK, one byte: 01 on, 00 off (checked on the
// real scanner). The scanner switches it off by itself when idle.
export async function lampIsOn(io) {
  await io.write(new Uint8Array([0x1e, 0xa1]));
  const r = await io.read(1);
  return Boolean(r[0] & 0x01);
}

// Switch the lamp on (`1e a2 01`), as every scan does first. There is no
// warm-up to gain: a scan after the lamp was off 4 minutes is as fast.
export async function lampOn(io) {
  for (const part of [[0x1e, 0xa2], [0x01]]) {
    await io.write(new Uint8Array(part));
    const r = await io.read(1);
    if (r[0] !== ACK) throw new Error(`lamp: scanner replied ${hex(r)}`);
  }
}

// Carriage position in motor steps: `1e 86`, no ACK, a u32 (0 at home, 51
// after the 51-step calibration move). No answer while the carriage moves.
export async function position(io) {
  await io.write(new Uint8Array([0x1e, 0x86]));
  const r = await io.read(4);
  return (r[0] | (r[1] << 8) | (r[2] << 16) | (r[3] << 24)) >>> 0;
}

// Get the scanner ready for a scan: let it finish driving home after the
// last scan (2-5 s), abort a scan that never finished, and send the carriage
// home if it isn't there. Throws "stuck" only if none of that works.
export async function ready(io, { log = () => {}, settleMs = 15000, sleep = sleepMs } = {}) {
  let s = await status(io);
  if (s[0] & 0x42) {
    try {
      s = await waitIdle(io, { timeoutMs: settleMs, sleep });
    } catch {
      log("scanner still busy: aborting the earlier scan");
      try {
        s = await abortScan(io, { sleep });
      } catch (e) {
        throw new Error(`The scanner is stuck from an earlier scan (${e.message}). Switch it off and on, then Connect and scan again.`);
      }
    }
  }
  if (s[0] & 0x10) { // firmware running: the position query exists
    let at;
    try {
      at = await position(io);
    } catch {
      // idle by status but not answering: left mid-scan (checked: an abort frees it)
      log("scanner not answering the position query: aborting the earlier scan");
      try {
        await abortScan(io, { sleep });
        at = await position(io);
      } catch (e) {
        throw new Error(`The scanner is stuck from an earlier scan (${e.message}). Switch it off and on, then Connect and scan again.`);
      }
    }
    if (at !== 0) {
      log(`carriage at step ${at}, not home: sending it home`);
      await home(io, { sleep });
    }
  }
  return s;
}
