"""Scan booth server: one scanner, any number of screens.

POST /api/scan starts a scan. Every screen connected to /ws watches it live:
  - JSON text messages: scan_started, scan_done, scan_failed
  - binary messages, one per strip: u32 x, u32 y (little-endian), then a JPEG
"""

import asyncio
import io
import logging
import secrets
import struct
import time
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import numpy as np
import segno
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi import Path as PathParam
from fastapi.responses import FileResponse, HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image

from v500 import Scanner, ScanSettings
from v500.fake import FakeScanner

from .config import Config
from .orient import place_strip, upright, upright_size

log = logging.getLogger("booth")
STATIC = Path(__file__).parent / "static"
PHOTO_ID = r"^[0-9a-f-]+$"


class Booth:
    def __init__(self, config: Config, scanner: Scanner):
        self.config = config
        self.scanner = scanner
        self.screens: set[WebSocket] = set()
        self.busy = False
        self.tasks: set[asyncio.Task] = set()
        config.photos_dir.mkdir(parents=True, exist_ok=True)

    def start_scan(self) -> str | None:
        """Start a scan in the background. Returns its photo id, or None if busy."""
        if self.busy:
            return None
        self.busy = True
        photo_id = time.strftime("%Y%m%d-%H%M%S-") + secrets.token_hex(2)
        task = asyncio.create_task(self._scan(photo_id))
        self.tasks.add(task)  # keep a reference so the task isn't garbage-collected
        task.add_done_callback(self.tasks.discard)
        return photo_id

    def photos(self, limit: int = 60) -> list[dict]:
        newest = sorted(self.config.photos_dir.glob("*.jpg"), reverse=True)[:limit]
        return [photo_links(p.stem) for p in newest]

    async def _scan(self, photo_id: str) -> None:
        rotate = self.config.rotate
        try:
            scan = await asyncio.to_thread(self.scanner.scan, ScanSettings(dpi=self.config.dpi))
            width, height = upright_size(scan.width, scan.height, rotate)
            await self._send_json(type="scan_started", id=photo_id, width=width, height=height)

            image = np.zeros((scan.height, scan.width, 3), np.uint8)
            top = 0
            async for strip in in_thread(scan.strips):
                image[top : top + len(strip)] = strip
                pixels, x, y = place_strip(strip, top, scan.height, rotate)
                await self._send_bytes(struct.pack("<II", x, y) + jpeg(pixels, quality=80))
                top += len(strip)

            path = self.config.photos_dir / f"{photo_id}.jpg"
            await asyncio.to_thread(path.write_bytes, jpeg(upright(image, rotate), quality=92))
            await self._send_json(type="scan_done", **photo_links(photo_id))
        except Exception as error:
            log.exception("scan %s failed", photo_id)
            await self._send_json(type="scan_failed", error=str(error))
        finally:
            self.busy = False

    async def _send_json(self, **event) -> None:
        await self._send(lambda ws: ws.send_json(event))

    async def _send_bytes(self, data: bytes) -> None:
        await self._send(lambda ws: ws.send_bytes(data))

    async def _send(self, send) -> None:
        for ws in list(self.screens):
            try:
                await send(ws)
            except Exception:
                self.screens.discard(ws)  # screen went away mid-scan


def photo_links(photo_id: str) -> dict:
    return {"id": photo_id, "url": f"/photos/{photo_id}.jpg", "page": f"/p/{photo_id}"}


def jpeg(pixels: np.ndarray, quality: int) -> bytes:
    out = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(pixels)).save(out, "JPEG", quality=quality)
    return out.getvalue()


async def in_thread(iterator: Iterator) -> AsyncIterator:
    """Iterate a blocking iterator without blocking the event loop."""
    done = object()
    while (item := await asyncio.to_thread(next, iterator, done)) is not done:
        yield item


def make_scanner(config: Config) -> Scanner:
    if config.scanner == "fake":
        return FakeScanner(config.fake_seconds, config.fake_images)
    raise ValueError(f"unknown scanner backend {config.scanner!r}")


def create_app(config: Config | None = None, scanner: Scanner | None = None) -> FastAPI:
    config = config or Config.from_env()
    booth = Booth(config, scanner or make_scanner(config))
    app = FastAPI(title="V500 scan booth")
    app.state.booth = booth

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    app.mount("/photos", StaticFiles(directory=config.photos_dir), name="photos")

    @app.get("/", include_in_schema=False)
    def booth_screen():
        return FileResponse(STATIC / "index.html")

    @app.get("/p/{photo_id}", response_class=HTMLResponse, include_in_schema=False)
    def guest_page(photo_id: str = PathParam(pattern=PHOTO_ID)):
        if not (config.photos_dir / f"{photo_id}.jpg").exists():
            raise HTTPException(404, "no such photo")
        return (STATIC / "guest.html").read_text().replace("{{id}}", photo_id)

    @app.post("/api/scan", status_code=202)
    async def scan():  # async: start_scan needs the event loop
        photo_id = booth.start_scan()
        if photo_id is None:
            raise HTTPException(409, "already scanning")
        return {"id": photo_id}

    @app.get("/api/status")
    def status():
        return {"busy": booth.busy}

    @app.get("/api/photos")
    def photos():
        return booth.photos()

    @app.get("/api/qr/{photo_id}.svg")
    def qr(request: Request, photo_id: str = PathParam(pattern=PHOTO_ID)):
        url = str(request.base_url).rstrip("/") + photo_links(photo_id)["page"]
        svg = io.BytesIO()  # a standalone file (with xmlns), so <img> can show it
        segno.make(url, error="m").save(svg, kind="svg", scale=8, xmldecl=False, light="#fff")
        return Response(svg.getvalue(), media_type="image/svg+xml")

    @app.websocket("/ws")
    async def screen(ws: WebSocket):
        await ws.accept()
        booth.screens.add(ws)
        try:
            while True:
                await ws.receive_text()  # screens don't talk; this just waits for disconnect
        except WebSocketDisconnect:
            booth.screens.discard(ws)

    return app
