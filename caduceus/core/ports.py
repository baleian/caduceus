"""Effect ports (Hexagonal seam) + default real implementations.

Pure domain code depends on these protocols only; tests inject fakes so the
whole of U1's logic runs without hermes, docker or a real clock.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket
import tempfile
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Protocol, runtime_checkable

from caduceus.core.errors import SubprocessTimeoutError
from caduceus.core.types import CoreEvent


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


@runtime_checkable
class CommandRunner(Protocol):
    """Run a short-lived command to completion (argv arrays only — no shell)."""

    async def run(
        self,
        argv: list[str],
        *,
        timeout_s: float,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> CommandResult: ...


class ProcessHandle(Protocol):
    """A spawned long-running child process (hermes gateway)."""

    @property
    def pid(self) -> int: ...

    @property
    def returncode(self) -> int | None: ...

    async def wait(self) -> int: ...

    def terminate(self) -> None: ...

    def kill(self) -> None: ...

    def iter_output(self) -> AsyncIterator[str]:
        """Merged stdout+stderr lines."""
        ...


@runtime_checkable
class ProcessSpawner(Protocol):
    async def spawn(
        self,
        argv: list[str],
        *,
        env: dict[str, str] | None = None,
    ) -> ProcessHandle: ...


@runtime_checkable
class FileStore(Protocol):
    """Filesystem access; all registry/profile writes go through here."""

    def read_text(self, path: Path) -> str: ...

    def exists(self, path: Path) -> bool: ...

    def mkdir(self, path: Path, *, mode: int = 0o755) -> None: ...

    def chmod(self, path: Path, mode: int) -> None: ...

    def write_text_atomic(self, path: Path, content: str, *, mode: int = 0o644) -> None: ...

    def rename(self, src: Path, dst: Path) -> None: ...

    def list_subdirs(self, path: Path) -> list[str]: ...


@runtime_checkable
class Clock(Protocol):
    def now_iso(self) -> str: ...

    def monotonic(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


@runtime_checkable
class EventSink(Protocol):
    def emit(self, event: CoreEvent) -> None: ...


PortProbe = Callable[[int], bool]
"""Returns True when a TCP port is already in use on loopback."""


# --------------------------------------------------------------------------
# Real implementations
# --------------------------------------------------------------------------


class RealCommandRunner:
    async def run(
        self,
        argv: list[str],
        *,
        timeout_s: float,
        env: dict[str, str] | None = None,
        cwd: str | None = None,
    ) -> CommandResult:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, **env} if env else None,
            cwd=cwd,
        )
        try:
            out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
        except TimeoutError as exc:
            with contextlib.suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            raise SubprocessTimeoutError(
                f"command timed out after {timeout_s:.0f}s",
                detail=" ".join(argv[:4]),
            ) from exc
        return CommandResult(
            returncode=proc.returncode if proc.returncode is not None else -1,
            stdout=out.decode(errors="replace"),
            stderr=err.decode(errors="replace"),
        )


class RealProcessHandle:
    def __init__(self, proc: asyncio.subprocess.Process) -> None:
        self._proc = proc

    @property
    def pid(self) -> int:
        return self._proc.pid

    @property
    def returncode(self) -> int | None:
        return self._proc.returncode

    async def wait(self) -> int:
        return await self._proc.wait()

    def terminate(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.send_signal(signal.SIGTERM)

    def kill(self) -> None:
        with contextlib.suppress(ProcessLookupError):
            self._proc.kill()

    async def iter_output(self) -> AsyncIterator[str]:
        stdout = self._proc.stdout
        if stdout is None:  # pragma: no cover - spawn always pipes
            return
        while True:
            line = await stdout.readline()
            if not line:
                break
            yield line.decode(errors="replace").rstrip("\n")


class RealProcessSpawner:
    async def spawn(
        self,
        argv: list[str],
        *,
        env: dict[str, str] | None = None,
    ) -> RealProcessHandle:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, **env} if env else None,
        )
        return RealProcessHandle(proc)


class RealFileStore:
    def read_text(self, path: Path) -> str:
        return path.read_text(encoding="utf-8")

    def exists(self, path: Path) -> bool:
        return path.exists()

    def mkdir(self, path: Path, *, mode: int = 0o755) -> None:
        path.mkdir(mode=mode, parents=True, exist_ok=True)

    def chmod(self, path: Path, mode: int) -> None:
        os.chmod(path, mode)

    def write_text_atomic(self, path: Path, content: str, *, mode: int = 0o644) -> None:
        """tmp + fsync + os.replace — crash-safe atomic write (NFR pattern)."""
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(content)
                fh.flush()
                os.fsync(fh.fileno())
            os.chmod(tmp, mode)
            os.replace(tmp, path)
        except BaseException:
            with contextlib.suppress(OSError):
                tmp.unlink()
            raise

    def rename(self, src: Path, dst: Path) -> None:
        os.replace(src, dst)

    def list_subdirs(self, path: Path) -> list[str]:
        if not path.is_dir():
            return []
        return sorted(p.name for p in path.iterdir() if p.is_dir())


class RealClock:
    def now_iso(self) -> str:
        return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")

    def monotonic(self) -> float:
        import time

        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class NullEventSink:
    def emit(self, event: CoreEvent) -> None:  # noqa: ARG002
        return None


def loopback_port_in_use(port: int) -> bool:
    """Default PortProbe: True if something is listening on 127.0.0.1:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0
