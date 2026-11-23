# Epson Perfection V500 Photo: our own driver, and a scan booth

Research notes, protocol notes and code for the V500 (sold in Japan as the
GT-X770).

| Path | What |
|---|---|
| `v500/` | our driver: the scanner interface, a fake backend, and the firmware loader |
| `booth/` | the party scan booth: a FastAPI server and an iPad web page |
| `web/` | the driver in plain JavaScript, and a page that scans over WebUSB |
| `tools/trace.c` | runs Epson's plugin against a fake scanner and logs its USB traffic |
| `PROTOCOL.md` | what we know about the USB protocol |
| `DESIGN.md` | the driver phases and the booth design |

## Scanning from the browser (WebUSB)

`web/` is the whole driver in dependency-free JavaScript, and a page that
uses it. It works in Chrome or Edge on a computer: iPads and Safari have no
WebUSB. On Linux, install the udev rule below first.

The easiest way: open **`web/dist/v500-scanner.html`**, one self-contained
file, by double-clicking it. No server, no install. (Or serve `web/` with
`python3 -m http.server` and open <http://localhost:8000>; WebUSB needs
localhost, https or a local file.)

Click Connect and pick the scanner. The first time, click **Get it from
Epson** (Epson's free Linux driver, 650 KB) and drop the download on the
page. The page takes the firmware out of it and keeps it in the browser for
next time. (The page can't fetch it from Epson by itself: Epson's server
doesn't allow other sites to read it, and Epson's licence forbids shipping
the firmware with the page.)

Then **Save a copy with the firmware built in**: that `v500-scanner.html`
works on any computer with Chrome or Edge with nothing to pick or install,
straight from a USB stick. It's for your own computers only: don't post it
publicly. A test makes sure the copy in this repo never holds firmware. Choose a resolution (200, 400 or 800 dpi),
colour or grey, and an area, then click Scan. The image paints as the head
moves. No capture of Epson's driver is needed. Templates
(`captures/<ts>/*.usblog`) are optional and only add resolutions the page
can't build yet.

**Booth mode** turns the page into the photo booth itself, no server or
iPad needed. Settings (remembered in the browser): how to turn the image
for the vertical mount, a countdown, a look (natural, black & white, high
contrast, photocopy), a white frame with a caption and the date, printing
every photo, a wipe-the-glass reminder, and a folder to save photos in.
Start booth gives a full-screen view with a big Scan button:

- The scanner's front buttons, Space or Enter scan, so guests needn't touch
  a screen and a USB foot pedal works. Countdown beeps, "hold still", a
  chime when done. Escape cancels a scan or leaves.
- A strip of recent photos; "Open slideshow window" shows them on a second
  screen, newest first.
- The computer stays awake (Wake Lock). The lamp is left to the scanner:
  it needs no warm-up (a scan after it was off 4 minutes is as fast).
- If the scanner is unplugged or stuck, a full-screen message says what to
  do, and the booth resumes by itself when it's back. A cancelled or failed
  scan is aborted on the scanner, so it doesn't stay stuck.
- Operator panel (press O, or tap the top-left corner three times): photo
  and error counts, recalibrate, "glass wiped", delete this session's
  photos, leave.

For an unattended machine, run Chrome with `--kiosk --kiosk-printing` (full
screen, prints without a dialog). Any laptop, mini PC or Android
tablet with Chrome can run it. iPads can't, because Safari has no WebUSB.

The page scans faster than Epson's driver: a 60 x 40 mm area at 200 dpi
takes 2.6 s instead of 7.0, with the first rows after 1.8 s (PROTOCOL.md,
"Scanning faster than Epson's driver"). It reuses the analog levels and
the calibration of an earlier scan for up to 10 minutes, and with Fast
scanning on (the default) it uses the shortest line period the sensor
allows.

`web/test/sim.html` runs the same page against a simulated scanner that
replays a capture (serve `epson_v500/` and open
`/web/test/sim.html?template=/captures/<ts>/02-color-200-full.usblog`). The
JS tests run with `cd web && node --test`; `tests/test_web.py` checks the JS
driver against the Python one on every capture, byte for byte. After
changing `web/`, rebuild the single file with `node web/tools/build.mjs`
(a test checks it is up to date).

## Running the booth

```sh
cd epson_v500
pip install -e '.[dev]'
python -m pytest                  # no scanner, no network needed
python -m booth                   # http://<host>:8000, open it on the iPad
```

| Variable | Default | Meaning |
|---|---|---|
| `BOOTH_SCANNER` | `fake` | backend: `fake`, or `replay` for the real scanner |
| `BOOTH_TEMPLATES` | none | `replay`: folder of captures of Epson's driver, one per dpi |
| `BOOTH_FIRMWARE` | none | `replay`: your `esfw7C.bin`, uploaded after a power cycle |
| `BOOTH_DPI` | `150` | scan resolution |
| `BOOTH_AREA` | full bed | `replay`: scan area in mm, `left,top,width,height` |
| `BOOTH_ROTATE` | `0` | degrees clockwise to turn scans upright, for the vertical mount |
| `BOOTH_PHOTOS_DIR` | `photos` | where scans are saved |
| `BOOTH_FAKE_SECONDS` | `8` | how long a fake scan takes |
| `BOOTH_FAKE_IMAGES` | none | folder of JPEGs for the fake scanner to replay |

On the iPad, open the page in Safari, then Share > Add to Home Screen. Turn
on Guided Access to lock the iPad to the app.

### With the real scanner

SANE's udev rules don't list `04b8:0130`, so the device node is root-only.
Install our rule once, then unplug and replug the scanner:

```sh
sudo install -m 644 udev/60-epson-v500.rules /etc/udev/rules.d/
sudo udevadm control --reload
```

Then check it answers, and upload the firmware (bring your own `esfw7C.bin`):

```sh
python -m v500.firmware --status            # status query only, changes nothing
python -m v500.firmware /path/to/esfw7C.bin  # upload, then confirm by status
```

To scan with our own code, replay a capture of Epson's driver (see
"Capturing" below) as a template:

```sh
python -m v500.replay captures/<ts>/02-color-200-full.usblog scan.png --firmware /path/to/esfw7C.bin
python -m v500.replay captures/<ts>/02-color-200-full.usblog face.png --area 20 30 150 100   # mm
```

Before firmware, the scanner enumerates as `04b8:0130` "EPSON Scanner",
USB 2.0 high speed, one vendor-specific interface with bulk endpoints `0x81`
in and `0x02` out, 512-byte packets.

### Capturing Epson's driver at work

To learn the commands after the firmware upload, run Epson's own driver once
and record the USB traffic. The driver runs in an Ubuntu 22.04 container, and
the host records with usbmon. Power-cycle the scanner first, then:

```sh
sudo tools/capture/capture.sh /path/to/iscan-gt-x770-bundle-2.30.4.x64.deb.tar.gz
```

It lists the scanner, then scans the full bed at 75 and 300 dpi. Each step
writes a `.pcap` (open it in Wireshark), an epkowa debug log and the image to
`captures/<timestamp>/`. The pcaps hold Epson's firmware bytes, so `captures/`
is gitignored.

## What the scanner is

| Fact | Value | Source |
|---|---|---|
| USB ID | `04b8:0130` (V500 Photo and GT-X770 share it) | SANE `doc/descriptions/epson2.desc` |
| Open-source SANE status | `unsupported`: "supported by the epkowa backend plus non-free interpreter" | same |
| Firmware blob | `esfw7C.bin`, sha1 `2230ef57a121591f6c69efedbefac7f42ccdff40` | epson-esci `BUNDLES` table |
| Vendor package | `iscan-gt-x770-bundle-2.30.4.x64.deb.tar.gz`, sha256 `5c10ccc8…3181e`, 666,703 bytes | same |
| Package URL | `https://download2.ebz.epson.net/iscan/plugin/gt-x770/deb/x64/` | same |
| Epson Scan 2 | does not support this model | Arch forum reports |

There is no firmware in the scanner's flash. The host uploads `esfw7C.bin`
each time the scanner powers on. The scanner keeps its USB address afterwards;
the status query is what shows the firmware is running.
Until that upload happens the scanner looks dead: the LED blinks and every
bulk transfer times out.

## The driver stack today

```
scanimage / GUI
  └─ SANE epkowa backend (iscan, mostly GPL)
       └─ libesci-interpreter-gt-x770.so   ← closed, x86/x86-64 only
            ├─ uploads esfw7C.bin
            └─ USB I/O to the scanner
```

The registry file `/var/lib/iscan/interpreter` links the USB ID to the plugin
and the firmware path. If that line is missing, every USB transfer times out.

## What's inside the plugin (from static analysis)

The bundle downloaded with a matching sha256. It holds `iscan` 2.30.4,
`iscan-data` 1.39.2 and `iscan-plugin-gt-x770` 2.1.3. The plugin itself is
`/usr/lib/iscan/libesint7C.so.2.0.1`: a stripped x86-64 C++ library of 320 KB.

**The plugin interface is small.** The epkowa backend `dlsym`s these and
nothing else:

| Symbol | Shape (from disassembly) | Role |
|---|---|---|
| `int_init` | `bool (int fd, read_cb, write_cb)` | stores the USB callbacks and builds the emulator |
| `int_write` / `int_read` | `(buf, len)` | ESC/I commands in, ESC/I replies and image data out |
| `int_fini` | `void ()` | tears down |
| `int_power_saving_mode` | | lamp/sleep timer |
| `function_s_0` / `function_s_1` | `(int,int,int,int,double*)` / `(u8*,u8*,int,int,double*,u8)` | image helpers the backend calls |

The backend also probes for `int_init_with_ctrl`.

**The plugin runs ESC/I on the host and drives the hardware directly.** Its
symbols are obfuscated (`esint7C_SYMBOL_NNN`), but the C++ mangling kept the
struct names: `stESC_CMD`, `stScanning_Param`, `stMotor_Control`,
`stCCD_Time`, `stADC`, `stGainTable_Param`, `stALOCTable_Param`,
`stShading`, `stShift`, `stSH_SETTING`. So once the firmware is loaded, the
scanner is a low-level device.

That means an open driver has to rebuild all of these:
- motor control
- sensor (CCD) timing
- analog front-end gain and offset (the ADC)
- shading calibration
- RGB line-shift correction

This is the genesys-backend kind of job, not a firmware loader.

**The firmware is plain data, not encrypted.** `esfw7C.bin` is 65,793 bytes
(0x10101), entropy 6.1 bits/byte, and contains the string
`EPSON   GT-X770         1.02`. The plugin loads it itself, from
`$ISCAN_FW_DIR/esfw7C.bin` or else `/usr/share/iscan/esfw7C.bin`. Its CPU
architecture is not identified yet.

The plugin only reaches the scanner through the two callbacks the host passes
to `int_init`. That gives us a clean place to tap the traffic: our own host
program loads the plugin, hands it logging callbacks, and records every USB
transfer next to the ESC/I command that caused it.

## Options

**A. Use the vendor stack, and share the scanner over the network (works today).**
Use an x86-64 Linux box or VM with `iscan`, `iscan-data` and the gt-x770
plugin. [epson-esci](https://github.com/Davan-Etelamaki/epson-esci) automates
the fetch and the install. Then share the scanner through `saned`, or through
an eSCL/AirScan server such as AirSane. Macs and phones then see it as a
driverless network scanner. On a Raspberry Pi the whole SANE process would
have to run under box64, which nobody has tested.

**B. Write an open driver (the real "custom driver").**
1. Get A working on x86 and record USB traffic with `usbmon` and Wireshark:
   the firmware upload, a preview, a full scan, and the transparency unit.
2. Open the plugin `.so` in Ghidra to read the command set and the image
   pipeline.
3. Write a libusb SANE backend. The user supplies `esfw7C.bin` from their own
   Epson download, the same way the `snapscan` backend handles firmware.

**C. Custom firmware on the scanner.** The firmware is uploaded on every power
cycle and nothing is flashed, so running our own code on the scanner's CPU
can't brick it. Step one is to identify the CPU architecture in `esfw7C.bin`.
This is speculative.

## Licensing

Epson's EULA forbids redistributing the plugin and the firmware. Do not commit
the `.so`, `esfw7C.bin` or the bundle to this repo. Commit URLs, checksums and
our own notes and code only. Analysing files you downloaded yourself for
hardware you own falls under the EULA's personal-use grant.

## Next steps

- [x] Download the bundle, check its sha256, and do a first static pass on the plugin.
- [x] Trace harness (`tools/trace.c`): captured the firmware upload without
      hardware. See [PROTOCOL.md](PROTOCOL.md).
- [x] Trace with the real scanner: a full 200 dpi scan, every transfer with
      full data (`tools/capture/`). First notes in [PROTOCOL.md](PROTOCOL.md).
- [x] Decode the raw image data (`v500/raw.py`): colour and grey, 200 to 800 dpi.
- [x] Calibration maths (`v500/calibration.py`) and a template-replay driver
      (`v500/replay.py`) that scans without Epson's plugin; tested against
      a simulated scanner.
- [x] First replay scan on the real scanner: 200 dpi colour, full bed, firmware
      uploaded by our code. It matches Epson's scan of the same page to about 1
      level darker on average (mean absolute difference 5.5, mostly noise).
- [x] Any scan area at a template's resolution (`v500/geometry.py`):
      checked on the real scanner against Epson's scan of the same area.
- [x] Epson's packed shading table and the `1e 41` bytes that describe it,
      from static analysis of the plugin.
- [x] WebUSB page (`web/`): the driver in plain JavaScript; matches the
      Python byte for byte on every capture, runs end to end on a simulated
      scanner.
- [x] Scans without any capture (`web/v500/protocol.js`), checked on the
      real scanner through the JS driver: 200 dpi colour and grey, 400 dpi
      (also 203 mm wide), 800 dpi (also a padded 1,288 px width).
- [x] Firmware straight from Epson's download (`web/v500/bundle.js`),
      uploaded to the real scanner by the JS driver.
- [ ] First WebUSB scan on the real scanner, from the page.
- [x] 1600 dpi with no capture: values from the plugin's tables (static
      analysis), checked on the real scanner.
- [x] Open firmware loader (pyusb): works on hardware, no Epson code involved.
- [ ] Identify the CPU architecture of `esfw7C.bin`.
- [ ] The driver plan and the photo booth design are in [DESIGN.md](DESIGN.md).
