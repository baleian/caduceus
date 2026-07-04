"""Admin REST/WS API (C5 contract; rules A5, B1–B4)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any, Literal

import httpx
from fastapi import APIRouter, Header, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from caduceus.control import observability
from caduceus.control.agent_proxy import build_agent_proxy_router  # noqa: F401 (re-export)
from caduceus.control.events import EventBus
from caduceus.control.jobs import JobEngine
from caduceus.control.lifecycle import LifecycleService
from caduceus.control.provisioner import Provisioner
from caduceus.core.config import CaduceusConfigStore, ConfigHolder
from caduceus.core.errors import CaduceusError, ConflictError, NotFoundError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import Clock
from caduceus.core.registry import Registry
from caduceus.core.tokens import issue_token
from caduceus.core.types import AgentSpec, ApprovalsMode, CoreEvent, UpstreamConfig
from caduceus.proxy.traffic import TrafficStats, parse_ts
from caduceus.proxy.upstream import UpstreamClient

logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 1024 * 1024  # B1

# Live gateway windows: window seconds, bucket seconds, series source.
# 15m reads the raw ring (fine 10s cells); 1h/24h read minute rollups
# (24h re-bucketed to 15 min so the payload stays ~100 cells).
GATEWAY_WINDOWS: dict[str, tuple[int, int, str]] = {
    "15m": (900, 10, "samples"),
    "1h": (3600, 60, "rollup"),
    "24h": (86400, 900, "rollup"),
}


class UpstreamUpdate(BaseModel):
    """PUT body is the complete upstream definition (full replace)."""

    model_config = ConfigDict(extra="forbid")

    base_url: str
    default_model: str  # required — agent profiles render model.default from it
    api_key_env: str | None = None
    extra_headers: dict[str, str] = {}


class SoulUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str


class SkillToggle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class ApprovalsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: ApprovalsMode


class ResolveOrphan(BaseModel):
    """POST body for user-driven orphan cleanup (web alert "clean up")."""

    model_config = ConfigDict(extra="forbid")

    resource: Literal["profile", "container"]
    name: str


class AllowPrivateUrlsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allow: bool


class ToolsetsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    toolsets: list[str]


def _error_response(exc: CaduceusError) -> JSONResponse:
    status = 500
    if isinstance(exc, NotFoundError):
        status = 404
    elif isinstance(exc, ConflictError):
        status = 409
    return JSONResponse(status_code=status, content={"error": str(exc.message)})


def _public_record(registry: Registry, name: str) -> dict[str, Any]:
    record = registry.get(name)
    data = record.model_dump()
    data.pop("api_server_key", None)  # S3: server-side only
    data.pop("token_hash", None)
    return data


def build_admin_router(
    *,
    registry: Registry,
    provisioner: Provisioner,
    lifecycle: LifecycleService,
    jobs: JobEngine,
    hermes: HermesAdapter,
    events: EventBus,
    traffic: TrafficStats,
    upstream: UpstreamClient,
    config_store: CaduceusConfigStore,
    config: ConfigHolder,
    invalidate_tokens: Any,
    ws_auth: Any,  # Callable[[str], bool] — WS token check (middleware skips WS)
    alerts_snapshot: Callable[[], dict[str, Any]],
    clock: Clock,
    agent_client: httpx.AsyncClient,
) -> APIRouter:
    router = APIRouter()

    # -- agents ---------------------------------------------------------------

    @router.get("/api/agents")
    async def list_agents(probe: bool = Query(default=False)) -> list[dict[str, Any]]:
        statuses = await lifecycle.status(probe_container=probe)
        return [s.model_dump() for s in statuses]

    @router.post("/api/agents", status_code=202)
    async def create_agent(spec: AgentSpec) -> dict[str, str]:
        job = provisioner.create_agent(spec)
        return {"job_id": job.id}

    @router.get("/api/agents/{name}")
    async def get_agent(name: str, probe: bool = Query(default=False)) -> dict[str, Any]:
        try:
            record = _public_record(registry, name)
            status = (await lifecycle.status(name, probe_container=probe))[0]
        except CaduceusError as exc:
            raise_http(exc)
        return {"record": record, "status": status.model_dump()}

    @router.delete("/api/agents/{name}", status_code=202)
    async def remove_agent(
        name: str, x_confirm: str | None = Header(default=None)
    ) -> Any:
        if x_confirm != name:  # A5: destructive op needs explicit confirmation
            return JSONResponse(
                status_code=400,
                content={"error": "destructive operation requires X-Confirm: <agent-name>"},
            )
        try:
            job = provisioner.remove_agent(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"job_id": job.id}

    @router.post("/api/agents/{name}/start", status_code=202)
    async def start_agent(name: str) -> Any:
        try:
            await lifecycle.start(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"ok": True}

    @router.post("/api/agents/{name}/stop", status_code=202)
    async def stop_agent(name: str) -> Any:
        try:
            await lifecycle.stop(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"ok": True}

    @router.get("/api/agents/{name}/logs")
    async def agent_logs(name: str, last: int = Query(default=200, ge=1, le=2000)) -> Any:
        try:
            return {"lines": lifecycle.logs(name, last=last)}
        except CaduceusError as exc:
            return _error_response(exc)

    @router.post("/api/agents/{name}/token/rotate", status_code=204, response_model=None)
    async def rotate_token(name: str) -> Any:
        try:
            record = registry.get(name)
            issued = issue_token(name)
            hermes.write_gateway_token(record.profile_name, issued.plaintext)
            registry.rotate_token_hash(name, issued.token_hash)
            invalidate_tokens()
        except CaduceusError as exc:
            return _error_response(exc)
        return None  # 204: plaintext lives only in the profile .env (S1)

    # -- persona / skills / toolsets (F7) ---------------------------------------

    @router.get("/api/agents/{name}/soul")
    async def get_soul(name: str) -> Any:
        try:
            record = registry.get(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"content": hermes.read_soul(record.profile_name)}

    @router.put("/api/agents/{name}/soul", status_code=204, response_model=None)
    async def put_soul(name: str, body: SoulUpdate) -> Any:
        try:
            record = registry.get(name)
            hermes.write_soul(record.profile_name, body.content)
        except CaduceusError as exc:
            return _error_response(exc)
        return None

    @router.get("/api/agents/{name}/skills")
    async def get_skills(name: str) -> Any:
        try:
            record = registry.get(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {
            "skills": [
                {"name": s.name, "enabled": s.enabled}
                for s in hermes.list_skills(record.profile_name)
            ]
        }

    @router.put("/api/agents/{name}/skills/{skill}", status_code=204, response_model=None)
    async def toggle_skill(name: str, skill: str, body: SkillToggle) -> Any:
        try:
            record = registry.get(name)
            hermes.set_skill_enabled(record.profile_name, skill, body.enabled)
        except CaduceusError as exc:
            return _error_response(exc)
        return None

    @router.get("/api/agents/{name}/approvals")
    async def get_approvals(name: str) -> Any:
        try:
            record = registry.get(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"mode": record.spec.approvals_mode}

    @router.put("/api/agents/{name}/approvals", status_code=204, response_model=None)
    async def put_approvals(name: str, body: ApprovalsUpdate) -> Any:
        """Switch approvals mode: update the spec of record, then re-render the
        managed config so hermes picks it up on next gateway (re)start."""
        try:
            record = registry.get(name)
            new_spec = record.spec.model_copy(update={"approvals_mode": body.mode})
            registry.replace(record.model_copy(update={"spec": new_spec}))
            hermes.apply_managed_config(
                record.profile_name,
                new_spec,
                daemon_v1_url=f"http://127.0.0.1:{config.config.listen.port}/v1",
                workspace_dir=record.workspace_dir,
                default_model=config.config.upstream.default_model,
            )
        except CaduceusError as exc:
            return _error_response(exc)
        return None

    @router.get("/api/agents/{name}/allow-private-urls")
    async def get_allow_private_urls(name: str) -> Any:
        try:
            record = registry.get(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"allow_private_urls": record.spec.allow_private_urls}

    @router.put(
        "/api/agents/{name}/allow-private-urls", status_code=204, response_model=None
    )
    async def put_allow_private_urls(name: str, body: AllowPrivateUrlsUpdate) -> Any:
        """Toggle the browser SSRF opt-in (security.allow_private_urls): update
        the spec, then re-render the managed config so hermes picks it up on the
        next gateway (re)start."""
        try:
            record = registry.get(name)
            new_spec = record.spec.model_copy(update={"allow_private_urls": body.allow})
            registry.replace(record.model_copy(update={"spec": new_spec}))
            hermes.apply_managed_config(
                record.profile_name,
                new_spec,
                daemon_v1_url=f"http://127.0.0.1:{config.config.listen.port}/v1",
                workspace_dir=record.workspace_dir,
                default_model=config.config.upstream.default_model,
            )
        except CaduceusError as exc:
            return _error_response(exc)
        return None

    @router.get("/api/agents/{name}/toolsets")
    async def get_toolsets(name: str) -> Any:
        try:
            record = registry.get(name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"toolsets": hermes.get_toolsets(record.profile_name)}

    @router.put("/api/agents/{name}/toolsets", status_code=204, response_model=None)
    async def put_toolsets(name: str, body: ToolsetsUpdate) -> Any:
        try:
            record = registry.get(name)
            hermes.set_toolsets(record.profile_name, body.toolsets)
        except CaduceusError as exc:
            return _error_response(exc)
        return None

    # -- gateway ----------------------------------------------------------------

    @router.get("/api/gateway")
    async def gateway_info() -> dict[str, Any]:
        return {
            "listen": config.config.listen.model_dump(),
            "upstream": {
                "base_url": upstream.config.base_url,
                "default_model": upstream.config.default_model,
                "api_key_env": upstream.config.api_key_env,  # env NAME only (S4)
                # names only — values may embed literals the caller typed (S3)
                "extra_headers": sorted(upstream.config.extra_headers),
            },
            "traffic": traffic.summary(),
        }

    @router.put("/api/gateway/upstream")
    async def put_upstream(body: UpstreamUpdate) -> Any:
        try:
            new_upstream = UpstreamConfig(**body.model_dump())
            new_config = config.config.model_copy(update={"upstream": new_upstream})
            upstream.swap(new_upstream)  # atomic (S4); fails closed on bad env refs
            config_store.save(new_config)
            config.replace(new_config)  # provisioner/reconciler observe it live
        except CaduceusError as exc:
            return _error_response(exc)
        return {"base_url": new_upstream.base_url, "default_model": new_upstream.default_model}

    # -- observability (observability-redesign S4) ---------------------------------
    #
    # Two read-only aggregates, one per data source:
    #   usage   — hermes-native session rows (persistent), daemon-side fan-out
    #   gateway — TrafficStats rings/rollups (volatile, "since daemon start")
    # Responses carry chart-ready grids; no conversation content, no secrets.

    def _known_agent(name: str | None) -> bool:
        if name is None:
            return True
        try:
            registry.get(name)
        except CaduceusError:
            return False
        return True

    @router.get("/api/observability/usage")
    async def observability_usage(
        range_key: str = Query(default="24h", alias="range"),
        agent: str | None = Query(default=None),
    ) -> Any:
        if range_key not in observability.RANGES:
            return JSONResponse(
                status_code=422,
                content={"error": f"range must be one of {sorted(observability.RANGES)}"},
            )
        if not _known_agent(agent):
            return JSONResponse(status_code=404, content={"error": "agent not found"})
        now_iso = clock.now_iso()
        now_s = parse_ts(now_iso) or 0.0
        per_agent = await observability.collect_sessions(registry, agent_client)
        all_sessions = [s for entry in per_agent for s in entry.sessions]
        fleet = {
            "kpis": observability.session_kpis(all_sessions, now_s=now_s),
            "series": observability.bucket_sessions(all_sessions, now_s=now_s, range_key=range_key),
            **observability.distributions(all_sessions),
            "ranking": observability.ranking(per_agent, now_s=now_s),
        }
        agent_block: dict[str, Any] | None = None
        if agent is not None:
            entry = next((e for e in per_agent if e.agent == agent), None)
            sessions = entry.sessions if entry else []
            agent_block = {
                "name": agent,
                "reachable": bool(entry and entry.reachable),
                "kpis": observability.session_kpis(sessions, now_s=now_s),
                "series": observability.bucket_sessions(sessions, now_s=now_s, range_key=range_key),
                **observability.distributions(sessions),
                "sessions": observability.session_rows(sessions),
            }
        return {
            "generated_at": now_iso,
            "range": range_key,
            "bucket_s": observability.RANGES[range_key][0],
            "fleet": fleet,
            "agent": agent_block,
            "unreachable": [e.agent for e in per_agent if not e.reachable],
        }

    @router.get("/api/observability/gateway")
    async def observability_gateway(
        window: str = Query(default="1h"),
        agent: str | None = Query(default=None),
    ) -> Any:
        if window not in GATEWAY_WINDOWS:
            return JSONResponse(
                status_code=422,
                content={"error": f"window must be one of {sorted(GATEWAY_WINDOWS)}"},
            )
        if not _known_agent(agent):
            return JSONResponse(status_code=404, content={"error": "agent not found"})
        now_s = parse_ts(clock.now_iso()) or 0.0
        window_s, bucket_s, source = GATEWAY_WINDOWS[window]
        if source == "samples":
            series = traffic.sample_series(agent, window_s=window_s, bucket_s=bucket_s, now_s=now_s)
        else:
            series = traffic.rollup_series(agent, window_s=window_s, bucket_s=bucket_s, now_s=now_s)
        summary = traffic.summary()
        totals = (
            summary["totals"]
            if agent is None
            else {
                "requests": summary["agents"].get(agent, {}).get("requests", 0),
                "errors": summary["agents"].get(agent, {}).get("errors", 0),
            }
        )
        return {
            "since": summary["since"],  # volatile scope marker (daemon start)
            "window": window,
            "bucket_s": bucket_s,
            "totals": totals,
            "latency": traffic.latency_summary(agent, window_s=window_s, now_s=now_s),
            "series": series,
            "per_agent": summary["agents"],
            "recent": traffic.recent_merged(agent, limit=100),
        }

    # -- jobs / status / events ---------------------------------------------------

    @router.get("/api/jobs")
    async def list_jobs() -> list[dict[str, Any]]:
        return [j.snapshot() for j in jobs.list()]

    @router.get("/api/jobs/{job_id}")
    async def get_job(job_id: str) -> Any:
        try:
            return jobs.get(job_id).snapshot()
        except CaduceusError as exc:
            return _error_response(exc)

    @router.get("/api/status")
    async def deep_status() -> dict[str, Any]:  # RESILIENCY-06 deep health
        statuses = await lifecycle.status(probe_container=False)
        return {
            "agents": {s.name: s.detail["summary"] for s in statuses},
            "traffic": traffic.summary()["totals"],
            "upstream": upstream.config.base_url,
        }

    @router.get("/api/alerts")
    async def active_alerts() -> dict[str, Any]:
        """Drift/orphan conditions active as of the last reconcile cycle."""
        return alerts_snapshot()

    @router.post("/api/alerts/orphan/resolve", status_code=202)
    async def resolve_orphan(body: ResolveOrphan) -> Any:
        """Reap + delete an orphaned resource (web alert "clean up"). The alert
        clears on the next reconcile cycle once the resource is gone."""
        try:
            job = provisioner.resolve_orphan(body.resource, body.name)
        except CaduceusError as exc:
            return _error_response(exc)
        return {"job_id": job.id}

    @router.websocket("/api/events")
    async def events_ws(websocket: WebSocket) -> None:
        # NOTE: auth for WS is enforced here (HTTP middleware does not cover WS).
        token = websocket.query_params.get("token") or websocket.headers.get(
            "x-caduceus-token", ""
        )
        if not ws_auth(token):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        queue = events.subscribe()
        try:
            for past in events.replay():
                await websocket.send_text(past.model_dump_json())
            # Replay/live boundary: clients must not treat replayed events as
            # "just happened" (no toasts before this marker).
            synced = CoreEvent(kind="events.synced", agent=None, data={}, ts=clock.now_iso())
            await websocket.send_text(synced.model_dump_json())
            while True:
                event = await queue.get()
                await websocket.send_text(event.model_dump_json())
        except WebSocketDisconnect:
            pass
        finally:
            events.unsubscribe(queue)

    return router


def raise_http(exc: CaduceusError) -> None:
    from fastapi import HTTPException

    status = 404 if isinstance(exc, NotFoundError) else (
        409 if isinstance(exc, ConflictError) else 500
    )
    raise HTTPException(status_code=status, detail=str(exc.message))
