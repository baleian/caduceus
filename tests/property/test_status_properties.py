"""PU2-1 — status synthesis matches the FD §3.3 truth table (Oracle).

The expected values are hand-written from the functional-design table,
independent of the implementation, and every input combination is checked.
"""

from __future__ import annotations

import itertools

import pytest

from caduceus.control.lifecycle import synthesize_status

DESIRED = ["running", "stopped"]
PROCESS = ["starting", "running", "stopping", "exited", "crashlooping", "not-running"]
HEALTH = ["healthy", "unhealthy", "unreachable", "unknown"]
CONTAINER = ["running", "exited", "absent", "unknown"]


def expected_summary(desired: str, process: str, health: str) -> str:
    """Reference oracle transcribed from business-logic-model.md §3.3."""
    if desired == "running":
        if process == "crashlooping":
            return "crashlooping"
        if process == "running":
            if health == "healthy":
                return "ok"
            if health in ("unhealthy", "unreachable"):
                return "degraded"
            return "starting"  # health unknown → probe pending
        if process == "starting":
            return "starting"
        if process == "stopping":
            return "stopping"
        return "drift-start-needed"  # exited / not-running
    # desired == stopped
    if process in ("running", "starting"):
        return "drift-stop-needed"
    if process == "crashlooping":
        return "crashlooping"
    return "stopped"


@pytest.mark.parametrize(
    ("desired", "process", "health", "container"),
    list(itertools.product(DESIRED, PROCESS, HEALTH, CONTAINER)),
)
def test_pu2_1_synthesis_matches_truth_table(
    desired: str, process: str, health: str, container: str
) -> None:
    status = synthesize_status("coder", desired, process, health, container)  # type: ignore[arg-type]
    assert status.detail["summary"] == expected_summary(desired, process, health)
    # E3: inputs are passed through honestly, never coerced
    assert status.process == process
    assert status.health == health
    assert status.container == container
    assert status.desired_state == desired
