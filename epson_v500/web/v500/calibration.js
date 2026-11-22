// Calibration values for a scan, from the scanner's reference reads
// (see v500/calibration.py and PROTOCOL.md, "Calibration").
//
// White (32 lines) and dark (16 lines, lamp off) are read as 16-bit RGB across
// the sensor window. From them: a packed shading table (`1e 84` type 06), the
// per-colour minimums (`1e 42`) and bytes 11 and 15 of the image pass's `1e 41`,
// which tell the scanner how the table is packed. Method from Epson's plugin.

export const DARK_SMOOTHING = 51; // moving-average width that best matches Epson's dark line (fitted)

// A 16-bit read as a Uint16Array, copying so alignment is right.
export function u16Samples(bytes) {
  const copy = bytes.slice();
  return new Uint16Array(copy.buffer, 0, copy.length >> 1);
}

// Mean per colour of the dark probe (16 px x 4 lines), rounded.
export function probeOffsets(probe) {
  const sums = [0, 0, 0];
  for (let i = 0; i < probe.length; i++) sums[i % 3] += probe[i];
  const n = probe.length / 3;
  return sums.map((s) => roundHalfEven(s / n));
}

function roundHalfEven(x) {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// The `1e 42` block: 3 white values, then each dark value twice.
export function param1e42(white, dark) {
  const out = new Uint8Array(18);
  const dv = new DataView(out.buffer);
  const values = [white[0], white[1], white[2], dark[0], dark[0], dark[1], dark[1], dark[2], dark[2]];
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return out;
}

// Centred moving average along the line, narrower at the ends (one colour).
function smooth(line, width) {
  const n = line.length;
  const r = Math.floor(width / 2);
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i] + line[i];
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - r), hi = Math.min(n, i + r + 1);
    out[i] = (sums[hi] - sums[lo]) / (hi - lo);
  }
  return out;
}

// white: Uint16Array of 32 lines x window x 3; dark: 16 lines x window x 3.
// used: Uint8Array(window), 1 for the sensor pixels the scan needs.
export function compute(white, dark, window, used) {
  const W = window;
  const idx = [];
  for (let x = 0; x < W; x++) if (used[x]) idx.push(x);
  const n = idx.length;
  const w = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const d = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];

  for (let c = 0; c < 3; c++) {
    // white: 4 groups of 8 lines averaged, then the brightest of the 4
    idx.forEach((x, j) => {
      let best = -Infinity;
      for (let g = 0; g < 4; g++) {
        let s = 0;
        for (let l = 0; l < 8; l++) s += white[((g * 8 + l) * W + x) * 3 + c];
        best = Math.max(best, s / 8);
      }
      w[c][j] = Math.floor(best);
    });
    // dark: 16 lines averaged, smoothed across the whole window
    const darkLine = new Float64Array(W);
    const lines = dark.length / (W * 3);
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let l = 0; l < lines; l++) s += dark[(l * W + x) * 3 + c];
      darkLine[x] = s / lines;
    }
    const sm = smooth(darkLine, DARK_SMOOTHING);
    idx.forEach((x, j) => (d[c][j] = Math.floor(sm[x])));
  }

  const minOf = (a) => a.reduce((m, v) => Math.min(m, v), Infinity);
  const rangeOf = (arrs, mins) => Math.max(...arrs.map((a, c) => a.reduce((m, v) => Math.max(m, v - mins[c]), 0)));
  const whiteMin = w.map(minOf);
  const darkMin = d.map(minOf);

  const darkRange = rangeOf(d, darkMin);
  let k = 0, dshift = 0;
  const steps = [[3, 0x1f], [2, 0x3f], [1, 0x7f], [0, 0xff]];
  const found = steps.find(([, limit]) => darkRange <= limit);
  if (found) k = found[0];
  else while (darkRange >= 0x100 * 2 ** dshift) dshift++;
  const whiteRange = rangeOf(w, whiteMin);
  let h = 0;
  while (whiteRange >= 2 ** (k + 8) * 2 ** h && h < 8) h++;

  const table = new Uint16Array(W * 3);
  idx.forEach((x, j) => {
    for (let c = 0; c < 3; c++) {
      const v = (((w[c][j] - whiteMin[c]) >> h) << (8 - k)) | ((d[c][j] - darkMin[c]) >> dshift);
      table[x * 3 + c] = Math.min(65535, Math.max(0, v));
    }
  });
  return {
    whiteMin,
    darkMin,
    table,
    k,
    h,
    d: dshift,
    param1e42: () => param1e42(whiteMin, darkMin),
    tableBytes: () => new Uint8Array(table.buffer.slice(0)),
    windowBytes: () => [0x80 | k, (h << 4) | dshift],
  };
}
