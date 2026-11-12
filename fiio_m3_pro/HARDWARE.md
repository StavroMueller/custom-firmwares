# FiiO M3 Pro — hardware facts

Source: FiiO OTA in `~/Downloads/recovery-update` (Ingenic split-zip format,
75 signed chunks). Reassembled `xImage` = uImage "Linux-3.10.14-g37b5666",
built 2021-04-26, self-extracting (load/entry 0x80F00000), gzip payload at
file offset 0x4060. Decompressed kernel runs at VMA **0x80010000**.

Status: **CONFIRMED** = read out of the stock kernel binary.

## Flash layout (CONFIRMED, device.xml)
| part     | offset    | size      | mtd |
|----------|-----------|-----------|-----|
| uboot    | 0x0       | 0x100000  | 0   |
| kernel   | 0x100000  | 0x420000  | 1   |
| recovery | 0x520000  | 0x600000  | 2   |
| rootfs   | 0xb20000  | 0x5000000 | 3 (UBI) |
| data     | 0x5b20000 | 0x24e0000 | 4   |
NAND capacity 0x8000000 (128 MiB). OTA ships x-loader (26624 B @0),
xImage (@0x100000), system.ubi (@0xb20000).

## Display (CONFIRMED)
X1000 SLCD, **16-bit bus**, → **SSD1963** → panel (ST7701S, SPI-initialised).
Panel scan is **480×800**; visible window is columns **70..409** (340 px).

SSD1963 init (kernel table @ file off 0x5f32ec; type 0=cmd 1=data 2=udelay):
```
E2 23 01 04          PLL M=35 N=1
E0 01 ; delay 1000   PLL enable
E0 03 ; delay 5000   PLL lock
01    ; delay 5000   soft reset
E6 22 22 01          LSHIFT (FPR = 0x22201, top nibble of byte0 ignored)
B0 04 00 01DF 031F 00 ; delay 5000   480x800 TFT
B4 0214 0019 02 0014 00             HT=533 HPS=26 HPW=3 LPS=20
B6 0336 0010 02 0004                VT=823 VPS=17 VPW=3 FPS=4
36 00
3A 50
F0 03 ; delay 5000   16-bit 565
2A 0046 0199         columns 70..409
2B 0000 031F         rows 0..799
2C x4 ; delay 120000
29                   display on
```
ST7701S init is inline code at VMA 0x800125f0, extracted into
`lcd-fiiom3pro.c`. SPI: SDA PC0, SCK PC2, CS = PB18 (shared with SLCD CS);
9-bit words (D/C + 8 bits MSB first), ~5 us half-period, CS per word.
Reset: PB14 low/high (`J3_LCD_SSD1963_Reset`). Sleep = 0x10, wake = 0x11.
Backlight = X1000 **PWM0 on PC25** (measured; see below) + LDO enable PC3.

## GPIOs (CONFIRMED, from gpio_request() calls)
| gpio | pin  | stock label        |
|------|------|--------------------|
| 16   | PA16 | ES9218_RST         |
| 17   | PA17 | TUSB320 CC_ENABLE  |
| 40   | PB8  | GPIO_USB_POWER_ON  |
| 41   | PB9  | GPIO_OTG_ID        |
| 42   | PB10 | GPIO_AXP192_IRQ    |
| 45   | PB13 | otg enable pin     |
| 46   | PB14 | LCD_SPI_RST        |
| 48   | PB16 | GPIO_PB(16)        |
| 50   | PB18 | lcd cs             |
| 55   | PB23 | es9218 scl (I2C0 pins) |
| 56   | PB24 | es9218 sda (I2C0 pins) |
| 57   | PB25 | GPIO_USB_CHANGE_EN |
| 58   | PB26 | rtc32k             |
| 64   | PC0  | LCD_SPI_SDA        |
| 66   | PC2  | LCD_SPI_CLK        |
| 67   | PC3  | BL LDO ENABLE      |
| 85   | PC21 | es9218 mck en      |
| 88   | PC24 | pwm4 (label only — pin is an unused input) |

(Keys, touch IRQ and SD detect were found later on the live device, below.)

## Other chips (CONFIRMED)
- PMU: **AXP192** (FiiO driver named `axp173`). Headphone detect on AXP
  **GPIO3**. DCDC1 3.3 V, DCDC2 1.4 V, DCDC3 1.8 V, LDO2/LDO3 3.3 V.
- DAC: **ES9218** with its own MCLK oscillator (enable on PC21).
- Touch: **Hynitron CST3xx** (not FocalTech) — needs a new Rockbox driver.
- USB-C: **TUSB320** CC controller.
- USB IDs: stock OS enumerates as 2972:0044 (DAC mode: UAC2 + HID only,
  **no ADB interface**).

## Live device data (ADB, 2026-11-11) — raw dumps in `adb-dump/`
ADB: Settings → About → tap the 3rd item ≥10× → "ADB MODE" (USB becomes
18d1:d002 adb-only until reboot). Root shell. Running kernel is an older
build (3.10.14-g07d574f, 2020-09-29) than the OTA analysed above.

cmdline: `mem=64M@0x0 no_console_suspend console=ttyS2,115200n8 lpj=5009408
ip=off init=/linuxrc ubi.mtd=3 root=ubi0:rootfs ubi.mtd=4 rootfstype=ubifs rw`
(Note: same string as the Shanling Q1's OF args.)

fb0: 340x800, 16 bpp, 60 Hz.

### I2C
| bus | addr | device |
|-----|------|--------|
| 1   | 0x1a | cst3xx touch |
| 2   | 0x34 | AXP192 (driver "axp173") |
| 2   | 0x47 | TUSB320 USB-C CC |
| 2   | 0x57 | AT24 EEPROM (+0x58–0x5e dummies) |
| — | — | ES9218: bit-banged by stock kernel on PB23/PB24 (= I2C0 pins); no i2c-0 adapter |

### Additional GPIOs (from /sys/kernel/debug/gpio + /proc/interrupts)
| gpio | pin  | label | state |
|------|------|-------|-------|
| 19   | PA19 | VOL INC & PRE SONG  | in hi (key, active low) |
| 38   | PB6  | mmc_detect          | in hi |
| 39   | PB7  | tusb320_int_gpio    | in hi |
| 43   | PB11 | VBUS DETECT_WAKEUP  | in hi |
| 44   | PB12 | cst3xx gpio irq     | in hi |
| 60   | PB28 | VOL DEC & NEXT SONG | in hi (key, active low) |
| 63   | PB31 | J3 POWER KEY        | in hi (key, active low) |
| 87   | PC23 | PLAY_PAUSE KEY      | in hi (key, active low) |

**Four physical keys only** (vol+/prev and vol−/next share a key each).
Touch has **no reset GPIO**: the stock driver soft-resets via I2C write to
register 0xD10E, then waits. No ES9218 power-enable GPIO seen (likely an
AXP rail); DAC MCLK oscillator enable is PC21.

### PMU rails (CONFIRMED from stock AXP register writes)
DCDC1 (0x26)=0x68 3.3 V, DCDC2 (0x23)=0x1c 1.4 V at init then 0x15 1.225 V
(`update_core_work v1.225`; DCDC2 = CPU core), DCDC3 (0x27)=0x2c 1.8 V,
LDO2/3 (0x28)=0xff 3.3 V, GPIO3/4 func (0x95)=0x8e, HP detect = reg 0x96 bit 4.
Note: Rockbox's axp192_supply_set_voltage() mishandles LDO2 (value not shifted
into the high nibble), so the port writes reg 0x28 directly.

### CST3xx touch protocol (CONFIRMED from stock driver at 0x80341414)
Read 7 bytes from reg 0xD000; b6 == 0xAB; b5&0x7f = points (stock: single
touch); (b0&0xf)==6 => down; x=(b1<<4)|(b3>>4) on 0..360, y=(b2<<4)|(b3&0xf)
on 0..800; x scaled to 340 then both axes mirrored. Always ack by writing
D0 00 AB. Soft reset = write D1 0E. No reset GPIO.

### Measured on the live device (devmem, read-only)
- Backlight: TCU **channel 0** (PWM0, PC25). Full = 0x960 (2400 @ 24 MHz =
  10 kHz), half-compare = full - on-time (brightness 255 -> 1, 10 -> 0x902),
  linear, active-high. PC25 goes to PWM function when screen is on.
- SLCD clock: LPCDR = MPLL(600 MHz)/20 = **30 MHz**. MCTRL = 0x115
  (NOT_USE_TE=1, FAST_MODE, DMA_MODE). MCFG.CWIDTH = 16-bit cmds,
  MCFG_NEW.DWIDTH = 16-bit data. WTIME = TASH = 0. DAH = 340, DAV = 800.
- Clocks: APLL 1008 MHz, MPLL 600 MHz. CCR = 0x9a752210 (CPU 1008, L2 504,
  AHB0 = MPLL/3 200, AHB2 = MPLL/6 100, PCLK /8 75 MHz). DDR = MPLL/3.
  MSC0 = MPLL/12 = 50 MHz.
- Keys: four GPIO keys, idle high (=> active low); press/release events
  seen on /dev/input/event1 during a hold test.
