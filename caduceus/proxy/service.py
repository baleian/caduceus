"""Proxy pipeline (logic §1.1): authenticate → rewrite → relay → account.

Thin by design: bodies are forwarded unmodified and never logged or stored
(rule P1). Usage numbers come only from what the upstream reports (E3).
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


def _extract_usage(payload: bytes) -> tuple[int | None, int | None]:
    """Pull usage tokens from an OpenAI-style JSON body; None when absent."""
    try:
        usage = json.loads(payload).get("usage") or {}
        return usage.get("prompt_tokens"), usage.get("completion_tokens")
    except (ValueError, AttributeError):
        return None, None


def _extract_usage_from_sse(line: str) -> tuple[int | None, int | None]:
    if not line.startswith("data:") or '"usage"' not in line:
        return None, None
    return _extract_usage(line[len("data:"):].strip().encode())


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
        started = self._clock.monotonic()

        upstream_request = self._upstream.client.build_request(
            method=request.method,
            url=self._upstream.target_url(request.url.path),
            content=body if body else None,
            headers=[
                (k, v)
                for k, v in request.headers.items()
                if k.lower() not in _SKIP_REQUEST_HEADERS
            ],
        )
        try:
            upstream_response = await self._upstream.client.send(
                upstream_request, stream=True
            )
        except Exception as exc:  # noqa: BLE001 - mapped fail-closed below
            return self._fail(agent, model, started, exc)

        content_type = upstream_response.headers.get("content-type", "")
        if "text/event-stream" in content_type:
            return self._relay_stream(agent, model, started, upstream_response)
        return await self._relay_buffered(agent, model, started, upstream_response)

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
        self, agent: str, model: str, started: float, upstream_response: httpx.Response
    ) -> Response:
        try:
            payload = await asyncio.wait_for(
                upstream_response.aread(), timeout=NONSTREAM_TOTAL_TIMEOUT_S
            )
        except Exception as exc:  # noqa: BLE001
            await upstream_response.aclose()
            return self._fail(agent, model, started, exc)
        await upstream_response.aclose()
        input_tokens, output_tokens = _extract_usage(payload)
        self._record(
            agent, model, upstream_response.status_code, started, input_tokens, output_tokens
        )
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
        self, agent: str, model: str, started: float, upstream_response: httpx.Response
    ) -> StreamingResponse:
        service = self

        async def stream() -> AsyncIterator[bytes]:
            input_tokens: int | None = None
            output_tokens: int | None = None
            try:
                async for line in upstream_response.aiter_lines():
                    found_in, found_out = _extract_usage_from_sse(line)
                    if found_in is not None or found_out is not None:
                        input_tokens, output_tokens = found_in, found_out
                    yield (line + "\n").encode()
            finally:
                # Runs on normal completion AND client disconnect → upstream
                # request is cancelled and accounting always happens.
                await upstream_response.aclose()
                service._record(
                    agent, model, upstream_response.status_code, started,
                    input_tokens, output_tokens,
                )

        return StreamingResponse(
            stream(),
            status_code=upstream_response.status_code,
            media_type="text/event-stream",
            headers={"cache-control": "no-cache"},
        )

    def _fail(self, agent: str, model: str, started: float, exc: Exception) -> JSONResponse:
        status, err_type, code = map_exception(exc)
        logger.warning("upstream failure for agent=%s: %s", agent, type(exc).__name__)
        self._record(agent, model, status, started, None, None)
        return openai_error(status, "Upstream request failed", err_type, code)

    def _record(
        self,
        agent: str,
        model: str,
        status: int,
        started: float,
        input_tokens: int | None,
        output_tokens: int | None,
    ) -> None:
        latency_ms = (self._clock.monotonic() - started) * 1000.0
        ts = self._clock.now_iso()
        self._traffic.record(
            agent,
            TrafficSample(
                ts=ts, model=model, status=status, latency_ms=latency_ms,
                input_tokens=input_tokens, output_tokens=output_tokens,
            ),
        )
        self._events.emit(
            CoreEvent(
                kind="traffic.request",
                agent=agent,
                data={
                    "model": model, "status": status,
                    "latency_ms": round(latency_ms, 1),
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                },
                ts=ts,
            )
        )
