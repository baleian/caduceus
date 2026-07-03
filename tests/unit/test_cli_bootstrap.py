"""bootstrap/serve_cmd example tests (init idempotency, doctor, pid, confirm)."""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Any

import pytest
from rich.console import Console

from caduceus.cli.bootstrap import (
    CheckRow,
    doctor_rows,
    ensure_initialized,
    read_live_pid,
    render_doctor,
    require_confirmation,
    run_init,
)
from caduceus.cli.errors import CliError, ExitCode
from caduceus.cli.output import Renderer
from caduceus.cli.serve_cmd import run_serve, run_serve_stop
from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import RealFileStore


def make_renderer() -> tuple[Renderer, io.StringIO, io.StringIO]:
    out_buf, err_buf = io.StringIO(), io.StringIO()
    renderer = Renderer(
        stdout=Console(file=out_buf, force_terminal=False, soft_wrap=True, width=200),
        stderr=Console(file=err_buf, stderr=True, force_terminal=False, width=200),
    )
    return renderer, out_buf, err_buf


# -- init ------------------------------------------------------------------------


def test_ensure_initialized_is_idempotent(tmp_path: Path) -> None:
    home = tmp_path / "home"
    first = ensure_initialized(home)
    assert len(first) == 3  # home, config.yaml, admin.token
    assert (home / "config.yaml").exists()
    assert oct((home / "admin.token").stat().st_mode & 0o777) == "0o600"
    assert ensure_initialized(home) == []  # second run touches nothing
    token_before = (home / "admin.token").read_text()
    ensure_initialized(home)
    assert (home / "admin.token").read_text() == token_before


def test_run_init_noninteractive_warns_on_missing_key_env(tmp_path: Path) -> None:
    renderer, out_buf, err_buf = make_renderer()
    code = run_init(renderer, tmp_path / "h", interactive=False, getenv=lambda _: None)
    assert code == ExitCode.OK
    assert "not set" in err_buf.getvalue()


def test_run_init_interactive_updates_upstream(tmp_path: Path) -> None:
    home = tmp_path / "h"
    renderer, out_buf, err_buf = make_renderer()
    answers = iter(["http://localhost:8000/v1", "my-model", "MY_KEY"])
    code = run_init(
        renderer, home, interactive=True,
        input_fn=lambda _: next(answers), getenv=lambda _: "present",
    )
    assert code == ExitCode.OK
    config = CaduceusConfigStore(home / "config.yaml", RealFileStore()).load()
    assert config.upstream.base_url == "http://localhost:8000/v1"
    assert config.upstream.api_key_env == "MY_KEY"


def test_run_init_interactive_keeps_defaults_on_empty_input(tmp_path: Path) -> None:
    home = tmp_path / "h"
    renderer, _, _ = make_renderer()
    run_init(renderer, home, interactive=True,
             input_fn=lambda _: "", getenv=lambda _: "present")
    config = CaduceusConfigStore(home / "config.yaml", RealFileStore()).load()
    assert config.upstream.base_url == "https://api.openai.com/v1"


# -- doctor ---------------------------------------------------------------------


def _daemon_up() -> dict[str, Any]:
    return {"status": "ok", "version": "0.1.0"}


def _daemon_down() -> dict[str, Any]:
    import httpx

    raise httpx.ConnectError("refused")


def test_doctor_all_green(tmp_path: Path) -> None:
    ensure_initialized(tmp_path)
    rows = doctor_rows(
        tmp_path,
        files=RealFileStore(),
        preflight_checks=[("hermes-cli", True, "1.0"), ("docker-daemon", True, "27")],
        daemon_probe=_daemon_up,
        gateway_info=lambda: {"upstream": {"base_url": "http://up", "api_key_env": "K"}},
        agent_count=lambda: 2,
        getenv=lambda _: "set",
    )
    assert all(r.status == "ok" for r in rows)
    renderer, out_buf, _ = make_renderer()
    assert render_doctor(renderer, rows) == ExitCode.OK
    assert "✓ daemon" in out_buf.getvalue()


def test_doctor_daemon_down_skips_remote_checks(tmp_path: Path) -> None:
    ensure_initialized(tmp_path)
    rows = doctor_rows(
        tmp_path,
        files=RealFileStore(),
        preflight_checks=[("hermes-cli", True, "1.0")],
        daemon_probe=_daemon_down,
        gateway_info=lambda: {},
        agent_count=lambda: 0,
    )
    by_name = {r.name: r.status for r in rows}
    assert by_name["daemon"] == "skip"
    assert by_name["upstream"] == "skip"
    assert by_name["registry"] == "skip"
    renderer, _, _ = make_renderer()
    assert render_doctor(renderer, rows) == ExitCode.OK  # skips are not failures


def test_doctor_missing_key_env_fails_upstream(tmp_path: Path) -> None:
    ensure_initialized(tmp_path)
    rows = doctor_rows(
        tmp_path,
        files=RealFileStore(),
        preflight_checks=[],
        daemon_probe=_daemon_up,
        gateway_info=lambda: {"upstream": {"base_url": "http://up", "api_key_env": "NOPE"}},
        agent_count=lambda: 0,
        getenv=lambda _: None,
    )
    upstream = next(r for r in rows if r.name == "upstream")
    assert upstream.status == "fail"
    renderer, _, _ = make_renderer()
    assert render_doctor(renderer, rows) == ExitCode.ERROR


def test_doctor_missing_token_fails_home_check(tmp_path: Path) -> None:
    rows = doctor_rows(
        tmp_path,
        files=RealFileStore(),
        preflight_checks=[],
        daemon_probe=_daemon_down,
        gateway_info=lambda: {},
        agent_count=lambda: 0,
    )
    home_row = next(r for r in rows if r.name == "caduceus-home")
    assert home_row.status == "fail"


def test_render_doctor_row_shape() -> None:
    renderer, out_buf, _ = make_renderer()
    render_doctor(renderer, [CheckRow("x", "skip", "why")])
    assert "- x: why" in out_buf.getvalue()


# -- pid / serve guards ------------------------------------------------------------


def test_read_live_pid_absent_and_stale(tmp_path: Path) -> None:
    assert read_live_pid(tmp_path) is None
    (tmp_path / "caduceusd.pid").write_text("not-a-pid")
    assert read_live_pid(tmp_path) is None
    # a forked-and-exited child is a guaranteed-dead pid
    pid = os.fork()
    if pid == 0:
        os._exit(0)
    os.waitpid(pid, 0)
    (tmp_path / "caduceusd.pid").write_text(str(pid))
    assert read_live_pid(tmp_path) is None  # stale → treated as absent


def test_read_live_pid_alive(tmp_path: Path) -> None:
    (tmp_path / "caduceusd.pid").write_text(str(os.getpid()))
    assert read_live_pid(tmp_path) == os.getpid()


def test_serve_refuses_when_already_running(tmp_path: Path) -> None:
    (tmp_path / "caduceusd.pid").write_text(str(os.getpid()))
    renderer, _, _ = make_renderer()
    with pytest.raises(CliError) as exc:
        run_serve(renderer, tmp_path)
    assert "already running" in exc.value.message


def test_serve_stop_when_not_running_is_ok(tmp_path: Path) -> None:
    renderer, _, err_buf = make_renderer()
    assert run_serve_stop(renderer, tmp_path) == ExitCode.OK
    assert "not running" in err_buf.getvalue()


# -- rm confirmation (CLI-C1..C3) ----------------------------------------------------


def test_confirmation_yes_bypasses_prompt() -> None:
    renderer, _, _ = make_renderer()
    require_confirmation(renderer, agent="bob", yes=True, is_tty=False)  # no raise


def test_confirmation_non_tty_without_yes_is_usage_error() -> None:
    renderer, _, _ = make_renderer()
    with pytest.raises(CliError) as exc:
        require_confirmation(renderer, agent="bob", yes=False, is_tty=False)
    assert exc.value.exit_code == ExitCode.USAGE


def test_confirmation_requires_exact_name() -> None:
    renderer, _, err_buf = make_renderer()
    with pytest.raises(CliError) as exc:
        require_confirmation(
            renderer, agent="bob", yes=False, is_tty=True, input_fn=lambda _: "nope"
        )
    assert exc.value.exit_code == ExitCode.REFUSED
    assert "workspace is preserved" in err_buf.getvalue()  # CLI-C3


def test_confirmation_accepts_exact_name() -> None:
    renderer, _, _ = make_renderer()
    require_confirmation(
        renderer, agent="bob", yes=False, is_tty=True, input_fn=lambda _: "bob"
    )
