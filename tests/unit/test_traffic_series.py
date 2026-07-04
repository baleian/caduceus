"""TrafficStats observability extension (observability-redesign S1): minute
rollups, fixed-grid series, latency percentiles, merged recent tail."""

from __future__ import annotations

from caduceus.proxy.traffic import (
    MINUTE_BUCKETS,
    RING_SIZE,
    TrafficSample,
    TrafficStats,
    parse_ts,
    percentile,
)

T0 = "2026-07-03T12:00:00Z"
T0_S = parse_ts(T0) or 0.0


def sample(ts: str, *, status: int = 200, latency: float = 100.0) -> TrafficSample:
    return TrafficSample(ts=ts, model="m", status=status, latency_ms=latency)


class TestRingAndRollup:
    def test_custom_ring_size_caps_raw_samples(self) -> None:
        stats = TrafficStats(since_iso=T0, ring_size=3)
        for i in range(5):
            stats.record("a", sample(f"2026-07-03T12:00:0{i}Z"))
        assert len(stats.recent("a")) == 3
        assert stats.agent("a").requests == 5  # totals unaffected by the cap

    def test_default_ring_size_is_expanded(self) -> None:
        assert RING_SIZE == 5000
        assert MINUTE_BUCKETS == 1440

    def test_same_minute_folds_new_minute_appends(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:00:01Z", latency=100))
        stats.record("a", sample("2026-07-03T12:00:59Z", status=500, latency=300))
        stats.record("a", sample("2026-07-03T12:01:10Z", latency=50))
        buckets = stats.agent("a").minutes
        assert [b.start_s for b in list(buckets)] == [int(T0_S), int(T0_S) + 60]
        buckets = list(buckets)
        assert (buckets[0].requests, buckets[0].errors) == (2, 1)
        assert buckets[0].latency_sum_ms == 400.0
        assert buckets[0].latency_max_ms == 300.0
        assert buckets[1].requests == 1

    def test_unparsable_ts_counts_totals_but_skips_rollup(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("not-a-timestamp"))
        assert stats.agent("a").requests == 1
        assert len(stats.agent("a").minutes) == 0

    def test_clock_skew_folds_into_newest_bucket(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:05:00Z"))
        stats.record("a", sample("2026-07-03T12:03:00Z"))  # skew backwards
        buckets = list(stats.agent("a").minutes)
        assert len(buckets) == 1  # starts stay monotonic
        assert buckets[0].requests == 2


class TestSeries:
    def test_rollup_series_zero_filled_grid(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:00:30Z"))
        stats.record("a", sample("2026-07-03T12:02:30Z", status=502, latency=400))
        now = T0_S + 240
        series = stats.rollup_series("a", window_s=300, now_s=now)
        assert len(series) == 5
        assert sum(cell["requests"] for cell in series) == 2
        assert sum(cell["errors"] for cell in series) == 1
        nonzero = [cell for cell in series if cell["requests"]]
        assert all(cell["avg_latency_ms"] > 0 for cell in nonzero)
        empty = [cell for cell in series if not cell["requests"]]
        assert all(cell["avg_latency_ms"] == 0.0 for cell in empty)

    def test_rollup_series_fleet_sums_agents(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:00:10Z"))
        stats.record("b", sample("2026-07-03T12:00:20Z"))
        series = stats.rollup_series(None, window_s=120, now_s=T0_S + 100)
        assert sum(cell["requests"] for cell in series) == 2

    def test_rollup_series_rebuckets_minutes_into_coarser_cells(self) -> None:
        stats = TrafficStats(since_iso=T0)
        for minute in (0, 1, 14, 16):
            stats.record("a", sample(f"2026-07-03T12:{minute:02d}:00Z"))
        series = stats.rollup_series("a", window_s=1800, bucket_s=900, now_s=T0_S + 1700)
        assert len(series) == 2
        assert sum(cell["requests"] for cell in series) == 4

    def test_sample_series_fine_buckets(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:00:05Z"))
        stats.record("a", sample("2026-07-03T12:00:06Z"))
        stats.record("a", sample("2026-07-03T12:00:25Z", status=500))
        series = stats.sample_series("a", window_s=60, bucket_s=10, now_s=T0_S + 50)
        assert len(series) == 6
        assert sum(cell["requests"] for cell in series) == 3
        assert sum(cell["errors"] for cell in series) == 1

    def test_out_of_window_points_dropped(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T11:00:00Z"))  # an hour before the window
        series = stats.rollup_series("a", window_s=300, now_s=T0_S + 200)
        assert sum(cell["requests"] for cell in series) == 0


class TestLatencyAndRecent:
    def test_latency_summary_percentiles(self) -> None:
        stats = TrafficStats(since_iso=T0)
        for i, latency in enumerate([100, 200, 300, 400, 1000]):
            stats.record("a", sample(f"2026-07-03T12:00:0{i}Z", latency=latency))
        summary = stats.latency_summary("a", window_s=3600, now_s=T0_S + 60)
        assert summary["count"] == 5
        assert summary["avg"] == 400.0
        assert summary["p50"] == 300.0
        assert summary["max"] == 1000.0
        assert summary["p50"] <= summary["p95"] <= summary["max"]

    def test_latency_summary_empty_is_zero(self) -> None:
        stats = TrafficStats(since_iso=T0)
        summary = stats.latency_summary(None, window_s=60, now_s=T0_S)
        assert summary == {"avg": 0.0, "p50": 0.0, "p95": 0.0, "max": 0.0, "count": 0.0}

    def test_recent_merged_fleet_sorted_and_capped(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("b", sample("2026-07-03T12:00:02Z"))
        stats.record("a", sample("2026-07-03T12:00:01Z"))
        stats.record("a", sample("2026-07-03T12:00:03Z"))
        rows = stats.recent_merged(None, limit=2)
        assert [row["ts"] for row in rows] == ["2026-07-03T12:00:02Z", "2026-07-03T12:00:03Z"]
        assert rows[1]["agent"] == "a"

    def test_recent_merged_agent_scope(self) -> None:
        stats = TrafficStats(since_iso=T0)
        stats.record("a", sample("2026-07-03T12:00:01Z"))
        stats.record("b", sample("2026-07-03T12:00:02Z"))
        rows = stats.recent_merged("b", limit=10)
        assert [row["agent"] for row in rows] == ["b"]


class TestPercentileHelper:
    def test_empty_returns_zero(self) -> None:
        assert percentile([], 0.95) == 0.0

    def test_single_value(self) -> None:
        assert percentile([42.0], 0.5) == 42.0
        assert percentile([42.0], 0.95) == 42.0

    def test_result_is_an_input_element(self) -> None:
        values = [1.0, 2.0, 3.0, 4.0]
        for q in (0.0, 0.25, 0.5, 0.75, 0.95, 1.0):
            assert percentile(values, q) in values
