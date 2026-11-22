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
| `0x04c` | 4 | `01 00 01 00` | **upload header**: sent as-is before the body |
| `0x100` | 65,536 | | **body**: sent as-is; contains `EPSON   GT-X770         1.02` |
| `0x10100` | 1 | `10` | trailer, not sent |

## Firmware upload

The plugin does this inside `int_init`, every time, whatever the status byte
says:

```
-> 1b 03               status query
<- 06 xx               ACK + status byte (meaning of xx unknown)
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

On real hardware the scanner is expected to re-enumerate on USB after this
**(unverified on hardware)**.

This is the first piece of the plugin we can replace with open code.

## Still to capture (needs the scanner)

- What follows `int_init`: the ESC/I commands epkowa sends, and the
  register-level traffic the plugin turns each one into.
- The meaning of the status byte returned by `1b 03`.
- Front-panel button state, if the protocol exposes it.
