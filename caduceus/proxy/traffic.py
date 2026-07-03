"""In-memory traffic accounting (FD5, rules P1/P2, property PU2-2).

Only request-level metadata is recorded — request/response bodies never enter
this module, and token usage is NOT tracked here (hermes accounts tokens
natively per session). Everything resets on daemon restart by design (FD5);
``since`` marks that.
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


@dataclass
class AgentTraffic:
    requests: int = 0
    errors: int = 0
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
        stats.last_request_at = sample.ts
        stats.recent.append(sample)

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
