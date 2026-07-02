"""Provisioning pipelines (C3, logic §2): create 9 steps / remove 4 steps.

Registry recording is deliberately LATE (FD7): a mid-pipeline crash leaves no
half-record; orphaned ``cad-*`` resources are surfaced by the reconciler.
No automatic rollback (E4). The workspace is never touched on removal (L3).
"""

from __future__ import annotations

import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from caduceus.control.jobs import Job, JobEngine
from caduceus.core.errors import ConflictError, DomainValidationError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import Clock
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry
from caduceus.core.types import (
    AgentRecord,
    AgentSpec,
    CaduceusConfig,
    profile_name_for,
)
from caduceus.core.workspace import WorkspaceManager

HEALTH_WAIT_TIMEOUT_S = 60.0
HEALTH_WAIT_INTERVAL_S = 1.0

# Injected health probe: port → True when the agent api_server answers /health.
HealthCheckFn = Callable[[int], Awaitable[bool]]
# Callback so the daemon can rebuild the proxy token cache (2-plane seam #2).
TokenCacheInvalidate = Callable[[], None]


@dataclass
class _CreateState:
    """Mutable state threaded through create steps."""

    workspace_dir: str = ""
    workspace_reused: bool = False
    api_port: int = 0
    token_plain: str = ""
    token_hash: str = ""
    api_server_key: str = ""


class Provisioner:
    def __init__(
        self,
        registry: Registry,
        hermes: HermesAdapter,
        workspaces: WorkspaceManager,
        manager: GatewayProcessManager,
        jobs: JobEngine,
        config: CaduceusConfig,
        clock: Clock,
        *,
        health_check: HealthCheckFn,
        invalidate_tokens: TokenCacheInvalidate,
    ) -> None:
        self._registry = registry
        self._hermes = hermes
        self._workspaces = workspaces
        self._manager = manager
        self._jobs = jobs
        self._config = config
        self._clock = clock
        self._health_check = health_check
        self._invalidate_tokens = invalidate_tokens

    # -- create ---------------------------------------------------------------

    def create_agent(self, spec: AgentSpec) -> Job:
        state = _CreateState()
        profile = profile_name_for(spec.name)
        daemon_v1_url = f"http://127.0.0.1:{self._config.listen.port}/v1"

        async def validate() -> None:
            if any(r.spec.name == spec.name for r in self._registry.list()):
                raise ConflictError(f"agent {spec.name!r} already exists")
            report = await self._hermes.preflight()
            failed = [c.name for c in report.checks if not c.ok]
            if failed:
                raise DomainValidationError(
                    f"preflight failed: {', '.join(failed)} — run `caduceus doctor`"
                )

        async def workspace() -> None:
            path, existed = self._workspaces.ensure(spec.name)
            state.workspace_dir = str(path)
            state.workspace_reused = existed  # L5: reuse is surfaced, not hidden

        async def allocate() -> None:
            from caduceus.core.tokens import issue_token

            state.api_port = self._registry.allocate_port(
                self._config.agents.port_base, reserved={self._config.listen.port}
            )
            issued = issue_token(spec.name)
            state.token_plain = issued.plaintext
            state.token_hash = issued.token_hash
            state.api_server_key = secrets.token_hex(16)

        async def profile_create() -> None:
            await self._hermes.create_profile(profile)

        async def config_apply() -> None:
            self._hermes.apply_managed_config(
                profile,
                spec,
                daemon_v1_url=daemon_v1_url,
                workspace_dir=state.workspace_dir,
                default_model=self._config.upstream.default_model,
            )

        async def env_write() -> None:
            self._hermes.write_api_server_env(
                profile, port=state.api_port, key=state.api_server_key
            )
            self._hermes.write_gateway_token(profile, state.token_plain)
            state.token_plain = ""  # plaintext now lives only in the profile .env (S1)

        async def registry_add() -> None:
            record = AgentRecord(
                spec=spec,
                profile_name=profile,
                workspace_dir=state.workspace_dir,
                api_port=state.api_port,
                api_server_key=state.api_server_key,
                token_hash=state.token_hash,
                desired_state="stopped",
                created_at=self._clock.now_iso(),
            )
            self._registry.add(record)
            self._invalidate_tokens()

        async def gateway_start() -> None:
            await self._manager.start(spec.name, self._hermes.gateway_argv(profile))
            self._registry.set_desired_state(spec.name, "running")

        async def health_wait() -> None:
            deadline = self._clock.monotonic() + HEALTH_WAIT_TIMEOUT_S
            while self._clock.monotonic() < deadline:
                if await self._health_check(state.api_port):
                    return
                await self._clock.sleep(HEALTH_WAIT_INTERVAL_S)
            raise TimeoutError(
                f"agent api_server did not become healthy within {HEALTH_WAIT_TIMEOUT_S:.0f}s"
            )

        return self._jobs.submit(
            "create",
            spec.name,
            [
                ("validate", validate),
                ("workspace", workspace),
                ("allocate", allocate),
                ("profile-create", profile_create),
                ("config-apply", config_apply),
                ("env-write", env_write),
                ("registry-add", registry_add),
                ("gateway-start", gateway_start),
                ("health-wait", health_wait),
            ],
        )

    # -- remove (FD4: workspace-only preservation) -------------------------------

    def remove_agent(self, name: str) -> Job:
        record = self._registry.get(name)  # NotFound raised synchronously
        profile = record.profile_name

        async def gateway_stop() -> None:
            if self._manager.is_managed(name):
                await self._manager.stop(name)

        async def containers_remove() -> None:
            await self._hermes.remove_containers(profile)

        async def profile_delete() -> None:
            await self._hermes.delete_profile(profile)

        async def registry_remove() -> None:
            self._registry.remove(name)
            self._invalidate_tokens()

        return self._jobs.submit(
            "remove",
            name,
            [
                ("gateway-stop", gateway_stop),
                ("containers-remove", containers_remove),
                ("profile-delete", profile_delete),
                ("registry-remove", registry_remove),
            ],
        )
