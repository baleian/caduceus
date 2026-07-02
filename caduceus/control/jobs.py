"""Provisioning job engine: guarded state machine + serial worker (PU2-3).

State machine (domain-entities.md): queued → running → done | failed.
Steps advance strictly in order; a failure freezes the remaining steps as
``skipped`` and fails the job. Invalid transitions raise — the guards are the
PBT surface (RuleBasedStateMachine compares against a trivial model).
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import secrets
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from caduceus.core.errors import CaduceusError, NotFoundError
from caduceus.core.hermes_adapter import redact
from caduceus.core.ports import Clock, EventSink
from caduceus.core.types import CoreEvent

logger = logging.getLogger(__name__)

JobState = Literal["queued", "running", "done", "failed"]
StepState = Literal["pending", "running", "ok", "failed", "skipped"]
JobKind = Literal["create", "remove"]

StepFn = Callable[[], Awaitable[None]]


class InvalidTransition(CaduceusError):
    """Job/step state machine guard violation."""


@dataclass
class JobStep:
    name: str
    state: StepState = "pending"


@dataclass
class Job:
    id: str
    kind: JobKind
    agent: str
    steps: list[JobStep]
    state: JobState = "queued"
    error: str | None = None
    created_at: str = ""
    finished_at: str | None = None
    _cursor: int = field(default=0, repr=False)

    # -- guarded transitions (PU2-3) ----------------------------------------

    def start(self) -> None:
        if self.state != "queued":
            raise InvalidTransition(f"cannot start job in state {self.state}")
        self.state = "running"

    def step_start(self) -> JobStep:
        self._require_running()
        if self._cursor >= len(self.steps):
            raise InvalidTransition("no pending steps left")
        step = self.steps[self._cursor]
        if step.state != "pending":
            raise InvalidTransition(f"step {step.name} is {step.state}, not pending")
        step.state = "running"
        return step

    def step_ok(self) -> None:
        self._require_running()
        step = self._current_running()
        step.state = "ok"
        self._cursor += 1

    def step_fail(self, error: str) -> None:
        self._require_running()
        step = self._current_running()
        step.state = "failed"
        for remaining in self.steps[self._cursor + 1:]:
            remaining.state = "skipped"
        self.state = "failed"
        self.error = error

    def finish(self) -> None:
        self._require_running()
        if self._cursor != len(self.steps):
            raise InvalidTransition("cannot finish: steps remain")
        self.state = "done"

    def _require_running(self) -> None:
        if self.state != "running":
            raise InvalidTransition(f"job is {self.state}, not running")

    def _current_running(self) -> JobStep:
        if self._cursor >= len(self.steps) or self.steps[self._cursor].state != "running":
            raise InvalidTransition("no step currently running")
        return self.steps[self._cursor]

    def snapshot(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "kind": self.kind,
            "agent": self.agent,
            "state": self.state,
            "error": self.error,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "steps": [{"name": s.name, "state": s.state} for s in self.steps],
        }


class JobEngine:
    """Single-worker serial execution (nfr pattern: serialized command queue)."""

    def __init__(self, events: EventSink, clock: Clock) -> None:
        self._events = events
        self._clock = clock
        self._jobs: dict[str, Job] = {}
        self._queue: asyncio.Queue[tuple[Job, Sequence[StepFn]]] = asyncio.Queue()
        self._worker: asyncio.Task[None] | None = None

    def start_worker(self) -> None:
        if self._worker is None:
            self._worker = asyncio.get_running_loop().create_task(self._run())

    async def stop_worker(self) -> None:
        if self._worker is not None:
            self._worker.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._worker
            self._worker = None

    def submit(
        self, kind: JobKind, agent: str, steps: Sequence[tuple[str, StepFn]]
    ) -> Job:
        job = Job(
            id=f"job-{secrets.token_hex(4)}",
            kind=kind,
            agent=agent,
            steps=[JobStep(name=name) for name, _ in steps],
            created_at=self._clock.now_iso(),
        )
        self._jobs[job.id] = job
        self._queue.put_nowait((job, [fn for _, fn in steps]))
        return job

    def get(self, job_id: str) -> Job:
        try:
            return self._jobs[job_id]
        except KeyError:
            raise NotFoundError(f"job {job_id!r} not found") from None

    def list(self) -> list[Job]:
        return [*self._jobs.values()]

    async def _run(self) -> None:
        while True:
            job, step_fns = await self._queue.get()
            try:
                await self._execute(job, step_fns)
            except Exception:  # noqa: BLE001 - worker must survive anything
                logger.exception("job worker error on %s", job.id)
            finally:
                self._queue.task_done()

    async def _execute(self, job: Job, step_fns: Sequence[StepFn]) -> None:
        job.start()
        for step_fn in step_fns:
            step = job.step_start()
            self._emit(job, "job.step", step=step.name, state="running")
            try:
                await step_fn()
            except Exception as exc:  # noqa: BLE001 - E4: fail job, no rollback
                job.step_fail(redact(str(exc)))
                job.finished_at = self._clock.now_iso()
                self._emit(job, "job.failed", step=step.name, error=job.error)
                return
            job.step_ok()
            self._emit(job, "job.step", step=step.name, state="ok")
        job.finish()
        job.finished_at = self._clock.now_iso()
        self._emit(job, "job.done")

    def _emit(self, job: Job, kind: str, **data: Any) -> None:
        self._events.emit(
            CoreEvent(
                kind=kind,
                agent=job.agent,
                data={"job_id": job.id, "kind": job.kind, **data},
                ts=self._clock.now_iso(),
            )
        )
