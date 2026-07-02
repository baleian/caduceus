"""In-memory traffic accounting (FD5, rules P1/P2, property PU2-2).

Only metadata is recorded — request/response bodies never enter this module.
Everything resets on daemon restart by design (FD5); ``since`` marks that.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from typing import Any

RING_SIZE = 100


@dataclass(frozen=True)
class TrafficSample:
    ts: str
    model: str
    status: int
    latency_ms: float
    input_tokens: int | None = None  # None = upstream did not report (no guessing)
    output_tokens: int | None = None


@dataclass
class AgentTraffic:
    requests: int = 0
    errors: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    last_request_at: str | None = None
    recent: deque[TrafficSample] = field(default_factory=lambda: deque(maxlen=RING_SIZE))


class TrafficStats:
    def __init__(self, *, since_iso: str) -> None:
        self._since = since_iso
        self._agents: dict[str, AgentTraffic] = {}

    def record(self, agent: str, sample: TrafficSample) -> None:
        stats = self._agents.setdefault(agent, AgentTraffic())
        stats.requests += 1
        if sample.status >= 400:
            stats.errors += 1
        if sample.input_tokens:
            stats.input_tokens += sample.input_tokens
        if sample.output_tokens:
            stats.output_tokens += sample.output_tokens
        stats.last_request_at = sample.ts
        stats.recent.append(sample)

    def agent(self, name: str) -> AgentTraffic:
        return self._agents.get(name, AgentTraffic())

    def summary(self) -> dict[str, Any]:
        totals = {
            "requests": sum(a.requests for a in self._agents.values()),
            "errors": sum(a.errors for a in self._agents.values()),
            "input_tokens": sum(a.input_tokens for a in self._agents.values()),
            "output_tokens": sum(a.output_tokens for a in self._agents.values()),
        }
        return {
            "since": self._since,
            "totals": totals,
            "agents": {
                name: {
                    "requests": a.requests,
                    "errors": a.errors,
                    "input_tokens": a.input_tokens,
                    "output_tokens": a.output_tokens,
                    "last_request_at": a.last_request_at,
                }
                for name, a in sorted(self._agents.items())
            },
        }

    def recent(self, agent: str) -> list[TrafficSample]:
        return list(self._agents.get(agent, AgentTraffic()).recent)
