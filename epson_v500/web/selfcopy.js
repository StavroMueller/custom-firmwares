// A copy of this page with the user's firmware built in, so it opens on any
// computer with no file to pick. For the user's own computers: Epson's
// licence forbids redistributing the firmware.

// The marker is assembled at run time: this code is itself inside the page,
// and a literal marker here would match its own source.
export const FIRMWARE_ID = ["v500", "firmware"].join("-");
const OPEN = `<script id="${FIRMWARE_ID}" type="application/octet-stream">`;

export function base64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The esfw7C.bin layout parseFirmware() reads, from a parsed firmware.
export function firmwareFile(fw) {
  const out = new Uint8Array(0x10100);
  out.set([0x45, 0x44, 0x4c, 0x41]); // "EDLA"
  out.set(fw.uploadHeader, 0x4c);
  out.set(fw.body, 0x100);
  return out;
}

// `html` with the firmware bytes in a data script before </body>, replacing
// any already there.
export function withFirmware(html, bytes) {
  const close = "<" + "/script>";
  const at = html.lastIndexOf(OPEN); // a copy of a copy: replace the old one
  if (at >= 0) {
    const end = html.indexOf(close, at) + close.length;
    html = html.slice(0, at) + html.slice(end).replace(/^\s*/, "");
  }
  const body = html.lastIndexOf("<" + "/body>");
  const tag = `${OPEN}\n${base64(bytes)}\n${close}\n`;
  return body < 0 ? html + tag : html.slice(0, body) + tag + html.slice(body);
}

// The firmware built into a page (its text content), or null.
export function decodeBuiltIn(text) {
  if (!text) return null;
  const bin = atob(text.trim());
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
