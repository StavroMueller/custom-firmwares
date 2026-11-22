"""A scanner that needs no hardware, for building and testing the booth.

It "scans" an image at the speed of a real scan head. By default it draws a
cartoon face pressed against the glass. Point it at a folder of images to
replay real scans instead.
"""

import random
import time
from collections.abc import Iterator
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

from .scanner import Scan, ScanSettings, bed_size_px

STRIP_ROWS = 32


class FakeScanner:
    def __init__(self, seconds_per_scan: float = 8.0, image_dir: Path | None = None):
        self.seconds_per_scan = seconds_per_scan
        self.image_dir = image_dir

    def scan(self, settings: ScanSettings) -> Scan:
        width, height = bed_size_px(settings.dpi)
        image = self._next_image(width, height)
        return Scan(width, height, self._strips(image))

    def close(self) -> None:
        pass

    def _strips(self, image: np.ndarray) -> Iterator[np.ndarray]:
        height = image.shape[0]
        delay = self.seconds_per_scan * STRIP_ROWS / height
        for top in range(0, height, STRIP_ROWS):
            time.sleep(delay)
            yield image[top : top + STRIP_ROWS]

    def _next_image(self, width: int, height: int) -> np.ndarray:
        samples = sorted(self.image_dir.glob("*.jp*g")) if self.image_dir else []
        if samples:
            picked = Image.open(random.choice(samples)).convert("RGB")
            return np.asarray(picked.resize((width, height)))
        return pressed_face(width, height)


def pressed_face(width: int, height: int) -> np.ndarray:
    """A cartoon of a face squashed against scanner glass, on a dark room."""
    s = width / 1275  # drawn at 150 dpi, scaled to fit
    img = Image.new("RGB", (width, height), (8, 6, 14))
    draw = ImageDraw.Draw(img)

    def box(cx, cy, rx, ry):
        return [(cx - rx) * s, (cy - ry) * s, (cx + rx) * s, (cy + ry) * s]

    hue = random.choice([(255, 196, 160), (224, 172, 128), (176, 118, 82), (120, 80, 56)])
    shadow = tuple(int(c * 0.75) for c in hue)
    cx, cy = 640, 900

    draw.ellipse(box(cx, cy - 170, 520, 420), fill=(30, 20, 26))   # hair
    draw.ellipse(box(cx, cy, 430, 540), fill=hue)                    # face, squashed wide
    draw.ellipse(box(cx, cy + 40, 400, 500), fill=shadow)            # contact patch
    draw.ellipse(box(cx, cy + 20, 380, 470), fill=hue)
    for ex in (cx - 170, cx + 170):                                   # eyes, closed
        draw.arc(box(ex, cy - 90, 90, 40), 10, 170, fill=(40, 24, 24), width=int(14 * s))
    draw.ellipse(box(cx, cy + 90, 110, 85), fill=shadow)             # flattened nose
    draw.ellipse(box(cx - 35, cy + 105, 18, 14), fill=(60, 36, 36))
    draw.ellipse(box(cx + 35, cy + 105, 18, 14), fill=(60, 36, 36))
    draw.ellipse(box(cx, cy + 290, 190, 70), fill=(150, 50, 60))     # squished lips
    draw.line([((cx - 170) * s, (cy + 290) * s), ((cx + 170) * s, (cy + 290) * s)],
              fill=(90, 24, 34), width=int(10 * s))
    for hx in (cx - 560, cx + 560):                                   # hands on the glass
        draw.ellipse(box(hx, cy + 520, 170, 230), fill=hue)
        for finger in range(4):
            fx = hx - 120 + finger * 80
            draw.rounded_rectangle(box(fx, cy + 220, 34, 120), radius=30 * s, fill=hue)

    img = img.filter(ImageFilter.GaussianBlur(3 * s))                # shallow depth of field
    pixels = np.asarray(img).astype(np.int16)
    noise = np.random.default_rng().normal(0, 6, pixels.shape)       # sensor grain
    return np.clip(pixels + noise, 0, 255).astype(np.uint8)
