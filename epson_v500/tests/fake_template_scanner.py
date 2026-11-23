"""A scanner that answers like the one in a template capture."""

from collections import deque

from v500 import replay


class TemplateScanner:
    """Replies to polls with 'ready' and 'not busy', and to everything else
    with the template's recorded replies, in order. Records what it's sent."""

    def __init__(self, template: replay.Template):
        self.replies = deque(
            step.data
            for g in template.groups
            if g.command not in (replay.POLL_READY, replay.STATUS)
            for step in g.steps
            if not step.out
        )
        self.writes: list[bytes] = []
        self.last_command = b""

    def write(self, data: bytes) -> None:
        self.writes.append(bytes(data))
        if len(data) == 2 and data[0] in (0x1B, 0x1E):
            self.last_command = bytes(data)

    def read(self, size: int) -> bytes:
        if self.last_command == replay.POLL_READY:
            return b"\x01"
        if self.last_command == replay.STATUS:
            return b"\x18\x81"
        reply = self.replies.popleft()
        assert len(reply) == size, f"replay asked for {size} bytes, template has {len(reply)}"
        return reply
