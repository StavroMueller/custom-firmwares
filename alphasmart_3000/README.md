# AlphaSmart 3000 custom firmware

Research toward custom code on the AlphaSmart 3000: first SmartApplets on the
stock OS, then possibly a replacement OS. Nothing has run on hardware yet.

| Path | What |
|---|---|
| `HARDWARE.md` | hardware facts and where each came from (original source, MAME, PCB) |
| `SOFTWARE.md` | OS architecture, applet ABI, toolchain, updater protocol, recovery |
| `SOURCES.md` | every external source, with archive.org IDs, checksums and licensing notes |
| `tools/as3k/` | read-only host tool for the updater: device info and flash dumps over USB or serial |
| `tools/tests/` | tests for `as3k` against a simulated updater (`python3 -m unittest discover -s tests -t .` from `tools/`) |
| `tools/fetch_archive.sh` | re-downloads and extracts the archive.org discs into `archive/` |
| `tools/extract_iso.py` | ISO 9660 extractor used by the fetch script (needs `pycdlib`) |
| `archive/` | **gitignored.** The extracted discs: original 1998–2003 OS source |

## Status

- **Known:** CPU (MC68EZ328 DragonBall EZ), memory map, every GPIO pin, LCD
  and keyboard wiring, flash layout, the full updater protocol (serial and
  USB), the flash-file format, and a hardware recovery path (EZ328 bootstrap
  mode via a key combo). See `HARDWARE.md` and `SOFTWARE.md`.
- **Have:** original AlphaSmart OS source (Mar 2000, Apr 2000, May 2003
  snapshots), prebuilt binaries with full symbol maps, the Windows simulator
  project, and the official ASM 2.3 updater.
- **Open question:** whether System 3 (the 2005 OS that added loadable
  SmartApplets) loads betawise `.OS3KApp` files. The source discs predate
  System 3; its binaries are inside the unopened ASM 2.3 InstallShield cabs.
- **Written, not yet run on hardware:** `as3k`, the read-only dump tool.

## Getting the source discs

```sh
pip install pycdlib
tools/fetch_archive.sh
```

The discs are third-party copyrighted (Intelligent Peripheral Devices /
AlphaSmart Inc., 1998–2003, plus licensed code from Usable Software Corp,
SDS and Wintertree). They stay out of git; `SOURCES.md` covers why.

## Dumping a unit with `as3k`

**Entering updater mode can wipe the files in the unit's RAM** (the updater
is copied over them; `SOFTWARE.md`). Send every file to a computer first.

```sh
cd tools && pip install -r requirements.txt

# USB: switch the unit from keyboard mode, then talk to the updater
python3 -m as3k usb-switch --files-saved
python3 -m as3k --usb info
python3 -m as3k --usb dump ../dumps/flash.bin --verify

# Serial (left "printer" port, 9600 to start): in AlphaWord press
# Cmd+Ctrl+U, then
python3 -m as3k --serial /dev/ttyUSB0 dump ../dumps/flash.bin --verify
```

The tool only implements VERSION, STATUS, BAUD, FLASH_NAME, FLASH_SIZE and
READ; it has no command that writes, erases or executes anything. Reads are
capped at 50 bytes (the device overflows a buffer past that) and limited to
RAM and flash, never the chip's registers. On Linux, USB access may need a
udev rule or `sudo`.

Unverified on hardware: the serial Cmd+Ctrl+U listener and the USB LED
switch are confirmed in the 2000–2003 source; whether System 3 keeps them
is unknown.

## Plan

1. **Dump our unit** with `as3k` (written; needs a hardware run). Nothing
   gets written, so there's no brick risk, and it tells us the machine ID and
   which OS is installed.
2. **Prove recovery.** Enter bootstrap mode (key combo), handshake over the
   printer port, and load the stock RAM updater. Only after this works do we
   write anything.
3. **Hello world from RAM.** m68k-elf-gcc build linked for RAM, loaded with
   SEND_BLOCK + EXECUTE. Drives the LCD and keyboard directly.
4. **Applet path.** Either a betawise `.OS3KApp` on System 3 (if the open
   question resolves yes), or our own image flashed as an "applet" at
   0x420030, signature last, sectors 0–3 never touched.
5. **Emulator bench.** Get MAME's `asma3k` past its early-boot hang and fix
   its LCD geometry, so OS work can be tested off-device.
6. **Replacement OS.** Written fresh against our docs, shipped as an
   applet so the stock Startup Manager and updater stay as the safety net.
