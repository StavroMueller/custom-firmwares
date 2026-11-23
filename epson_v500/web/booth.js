// Booth mode: the page as a party photo booth, with no server.
//
// Full screen, countdown with beeps, the scanner's own buttons / Space /
// Enter / a foot pedal to scan, effects and a framed caption, a gallery
// strip, a slideshow window for a second screen, printing, saving to a
// folder, and a clear screen when the scanner needs a person.
// An operator panel (press O, or tap the top-left corner three times) has
// the counters and the clean-up buttons.

import { compose, EFFECTS, applyEffect } from "./effects.js";
import { pressedButton, ready, status } from "./v500/device.js";

const $ = (id) => document.getElementById(id);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = "v500-booth-settings";
const GALLERY_SIZE = 24;
const STUCK_AFTER_MS = 20_000; // busy this long while idle: an earlier scan never finished

// ctx: {state, performScan(canvas, onStatus), exclusive(fn), log(line), recalibrate()}
export function setupBooth(ctx) {
  const { state, log } = ctx;
  const el = {
    root: $("booth"), canvas: $("booth-canvas"), photo: $("booth-photo"), count: $("booth-count"),
    hint: $("booth-hint"), status: $("booth-status"), go: $("booth-go"), exit: $("booth-exit"),
    strip: $("booth-strip"), attention: $("booth-attention"), attentionTitle: $("booth-attention-title"),
    attentionText: $("booth-attention-text"), operator: $("booth-operator"), opStats: $("op-stats"),
    corner: $("booth-corner"), printFrame: $("booth-print"),
    // settings in the side panel
    start: $("booth-start"), rotate: $("booth-rotate"), countdown: $("booth-countdown"), effect: $("booth-effect"),
    frame: $("booth-frame"), caption: $("booth-caption"), date: $("booth-date"), print: $("booth-print-each"),
    clean: $("booth-clean"), folder: $("booth-folder"), folderName: $("booth-folder-name"), slideshow: $("booth-slideshow"),
  };
  const booth = {
    open: false, busy: false, dir: null, wakeLock: null, gallery: [], saved: [], slideshow: null,
    scans: 0, failures: 0, lastError: "", sinceClean: 0, needsClean: false, attention: null,
    busySince: 0,
  };

  // ---- settings, remembered in this browser ----

  el.effect.replaceChildren(...Object.entries(EFFECTS).map(([k, v]) => new Option(v, k)));
  const fields = ["rotate", "countdown", "effect", "caption", "clean"];
  const checks = ["frame", "date", "print"];
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS) || "{}");
    for (const f of fields) if (saved[f] != null) el[f].value = saved[f];
    for (const f of checks) if (saved[f] != null) el[f].checked = saved[f];
  } catch { /* storage blocked: defaults */ }
  const remember = () => {
    const s = {};
    for (const f of fields) s[f] = el[f].value;
    for (const f of checks) s[f] = el[f].checked;
    try {
      localStorage.setItem(SETTINGS, JSON.stringify(s));
    } catch { /* storage blocked */ }
  };
  for (const f of [...fields, ...checks]) el[f].addEventListener("change", remember);

  // ---- sound ----

  let audio = null;
  function beep(freq = 880, ms = 120, volume = 0.15) {
    try {
      audio ??= new AudioContext();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq;
      g.gain.setValueAtTime(volume, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + ms / 1000);
    } catch { /* no audio: silent */ }
  }

  // ---- keeping the computer awake ----

  async function keepAwake() {
    try {
      if (booth.open && !booth.wakeLock && "wakeLock" in navigator) {
        booth.wakeLock = await navigator.wakeLock.request("screen");
        booth.wakeLock.addEventListener("release", () => (booth.wakeLock = null));
      }
    } catch (e) {
      log(`couldn't keep the screen awake: ${e.message}`);
    }
  }
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && keepAwake());

  // ---- the "needs a person" screen ----

  const ATTENTION = {
    disconnected: ["Scanner unplugged", "Plug the scanner's USB cable back in. The booth carries on by itself."],
    stuck: ["Scanner needs a restart", "Switch the scanner off, wait 5 seconds, and switch it on again."],
    clean: ["Time to wipe the glass", "Give the scanner glass a quick wipe, then press Scan to carry on."],
  };
  function attention(kind) {
    booth.attention = kind;
    el.attention.hidden = !kind;
    if (kind) {
      [el.attentionTitle.textContent, el.attentionText.textContent] = ATTENTION[kind];
      log(`booth: ${ATTENTION[kind][0]}`);
    }
  }

  // Called by the page when the scanner disappears or comes back.
  ctx.onConnection = (connected) => {
    if (!booth.open) return;
    if (!connected) attention("disconnected");
    else if (booth.attention === "disconnected" || booth.attention === "stuck") attention(null);
  };

  // ---- gallery and slideshow ----

  function addToGallery(blob, name) {
    const url = URL.createObjectURL(blob);
    booth.gallery.unshift({ url, name });
    for (const old of booth.gallery.splice(GALLERY_SIZE)) URL.revokeObjectURL(old.url);
    el.strip.replaceChildren(...booth.gallery.map((p) => {
      const img = new Image();
      img.src = p.url;
      img.alt = p.name;
      img.addEventListener("click", () => showPhoto(p.url));
      return img;
    }));
    updateSlideshow(url);
  }

  function showPhoto(url) {
    el.canvas.hidden = true;
    el.photo.hidden = false;
    el.photo.src = url;
    el.hint.hidden = true;
  }

  // A second window, for a TV: the newest photo, then the recent ones in turn.
  function openSlideshow() {
    const w = window.open("", "v500-slideshow", "popup,width=1280,height=720");
    if (!w) {
      log("the browser blocked the slideshow window; allow pop-ups for this page");
      return;
    }
    w.document.title = "Scan booth";
    w.document.body.style.cssText = "margin:0;background:#000;display:grid;place-items:center;height:100vh;overflow:hidden";
    w.document.body.innerHTML = '<img id="s" style="max-width:100vw;max-height:100vh;transition:opacity .6s">';
    booth.slideshow = { w, index: 0, hold: 0 };
    w.document.body.addEventListener("click", () => w.document.documentElement.requestFullscreen?.().catch(() => {}));
    updateSlideshow();
  }

  function updateSlideshow(newest) {
    const s = booth.slideshow;
    if (!s || s.w.closed) return;
    const img = s.w.document.getElementById("s");
    if (newest) {
      img.src = newest;
      s.index = 0;
      s.hold = Date.now() + 15_000; // show a fresh photo a little longer
    } else if (booth.gallery.length) {
      img.src = booth.gallery[s.index % booth.gallery.length].url;
    }
  }
  setInterval(() => {
    const s = booth.slideshow;
    if (!s || s.w.closed || !booth.gallery.length || Date.now() < s.hold) return;
    s.index = (s.index + 1) % booth.gallery.length;
    updateSlideshow();
  }, 6000);

  // ---- saving and printing ----

  async function save(blob, name) {
    if (!booth.dir) return;
    try {
      const file = await booth.dir.getFileHandle(name, { create: true });
      const w = await file.createWritable();
      await w.write(blob);
      await w.close();
      booth.saved.push(name);
      log(`saved ${name}`);
    } catch (e) {
      log(`couldn't save ${name}: ${e.message}`);
    }
  }

  // Print through a hidden frame. With Chrome's --kiosk-printing flag this
  // goes straight to the default printer, with no dialog.
  function print(url) {
    const doc = el.printFrame.contentDocument;
    doc.open();
    doc.write(`<!doctype html><style>@page{margin:6mm}html,body{margin:0;height:100%}
      img{display:block;max-width:100%;max-height:100%;margin:auto}</style><img src="${url}">`);
    doc.close();
    const img = doc.querySelector("img");
    img.onload = () => el.printFrame.contentWindow.print();
  }

  el.folder.addEventListener("click", async () => {
    if (!window.showDirectoryPicker) {
      el.folderName.textContent = "this browser can't save to folders";
      return;
    }
    try {
      booth.dir = await window.showDirectoryPicker({ mode: "readwrite", id: "v500-booth" });
      el.folderName.textContent = `saving to ${booth.dir.name}/`;
    } catch { /* picker closed */ }
  });
  el.slideshow.addEventListener("click", openSlideshow);

  // ---- a scan ----

  async function scan() {
    if (booth.busy || state.scanning || !booth.open) return;
    if (booth.attention && booth.attention !== "clean") return;
    if (booth.attention === "clean") {
      attention(null);
      booth.sinceClean = 0;
      return; // the press that dismisses the reminder doesn't scan
    }
    if (!state.io) return attention("disconnected");
    booth.busy = state.scanning = true;
    el.go.disabled = true;
    ctx.refresh();
    try {
      for (let n = Number(el.countdown.value); n > 0; n--) {
        el.hint.hidden = true;
        el.count.hidden = false;
        el.count.textContent = n;
        beep(660, 140);
        await wait(1000);
      }
      el.count.hidden = true;
      el.hint.hidden = true;
      beep(990, 220);
      const deg = Number(el.rotate.value);
      el.photo.hidden = true;
      el.canvas.hidden = false;
      el.canvas.style.transform = deg ? `rotate(${deg}deg)` : "";
      el.canvas.classList.toggle("turned", deg % 180 !== 0);
      const r = await ctx.performScan(el.canvas, (text) => (el.status.textContent = text === "Scanning…" ? "Hold still…" : text));
      booth.scans++;
      booth.sinceClean++;
      log(`booth scan ${booth.scans}: ${r.width} x ${r.height} px in ${r.seconds.toFixed(1)} s`);

      // the finished photo: effect, turned upright, framed
      const c2 = el.canvas.getContext("2d");
      const img = c2.getImageData(0, 0, el.canvas.width, el.canvas.height);
      applyEffect(img.data, el.effect.value);
      c2.putImageData(img, 0, 0);
      const date = el.date.checked ? new Date().toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) : "";
      const final = compose(el.canvas, {
        deg, caption: el.frame.checked ? el.caption.value.trim() : "", date: el.frame.checked ? date : "",
        framed: el.frame.checked, makeCanvas: (w, h) => Object.assign(document.createElement("canvas"), { width: w, height: h }),
      });
      const blob = await new Promise((res) => final.toBlob(res, "image/jpeg", 0.92));
      const name = `scan-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.jpg`;
      addToGallery(blob, name);
      showPhoto(booth.gallery[0].url);
      el.status.textContent = "Done!";
      beep(1320, 160);
      await save(blob, name);
      if (el.print.checked) print(booth.gallery[0].url);
      const every = Number(el.clean.value);
      if (every && booth.sinceClean >= every) {
        await wait(4000); // let the guest see their photo first
        attention("clean");
      }
    } catch (e) {
      booth.failures++;
      booth.lastError = e.message;
      el.status.textContent = e.name === "AbortError" ? "Cancelled." : "That didn't work. Try again!";
      log(`booth error: ${e.stack || e.message}`);
      if (/stuck|stayed busy|didn't confirm the abort/.test(e.message)) attention("stuck");
      else if (!state.io) attention("disconnected");
    } finally {
      booth.busy = state.scanning = false;
      el.go.disabled = false;
      ctx.refresh();
      updateOperator();
    }
  }

  // ---- watching the scanner while idle: buttons, stuck ----
  // (The lamp is left to the scanner: a scan after it was off 4 minutes is
  // as fast as one with it on, so there's nothing to gain keeping it lit.)

  async function watch() {
    while (booth.open) {
      if (!booth.busy && state.io) {
        try {
          const now = Date.now();
          const { button, busy } = await ctx.exclusive(async () => {
            const s = await status(state.io);
            const busy = Boolean(s[0] & 0x40);
            return { button: busy ? 0 : await pressedButton(state.io), busy };
          });
          if (busy) {
            booth.busySince ||= now;
            if (now - booth.busySince > STUCK_AFTER_MS && booth.attention !== "stuck") {
              // abort the scan that never finished; ask for a power cycle only if that fails
              try {
                await ctx.exclusive(() => ready(state.io, { log, settleMs: 0 }));
                log("recovered the scanner from an unfinished scan");
                booth.busySince = 0;
              } catch (e) {
                log(e.message);
                attention("stuck");
              }
            }
          } else {
            booth.busySince = 0;
            if (booth.attention === "stuck" || booth.attention === "disconnected") attention(null);
          }
          if (button) {
            log(`scanner button ${button} pressed`);
            scan();
          }
        } catch (e) {
          log(`watching the scanner: ${e.message}`);
          await wait(2000);
        }
      }
      await wait(300);
    }
  }

  // ---- operator panel ----

  function updateOperator() {
    if (el.operator.hidden) return;
    el.opStats.textContent = [
      `${plural(booth.scans, "photo")} this session, ${plural(booth.failures, "failed scan")}`,
      booth.lastError ? `last error: ${booth.lastError}` : "no errors",
      `${booth.saved.length} saved${booth.dir ? ` to ${booth.dir.name}/` : " (no folder chosen)"}`,
      `glass wiped ${plural(booth.sinceClean, "photo")} ago`,
    ].join("\n");
  }
  function toggleOperator() {
    el.operator.hidden = !el.operator.hidden;
    updateOperator();
  }
  let taps = [];
  el.corner.addEventListener("click", () => {
    taps = [...taps.filter((t) => Date.now() - t < 1500), Date.now()];
    if (taps.length >= 3) {
      taps = [];
      toggleOperator();
    }
  });
  $("op-close").addEventListener("click", toggleOperator);
  $("op-recalibrate").addEventListener("click", () => {
    ctx.recalibrate();
    log("operator: the next scan measures the levels and calibration again");
    $("op-recalibrate").textContent = "Next scan recalibrates";
  });
  $("op-cleaned").addEventListener("click", () => {
    booth.sinceClean = 0;
    if (booth.attention === "clean") attention(null);
    updateOperator();
  });
  $("op-delete").addEventListener("click", async () => {
    if (!confirm(`Delete all ${booth.gallery.length} photos from this session${booth.saved.length ? `, including ${booth.saved.length} saved files` : ""}?`)) return;
    for (const name of booth.saved) {
      try {
        await booth.dir.removeEntry(name);
      } catch (e) {
        log(`couldn't delete ${name}: ${e.message}`);
      }
    }
    booth.saved = [];
    for (const p of booth.gallery) URL.revokeObjectURL(p.url);
    booth.gallery = [];
    el.strip.replaceChildren();
    el.photo.hidden = true;
    el.canvas.hidden = true;
    el.hint.hidden = false;
    updateOperator();
  });
  $("op-leave").addEventListener("click", () => {
    el.operator.hidden = true;
    leave();
  });

  // ---- entering and leaving ----

  el.start.addEventListener("click", async () => {
    booth.open = true;
    el.root.hidden = false;
    document.body.style.overflow = "hidden";
    el.hint.hidden = false;
    el.status.textContent = "";
    attention(state.io ? null : "disconnected");
    try {
      await el.root.requestFullscreen();
    } catch { /* fullscreen refused: the overlay still covers the window */ }
    keepAwake();
    watch();
  });

  function leave() {
    if (booth.busy) return;
    booth.open = false;
    el.root.hidden = true;
    document.body.style.overflow = "";
    booth.wakeLock?.release().catch(() => {});
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }

  el.go.addEventListener("click", scan);
  el.exit.addEventListener("click", leave);
  document.addEventListener("keydown", (e) => {
    if (!booth.open) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      scan();
    } else if (e.key === "Escape") {
      if (booth.busy) state.abort?.abort();
      else if (!el.operator.hidden) toggleOperator();
      else leave();
    } else if (e.key === "o" || e.key === "O") {
      toggleOperator();
    }
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && booth.open && !booth.busy && el.operator.hidden) leave();
  });

  return { leave };
}
