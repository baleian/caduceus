"""PU3-2 (job render convergence) and PU3-4 (--json stdout purity)."""

from __future__ import annotations

import io
import json
from typing import Any

from hypothesis import given
from hypothesis import strategies as st
from rich.console import Console

from caduceus.cli.errors import ExitCode
from caduceus.cli.output import Renderer, job_exit_code, job_transitions

STEP_NAMES = ["workspace", "allocate", "profile", "config", "gateway"]


@st.composite
def job_snapshot_sequences(draw: Any) -> list[dict[str, Any]]:
    """Generate snapshot sequences only the U2 job state machine can produce:
    steps advance strictly in order; a failure freezes the rest as skipped."""
    n_steps = draw(st.integers(min_value=1, max_value=5))
    names = STEP_NAMES[:n_steps]
    fail_at = draw(st.one_of(st.none(), st.integers(min_value=0, max_value=n_steps - 1)))

    def snap(cursor: int, running: bool, failed: bool) -> dict[str, Any]:
        steps = []
        for i, name in enumerate(names):
            if failed and i == cursor:
                state = "failed"
            elif failed and i > cursor:
                state = "skipped"
            elif i < cursor:
                state = "ok"
            elif i == cursor and running:
                state = "running"
            else:
                state = "pending"
            steps.append({"name": name, "state": state})
        job_state = (
            "failed" if failed else ("done" if cursor >= n_steps else "running")
        )
        return {"id": "job-x", "state": job_state, "steps": steps,
                "error": "boom" if failed else None}

    sequence: list[dict[str, Any]] = [{"id": "job-x", "state": "queued",
                                       "steps": [{"name": n, "state": "pending"} for n in names],
                                       "error": None}]
    for cursor in range(n_steps):
        sequence.append(snap(cursor, running=True, failed=False))
        if fail_at == cursor:
            sequence.append(snap(cursor, running=False, failed=True))
            return sequence
        sequence.append(snap(cursor + 1, running=False, failed=False))
    return sequence


@given(job_snapshot_sequences())
def test_pu3_2_job_render_converges(sequence: list[dict[str, Any]]) -> None:
    """Any valid snapshot sequence renders without error, reaches a terminal
    line exactly once, and the exit code matches the final job state."""
    all_lines: list[str] = []
    prev: dict[str, Any] | None = None
    for snapshot in sequence:
        all_lines.extend(job_transitions(prev, snapshot))
        prev = snapshot

    final = sequence[-1]
    terminal_lines = [line for line in all_lines if line.startswith("job ")]
    assert terminal_lines == [f"job job-x: {final['state']}"]
    expected = ExitCode.OK if final["state"] == "done" else ExitCode.ERROR
    assert job_exit_code(final) == expected
    # every ok step was announced exactly once
    ok_steps = [s["name"] for s in final["steps"] if s["state"] == "ok"]
    for name in ok_steps:
        assert all_lines.count(f"✓ {name}") == 1


@given(job_snapshot_sequences())
def test_pu3_2_transitions_idempotent_on_repeat(sequence: list[dict[str, Any]]) -> None:
    """Re-observing the same snapshot (poll with no change) emits nothing."""
    for snapshot in sequence:
        assert job_transitions(snapshot, snapshot) == []


JSON_VALUES = st.recursive(
    st.one_of(st.none(), st.booleans(), st.integers(), st.text(max_size=30)),
    lambda children: st.one_of(
        st.lists(children, max_size=4),
        st.dictionaries(st.text(max_size=10), children, max_size=4),
    ),
    max_leaves=10,
)


@given(JSON_VALUES)
def test_pu3_4_json_stdout_is_a_single_document(value: Any) -> None:
    out_buf, err_buf = io.StringIO(), io.StringIO()
    renderer = Renderer(
        stdout=Console(file=out_buf, force_terminal=False, soft_wrap=True),
        stderr=Console(file=err_buf, stderr=True, force_terminal=False),
        json_mode=True,
    )
    renderer.progress("progress noise")  # must not touch stdout
    renderer.notice("notice noise")
    renderer.data_json(value)
    assert json.loads(out_buf.getvalue()) == value
    assert "noise" in err_buf.getvalue()


@given(st.text(alphabet="0123456789abcdef", min_size=32, max_size=40))
def test_renderer_redacts_secrets_on_every_path(secret: str) -> None:
    out_buf, err_buf = io.StringIO(), io.StringIO()
    renderer = Renderer(
        stdout=Console(file=out_buf, force_terminal=False, soft_wrap=True),
        stderr=Console(file=err_buf, stderr=True, force_terminal=False),
    )
    renderer.data_text(f"token {secret}")
    renderer.notice(f"token {secret}")
    renderer.data_table(["A"], [[f"token {secret}"]])
    assert secret not in out_buf.getvalue()
    assert secret not in err_buf.getvalue()
