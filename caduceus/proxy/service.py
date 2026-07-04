"""Proxy pipeline (logic §1.1): authenticate → rewrite → relay → account.

Thin by design: bodies are forwarded unmodified and never logged or stored
(rule P1). Token usage is NOT accounted here — hermes tracks it natively per
session (``/api/sessions`` usage fields); the proxy records only request-level
metadata (status, latency) that hermes has no visibility into.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

import httpx
from fastapi import Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from caduceus.core.ports import Clock, EventSink
from caduceus.core.tokens import TokenResolver
from caduceus.core.types import CoreEvent
from caduceus.proxy.traffic import TrafficSample, TrafficStats
from caduceus.proxy.upstream import NONSTREAM_TOTAL_TIMEOUT_S, UpstreamClient

logger = logging.getLogger(__name__)

# PU2-5 oracle table: error class → (http status, openai error type, code)
ERROR_MAP: list[tuple[type[Exception], tuple[int, str, str]]] = [
    (httpx.ConnectTimeout, (502, "upstream_error", "upstream_unreachable")),
    (httpx.ConnectError, (502, "upstream_error", "upstream_unreachable")),
    (httpx.ReadTimeout, (504, "upstream_error", "upstream_timeout")),
    (httpx.WriteTimeout, (504, "upstream_error", "upstream_timeout")),
    (httpx.PoolTimeout, (502, "upstream_error", "upstream_overloaded")),
    (httpx.HTTPError, (502, "upstream_error", "upstream_failed")),
    (asyncio.TimeoutError, (504, "upstream_error", "upstream_timeout")),
]

# Hop-by-hop / recomputed headers we never forward in either direction.
_SKIP_REQUEST_HEADERS = {"host", "authorization", "content-length", "connection"}
_SKIP_RESPONSE_HEADERS = {"content-length", "transfer-encoding", "connection"}

# Only genuine LLM-inference calls are accounted in the dashboard Requests/Errors
# numbers. Metadata / capability probes (/v1/models, /v1/models/{id}, /v1/props,
# ...) are relayed normally but never counted — they are client-driven startup
# noise that would otherwise dilute the "meaningful traffic" the dashboard reports.
_INFERENCE_PATHS = frozenset(
    {
        "/v1/chat/completions",
        "/v1/completions",
        "/v1/embeddings",
        "/v1/responses",
    }
)


def is_inference_path(path: str) -> bool:
    return path.rstrip("/") in _INFERENCE_PATHS


def map_exception(exc: Exception) -> tuple[int, str, str]:
    for exc_type, mapped in ERROR_MAP:
        if isinstance(exc, exc_type):
            return mapped
    return (502, "upstream_error", "upstream_failed")


def openai_error(status: int, message: str, err_type: str, code: str) -> JSONResponse:
    """Generic OpenAI-wire error body — no internal details (rule R3)."""
    return JSONResponse(
        status_code=status,
        content={"error": {"message": message, "type": err_type, "code": code}},
    )


class ProxyService:
    def __init__(
        self,
        resolver: TokenResolver,
        upstream: UpstreamClient,
        traffic: TrafficStats,
        events: EventSink,
        clock: Clock,
    ) -> None:
        self._resolver = resolver
        self._upstream = upstream
        self._traffic = traffic
        self._events = events
        self._clock = clock

    async def handle(self, request: Request) -> Response:
        agent = self._authenticate(request)
        if agent is None:
            return openai_error(401, "Invalid API key", "invalid_request_error", "invalid_api_key")

        body = await request.body()
        model = self._peek_model(body)
        path = request.url.path
        started = self._clock.monotonic()

        upstream_request = self._upstream.client.build_request(
            method=request.method,
            url=self._upstream.target_url(path),
            content=body if body else None,
            headers=[
                (k, v) for k, v in request.headers.items() if k.lower() not in _SKIP_REQUEST_HEADERS
            ],
        )
        try:
            upstream_response = await self._upstream.client.send(upstream_request, stream=True)
        except Exception as exc:  # noqa: BLE001 - mapped fail-closed below
            return self._fail(agent, model, started, exc, path)

        content_type = upstream_response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            return self._relay_stream(agent, model, started, upstream_response, path)
        return await self._relay_buffered(agent, model, started, upstream_response, path)

    # -- internals -----------------------------------------------------------

    def _authenticate(self, request: Request) -> str | None:
        auth = request.headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            return None
        return self._resolver.resolve(auth[7:].strip())

    @staticmethod
    def _peek_model(body: bytes) -> str:
        """Metadata-only peek (P1): model name for accounting, nothing else kept."""
        try:
            model = json.loads(body).get("model")
            return model if isinstance(model, str) else "unknown"
        except ValueError:
            return "unknown"

    async def _relay_buffered(
        self,
        agent: str,
        model: str,
        started: float,
        upstream_response: httpx.Response,
        path: str,
    ) -> Response:
        try:
            payload = await asyncio.wait_for(
                upstream_response.aread(), timeout=NONSTREAM_TOTAL_TIMEOUT_S
            )
        except Exception as exc:  # noqa: BLE001
            await upstream_response.aclose()
            return self._fail(agent, model, started, exc, path)
        await upstream_response.aclose()
        self._record(agent, model, upstream_response.status_code, started, path)
        return Response(
            content=payload,
            status_code=upstream_response.status_code,
            headers={
                k: v
                for k, v in upstream_response.headers.items()
                if k.lower() not in _SKIP_RESPONSE_HEADERS
            },
        )

    def _relay_stream(
        self,
        agent: str,
        model: str,
        started: float,
        upstream_response: httpx.Response,
        path: str,
    ) -> StreamingResponse:
        service = self

        async def stream() -> AsyncIterator[bytes]:
            try:
                async for line in upstream_response.aiter_lines():
                    yield (line + "\n").encode()
            finally:
                # Runs on normal completion AND client disconnect → upstream
                # request is cancelled and accounting always happens.
                await upstream_response.aclose()
                service._record(agent, model, upstream_response.status_code, started, path)

        return StreamingResponse(
            stream(),
            status_code=upstream_response.status_code,
            media_type="text/event-stream",
            headers={"cache-control": "no-cache"},
        )

    def _fail(
        self, agent: str, model: str, started: float, exc: Exception, path: str
    ) -> JSONResponse:
        status, err_type, code = map_exception(exc)
        logger.warning("upstream failure for agent=%s: %s", agent, type(exc).__name__)
        self._record(agent, model, status, started, path)
        return openai_error(status, "Upstream request failed", err_type, code)

    def _record(self, agent: str, model: str, status: int, started: float, path: str) -> None:
        # Account only genuine LLM-inference calls (FR-1/2/3). Metadata / capability
        # probes are relayed to the client but never counted or emitted, so the
        # dashboard Requests/Errors reflect meaningful traffic only.
        if not is_inference_path(path):
            return
        latency_ms = (self._clock.monotonic() - started) * 1000.0
        ts = self._clock.now_iso()
        self._traffic.record(
            agent, TrafficSample(ts=ts, model=model, status=status, latency_ms=latency_ms)
        )
        self._events.emit(
            CoreEvent(
                kind="traffic.request",
                agent=agent,
                data={"model": model, "status": status, "latency_ms": round(latency_ms, 1)},
                ts=ts,
            )
        )
