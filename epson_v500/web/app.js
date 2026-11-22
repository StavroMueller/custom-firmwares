// The scanner page: connect over WebUSB, upload firmware, scan, paint rows live.

import { parseFirmware, status, isLoaded, upload } from "./v500/firmware.js";
import { fromMm, fullBed, retarget } from "./v500/geometry.js";
import { Replayer, Template } from "./v500/replay.js";
import { WebUsbTransport } from "./v500/webusb.js";

const $ = (id) => document.getElementById(id);
const ui = {
  connect: $("connect"), device: $("device"), firmware: $("firmware"), firmwareName: $("firmware-name"),
  templates: $("templates"), templatesList: $("templates-list"), forget: $("forget"),
  dpi: $("dpi"), preset: $("area-preset"), areaMm: $("area-mm"),
  left: $("left"), top: $("top"), width: $("width"), height: $("height"),
  scan: $("scan"), save: $("save"), progress: $("progress"), status: $("status"), log: $("log"),
  canvas: $("canvas"), placeholder: $("placeholder"), unsupported: $("unsupported"),
};

const state = {
  io: null,
  firmware: null, // parsed esfw7C.bin
  templates: new Map(), // dpi -> Template (colour, 8-bit)
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
  const ready = state.io && state.templates.size && !state.scanning;
  ui.scan.disabled = !ready;
  ui.connect.disabled = state.scanning;
  for (const el of [ui.firmware, ui.templates, ui.dpi, ui.preset, ui.left, ui.top, ui.width, ui.height, ui.forget]) {
    el.disabled = state.scanning;
  }
}

// ---- scanner ----

async function attach(io) {
  state.io = io;
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
  ui.firmwareName.textContent = `${name}: ${state.firmware.ident}`;
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
  if (!have || (have.grey && !t.grey)) state.templates.set(t.yres, t);
  return null;
}

function showTemplates(notes = []) {
  const dpis = [...state.templates.keys()].sort((a, b) => a - b);
  ui.templatesList.textContent = dpis.length
    ? dpis.map((d) => `${d} dpi ${state.templates.get(d).grey ? "grey" : "colour"}`).join(", ")
    : "none";
  if (notes.length) log(notes.join("\n"));
  const keep = Number(ui.dpi.value);
  ui.dpi.replaceChildren(...dpis.map((d) => new Option(`${d} dpi`, d, false, d === keep)));
  refresh();
}

ui.firmware.addEventListener("change", async () => {
  const f = ui.firmware.files[0];
  if (!f) return;
  try {
    const data = await f.arrayBuffer();
    await useFirmware(f.name, data);
    await store("put", { name: f.name, data }, "firmware");
    say("Firmware file ready.", "ok");
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

ui.scan.addEventListener("click", async () => {
  const dpi = Number(ui.dpi.value);
  const template = state.templates.get(dpi);
  if (!template || !state.io) return;
  state.scanning = true;
  refresh();
  ui.save.disabled = true;
  ui.progress.hidden = false;
  ui.progress.value = 0;
  try {
    const io = state.io;
    if (!isLoaded(await status(io))) {
      if (!state.firmware) throw new Error("The scanner needs its firmware: pick your esfw7C.bin first.");
      say("Uploading firmware…");
      await upload(state.firmware, io);
      log(`firmware uploaded: ${state.firmware.ident}`);
      ui.device.textContent = `${io.name}: firmware running`;
    }
    const area = ui.preset.value === "full"
      ? fullBed(dpi)
      : fromMm(dpi, +ui.left.value, +ui.top.value, +ui.width.value, +ui.height.value);
    const t = retarget(template, area);
    log(`scan: ${t.width} x ${t.height} px at ${dpi} dpi from ${template.name}`);

    ui.canvas.width = t.width;
    ui.canvas.height = t.height;
    ui.placeholder.hidden = true;
    const ctx = ui.canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, t.width, t.height);

    say("Warming up and calibrating…");
    const started = performance.now();
    let imaging = false;
    const replayer = new Replayer(t, io, {
      log,
      onRows: (r) => {
        if (!imaging) {
          imaging = true;
          say("Scanning…");
        }
        paint(ctx, r);
        ui.progress.value = (r.top + r.rows) / t.height;
      },
      onProgress: (i, n) => {
        if (!imaging) ui.progress.value = (0.15 * i) / n; // setup and calibration: the first sliver
      },
    });
    await replayer.run();
    ui.progress.value = 1;
    say(`Done: ${t.width} x ${t.height} px in ${((performance.now() - started) / 1000).toFixed(1)} s.`, "ok");
    ui.save.disabled = false;
  } catch (e) {
    say(`Scan failed: ${e.message}`, "bad");
    log(`error: ${e.stack || e.message}`);
  } finally {
    state.scanning = false;
    refresh();
  }
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
