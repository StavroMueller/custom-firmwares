// Small helpers for little-endian byte blocks.

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

export function view(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function u16(bytes, offset) {
  return view(bytes).getUint16(offset, true);
}

export function u32(bytes, offset) {
  return view(bytes).getUint32(offset, true);
}

export function setU16(bytes, offset, value) {
  view(bytes).setUint16(offset, value, true);
}

export function setU32(bytes, offset, value) {
  view(bytes).setUint32(offset, value, true);
}

export function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function equal(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// A two-byte command as a number: 1e 41 -> 0x1e41.
export function commandId(bytes) {
  return (bytes[0] << 8) | bytes[1];
}

export function commandBytes(id) {
  return new Uint8Array([id >> 8, id & 0xff]);
}
