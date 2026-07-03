"""Gateway child-process supervision (C7 as redefined by AMD-1/FD3).

The daemon owns every agent gateway as a direct child: spawn → monitor →
backoff-restart while desired, graceful SIGTERM→SIGKILL on stop, everything
torn down on shutdown (gateway lifetime ⊆ daemon lifetime — L1).
"""

from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from dataclasses import dataclass, field

from caduceus.core.errors import ConflictError, NotFoundError
from caduceus.core.ports import Clock, EventSink, ProcessHandle, ProcessSpawner
from caduceus.core.types import CoreEvent, ProcessState

BACKOFF_BASE_S = 1.0
BACKOFF_CAP_S = 60.0
BACKOFF_RESET_AFTER_S = 300.0  # stable run duration → attempt counter reset
CRASHLOOP_THRESHOLD = 5  # L6
STOP_GRACE_S = 15.0
LOG_BUFFER_LINES = 2000


def next_backoff_s(attempt: int) -> float:
    """Pure backoff schedule (P8): 1, 2, 4, ... capped at 60s.

    ``attempt`` is the number of consecutive failures already observed (≥0).
    """
    if attempt < 0:
        raise ValueError("attempt must be >= 0")
    exponent = min(attempt, 6)  # 2**6 = 64 > cap; avoids huge intermediates
    return min(BACKOFF_BASE_S * (2.0**exponent), BACKOFF_CAP_S)


@dataclass
class _Managed:
    agent: str
    argv: list[str]
    state: ProcessState = "starting"
    handle: ProcessHandle | None = None
    restart_count: int = 0
    last_exit_code: int | None = None
    started_at_mono: float = 0.0
    desired_running: bool = True
    logs: deque[str] = field(default_factory=lambda: deque(maxlen=LOG_BUFFER_LINES))
    monitor_task: asyncio.Task[None] | None = None


@dataclass(frozen=True)
class ProcessInfo:
    agent: str
    state: ProcessState
    pid: int | None
    restart_count: int
    last_exit_code: int | None


class GatewayProcessManager:
    def __init__(
        self,
        spawner: ProcessSpawner,
        clock: Clock,
        events: EventSink,
    ) -> None:
        self._spawner = spawner
        self._clock = clock
        self._events = events
        self._managed: dict[str, _Managed] = {}
        self._shutting_down = False

    # -- queries -----------------------------------------------------------

    def info(self, agent: str) -> ProcessInfo:
        managed = self._get(agent)
        return ProcessInfo(
            agent=agent,
            state=managed.state,
            pid=managed.handle.pid if managed.handle else None,
            restart_count=managed.restart_count,
            last_exit_code=managed.last_exit_code,
        )

    def is_managed(self, agent: str) -> bool:
        return agent in self._managed

    def log_lines(self, agent: str, *, last: int = 200) -> list[str]:
        managed = self._get(agent)
        return list(managed.logs)[-last:]

    # -- lifecycle ----------------------------------------------------------

    async def start(self, agent: str, argv: list[str]) -> None:
        if self._shutting_down:
            raise ConflictError("daemon is shutting down")
        existing = self._managed.get(agent)
        if existing and existing.state in ("starting", "running", "stopping"):
            raise ConflictError(f"gateway for {agent!r} already running")
        managed = _Managed(agent=agent, argv=list(argv))
        self._managed[agent] = managed
        await self._spawn(managed)

    async def stop(self, agent: str) -> None:
        """Non-destructive stop (L2): terminate process, keep everything else."""
        managed = self._get(agent)
        managed.desired_running = False
        if managed.monitor_task:
            managed.monitor_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await managed.monitor_task
            managed.monitor_task = None
        await self._terminate(managed)
        managed.state = "exited"
        del self._managed[agent]
        self._emit(agent, "process.state", state="stopped")

    async def shutdown(self) -> None:
        """Daemon exit: stop every child in parallel (L1)."""
        self._shutting_down = True
        agents = list(self._managed)
        await asyncio.gather(
            *(self.stop(agent) for agent in agents), return_exceptions=True
        )

    # -- internals -----------------------------------------------------------

    def _get(self, agent: str) -> _Managed:
        try:
            return self._managed[agent]
        except KeyError:
            raise NotFoundError(f"no managed gateway for agent {agent!r}") from None

    async def _spawn(self, managed: _Managed) -> None:
        managed.state = "starting"
        handle = await self._spawner.spawn(managed.argv)
        managed.handle = handle
        managed.started_at_mono = self._clock.monotonic()
        managed.state = "running"
        self._emit(managed.agent, "process.state", state="running", pid=handle.pid)
        managed.monitor_task = asyncio.get_running_loop().create_task(
            self._monitor(managed)
        )

    async def _monitor(self, managed: _Managed) -> None:
        handle = managed.handle
        if handle is None:  # _spawn always sets it; guard for type narrowing
            raise NotFoundError(f"no process handle for {managed.agent!r}")
        log_task = asyncio.get_running_loop().create_task(
            self._pump_logs(managed, handle)
        )
        try:
            exit_code = await handle.wait()
        finally:
            log_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await log_task

        managed.last_exit_code = exit_code
        ran_for = self._clock.monotonic() - managed.started_at_mono
        if ran_for >= BACKOFF_RESET_AFTER_S:
            managed.restart_count = 0

        if self._shutting_down or not managed.desired_running:
            managed.state = "exited"
            return

        managed.restart_count += 1
        if managed.restart_count >= CRASHLOOP_THRESHOLD:
            managed.state = "crashlooping"
            self._emit(
                managed.agent,
                "process.crashloop",
                restarts=managed.restart_count,
                exit_code=exit_code,
            )
            return  # L6: stop auto-retrying; explicit user start resets

        delay = next_backoff_s(managed.restart_count - 1)
        managed.state = "exited"
        self._emit(
            managed.agent,
            "process.restarting",
            exit_code=exit_code,
            delay_s=delay,
            attempt=managed.restart_count,
        )
        await self._clock.sleep(delay)
        if self._shutting_down or not managed.desired_running:
            return
        await self._spawn(managed)

    async def _pump_logs(self, managed: _Managed, handle: ProcessHandle) -> None:
        with contextlib.suppress(Exception):
            async for line in handle.iter_output():
                managed.logs.append(line)

    async def _terminate(self, managed: _Managed) -> None:
        handle = managed.handle
        if handle is None or handle.returncode is not None:
            return
        managed.state = "stopping"
        handle.terminate()
        try:
            await asyncio.wait_for(handle.wait(), timeout=STOP_GRACE_S)
        except TimeoutError:
            handle.kill()
            await handle.wait()

    def _emit(self, agent: str, kind: str, **data: object) -> None:
        self._events.emit(
            CoreEvent(kind=kind, agent=agent, data=dict(data), ts=self._clock.now_iso())
        )
