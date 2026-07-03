"""Agent chat reverse proxy (S2, rule B3, property PU2-4).

``/agents/{name}/api/{path}`` → ``http://127.0.0.1:<agent api_port>/{path}``
with the agent's ``API_SERVER_KEY`` attached server-side — browsers and CLI
never see per-agent keys (S3). Streams (SSE) are relayed unbuffered; the
api_server endpoints themselves (sessions, runs, stop, approval) pass through
untouched (P1 of the design: no reimplementation).
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from caduceus.core.errors import NotFoundError
from caduceus.core.registry import Registry
from caduceus.core.types import validate_agent_name

logger = logging.getLogger(__name__)

ALLOWED_PREFIXES = ("v1/", "api/sessions", "health")
_SKIP_REQUEST_HEADERS = {
    "host", "authorization", "x-caduceus-token", "content-length", "connection",
    # browser-context headers must not leak through the relay: hermes
    # api_server's CORS middleware 403s on any non-allowlisted Origin. The
    # relay is an authenticated server-side client (single-origin design,
    # C5) — exactly like the CLI, which sends none of these.
    "origin", "referer", "cookie",
}
_SKIP_RESPONSE_HEADERS = {"content-length", "transfer-encoding", "connection"}


def allowed_subpath(path: str) -> bool:
    """Pure containment check (PU2-4): allowlisted prefixes, no traversal."""
    if not path or path.startswith("/") or "\\" in path or ".." in path:
        return False
    if "://" in path or path.startswith("//"):
        return False
    return path == "health" or any(path.startswith(p) for p in ALLOWED_PREFIXES)


def target_url(api_port: int, path: str) -> str:
    return f"http://127.0.0.1:{api_port}/{path}"


def build_agent_proxy_router(registry: Registry, client: httpx.AsyncClient) -> APIRouter:
    router = APIRouter()

    @router.api_route(
        "/agents/{name}/api/{path:path}",
        methods=["GET", "POST", "PATCH", "DELETE"],
        include_in_schema=False,
    )
    async def relay(request: Request, name: str, path: str) -> Response:
        try:
            validate_agent_name(name)
            record = registry.get(name)
        except (NotFoundError, Exception) as exc:  # noqa: BLE001
            if isinstance(exc, NotFoundError):
                return JSONResponse(status_code=404, content={"error": "agent not found"})
            return JSONResponse(status_code=404, content={"error": "invalid agent"})

        if not allowed_subpath(path):
            return JSONResponse(status_code=404, content={"error": "path not allowed"})

        upstream_request = client.build_request(
            method=request.method,
            url=target_url(record.api_port, path),
            params=request.query_params,
            content=await request.body() or None,
            headers=[
                *(
                    (k, v)
                    for k, v in request.headers.items()
                    if k.lower() not in _SKIP_REQUEST_HEADERS
                ),
                ("authorization", f"Bearer {record.api_server_key}"),  # S3 server-side
            ],
        )
        try:
            upstream_response = await client.send(upstream_request, stream=True)
        except httpx.HTTPError as exc:
            logger.warning("agent %s api relay failed: %s", name, type(exc).__name__)
            return JSONResponse(
                status_code=502, content={"error": "agent api unreachable"}
            )

        headers = {
            k: v
            for k, v in upstream_response.headers.items()
            if k.lower() not in _SKIP_RESPONSE_HEADERS
        }
        if "text/event-stream" in upstream_response.headers.get("content-type", ""):

            async def stream() -> AsyncIterator[bytes]:
                try:
                    async for chunk in upstream_response.aiter_raw():
                        yield chunk
                finally:
                    await upstream_response.aclose()  # client disconnect → cancel upstream

            return StreamingResponse(
                stream(),
                status_code=upstream_response.status_code,
                headers=headers,
                media_type="text/event-stream",
            )

        payload = await upstream_response.aread()
        await upstream_response.aclose()
        return Response(
            content=payload, status_code=upstream_response.status_code, headers=headers
        )

    return router
