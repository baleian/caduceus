"""In-memory traffic accounting (FD5, rules P1/P2, property PU2-2).

Only request-level metadata is recorded — request/response bodies never enter
this module, and token usage is NOT tracked here (hermes accounts tokens
natively per session). Everything resets on daemon restart by design (FD5);
``since`` marks that.

Observability extension (observability-redesign Q3=C): the per-agent raw ring
is larger (``RING_SIZE``) and each agent additionally keeps a bounded deque of
per-minute rollup buckets (``MINUTE_BUCKETS`` — 24h), so the daemon can serve
live time series beyond the raw ring's horizon. Both structures are hard-capped
``deque(maxlen=...)`` — memory is bounded (~1MB/agent) and nothing is ever
persisted to disk. Series/percentile helpers are pure and deterministic
(``now_s`` is a parameter) so they are property-testable.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

RING_SIZE = 5000  # raw samples/agent (~150B each → ~0.75MB/agent hard cap)
MINUTE_BUCKETS = 1440  # per-minute rollups/agent (24h hard cap)


@dataclass(frozen=True)
class TrafficSample:
    ts: str
    model: str
    status: int
    latency_ms: float


@dataclass
class MinuteBucket:
    """One minute of folded samples (rollup — outlives the raw ring)."""

    start_s: int  # epoch seconds, minute-aligned
    requests: int = 0
    errors: int = 0
    latency_sum_ms: float = 0.0
    latency_max_ms: float = 0.0


@dataclass
class AgentTraffic:
    requests: int = 0
    errors: int = 0
    last_request_at: str | None = None
    recent: deque[TrafficSample] = field(default_factory=lambda: deque(maxlen=RING_SIZE))
    minutes: deque[MinuteBucket] = field(default_factory=lambda: deque(maxlen=MINUTE_BUCKETS))


def parse_ts(ts: str) -> float | None:
    """ISO timestamp → epoch seconds; None when unparsable (never raises)."""
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def percentile(sorted_values: list[float], q: float) -> float:
    """Nearest-rank percentile over pre-sorted values; 0.0 on empty input.

    Pure; result is always an element of the input (∈ [min, max])."""
    if not sorted_values:
        return 0.0
    rank = min(len(sorted_values) - 1, max(0, round(q * (len(sorted_values) - 1))))
    return sorted_values[rank]


class TrafficStats:
    def __init__(self, *, since_iso: str, ring_size: int = RING_SIZE) -> None:
        self._since = since_iso
        self._ring_size = ring_size
        self._agents: dict[str, AgentTraffic] = {}

    def _new_agent(self) -> AgentTraffic:
        return AgentTraffic(
            recent=deque(maxlen=self._ring_size),
            minutes=deque(maxlen=MINUTE_BUCKETS),
        )

    def record(self, agent: str, sample: TrafficSample) -> None:
        stats = self._agents.setdefault(agent, self._new_agent())
        stats.requests += 1
        if sample.status >= 400:
            stats.errors += 1
        stats.last_request_at = sample.ts
        stats.recent.append(sample)
        self._fold_minute(stats, sample)

    @staticmethod
    def _fold_minute(stats: AgentTraffic, sample: TrafficSample) -> None:
        epoch = parse_ts(sample.ts)
        if epoch is None:
            return  # unparsable ts: counted in totals/ring, absent from rollup
        minute = int(epoch // 60) * 60
        error = 1 if sample.status >= 400 else 0
        if stats.minutes and stats.minutes[-1].start_s >= minute:
            # same minute, or clock skew backwards — fold into the newest bucket
            # so bucket starts stay monotonically non-decreasing (invariant).
            bucket = stats.minutes[-1]
        else:
            bucket = MinuteBucket(start_s=minute)
            stats.minutes.append(bucket)
        bucket.requests += 1
        bucket.errors += error
        bucket.latency_sum_ms += sample.latency_ms
        bucket.latency_max_ms = max(bucket.latency_max_ms, sample.latency_ms)

    def agent(self, name: str) -> AgentTraffic:
        return self._agents.get(name, AgentTraffic())

    def summary(self) -> dict[str, Any]:
        totals = {
            "requests": sum(a.requests for a in self._agents.values()),
            "errors": sum(a.errors for a in self._agents.values()),
        }
        return {
            "since": self._since,
            "totals": totals,
            "agents": {
                name: {
                    "requests": a.requests,
                    "errors": a.errors,
                    "last_request_at": a.last_request_at,
                }
                for name, a in sorted(self._agents.items())
            },
        }

    def recent(self, agent: str) -> list[TrafficSample]:
        return list(self._agents.get(agent, AgentTraffic()).recent)

    # -- observability series (pure given now_s) --------------------------------

    def _selected(self, agent: str | None) -> list[AgentTraffic]:
        if agent is None:
            return list(self._agents.values())
        found = self._agents.get(agent)
        return [found] if found is not None else []

    def rollup_series(
        self, agent: str | None, *, window_s: int, bucket_s: int = 60, now_s: float
    ) -> list[dict[str, Any]]:
        """Fixed grid over the window (zero-filled), from minute rollup buckets.

        ``bucket_s`` ≥ 60 re-buckets minutes into coarser cells (e.g. 15 min for
        a 24h window). Fleet scope (agent=None) sums across agents by start."""
        return self._grid(
            [
                (b.start_s, b.requests, b.errors, b.latency_sum_ms)
                for a in self._selected(agent)
                for b in a.minutes
            ],
            window_s=window_s,
            bucket_s=bucket_s,
            now_s=now_s,
        )

    def sample_series(
        self, agent: str | None, *, window_s: int, bucket_s: int, now_s: float
    ) -> list[dict[str, Any]]:
        """Fixed fine-grained grid from raw ring samples (Live view)."""
        points: list[tuple[int, int, int, float]] = []
        for a in self._selected(agent):
            for s in a.recent:
                epoch = parse_ts(s.ts)
                if epoch is None:
                    continue
                start = int(epoch // bucket_s) * bucket_s
                points.append((start, 1, 1 if s.status >= 400 else 0, s.latency_ms))
        return self._grid(points, window_s=window_s, bucket_s=bucket_s, now_s=now_s)

    @staticmethod
    def _grid(
        points: list[tuple[int, int, int, float]],
        *,
        window_s: int,
        bucket_s: int,
        now_s: float,
    ) -> list[dict[str, Any]]:
        """Zero-filled fixed grid ending at ``now_s``; drops out-of-window points.

        Each point is (bucket_start_s, requests, errors, latency_sum_ms)."""
        safe_bucket = max(1, bucket_s)
        count = max(1, window_s // safe_bucket)
        end = int(now_s // safe_bucket) * safe_bucket + safe_bucket  # exclusive
        start0 = end - count * safe_bucket
        grid = [
            {"start_s": start0 + i * safe_bucket, "requests": 0, "errors": 0, "latency_sum_ms": 0.0}
            for i in range(count)
        ]
        for start, requests, errors, latency_sum in points:
            aligned = int(start // safe_bucket) * safe_bucket
            if aligned < start0 or aligned >= end:
                continue
            cell = grid[(aligned - start0) // safe_bucket]
            cell["requests"] += requests
            cell["errors"] += errors
            cell["latency_sum_ms"] += latency_sum
        for cell in grid:
            latency_sum = cell.pop("latency_sum_ms")
            cell["avg_latency_ms"] = latency_sum / cell["requests"] if cell["requests"] else 0.0
        return grid

    def recent_merged(self, agent: str | None, *, limit: int = 100) -> list[dict[str, Any]]:
        """Newest raw samples across the scope (agent-tagged), ascending by ts.

        Fleet scope merges every agent's ring tail; ties keep insertion order."""
        rows = [
            {
                "ts": s.ts,
                "agent": name,
                "model": s.model,
                "status": s.status,
                "latency_ms": s.latency_ms,
            }
            for name, a in self._agents.items()
            if agent is None or name == agent
            for s in a.recent
        ]
        rows.sort(key=lambda r: str(r["ts"]))
        return rows[-max(0, limit):]

    def latency_summary(
        self, agent: str | None, *, window_s: int, now_s: float
    ) -> dict[str, float]:
        """avg/p50/p95/max/count over raw-ring samples inside the window."""
        cutoff = now_s - window_s
        latencies: list[float] = []
        for a in self._selected(agent):
            for s in a.recent:
                epoch = parse_ts(s.ts)
                if epoch is not None and epoch >= cutoff:
                    latencies.append(s.latency_ms)
        latencies.sort()
        count = len(latencies)
        return {
            "avg": (sum(latencies) / count) if count else 0.0,
            "p50": percentile(latencies, 0.50),
            "p95": percentile(latencies, 0.95),
            "max": latencies[-1] if count else 0.0,
            "count": float(count),
        }
