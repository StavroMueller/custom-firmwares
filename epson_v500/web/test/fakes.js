// Simulated scanners, mirroring tests/fake_template_scanner.py and
// tests/fake_geometry_scanner.py so both implementations see the same data.

import { commandId, u16, u32 } from "../v500/bytes.js";
import { POLL_READY, replies, STATUS } from "../v500/replay.js";

const ACK = 0x06;

// Answers with a template's recorded replies, in order; polls say ready.
// strict: the caller must ask for exactly the recorded size. Off, it behaves
// like USB: a request for more gets what the scanner has (WebUSB asks for at
// least a full packet).
export class TemplateScanner {
  constructor(template, { strict = true } = {}) {
    this.strict = strict;
    this.replies = template.groups.filter((g) => g.command !== POLL_READY && g.command !== STATUS).flatMap(replies);
    this.writes = [];
    this.command = 0;
  }

  async write(data) {
    this.writes.push(data.slice());
    if (data.length === 2 && (data[0] === 0x1b || data[0] === 0x1e)) this.command = commandId(data);
  }

  async read(size) {
    if (this.command === POLL_READY) return new Uint8Array([0x01]);
    if (this.command === STATUS) return new Uint8Array([0x18, 0x81]);
    if (this.command === 0x1e85) { // front-panel button: reported once
      const b = this.button ?? 0;
      this.button = 0;
      return new Uint8Array([b]);
    }
    const r = this.replies.shift();
    if (this.strict ? r.length !== size : r.length > size) throw new Error(`replay asked for ${size} bytes, template has ${r.length}`);
    return r;
  }
}

const RATIO = { 200: 8 / 3, 400: 4 / 3, 800: 1 };

function trailer(n) {
  return new Uint8Array([0x02, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0, 0, 0x80, 0]);
}

// Deterministic 16-bit reference read, same formula as the Python fake.
export function reference(level, lines, window) {
  const out = new Uint16Array(lines * window * 3);
  for (let l = 0; l < lines; l++)
    for (let x = 0; x < window; x++)
      for (let c = 0; c < 3; c++) out[(l * window + x) * 3 + c] = level + ((l * 7 + x * 13 + c * 5) % 50) + ((x * 3) % 40);
  return new Uint8Array(out.buffer);
}

// Answers from the geometry it's told: reads sized by the last 1e 41.
export class GeometryScanner {
  constructor(ratio = null) {
    this.ratio = ratio;
    this.writes = [];
    this.command = 0;
    this.params = new Map();
    this.pending = new Uint8Array(0);
    this.reads = 0;
    this.dpi = 200;
  }

  sent(cmd) {
    return this.params.get(cmd) ?? [];
  }

  async write(data) {
    data = data.slice();
    this.writes.push(data);
    if (data.length === 2 && (data[0] === 0x1b || data[0] === 0x1e)) {
      this.command = commandId(data);
      if (this.command === 0x1e47) {
        this.pending = this.dataForRead();
        this.reads++;
      }
    } else {
      if (!this.params.has(this.command)) this.params.set(this.command, []);
      this.params.get(this.command).push(data);
      if (this.command === 0x1e57) this.dpi = u32(data, 4);
    }
  }

  async read(size) {
    if (this.command === 0x1e47) {
      const out = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      return out;
    }
    if (this.command === POLL_READY) return new Uint8Array([0x01]);
    if (this.command === STATUS) return new Uint8Array([0x18, 0x81]);
    if (this.command === 0x1e85) return new Uint8Array([0]);
    if (size === 1) return new Uint8Array([ACK]);
    return new Uint8Array(size);
  }

  dataForRead() {
    const p = this.sent(0x1e41).at(-1);
    const start = u16(p, 0), end = u16(p, 2), lines = u16(p, 4);
    const window = end - start;
    if (this.reads < 3) {
      const d = reference([1200, 40000, 1300][this.reads], lines, window);
      return join([d, trailer(d.length)]);
    }
    const width = Math.round(window / (this.ratio ?? RATIO[this.dpi]));
    const perBlock = p[18];
    const line = width * 3;
    const image = new Uint8Array(lines * line);
    for (let i = 0; i < image.length; i++) image[i] = i % 251;
    this.image = image;
    const parts = [];
    for (let top = 0; top < lines; top += perBlock) {
      const block = image.subarray(top * line, Math.min(lines, top + perBlock) * line);
      parts.push(block, trailer(block.length));
    }
    return join(parts);
  }
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
