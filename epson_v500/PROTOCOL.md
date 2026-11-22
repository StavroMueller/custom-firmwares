# V500 USB protocol notes

Facts here come from `tools/trace.c`, which runs Epson's plugin against a fake
scanner, and from reading the plugin's disassembly. Anything not yet checked on
real hardware is marked **(unverified on hardware)**.

`->` is host to scanner (bulk out), `<-` is scanner to host (bulk in).
`ACK` is `06`.

## Firmware file: `esfw7C.bin` (65,793 bytes)

| Offset | Size | Value | Meaning |
|---|---|---|---|
| `0x000` | 4 | `45 44 4c 41` "EDLA" | magic |
| `0x040` | 4 | `00 01 00 00` | u32 LE 0x100: where the body starts (probably) |
| `0x044` | 4 | `01 00 00 01` | unknown |
| `0x048` | 4 | `00 00 b8 04` | the high half is u16 LE 0x04b8, Epson's USB vendor ID |
| `0x04c` | 4 | `01 00 01 00` | **upload header**: u32 LE 0x10001, the length of body + checksum. The plugin builds it from that length; the file happens to hold the same bytes |
| `0x100` | 65,536 | | **body**: sent as-is; contains `EPSON   GT-X770         1.02` |
| `0x10100` | 1 | `10` | trailer; the plugin reads it, then overwrites it with the checksum and sends that |

## Firmware upload

The plugin does this inside `int_init`. Read from its disassembly (the
function int_init reaches through `esint7C_SYMBOL_151` and `SYMBOL_25::SYMBOL_176`):

```
-> 1b 03               status query
<- s0 s1               2 status bytes, NO ack. If s0 & 0x10, firmware is
                       already running and the plugin stops here.
-> 1b 06               begin upload
<- 06
-> file[0x4c:0x50]     4-byte upload header (01 00 01 00)
-> file[0x100:0x10100] 65,536-byte body, in one write
-> sum(body) & 0xff    1-byte checksum (f1 for this file)
<- 06
-> 1b 16               unknown, probably "run firmware"
<- 06
-> 80                  parameter for 1b 16
<- 06
```

Every `<- 06` after the status query is checked: the plugin reads one byte
and gives up unless it is `06`.

On real hardware, a V500 with no firmware answers the status query with
`28 00` (bit 0x10 clear). The trace harness's fake scanner answered `06 00`,
which also has the bit clear, so the capture still showed a full upload.

**Verified on hardware (2026-11-22).** Our open loader (`v500/firmware.py`)
uploaded the firmware and every step was ACKed. The status went from `28 00`
to `18 81`, so bit 0x10 means "firmware running". The scanner does **not**
re-enumerate: it keeps its USB address. A power cycle drops the firmware.

| Status | When |
|---|---|
| `28 00` | powered on, no firmware |
| `18 81` | right after our upload |

The other bits are not decoded yet.

This is the first piece of the plugin we can replace with open code.

## A full scan, as Epson's driver does it

Captured on 2026-11-22 with `tools/capture/capture.sh`: Epson's driver in a
container, every libusb transfer logged with full data by `usblog.c`. A
200 dpi colour scan of the full bed, 1696 x 2339 px. Decode a capture with
`python tools/usbpcap.py captures/<ts>/02-scan-75dpi.usblog`.

The driver offers only `--resolution 200|400|800|1600`; scanimage rounds
anything else to 200. The advanced x and y resolutions are separate lists:
x `100 200 400 600 800 1200 1600 3200 6400`, y `80 200 320 400 600 800 1200
1600 2400 3200 4800 6400`.

**Two command sets.** `1b xx` is classic ESC/I. `1e xx` is a lower-level set
that the plugin uses to drive the hardware. A command byte pair is answered
with `06` (ACK) before any parameter block is sent; the block is ACKed again.

**Measured:**

| Command | Out | In | Notes |
|---|---|---|---|
| `1b 03` | | 2 | status, see below |
| `1b 13` | | 28 | `EPSON   GT-X770         1.02` |
| `1b 40` | | `06` | sent before each session; ESC/I "initialize" |
| `1e 53` | | 42 | read scan parameters |
| `1e 57` | 42 | | write scan parameters |
| `1e 65` | | 1 | always `00` so far |
| `1e 84` | 8-byte header + data | | write a table: gamma, shading, ... |
| `1e 04` | | 1 | poll: `02` busy, `01` ready; polled about every 100 ms |
| `1e 47` | | data | read data: calibration lines, then the image |

**Scan parameters** (`1e 53` / `1e 57`, 42 bytes, u32 LE). The first six
fields are clear:

| Offset | Read at power-on | Written for this scan | Meaning |
|---|---|---|---|
| 0 | 100 | 200 | x resolution |
| 4 | 80 | 200 | y resolution |
| 8 | 0 | 0 | x offset (probably) |
| 12 | 0 | 0 | y offset (probably) |
| 16 | 848 | 1696 | width in pixels |
| 20 | 936 | 2339 | height in pixels |

**Tables via `1e 84`.** Header `03 00 fc 1f 02 00 01 00` followed by 256
bytes `00 01 02 ...` loads an identity gamma table; `fc`, `fd` and `fe` are
presumably the red, green and blue tables. Other headers (`05 ...`, `06 ...`,
`07 ...`) carry 2 to 30,720 bytes and look like shading and motor tables.

**Guesses, not yet tested:** `1e 31`, `1e 46`, `1e 92` (12 bytes) look like
analog front-end gain and offset; `1e 41` (22), `1e 42` (18) and `1e 43` (12)
like sensor timing and per-channel levels; `1e 21`/`1e 22` lamp or motor
setup; `1e 01` (12 bytes) starts a move or a scan; `1e 05` stops or parks.

**Sequence:** initialize, read and write parameters, load gamma tables, warm
up the lamp (poll `1e 04` until `01`, about 1 s, twice), calibrate (several
`1e 47` reads of 8 KB to 1 MB), load shading tables, then the image: 294
reads, mostly 51,200 bytes, 13,532,592 bytes in all. That is more than the
11,900,832 bytes of the final 8-bit RGB image, so the raw format (bit depth,
padding, extra lines for RGB line shift) is the next thing to work out.

**More status values:** `1a 81` and `5a 81` while the firmware starts; `58 81`
while data is being read, so bit 0x40 is probably "busy".

## Still to capture

- The meaning of the other status bits returned by `1b 03`.
- Front-panel button state, if the protocol exposes it.
