"""Booth settings, read from BOOTH_* environment variables."""

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    scanner: str = "fake"              # "fake", or "replay" for the real scanner
    dpi: int = 150
    rotate: int = 0                    # degrees clockwise to turn each scan upright: 0/90/180/270
    photos_dir: Path = Path("photos")
    fake_seconds: float = 8.0          # how long a fake scan takes
    fake_images: Path | None = None    # folder of JPEGs for the fake scanner to replay
    templates: Path | None = None      # replay: folder of captures of Epson's driver
    firmware: Path | None = None       # replay: esfw7C.bin, uploaded after a power cycle

    @classmethod
    def from_env(cls) -> "Config":
        env = os.environ.get
        config = cls(
            scanner=env("BOOTH_SCANNER", cls.scanner),
            dpi=int(env("BOOTH_DPI", cls.dpi)),
            rotate=int(env("BOOTH_ROTATE", cls.rotate)),
            photos_dir=Path(env("BOOTH_PHOTOS_DIR", cls.photos_dir)),
            fake_seconds=float(env("BOOTH_FAKE_SECONDS", cls.fake_seconds)),
            fake_images=Path(p) if (p := env("BOOTH_FAKE_IMAGES")) else None,
            templates=Path(p) if (p := env("BOOTH_TEMPLATES")) else None,
            firmware=Path(p) if (p := env("BOOTH_FIRMWARE")) else None,
        )
        if config.rotate not in (0, 90, 180, 270):
            raise ValueError(f"BOOTH_ROTATE must be 0, 90, 180 or 270, not {config.rotate}")
        return config
