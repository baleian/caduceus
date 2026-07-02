"""EventBus example tests: subscription lifecycle, failure isolation (P4)."""

from __future__ import annotations

import asyncio

from caduceus.control.events import EventBus
from caduceus.core.types import CoreEvent

EVENT = CoreEvent(kind="test", data={}, ts="2026-07-03T00:00:00Z")


def test_unsubscribe_stops_delivery() -> None:
    bus = EventBus()
    queue = bus.subscribe()
    bus.unsubscribe(queue)
    bus.emit(EVENT)
    assert queue.qsize() == 0


def test_full_queue_drops_without_raising() -> None:
    bus = EventBus()
    queue = bus.subscribe(max_pending=1)
    bus.emit(EVENT)
    bus.emit(EVENT)  # would overflow; must not raise (P4)
    assert queue.qsize() == 1
    assert len(bus.replay()) == 2  # replay unaffected by slow consumer


def test_multiple_subscribers_each_receive() -> None:
    bus = EventBus()
    q1, q2 = bus.subscribe(), bus.subscribe()
    bus.emit(EVENT)
    assert q1.qsize() == q2.qsize() == 1


async def test_async_consumption() -> None:
    bus = EventBus()
    queue = bus.subscribe()
    bus.emit(EVENT)
    event = await asyncio.wait_for(queue.get(), timeout=1)
    assert event.kind == "test"
