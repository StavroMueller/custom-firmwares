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

- **Known:** CPU, memory map, flash and RAM parts, LCD controllers, USB
  chip, updater boot flow. See `HARDWARE.md`.
- **Have:** original AlphaSmart OS source (Mar 2000, Apr 2000, May 2003
  snapshots), prebuilt binaries, the Windows simulator project, and the
  official ASM 2.3 updater.
- **Not yet done:** a flash dump from our own unit, a working toolchain
  build, any code running on hardware.

## Getting the source discs

```sh
pip install pycdlib
tools/fetch_archive.sh
```

The discs are third-party copyrighted (Intelligent Peripheral Devices /
AlphaSmart Inc., 1998–2003, plus licensed code from Usable Software Corp,
SDS and Wintertree). They stay out of git; `SOURCES.md` covers why.

## Plan

1. **Applet on stock OS.** Build a betawise "hello world" `.OS3KApp`, load it
   with AlphaSmart Manager 2, confirm it runs. Proves the toolchain and the
   load path with zero brick risk.
2. **Flash dump.** Read our unit's 1 MB flash (updater protocol or applet)
   and diff it against the MAME dump and the prebuilt binaries.
3. **Emulator bench.** Get MAME's `asma3k` driver past its early-boot hang
   (suspected DragonBall-EZ core bug) so OS work can be tested off-device.
4. **Replacement OS.** Only after 1–3, and only once the recovery path in
   `SOFTWARE.md` has been tested on the real unit.
