# Rockbox on the FiiO M3 Pro

Native Rockbox port for the FiiO M3 Pro (Ingenic X1000E), plus a custom
TUI theme. Running on a retail unit with the bootloader installed to flash.

| Path | What |
|---|---|
| `patches/` | the port, as a patch against upstream Rockbox `c9d000b7` |
| `HARDWARE.md` | every hardware fact and where it came from (stock kernel, ADB, live registers) |
| `themes/tui/` | the TUI theme; `gen.py` generates it |
| `adb-dump/` | raw dumps from the stock OS (`/proc`, GPIO, I2C, register test logs) |
| `backups/fiiom3pro-boot.bin` | **original first flash block (FiiO x-loader), needed to restore stock** |

## Status

- **Works on hardware:** USB boot, bootloader install, LCD, backlight, keys,
  touch, NAND, SD card, USB storage, booting the stock firmware from the
  bootloader, the Rockbox main firmware.
- **Not yet verified:** audio output (ES9218), headphone detect, battery curves.
- **Excluded plugins:** rockblox, bubbles, invadrox, jewels and wormlet have
  no 340x800 layout yet.

## Rebuilding

```sh
git clone https://github.com/Rockbox/rockbox.git rockbox
cd rockbox && git checkout c9d000b7980831fc8fa6f5558681dd9a2191e3e3
git am ../patches/*.patch
```

Toolchain (macOS, Apple Silicon):

```sh
brew install coreutils texinfo automake autoconf gmp mpfr libmpc isl gnu-tar gcc
# macOS 26 SDK declares pipe2() but libSystem lacks it -> GCC 9.5 crashes without this
cd rockbox/tools && ac_cv_func_pipe2=no RBDEV_PREFIX=$HOME/rockbox-tc ./rockboxdev.sh --target=i
export PATH="$HOME/rockbox-tc/bin:$PATH"
```

Build (GNU tar must be `tar` for the bootloader package):

```sh
export PATH="$(brew --prefix)/opt/gnu-tar/libexec/gnubin:$PATH"
mkdir build-m3pro && cd build-m3pro && ../rockbox/tools/configure --target=fiiom3pro --type=N && gmake -j && gmake zip
mkdir build-m3pro-boot && cd build-m3pro-boot && ../rockbox/tools/configure --target=fiiom3pro --type=B && gmake -j
```

jztool (USB boot loader):

```sh
cd rockbox/utils/jztool && make LIBUSB_CFLAGS="$(pkg-config --cflags libusb-1.0)" LIBUSB_LDOPTS="$(pkg-config --libs libusb-1.0)"
```

## Using it

- **SD card:** FAT32 with MBR (not exFAT). Unzip `build-m3pro/rockbox.zip`
  to the card root, then copy `themes/tui/.rockbox` over it for the theme.
- **USB boot mode:** power off, then hold **vol-** while plugging in USB. The
  screen stays black and the Mac sees `a108:1000`. Then run
  `jztool fiiom3pro load build-m3pro-boot/bootloader.m3pro`. This only loads
  into RAM.
- **Power-on keys, once installed:**

  | Held at power-on | Result |
  |---|---|
  | nothing | Rockbox |
  | play | FiiO firmware |
  | vol+ | bootloader menu |
  | play + vol+ | FiiO recovery |

- **ADB on the stock OS:** Settings > About, tap the 3rd item 10 times.

## Restoring stock

1. Put `backups/fiiom3pro-boot.bin` in the SD card root, named exactly that.
2. USB boot and load the bootloader (above).
3. Choose **Restore**.

Don't run **Backup** once Rockbox is installed: it would overwrite the
stock backup file on the card with the Rockbox block.

## TUI theme

`themes/tui/gen.py` writes the skins, the theme config and the colour file
on a 34x40 grid of 10x20 cells (Terminus). Edit the script, not the
generated files, then validate with checkwps (`configure --type=C`,
needs Homebrew `gcc-16`).
