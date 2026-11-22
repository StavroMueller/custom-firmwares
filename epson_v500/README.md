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

**Not verified yet:** whether the plugin does more than upload the firmware.
The name "interpreter" suggests it runs the ESC/I command set on the host and
drives a simple device. If it does, an open driver also has to rebuild the
shading and calibration logic. If it only uploads firmware and then passes
ESC/I through, an open driver is small. Taking the `.so` apart answers this,
and it decides how big option B below is.

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

- [ ] Download the bundle and check its sha256. Run `nm -D` and `strings` on the
      plugin `.so`, and identify the CPU architecture of `esfw7C.bin`.
- [ ] Bring up option A on an x86-64 Linux machine. Take the USB captures.
- [ ] Decide between B and C based on what the plugin turns out to do.
