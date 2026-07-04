"""Provisioning pipelines (C3, logic §2): create 9 steps / remove 4 steps.

Registry recording is deliberately LATE (FD7): a mid-pipeline crash leaves no
half-record; orphaned ``cad-*`` resources are surfaced by the reconciler.
No automatic rollback (E4). The workspace is never touched on removal (L3).
"""

from __future__ import annotations

import logging
import secrets
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from caduceus.control.jobs import Job, JobEngine
from caduceus.core.config import ConfigHolder
from caduceus.core.errors import ConflictError, DomainValidationError, HermesError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import Clock
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry
from caduceus.core.render import DEFAULT_API_SERVER_TOOLSETS
from caduceus.core.types import (
    PROFILE_PREFIX,
    AgentRecord,
    AgentSpec,
    profile_name_for,
)
from caduceus.core.workspace import WorkspaceManager

logger = logging.getLogger(__name__)

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
        config: ConfigHolder,
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
        self._holder = config
        self._clock = clock
        self._health_check = health_check
        self._invalidate_tokens = invalidate_tokens

    # -- create ---------------------------------------------------------------

    def create_agent(self, spec: AgentSpec) -> Job:
        state = _CreateState()
        profile = profile_name_for(spec.name)
        daemon_v1_url = f"http://127.0.0.1:{self._holder.config.listen.port}/v1"

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
                self._holder.config.agents.port_base, reserved={self._holder.config.listen.port}
            )
            issued = issue_token(spec.name)
            state.token_plain = issued.plaintext
            state.token_hash = issued.token_hash
            state.api_server_key = secrets.token_hex(16)

        async def profile_create() -> None:
            # A prior removal may have dropped the registry record while leaving
            # the profile dir behind (root-owned artifacts it couldn't delete —
            # see remove_agent). validate() already proved no record exists, so
            # any surviving dir is definitionally an orphan: reclaim + delete it
            # (idempotent — no-op when absent) before creating. Create runs
            # privileged sandbox containers anyway, so leveraging one here to
            # clean up introduces nothing new.
            await self._hermes.delete_profile(profile, image=spec.docker_image)
            await self._hermes.create_profile(profile)

        async def config_apply() -> None:
            self._hermes.apply_managed_config(
                profile,
                spec,
                daemon_v1_url=daemon_v1_url,
                workspace_dir=state.workspace_dir,
                default_model=self._holder.config.upstream.default_model,
            )
            # Seed the explicit api_server toolset surface (not drift-managed:
            # the user may edit it later via `agent toolsets`). Without it,
            # hermes' subset inference silently drops `terminal` — see
            # DEFAULT_API_SERVER_TOOLSETS.
            self._hermes.set_toolsets(profile, list(DEFAULT_API_SERVER_TOOLSETS))
            # Seed the default sandbox login profile (PATH += games dirs) —
            # must exist before the first gateway boot captures its env
            # snapshot from a login shell.
            self._hermes.seed_sandbox_profile(profile)
            # F7: the spec's persona seeds SOUL.md (was silently dropped
            # before U4's browser E2E exercised the create-with-persona path)
            if spec.persona is not None:
                self._hermes.write_soul(profile, spec.persona)

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
            await self._manager.start(
                spec.name,
                self._hermes.gateway_argv(profile),
                env=self._hermes.gateway_env(spec, state.workspace_dir),
            )
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
            # Belt-and-suspenders: a gateway the manager isn't tracking (survived
            # a daemon restart, spawned out-of-band) keeps rewriting the profile
            # dir and reappears as an orphan every reconcile. Reap it from the
            # on-disk pidfile — the manager-independent source of truth — so
            # profile-delete below isn't immediately undone. Never fail remove on
            # reap trouble (Q2=A: visibility over strictness).
            try:
                outcome = await self._hermes.reap_gateway(profile, clock=self._clock)
                if outcome == "survived":
                    logger.warning("gateway for %s survived reap; removing anyway", profile)
            except Exception:  # noqa: BLE001 - reap must not break removal
                logger.warning("reap_gateway(%s) failed; proceeding with removal", profile)

        async def containers_remove() -> None:
            await self._hermes.remove_containers(profile)

        async def profile_delete() -> None:
            try:
                await self._hermes.delete_profile(profile, image=record.spec.docker_image)
            except HermesError:
                # The dir couldn't be fully removed even after an ownership
                # reclaim + retry. Drop the registry record anyway so the agent
                # disappears from Caduceus (visibility); the orphan dir is
                # reclaimed + deleted on the next create with this name.
                logger.warning(
                    "profile %s dir not fully removed; proceeding with registry "
                    "removal (orphan cleaned on next create)", profile,
                )

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

    # -- resolve orphan (user-driven alert cleanup) ------------------------------

    def resolve_orphan(self, resource: str, name: str) -> Job:
        """Reap + delete an orphaned ``cad-*`` resource on user request (the web
        alert's "clean up" action). Guarded to genuine orphans: the name must be
        a caduceus profile that is NOT in the registry, so a live agent's profile
        can never be destroyed through this path."""
        if resource not in ("profile", "container"):
            raise DomainValidationError(f"unknown orphan resource {resource!r}")
        if not name.startswith(PROFILE_PREFIX):
            raise DomainValidationError(
                f"{name!r} is not a caduceus-managed resource (prefix {PROFILE_PREFIX!r})"
            )
        if any(r.profile_name == name for r in self._registry.list()):
            raise ConflictError(
                f"{name!r} belongs to a live agent — remove the agent instead"
            )

        async def reap() -> None:
            try:
                await self._hermes.reap_gateway(name, clock=self._clock)
            except Exception:  # noqa: BLE001 - reap must not break cleanup (Q2=A)
                logger.warning("reap_gateway(%s) failed during orphan cleanup", name)

        async def containers_remove() -> None:
            await self._hermes.remove_containers(name)

        async def profile_delete() -> None:
            try:
                await self._hermes.delete_profile(name)
            except HermesError:
                logger.warning(
                    "orphan profile %s dir not fully removed; will resurface", name
                )

        if resource == "container":
            steps: list[tuple[str, Callable[[], Awaitable[None]]]] = [
                ("containers-remove", containers_remove),
            ]
        else:
            steps = [
                ("reap", reap),
                ("containers-remove", containers_remove),
                ("profile-delete", profile_delete),
            ]
        return self._jobs.submit("resolve-orphan", name, steps)
