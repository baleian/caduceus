"""Reconciler alerts-snapshot properties (alert-ux FR-1, PBT extension).

For ANY sequence of orphan detections, after each completed cycle:
- active keys == exactly that cycle's detections (no stale carry-over),
- keys are unique,
- `since` is stable while a condition persists across consecutive cycles.
"""

from __future__ import annotations

import asyncio
from typing import Any

from hypothesis import given, settings
from hypothesis import strategies as st

from caduceus.control.reconciler import Reconciler
from caduceus.core.types import PROFILE_PREFIX


class TickingClock:
    def __init__(self) -> None:
        self._tick = 0

    def now_iso(self) -> str:
        self._tick += 1
        return f"2026-07-04T00:00:00.{self._tick:06d}Z"

    def monotonic(self) -> float:
        return float(self._tick)

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(0)


class EmptyRegistry:
    def list(self) -> list[Any]:
        return []  # no agents → dead-gateway/config-drift paths are no-ops


class OrphanHermes:
    def __init__(self) -> None:
        self.profiles: list[str] = []
        self.containers: list[str] = []

    def list_profiles(self) -> list[str]:
        return list(self.profiles)

    async def list_container_profiles(self) -> list[str]:
        return list(self.containers)


class NullSink:
    def emit(self, event: Any) -> None:
        return None


names = st.sets(st.sampled_from(["a", "b", "c", "d"]), max_size=4)


@settings(max_examples=50, deadline=None)
@given(cycles=st.lists(st.tuples(names, names), min_size=1, max_size=8))
def test_snapshot_matches_last_cycle_and_preserves_since(
    cycles: list[tuple[set[str], set[str]]],
) -> None:
    hermes = OrphanHermes()
    reconciler = Reconciler(
        EmptyRegistry(), None, hermes, None,  # type: ignore[arg-type]
        None, TickingClock(), NullSink(),  # type: ignore[arg-type]
        interval_s=30,
    )

    previous: dict[str, str] = {}
    for profile_names, container_names in cycles:
        hermes.profiles = [f"{PROFILE_PREFIX}{n}" for n in profile_names]
        hermes.containers = [f"{PROFILE_PREFIX}{n}" for n in container_names]
        asyncio.run(reconciler.reconcile_once())

        snapshot = reconciler.alerts_snapshot()
        alerts = {a["key"]: a for a in snapshot["alerts"]}
        expected = {f"orphan:profile:{PROFILE_PREFIX}{n}" for n in profile_names} | {
            f"orphan:container:{PROFILE_PREFIX}{n}" for n in container_names
        }
        assert set(alerts) == expected  # active == exactly this cycle's detections
        assert len(snapshot["alerts"]) == len(expected)  # key uniqueness
        assert snapshot["checked_at"] is not None
        for key, alert in alerts.items():
            if key in previous:  # persisted condition → since unchanged
                assert alert["since"] == previous[key]
        previous = {key: alert["since"] for key, alert in alerts.items()}
