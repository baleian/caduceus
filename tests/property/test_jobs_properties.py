"""PU2-3 — Job state machine stateful PBT (Hypothesis RuleBasedStateMachine).

The real Job's guarded transitions are compared against a trivial reference
model on every rule (PBT-06: invariants checked after each command).
"""

from __future__ import annotations

from hypothesis import strategies as st
from hypothesis.stateful import RuleBasedStateMachine, invariant, precondition, rule

from caduceus.control.jobs import InvalidTransition, Job, JobStep

STEP_NAMES = ["validate", "workspace", "allocate", "profile-create", "config-apply"]


class JobMachine(RuleBasedStateMachine):
    def __init__(self) -> None:
        super().__init__()
        self.job = Job(
            id="job-test",
            kind="create",
            agent="coder",
            steps=[JobStep(name=n) for n in STEP_NAMES],
            created_at="2026-07-03T00:00:00Z",
        )
        # reference model
        self.model_state = "queued"
        self.model_done_steps = 0
        self.model_step_running = False

    @rule()
    def start(self) -> None:
        if self.model_state == "queued":
            self.job.start()
            self.model_state = "running"
        else:
            self._expect_invalid(self.job.start)

    @rule()
    def step_start(self) -> None:
        valid = (
            self.model_state == "running"
            and not self.model_step_running
            and self.model_done_steps < len(STEP_NAMES)
        )
        if valid:
            self.job.step_start()
            self.model_step_running = True
        else:
            self._expect_invalid(self.job.step_start)

    @rule()
    def step_ok(self) -> None:
        if self.model_state == "running" and self.model_step_running:
            self.job.step_ok()
            self.model_step_running = False
            self.model_done_steps += 1
        else:
            self._expect_invalid(self.job.step_ok)

    @rule(error=st.text(min_size=1, max_size=20))
    def step_fail(self, error: str) -> None:
        if self.model_state == "running" and self.model_step_running:
            self.job.step_fail(error)
            self.model_state = "failed"
            self.model_step_running = False
        else:
            self._expect_invalid(lambda: self.job.step_fail(error))

    @precondition(lambda self: True)
    @rule()
    def finish(self) -> None:
        valid = (
            self.model_state == "running"
            and not self.model_step_running
            and self.model_done_steps == len(STEP_NAMES)
        )
        if valid:
            self.job.finish()
            self.model_state = "done"
        else:
            self._expect_invalid(self.job.finish)

    @invariant()
    def states_agree(self) -> None:
        assert self.job.state == self.model_state
        ok_steps = sum(1 for s in self.job.steps if s.state == "ok")
        assert ok_steps == self.model_done_steps
        # terminal states never have running steps
        if self.job.state in ("done", "failed"):
            assert not any(s.state == "running" for s in self.job.steps)
        # failed job: everything after the failed step is skipped
        if self.job.state == "failed":
            seen_failed = False
            for step in self.job.steps:
                if step.state == "failed":
                    seen_failed = True
                elif seen_failed:
                    assert step.state == "skipped"

    @staticmethod
    def _expect_invalid(fn) -> None:  # type: ignore[no-untyped-def]
        try:
            fn()
        except InvalidTransition:
            return
        raise AssertionError("expected InvalidTransition")


TestJobStateMachine = JobMachine.TestCase
