# AlphaSmart 3000 — hardware facts

**CONFIRMED** = read in the original OS source or design docs.
**INFERRED** = our reading, not yet measured on a board.
Path prefixes are as in `SOFTWARE.md`: `S00/` = Apr 2000 tree, `S03/` =
May 2003 tree, `MAME` = `src/mame/skeleton/alphasma3k.cpp`.
`PortBits` = `S00/Documents/AS 3000 Port Bits.c`, the original hand-written
pin table; start there.

## Parts (MAME PCB notes, rev 2.8 board)

| Part | Chip | Notes |
|---|---|---|
| CPU | **Motorola MC68EZ328PU16V** (DragonBall EZ, 68000 core) | also `S00/Software/ModuleSources/M68328EZ.h` |
| Flash | Intel **28F008B3**, 1 MB, 8-bit | machine ID 02. Earlier boards: 512 KB AMD/ST/Fujitsu, ID 01 (`S00/Documents/Address Map - Normal.pdf`) |
| SRAM | Hynix **HY62U8200**, 256 KB | boards before rev 1.2 had 128 KB (`S00/Software/AlphaSmartApps/AlphaWord/linkerROM.spc:7,16`) |
| Column latch | 74HC574 at 0x600000 | keyboard columns, see below |
| RS-232 | Sipex SP3223 | enabled by PG2 |
| USB | Philips **PDIUSBD11** | I²C-style, bit-banged |
| LCD | 2 × HD44780-compatible (MAME guesses KS0066) | 4 × 40 characters total |
| RTC backup | CR2032 | |

MAME has a flash dump of this board: `28f008b3.u1`, CRC32 `73a24834`. The
driver is `MACHINE_NOT_WORKING`: boot hangs at PC=0x40016C in the
flash→RAM copy loop, which the driver suspects is a DragonBall-EZ core bug.

## Memory map (CONFIRMED, `S00/Software/ModuleSources/AS3000InitCode.s:37-49`)

| Range | Chip select | What |
|---|---|---|
| 0x000000–0x03FFFF | CSB, 8-bit, 0 wait states (2003: 1 wait state on early boards) | SRAM. Vectors 0x000–0x3FF, boot message at 0x400, updater/app RAM from 0x410, stack top 0x3FFF0 |
| 0x400000–0x4FFFFF | CSA, 8-bit, 1 MB window (2003: read-only except while writing) | flash. Layout in `SOFTWARE.md` |
| 0x600000–0x607FFF | CSC, 8-bit, 32 KB window | write-only keyboard column latch |
| 0xFFFFF000– | — | EZ328 internal registers |
| 0xFFFFFF44 | — | EZ328 internal bootstrap ROM entry (`S00/Software/AlphaSmartApps/Flasher/Flasher.c:478-480`) |

- PLLCR = 0x2410 (sysclk = VCO/1); PLLFSR stays at its reset default.
- Watchdog and RTC are off at reset (they're re-enabled later for the
  auto-off alarm).
- System clock ≈ **16.58 MHz** from a 32.768 kHz crystal (INFERRED from
  the UART divisors: `0x0038` = 115200).

## GPIO map (CONFIRMED unless noted)

The EZ328 has ports A–G only.

| Pin | Function | Ref |
|---|---|---|
| PA0–PA6 | keyboard columns 9–15 (outputs) | `KeyboardModule.c:226-234` |
| PA7 | IrDA transceiver enable (active-low after board v1.3) | `UartModule.c:225-233` |
| PB0 / PB2 | CSB0 (SRAM) / CSC0 (column latch) | `PortBits:25-27` |
| PB1 | IR flex cable present (low = present) | `IrdaModule.c:196-209` |
| PB3 / PB6 | host connector CLK_IN / DATA_IN | `SystemModule.h:30,33` |
| PB4 / PB5 | host connector CLK_OUT / DATA_OUT, through an inverting driver (1 = pull low) | `SystemModule.h:31-32` |
| PB7 | spare ("sound out"). 2003: battery-gauge capacitor | `S03/ModuleSources/BatteryModule.c:23` |
| PC0–PC3 | LCD D4–D7 | `LCDModule.c:48-51` |
| PC4 / PC5 | LCD R/W (1 = read) / RS (1 = data) | `LCDModule.c:52-53` |
| PC6 / PC7 | LCD E1 (lines 1–2) / E2 (lines 3–4) | `LCDModule.c:54-55` |
| PD0–PD7 | keyboard rows 1–8 (inputs, keyboard interrupt / wake) | `KeyboardModule.c:236-241` |
| PE0 | USB SUSPEND | `UsbModule.c:233-235` |
| PE1 / PE2 | USB SDA / SCL (bit-banged). PE1 high also means "cable power present" | `SystemModule.h:26-27` |
| PE3 | carrier detect | `PortBits:60` |
| PE4–PE7 | UART RXD / TXD / RTS / CTS | `UartModule.c:26-29` |
| PF0 | spare ("graphic LCD contrast"). 2003: NiMH / alkaline detect | `PortBits:77` |
| PF1 | IRQ5 = host-connect interrupt from USB | `AS3000InitCode.s:24` |
| PF2 | debug RTS / USB chip reset (high = run). 2003: board-revision bit 2 | `UsbModule.c:243-245` |
| PF3 | A20 | `AS3000InitCode.s:24` |
| PF4 | **ambiguous**, see the Conflicts section | — |
| PF5 / PF6 | bit-banged debug serial TX / RX (19200 baud, SDS monitor). 2003: board-revision bits 1 / 0 | `S00/Software/Test/BitBang/EzBitBang.s:203-210` |
| PF7 | "host power off", driven low at init | `AS3000InitCode.s:70` |
| PG0 | BUSW tied low (8-bit boot device) | `PortBits:89` |
| PG1 | A0 | `AS3000InitCode.s:16` |
| PG2 | RS-232 driver enable | `UartModule.c:219-222` |
| PG3 | **power hold**: clearing it turns the unit off | `PowerModule.c:50` |
| PG4 | low-battery comparator input (0 = low) | `PowerModule.c:51` |
| PG5 | **EMUBRK**: ground = EZ328 bootstrap mode | `PortBits:83` |

## LCD (CONFIRMED)

- 4 lines × 40 characters, built from two independent 2 × 40 controllers:
  E1 drives lines 1–2, E2 lines 3–4 (`LCDModule.c:5-10`). MAME's
  `set_lcd_size(4, 40)` on *each* controller is probably wrong; it should be
  2 × 40.
- 4-bit bus on port C, polling the busy flag.
- Init per controller: function set 0x28, entry mode 0x06, display 0x0C,
  clear 0x01, home 0x80 (`LCDModule.c:938-979`).
- 8 CGRAM characters, written to both controllers. In 2003, 4 of them are
  redrawn on the fly as a battery gauge.
- No software contrast or backlight control. Contrast is probably a
  trimpot (INFERRED).

## Keyboard (CONFIRMED)

- 16 columns × 8 rows:
  - columns 1–8 driven by the latch at 0x600000 (D7 = column 0, D0–D6 =
    columns 9–F);
  - columns 9–15 driven by PA0–PA6;
  - rows read on PD0–PD7.
  - Refs: `KeyboardModule.c:56,1836-1851`.
- The ON/OFF key sits alone on a column that is never scanned.
- Scan: drive one column low, read PD, invert. Scan code = `(row << 4) | col`;
  at most two keys at once (`KeyboardModule.c:1246-1263,1875-1889`).
- Scan code → key code table: `gpubLocalScanCodeToQwertyICode`
  (`LocalUSA.c:2554`). Key codes and modifier bits match the NEO / betawise
  `os3k.h`.

### Key combos at power-on

| Hold | Does | Ref |
|---|---|---|
| Right Arrow + Up Arrow + Left Arrow + Right Option | EZ328 bootstrap mode (serial recovery) | `S00/Software/AlphaSmartApps/AlphaWord/Release Notes.html:13-21` |
| Delete + Right Shift (warm boot) | factory reset prompt: Y, then password `tommy` | `SystemModule.c:58-65,782-854` |

## Power (CONFIRMED)

- **Soft power latch on PG3.** The auto-off RTC alarm (4–59 min idle)
  clears it.
- **Sleep:** turn the PLL off, then `stop #$2000` (`SystemAssembly.s:50-77`).
- **Wake sources:** keyboard interrupt, IRQ5 (host connect), RTC alarm.
- **No ADC.** Battery level is a comparator on PG4. From Apr 2000, an RC
  timing trick measures it: discharge a capacitor, count until PG4 trips.
  In 2003 the capacitor moves to PB7, NiMH/alkaline detect goes on PF0, and
  a calibration value is stored in the flash boot sectors.
- When no host is attached, the USB chip pins are driven low to save
  ~130 µA per pin (`SystemModule.c:405-447`).

## Host connector and serial (CONFIRMED)

- **One connector serves USB, ADB and PS/2.** Detection order
  (`SystemModule.c:280-348`):
  1. CLK_IN and DATA_IN both low → USB.
  2. DATA goes low within 20 ms → ADB.
  3. Otherwise → PS/2.
- ADB and PS/2 are bit-banged in hand-timed assembly on PB3–PB6
  (`PS2Assembly.s`, `ADBAssembly.s`).
- **Hardware UART** (PE4–7) is shared between RS-232 on the left "printer"
  port (PG2 driver enable) and IrDA. The IR transceiver is on an optional
  flex cable, detected via PB1.
- **Debug serial** is bit-banged on PF5 / PF6, a separate set of pins from
  the UART.

## Conflicts to settle with a board probe

| Question | Says A | Says B |
|---|---|---|
| Which pin is "host power off"? | PF7 (`AS3000InitCode.s:70`, `PortBits:69`) | PF4 (`UsbModule.c:36,239-241`) |
| What else is PF4? | unused (`PortBits:72`) | Apr 2000: battery-gauge capacitor (`PowerModule.c:52`) |
| PA7 IrDA enable polarity | 1 = on (`PortBits`) | active-low after board v1.3 (`UartModule.c:225-233`) |
| PB1 meaning | UART peer connected (`PortBits:26`) | IR cable present (`IrdaModule.c:126`) |
| 2003 battery capacitor pin | PB7 (`0x80`, `S03/.../BatteryModule.c:23`) | PB6 (comments, `:188-192`) |
| Flash size on our unit | 512 KB, ID 01 (`Address Map - Normal.pdf`) | 1 MB, ID 02 (MAME board) |

Our unit's flash type comes out of FLASH_NAME / FLASH_SIZE (updater ops
100 / 110) without opening the case.
