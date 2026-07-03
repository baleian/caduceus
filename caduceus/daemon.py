"""caduceusd — composition root and entry point (AD-5, logic §5).

The single place where the two planes are wired together (three seams:
EventSink, token-cache invalidation, upstream reload). Tests assemble the
same app with fake ports via :func:`build_daemon`.
"""

from __future__ import annotations

import argparse
import contextlib
import logging
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

from caduceus import __version__
from caduceus.control.agent_proxy import build_agent_proxy_router
from caduceus.control.api import MAX_BODY_BYTES, build_admin_router
from caduceus.control.auth import AdminAuth, AdminAuthMiddleware, load_or_create_admin_token
from caduceus.control.events import EventBus
from caduceus.control.jobs import JobEngine
from caduceus.control.lifecycle import LifecycleService
from caduceus.control.prober import HealthProber
from caduceus.control.provisioner import Provisioner
from caduceus.control.reconciler import Reconciler
from caduceus.core.config import CaduceusConfigStore, ConfigHolder
from caduceus.core.errors import CaduceusError, ConfigError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import (
    Clock,
    CommandRunner,
    FileStore,
    ProcessSpawner,
    RealClock,
    RealCommandRunner,
    RealFileStore,
    RealProcessSpawner,
)
from caduceus.core.process_manager import GatewayProcessManager
from caduceus.core.registry import Registry, RegistryStore
from caduceus.core.tokens import TokenResolver
from caduceus.core.types import AgentRecord, CaduceusConfig
from caduceus.core.workspace import WorkspaceManager
from caduceus.proxy.routes import build_proxy_router
from caduceus.proxy.service import ProxyService
from caduceus.proxy.traffic import TrafficStats
from caduceus.proxy.upstream import UpstreamClient

logger = logging.getLogger(__name__)

DEFAULT_CADUCEUS_HOME = Path.home() / ".caduceus"


@dataclass
class Daemon:
    """Assembled application + background task lifecycle."""

    app: FastAPI
    config: CaduceusConfig
    registry: Registry
    resolver: TokenResolver
    manager: GatewayProcessManager
    jobs: JobEngine
    prober: HealthProber
    reconciler: Reconciler
    lifecycle: LifecycleService
    hermes: HermesAdapter
    upstream: UpstreamClient
    agent_client: httpx.AsyncClient

    async def startup(self) -> None:
        self.jobs.start_worker()
        self.prober.start()
        self.reconciler.start()
        # L7: bring desired=running agents back up
        for record in self.registry.list():
            if record.desired_state == "running":
                with contextlib.suppress(CaduceusError):
                    await self.manager.start(
                        record.spec.name,
                        self.hermes.gateway_argv(record.profile_name),
                    )

    async def shutdown(self) -> None:
        await self.reconciler.stop()
        await self.prober.stop()
        await self.jobs.stop_worker()
        await self.manager.shutdown()  # L1: gateway lifetime ⊆ daemon lifetime
        await self.upstream.aclose()
        await self.agent_client.aclose()


async def _noop_run_stop(record: AgentRecord) -> None:
    """Best-effort run interruption before SIGTERM.

    hermes gateway performs its own graceful drain on SIGTERM (native
    behavior), so the daemon does not duplicate it (P2). This hook remains a
    seam for a future explicit /v1/runs stop sweep.
    """
    return None


def build_daemon(
    *,
    config: CaduceusConfig,
    config_store: CaduceusConfigStore,
    caduceus_home: Path,
    files: FileStore,
    clock: Clock,
    runner: CommandRunner,
    spawner: ProcessSpawner,
    hermes_home: Path,
    upstream_transport: httpx.AsyncBaseTransport | None = None,
    agent_transport: httpx.AsyncBaseTransport | None = None,
) -> Daemon:
    events = EventBus()
    holder = ConfigHolder(config)  # live view for provisioner/reconciler/api
    registry = Registry(
        RegistryStore(caduceus_home / "registry.json", files, clock)
    )
    resolver = TokenResolver()
    resolver.rebuild(registry.token_map())

    def invalidate_tokens() -> None:  # seam #2
        resolver.rebuild(registry.token_map())

    admin_token = load_or_create_admin_token(caduceus_home, files)
    auth = AdminAuth(admin_token)

    # DOCKER_HOST for the rootless sandbox daemon — reaches both our own
    # docker calls (adapter) and every hermes gateway child (manager).
    docker_env = {"DOCKER_HOST": config.docker.host} if config.docker.host else None
    hermes = HermesAdapter(runner, files, hermes_home=hermes_home, env=docker_env)
    workspaces = WorkspaceManager(caduceus_home / "workspaces", files)
    manager = GatewayProcessManager(spawner, clock, events, env=docker_env)
    traffic = TrafficStats(since_iso=clock.now_iso())
    upstream = UpstreamClient(config.upstream, transport=upstream_transport)
    proxy_service = ProxyService(resolver, upstream, traffic, events, clock)

    agent_client = httpx.AsyncClient(
        transport=agent_transport,
        timeout=httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0),
    )

    async def health_check(port: int) -> bool:
        return await _probe(agent_client, port) is True

    async def probe(port: int) -> bool | None:
        return await _probe(agent_client, port)

    jobs = JobEngine(events, clock)
    provisioner = Provisioner(
        registry, hermes, workspaces, manager, jobs, holder, clock,
        health_check=health_check, invalidate_tokens=invalidate_tokens,
    )
    prober = HealthProber(
        registry, manager, probe, clock, events,
        interval_s=config.reconcile.interval_s,
    )
    lifecycle = LifecycleService(
        registry, manager, hermes,
        health_of=prober.health_of, run_stop=_noop_run_stop,
    )
    reconciler = Reconciler(
        registry, manager, hermes, lifecycle, holder, clock, events,
        interval_s=config.reconcile.interval_s,
    )

    app = FastAPI(title="caduceus", version=__version__, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def hardening(request: Request, call_next):  # type: ignore[no-untyped-def]
        length = request.headers.get("content-length")
        if length and int(length) > MAX_BODY_BYTES:  # B1
            return JSONResponse(status_code=413, content={"error": "request too large"})
        response: Response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    app.add_middleware(AdminAuthMiddleware, auth=auth)

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:  # shallow liveness (public)
        return {"status": "ok", "version": __version__}

    app.include_router(build_proxy_router(proxy_service))
    app.include_router(
        build_admin_router(
            registry=registry,
            provisioner=provisioner,
            lifecycle=lifecycle,
            jobs=jobs,
            hermes=hermes,
            events=events,
            traffic=traffic,
            upstream=upstream,
            config_store=config_store,
            config=holder,
            invalidate_tokens=invalidate_tokens,
            ws_auth=auth.verify,
        )
    )
    app.include_router(build_agent_proxy_router(registry, agent_client))

    return Daemon(
        app=app, config=config, registry=registry, resolver=resolver,
        manager=manager, jobs=jobs, prober=prober, reconciler=reconciler,
        lifecycle=lifecycle, hermes=hermes, upstream=upstream,
        agent_client=agent_client,
    )


async def _probe(client: httpx.AsyncClient, port: int) -> bool | None:
    try:
        response = await client.get(f"http://127.0.0.1:{port}/health", timeout=5.0)
    except httpx.HTTPError:
        return None
    return response.status_code == 200


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="caduceusd")
    parser.add_argument("--home", type=Path, default=DEFAULT_CADUCEUS_HOME)
    parser.add_argument("--hermes-home", type=Path, default=Path.home() / ".hermes")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args(argv)

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    files = RealFileStore()
    config_store = CaduceusConfigStore(args.home / "config.yaml", files)
    try:
        config = config_store.load()
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if args.host:
        config = config.model_copy(
            update={"listen": config.listen.model_copy(update={"host": args.host})}
        )
    if args.port:
        config = config.model_copy(
            update={"listen": config.listen.model_copy(update={"port": args.port})}
        )

    daemon = build_daemon(
        config=config,
        config_store=config_store,
        caduceus_home=args.home,
        files=files,
        clock=RealClock(),
        runner=RealCommandRunner(),
        spawner=RealProcessSpawner(),
        hermes_home=args.hermes_home,
    )

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await daemon.startup()
        try:
            yield
        finally:
            await daemon.shutdown()

    daemon.app.router.lifespan_context = lifespan

    import uvicorn

    uvicorn.run(
        daemon.app,
        host=config.listen.host,
        port=config.listen.port,
        log_level="info",
        access_log=False,  # P1/P3: our own structured request logging only
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
