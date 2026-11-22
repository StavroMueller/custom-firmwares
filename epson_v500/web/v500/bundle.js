// Find esfw7C.bin inside Epson's Linux driver download, in the browser.
//
// The bundle (iscan-gt-x770-bundle-*.tar.gz) is gzip -> tar, holding the
// plugin package iscan-plugin-gt-x770_*.deb: an `ar` archive whose
// data.tar.gz holds usr/share/iscan/esfw7C.bin. Everything is gzip, which
// browsers decompress natively (DecompressionStream); no library needed.

const FIRMWARE = "esfw7C.bin";

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const text = (b) => new TextDecoder("latin1").decode(b).replace(/\0.*$/s, "").trim();

// Files in a tar archive: [{name, data}].
export function* untar(tar) {
  for (let pos = 0; pos + 512 <= tar.length; ) {
    const header = tar.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) return;
    const name = text(header.subarray(345, 500)) + text(header.subarray(0, 100)); // ustar prefix + name
    const size = parseInt(text(header.subarray(124, 136)) || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    pos += 512;
    if (type === "0" || type === "\0") yield { name, data: tar.subarray(pos, pos + size) };
    pos += Math.ceil(size / 512) * 512;
  }
}

// Members of an `ar` archive (a .deb): [{name, data}].
export function* unar(ar) {
  if (text(ar.subarray(0, 8)) !== "!<arch>") throw new Error("not a .deb package");
  for (let pos = 8; pos + 60 <= ar.length; ) {
    const name = text(ar.subarray(pos, pos + 16)).replace(/\/$/, "");
    const size = parseInt(text(ar.subarray(pos + 48, pos + 58)), 10);
    yield { name, data: ar.subarray(pos + 60, pos + 60 + size) };
    pos += 60 + size + (size % 2);
  }
}

async function fromDeb(deb) {
  for (const m of unar(deb)) {
    if (!m.name.startsWith("data.tar")) continue;
    if (!m.name.endsWith(".gz")) throw new Error(`${m.name}: only gzip packages are supported`);
    for (const f of untar(await gunzip(m.data))) if (f.name.endsWith("/" + FIRMWARE)) return f.data.slice();
  }
  return null;
}

// Accepts the bundle (.tar.gz), the plugin .deb, or esfw7C.bin itself.
// Returns the firmware bytes.
export async function findFirmware(bytes) {
  bytes = new Uint8Array(bytes);
  if (text(bytes.subarray(0, 4)) === "EDLA") return bytes; // already the firmware
  if (text(bytes.subarray(0, 8)) === "!<arch>") {
    const fw = await fromDeb(bytes);
    if (fw) return fw;
    throw new Error("no esfw7C.bin in that package; pick the gt-x770 plugin or the whole bundle");
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    for (const f of untar(await gunzip(bytes))) {
      if (f.name.endsWith("/" + FIRMWARE)) return f.data.slice();
      if (/iscan-plugin-gt-x770.*\.deb$/.test(f.name)) {
        const fw = await fromDeb(f.data);
        if (fw) return fw;
      }
    }
    throw new Error("no V500 firmware in that archive; it should be Epson's iscan-gt-x770 bundle");
  }
  throw new Error("pick Epson's driver bundle (.tar.gz), its plugin .deb, or esfw7C.bin");
}
