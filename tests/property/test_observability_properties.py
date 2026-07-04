"""Observability aggregation invariants (observability-redesign S2 PBT).

Conservation: bucketing never invents or loses in-window quantities; fleet
aggregation is the elementwise sum of per-agent aggregation (linearity);
derived ratios stay in range. All functions take ``now_s`` — deterministic."""

from __future__ import annotations

from typing import Any

from hypothesis import given
from hypothesis import strategies as st

from caduceus.control import observability as obs
from caduceus.proxy.traffic import RING_SIZE, TrafficSample, TrafficStats, percentile

NOW = 1_783_200_000.0


def sessions_strategy() -> st.SearchStrategy[list[dict[str, Any]]]:
    counts = st.one_of(st.none(), st.integers(min_value=0, max_value=500))
    instant = st.one_of(
        st.none(),
        st.floats(min_value=NOW - 40 * 86_400, max_value=NOW + 3_600, allow_nan=False),
    )
    row = st.fixed_dictionaries(
        {
            "id": st.text(min_size=1, max_size=8),
            "model": st.one_of(st.none(), st.sampled_from(["m1", "m2", "m3"])),
            "source": st.one_of(st.none(), st.sampled_from(["api_server", "cli"])),
            "started_at": instant,
            "last_active": instant,
            "ended_at": st.one_of(st.none(), st.just(NOW - 100)),
            "api_call_count": counts,
            "message_count": counts,
            "tool_call_count": counts,
            "input_tokens": counts,
            "output_tokens": counts,
            "cache_read_tokens": counts,
            "cache_write_tokens": counts,
            "reasoning_tokens": counts,
            "estimated_cost_usd": st.one_of(
                st.none(), st.floats(min_value=0, max_value=10, allow_nan=False)
            ),
            "actual_cost_usd": st.none(),
        }
    )
    return st.lists(row, max_size=40)


def in_window(sessions: list[dict[str, Any]], range_key: str) -> list[dict[str, Any]]:
    bucket_s, count = obs.RANGES[range_key]
    end = int(NOW // bucket_s) * bucket_s + bucket_s
    start0 = end - count * bucket_s
    kept = []
    for s in sessions:
        instant = obs.session_time(s)
        if instant is not None and start0 <= instant < end:
            kept.append(s)
    return kept


@given(sessions_strategy(), st.sampled_from(["24h", "7d", "30d"]))
def test_bucket_conservation(sessions: list[dict[str, Any]], range_key: str) -> None:
    grid = obs.bucket_sessions(sessions, now_s=NOW, range_key=range_key)
    assert len(grid) == obs.RANGES[range_key][1]
    starts = [cell["start_s"] for cell in grid]
    assert starts == sorted(starts) and len(set(starts)) == len(starts)
    kept = in_window(sessions, range_key)
    assert sum(cell["sessions"] for cell in grid) == len(kept)
    for key, field in (
        ("requests", "api_call_count"),
        ("messages", "message_count"),
        ("tool_calls", "tool_call_count"),
        ("input_tokens", "input_tokens"),
        ("cost_usd", "estimated_cost_usd"),
    ):
        expected = sum(float(s[field] or 0) for s in kept)
        assert sum(cell[key] for cell in grid) == expected


@given(
    st.lists(st.tuples(st.sampled_from(["a", "b", "c"]), sessions_strategy()), max_size=3),
    st.sampled_from(["24h", "7d", "30d"]),
)
def test_fleet_equals_sum_of_agents(
    per_agent: list[tuple[str, list[dict[str, Any]]]], range_key: str
) -> None:
    all_sessions = [s for _, sessions in per_agent for s in sessions]
    fleet = obs.bucket_sessions(all_sessions, now_s=NOW, range_key=range_key)
    agent_grids = [obs.bucket_sessions(s, now_s=NOW, range_key=range_key) for _, s in per_agent]
    for i, cell in enumerate(fleet):
        for key in cell:
            if key == "start_s":
                continue
            assert cell[key] == sum(grid[i][key] for grid in agent_grids)


@given(sessions_strategy())
def test_kpi_ratios_in_range_and_nonnegative(sessions: list[dict[str, Any]]) -> None:
    kpis = obs.session_kpis(sessions, now_s=NOW)
    assert 0.0 <= kpis["cache_hit_ratio"] <= 1.0
    assert kpis["active_sessions"] <= kpis["sessions"] == len(sessions)
    for key, value in kpis.items():
        assert float(value) >= 0.0, key


@given(sessions_strategy())
def test_distributions_conserve_requests(sessions: list[dict[str, Any]]) -> None:
    dist = obs.distributions(sessions)
    total = sum(float(s["api_call_count"] or 0) for s in sessions)
    for field in ("by_model", "by_source"):
        assert sum(row["requests"] for row in dist[field]) == total
        values = [row["requests"] for row in dist[field]]
        assert values == sorted(values, reverse=True)


# -- gateway rollup invariants (S1) ------------------------------------------------

samples = st.builds(
    TrafficSample,
    ts=st.integers(min_value=0, max_value=7200).map(
        lambda o: f"2026-07-03T{o // 3600:02d}:{(o % 3600) // 60:02d}:{o % 60:02d}Z"
    ),
    model=st.just("m"),
    status=st.sampled_from([200, 200, 500]),
    latency_ms=st.floats(min_value=0, max_value=5000, allow_nan=False),
)


@given(st.lists(samples, max_size=300))
def test_rollup_conserves_and_stays_bounded(sample_list: list[TrafficSample]) -> None:
    stats = TrafficStats(since_iso="2026-07-03T00:00:00Z")
    for sample in sample_list:
        stats.record("a", sample)
    minutes = list(stats.agent("a").minutes)
    assert len(minutes) <= 1440
    assert len(stats.recent("a")) <= RING_SIZE
    starts = [b.start_s for b in minutes]
    assert starts == sorted(starts)
    # every parsable sample lands in exactly one rollup bucket
    assert sum(b.requests for b in minutes) == len(sample_list)
    errors = sum(1 for s in sample_list if s.status >= 400)
    assert sum(b.errors for b in minutes) == errors


@given(st.lists(samples, max_size=200), st.integers(min_value=1, max_value=7200))
def test_grid_never_exceeds_recorded(sample_list: list[TrafficSample], window_s: int) -> None:
    stats = TrafficStats(since_iso="2026-07-03T00:00:00Z")
    for sample in sample_list:
        stats.record("a", sample)
    now_s = 7200.0 + 1_767_398_400  # any fixed instant ≥ all samples (2026-01-03 base)
    series = stats.rollup_series("a", window_s=window_s, now_s=now_s)
    assert len(series) == max(1, window_s // 60)
    assert sum(cell["requests"] for cell in series) <= len(sample_list)
    for cell in series:
        assert cell["errors"] <= cell["requests"]
        assert cell["avg_latency_ms"] >= 0.0


@given(st.lists(st.floats(min_value=0, max_value=10_000, allow_nan=False), max_size=200))
def test_percentile_within_bounds(latencies: list[float]) -> None:
    ordered = sorted(latencies)
    for q in (0.0, 0.5, 0.95, 1.0):
        value = percentile(ordered, q)
        if ordered:
            assert ordered[0] <= value <= ordered[-1]
            assert value in ordered
        else:
            assert value == 0.0
