// Booth screen. Server protocol: see booth/app.py.
"use strict";

const COUNTDOWN_SECONDS = 3;
const RESULT_TIMEOUT_MS = 90_000; // go back to the attract screen if nobody taps

const $ = (id) => document.getElementById(id);
const canvas = $("canvas");
const ctx = canvas.getContext("2d");

let current = null;       // the scan being received: { id, painted }
let idleTimer = null;
let countingDown = false;

// --- screens ---------------------------------------------------------------

function show(name) {
  for (const screen of document.querySelectorAll(".screen")) {
    screen.hidden = screen.id !== name;
  }
  clearTimeout(idleTimer);
  if (name === "result") idleTimer = setTimeout(() => show("attract"), RESULT_TIMEOUT_MS);
  if (name === "gallery") loadGallery();
}

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => (el.hidden = true), 4000);
}

// --- starting a scan --------------------------------------------------------

async function startScan() {
  if (countingDown) return;
  countingDown = true;
  show("countdown");
  for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
    $("count").textContent = n;
    await sleep(1000);
  }
  countingDown = false;

  const response = await fetch("/api/scan", { method: "POST" });
  if (response.status === 409) {
    toast("Already scanning, hang on!");
  } else if (!response.ok) {
    toast("Scanner trouble, try again");
    show("attract");
  }
  // On success the server's scan_started event switches every screen over.
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- live scan over the WebSocket ------------------------------------------

function onEvent(event) {
  switch (event.type) {
    case "scan_started":
      current = { id: event.id, painted: 0 };
      canvas.width = event.width;
      canvas.height = event.height;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      setProgress(0);
      show("scanning");
      break;
    case "scan_done":
      $("result-photo").src = event.url;
      $("result-qr").src = `/api/qr/${event.id}.svg`;
      current = null;
      show("result");
      break;
    case "scan_failed":
      current = null;
      toast("Scan failed: " + event.error);
      show("attract");
      break;
  }
}

async function onStrip(buffer) {
  if (!current) return;
  const header = new DataView(buffer, 0, 8);
  const x = header.getUint32(0, true);
  const y = header.getUint32(4, true);
  const bitmap = await createImageBitmap(new Blob([buffer.slice(8)], { type: "image/jpeg" }));
  ctx.drawImage(bitmap, x, y);
  moveScanLine(x, y, bitmap.width, bitmap.height);
  current.painted += bitmap.width * bitmap.height;
  setProgress(current.painted / (canvas.width * canvas.height));
}

// The glowing bar follows the scan head, whichever way the scanner is mounted.
function moveScanLine(x, y, w, h) {
  const line = $("scan-line");
  const horizontal = w === canvas.width; // strips stack top-to-bottom or bottom-to-top
  line.classList.toggle("vertical", !horizontal);
  if (horizontal) line.style.top = `${((y + h / 2) / canvas.height) * 100}%`;
  else line.style.left = `${((x + w / 2) / canvas.width) * 100}%`;
}

function setProgress(fraction) {
  const percent = Math.min(100, Math.round(fraction * 100));
  $("progress-bar").style.width = `${percent}%`;
  $("progress-text").textContent = `${percent}%`;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = (message) =>
    typeof message.data === "string" ? onEvent(JSON.parse(message.data)) : onStrip(message.data);
  ws.onclose = () => setTimeout(connect, 1000); // the booth Wi-Fi will drop sometimes
}

// --- gallery ----------------------------------------------------------------

async function loadGallery() {
  const photos = await (await fetch("/api/photos")).json();
  const grid = $("gallery-grid");
  grid.replaceChildren(
    ...photos.map((photo) => {
      const img = document.createElement("img");
      img.src = photo.url;
      img.loading = "lazy";
      img.onclick = () => {
        $("result-photo").src = photo.url;
        $("result-qr").src = `/api/qr/${photo.id}.svg`;
        show("result");
      };
      return img;
    }),
  );
  if (!photos.length) grid.textContent = "No scans yet. Be the first!";
}

// --- wiring -----------------------------------------------------------------

$("scan-button").onclick = startScan;
for (const button of document.querySelectorAll("[data-goto]")) {
  button.onclick = () => show(button.dataset.goto);
}
// A Bluetooth foot pedal shows up as a keyboard.
document.addEventListener("keydown", (e) => {
  if ((e.key === " " || e.key === "Enter") && !$("attract").hidden) startScan();
});

connect();
