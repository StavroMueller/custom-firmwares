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

## Image data

Decoded by `v500/raw.py`, checked against Epson's own output for the same
scans (test: `tests/test_raw.py`). At 200 dpi, 99.8-99.9% of pixels are
identical in colour and in grey. At 400 and 800 dpi Epson also smooths the
image slightly (roughly a cross-shaped blur, centre weight 0.64), so ours is
a little sharper and differs by a few levels.

- Data comes in blocks, each followed by an 8-byte trailer
  `02 <u24 LE length> 00 00 80 00`, e.g. `02 00 b4 00 ...` after 46,080
  bytes. A block can span several USB reads (the 983,040-byte white
  reference arrives in 20 reads with one trailer at the end).
- After dropping trailers: lines of RGB pixels, 8 bits, interleaved, in
  colour **and** in grey mode. The line count is in `1e 41` (below).
- Line shift: a spot on the glass reaches blue first, green `k` lines later
  and red `2k` lines later, with `k = 5 x dpi / 200`. Measured at 200, 400
  and 800 dpi. The scanner sends `2k` extra lines.
- The image is the leftmost `width` pixels of each line. Raw line widths seen:
  1,920 (full bed at 200 dpi), 768 (472 px wide at 200), 1,152 (944 at 400),
  1,888 (1,888 at 800).
- Colour correction happens on the host, with this matrix (Epson's
  `libsane-epkowa` offset `0x3ee70`, also shown as the scanner's `--cct-1`
  to `--cct-9` options), truncated to 0..255:

```
R' =  1.247  R - 0.2041 G - 0.0429 B
G' = -0.192  R + 1.2918 G - 0.0998 B
B' = -0.01   R - 0.2503 G + 1.2603 B
```

- Grey is computed on the host from the raw channels, without the matrix:
  `floor(0.195 R + 0.61 G + 0.195 B)`.
- The driver's default gamma is 1.8 (`--gamma-correction`); the 4,096-entry
  curves uploaded with `1e 84` type `02` are presumably it.

So the scanner already applies shading correction and the tables uploaded
with `1e 84`. An open driver has to compute those tables itself (next
section).

## Calibration

Implemented in `v500/calibration.py`; checked against Epson's values on seven
scans (`tests/test_calibration.py`).

Before each scan the driver makes three 16-bit RGB reference reads. Their
width is the sensor window from `1e 41` (bytes 2-3 minus bytes 0-1; 5,120 for
the full bed, 2,048 for a 60 mm region at 200 dpi), 6 bytes per pixel:

| Read | Size | Conditions | Use |
|---|---|---|---|
| dark probe | 16 px x 4 lines, sensor pixels 21-37 | `1e 42` all zero | mean per colour -> offsets in the next `1e 42` |
| white | window x 32 lines | after a 51-step move, offsets applied | per-pixel white level |
| dark | window x 16 lines | after `1e a2 00` (lamp off), `1e 42` zero | final offsets |

Then the last `1e 42`, the shading table, and two bytes of the image pass's
`1e 41`. The method comes from Epson's plugin (static analysis:
`libesint7C.so` functions at 0x102b0, 0xfc10 and 0xfec0). Over the used
sensor pixels:

- **white line**: the 32 white lines averaged in 4 groups of 8, keeping
  the brightest of the 4 per pixel, floored.
- **dark line**: the 16 dark lines averaged, then smoothed along the line
  (a moving average about 51 pixels wide, fitted; the plugin's filter at
  0x3c9f0 is not fully decoded), floored.
- **`1e 42`**: the white line's minimum per colour (bytes 0-5), then the
  dark line's minimum per colour, each twice (bytes 6-17).
- **packing**: from the dark line's largest range across pixels, D: `k` = 3,
  2, 1 or 0 for D up to 31, 63, 127 or 255; above that `k` = 0 and the dark
  shift `d` is the smallest with D < 256 << d. From the white line's largest
  range, W: the white shift `h` is the smallest with W < 2^(k+8) << h.
- **shading table** (`1e 84` type 06): u16 per sensor pixel per colour,
  interleaved R G B, `((white - white_min) >> h) << (8 - k) | (dark -
  dark_min) >> d`. Entries for pixels the scan doesn't use are 0.
- **image-pass `1e 41`**: byte 11 = `0x80 | k`, byte 15 = `h << 4 | d`. The
  scanner needs these to unpack the table. With the wrong ones the image
  comes out about 10% darker.

Ours match Epson's on seven captures: `k`, `h`, `d`, the white minimums and
the white half of every entry exactly; the dark minimums within 1 or 2.

The other uploaded tables are not calibration and are replayed as captured:

- type `02`, 4,096 u16 per colour: gamma 1.8 on 12 bits,
  `floor(4096 x (x / 4095)^(1/1.8))` clipped to 4,095, 96% exact, the rest
  off by one.
- type `05`: motor acceleration ramps.
- type `07` and `1e 21`, `1e 87`: unknown.

## Scanning without Epson's plugin

`v500/replay.py` replays a capture of Epson's driver as a template, with the
analog levels, offsets, shading table and its packing computed live
(above), and status polls done properly. `v500/geometry.py` retargets it to
any scan area (below). Against a simulated scanner it reproduces all
seven captured scans exactly (`tests/test_replay.py`).

## Scan geometry

`v500/geometry.py` rewrites a template for any scan area at its resolution.
Checked by rebuilding each capture from itself (identical commands) and from
the other captures, and on the real scanner.

- **Sensor window** (`1e 41` bytes 0-3): in sensor units. One pixel is 8/3
  units at 200 dpi, 4/3 at 400 and 1 at 800. Start = origin + x offset in
  units, with origin 143 at 200/400 dpi and 213 at 800. At 200 and 400 dpi
  the raw line is the width rounded up to a multiple of 384 pixels; at 800
  it is the width. The reference reads and the shading table are
  window-sized. The shading table covers `ceil(width x units) + 3` pixels
  (at 800: the whole window).
- **Image pass** (`1e 41`): bytes 4-5 lines = height + red line lag, byte 18
  = lines per 51,200-byte block. Each image read is one block.
- **`1e 01` moves**: bytes 6-7 and 8-9 are the ramp lengths minus one, as
  entries from the start of the type `05` table uploaded just before. A move
  covers its step count plus both ramps. The move to the top of the area
  keeps start + y x (2400 / dpi) steps and uses the longest ramp that fits.
- **Scan move**: lines x (2400 / dpi) + bytes 4-5 (120 at 200 dpi, 126 at
  400 and 800).
- **`1e 57`**: field 7 is two bytes from the frontend. Byte 28 is lines per
  transfer; on all captures it equals floor(65,536 / output bytes per line),
  rounded down to even. Byte 29 is the gamma setting (4).
- Epson's full bed is 1,696 x 2,339 px at 200 dpi (8.48 x 11.7 in).

## Building a scan without a template

`web/v500/protocol.js` builds the whole sequence from scratch at 200, 400
and 800 dpi, colour or grey. It rebuilds every capture exactly, apart from
the values measured live (`web/test/protocol.test.js`), and it scans
correctly on the real scanner at 200 and 400 dpi.

Every capture sends the same 93 commands in the same order (repeated polls
collapsed). Almost all parameters are fixed. The tables are computed:

- **gamma** (`1e 84` type `02`): `floor(65535 x (x / 4095)^(1/1.8)) >> 4`,
  exact for all 4,096 entries.
- **motor ramps** (type `05`): step intervals going from `start` down to
  `cruise` over `n` entries, `max(cruise, floor(start / sqrt(1 + a i)))`
  with `a = ((start / cruise)^2 - 1) / (n - 1)`. This is within 4 timer
  ticks of Epson's tables. Move to the area: 2500 to 160 over 512. Scan:
  2500 to 320 over 512 at 200 dpi, 1249 to 272 over 512 at 400 (first 256
  used), and a constant 112 at 800.
- **type `07`**: constant, u16 pairs `(0, 0) (40, 0x31c0) (200, 0x31c0)
  (400, 0x1000)`, then `ff`.

Per resolution:

| | 200 | 400 | 800 |
|---|---|---|---|
| `1e 46`/`1e 21`/`1e 22` timing (u16) | 0x0f00 | 0x0cc0 | 0x1500 |
| `1e 46` byte 0, `1e 11` | 4 | 4 | 3 |
| probe window | 21-37 | 21-37 | 32-48 |
| image `1e 41` bytes 8-9 | 0x1b1 | 0x1a1 | 0x101 |
| 51-step move speed (type `05`, 1 entry) | 160 | 136 | 224 |
| move to area at y = 0 (steps + both ramps) | 706 | 956 | 1212 |
| scan move tail, ramp entries, flags | 120, 512, 0 | 126, 256, 2 | 126, 0, 8 |

1600 dpi needs a capture (`tools/capture/capture.sh --set 2`).

**Widths.** Epson rounds the area's offsets to the nearest pixel and cuts the
width down to a multiple of 8. At 800 dpi the raw line is the width itself.
A 1,889 px line hung the scanner mid-scan, so we pad it to a multiple of 32.
A hung scanner (status `58 81`, busy) needs a power cycle. **A USB port reset
does not help: the scanner drops off the bus until it is power-cycled.**

## The `1e` commands in a scan, in order

From one 200 dpi colour scan, and a repeat of it to see which values move.
Values marked *varies* changed between the two runs, so the driver computes
them from calibration.

| Phase | Commands | What they seem to do |
|---|---|---|
| setup | `1e 84` x3 (type `03`, 256 B) | identity gamma, one table per colour |
| | `1e 57` (42 B) | scan parameters |
| | `1e a2 01` | probably lamp on (see `1e a2 00` below) |
| | `1e 87 00` -> 10 B `01 5b e9 ff f4 00 f0 00 b0 00` | unknown, same both runs |
| | `1e 86` -> u32 | carriage position: `0` here, `51` after a 51-step move |
| analog gain | `1e 31` `80 00 80 00 80 00 ...`, then `1e 46`, poll `1e 04` until `01`, then `1e 92` -> 12 B | the scanner measures per-channel levels itself. Twice. |
| | `1e 31` <the `1e 92` reply> | writes the measured levels back. 3 u16 (about 138, 136, 142, *varies*) and 3 ASCII digits (`304`, *varies*) |
| | `1e 11 04` | unknown |
| sensor | `1e 21` (26 B), `1e 84` type `07`, `1e 22` (12 B), `1e 41` (22 B), `1e 42` (18 B), `1e 43` (12 B) | sensor and window setup; `1e 41` byte 4 is a line count (4, 32, 16, then 2349 for the image) |
| calibration | `1e 47` -> 392 B; `1e 01` move 51 steps; `1e 47` -> 983 KB in 20 reads; `1e a2 00` (lamp off?); `1e 47` -> 492 KB in 10 reads; `1e a2 01` | dark and white reference lines |
| | `1e 42` | 9 u16: first three ~25,000 (*varies*, per-colour gain), then three pairs ~1,200-1,500 (*varies*, per-colour offset, each twice) |
| tables | `1e 84` type `02` x3 at `0x3800`, `0x3820`, `0x3840`, 8,192 B each | a 4,096-entry u16 curve per colour, starting `0 40 59 74 87`: looks like a tone curve |
| | `1e 84` type `05` (512 or 1,024 B) | decreasing u16 `2500 2375 ...`: a motor acceleration ramp |
| | `1e 84` type `06`, 30,720 B | shading table: 16 bytes per pixel for 1,920 pixels (*varies*) |
| scan | `1e 01` `94 6e 00 00 78 00 ff 01 ff 01 00 00` | move 28,308 steps while scanning |
| | `1e 47` -> image | 294 reads |

**Scan parameters across settings** (`1e 57`, u32 fields). Offsets are in
pixels at the scan resolution (20 mm at 200 dpi = 157). Field 6 encodes the
mode. Field 7 changes between scans with no pattern yet.

| Scan | dpi | x off | y off | width | height | 6 | 7 |
|---|---|---|---|---|---|---|---|
| full bed, colour | 200 | 0 | 0 | 1696 | 2339 | `0x813` | 1036 |
| 60 x 40 mm region, colour | 200 | 157 | 236 | 472 | 314 | `0x813` | 1070 |
| same region | 400 | 315 | 472 | 944 | 629 | `0x813` | 1046 |
| same region | 800 | 630 | 945 | 1888 | 1259 | `0x813` | 1034 |
| same region, grey | 200 | 157 | 236 | 472 | 314 | `0x800` | 1162 |

Field 8 is always `0x8000`.

**`1e 41` (22 bytes) for the image pass**, as u16 at bytes 0, 2, 4:

| Scan | bytes 0-1 | bytes 2-3 | bytes 4-5 = lines | byte 10 |
|---|---|---|---|---|
| full, 200 | 143 | 5263 | 2349 = 2339 + 10 | 12 |
| region, 200 | 565 | 2613 | 324 = 314 + 10 | 12 |
| region, 400 | 563 | 2099 | 649 = 629 + 20 | 6 |
| region, 800 | 843 | 2731 | 1299 = 1259 + 40 | 3 |

Byte 10 is 2400 / dpi. Bytes 0-3 look like a start and end on the sensor; the
units are not worked out yet.

**Carriage moves** (`1e 01`, u32 step count): every scan first moves 51 steps
(position `1e 86` reads 51 after it), then a second move that grows with the
top offset (194 for 0 mm; 2514, 2764 and 3023 for 30 mm at 200, 400 and
800 dpi), then `1e 05`, then the scan itself: 28,308 steps for the full bed,
about 4,010 for 40 mm. That is roughly 2,400 steps per inch while scanning.

**16-bit scans hang the scanner.** Epson's backend read part of a 16-bit
scan, then exited with no error. The scanner kept the unsent data and
ignored the next session until it was power-cycled.

**`1e 84` header, 8 bytes:** byte 0 table type; bytes 2-3 an address for
type `02` (`0x3800` + `0x20` per colour); bytes 6-7 the length in units of
256 bytes (`01 00` = 256, `78 00` = 30,720). Holds for all 11 uploads.

**`1e 01`, 12 bytes:** bytes 0-3 are a u32 step count. The rest is unknown.

## Still to capture

- The meaning of the other status bits returned by `1b 03`.
- Front-panel button state, if the protocol exposes it.
