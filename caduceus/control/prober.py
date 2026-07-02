"""Health prober (FD8): periodic /health polling with consecutive-failure gating."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Awaitable, Callable

from caduceus.core.ports import Clock, EventSink
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry
from caduceus.core.types import CoreEvent, HealthState

logger = logging.getLogger(__name__)

FAIL_THRESHOLD = 3  # consecutive failures before "unreachable" (FD8)

# Injected probe: port → True(200) / False(non-200) / None(connect fail/timeout).
ProbeFn = Callable[[int], Awaitable[bool | None]]


class HealthProber:
    def __init__(
        self,
        registry: Registry,
        manager: GatewayProcessManager,
        probe: ProbeFn,
        clock: Clock,
        events: EventSink,
        *,
        interval_s: float,
    ) -> None:
        self._registry = registry
        self._manager = manager
        self._probe = probe
        self._clock = clock
        self._events = events
        self._interval = interval_s
        self._health: dict[str, HealthState] = {}
        self._consecutive_failures: dict[str, int] = {}
        self._task: asyncio.Task[None] | None = None

    def health_of(self, agent: str) -> HealthState:
        return self._health.get(agent, "unknown")

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def probe_once(self) -> None:
        for record in self._registry.list():
            agent = record.spec.name
            if not self._manager.is_managed(agent):
                self._set(agent, "unknown")
                self._consecutive_failures.pop(agent, None)
                continue
            result = await self._probe(record.api_port)
            if result is True:
                self._consecutive_failures[agent] = 0
                self._set(agent, "healthy")
            elif result is False:
                self._consecutive_failures[agent] = 0
                self._set(agent, "unhealthy")
            else:  # connect failure / timeout
                failures = self._consecutive_failures.get(agent, 0) + 1
                self._consecutive_failures[agent] = failures
                if failures >= FAIL_THRESHOLD:
                    self._set(agent, "unreachable")
                # below threshold: keep previous state (no flapping)

    async def _loop(self) -> None:
        while True:
            try:
                await self.probe_once()
            except Exception:  # noqa: BLE001 - prober must never die
                logger.exception("health probe cycle failed")
            await self._clock.sleep(self._interval)

    def _set(self, agent: str, state: HealthState) -> None:
        previous = self._health.get(agent, "unknown")
        if previous != state:
            self._health[agent] = state
            self._events.emit(
                CoreEvent(
                    kind="health.changed",
                    agent=agent,
                    data={"from": previous, "to": state},
                    ts=self._clock.now_iso(),
                )
            )
