// Retarget a template to any scan area at its resolution (see v500/geometry.py
// and PROTOCOL.md, "Scan geometry").

import { setU16, setU32, u16, u32 } from "./bytes.js";
import { lineShift } from "./raw.js";
import { CMD, params, Template } from "./replay.js";

export const STEPS_PER_INCH = 2400;
export const BLOCK_BYTES = 51200; // Epson reads in chunks of this size; image blocks fit in it
export const RAW_QUANTUM = 384; // raw line widths when the sensor runs faster than the scan
export const LINE_QUANTUM = 32; // otherwise: every width Epson sent at 800 dpi is a multiple of 32; 1,889 px hung the scanner
export const USED_MARGIN = 3; // extra sensor pixels Epson's shading table covers
export const BED_IN = 8.48; // the scanner's maximum width
export const BED_MM = 297.18; // and the driver's maximum height
export const SENSOR_SPAN_IN = 9.6; // widest window Epson used: 5,120 units at 200 dpi

// A scan area in pixels at the scan resolution.
export function region(x, y, width, height) {
  return { x, y, width, height };
}

// mm -> px through SANE's fixed point (1/65536 mm), as Epson's driver gets
// them. Epson rounds the offsets, truncates the height and the width to a
// multiple of 8 (60 mm at 800 dpi: 1,888 px, not 1,889).
export function fromMm(dpi, left, top, width, height) {
  const exact = (v) => (Math.floor(v * 65536) / 65536 / 25.4) * dpi;
  return region(Math.floor(exact(left) + 0.5), Math.floor(exact(top) + 0.5),
    Math.floor(Math.floor(exact(width)) / 8) * 8, Math.floor(exact(height)));
}

export function fullBed(dpi) {
  return region(0, 0, Math.floor(BED_IN * dpi + 1e-6), fromMm(dpi, 0, 0, 0, BED_MM).height);
}

const firstIndex = (groups, cmd) => groups.findIndex((g) => g.command === cmd);
const lastIndex = (groups, cmd) => groups.findLastIndex((g) => g.command === cmd);

// Replace the parameter blocks a group sends.
function withParams(g, blocks) {
  let i = 0;
  return { command: g.command, steps: g.steps.map((s) => (s.out ? { ...s, data: blocks[i], requested: blocks[i++].length } : s)) };
}

function readGroup(sizes) {
  return { command: CMD.READ, steps: sizes.map((s) => ({ out: false, requested: s, data: new Uint8Array(0) })) };
}

function chunks(total) {
  const out = Array(Math.floor(total / BLOCK_BYTES)).fill(BLOCK_BYTES);
  if (total % BLOCK_BYTES) out.push(total % BLOCK_BYTES);
  return out;
}

export function retarget(t, area) {
  const dpi = t.yres;
  if (t.xres !== dpi) throw new Error("templates with different x and y resolutions aren't supported");
  const full = fullBed(dpi);
  if (area.width <= 0 || area.height <= 0 || area.x < 0 || area.y < 0 ||
      area.x + area.width > full.width || area.y + area.height > full.height) {
    throw new Error(`area ${JSON.stringify(area)} is outside the bed (${full.width} x ${full.height} px at ${dpi} dpi)`);
  }

  const groups = t.groups;
  const iParams = firstIndex(groups, CMD.PARAMS);
  const p57t = params(groups[iParams])[0];
  const imageWindow = lastIndex(groups, CMD.WINDOW);
  const w41 = params(groups[imageWindow])[0];
  const startT = u16(w41, 0), endT = u16(w41, 2);
  const windowT = endT - startT;
  const tx = u32(p57t, 8), ty = u32(p57t, 12);
  const extra = Math.max(...lineShift(dpi));
  const linesT = t.height + extra;
  const rawWT = t.imageRawWidth ?? t.rawWidth();
  const ratio = windowT / rawWT;
  const origin = startT - Math.round(tx * ratio);

  const quantum = ratio === 1 ? LINE_QUANTUM : RAW_QUANTUM;
  const rawW = Math.ceil(area.width / quantum) * quantum; // the host crops the padding
  const window = Math.round(rawW * ratio);
  let start = origin + Math.round(area.x * ratio);
  let cropX = 0;
  const limit = origin + Math.round(SENSOR_SPAN_IN * dpi * ratio);
  if (start + window > limit) { // near the right edge: start earlier, crop on the host
    const shift = Math.ceil((start + window - limit) / ratio);
    start -= Math.round(shift * ratio);
    cropX = shift;
  }
  const usedPx = Math.min(window, Math.ceil((cropX + area.width) * ratio) + (ratio !== 1 ? USED_MARGIN : 0));
  const lines = area.height + extra;
  const perBlock = Math.min(255, Math.floor(BLOCK_BYTES / (rawW * 3)));
  if (perBlock < 1) throw new Error(`a ${rawW} px line doesn't fit in one block`);

  const spl = STEPS_PER_INCH / dpi;
  const moves = groups.map((g, i) => (g.command === CMD.MOVE ? i : -1)).filter((i) => i >= 0);
  if (moves.length < 2) throw new Error("template has no move to the scan area");
  const [toTop, scanMove] = moves.slice(-2);
  const ramp = lastIndex(groups.slice(0, toTop), CMD.TABLE);

  const out = groups.slice();

  const p57 = p57t.slice();
  [area.x, area.y, area.width, area.height].forEach((v, i) => setU32(p57, 8 + i * 4, v));
  const channels = t.grey ? 1 : 3 * (p57[25] & 0x10 ? 2 : 1); // mode 0x1013: 16-bit
  p57[28] = Math.min(254, Math.floor(Math.floor(65536 / (area.width * channels)) / 2) * 2);
  out[iParams] = withParams(groups[iParams], [p57]);

  groups.forEach((g, i) => {
    if (g.command === CMD.WINDOW) {
      const p = params(g)[0];
      if (u16(p, 0) !== startT || u16(p, 2) !== endT) return; // the probe's own window
      const q = p.slice();
      setU16(q, 0, start);
      setU16(q, 2, start + window);
      if (i === imageWindow) {
        setU16(q, 4, lines);
        q[18] = perBlock;
      }
      out[i] = withParams(g, [q]);
    } else if (g.command === CMD.TABLE && params(g)[0][0] === 6) {
      const header = params(g)[0].slice();
      const len = window * 6;
      header[5] = len & 0xff;
      header[6] = (len >> 8) & 0xff;
      header[7] = (len >> 16) & 0xff;
      out[i] = withParams(g, [header, new Uint8Array(len)]);
    }
  });

  const reads = groups.map((g, i) => (g.command === CMD.READ ? i : -1)).filter((i) => i >= 0);
  reads.forEach((i, n) => {
    if (n === 0) return; // the probe read is fixed-size
    if (n < reads.length - 1) {
      const refLines = u16(params(out[lastIndex(out.slice(0, i), CMD.WINDOW)])[0], 4);
      out[i] = readGroup(chunks(refLines * window * 6 + 8));
    } else {
      const line = rawW * 3;
      const sizes = Array(Math.floor(lines / perBlock)).fill(perBlock * line + 8);
      if (lines % perBlock) sizes.push((lines % perBlock) * line + 8);
      out[i] = readGroup(sizes);
    }
  });

  // the move to the top of the area: same total distance plus the y change
  let m = params(groups[toTop])[0];
  const stepsT = u32(m, 0), rampT = u16(m, 6) + 1;
  const distance = stepsT + 2 * rampT + (area.y - ty) * spl;
  let n = params(groups[ramp])[1].length / 2;
  while (n > 1 && distance - 2 * n < 0) n = Math.floor(n / 2);
  if (distance - 2 * n < 0) throw new Error(`can't reach line ${area.y}: move of ${distance} steps`);
  let q = m.slice();
  setU32(q, 0, distance - 2 * n);
  setU16(q, 6, n - 1);
  setU16(q, 8, n - 1);
  out[toTop] = withParams(groups[toTop], [q]);

  // the scan move
  m = params(groups[scanMove])[0];
  const tail = u16(m, 4);
  if (u32(m, 0) !== linesT * spl + tail) throw new Error("template's scan move doesn't match its line count");
  q = m.slice();
  setU32(q, 0, lines * spl + tail);
  out[scanMove] = withParams(groups[scanMove], [q]);

  const used = new Uint8Array(window);
  used.fill(1, 0, usedPx);
  const windows = [t.windows[0], ...t.windows.slice(1).map(() => window)];
  return new Template({ ...t, groups: out, width: area.width, height: area.height, windows, used, cropX, imageRawWidth: rawW });
}
