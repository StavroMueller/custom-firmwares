// Scan with the JavaScript driver from Node, on the real scanner, through
// tools/usbbridge.py (Python owns the USB device). The same code path as the
// web page, minus WebUSB: for testing on hardware without a browser.
//
//   node web/tools/scan-node.mjs <template.usblog | @dpi> <out.ppm> [--firmware esfw7C.bin] [--area L T W H] [--grey]
//
// "@200" builds the scan from scratch (protocol.js) instead of a template.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findFirmware } from "../v500/bundle.js";
import { parseFirmware, upload } from "../v500/firmware.js";
import { fromMm, fullBed, retarget } from "../v500/geometry.js";
import { build } from "../v500/protocol.js";
import { Replayer, Template } from "../v500/replay.js";

const here = dirname(fileURLToPath(import.meta.url));

export class BridgeTransport {
  constructor(python = join(here, "../../.venv/bin/python")) {
    this.proc = spawn(python, [join(here, "../../tools/usbbridge.py")], { stdio: ["pipe", "pipe", "inherit"] });
    this.buf = Buffer.alloc(0);
    this.waiters = [];
    this.proc.stdout.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.wake();
    });
    this.proc.on("exit", () => {
      this.closed = true;
      this.wake();
    });
  }

  wake() {
    const w = this.waiters;
    this.waiters = [];
    w.forEach((f) => f());
  }

  async take(n) {
    while (this.buf.length < n) {
      if (this.closed) throw new Error("usb bridge exited");
      await new Promise((r) => this.waiters.push(r));
    }
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }

  async error() {
    const n = (await this.take(4)).readUInt32LE();
    throw new Error(`usb: ${(await this.take(n)).toString()}`);
  }

  send(op, n, data) {
    const head = Buffer.alloc(5);
    head.write(op, 0);
    head.writeUInt32LE(n, 1);
    this.proc.stdin.write(data ? Buffer.concat([head, Buffer.from(data)]) : head);
  }

  async write(data) {
    this.send("W", data.length, data);
    const r = await this.take(1);
    if (r[0] === 0x45) await this.error();
  }

  async read(size) {
    this.send("R", size);
    const first = await this.take(1);
    if (first[0] === 0x45) await this.error();
    const n = Buffer.concat([first, await this.take(3)]).readUInt32LE();
    return new Uint8Array(await this.take(n));
  }

  close() {
    this.proc.stdin.end();
  }
}

function arg(name, count = 1) {
  const i = process.argv.indexOf(name);
  return i < 0 ? null : process.argv.slice(i + 1, i + 1 + count);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [templatePath, outPath] = process.argv.slice(2);
  const area = arg("--area", 4);
  let t;
  if (templatePath.startsWith("@")) {
    const dpi = Number(templatePath.slice(1));
    t = build(dpi, area ? fromMm(dpi, ...area.map(Number)) : fullBed(dpi), { grey: process.argv.includes("--grey") });
  } else {
    const buf = readFileSync(templatePath);
    t = Template.fromUsblog(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), templatePath);
    if (area) t = retarget(t, fromMm(t.yres, ...area.map(Number)));
  }
  const io = new BridgeTransport();
  try {
    const fw = arg("--firmware");
    if (fw) {
      const f = await findFirmware(readFileSync(fw[0])); // esfw7C.bin, or Epson's bundle / plugin .deb
      if (await upload(parseFirmware(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength)), io)) console.log("firmware uploaded");
    }
    const started = Date.now();
    let first = null;
    const img = await new Replayer(t, io, {
      log: console.log,
      onRows: () => (first ??= Date.now()),
    }).run();
    const s = (ms) => (ms / 1000).toFixed(1);
    console.log(`${img.width} x ${img.height}: first rows after ${s(first - started)} s, done in ${s(Date.now() - started)} s`);
    const header = Buffer.from(`P${img.channels === 3 ? 6 : 5}\n${img.width} ${img.height}\n255\n`);
    writeFileSync(outPath, Buffer.concat([header, Buffer.from(img.data)]));
    console.log(`saved ${outPath}`);
  } finally {
    io.close();
  }
}
