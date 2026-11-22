# Epson Perfection V500 Photo: driver investigation

Research notes on the V500 (also sold in Japan as the GT-X770). No code yet.

## What the scanner is

| Fact | Value | Source |
|---|---|---|
| USB ID | `04b8:0130` (V500 Photo and GT-X770 share it) | SANE `doc/descriptions/epson2.desc` |
| Open-source SANE status | `unsupported`: "supported by the epkowa backend plus non-free interpreter" | same |
| Firmware blob | `esfw7C.bin`, sha1 `2230ef57a121591f6c69efedbefac7f42ccdff40` | epson-esci `BUNDLES` table |
| Vendor package | `iscan-gt-x770-bundle-2.30.4.x64.deb.tar.gz`, sha256 `5c10ccc8…3181e`, 666,703 bytes | same |
| Package URL | `https://download2.ebz.epson.net/iscan/plugin/gt-x770/deb/x64/` | same |
| Epson Scan 2 | does not support this model | Arch forum reports |

There is no firmware in the scanner's flash. The host uploads `esfw7C.bin`
each time the scanner powers on, and the scanner then re-enumerates on USB.
Until that upload happens the scanner looks dead: the LED blinks and every
bulk transfer times out.

## The driver stack today

```
scanimage / GUI
  └─ SANE epkowa backend (iscan, mostly GPL)
       └─ libesci-interpreter-gt-x770.so   ← closed, x86/x86-64 only
            ├─ uploads esfw7C.bin
            └─ USB I/O to the scanner
```

The registry file `/var/lib/iscan/interpreter` links the USB ID to the plugin
and the firmware path. If that line is missing, every USB transfer times out.

## What's inside the plugin (from static analysis)

The bundle downloaded with a matching sha256. It holds `iscan` 2.30.4,
`iscan-data` 1.39.2 and `iscan-plugin-gt-x770` 2.1.3. The plugin itself is
`/usr/lib/iscan/libesint7C.so.2.0.1`: a stripped x86-64 C++ library of 320 KB.

**The plugin interface is small.** The epkowa backend `dlsym`s these and
nothing else:

| Symbol | Shape (from disassembly) | Role |
|---|---|---|
| `int_init` | `bool (int fd, read_cb, write_cb)` | stores the USB callbacks and builds the emulator |
| `int_write` / `int_read` | `(buf, len)` | ESC/I commands in, ESC/I replies and image data out |
| `int_fini` | `void ()` | tears down |
| `int_power_saving_mode` | | lamp/sleep timer |
| `function_s_0` / `function_s_1` | `(int,int,int,int,double*)` / `(u8*,u8*,int,int,double*,u8)` | image helpers the backend calls |

The backend also probes for `int_init_with_ctrl`.

**The plugin runs ESC/I on the host and drives the hardware directly.** Its
symbols are obfuscated (`esint7C_SYMBOL_NNN`), but the C++ mangling kept the
struct names: `stESC_CMD`, `stScanning_Param`, `stMotor_Control`,
`stCCD_Time`, `stADC`, `stGainTable_Param`, `stALOCTable_Param`,
`stShading`, `stShift`, `stSH_SETTING`. So once the firmware is loaded, the
scanner is a low-level device.

That means an open driver has to rebuild all of these:
- motor control
- sensor (CCD) timing
- analog front-end gain and offset (the ADC)
- shading calibration
- RGB line-shift correction

This is the genesys-backend kind of job, not a firmware loader.

**The firmware is plain data, not encrypted.** `esfw7C.bin` is 65,793 bytes
(0x10101), entropy 6.1 bits/byte, and contains the string
`EPSON   GT-X770         1.02`. The plugin loads it itself, from
`$ISCAN_FW_DIR/esfw7C.bin` or else `/usr/share/iscan/esfw7C.bin`. Its CPU
architecture is not identified yet.

The plugin only reaches the scanner through the two callbacks the host passes
to `int_init`. That gives us a clean place to tap the traffic: our own host
program loads the plugin, hands it logging callbacks, and records every USB
transfer next to the ESC/I command that caused it.

## Options

**A. Use the vendor stack, and share the scanner over the network (works today).**
Use an x86-64 Linux box or VM with `iscan`, `iscan-data` and the gt-x770
plugin. [epson-esci](https://github.com/Davan-Etelamaki/epson-esci) automates
the fetch and the install. Then share the scanner through `saned`, or through
an eSCL/AirScan server such as AirSane. Macs and phones then see it as a
driverless network scanner. On a Raspberry Pi the whole SANE process would
have to run under box64, which nobody has tested.

**B. Write an open driver (the real "custom driver").**
1. Get A working on x86 and record USB traffic with `usbmon` and Wireshark:
   the firmware upload, a preview, a full scan, and the transparency unit.
2. Open the plugin `.so` in Ghidra to read the command set and the image
   pipeline.
3. Write a libusb SANE backend. The user supplies `esfw7C.bin` from their own
   Epson download, the same way the `snapscan` backend handles firmware.

**C. Custom firmware on the scanner.** The firmware is uploaded on every power
cycle and nothing is flashed, so running our own code on the scanner's CPU
can't brick it. Step one is to identify the CPU architecture in `esfw7C.bin`.
This is speculative.

## Licensing

Epson's EULA forbids redistributing the plugin and the firmware. Do not commit
the `.so`, `esfw7C.bin` or the bundle to this repo. Commit URLs, checksums and
our own notes and code only. Analysing files you downloaded yourself for
hardware you own falls under the EULA's personal-use grant.

## Next steps

- [x] Download the bundle, check its sha256, and do a first static pass on the plugin.
- [x] Trace harness (`tools/trace.c`): captured the firmware upload without
      hardware. See [PROTOCOL.md](PROTOCOL.md).
- [ ] Trace with the real scanner: every ESC/I command and the USB traffic it
      turns into.
- [ ] Open firmware loader (pyusb), first test on hardware.
- [ ] Identify the CPU architecture of `esfw7C.bin`.
- [ ] The driver plan and the photo booth design are in [DESIGN.md](DESIGN.md).
