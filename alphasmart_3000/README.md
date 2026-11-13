# AlphaSmart 3000 custom firmware

Research toward custom code on the AlphaSmart 3000: first SmartApplets on the
stock OS, then possibly a replacement OS. Nothing has run on hardware yet.

| Path | What |
|---|---|
| `HARDWARE.md` | hardware facts and where each came from (original source, MAME, PCB) |
| `SOFTWARE.md` | OS architecture, applet ABI, toolchain, updater protocol, recovery |
| `SOURCES.md` | every external source, with archive.org IDs, checksums and licensing notes |
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
- **Not yet done:** anything on hardware.

## Getting the source discs

```sh
pip install pycdlib
tools/fetch_archive.sh
```

The discs are third-party copyrighted (Intelligent Peripheral Devices /
AlphaSmart Inc., 1998–2003, plus licensed code from Usable Software Corp,
SDS and Wintertree). They stay out of git; `SOURCES.md` covers why.

## Plan

1. **Read-only host tool.** Python + pyserial/libusb, implementing the
   updater protocol's VERSION, FLASH_NAME, FLASH_SIZE and READ commands.
   Use it to dump our unit's whole flash (512 KB or 1 MB). Nothing gets written, so there's
   no brick risk, and it tells us the machine ID and which OS is installed.
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
