import json
import struct

import pytest
from fastapi.testclient import TestClient

from booth.app import create_app
from booth.config import Config
from v500.fake import FakeScanner


@pytest.fixture
def client(tmp_path):
    config = Config(photos_dir=tmp_path, dpi=50, rotate=90)
    with TestClient(create_app(config, FakeScanner(seconds_per_scan=0.2))) as client:
        yield client


def run_scan(client) -> tuple[dict, list[bytes], dict]:
    """Start a scan and collect what a screen sees: start event, strips, end event."""
    with client.websocket_connect("/ws") as ws:
        assert client.post("/api/scan").status_code == 202
        started = ws.receive_json()
        strips = []
        while (message := ws.receive()).get("bytes"):
            strips.append(message["bytes"])
        done = json.loads(message["text"])
    return started, strips, done


def test_a_scan_streams_strips_then_saves_the_photo(client, tmp_path):
    started, strips, done = run_scan(client)

    assert started["type"] == "scan_started"
    assert (started["width"], started["height"]) == (585, 425)  # A4 at 50 dpi, turned 90°
    assert strips and all(s[8:10] == b"\xff\xd8" for s in strips)  # JPEG after the header
    x, y = struct.unpack("<II", strips[0][:8])
    assert y == 0 and x > 0  # rotated 90°: the first rows land on the right edge

    assert done["type"] == "scan_done"
    assert (tmp_path / f"{done['id']}.jpg").exists()
    assert client.get(done["url"]).headers["content-type"] == "image/jpeg"
    assert client.get(done["page"]).status_code == 200
    assert client.get(f"/api/qr/{done['id']}.svg").text.startswith('<svg xmlns="http://www.w3.org/2000/svg"')
    assert client.get("/api/photos").json()[0]["id"] == done["id"]


def test_one_scan_at_a_time(client):
    assert client.post("/api/scan").status_code == 202
    assert client.post("/api/scan").status_code == 409


def test_unknown_or_unsafe_photo_ids_are_rejected(client):
    assert client.get("/p/20990101-000000-beef").status_code == 404
    assert client.get("/p/..%2Fsecrets").status_code in (404, 422)
