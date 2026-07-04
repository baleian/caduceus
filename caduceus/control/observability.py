"""Observability aggregation (observability-redesign S2/S3).

Two halves, deliberately separated:

- **Pure aggregation** over hermes-native session rows (the per-session dicts
  returned by an agent api_server's ``GET /api/sessions``): time bucketing,
  KPI rollups, model/source distributions, fleet ranking. Every function takes
  ``now_s`` explicitly — deterministic, property-testable (PBT).
- **Async collection**: fan out over registry agents, fetching each agent's
  sessions with its own api_server key attached server-side (S3 — keys never
  reach the browser). Per-agent failure degrades to ``reachable=False``
  (RESILIENCY: partial success, never all-or-nothing).

Session rows are hermes state — timestamps are epoch floats, token/cost fields
may be null (older sessions). Missing numerics count as 0.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from caduceus.core.registry import Registry

# range → (bucket seconds, bucket count). Grid ends at now (exclusive).
RANGES: dict[str, tuple[int, int]] = {
    "24h": (3600, 24),  # hourly
    "7d": (21600, 28),  # 6-hourly
    "30d": (86400, 30),  # daily
}

ACTIVE_WINDOW_S = 300  # session is "active" when not ended and touched recently
SESSIONS_FETCH_LIMIT = 1000  # per agent — bounded fan-out response size

_TOKEN_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "reasoning_tokens")
_SERIES_KEYS = ("requests", "sessions", "messages", "tool_calls", "cost_usd", *_TOKEN_KEYS)


def _num(session: dict[str, Any], key: str) -> float:
    value = session.get(key)
    return float(value) if isinstance(value, (int, float)) else 0.0


def session_time(session: dict[str, Any]) -> float | None:
    """Placement instant for bucketing: last_active, else started_at (Q4=A)."""
    for key in ("last_active", "started_at"):
        value = session.get(key)
        if isinstance(value, (int, float)):
            return float(value)
    return None


def bucket_sessions(
    sessions: list[dict[str, Any]], *, now_s: float, range_key: str
) -> list[dict[str, Any]]:
    """Zero-filled fixed grid of per-bucket sums; out-of-window sessions drop.

    Invariants (PBT): len == RANGES[range_key][1]; per-key series sum equals
    the same key summed over in-window sessions; starts strictly increase."""
    bucket_s, count = RANGES[range_key]
    end = int(now_s // bucket_s) * bucket_s + bucket_s  # exclusive
    start0 = end - count * bucket_s
    grid: list[dict[str, Any]] = [
        {"start_s": start0 + i * bucket_s, **{k: 0.0 for k in _SERIES_KEYS}} for i in range(count)
    ]
    for session in sessions:
        instant = session_time(session)
        if instant is None or instant < start0 or instant >= end:
            continue
        cell = grid[int((instant - start0) // bucket_s)]
        cell["requests"] += _num(session, "api_call_count")
        cell["sessions"] += 1
        cell["messages"] += _num(session, "message_count")
        cell["tool_calls"] += _num(session, "tool_call_count")
        cell["cost_usd"] += _num(session, "estimated_cost_usd")
        for key in _TOKEN_KEYS:
            cell[key] += _num(session, key)
    return grid


def session_kpis(sessions: list[dict[str, Any]], *, now_s: float) -> dict[str, Any]:
    """Scope totals + derived ratios over ALL given sessions (no window cut)."""
    totals = {key: 0.0 for key in ("requests", "messages", "tool_calls", "cost_usd", *_TOKEN_KEYS)}
    cache_write = 0.0
    actual_cost = 0.0
    durations: list[float] = []
    active = 0
    for session in sessions:
        totals["requests"] += _num(session, "api_call_count")
        totals["messages"] += _num(session, "message_count")
        totals["tool_calls"] += _num(session, "tool_call_count")
        totals["cost_usd"] += _num(session, "estimated_cost_usd")
        for key in _TOKEN_KEYS:
            totals[key] += _num(session, key)
        cache_write += _num(session, "cache_write_tokens")
        actual_cost += _num(session, "actual_cost_usd")
        started, touched = session.get("started_at"), session.get("last_active")
        if isinstance(started, (int, float)) and isinstance(touched, (int, float)):
            durations.append(max(0.0, float(touched) - float(started)))
        if (
            session.get("ended_at") is None
            and isinstance(touched, (int, float))
            and now_s - float(touched) <= ACTIVE_WINDOW_S
        ):
            active += 1
    denominator = totals["input_tokens"] + totals["cache_read_tokens"]
    return {
        **totals,
        "cache_write_tokens": cache_write,
        "actual_cost_usd": actual_cost,
        "sessions": len(sessions),
        "active_sessions": active,
        "avg_duration_s": (sum(durations) / len(durations)) if durations else 0.0,
        "cache_hit_ratio": (totals["cache_read_tokens"] / denominator) if denominator else 0.0,
    }


def distributions(sessions: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    """by_model / by_source rows (requests·tokens·cost·sessions per group)."""

    def group(field: str) -> list[dict[str, Any]]:
        rows: dict[str, dict[str, float]] = {}
        for session in sessions:
            key = str(session.get(field) or "unknown")
            row = rows.setdefault(
                key, {"requests": 0.0, "sessions": 0.0, "tokens": 0.0, "cost_usd": 0.0}
            )
            row["requests"] += _num(session, "api_call_count")
            row["sessions"] += 1
            row["tokens"] += _num(session, "input_tokens") + _num(session, "output_tokens")
            row["cost_usd"] += _num(session, "estimated_cost_usd")
        return [
            {field: key, **values}
            for key, values in sorted(rows.items(), key=lambda kv: -kv[1]["requests"])
        ]

    return {"by_model": group("model"), "by_source": group("source")}


def _instant(value: Any) -> float | None:
    """Coerce a timestamp field to epoch seconds; non-numeric → None.

    hermes emits epoch floats, but rows are external input — a foreign shape
    (e.g. ISO strings) must degrade to None, never crash the aggregate."""
    return float(value) if isinstance(value, (int, float)) else None


def session_rows(sessions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Narrow-down rows for the Agent view — metadata + metrics only.

    Content fields (``preview``, system prompt flags…) are deliberately not
    forwarded; the observability surface carries no conversation text."""
    rows = []
    for session in sessions:
        started, touched = _instant(session.get("started_at")), _instant(session.get("last_active"))
        duration = (
            max(0.0, touched - started) if started is not None and touched is not None else 0.0
        )
        rows.append(
            {
                "id": session.get("id"),
                "title": session.get("title"),
                "model": session.get("model"),
                "source": session.get("source"),
                "started_at": started,
                "last_active": touched,
                "ended_at": _instant(session.get("ended_at")),
                "duration_s": duration,
                "requests": _num(session, "api_call_count"),
                "messages": _num(session, "message_count"),
                "tool_calls": _num(session, "tool_call_count"),
                "input_tokens": _num(session, "input_tokens"),
                "output_tokens": _num(session, "output_tokens"),
                "cache_read_tokens": _num(session, "cache_read_tokens"),
                "reasoning_tokens": _num(session, "reasoning_tokens"),
                "cost_usd": _num(session, "estimated_cost_usd"),
            }
        )
    rows.sort(key=lambda r: -(r["last_active"] if r["last_active"] is not None else 0.0))
    return rows


def ranking(per_agent: list[AgentSessions], *, now_s: float) -> list[dict[str, Any]]:
    """Fleet comparison rows (one per agent), sorted by requests desc."""
    rows = []
    for entry in per_agent:
        kpis = session_kpis(entry.sessions, now_s=now_s)
        rows.append(
            {
                "agent": entry.agent,
                "reachable": entry.reachable,
                "requests": kpis["requests"],
                "sessions": kpis["sessions"],
                "active_sessions": kpis["active_sessions"],
                "tokens": kpis["input_tokens"] + kpis["output_tokens"],
                "cost_usd": kpis["cost_usd"],
                "tool_calls": kpis["tool_calls"],
            }
        )
    rows.sort(key=lambda r: -r["requests"])
    return rows


# -- collection (S3) -------------------------------------------------------------


@dataclass(frozen=True)
class AgentSessions:
    agent: str
    reachable: bool
    sessions: list[dict[str, Any]]


async def collect_sessions(
    registry: Registry,
    client: httpx.AsyncClient,
    *,
    limit: int = SESSIONS_FETCH_LIMIT,
) -> list[AgentSessions]:
    """Fetch every agent's sessions in parallel; failures degrade per-agent."""

    async def fetch(name: str, api_port: int, key: str) -> AgentSessions:
        try:
            response = await client.get(
                f"http://127.0.0.1:{api_port}/api/sessions",
                params={"limit": limit},
                headers={"authorization": f"Bearer {key}"},
            )
            response.raise_for_status()
            data = response.json().get("data")
            rows = data if isinstance(data, list) else []
            sessions = [row for row in rows if isinstance(row, dict)]
            return AgentSessions(agent=name, reachable=True, sessions=sessions)
        except (httpx.HTTPError, ValueError):
            return AgentSessions(agent=name, reachable=False, sessions=[])

    records = registry.list()
    results = await asyncio.gather(
        *(fetch(r.spec.name, r.api_port, r.api_server_key) for r in records)
    )
    return list(results)
