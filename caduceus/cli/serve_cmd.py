"""`caduceus serve` — run the daemon in-process (CLI-D2: the only module that
may import ``caduceus.daemon``, lazily, inside functions).

Foreground is the default; ``-d/--detach`` double-forks (POSIX only — CLI-D5),
verifies startup via ``/healthz`` (U3-REL-5) and reports the pid. ``serve stop``
sends a single SIGTERM and observes up to 15s (CLI-C6); ``serve status``
combines pid liveness with a health probe.
"""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

import httpx

from caduceus.cli.bootstrap import (
    ensure_initialized,
    log_path,
    pid_path,
    read_live_pid,
)
from caduceus.cli.errors import CliError, ExitCode
from caduceus.cli.output import Renderer

_HEALTH_WAIT_S = 10.0
_STOP_WAIT_S = 15.0


def _healthz_url(home: Path, host: str | None, port: int | None) -> str:
    from caduceus.core.config import CaduceusConfigStore
    from caduceus.core.ports import RealFileStore

    config = CaduceusConfigStore(home / "config.yaml", RealFileStore()).load()
    return f"http://{host or config.listen.host}:{port or config.listen.port}/healthz"


def _daemon_argv(home: Path, host: str | None, port: int | None) -> list[str]:
    argv = ["--home", str(home)]
    if host:
        argv += ["--host", host]
    if port:
        argv += ["--port", str(port)]
    return argv


def run_serve(
    renderer: Renderer,
    home: Path,
    *,
    host: str | None = None,
    port: int | None = None,
    detach: bool = False,
) -> ExitCode:
    ensure_initialized(home)
    live = read_live_pid(home)
    if live is not None:
        raise CliError(
            f"caduceusd already running (pid {live})",
            ExitCode.ERROR,
            hint="stop it with `caduceus serve stop`",
        )
    if not detach:
        from caduceus.daemon import main as daemon_main  # lazy (P4, CLI-D2)

        return ExitCode.OK if daemon_main(_daemon_argv(home, host, port)) == 0 else ExitCode.ERROR
    return _serve_detached(renderer, home, host, port)


def _serve_detached(
    renderer: Renderer, home: Path, host: str | None, port: int | None
) -> ExitCode:
    if os.name != "posix":  # pragma: no cover - CLI-D5 documented exception
        raise CliError("--detach is POSIX-only", ExitCode.USAGE)
    url = _healthz_url(home, host, port)
    log_file = log_path(home)
    log_file.parent.mkdir(parents=True, exist_ok=True)

    first = os.fork()
    if first == 0:  # pragma: no cover - runs in the forked child
        os.setsid()
        second = os.fork()
        if second > 0:
            os._exit(0)
        # grandchild: become the daemon
        with open(log_file, "ab") as log, open(os.devnull, "rb") as devnull:
            os.dup2(devnull.fileno(), 0)
            os.dup2(log.fileno(), 1)
            os.dup2(log.fileno(), 2)
        pid_path(home).write_text(f"{os.getpid()}\n")
        from caduceus.daemon import main as daemon_main  # lazy (CLI-D2)

        code = 1
        try:
            code = daemon_main(_daemon_argv(home, host, port))
        finally:
            try:
                pid_path(home).unlink(missing_ok=True)
            finally:
                os._exit(code)

    os.waitpid(first, 0)  # reap the intermediate child immediately

    # health-verified startup (U3-REL-5): silence here would hide a dead child
    deadline = time.monotonic() + _HEALTH_WAIT_S
    while time.monotonic() < deadline:
        try:
            if httpx.get(url, timeout=1.0).status_code == 200:
                pid = read_live_pid(home)
                renderer.progress(f"caduceusd running (pid {pid}) — logs: {log_file}")
                return ExitCode.OK
        except httpx.HTTPError:
            pass
        time.sleep(0.25)
    raise CliError(
        "daemon did not become healthy within 10s",
        ExitCode.ERROR,
        hint=f"inspect {log_file}",
    )


def run_serve_stop(renderer: Renderer, home: Path) -> ExitCode:
    pid = read_live_pid(home)
    if pid is None:
        renderer.progress("caduceusd is not running")
        return ExitCode.OK
    os.kill(pid, signal.SIGTERM)  # single graceful signal (CLI-C6)
    deadline = time.monotonic() + _STOP_WAIT_S
    while time.monotonic() < deadline:
        if read_live_pid(home) is None:
            renderer.progress(f"stopped (pid {pid})")
            return ExitCode.OK
        time.sleep(0.25)
    renderer.warn(
        f"pid {pid} still running after {int(_STOP_WAIT_S)}s — it may be draining; "
        "inspect and escalate manually if needed"
    )
    return ExitCode.ERROR


def run_serve_status(renderer: Renderer, home: Path) -> ExitCode:
    pid = read_live_pid(home)
    if pid is None:
        renderer.data_text("not running")
        return ExitCode.UNREACHABLE
    try:
        response = httpx.get(_healthz_url(home, None, None), timeout=2.0)
        healthy = response.status_code == 200
    except httpx.HTTPError:
        healthy = False
    renderer.data_text(f"running (pid {pid}, {'healthy' if healthy else 'unresponsive'})")
    return ExitCode.OK if healthy else ExitCode.ERROR


def is_tty() -> bool:
    return sys.stdin.isatty() and sys.stderr.isatty()
