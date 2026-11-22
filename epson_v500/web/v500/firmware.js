// Parse Epson's esfw7C.bin and upload it (see v500/firmware.py, PROTOCOL.md).
// The V500 keeps no firmware in flash; the host uploads it on every power-on.
// Users supply their own copy: Epson's licence forbids redistributing it.

import { hex } from "./bytes.js";

const ACK = 0x06;
const STATUS = new Uint8Array([0x1b, 0x03]);
const BEGIN_UPLOAD = new Uint8Array([0x1b, 0x06]);
const RUN = new Uint8Array([0x1b, 0x16]);
const RUN_PARAM = new Uint8Array([0x80]);
export const FIRMWARE_LOADED = 0x10; // bit in the first status byte

export function parseFirmware(buffer) {
  const data = new Uint8Array(buffer);
  if (String.fromCharCode(...data.subarray(0, 4)) !== "EDLA") throw new Error("not an Epson firmware file (expected esfw7C.bin)");
  if (data.length < 0x10100) throw new Error(`file is ${data.length} bytes, expected at least ${0x10100}`);
  const body = data.slice(0x100, 0x10100);
  let sum = 0;
  for (const b of body) sum = (sum + b) & 0xff;
  const text = new TextDecoder("latin1").decode(body);
  const m = text.match(/EPSON[ -~]{10,40}/);
  return { uploadHeader: data.slice(0x4c, 0x50), body, checksum: sum, ident: m ? m[0].split(/\s+/).join(" ") : "unknown" };
}

export async function status(io) {
  await io.write(STATUS);
  const reply = await io.read(2);
  if (reply.length < 2) throw new Error(`short status reply: ${hex(reply) || "nothing"}`);
  return reply.subarray(0, 2);
}

export const isLoaded = (reply) => Boolean(reply[0] & FIRMWARE_LOADED);

async function expectAck(io) {
  const reply = await io.read(1);
  if (!reply.length || reply[0] !== ACK) throw new Error(`expected ACK, scanner replied ${hex(reply) || "nothing"}`);
}

// Upload unless the scanner already runs firmware. Returns true if it uploaded.
export async function upload(fw, io) {
  if (isLoaded(await status(io))) return false;
  await io.write(BEGIN_UPLOAD);
  await expectAck(io);
  await io.write(fw.uploadHeader);
  await io.write(fw.body);
  await io.write(new Uint8Array([fw.checksum]));
  await expectAck(io);
  await io.write(RUN);
  await expectAck(io);
  await io.write(RUN_PARAM);
  await expectAck(io);
  if (!isLoaded(await status(io))) throw new Error("upload ACKed but the firmware isn't running");
  return true;
}
