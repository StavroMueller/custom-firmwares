// Bulk transport to the V500 over WebUSB (Chrome and Edge; see v500/usb.py).

export const VENDOR_ID = 0x04b8;
export const PRODUCT_ID = 0x0130;
const TIMEOUT_MS = 10000;

export class WebUsbTransport {
  constructor(device) {
    this.device = device;
  }

  static get supported() {
    return typeof navigator !== "undefined" && "usb" in navigator;
  }

  // A scanner this page was allowed before, or null.
  static async remembered() {
    const devices = await navigator.usb.getDevices();
    const d = devices.find((x) => x.vendorId === VENDOR_ID && x.productId === PRODUCT_ID);
    return d ? WebUsbTransport.open(d) : null;
  }

  // Ask the user to pick the scanner. Must run from a click.
  static async request() {
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] });
    return WebUsbTransport.open(d);
  }

  static async open(device) {
    if (!device.opened) await device.open();
    if (device.configuration === null) await device.selectConfiguration(1);
    const iface = device.configuration.interfaces[0];
    try {
      await device.claimInterface(iface.interfaceNumber);
    } catch (e) {
      throw new Error(`can't claim the scanner (${e.message}). Is another program using it? ` +
        "On Linux install udev/60-epson-v500.rules; on Windows the device needs the WinUSB driver.");
    }
    const t = new WebUsbTransport(device);
    t.interfaceNumber = iface.interfaceNumber;
    const eps = iface.alternate.endpoints.filter((e) => e.type === "bulk");
    t.outEp = eps.find((e) => e.direction === "out");
    t.inEp = eps.find((e) => e.direction === "in");
    if (!t.outEp || !t.inEp) throw new Error("scanner has no bulk endpoints");
    return t;
  }

  get name() {
    return this.device.productName || "Epson scanner";
  }

  async write(data) {
    const r = await withTimeout(this.device.transferOut(this.outEp.endpointNumber, data), "write");
    if (r.status !== "ok" || r.bytesWritten !== data.length) {
      throw new Error(`short write: ${r.bytesWritten} of ${data.length} bytes (${r.status})`);
    }
  }

  async read(size) {
    // Ask for at least one full packet: a shorter request overflows if the
    // scanner sends more than `size` bytes.
    const want = Math.max(size, this.inEp.packetSize);
    // A transfer whose wait timed out is still queued in the browser and
    // would take the next reply (e.g. the answer to an abort). Reuse it as
    // this read when it's big enough; otherwise let it finish first.
    let transfer = null;
    if (this.stale) {
      const { promise, want: staleWant } = this.stale;
      this.stale = null;
      if (staleWant >= size) transfer = { promise, want: staleWant };
      else await withTimeout(promise, "read").catch(() => {});
    }
    transfer ??= { promise: this.device.transferIn(this.inEp.endpointNumber, want), want };
    let r;
    try {
      r = await withTimeout(transfer.promise, "read");
    } catch (e) {
      this.stale = transfer;
      throw e;
    }
    if (r.status !== "ok") throw new Error(`read failed: ${r.status}`);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async close() {
    try {
      await this.device.releaseInterface(this.interfaceNumber);
    } catch { /* already gone */ }
    await this.device.close();
  }
}

function withTimeout(promise, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`scanner didn't answer (${what} timed out); power-cycle it if this repeats`)), TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
