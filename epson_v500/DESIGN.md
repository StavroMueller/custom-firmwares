# V500 scan booth: design

Goal: a headless party photo booth. Guests press themselves against the
glass, tap a button on an iPad, and watch their "photo" fill in line by line
as the scan head moves.

## Shape of the system

```
iPad (Safari, home-screen web app, Guided Access)
   │  HTTP + WebSocket over the booth's own Wi-Fi
   ▼
booth host (Linux)
   ├─ booth web app   — one Python process (FastAPI): UI, scan queue, gallery
   └─ v500 driver     — our code; owns the USB device
        └─ Scanner interface: open() · scan(settings) → rows · buttons()
             ├─ PluginBackend  — phase 1: loads Epson's libesint7C.so (x86-64)
             ├─ OpenBackend    — phase 3: our own code, runs anywhere
             └─ FakeBackend    — UI work without hardware
```

The web app depends only on the `Scanner` interface. That interface is the
seam that lets us swap Epson's plugin for our own code without touching the
booth.

## Why a web app, not a native app

- The iPad needs no install: Safari, then Add to Home Screen, and it runs
  full screen.
- The same page works on a Linux laptop, a phone, or a big TV.
- Guided Access (iPadOS Settings > Accessibility) locks the iPad to the app
  so guests can't leave it.
- No build step. Plain HTML, CSS and JS served by the backend, so it stays
  readable and easy to fix at 1am mid-party.

## Driver plan

The plugin turns out to be a full ESC/I emulator that drives the motor, the
sensor and the analog front end itself (see [README.md](README.md)). So
"our own driver" happens in phases. Each phase ships something that works.

| Phase | What we write | What still comes from Epson | Host |
|---|---|---|---|
| 0. Trace harness | A small host program that loads the plugin with logging USB callbacks | plugin + firmware | x86-64 Linux |
| 1. Our driver on top of the plugin | ESC/I command layer, scan loop, rows streamed out; no SANE, no iscan | plugin + firmware | x86-64 Linux |
| 2. Replace the plugin piece by piece | firmware upload → device init → motor → sensor timing → analog gain/offset → shading → RGB line shift | less and less | x86-64 Linux |
| 3. Fully open driver | the last pieces, with the plugin removed | firmware only (each user supplies their own) | anything, incl. Raspberry Pi |

Phase 1 gets the booth working at a party. Phases 2 and 3 are the real
reverse engineering, and they're testable. A golden-image test scans the same
target once through the plugin and once through our code, then diffs the two.
The traces from phase 0 become fixtures for the protocol code.

Language: **Python** (pyusb, numpy, ctypes for the plugin). The data rate is
a few MB per scan, so Python is fast enough. It's the fastest language to
iterate in while reverse engineering, and it keeps the driver and the web app
in one stack. Hot paths can move to numpy, or to a small C extension, if
profiling shows the need.

## Booth flow

1. **Attract**: big "Press your face to the glass, then tap" screen.
2. **Countdown**: 3‑2‑1, while the lamp warms up. Start warm-up on the first
   tap so the countdown hides it.
3. **Scanning**: rows arrive over the WebSocket and paint top to bottom, so
   guests watch the scan "develop".
4. **Result**: keep / retake, plus a QR code that links to the image on the
   booth's local gallery.

Ways to trigger a scan:
- the iPad button
- a USB foot pedal (shows up as a keyboard; best for hands-against-glass poses)
- the scanner's own front buttons, if the protocol exposes their state; to be
  checked in phase 0

## Settings to measure, not guess

- Scan time at 150, 300 and 600 dpi over the full bed vs. a face-sized
  region. Guests have to hold still for the whole pass, so time is the main UX
  constraint.
- Lamp warm-up time, and whether the lamp can stay warm between guests.
- Lid open means ambient light reaches the sensor. Test in party lighting;
  a black hood or a dim corner may be needed.
- "Warp mode": moving during the scan smears the image into a slit-scan. That
  could be a feature.

## Physical setup and safety

The glass is **vertical**: the scanner stands on its edge, like a window
guests press against.

- **The carriage now climbs against gravity.** The motor and belt were tuned
  for flat use. A scan may jitter or stall going up, and run fast coming down.
  Test both mounting orientations, with the hinge up and with the hinge down,
  and pick the one that scans cleanly. Watch for banding and for lines that
  come out squashed or stretched.
- **The image comes out rotated.** The head sweeps vertically, so the booth
  turns each image upright, and the live preview paints in the direction the
  head actually moves. Both depend on the mounting, so they're a config
  setting.
- **Remove the lid.** It hinges open, and the lid with the transparency unit
  is heavy. Taking it off avoids it swinging into someone's head.
- **Bolt it down.** Use a frame that holds the scanner by its body, not its
  glass, rated for people leaning in. Guests push sideways now, not down, so a
  free-standing scanner will tip.
- The platen glass is still not load-bearing. Put up a "press gently" sign.
- The light bar is bright and now shines straight at eye level: tell guests
  to close their eyes.
- Wipe the glass between guests. Wipes go on the stand.
- Use a powered USB connection, not a long chain of hubs.

## Networking

- The booth host runs its own Wi-Fi access point and answers at `booth.local`.
  This doesn't depend on venue Wi-Fi.
- Guests join the booth Wi-Fi to download their photo via the QR code. A
  cloud upload can come later.

## Hardware shopping list (phase 1)

- An x86-64 mini PC (an Intel N100-class box) or any old x86 laptop running
  Linux. The plugin is x86-64 only, so a Raspberry Pi waits for phase 3.
- Optional: a USB foot pedal and a scanner stand.

## Open questions

- Does the carriage scan cleanly when the scanner is on its edge? Which
  mounting orientation works best?
- Does the protocol expose the front-panel buttons?
- What CPU does `esfw7C.bin` target? This matters for the custom-firmware
  side quest.
- Real scan timings, so we can choose the default dpi.
