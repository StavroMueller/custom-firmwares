// The scanner page: connect over WebUSB, upload firmware, scan, paint rows live.

import { findFirmware } from "./v500/bundle.js";
import { setupBooth } from "./booth.js";
import { parseFirmware, status, isLoaded, upload } from "./v500/firmware.js";
import { fromMm, fullBed, retarget } from "./v500/geometry.js";
import { build, SUPPORTED } from "./v500/protocol.js";
import { Replayer, Template } from "./v500/replay.js";
import { WebUsbTransport } from "./v500/webusb.js";

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"), device: $("device"), firmware: $("firmware"), firmwareName: $("firmware-name"),
  templates: $("templates"), templatesList: $("templates-list"), forget: $("forget"),
  dpi: $("dpi"), mode: $("mode"), fast: $("fast"), preset: $("area-preset"), areaMm: $("area-mm"),
  left: $("left"), top: $("top"), width: $("width"), height: $("height"),
  scan: $("scan"), cancel: $("cancel"), save: $("save"), progress: $("progress"), status: $("status"), log: $("log"),
  canvas: $("canvas"), placeholder: $("placeholder"), unsupported: $("unsupported"),
};

const state = {
  io: null,
  firmware: null, // parsed esfw7C.bin
  templates: new Map(), // dpi -> Template (colour, 8-bit), for resolutions not built in
  levels: null, // {data, at, key}: analog levels measured by an earlier scan, reused while fresh
  calibration: null, // {key, cal, at}: an earlier scan's calibration, reused for the same window
  abort: null, // AbortController of the scan in progress
  ioLock: Promise.resolve(), // one user of the USB connection at a time
};

// Run `fn` with the scanner to itself: button polls never interleave with a scan.
async function exclusive(fn) {
  const before = state.ioLock;
  let release;
  state.ioLock = new Promise((r) => (release = r));
  await before;
  try {
    return await fn();
  } finally {
    release();
  }
}


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
  $("booth-start").disabled = state.scanning; // the booth waits for the scanner by itself
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
// self-measurement, and reusing the calibration skips the reference reads
// and the lamp off/on (another 1 s). On the real scanner the first rows of a
// 60 x 40 mm scan then appear after 1.8 s instead of 5 s, same image
// quality. Both are measured again after a power cycle and every 10 minutes.
const LEVELS_FRESH_MS = 10 * 60 * 1000;
const fresh = (entry) => entry && Date.now() - entry.at < LEVELS_FRESH_MS;

async function attach(io) {
  state.io = io;
  state.levels = state.calibration = null;
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
function performScan(...args) {
  return exclusive(() => scanNow(...args));
}

async function scanNow(canvas, onStatus, onFraction = () => {}) {
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
    state.levels = state.calibration = null; // power-cycled: measure again
    log(`firmware uploaded: ${state.firmware.ident}`);
    ui.device.textContent = `${io.name}: firmware running`;
  }
  const area = ui.preset.value === "full"
    ? fullBed(dpi)
    : fromMm(dpi, +ui.left.value, +ui.top.value, +ui.width.value, +ui.height.value);
  const fast = ui.fast.checked;
  const t = SUPPORTED.includes(dpi) ? build(dpi, area, { grey: ui.mode.value === "grey", fast }) : retarget(template, area);
  const levelsKey = `${dpi}|${fast}|${t.name}`;
  log(`scan: ${t.width} x ${t.height} px at ${dpi} dpi, ${t.grey ? "grey" : "colour"}, from ${t.name}`);

  canvas.width = t.width;
  canvas.height = t.height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, t.width, t.height);

  onStatus("Warming up…");
  const started = performance.now();
  let imaging = false;
  const levels = fresh(state.levels) && state.levels.key === levelsKey ? state.levels.data : null;
  if (levels) log("reusing the analog levels measured earlier");
  const calibration = fresh(state.calibration) ? state.calibration : null;
  state.abort = new AbortController();
  const replayer = new Replayer(t, io, {
    signal: state.abort.signal,
    levels,
    calibration,
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
  try {
    await replayer.run();
  } finally {
    state.abort = null;
  }
  if (!levels) state.levels = { data: replayer.afe, at: Date.now(), key: levelsKey };
  if (replayer.calibration && replayer.calibration.cal !== calibration?.cal) state.calibration = { ...replayer.calibration, at: Date.now() };
  onFraction(1);
  return { width: t.width, height: t.height, seconds: (performance.now() - started) / 1000 };
}

ui.cancel.addEventListener("click", () => state.abort?.abort());

ui.scan.addEventListener("click", async () => {
  state.scanning = true;
  refresh();
  ui.cancel.hidden = false;
  ui.save.disabled = true;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  ui.placeholder.hidden = true;
  try {
    const r = await performScan(ui.canvas, (text) => say(text), (f) => (ui.progress.value = f));
    say(`Done: ${r.width} x ${r.height} px in ${r.seconds.toFixed(1)} s.`, "ok");
    ui.save.disabled = false;
  } catch (e) {
    if (e.name === "AbortError") say("Scan cancelled.");
    else say(`Scan failed: ${e.message}`, "bad");
    log(`error: ${e.stack || e.message}`);
  } finally {
    state.scanning = false;
    ui.cancel.hidden = true;
    refresh();
  }
});

// ---- booth mode (booth.js) ----

const boothCtx = {
  state, log, exclusive, refresh, performScan,
  // forget the reused levels and calibration: the next scan measures again
  recalibrate: () => (state.levels = state.calibration = null),
  onConnection: () => {},
};
setupBooth(boothCtx);

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
        boothCtx.onConnection(false);
      }
    });
    // plugged back in (or power-cycled): reconnect without a click, since
    // this page was already allowed to use it
    navigator.usb.addEventListener("connect", async (e) => {
      if (state.io || e.device.vendorId !== 0x04b8 || e.device.productId !== 0x0130) return;
      try {
        await attach(await WebUsbTransport.open(e.device));
        log("scanner reconnected");
        boothCtx.onConnection(true);
      } catch (err) {
        log(`couldn't reconnect: ${err.message}`);
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
