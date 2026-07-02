"""Reconciler (S5, rule R5): drift + orphan detection, bounded remediation.

The ONLY automatic remediation is restarting a dead desired=running gateway,
once per drift occurrence. Everything else is an event for the user.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any

from caduceus.control.lifecycle import LifecycleService
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import Clock, EventSink
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry
from caduceus.core.render import diff_managed, managed_config
from caduceus.core.types import PROFILE_PREFIX, CaduceusConfig, CoreEvent

logger = logging.getLogger(__name__)


class Reconciler:
    def __init__(
        self,
        registry: Registry,
        manager: GatewayProcessManager,
        hermes: HermesAdapter,
        lifecycle: LifecycleService,
        config: CaduceusConfig,
        clock: Clock,
        events: EventSink,
        *,
        interval_s: float,
    ) -> None:
        self._registry = registry
        self._manager = manager
        self._hermes = hermes
        self._lifecycle = lifecycle
        self._config = config
        self._clock = clock
        self._events = events
        self._interval = interval_s
        self._restart_attempted: set[str] = set()  # R5: once per drift occurrence
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.get_running_loop().create_task(self._loop())

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def reconcile_once(self) -> None:
        await self._dead_gateways()
        self._config_drift()
        await self._orphans()

    async def _dead_gateways(self) -> None:
        for record in self._registry.list():
            agent = record.spec.name
            if record.desired_state != "running":
                self._restart_attempted.discard(agent)
                continue
            managed = self._manager.is_managed(agent)
            if managed and self._manager.info(agent).state == "running":
                self._restart_attempted.discard(agent)  # healthy again → re-arm
                continue
            if managed:  # starting/stopping/crashlooping — manager owns those
                continue
            self._emit("drift.detected", agent, reason="gateway-not-running")
            if agent in self._restart_attempted:
                continue  # R5: no restart loops from the reconciler
            self._restart_attempted.add(agent)
            try:
                await self._lifecycle.start(agent)
                self._emit("drift.remediated", agent, action="gateway-restarted")
            except Exception as exc:  # noqa: BLE001 - report, never crash the loop
                logger.warning("reconcile restart failed for %s: %s", agent, type(exc).__name__)

    def _config_drift(self) -> None:
        for record in self._registry.list():
            expected = managed_config(
                record.spec,
                daemon_v1_url=f"http://127.0.0.1:{self._config.listen.port}/v1",
                workspace_dir=record.workspace_dir,
                default_model=self._config.upstream.default_model,
            )
            try:
                current = self._hermes.read_config_text(record.profile_name)
            except OSError:
                continue
            drift = diff_managed(current, expected)
            if drift:
                self._emit(
                    "drift.detected",
                    record.spec.name,
                    reason="managed-config-drift",
                    keys=[key for key, _, _ in drift],
                )

    async def _orphans(self) -> None:
        known_profiles = {r.profile_name for r in self._registry.list()}
        for profile in self._hermes.list_profiles():
            if profile.startswith(PROFILE_PREFIX) and profile not in known_profiles:
                self._emit("orphan.detected", None, resource="profile", name=profile)
        for profile in await self._hermes.list_container_profiles():
            if profile.startswith(PROFILE_PREFIX) and profile not in known_profiles:
                self._emit("orphan.detected", None, resource="container", name=profile)

    async def _loop(self) -> None:
        while True:
            try:
                await self.reconcile_once()
            except Exception:  # noqa: BLE001 - reconciler must never die
                logger.exception("reconcile cycle failed")
            await self._clock.sleep(self._interval)

    def _emit(self, kind: str, agent: str | None, **data: Any) -> None:
        self._events.emit(
            CoreEvent(kind=kind, agent=agent, data=data, ts=self._clock.now_iso())
        )
