"""Shared fake port implementations for unit/property tests (Hexagonal seam)."""

from __future__ import annotations

from pathlib import Path

from caduceus.core.ports import CommandResult
from caduceus.core.types import CoreEvent


class InMemoryFileStore:
    """FileStore fake: path → (content, mode). Atomicity is trivially true."""

    def __init__(self) -> None:
        self.files: dict[str, str] = {}
        self.modes: dict[str, int] = {}
        self.dirs: set[str] = set()

    def read_text(self, path: Path) -> str:
        try:
            return self.files[str(path)]
        except KeyError:
            raise FileNotFoundError(str(path)) from None

    def exists(self, path: Path) -> bool:
        return str(path) in self.files or str(path) in self.dirs

    def mkdir(self, path: Path, *, mode: int = 0o755) -> None:
        self.dirs.add(str(path))
        self.modes[str(path)] = mode

    def write_text_atomic(self, path: Path, content: str, *, mode: int = 0o644) -> None:
        self.files[str(path)] = content
        self.modes[str(path)] = mode

    def rename(self, src: Path, dst: Path) -> None:
        self.files[str(dst)] = self.files.pop(str(src))
        if str(src) in self.modes:
            self.modes[str(dst)] = self.modes.pop(str(src))

    def list_subdirs(self, path: Path) -> list[str]:
        prefix = str(path).rstrip("/") + "/"
        names = {
            d[len(prefix):].split("/", 1)[0]
            for d in self.dirs
            if d.startswith(prefix)
        }
        return sorted(names)


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.time = start
        self.sleeps: list[float] = []

    def now_iso(self) -> str:
        return "2026-07-02T00:00:00Z"

    def monotonic(self) -> float:
        return self.time

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.time += seconds


class RecordingEventSink:
    def __init__(self) -> None:
        self.events: list[CoreEvent] = []

    def emit(self, event: CoreEvent) -> None:
        self.events.append(event)


class ScriptedRunner:
    """CommandRunner fake: maps argv prefix to a scripted result; records calls."""

    def __init__(self, default: CommandResult | None = None) -> None:
        self.calls: list[list[str]] = []
        self.scripts: list[tuple[tuple[str, ...], CommandResult | Exception]] = []
        self.default = default or CommandResult(returncode=0, stdout="", stderr="")

    def on(self, *prefix: str, result: CommandResult | Exception) -> None:
        self.scripts.append((prefix, result))

    async def run(
        self,
        argv: list[str],
        *,
        timeout_s: float,  # noqa: ARG002
        env: dict[str, str] | None = None,  # noqa: ARG002
        cwd: str | None = None,  # noqa: ARG002
    ) -> CommandResult:
        self.calls.append(list(argv))
        for prefix, result in self.scripts:
            if tuple(argv[: len(prefix)]) == prefix:
                if isinstance(result, Exception):
                    raise result
                return result
        return self.default
