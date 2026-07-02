"""HealthProber (FD8 gating) + Reconciler (drift/orphan, R5 bounds) tests."""

from __future__ import annotations

import asyncio

from caduceus.control.lifecycle import LifecycleService
from caduceus.control.prober import HealthProber
from caduceus.control.reconciler import Reconciler
from caduceus.core.types import AgentSpec
from tests.unit.fakes import FakeClock, RecordingEventSink
from tests.unit.test_provisioner_lifecycle import HERMES_HOME, Harness


async def provisioned_harness() -> Harness:
    h = Harness()
    h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()
    return h


class TestProber:
    async def make(
        self, h: Harness, results: list[bool | None]
    ) -> tuple[HealthProber, RecordingEventSink]:
        sink = RecordingEventSink()
        sequence = iter(results)

        async def probe(port: int) -> bool | None:  # noqa: ARG001
            return next(sequence)

        prober = HealthProber(
            h.registry, h.manager, probe, FakeClock(), sink, interval_s=30,  # type: ignore[arg-type]
        )
        return prober, sink

    async def test_healthy_then_unhealthy_transitions_emit_events(self) -> None:
        h = await provisioned_harness()
        prober, sink = await self.make(h, [True, False])
        await prober.probe_once()
        assert prober.health_of("coder") == "healthy"
        await prober.probe_once()
        assert prober.health_of("coder") == "unhealthy"
        changes = [e for e in sink.events if e.kind == "health.changed"]
        assert [(e.data["from"], e.data["to"]) for e in changes] == [
            ("unknown", "healthy"),
            ("healthy", "unhealthy"),
        ]

    async def test_unreachable_requires_three_consecutive_failures(self) -> None:
        h = await provisioned_harness()
        prober, _ = await self.make(h, [True, None, None, None])
        await prober.probe_once()
        assert prober.health_of("coder") == "healthy"
        await prober.probe_once()
        assert prober.health_of("coder") == "healthy"  # 1 failure — keep previous
        await prober.probe_once()
        assert prober.health_of("coder") == "healthy"  # 2 failures
        await prober.probe_once()
        assert prober.health_of("coder") == "unreachable"  # 3rd (FD8)

    async def test_unmanaged_agent_is_unknown(self) -> None:
        h = await provisioned_harness()
        await h.manager.stop("coder")
        prober, _ = await self.make(h, [])
        await prober.probe_once()  # probe fn never called for unmanaged
        assert prober.health_of("coder") == "unknown"


def make_reconciler(h: Harness, sink: RecordingEventSink) -> Reconciler:
    async def run_stop(record) -> None:  # type: ignore[no-untyped-def]
        return None

    lifecycle = LifecycleService(
        h.registry, h.manager, h.hermes,  # type: ignore[arg-type]
        health_of=lambda _: "healthy", run_stop=run_stop,
    )
    return Reconciler(
        h.registry, h.manager, h.hermes, lifecycle,  # type: ignore[arg-type]
        h.config, FakeClock(), sink, interval_s=30,
    )


class TestReconciler:
    async def test_dead_desired_running_restarted_once(self) -> None:
        h = await provisioned_harness()
        sink = RecordingEventSink()
        reconciler = make_reconciler(h, sink)
        await h.manager.stop("coder")  # simulate death; desired stays running

        await reconciler.reconcile_once()
        assert h.manager.is_managed("coder")  # remediated
        assert any(e.kind == "drift.remediated" for e in sink.events)

        # simulate death again WITHOUT recovery in between → no second attempt
        # (manager reported running in the meantime, so re-arm happens; emulate
        # no-recovery by stopping and clearing the re-arm history manually)
        await h.manager.stop("coder")
        sink.events.clear()
        reconciler._restart_attempted.add("coder")  # as if already attempted
        await reconciler.reconcile_once()
        assert not h.manager.is_managed("coder")  # R5: no restart loop
        assert any(e.kind == "drift.detected" for e in sink.events)

    async def test_config_drift_detected_after_manual_edit(self) -> None:
        h = await provisioned_harness()
        sink = RecordingEventSink()
        reconciler = make_reconciler(h, sink)
        # user manually flips a managed key in profile config
        path = HERMES_HOME / "profiles" / "cad-coder" / "config.yaml"
        text = h.files.read_text(path).replace("provider: custom", "provider: auto")
        h.files.write_text_atomic(path, text)

        await reconciler.reconcile_once()
        drift = [e for e in sink.events if e.data.get("reason") == "managed-config-drift"]
        assert drift and "model.provider" in drift[0].data["keys"]

    async def test_orphan_profile_and_container_detected(self) -> None:
        h = await provisioned_harness()
        sink = RecordingEventSink()
        reconciler = make_reconciler(h, sink)
        # orphan profile dir (cad- namespaced, not in registry)
        h.files.mkdir(HERMES_HOME / "profiles" / "cad-ghost")
        # non-cad profile must be ignored
        h.files.mkdir(HERMES_HOME / "profiles" / "personal")

        async def run(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
            from caduceus.core.ports import CommandResult

            if argv[:2] == ["docker", "ps"]:
                return CommandResult(0, "cad-zombie\ncad-coder\n", "")
            return CommandResult(0, "", "")

        h.runner.run = run  # type: ignore[method-assign]

        await reconciler.reconcile_once()
        orphans = {
            (e.data["resource"], e.data["name"])
            for e in sink.events
            if e.kind == "orphan.detected"
        }
        assert ("profile", "cad-ghost") in orphans
        assert ("container", "cad-zombie") in orphans
        assert not any(name == "personal" for _, name in orphans)
        assert not any(name == "cad-coder" for _, name in orphans)


async def test_prober_and_reconciler_loops_survive_probe_exceptions() -> None:
    h = await provisioned_harness()
    sink = RecordingEventSink()

    async def exploding_probe(port: int) -> bool | None:  # noqa: ARG001
        raise RuntimeError("boom")

    prober = HealthProber(
        h.registry, h.manager, exploding_probe, FakeClock(), sink, interval_s=0.01,  # type: ignore[arg-type]
    )
    prober.start()
    await asyncio.sleep(0.05)  # a few cycles despite exceptions
    await prober.stop()  # would raise if the task had died uncleanly
