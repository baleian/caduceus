"""GatewayProcessManager scenarios with fake processes (restart, crashloop, stop)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

import pytest

from caduceus.core.errors import ConflictError, NotFoundError
from caduceus.core.process_manager import (
    CRASHLOOP_THRESHOLD,
    GatewayProcessManager,
)
from tests.unit.fakes import FakeClock, RecordingEventSink


class FakeHandle:
    _next_pid = 100

    def __init__(self, exit_code: int | None = None, lines: list[str] | None = None) -> None:
        FakeHandle._next_pid += 1
        self._pid = FakeHandle._next_pid
        self._exit_future: asyncio.Future[int] = asyncio.get_event_loop().create_future()
        self._lines = lines or []
        self.terminated = False
        self.killed = False
        if exit_code is not None:
            self._exit_future.set_result(exit_code)

    @property
    def pid(self) -> int:
        return self._pid

    @property
    def returncode(self) -> int | None:
        return self._exit_future.result() if self._exit_future.done() else None

    def exit_now(self, code: int) -> None:
        if not self._exit_future.done():
            self._exit_future.set_result(code)

    async def wait(self) -> int:
        return await asyncio.shield(self._exit_future)

    def terminate(self) -> None:
        self.terminated = True
        self.exit_now(0)

    def kill(self) -> None:
        self.killed = True
        self.exit_now(-9)

    async def iter_output(self) -> AsyncIterator[str]:
        for line in self._lines:
            yield line
        # then stay open until the process exits
        await asyncio.shield(self._exit_future)


class FakeSpawner:
    def __init__(self) -> None:
        self.spawned: list[FakeHandle] = []
        self.argvs: list[list[str]] = []
        self.envs: list[dict[str, str] | None] = []

    async def spawn(self, argv: list[str], *, env: dict[str, str] | None = None) -> FakeHandle:
        self.argvs.append(list(argv))
        self.envs.append(env)
        handle = FakeHandle()
        self.spawned.append(handle)
        return handle


def make_manager() -> tuple[GatewayProcessManager, FakeSpawner, FakeClock, RecordingEventSink]:
    spawner = FakeSpawner()
    clock = FakeClock()
    sink = RecordingEventSink()
    return GatewayProcessManager(spawner, clock, sink), spawner, clock, sink


ARGV = ["hermes", "-p", "cad-coder", "gateway"]


async def drain() -> None:
    for _ in range(20):
        await asyncio.sleep(0)


async def test_start_spawns_and_reports_running() -> None:
    manager, spawner, _, sink = make_manager()
    await manager.start("coder", ARGV)
    info = manager.info("coder")
    assert info.state == "running"
    assert info.pid == spawner.spawned[0].pid
    assert spawner.argvs == [ARGV]
    assert any(e.kind == "process.state" for e in sink.events)
    await manager.shutdown()


async def test_start_injects_env_into_spawn() -> None:
    manager, spawner, _, _ = make_manager()
    env = {"TERMINAL_ENV": "docker", "TERMINAL_DOCKER_EXTRA_ARGS": '["--network=host"]'}
    await manager.start("coder", ARGV, env=env)
    assert spawner.envs == [env]
    await manager.shutdown()


async def test_restart_reuses_injected_env() -> None:
    manager, spawner, _, _ = make_manager()
    env = {"TERMINAL_ENV": "docker", "TERMINAL_DOCKER_EXTRA_ARGS": '["--network=host"]'}
    await manager.start("coder", ARGV, env=env)
    spawner.spawned[0].exit_now(1)
    await drain()
    # backoff-restart re-spawns via the same _spawn, so the stored env rides
    # along — a restarted gateway keeps its TERMINAL_* terminal config (FR-4).
    assert len(spawner.envs) == 2
    assert spawner.envs[1] == env
    await manager.shutdown()


async def test_double_start_conflicts() -> None:
    manager, _, _, _ = make_manager()
    await manager.start("coder", ARGV)
    with pytest.raises(ConflictError):
        await manager.start("coder", ARGV)
    await manager.shutdown()


async def test_crash_triggers_backoff_restart() -> None:
    manager, spawner, clock, sink = make_manager()
    await manager.start("coder", ARGV)
    spawner.spawned[0].exit_now(1)
    await drain()
    assert clock.sleeps == [1.0]  # first backoff
    assert len(spawner.spawned) == 2  # restarted
    assert manager.info("coder").restart_count == 1
    assert any(e.kind == "process.restarting" for e in sink.events)
    await manager.shutdown()


async def test_crashloop_stops_after_threshold() -> None:
    manager, spawner, clock, sink = make_manager()
    await manager.start("coder", ARGV)
    for _ in range(CRASHLOOP_THRESHOLD):
        spawner.spawned[-1].exit_now(1)
        await drain()
    assert manager.info("coder").state == "crashlooping"
    assert len(spawner.spawned) == CRASHLOOP_THRESHOLD  # no further respawn (L6)
    assert any(e.kind == "process.crashloop" for e in sink.events)
    await manager.shutdown()


async def test_stable_run_resets_restart_counter() -> None:
    manager, spawner, clock, _ = make_manager()
    await manager.start("coder", ARGV)
    spawner.spawned[0].exit_now(1)
    await drain()
    assert manager.info("coder").restart_count == 1
    clock.time += 600  # runs stably past BACKOFF_RESET_AFTER_S
    spawner.spawned[1].exit_now(1)
    await drain()
    assert manager.info("coder").restart_count == 1  # reset then +1
    await manager.shutdown()


async def test_stop_terminates_without_restart() -> None:
    manager, spawner, _, _ = make_manager()
    await manager.start("coder", ARGV)
    await manager.stop("coder")
    assert spawner.spawned[0].terminated
    assert len(spawner.spawned) == 1  # L2: no respawn after explicit stop
    assert not manager.is_managed("coder")
    with pytest.raises(NotFoundError):
        manager.info("coder")


async def test_shutdown_stops_all_children() -> None:
    manager, spawner, _, _ = make_manager()
    await manager.start("a", ARGV)
    await manager.start("b", ARGV)
    await manager.shutdown()
    assert all(h.terminated for h in spawner.spawned)  # L1
    assert not manager.is_managed("a")
    assert not manager.is_managed("b")
    with pytest.raises(ConflictError):
        await manager.start("c", ARGV)


async def test_log_lines_captured() -> None:
    manager, spawner, _, _ = make_manager()

    async def spawn_with_lines(argv: list[str], *, env: dict[str, str] | None = None) -> FakeHandle:
        handle = FakeHandle(lines=["gateway starting", "listening on 42800"])
        spawner.spawned.append(handle)
        return handle

    spawner.spawn = spawn_with_lines  # type: ignore[method-assign]
    await manager.start("coder", ARGV)
    await drain()
    assert manager.log_lines("coder") == ["gateway starting", "listening on 42800"]
    await manager.shutdown()
