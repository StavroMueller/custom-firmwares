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

## Still to capture (needs the scanner)

- What follows `int_init`: the ESC/I commands epkowa sends, and the
  register-level traffic the plugin turns each one into.
- The meaning of the other status bits returned by `1b 03`.
- Front-panel button state, if the protocol exposes it.
