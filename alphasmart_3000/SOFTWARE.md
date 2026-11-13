# AlphaSmart 3000 — software facts

How the stock firmware is built, how code gets onto the device, and how to
get it back when it goes wrong.

**CONFIRMED** = read in the original source or checked against a built
binary. **INFERRED** = our reading, not yet tested.

Path prefixes (all under the gitignored `archive/`, see `SOURCES.md`):

| Prefix | Tree |
|---|---|
| `S00/` | `simulator/extracted/AS3000/` (Apr 2000, most complete) |
| `S03/` | `smartinput-2003/extracted/AlphaSmart/AS3000/Software/` (May 2003, "WriterTools 2.0.2") |

**Start with** `S00/Documents/AS3K Software Architecture.doc` (Jon
Norenberg, 2000-01-28), the original design doc. `S00/Documents/` also holds
`FlashFile Layout.pdf`, `Address Map - Flashing.pdf`, `AS 3000 Port Bits.c`
and `Chameleon Update Process.pdf`.

## Boot chain (CONFIRMED)

| Stage | Where | What it does | Ref |
|---|---|---|---|
| Startup Manager (SM) | flash 0x400000, first 1 KB | Reset vectors (SSP 0x3FFF0), hardware init, then compares the string `Valid Applet Sig` at the applet signature address | `S00/Software/AlphaSmartApps/Updater/StartupManager.s:33-80` |
| → applet | 0x410030 (ID 01) / 0x420030 (ID 02) | SM points TRAP #0 (vector 0x80) at itself and jumps to signature + 0x30 | same, `:72-80` |
| → updater | copied flash 0x400410… → RAM 0x410 | Taken when the signature is missing, or when the applet runs `trap #0`. Message word at RAM 0x400: 1 = no applet, 2 = applet asked | `StartupManager.s:99-148`, `S00/Software/ModuleSources/UpdaterInfo.h` |

- The SM checks **no keys** at power-on. The planned "update keys" were never
  built.
- Copying the updater to RAM overwrites RAM from 0x410 up, so user files
  may be lost (INFERRED from `SystemModule.c:1234-1237`).

### Getting into the updater

| Way in | How | Ref |
|---|---|---|
| Missing or cleared applet signature | automatic | `StartupManager.s` |
| Serial, from AlphaWord | Cmd+Ctrl+U, then the host sends `C0 14 00 14 C1` at 9600 8N1 | `S00/Software/AlphaSmartApps/AlphaWord/AlphaWord.c:851-858` |
| USB, from keyboard mode | the host sends HID output (LED) reports `F0 F1 F2 F3 F4` (or `07 03 01 04 02`); the device drops off and re-enumerates in updater mode | `S00/Software/ModuleSources/UsbRequestResponse.c:1220-1330` |
| **EZ328 hardware bootstrap** | hold **Right Arrow + Up Arrow + Left Arrow + Right Option** while powering on. LCD lines 1 and 3 fill with blocks. Serial on the **left (printer) port** | `S00/Software/AlphaSmartApps/AlphaWord/Release Notes.html:13-21` |

Bootstrap mode is the DragonBall's on-chip ROM, triggered by EMUBRK (PG5)
going low (`S00/Documents/AS 3000 Port Bits.c:83`). It needs **no flash
code**, which makes it the real unbrick path. That the key combo is what
grounds EMUBRK is INFERRED.

## Flash layout (CONFIRMED)

| Region | Machine ID 01 (AMD / ST / Fujitsu) | Machine ID 02 (Intel / Micron) |
|---|---|---|
| Boot sectors 0–3 | 16K + 8K + 8K + 32K = 64 KB | 16K + 8K + 8K + 96K = 128 KB |
| contents | SM, platform info, ROM updater | same |
| Machine ID (`\x01MachineID Sig`) | 0x400400, copy at 0x40FFF0 | same addresses |
| Applet signature / code | 0x410000 / 0x410030 (64 KB sectors) | 0x420000 / 0x420030 (128 KB sectors) |

Our MAME reference unit has an Intel 28F008B3, so it's **ID 02**.

- Supported parts: Am29LV004B/008BB/800BB, M29W004/008/800 and
  MBM29LV004/008/800 (JEDEC AA/55 command set); MT28F008B3/800B3 and Intel
  B3 (Intel command set). Refs: `S00/Software/AlphaSmartApps/Updater/FlashAmdModule.c:146-260`,
  `FlashMicronModule.c:31-98`.
- **2003 only:**
  - CSA is set read-only at boot and unlocked around each write.
  - Battery calibration is stored at 0x4003F0 and 0x40FFE0, inside the
    boot sectors (`S03/ModuleSources/UpdaterInfo.h:77-82`).
  - **Keep that data if you ever rewrite sectors 0–3.**

## Updater protocol (CONFIRMED)

The same command set runs over two transports.

**Serial.** Starts at 9600 8N1; command 10 raises it to 115200. Frames are
`C0 | payload | sum_hi sum_lo | C1`:

- Escape: `7D` followed by the byte XOR `0x20`, for `C0`, `C1` and `7D`.
- Checksum: plain 16-bit byte sum of the payload, sent big-endian.
- Ref: `S00/Software/AlphaSmartApps/Updater/RS232Framer.c`.

**USB.** Raw payload, no framing, over bulk EP `0x01` (OUT) and `0x81` (IN),
8-byte packets:

- A packet shorter than 8 bytes ends the message.
- If a message is an exact multiple of 8, the host pads it with one byte.
- Ref: `S00/Software/AlphaSmartApps/Updater/usbtoud.c:156-200`.

**Commands.** Reply = request + 1, error = request + 2. All multi-byte
values are big-endian. Ref: `S00/Software/ModuleSources/UpdaterCommands.h`.

| Op | Name | Payload |
|---|---|---|
| 1 | VERSION | — (v1 in 2000, v8 in 2003) |
| 10 | BAUD | u32 baud |
| 20 | STATUS | — |
| 30 | SEND_BLOCK | addr, len, data: writes **any** address (normally RAM 0x31000) |
| 40 | DECOMPRESS | src, srclen, dst, dstsize, explen (zlib) |
| 50 | PROGRAM | src, flash dst, len; read back and verified |
| 60 | ERASE | u8 sector: **sector 0 is not protected** |
| 70 | EXECUTE | addr; replies first, then jumps |
| 80 | RESET | — |
| 85 | SEND_EXPAND_PROGRAM | clen, flash addr, ulen, zlib data (≤16 KB out) |
| 90 | READ | addr, len ≤ 50: memory peek, enough to dump flash |
| 100 / 110 | FLASH_NAME / FLASH_SIZE | — |
| 120 | POWER_OFF | — |

What the stock host updater sends, in order
(`S00/Utilities/HostUpdater/UpdaterSerialMode.c`):

1. VERSION, then BAUD.
2. FLASH_NAME and FLASH_SIZE.
3. READ of the machine ID at 0x400400.
4. ERASE of sectors **4 and up**.
5. Op 85 for each applet segment.
6. `Cold Boot Sig` written to RAM 0x400.
7. PROGRAM of the applet signature, **last**.
8. RESET.

## USB (CONFIRMED)

- **Chip:** Philips PDIUSBD11, on a bit-banged I²C-style bus: PE1 = SDA,
  PE2 = SCL, PE0 = SUSPEND, interrupt on PF1/IRQ5. Refs:
  `S00/Software/ModuleSources/UsbChip.c:25-63`, `UsbAsmModule.s`.
- **VID `0x081E`:**
  - PID `0xBD04`: HID boot keyboard, the normal "send text to the computer"
    mode.
  - PID `0xBD01`: updater / Get Utility mode, two bulk endpoints. The source
    calls it `IPD_IRDA_POD`, a leftover name, but the updater driver binds
    to it (`S00/Utilities/HostUpdater/ASUSBDrv.inf:17`).
- Stock Windows needed a custom kernel driver (`ASUSBDrv.sys`). On a modern
  machine, **libusb talks to BD01 directly** (INFERRED).

## Flash file format (CONFIRMED)

This is the file the host updater sends, e.g.
`S00/Software/BuiltAlphaWordFlashFileUSA/AlphaWordFlashFile`. Fields are
**little-endian**. Refs: `S00/Documents/FlashFile Layout.pdf`,
`S00/Utilities/FlashFileBuilder/FlashBuilderMain.c`.

```
u32 nMachines ; { u8 id ; u32 offset } × n ; u8 len ; name ("AlphaWord v1.1")
per machine:  u32 ramOff, romOff, appletOff
RAM module:   u32 size ; ASCII b-records (register init + RAM updater)
ROM / applet: u32 usize, u32 csize, u32 nSeg ; { u32 u, u32 c, zlib data } × nSeg
              (16 KB segments, zlib 1.1.3 compress())
```

The applet `.bin` is raw code linked at signature + 0x30 and holds no
signature; the host writes the signature last.

## OS architecture (CONFIRMED)

- **There is no separate OS.** In both 2000 and 2003, all modules compile
  into `libModule.a` and are linked with `AppletStart.o` + `AlphaWord.o` into
  one image ("the applet"). Refs: `S03/ModuleSources/makefile`,
  `S03/AlphaSmartApps/AlphaWord/makefile:57-62,113-120`, design doc § "applets".
- Product variants (KeyWords, Quiz, Outliner) are `#ifdef`s inside
  `AlphaWord.c`. 2003's "WriterTools" applets are function pointers chained
  inside the same image (`S03/ModuleSources/WriterTools/api/WtApplet_Types.h:13-26`).
- **The only system call is `trap #0`**, which goes back to the SM to enter
  the updater. There's no A-line trap table and no jump table.
- **Loadable SmartApplets came later**, with System 3. That code is **not
  in these trees**; it's presumably inside the ASM 2.3 InstallShield cabs
  (not yet unpacked).

| Group | Modules (`S00/Software/ModuleSources/*Module.c`) |
|---|---|
| Drivers | LCD, Keyboard, Uart, Timer, Interrupt, Power, Battery, USB, PS2, ADB, IrDA, RamTest |
| Services | System, Memory (fixed-block pools), File (8 slots), Text, Find, Dialog, Password, Localization, SpellCheck, Print (StyleWriter), Debug |
| Apps | Calculator, KeyCaps, TypingTimer, KeyWords, Quiz, Outliner |

### Relation to the NEO / betawise ABI

- betawise `.OS3KApp` files have:
  - a `0xC0FFEEAD` header and `0xCAFEFEED` footer;
  - A-line syscalls (`0xA000 + 4n`);
  - a `ProcessMessage` entry point.
- **None of that appears anywhere in the 2000–2003 source or binaries**
  (grep and byte scan).
- The **keyboard codes and modifier bits are identical**, e.g. ESC 0x48,
  F1 0x2D, CTRL 0x8000, LSHIFT 0x0400. Compare
  `S00/Software/ModuleSources/LocalizationModule.h:772-802` and
  `KeyboardModule.h:50-63` with betawise `os3k/os3k.h`. So the NEO OS
  descends from this code (INFERRED).

**Open question:** does the 3000's System 3 OS load `.OS3KApp` files? The
68kmla claim says yes. To settle it, unpack the ASM 2.3 cabs and look for
`C0FFEEAD`, or just try it on hardware.

## Toolchain (CONFIRMED)

- **Original:** SDS CrossCode 7.4 (`cc68000`, `as68000`, `linker`, `down`),
  with Metrowerks CodeWarrior as an alternative path. Linker specs are
  `.spc` files. Hosts were DOS/NT with MSVC6 and GNU make. Refs:
  `S03/Bin/ASMake.bat`, `.o.lst` headers (`cver=0x740`).
- **SDS calling convention:** arguments pushed right to left as 32-bit
  longs, **callee pops**, return in D0. Ghidra needs a custom calling
  convention for this. Ref: `S00/Software/ModuleSources/SystemAssembly.s:205-229`.
- **Porting to m68k-elf-gcc** (INFERRED, feasible):
  - about 3.7k lines of SDS-syntax assembly to convert;
  - `#pragma interrupt` → `__attribute__((interrupt))`;
  - `.spc` → ld scripts;
  - SDS libc → picolibc.

## Simulator (CONFIRMED)

`S00/Software/ModuleSources/WinSim.dsp` is an MSVC6 Win32 app.

- It is **not a CPU emulator**: the OS's C code runs natively as a thread,
  with the LCD, keyboard and timer HAL swapped for Win32 shims (`As_sim.c`,
  `As_scrn.c`, ~150 `#ifdef AS_SIMULATOR` sites).
- That makes it good for app logic and useless for driver work.
- An SDL port is realistic (INFERRED).

## Binaries worth loading into Ghidra (CONFIRMED)

| File | Size | Load at | Notes |
|---|---|---|---|
| `S03/BuiltApplet/AWordApplet02.bin` | 692,430 | 0x420030 | ID 02 applet (our flash type) |
| `S03/BuiltApplet/AWordApplet0{1,2}.xrf` | 136,217 | — | **full symbol map**, 2,287 globals |
| `S03/BuiltApplet/*.o.lst` | — | — | per-module listings with C interleaved |
| `S03/BuiltUpdaters/UpdaterROMWithStartup01.bin` | 38,346 | 0x400000 | SM + ROM updater; symbols in `UpdaterROM.xrf`, `Startup.xrf` |
| `S03/BuiltUpdaters/UpdaterRAMWithInit01.brc` | 91,764 | — | ASCII b-records: bootstrap RAM updater |

SDS `.o` / `.out` files are a proprietary format; use `.bin` + `.xrf` instead.

## Debug monitors (CONFIRMED)

- **BBug** (`S00/Utilities/Bbug/`): Motorola's terminal for EZ328 bootstrap
  mode. It peeks and pokes registers and memory, loads S- and B-records, and
  runs code with `go`.
- **SDS SingleStep monitor** (`S00/Software/DebugMonitors/SDS/ipd/`): flashed
  into the **boot sector** in place of the SM.
  - Transport: UART1 at 115200, or bit-banged at 19200 on PF5 (TX) / PF6 (RX).
  - Flow: bootstrap → `init finit.b` → load `flasher.dwn` and `monUart.dwn` → `go 43D000`.
  - With `FInit.b` loaded, the map is remapped (flash at 0x100000, RAM at
    0x400000) — see `S00/Documents/Address Map - Flashing.pdf`.

## Safe-flashing rules

1. **Ship custom code as an applet**, linked at 0x420030 (ID 02) or 0x410030
   (ID 01). Erase sector ≥ 4 only, and program the signature **last**.
   If an update is interrupted, the signature is missing and the SM drops
   back into the updater, so it can't brick.
2. **Our host tool must refuse sectors 0–3** unless a `--boot-sector` flag is
   given. The device updater enforces nothing.
3. **Dump first.** Before any write, READ 0x400000–0x41FFFF (machine ID, ROM
   updater, 2003 battery calibration), and ideally the whole 1 MB.
4. **Develop from RAM.** Load with op 30 + op 70 from the updater, or `lo` +
   `go` in bootstrap mode, so flash is never touched.
5. **Before touching the boot sectors**, prove the bootstrap recovery path on
   our unit: key combo → BBug-style handshake on the printer port →
   RAM updater loads.
