"""Event bus: in-proc pub/sub with a bounded replay buffer (PU2-6, rule P4).

Implements the ``EventSink`` port from U1, so core components emit through the
same object WS clients subscribe to.
"""

from __future__ import annotations

import asyncio
import logging
from collections import deque
from collections.abc import Callable

from caduceus.core.types import CoreEvent

logger = logging.getLogger(__name__)

REPLAY_BUFFER_SIZE = 500

Subscriber = Callable[[CoreEvent], None]


class EventBus:
    """Synchronous fan-out + async queue subscriptions for WS sessions.

    Emission never raises (P4): a failing subscriber is logged and skipped —
    observability must not break the operation that emitted the event.
    """

    def __init__(self, *, replay_size: int = REPLAY_BUFFER_SIZE) -> None:
        self._replay: deque[CoreEvent] = deque(maxlen=replay_size)
        self._queues: set[asyncio.Queue[CoreEvent]] = set()

    # EventSink port implementation
    def emit(self, event: CoreEvent) -> None:
        self._replay.append(event)
        for queue in list(self._queues):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer: drop for that consumer only, never block emitters.
                logger.warning("event queue full; dropping event for one subscriber")
            except Exception:  # noqa: BLE001 - P4: never propagate
                logger.exception("event subscriber failed")

    def replay(self) -> list[CoreEvent]:
        """Events in emission order (oldest first), bounded by the buffer."""
        return list(self._replay)

    def subscribe(self, *, max_pending: int = 1000) -> asyncio.Queue[CoreEvent]:
        queue: asyncio.Queue[CoreEvent] = asyncio.Queue(maxsize=max_pending)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[CoreEvent]) -> None:
        self._queues.discard(queue)
