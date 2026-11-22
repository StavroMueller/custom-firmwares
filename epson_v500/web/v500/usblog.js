// Read the transfer logs that tools/capture/usblog.c writes (see v500/usblog.py).
//
// File: "V5USBLOG", then records of
//   double t; u8 endpoint; u8 kind; i32 rc; u32 requested; u32 actual;
//   u8 data[IN ? actual : requested]

const MAGIC = "V5USBLOG";
const RECORD = 22;

export function parseUsblog(buffer) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(...bytes.subarray(0, 8));
  if (magic !== MAGIC) throw new Error("not a usblog file (expected a capture from tools/capture)");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const records = [];
  let pos = 8;
  while (pos + RECORD <= bytes.length) {
    const time = dv.getFloat64(pos, true);
    const endpoint = dv.getUint8(pos + 8);
    const rc = dv.getInt32(pos + 10, true);
    const requested = dv.getUint32(pos + 14, true);
    const actual = dv.getUint32(pos + 18, true);
    pos += RECORD;
    const size = endpoint & 0x80 ? actual : requested;
    records.push({ time, endpoint, rc, requested, out: !(endpoint & 0x80), data: bytes.slice(pos, pos + size) });
    pos += size;
  }
  return records;
}
