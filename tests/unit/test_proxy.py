"""Proxy pipeline tests: ASGI app + httpx MockTransport upstream (PU2-5, S2)."""

from __future__ import annotations

import json

import httpx
import pytest
from fastapi import FastAPI

from caduceus.core.tokens import TokenResolver, issue_token
from caduceus.core.types import UpstreamConfig
from caduceus.proxy.routes import build_proxy_router
from caduceus.proxy.service import ERROR_MAP, ProxyService, map_exception
from caduceus.proxy.traffic import TrafficStats
from caduceus.proxy.upstream import UpstreamClient
from tests.unit.fakes import FakeClock, RecordingEventSink

UPSTREAM_URL = "http://upstream.test/v1"


def make_app(
    upstream_handler,  # type: ignore[no-untyped-def]
) -> tuple[FastAPI, TrafficStats, RecordingEventSink, str]:
    issued = issue_token("coder")
    resolver = TokenResolver()
    resolver.rebuild({issued.token_hash: "coder"})
    upstream = UpstreamClient(
        UpstreamConfig(base_url=UPSTREAM_URL),
        transport=httpx.MockTransport(upstream_handler),
    )
    traffic = TrafficStats(since_iso="2026-07-03T00:00:00Z")
    sink = RecordingEventSink()
    service = ProxyService(resolver, upstream, traffic, sink, FakeClock())
    app = FastAPI()
    app.include_router(build_proxy_router(service))
    return app, traffic, sink, issued.plaintext


def client_for(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://caduceus.test"
    )


CHAT_BODY = {"model": "hermes-large", "messages": [{"role": "user", "content": "hi"}]}


async def test_unknown_token_is_401_and_never_reaches_upstream() -> None:
    calls: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={})

    app, traffic, _, _ = make_app(handler)
    async with client_for(app) as client:
        response = await client.post(
            "/v1/chat/completions",
            json=CHAT_BODY,
            headers={"Authorization": "Bearer wrong-token"},
        )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_api_key"
    assert calls == []  # fail-closed before any upstream traffic
    assert traffic.summary()["totals"]["requests"] == 0


async def test_missing_bearer_is_401() -> None:
    app, _, _, _ = make_app(lambda r: httpx.Response(200, json={}))
    async with client_for(app) as client:
        response = await client.post("/v1/chat/completions", json=CHAT_BODY)
    assert response.status_code == 401


async def test_non_stream_relay_records_usage_and_replaces_auth() -> None:
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization", "")
        seen["url"] = str(request.url)
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 7},
            },
        )

    app, traffic, sink, token = make_app(handler)
    async with client_for(app) as client:
        response = await client.post(
            "/v1/chat/completions",
            json=CHAT_BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 200
    assert seen["url"] == f"{UPSTREAM_URL}/chat/completions"  # path rewrite
    assert token not in seen["auth"]  # agent token never leaks upstream (S1)
    agent_stats = traffic.agent("coder")
    assert (agent_stats.requests, agent_stats.input_tokens, agent_stats.output_tokens) == (1, 11, 7)
    traffic_events = [e for e in sink.events if e.kind == "traffic.request"]
    assert traffic_events and traffic_events[0].data["model"] == "hermes-large"
    # P1: no body content anywhere in the event
    assert "hi" not in json.dumps(traffic_events[0].data)


async def test_sse_stream_relayed_with_usage_from_last_chunk() -> None:
    sse_body = (
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n'
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n'
        'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n'
        "data: [DONE]\n\n"
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=sse_body, headers={"content-type": "text/event-stream"}
        )

    app, traffic, _, token = make_app(handler)
    async with client_for(app) as client, client.stream(
        "POST",
        "/v1/chat/completions",
        json={**CHAT_BODY, "stream": True},
        headers={"Authorization": f"Bearer {token}"},
    ) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        received = "".join([chunk async for chunk in response.aiter_text()])
    assert '"content":"he"' in received
    assert "[DONE]" in received
    agent_stats = traffic.agent("coder")
    assert (agent_stats.input_tokens, agent_stats.output_tokens) == (5, 2)


async def test_upstream_connect_error_maps_to_502() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    app, traffic, _, token = make_app(handler)
    async with client_for(app) as client:
        response = await client.post(
            "/v1/chat/completions",
            json=CHAT_BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "upstream_unreachable"
    assert "refused" not in response.text  # R3: no internal details
    assert traffic.agent("coder").errors == 1


async def test_usage_absent_records_none_not_guess() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})  # no usage field

    app, traffic, _, token = make_app(handler)
    async with client_for(app) as client:
        await client.post(
            "/v1/chat/completions",
            json=CHAT_BODY,
            headers={"Authorization": f"Bearer {token}"},
        )
    stats = traffic.agent("coder")
    assert (stats.requests, stats.input_tokens, stats.output_tokens) == (1, 0, 0)
    assert stats.recent[-1].input_tokens is None  # honesty over estimation (E3)


async def test_hot_swap_switches_target() -> None:
    def handler_a(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"from": str(request.url.host)})

    app, _, _, token = make_app(handler_a)
    # grab the service's upstream to swap it
    # (route closure holds the service; swap via the same UpstreamClient)
    # simpler: rebuild an app is not a swap test — instead test UpstreamClient directly
    upstream = UpstreamClient(
        UpstreamConfig(base_url="http://a.test/v1"),
        transport=httpx.MockTransport(handler_a),
    )
    assert upstream.target_url("/v1/models") == "http://a.test/v1/models"
    upstream.swap(UpstreamConfig(base_url="http://b.test/v1"))
    assert upstream.target_url("/v1/models") == "http://b.test/v1/models"
    assert upstream.config.base_url == "http://b.test/v1"


class TestPU25ErrorMapping:
    @pytest.mark.parametrize(("exc_type", "expected"), ERROR_MAP)
    def test_table_exhaustive(
        self, exc_type: type[Exception], expected: tuple[int, str, str]
    ) -> None:
        try:
            exc = exc_type("x")
        except TypeError:  # asyncio.TimeoutError()
            exc = exc_type()
        assert map_exception(exc) == expected

    def test_unknown_exception_defaults_to_502(self) -> None:
        assert map_exception(RuntimeError("?")) == (502, "upstream_error", "upstream_failed")

    def test_more_specific_class_wins(self) -> None:
        # ConnectTimeout is both TimeoutException and ConnectError family;
        # table order guarantees the specific mapping
        assert map_exception(httpx.ConnectTimeout("x"))[1] == "upstream_error"
        assert map_exception(httpx.ReadTimeout("x"))[0] == 504
