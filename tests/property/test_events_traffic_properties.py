"""PU2-6 (event bus replay) and PU2-2 (traffic counters) properties."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from caduceus.control.events import EventBus
from caduceus.core.types import CoreEvent
from caduceus.proxy.traffic import TrafficSample, TrafficStats
from tests.property.strategies import agent_names


def make_event(i: int) -> CoreEvent:
    return CoreEvent(kind="test", agent=None, data={"i": i}, ts="2026-07-03T00:00:00Z")


@given(st.integers(min_value=0, max_value=1200), st.integers(min_value=1, max_value=50))
def test_pu2_6_replay_keeps_last_n_in_order(total: int, replay_size: int) -> None:
    bus = EventBus(replay_size=replay_size)
    for i in range(total):
        bus.emit(make_event(i))
    replay = bus.replay()
    expected = list(range(max(0, total - replay_size), total))
    assert [e.data["i"] for e in replay] == expected  # FIFO order, bounded


@given(st.integers(min_value=1, max_value=200))
def test_pu2_6_subscriber_receives_emission_order(total: int) -> None:
    bus = EventBus()
    queue = bus.subscribe()
    for i in range(total):
        bus.emit(make_event(i))
    received = [queue.get_nowait().data["i"] for _ in range(total)]
    assert received == list(range(total))


samples = st.builds(
    TrafficSample,
    ts=st.just("2026-07-03T00:00:00Z"),
    model=st.sampled_from(["hermes", "gpt", "llama"]),
    status=st.sampled_from([200, 200, 200, 401, 502]),
    latency_ms=st.floats(min_value=0, max_value=5000, allow_nan=False),
    input_tokens=st.one_of(st.none(), st.integers(min_value=0, max_value=100_000)),
    output_tokens=st.one_of(st.none(), st.integers(min_value=0, max_value=100_000)),
)


@given(st.lists(st.tuples(agent_names(), samples), max_size=60))
def test_pu2_2_totals_equal_sum_of_agents(records: list[tuple[str, TrafficSample]]) -> None:
    stats = TrafficStats(since_iso="2026-07-03T00:00:00Z")
    for agent, sample in records:
        stats.record(agent, sample)
    summary = stats.summary()
    for key in ("requests", "errors", "input_tokens", "output_tokens"):
        assert summary["totals"][key] == sum(a[key] for a in summary["agents"].values())
    assert summary["totals"]["requests"] == len(records)


@given(st.lists(samples, min_size=1, max_size=250))
def test_pu2_2_counters_monotonic_and_ring_bounded(sample_list: list[TrafficSample]) -> None:
    stats = TrafficStats(since_iso="2026-07-03T00:00:00Z")
    prev_requests = 0
    for sample in sample_list:
        stats.record("coder", sample)
        current = stats.agent("coder").requests
        assert current == prev_requests + 1  # strictly monotonic
        prev_requests = current
    assert len(stats.recent("coder")) <= 100
    assert [s.ts for s in stats.recent("coder")] == [
        s.ts for s in sample_list[-100:]
    ]
