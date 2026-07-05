"""Observability aggregation (observability-redesign S2/S3): pure session
bucketing/KPIs/distributions plus the fan-out collector's failure isolation."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import httpx
import pytest

from caduceus.control import observability as obs
from caduceus.core.registry import Registry, RegistryStore
from caduceus.core.types import AgentRecord, AgentSpec
from tests.unit.fakes import FakeClock, InMemoryFileStore

NOW = 1_783_200_000.0  # deterministic "now" (epoch s)


def session(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "s1",
        "model": "m1",
        "source": "api_server",
        "title": None,
        "started_at": NOW - 600,
        "last_active": NOW - 60,
        "ended_at": None,
        "api_call_count": 5,
        "message_count": 10,
        "tool_call_count": 3,
        "input_tokens": 1000,
        "output_tokens": 200,
        "cache_read_tokens": 3000,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "estimated_cost_usd": 0.02,
        "actual_cost_usd": None,
        "preview": "conversation text that must never be forwarded",
    }
    base.update(overrides)
    return base


class TestBucketSessions:
    def test_grid_shape_and_placement(self) -> None:
        rows = [session(), session(id="s2", last_active=NOW - 90_000)]  # second out of 24h
        grid = obs.bucket_sessions(rows, now_s=NOW, range_key="24h")
        assert len(grid) == 24
        assert sum(cell["sessions"] for cell in grid) == 1
        assert sum(cell["requests"] for cell in grid) == 5

    def test_placement_falls_back_to_started_at(self) -> None:
        rows = [session(last_active=None)]
        grid = obs.bucket_sessions(rows, now_s=NOW, range_key="24h")
        assert sum(cell["sessions"] for cell in grid) == 1

    def test_null_numerics_count_as_zero(self) -> None:
        rows = [session(input_tokens=None, estimated_cost_usd=None, api_call_count=None)]
        grid = obs.bucket_sessions(rows, now_s=NOW, range_key="24h")
        assert sum(cell["requests"] for cell in grid) == 0
        assert sum(cell["input_tokens"] for cell in grid) == 0

    def test_future_timestamps_dropped(self) -> None:
        rows = [session(last_active=NOW + 86_400)]
        grid = obs.bucket_sessions(rows, now_s=NOW, range_key="24h")
        assert sum(cell["sessions"] for cell in grid) == 0

    @pytest.mark.parametrize(("range_key", "count"), [("24h", 24), ("7d", 28), ("30d", 30)])
    def test_range_presets(self, range_key: str, count: int) -> None:
        assert len(obs.bucket_sessions([], now_s=NOW, range_key=range_key)) == count


class TestSessionKpis:
    def test_totals_and_ratios(self) -> None:
        rows = [session(), session(id="s2", input_tokens=0, cache_read_tokens=0)]
        kpis = obs.session_kpis(rows, now_s=NOW)
        assert kpis["requests"] == 10.0
        assert kpis["sessions"] == 2
        assert kpis["cache_hit_ratio"] == pytest.approx(3000 / 4000)
        assert kpis["avg_duration_s"] == pytest.approx(540.0)

    def test_active_window(self) -> None:
        rows = [
            session(),  # touched 60s ago, not ended → active
            session(id="s2", last_active=NOW - 3600),  # stale
            session(id="s3", ended_at=NOW - 10),  # ended
        ]
        assert obs.session_kpis(rows, now_s=NOW)["active_sessions"] == 1

    def test_empty_is_all_zeros(self) -> None:
        kpis = obs.session_kpis([], now_s=NOW)
        assert kpis["sessions"] == 0
        assert kpis["cache_hit_ratio"] == 0.0
        assert kpis["avg_duration_s"] == 0.0


class TestDistributionsAndRows:
    def test_distributions_sorted_by_requests(self) -> None:
        rows = [
            session(model="big", api_call_count=10),
            session(id="s2", model="small", api_call_count=2),
            session(id="s3", model=None, api_call_count=1),
        ]
        dist = obs.distributions(rows)
        assert [r["model"] for r in dist["by_model"]] == ["big", "small", "unknown"]
        assert dist["by_source"][0]["source"] == "api_server"

    def test_session_rows_sanitized_and_sorted(self) -> None:
        rows = obs.session_rows([session(), session(id="s2", last_active=NOW - 10)])
        assert [r["id"] for r in rows] == ["s2", "s1"]  # newest first
        assert all("preview" not in r for r in rows)
        assert rows[1]["duration_s"] == pytest.approx(540.0)

    def test_session_rows_survive_foreign_timestamp_shapes(self) -> None:
        # Found in e2e: a fake api_server emitted ISO-string timestamps and the
        # sort crashed. Rows are external input — coerce to None, never raise.
        rows = obs.session_rows(
            [
                session(id="iso", started_at="2026-07-03T00:00:00Z", last_active="not-a-number"),
                session(id="num"),
            ]
        )
        by_id = {r["id"]: r for r in rows}
        assert by_id["iso"]["started_at"] is None
        assert by_id["iso"]["last_active"] is None
        assert by_id["iso"]["duration_s"] == 0.0
        assert rows[0]["id"] == "num"  # numeric instants sort ahead of unknown

    def test_ranking_sorted_by_requests(self) -> None:
        per_agent = [
            obs.AgentSessions(agent="low", reachable=True, sessions=[session(api_call_count=1)]),
            obs.AgentSessions(agent="high", reachable=True, sessions=[session(api_call_count=9)]),
            obs.AgentSessions(agent="down", reachable=False, sessions=[]),
        ]
        rows = obs.ranking(per_agent, now_s=NOW)
        assert [r["agent"] for r in rows] == ["high", "low", "down"]
        assert rows[2]["reachable"] is False
        # per-type token breakdown is exposed for the stacked ranking bar
        assert rows[0]["tokens"] == rows[0]["input_tokens"] + rows[0]["output_tokens"]
        assert "cache_read_tokens" in rows[0]


def make_registry(*names: str) -> Registry:
    files = InMemoryFileStore()
    registry = Registry(RegistryStore(Path("/registry.json"), files, FakeClock()))
    for i, name in enumerate(names):
        registry.add(
            AgentRecord(
                spec=AgentSpec(name=name),
                profile_name=f"cad-{name}",
                workspace_dir=f"/w/{name}",
                api_port=39000 + i,
                api_server_key="k" * 32,
                token_hash=f"{i:064x}",
                desired_state="running",
                created_at="2026-07-03T00:00:00Z",
            )
        )
    return registry


class TestCollectSessions:
    @pytest.mark.asyncio
    async def test_partial_failure_degrades_per_agent(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            port = request.url.port
            if port == 39000:
                assert request.headers["authorization"] == f"Bearer {'k' * 32}"
                return httpx.Response(200, json={"data": [session()]})
            if port == 39001:
                return httpx.Response(500, text="boom")
            return httpx.Response(200, text="not json")

        registry = make_registry("ok", "boom", "garbled")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            results = await obs.collect_sessions(registry, client)
        by_name = {r.agent: r for r in results}
        assert by_name["ok"].reachable and len(by_name["ok"].sessions) == 1
        assert not by_name["boom"].reachable and by_name["boom"].sessions == []
        assert not by_name["garbled"].reachable

    @pytest.mark.asyncio
    async def test_non_dict_rows_filtered(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"data": [session(), "junk", 42]})

        registry = make_registry("a")
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            results = await obs.collect_sessions(registry, client)
        assert len(results[0].sessions) == 1

    @pytest.mark.asyncio
    async def test_empty_registry_returns_empty(self) -> None:
        registry = make_registry()
        async with httpx.AsyncClient() as client:
            assert await obs.collect_sessions(registry, client) == []
