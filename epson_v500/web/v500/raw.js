// Turn the V500's raw image data into RGB (see v500/raw.py and PROTOCOL.md).
//
// Data comes in blocks, each followed by an 8-byte trailer holding its length.
// The rest is lines of 8-bit interleaved RGB (grey scans too). Red lags green
// by k lines and green lags blue by k, k = 5 x dpi / 200. Crop the leftmost
// `width` pixels, then apply Epson's colour matrix, or the grey weights.

import { concat } from "./bytes.js";

export const TRAILER = 8; // 02 <u24 LE block length> 00 00 80 00

// From Epson's libsane-epkowa; out = M @ (r, g, b), truncated to 0..255.
export const COLOR_MATRIX = [
  [1.247, -0.2041, -0.0429],
  [-0.192, 1.2918, -0.0998],
  [-0.01, -0.2503, 1.2603],
];
export const GREY_WEIGHTS = [0.195, 0.61, 0.195];

export function lineShift(dpi) {
  const k = Math.floor((5 * dpi) / 200);
  return [2 * k, k, 0];
}

// Split the reads after one `1e 47` into data blocks, walking trailers from the end.
export function blocks(reads) {
  const data = concat(reads);
  const out = [];
  let end = data.length;
  while (end > 0) {
    const t = data.subarray(end - TRAILER, end);
    if (t.length < TRAILER || t[0] !== 0x02) throw new Error(`no block trailer before byte ${end}`);
    const length = t[1] | (t[2] << 8) | (t[3] << 16);
    const start = end - TRAILER - length;
    if (start < 0) throw new Error(`trailer claims ${length} bytes, only ${end - TRAILER} left`);
    out.push(data.subarray(start, end - TRAILER));
    end = start;
  }
  return out.reverse();
}

export function payload(reads) {
  return concat(blocks(reads));
}

// The same in exact integers (x 10,000 and x 1,000), as raw.py does, so values
// that land exactly on an integer truncate the same everywhere.
const M = COLOR_MATRIX.map((row) => row.map((v) => Math.round(v * 10000)));
const G = GREY_WEIGHTS.map((v) => Math.round(v * 1000));

// One output pixel from the raw samples r, g, b.
function convert(r, g, b, grey, out, o) {
  if (grey) {
    const v = Math.floor((r * G[0] + g * G[1] + b * G[2]) / 1000);
    out[o] = v < 0 ? 0 : v > 255 ? 255 : v;
    return;
  }
  for (let c = 0; c < 3; c++) {
    const m = M[c];
    const v = Math.floor((r * m[0] + g * m[1] + b * m[2]) / 10000);
    out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
}

// Decodes rows as raw lines arrive, so a page can paint the scan as it happens.
// push(bytes) takes raw line data (trailers removed) and returns
// {top, rows, data}: the newly finished rows, `channels` bytes per pixel.
export class StreamDecoder {
  constructor({ rawWidth, width, height, dpi, grey = false, cropX = 0 }) {
    this.rawWidth = rawWidth;
    this.width = width;
    this.height = height;
    this.grey = grey;
    this.cropX = cropX;
    this.channels = grey ? 1 : 3;
    this.shift = lineShift(dpi);
    this.lineBytes = rawWidth * 3;
    this.lines = height + Math.max(...this.shift);
    this.buffer = new Uint8Array(this.lines * this.lineBytes);
    this.filled = 0; // bytes received
    this.done = 0; // output rows produced
  }

  push(bytes) {
    if (this.filled + bytes.length > this.buffer.length) throw new Error("more image data than expected");
    this.buffer.set(bytes, this.filled);
    this.filled += bytes.length;
    const complete = Math.floor(this.filled / this.lineBytes);
    // row y needs raw lines y + shift[c] for each colour
    const ready = Math.min(this.height, complete - Math.max(...this.shift));
    const top = this.done;
    if (ready <= top) return { top, rows: 0, data: new Uint8Array(0) };
    const rows = ready - top;
    const out = new Uint8Array(rows * this.width * this.channels);
    const [sr, sg, sb] = this.shift;
    const lb = this.lineBytes;
    const buf = this.buffer;
    for (let y = 0; y < rows; y++) {
      const ry = (top + y + sr) * lb, gy = (top + y + sg) * lb, by = (top + y + sb) * lb;
      for (let x = 0; x < this.width; x++) {
        const px = (this.cropX + x) * 3;
        convert(buf[ry + px], buf[gy + px + 1], buf[by + px + 2], this.grey, out, (y * this.width + x) * this.channels);
      }
    }
    this.done = ready;
    return { top, rows, data: out };
  }

  get complete() {
    return this.done === this.height;
  }
}

// Whole-image decode: raw payload -> {width, height, channels, data}.
export function decode(data, width, height, { dpi = 200, grey = false, cropX = 0 } = {}) {
  const lines = height + Math.max(...lineShift(dpi));
  if (data.length % (lines * 3)) throw new Error(`${data.length} bytes don't split into ${lines} RGB lines`);
  const rawWidth = data.length / (lines * 3);
  if (rawWidth < cropX + width) throw new Error(`raw lines are ${rawWidth} px, narrower than ${cropX + width}`);
  const dec = new StreamDecoder({ rawWidth, width, height, dpi, grey, cropX });
  const { data: out } = dec.push(data);
  return { width, height, channels: dec.channels, data: out };
}
