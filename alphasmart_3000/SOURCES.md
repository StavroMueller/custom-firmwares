# Sources

## archive.org discs (fetched by `tools/fetch_archive.sh`)

| Local dir | archive.org item | Disc date | What's on it | sha256 |
|---|---|---|---|---|
| `archive/as-2-2000/` | [`as-2-2000`](https://archive.org/details/as-2-2000) | 2000-03-02 | "AlphaSmart Code Drop": AS3000 OS module sources, apps (AlphaWord, Diagnostics, Flasher, Updater), hardware tests, USB host updater. 343 files | `a2b0dbe2…7d60fb82` |
| `archive/simulator/` | [`Alphasmart`](https://archive.org/details/Alphasmart) | 2000-04-26 | "AlphaSmart Simulator": same tree, bigger. Adds the WinSim simulator project, prebuilt flash files, dictionaries, debug monitors (SDS, Bbug, WinBug), FlashFileBuilder, S-record tools, PC/Mac/factory host updaters. 1484 files | `a7d350d2…05ae0b31` |
| `archive/smartinput-2003/` | [`smartinput-may-12-2003`](https://archive.org/details/smartinput-may-12-2003) | 2003-05-12 | Smart Input snapshot of the System 3 era tree: AS3000 sources, CodeWarrior debug monitor, WriterTools, dictionary build utils, Wintertree spell-check data, SharkySoft Lava library. 2614 files | `550d41c6…5bee1549` |
| `archive/asm-manager-2.3/` | [`asm-3000-manager-2.3-full-1`](https://archive.org/details/asm-3000-manager-2.3-full-1) | — | Official AlphaSmart Manager 2.3 for the 3000 (InstallShield cabs, not yet unpacked). Per its archive.org description it reflashes the OS and loads SmartApplets; also ships the System 3 Addendum PDF | `4cffc8dd…7fb67380` |

Full checksums live in `tools/fetch_archive.sh`; the script refuses to
extract a file that doesn't match.

Not fetched yet, possibly useful:
[`alphasmart-cd-1`](https://archive.org/details/alphasmart-cd-1) (two Smart
Input CD-Rs, ~900 MB),
[`si-backup-1-24-03`](https://archive.org/details/si-backup-1-24-03)
(Smart Input backup, 620 MB),
[`manualzilla-id-7337681`](https://archive.org/details/manualzilla-id-7337681)
(3000 user's guide).

## Other sources

| Source | Used for |
|---|---|
| MAME `src/mame/skeleton/alphasma3k.cpp` ([mamedev/mame](https://github.com/mamedev/mame), checked at `9cf98d8`, 2026-11-13) | PCB parts list, flash dump CRC, emulation status |
| [isotherm/betawise](https://github.com/isotherm/betawise) | open-source `.OS3KApp` applet SDK (m68k-elf GCC) |
| [Hacking the AlphaSmart NEO](https://hackaday.io/project/25732-hacking-the-alphasmart-neo) | SmartApplet format, NEO-side reverse engineering |
| [ROM Disassembly – AlphaSmart Pro](https://hackaday.io/project/189608-rom-disassembly-alphasmart-pro) | older 68HC11 model, for comparison only |
| [68kmla AlphaSmart SDK thread](https://68kmla.org/bb/threads/alphasmart-sdk.3582/latest) | claim that 3000 and NEO run the same applet binaries |
| [csh.rit.edu AlphaSmart 3000 notes](https://csh.rit.edu/~rg/alphasmart-3000/) | updating to System 3.01 with ASM 2.3 over USB |

## Licensing

The disc contents are **not public domain**. Their notices read
`Copyright (c) 1998–2002 by Intelligent Peripheral Devices, Inc.` /
`AlphaSmart, Inc.`, with third-party code from Usable Software Corp (1997–98),
Software Development Systems (1993), Wintertree (spell-check) and zlib (Mark
Adler; zlib licence). Corporate works from that period are protected in the
US for 95 years from publication, and the rights passed to Renaissance
Learning with the AlphaSmart acquisition.

So the policy for this repo:

- **Committed:** our own notes, our own code, our own tools, and short
  factual excerpts (addresses, register values, opcodes) with a
  file/line citation. Interoperability facts like these are not protected
  expression.
- **Not committed:** the discs, the extracted source, the prebuilt binaries,
  or long verbatim copies of any of it. `archive/` is gitignored; anyone can
  re-fetch it from archive.org with the script.
- **Our replacement OS / applets** should be written fresh against
  `HARDWARE.md` and `SOFTWARE.md`, not pasted from the original modules.
