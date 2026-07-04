"""Observability endpoint contracts (observability-redesign S4)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx

from caduceus.core.types import AgentRecord, AgentSpec
from tests.unit.test_web_serving import admin_headers, make_app

SESSION_ROW: dict[str, Any] = {
    "id": "sess-1",
    "model": "m1",
    "source": "api_server",
    "title": "t",
    "started_at": 1_753_000_000.0,
    "last_active": 1_753_000_500.0,
    "ended_at": None,
    "api_call_count": 7,
    "message_count": 12,
    "tool_call_count": 4,
    "input_tokens": 1000,
    "output_tokens": 300,
    "cache_read_tokens": 500,
    "cache_write_tokens": 0,
    "reasoning_tokens": 0,
    "estimated_cost_usd": 0.05,
    "actual_cost_usd": None,
    "preview": "MUST NOT LEAK",
}


def add_agent(daemon: object, name: str, port: int) -> None:
    daemon.registry.add(  # type: ignore[attr-defined]
        AgentRecord(
            spec=AgentSpec(name=name),
            profile_name=f"cad-{name}",
            workspace_dir=f"/w/{name}",
            api_port=port,
            api_server_key="k" * 32,
            token_hash="0" * 64,
            desired_state="running",
            created_at="2026-07-03T00:00:00Z",
        )
    )


def sessions_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json={"data": [SESSION_ROW]})


class TestUsageEndpoint:
    def test_invalid_range_is_422(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get("/api/observability/usage?range=1y", headers=admin_headers(files))
        assert response.status_code == 422

    def test_unknown_agent_is_404(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get(
            "/api/observability/usage?agent=ghost", headers=admin_headers(files)
        )
        assert response.status_code == 404

    def test_empty_registry_returns_zeroed_fleet(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get("/api/observability/usage", headers=admin_headers(files))
        assert response.status_code == 200
        body = response.json()
        assert body["range"] == "24h"
        assert body["fleet"]["kpis"]["sessions"] == 0
        assert len(body["fleet"]["series"]) == 24
        assert body["agent"] is None
        assert body["unreachable"] == []

    def test_agent_scope_carries_sessions_without_content(self, tmp_path: Path) -> None:
        client, files, daemon = make_app(
            tmp_path, with_dist=False, agent_transport=httpx.MockTransport(sessions_handler)
        )
        add_agent(daemon, "a1", 39001)
        response = client.get(
            "/api/observability/usage?range=7d&agent=a1", headers=admin_headers(files)
        )
        assert response.status_code == 200
        body = response.json()
        assert body["bucket_s"] == 21_600
        assert body["fleet"]["kpis"]["requests"] == 7.0
        assert body["fleet"]["ranking"][0]["agent"] == "a1"
        agent = body["agent"]
        assert agent["name"] == "a1" and agent["reachable"] is True
        assert agent["kpis"]["sessions"] == 1
        assert agent["sessions"][0]["id"] == "sess-1"
        assert "MUST NOT LEAK" not in response.text  # no conversation content
        assert "preview" not in agent["sessions"][0]

    def test_unreachable_agent_degrades(self, tmp_path: Path) -> None:
        def failing(request: httpx.Request) -> httpx.Response:
            return httpx.Response(502, text="down")

        client, files, daemon = make_app(
            tmp_path, with_dist=False, agent_transport=httpx.MockTransport(failing)
        )
        add_agent(daemon, "a1", 39001)
        response = client.get("/api/observability/usage", headers=admin_headers(files))
        assert response.status_code == 200
        assert response.json()["unreachable"] == ["a1"]

    def test_requires_admin_token(self, tmp_path: Path) -> None:
        client, _, _ = make_app(tmp_path, with_dist=False)
        assert client.get("/api/observability/usage").status_code == 401


class TestGatewayEndpoint:
    def test_invalid_window_is_422(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get(
            "/api/observability/gateway?window=1w", headers=admin_headers(files)
        )
        assert response.status_code == 422

    def test_unknown_agent_is_404(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get(
            "/api/observability/gateway?agent=ghost", headers=admin_headers(files)
        )
        assert response.status_code == 404

    def test_shape_and_volatile_marker(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get("/api/observability/gateway", headers=admin_headers(files))
        assert response.status_code == 200
        body = response.json()
        assert body["window"] == "1h" and body["bucket_s"] == 60
        assert body["since"]  # volatile scope marker (daemon start)
        assert body["totals"] == {"requests": 0, "errors": 0}
        assert body["latency"]["count"] == 0.0
        assert len(body["series"]) == 60
        assert body["recent"] == []

    def test_15m_window_uses_fine_buckets(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get(
            "/api/observability/gateway?window=15m", headers=admin_headers(files)
        )
        body = response.json()
        assert body["bucket_s"] == 10
        assert len(body["series"]) == 90

    def test_24h_window_rebuckets_to_15min(self, tmp_path: Path) -> None:
        client, files, _ = make_app(tmp_path, with_dist=False)
        response = client.get(
            "/api/observability/gateway?window=24h", headers=admin_headers(files)
        )
        body = response.json()
        assert body["bucket_s"] == 900
        assert len(body["series"]) == 96
