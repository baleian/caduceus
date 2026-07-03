"""Bootstrap commands that work without a running daemon (CLI-D3 scope).

``init`` — idempotent home/config/admin-token creation + interactive upstream
wizard + preflight summary. ``doctor`` — environment diagnosis; daemon-side
checks degrade to "skip" when the daemon is down. ``ui`` — browser opener with
a WSL-aware fallback chain. Plus the POSIX pid-file utilities used by
``serve -d`` (pattern P9).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from caduceus.cli.errors import CliError, ExitCode, map_exception
from caduceus.cli.output import Renderer
from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import FileStore, RealFileStore
from caduceus.core.tokens import ADMIN_TOKEN_FILE, load_or_create_admin_token
from caduceus.core.types import CaduceusConfig, UpstreamConfig

DEFAULT_UPSTREAM_URL = "https://api.openai.com/v1"
DEFAULT_UPSTREAM_MODEL = "gpt-4o"  # placeholder — the init wizard asks for the real one
DEFAULT_API_KEY_ENV = "OPENAI_API_KEY"

PID_FILE = "caduceusd.pid"
LOG_DIR = "logs"
LOG_FILE = "caduceusd.log"

CheckStatus = Literal["ok", "fail", "skip"]


@dataclass(frozen=True)
class CheckRow:
    name: str
    status: CheckStatus
    detail: str


# -- init (Q1=A, idempotent) -------------------------------------------------------


def ensure_initialized(home: Path, files: FileStore | None = None) -> list[str]:
    """Create home dir, default config and admin token if absent; returns what
    was created. Never overwrites existing files (idempotent)."""
    files = files or RealFileStore()
    created: list[str] = []
    if not files.exists(home):
        files.mkdir(home)
        created.append(str(home))
    store = CaduceusConfigStore(home / "config.yaml", files)
    if not store.exists():
        store.save(
            CaduceusConfig(
                upstream=UpstreamConfig(
                    base_url=DEFAULT_UPSTREAM_URL,
                    default_model=DEFAULT_UPSTREAM_MODEL,
                    api_key_env=DEFAULT_API_KEY_ENV,
                )
            )
        )
        created.append(str(store.path))
    if not files.exists(home / ADMIN_TOKEN_FILE):
        load_or_create_admin_token(home, files)
        created.append(str(home / ADMIN_TOKEN_FILE))
    return created


def run_init(
    renderer: Renderer,
    home: Path,
    *,
    files: FileStore | None = None,
    interactive: bool,
    input_fn: Callable[[str], str] = input,
    getenv: Callable[[str], str | None] = os.environ.get,
) -> ExitCode:
    files = files or RealFileStore()
    created = ensure_initialized(home, files)
    for path in created:
        renderer.progress(f"created {path}")
    if not created:
        renderer.progress(f"already initialized: {home}")

    store = CaduceusConfigStore(home / "config.yaml", files)
    config = store.load()
    if interactive:
        current = config.upstream
        base_url = input_fn(f"upstream base_url [{current.base_url}] › ").strip()
        default_model = input_fn(
            f"upstream default model [{current.default_model}] › "
        ).strip()
        api_key_env = input_fn(
            f"upstream api_key_env [{current.api_key_env or '-'}] "
            "('-' to clear for keyless local servers) › "
        ).strip()
        upstream = UpstreamConfig(
            base_url=base_url or current.base_url,
            default_model=default_model or current.default_model,
            api_key_env=None if api_key_env == "-" else (api_key_env or current.api_key_env),
            extra_headers=current.extra_headers,
        )
        if upstream != current:
            store.save(config.model_copy(update={"upstream": upstream}))
            renderer.progress("upstream configuration saved")
        config = store.load()

    key_env = config.upstream.api_key_env
    if key_env and getenv(key_env) is None:  # CLI-P4: presence only, value untouched
        renderer.warn(f"environment variable {key_env} is not set — the gateway "
                      "will fail to authenticate upstream")
    renderer.progress(f"listen: {config.listen.host}:{config.listen.port}  "
                      f"upstream: {config.upstream.base_url}")
    return ExitCode.OK


# -- doctor -------------------------------------------------------------------------


def doctor_rows(
    home: Path,
    *,
    files: FileStore,
    preflight_checks: list[tuple[str, bool, str]],
    daemon_probe: Callable[[], dict[str, object]],
    gateway_info: Callable[[], dict[str, object]],
    agent_count: Callable[[], int],
    getenv: Callable[[str], str | None] = os.environ.get,
) -> list[CheckRow]:
    rows: list[CheckRow] = [
        CheckRow(name, "ok" if ok else "fail", detail) for name, ok, detail in preflight_checks
    ]

    token_path = home / ADMIN_TOKEN_FILE
    if files.exists(token_path):
        mode = os.stat(token_path).st_mode & 0o777 if token_path.exists() else 0o600
        ok = mode == 0o600
        rows.append(CheckRow("caduceus-home", "ok" if ok else "fail",
                             str(home) if ok else f"{token_path} mode {oct(mode)} != 0600"))
    else:
        rows.append(CheckRow("caduceus-home", "fail",
                             f"{token_path} missing — run `caduceus init`"))

    try:
        version = daemon_probe().get("version", "?")
        rows.append(CheckRow("daemon", "ok", f"reachable (v{version})"))
        daemon_up = True
    except Exception as exc:  # noqa: BLE001 - any failure means unreachable
        rows.append(CheckRow("daemon", "skip", f"not running ({map_exception(exc).message})"))
        daemon_up = False

    if daemon_up:
        try:
            info = gateway_info()
            upstream = info.get("upstream", {})
            base_url = upstream.get("base_url") if isinstance(upstream, dict) else None
            key_env = upstream.get("api_key_env") if isinstance(upstream, dict) else None
            detail = str(base_url or "unset")
            ok = bool(base_url)
            if ok and isinstance(key_env, str) and key_env and getenv(key_env) is None:
                ok, detail = False, f"{detail} — env {key_env} not set"
            rows.append(CheckRow("upstream", "ok" if ok else "fail", detail))
        except Exception as exc:  # noqa: BLE001
            rows.append(CheckRow("upstream", "fail", map_exception(exc).message))
        try:
            rows.append(CheckRow("registry", "ok", f"{agent_count()} agent(s)"))
        except Exception as exc:  # noqa: BLE001
            rows.append(CheckRow("registry", "fail", map_exception(exc).message))
    else:
        rows.append(CheckRow("upstream", "skip", "daemon not running"))
        rows.append(CheckRow("registry", "skip", "daemon not running"))
    return rows


def render_doctor(renderer: Renderer, rows: list[CheckRow]) -> ExitCode:
    icons = {"ok": "✓", "fail": "✗", "skip": "-"}
    for row in rows:
        renderer.data_text(f"{icons[row.status]} {row.name}: {row.detail}")
    return ExitCode.ERROR if any(r.status == "fail" for r in rows) else ExitCode.OK


# -- ui ---------------------------------------------------------------------------


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower()
    except OSError:
        return False


def _gui_openers() -> list[list[str]]:
    """GUI-only opener commands, best first. Never the python ``webbrowser``
    module: with no GUI browser it falls back to console browsers (w3m/lynx),
    which take over the terminal and block — a blank hung screen (U4 fix)."""
    candidates: list[list[str]] = []
    if _is_wsl():
        for name in ("wslview", "explorer.exe"):
            path = shutil.which(name)
            if path:
                candidates.append([path])
    if sys.platform == "darwin":
        candidates.append(["open"])
    elif os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"):
        path = shutil.which("xdg-open")
        if path:
            candidates.append([path])
    return candidates


def open_ui(renderer: Renderer, url: str) -> ExitCode:
    """Open the web UI without ever blocking the terminal.

    The full URL — including the ``#token=`` fragment — is printed FIRST so
    the link is never hostage to a browser attempt and stays clickable even
    when an opener (e.g. explorer.exe) drops the fragment. Printing the
    admin token here is a **user-approved exception** to the redact gate
    (decision 2026-07-03): the token is hex, so ``data_text`` would mask the
    fragment; it is the operator's own credential in their own terminal —
    the same trust boundary as ``cat ~/.caduceus/admin.token``.
    """
    from rich.text import Text

    renderer.out.print(Text(url))  # deliberate bypass of the redact gate (see above)
    for argv in _gui_openers():
        try:
            subprocess.Popen(  # noqa: S603
                [*argv, url],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
            )
            renderer.progress(f"opening in browser via {Path(argv[0]).name}")
            return ExitCode.OK
        except OSError:
            continue
    renderer.progress(
        "no browser opener found — open the URL above yourself"
        " (the page will ask for the admin token: ~/.caduceus/admin.token)"
    )
    return ExitCode.OK


# -- pid utilities (P9) --------------------------------------------------------------


def pid_path(home: Path) -> Path:
    return home / PID_FILE


def log_path(home: Path) -> Path:
    return home / LOG_DIR / LOG_FILE


def pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def read_live_pid(home: Path) -> int | None:
    """Return the recorded pid if that process is alive; treat stale files as
    absent (they are reported and overwritten by the next `serve -d`)."""
    path = pid_path(home)
    try:
        pid = int(path.read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if pid_alive(pid) else None


def require_confirmation(
    renderer: Renderer,
    *,
    agent: str,
    yes: bool,
    is_tty: bool,
    input_fn: Callable[[str], str] = input,
) -> None:
    """rm confirmation gate (CLI-C1..C3). Raises CliError on refusal."""
    if yes:
        return
    if not is_tty:
        raise CliError(
            "refusing to remove without confirmation in non-interactive mode",
            ExitCode.USAGE,
            hint="pass --yes to confirm",
        )
    renderer.err.print(
        f"about to remove agent '{agent}': its profile and container will be deleted.\n"
        f"the workspace is preserved at ~/.caduceus/workspaces/{agent}"
    )
    try:
        answer = input_fn(f"type the agent name to confirm ({agent}) › ").strip()
    except (KeyboardInterrupt, EOFError):
        answer = ""
    if answer != agent:
        raise CliError("removal cancelled", ExitCode.REFUSED)
