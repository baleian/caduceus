"""Provisioner pipeline + LifecycleService tests over real core with fake ports."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from caduceus.control.jobs import JobEngine
from caduceus.control.lifecycle import LifecycleService
from caduceus.control.provisioner import Provisioner
from caduceus.core.errors import NotFoundError
from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import CommandResult
from caduceus.core.registry import Registry, RegistryStore
from caduceus.core.types import AgentSpec, CaduceusConfig, UpstreamConfig
from caduceus.core.workspace import WorkspaceManager
from tests.unit.fakes import FakeClock, InMemoryFileStore, RecordingEventSink, ScriptedRunner

HERMES_HOME = Path("/home/u/.hermes")
CADUCEUS_HOME = Path("/home/u/.caduceus")


class FakeManager:
    """Minimal GatewayProcessManager stand-in."""

    def __init__(self) -> None:
        self.started: list[tuple[str, list[str]]] = []
        self.stopped: list[str] = []
        self.managed: dict[str, str] = {}  # agent -> state

    async def start(self, agent: str, argv: list[str]) -> None:
        self.started.append((agent, argv))
        self.managed[agent] = "running"

    async def stop(self, agent: str) -> None:
        self.stopped.append(agent)
        self.managed.pop(agent, None)

    def is_managed(self, agent: str) -> bool:
        return agent in self.managed

    def info(self, agent: str):  # type: ignore[no-untyped-def]
        from caduceus.core.process_manager import ProcessInfo

        return ProcessInfo(
            agent=agent, state=self.managed[agent],  # type: ignore[arg-type]
            pid=1, restart_count=0, last_exit_code=None,
        )

    def log_lines(self, agent: str, *, last: int = 200) -> list[str]:  # noqa: ARG002
        return ["line1"]


class Harness:
    def __init__(self, *, healthy: bool = True) -> None:
        self.files = InMemoryFileStore()
        self.files.mkdir(HERMES_HOME)  # preflight hermes-home check
        self.clock = FakeClock()
        self.sink = RecordingEventSink()
        self.runner = ScriptedRunner()
        self._wire_runner()
        self.registry = Registry(
            RegistryStore(CADUCEUS_HOME / "registry.json", self.files, self.clock),
            port_in_use=lambda _: False,
        )
        self.hermes = HermesAdapter(self.runner, self.files, hermes_home=HERMES_HOME)
        self.workspaces = WorkspaceManager(CADUCEUS_HOME / "workspaces", self.files)
        self.manager = FakeManager()
        self.jobs = JobEngine(self.sink, self.clock)
        self.invalidations = 0
        self.healthy = healthy
        self.config = CaduceusConfig(
            upstream=UpstreamConfig(base_url="http://localhost:11434/v1", default_model="hermes")
        )

        async def health_check(port: int) -> bool:  # noqa: ARG001
            return self.healthy

        def invalidate() -> None:
            self.invalidations += 1

        self.provisioner = Provisioner(
            self.registry, self.hermes, self.workspaces, self.manager,  # type: ignore[arg-type]
            self.jobs, self.config, self.clock,
            health_check=health_check, invalidate_tokens=invalidate,
        )

    def _wire_runner(self) -> None:
        async def run(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
            self.runner.calls.append(list(argv))
            if argv[:3] == ["hermes", "profile", "create"]:
                self.files.mkdir(HERMES_HOME / "profiles" / argv[3])
            if argv[:2] == ["hermes", "--version"]:
                return CommandResult(0, "hermes 1.0\n", "")
            if argv[:2] == ["docker", "version"]:
                return CommandResult(0, "27.0\n", "")
            if argv[:2] == ["docker", "ps"]:
                return CommandResult(0, "", "")
            return CommandResult(0, "", "")

        self.runner.run = run  # type: ignore[method-assign]

    async def drain(self) -> None:
        self.jobs.start_worker()
        for _ in range(200):
            await asyncio.sleep(0)


async def test_create_pipeline_happy_path() -> None:
    h = Harness()
    job = h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()

    snap = h.jobs.get(job.id).snapshot()
    assert snap["state"] == "done", snap
    assert [s["state"] for s in snap["steps"]] == ["ok"] * 9

    record = h.registry.get("coder")
    assert record.profile_name == "cad-coder"
    assert record.desired_state == "running"
    assert record.api_port == 42800

    profile_dir = HERMES_HOME / "profiles" / "cad-coder"
    config_text = h.files.read_text(profile_dir / "config.yaml")
    assert "http://127.0.0.1:4285/v1" in config_text  # model routing → daemon
    assert "container_persistent: true" in config_text
    env_text = h.files.read_text(profile_dir / ".env")
    assert "API_SERVER_PORT=42800" in env_text
    assert "OPENAI_API_KEY=cad-coder-" in env_text

    assert h.manager.started and h.manager.started[0][0] == "coder"
    assert h.invalidations == 1  # token cache rebuilt after registry-add


async def test_create_fails_at_health_wait_leaves_record_no_rollback() -> None:
    h = Harness(healthy=False)
    job = h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()
    snap = h.jobs.get(job.id).snapshot()
    assert snap["state"] == "failed"
    assert snap["steps"][-1] == {"name": "health-wait", "state": "failed"}
    # E4: record exists (registry-add succeeded), nothing auto-deleted
    assert h.registry.get("coder").spec.name == "coder"
    assert h.files.exists(HERMES_HOME / "profiles" / "cad-coder")


async def test_create_duplicate_fails_in_validate_before_side_effects() -> None:
    h = Harness()
    h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()
    job2 = h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()
    snap = h.jobs.get(job2.id).snapshot()
    assert snap["state"] == "failed"
    assert snap["steps"][0] == {"name": "validate", "state": "failed"}
    assert all(s["state"] == "skipped" for s in snap["steps"][1:])


async def test_remove_pipeline_preserves_workspace_only() -> None:
    h = Harness()
    h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()
    workspace_path = str(CADUCEUS_HOME / "workspaces" / "coder")

    job = h.provisioner.remove_agent("coder")
    await h.drain()
    assert h.jobs.get(job.id).snapshot()["state"] == "done"

    with pytest.raises(NotFoundError):
        h.registry.get("coder")
    assert h.manager.stopped == ["coder"]
    # docker rm invoked via label filter
    assert any(c[:2] == ["docker", "ps"] for c in h.runner.calls)
    # hermes profile delete --yes invoked
    assert ["hermes", "profile", "delete", "cad-coder", "--yes"] in h.runner.calls
    # workspace dir untouched (L3)
    assert workspace_path in h.files.dirs


async def test_lifecycle_start_stop_and_status() -> None:
    h = Harness()
    h.provisioner.create_agent(AgentSpec(name="coder"))
    await h.drain()

    stops: list[str] = []

    async def run_stop(record) -> None:  # type: ignore[no-untyped-def]
        stops.append(record.spec.name)

    lifecycle = LifecycleService(
        h.registry, h.manager, h.hermes,  # type: ignore[arg-type]
        health_of=lambda _: "healthy", run_stop=run_stop,
    )
    statuses = await lifecycle.status()
    assert statuses[0].detail["summary"] == "ok"

    await lifecycle.stop("coder")
    assert stops == ["coder"]  # graceful run-stop attempted first
    assert h.registry.get("coder").desired_state == "stopped"
    statuses = await lifecycle.status("coder")
    assert statuses[0].detail["summary"] == "stopped"

    await lifecycle.start("coder")
    assert h.registry.get("coder").desired_state == "running"
    assert lifecycle.logs("coder") == ["line1"]
