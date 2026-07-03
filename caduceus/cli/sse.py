"""Minimal SSE parser (tech-stack decision: hand-rolled, ~30 lines of logic).

Consumes an iterator of raw byte chunks (any chunking) and yields
``SseEvent(event, data)`` per spec block. Tolerant by design (PU3-3): unknown
fields and comment lines are ignored, malformed text never raises, multiple
``data:`` lines are joined with ``\\n``.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass

DEFAULT_EVENT = "message"


@dataclass(frozen=True)
class SseEvent:
    event: str
    data: str


def _parse_block(block: str) -> SseEvent | None:
    event = DEFAULT_EVENT
    data_lines: list[str] = []
    for line in block.split("\n"):
        if not line or line.startswith(":"):
            continue  # comment / keepalive
        field, _, value = line.partition(":")
        value = value.removeprefix(" ")
        if field == "event" and value:
            event = value
        elif field == "data":
            data_lines.append(value)
    if not data_lines and event == DEFAULT_EVENT:
        return None  # nothing meaningful in this block
    return SseEvent(event=event, data="\n".join(data_lines))


def iter_sse(chunks: Iterable[bytes]) -> Iterator[SseEvent]:
    import codecs

    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    buffer = ""
    for chunk in chunks:
        buffer += decoder.decode(chunk)
        buffer = buffer.replace("\r\n", "\n").replace("\r", "\n")
        while "\n\n" in buffer:
            block, buffer = buffer.split("\n\n", 1)
            parsed = _parse_block(block)
            if parsed is not None:
                yield parsed
    # trailing block without terminator (stream cut mid-event) is dropped by
    # design — a partial event must not be rendered as if complete (U3-REL-2
    # keeps already-yielded output; incomplete data is not fabricated)
