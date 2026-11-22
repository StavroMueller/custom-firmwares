// The scanner page: connect over WebUSB, upload firmware, scan, paint rows live.

import { findFirmware } from "./v500/bundle.js";
import { parseFirmware, status, isLoaded, upload } from "./v500/firmware.js";
import { fromMm, fullBed, retarget } from "./v500/geometry.js";
import { build, SUPPORTED } from "./v500/protocol.js";
import { Replayer, Template } from "./v500/replay.js";
import { WebUsbTransport } from "./v500/webusb.js";

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"), device: $("device"), firmware: $("firmware"), firmwareName: $("firmware-name"),
  templates: $("templates"), templatesList: $("templates-list"), forget: $("forget"),
  dpi: $("dpi"), mode: $("mode"), preset: $("area-preset"), areaMm: $("area-mm"),
  left: $("left"), top: $("top"), width: $("width"), height: $("height"),
  scan: $("scan"), save: $("save"), progress: $("progress"), status: $("status"), log: $("log"),
  canvas: $("canvas"), placeholder: $("placeholder"), unsupported: $("unsupported"),
};

const state = {
  io: null,
  firmware: null, // parsed esfw7C.bin
  templates: new Map(), // dpi -> Template (colour, 8-bit), for resolutions not built in
  levels: null, // {data, at}: analog levels measured by an earlier scan, reused while fresh
  scanning: false,
};

// ---- stored files (IndexedDB; this browser only) ----

const DB = "v500-scanner";

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("files");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Storage can fail or never answer (private windows, blocked site data): give
// up after a moment and work without it.
async function store(op, ...args) {
  const attempt = (async () => {
    const d = await db();
    return await new Promise((resolve, reject) => {
      const tx = d.transaction("files", op.startsWith("get") ? "readonly" : "readwrite");
      const req = tx.objectStore("files")[op](...args);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  })();
  const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), 2000));
  try {
    return await Promise.race([attempt, timeout]);
  } catch {
    return undefined;
  }
}

// ---- helpers ----

function log(line) {
  ui.log.textContent += line + "\n";
  ui.log.scrollTop = ui.log.scrollHeight;
}

function say(text, kind = "") {
  ui.status.textContent = text;
  ui.status.className = "status " + kind;
}

function refresh() {
  ui.scan.disabled = !state.io || state.scanning;
  $("booth-start").disabled = !state.io || state.scanning;
  ui.connect.disabled = state.scanning;
  const dpi = Number(ui.dpi.value);
  const builtIn = SUPPORTED.includes(dpi);
  ui.mode.querySelector('[value="grey"]').disabled = !builtIn && !state.templates.get(dpi)?.grey;
  if (!builtIn) ui.mode.value = state.templates.get(dpi)?.grey ? "grey" : "colour";
  for (const el of [ui.firmware, ui.templates, ui.dpi, ui.mode, ui.preset, ui.left, ui.top, ui.width, ui.height, ui.forget]) {
    el.disabled = state.scanning;
  }
}

// ---- scanner ----

// Reusing the last measured analog levels skips the scanner's 2.2 s
// self-measurement (first rows after 3.1 s instead of 5.3 s, same image
// quality). Measure again after a power cycle and every 10 minutes.
const LEVELS_FRESH_MS = 10 * 60 * 1000;

async function attach(io) {
  state.io = io;
  state.levels = null;
  try {
    const s = await status(io);
    ui.device.textContent = `${io.name}: ${isLoaded(s) ? "firmware running" : "needs firmware"}`;
  } catch (e) {
    ui.device.textContent = `${io.name}: not answering`;
    say(`The scanner didn't answer: ${e.message}`, "bad");
  }
  refresh();
}

ui.connect.addEventListener("click", async () => {
  try {
    if (state.io) await state.io.close().catch(() => {});
    state.io = null;
    await attach(await WebUsbTransport.request());
  } catch (e) {
    if (e.name !== "NotFoundError") say(e.message, "bad"); // NotFoundError: picker closed
    refresh();
  }
});

// ---- files ----

async function useFirmware(name, data) {
  state.firmware = parseFirmware(data);
  ui.firmwareName.textContent = `${state.firmware.ident} (from ${name})`;
}

function addTemplate(name, data) {
  let t;
  try {
    t = Template.fromUsblog(data, name);
  } catch {
    return `${name}: not a scan, skipped`;
  }
  if (t.deep) return `${name}: 16-bit, skipped (16-bit scans hang the scanner)`;
  if (t.xres !== t.yres) return `${name}: unequal x and y resolution, skipped`;
  const have = state.templates.get(t.yres);
  if (SUPPORTED.includes(t.yres)) return `${name}: ${t.yres} dpi is built in, template not needed`;
  if (!have || (have.grey && !t.grey)) state.templates.set(t.yres, t);
  return null;
}

function showTemplates(notes = []) {
  const extra = [...state.templates.keys()].sort((a, b) => a - b);
  ui.templatesList.textContent = extra.length
    ? extra.map((d) => `${d} dpi ${state.templates.get(d).grey ? "grey" : "colour"}`).join(", ")
    : "none";
  if (notes.length) log(notes.join("\n"));
  const keep = Number(ui.dpi.value) || SUPPORTED[0];
  const dpis = [...new Set([...SUPPORTED, ...extra])].sort((a, b) => a - b);
  ui.dpi.replaceChildren(...dpis.map((d) => new Option(`${d} dpi${SUPPORTED.includes(d) ? "" : " (template)"}`, d, false, d === keep)));
  refresh();
}

ui.firmware.addEventListener("change", async () => {
  const f = ui.firmware.files[0];
  if (!f) return;
  try {
    say("Reading the firmware…");
    const data = await findFirmware(await f.arrayBuffer());
    await useFirmware(f.name, data.buffer);
    await store("put", { name: f.name, data: data.buffer }, "firmware");
    say("Firmware ready.", "ok");
  } catch (e) {
    say(e.message, "bad");
  }
});

ui.templates.addEventListener("change", async () => {
  const notes = [];
  for (const f of ui.templates.files) {
    const data = await f.arrayBuffer();
    const note = addTemplate(f.name, data);
    if (note) notes.push(note);
    else await store("put", { name: f.name, data }, "template:" + f.name);
  }
  showTemplates(notes);
});

ui.forget.addEventListener("click", async () => {
  await store("clear");
  state.firmware = null;
  state.templates.clear();
  ui.firmwareName.textContent = "none";
  showTemplates();
  say("Stored files forgotten.");
});

ui.dpi.addEventListener("change", refresh);

ui.preset.addEventListener("change", () => {
  ui.areaMm.hidden = ui.preset.value !== "custom";
});

// ---- scanning ----

function paint(ctx, { top, rows, data, width, channels }) {
  const img = ctx.createImageData(width, rows);
  const px = img.data;
  for (let i = 0, n = width * rows; i < n; i++) {
    const s = i * channels;
    px[i * 4] = data[s];
    px[i * 4 + 1] = data[channels === 3 ? s + 1 : s];
    px[i * 4 + 2] = data[channels === 3 ? s + 2 : s];
    px[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, top);
}

// One scan with the settings in the panel, painted into `canvas` as rows arrive.
// `onStatus(text)` reports what's happening. Returns {width, height, seconds}.
async function performScan(canvas, onStatus, onFraction = () => {}) {
  const dpi = Number(ui.dpi.value);
  const template = state.templates.get(dpi);
  if (!state.io) throw new Error("Connect the scanner first.");
  if (!SUPPORTED.includes(dpi) && !template) throw new Error(`No way to scan at ${dpi} dpi.`);
  const io = state.io;
  const before = await status(io);
  if (before[0] & 0x40) {
    // busy before we've asked for anything: an earlier scan never finished
    throw new Error("The scanner is stuck from an earlier scan (status busy). Switch it off and on, then Connect and scan again.");
  }
  if (!isLoaded(before)) {
    if (!state.firmware) throw new Error("The scanner needs its firmware: pick Epson's driver download first.");
    onStatus("Uploading firmware…");
    await upload(state.firmware, io);
    state.levels = null; // power-cycled: measure again
    log(`firmware uploaded: ${state.firmware.ident}`);
    ui.device.textContent = `${io.name}: firmware running`;
  }
  const area = ui.preset.value === "full"
    ? fullBed(dpi)
    : fromMm(dpi, +ui.left.value, +ui.top.value, +ui.width.value, +ui.height.value);
  const t = SUPPORTED.includes(dpi) ? build(dpi, area, { grey: ui.mode.value === "grey" }) : retarget(template, area);
  log(`scan: ${t.width} x ${t.height} px at ${dpi} dpi, ${t.grey ? "grey" : "colour"}, from ${t.name}`);

  canvas.width = t.width;
  canvas.height = t.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, t.width, t.height);

  onStatus("Warming up…");
  const started = performance.now();
  let imaging = false;
  const levels = state.levels && Date.now() - state.levels.at < LEVELS_FRESH_MS ? state.levels.data : null;
  if (levels) log("reusing the analog levels measured earlier");
  const replayer = new Replayer(t, io, {
    levels,
    log,
    onRows: (r) => {
      if (!imaging) {
        imaging = true;
        onStatus("Scanning…");
      }
      paint(ctx, r);
      onFraction((r.top + r.rows) / t.height);
    },
    onProgress: (i, n) => {
      if (!imaging) onFraction((0.15 * i) / n); // setup and calibration: the first sliver
    },
  });
  await replayer.run();
  if (!levels) state.levels = { data: replayer.afe, at: Date.now() };
  onFraction(1);
  return { width: t.width, height: t.height, seconds: (performance.now() - started) / 1000 };
}

ui.scan.addEventListener("click", async () => {
  state.scanning = true;
  refresh();
  ui.save.disabled = true;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  ui.placeholder.hidden = true;
  try {
    const r = await performScan(ui.canvas, (text) => say(text), (f) => (ui.progress.value = f));
    say(`Done: ${r.width} x ${r.height} px in ${r.seconds.toFixed(1)} s.`, "ok");
    ui.save.disabled = false;
  } catch (e) {
    say(`Scan failed: ${e.message}`, "bad");
    log(`error: ${e.stack || e.message}`);
  } finally {
    state.scanning = false;
    refresh();
  }
});

// ---- booth mode ----

const booth = {
  el: $("booth"), canvas: $("booth-canvas"), count: $("booth-count"), hint: $("booth-hint"),
  status: $("booth-status"), go: $("booth-go"), exit: $("booth-exit"), start: $("booth-start"),
  rotate: $("booth-rotate"), countdown: $("booth-countdown"), folder: $("booth-folder"), folderName: $("booth-folder-name"),
  dir: null, // a folder handle from showDirectoryPicker, if the user picked one
  busy: false,
};

// A copy of `src` turned clockwise by `deg`, for saving upright.
function turned(src, deg) {
  if (!deg) return src;
  const c = document.createElement("canvas");
  const side = deg % 180 !== 0;
  c.width = side ? src.height : src.width;
  c.height = side ? src.width : src.height;
  const ctx = c.getContext("2d");
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boothScan() {
  if (booth.busy || state.scanning) return;
  booth.busy = state.scanning = true;
  booth.go.disabled = true;
  refresh();
  try {
    for (let n = Number(booth.countdown.value); n > 0; n--) {
      booth.hint.hidden = true;
      booth.count.hidden = false;
      booth.count.textContent = n;
      await wait(1000);
    }
    booth.count.hidden = true;
    booth.hint.hidden = true;
    const deg = Number(booth.rotate.value);
    booth.canvas.style.transform = deg ? `rotate(${deg}deg)` : "";
    booth.canvas.classList.toggle("turned", deg % 180 !== 0);
    const r = await performScan(booth.canvas, (text) => (booth.status.textContent = text === "Scanning…" ? "Hold still…" : text));
    booth.status.textContent = "Done!";
    log(`booth scan: ${r.width} x ${r.height} px in ${r.seconds.toFixed(1)} s`);
    if (booth.dir) await savePhoto(turned(booth.canvas, deg));
  } catch (e) {
    booth.status.textContent = `Scan failed: ${e.message}`;
    log(`error: ${e.stack || e.message}`);
  } finally {
    booth.busy = state.scanning = false;
    booth.go.disabled = false;
    refresh();
  }
}

async function savePhoto(canvas) {
  const name = `scan-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jpg`;
  try {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92));
    const file = await booth.dir.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    await w.write(blob);
    await w.close();
    log(`saved ${name}`);
  } catch (e) {
    log(`couldn't save ${name}: ${e.message}`);
  }
}

booth.folder.addEventListener("click", async () => {
  if (!window.showDirectoryPicker) {
    booth.folderName.textContent = "this browser can't save to folders; use Save PNG";
    return;
  }
  try {
    booth.dir = await window.showDirectoryPicker({ mode: "readwrite" });
    booth.folderName.textContent = `saving to ${booth.dir.name}/`;
  } catch {
    /* picker closed */
  }
});

booth.start.addEventListener("click", async () => {
  booth.el.hidden = false;
  document.body.style.overflow = "hidden";
  booth.hint.hidden = false;
  booth.status.textContent = "";
  try {
    await booth.el.requestFullscreen();
  } catch {
    /* fullscreen refused: the overlay still covers the window */
  }
});

function leaveBooth() {
  if (booth.busy) return;
  booth.el.hidden = true;
  document.body.style.overflow = "";
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

booth.go.addEventListener("click", boothScan);
booth.exit.addEventListener("click", leaveBooth);
document.addEventListener("keydown", (e) => {
  if (booth.el.hidden) return;
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    boothScan();
  } else if (e.key === "Escape") {
    leaveBooth();
  }
});
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !booth.el.hidden && !booth.busy) leaveBooth();
});

ui.save.addEventListener("click", () => {
  ui.canvas.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `v500-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }, "image/png");
});

// ---- start ----

async function start() {
  if (!WebUsbTransport.supported) {
    ui.unsupported.hidden = false;
    ui.connect.disabled = true;
  } else {
    navigator.usb.addEventListener("disconnect", (e) => {
      if (state.io && e.device === state.io.device) {
        state.io = null;
        ui.device.textContent = "Disconnected";
        refresh();
      }
    });
    try {
      const io = await WebUsbTransport.remembered();
      if (io) await attach(io);
    } catch (e) {
      log(`couldn't reopen the scanner: ${e.message}`);
    }
  }

  const fw = await store("get", "firmware");
  if (fw) await useFirmware(fw.name, fw.data).catch(() => {});
  const keys = (await store("getAllKeys")) ?? [];
  const notes = [];
  for (const key of keys.filter((k) => String(k).startsWith("template:"))) {
    const f = await store("get", key);
    const note = f && addTemplate(f.name, f.data);
    if (note) notes.push(note);
  }
  showTemplates(notes);
  refresh();
}

start();
