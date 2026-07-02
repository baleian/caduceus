"""Lifecycle service: start/stop, status synthesis, logs (C4, logic §3)."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

from caduceus.core.errors import NotFoundError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry
from caduceus.core.types import (
    AgentRecord,
    AgentStatus,
    ContainerState,
    DesiredState,
    HealthState,
)

logger = logging.getLogger(__name__)

# Best-effort budget for stopping active runs before SIGTERM (logic §3.1).
RUN_STOP_BUDGET_S = 5.0

# Attempt to stop active runs on the agent's api_server; injected so tests and
# the daemon wire it independently of any HTTP framework. Returns silently on
# any failure — this is strictly best-effort.
RunStopFn = Callable[[AgentRecord], Awaitable[None]]

ProcessView = str  # ProcessState | "not-running"


def synthesize_status(
    name: str,
    desired: DesiredState,
    process: ProcessView,
    health: HealthState,
    container: ContainerState,
) -> AgentStatus:
    """Pure synthesis per the §3.3 truth table (PU2-1 oracle target)."""
    summary: str
    if desired == "running":
        if process == "crashlooping":
            summary = "crashlooping"
        elif process in ("running",):
            if health == "healthy":
                summary = "ok"
            elif health in ("unhealthy", "unreachable"):
                summary = "degraded"
            else:  # unknown — probe pending
                summary = "starting"
        elif process in ("starting", "stopping"):
            summary = "starting" if process == "starting" else "stopping"
        else:  # exited / not-running
            summary = "drift-start-needed"
    else:  # desired stopped
        if process in ("running", "starting"):
            summary = "drift-stop-needed"
        elif process == "crashlooping":
            summary = "crashlooping"
        else:
            summary = "stopped"
    return AgentStatus(
        name=name,
        desired_state=desired,
        process=process,  # type: ignore[arg-type]
        health=health,
        container=container,
        detail={"summary": summary},
    )


class LifecycleService:
    def __init__(
        self,
        registry: Registry,
        manager: GatewayProcessManager,
        hermes: HermesAdapter,
        *,
        health_of: Callable[[str], HealthState],
        run_stop: RunStopFn,
    ) -> None:
        self._registry = registry
        self._manager = manager
        self._hermes = hermes
        self._health_of = health_of
        self._run_stop = run_stop

    async def start(self, name: str) -> None:
        record = self._registry.get(name)
        await self._manager.start(name, self._hermes.gateway_argv(record.profile_name))
        self._registry.set_desired_state(name, "running")

    async def stop(self, name: str) -> None:
        record = self._registry.get(name)
        if self._manager.is_managed(name):
            try:
                await self._run_stop(record)  # graceful: stop active runs first (N4)
            except Exception:  # noqa: BLE001 - strictly best-effort
                logger.debug("run-stop best effort failed for %s", name)
            await self._manager.stop(name)
        self._registry.set_desired_state(name, "stopped")

    async def status(
        self, name: str | None = None, *, probe_container: bool = True
    ) -> list[AgentStatus]:
        records = [self._registry.get(name)] if name else self._registry.list()
        statuses: list[AgentStatus] = []
        for record in records:
            agent = record.spec.name
            process: ProcessView = (
                self._manager.info(agent).state
                if self._manager.is_managed(agent)
                else "not-running"
            )
            container: ContainerState = "unknown"
            if probe_container:
                container = await self._hermes.container_state(record.profile_name)  # type: ignore[assignment]
            statuses.append(
                synthesize_status(
                    agent, record.desired_state, process, self._health_of(agent), container
                )
            )
        return statuses

    def logs(self, name: str, *, last: int = 200) -> list[str]:
        self._registry.get(name)
        if not self._manager.is_managed(name):
            raise NotFoundError(f"agent {name!r} has no running gateway")
        return self._manager.log_lines(name, last=last)
