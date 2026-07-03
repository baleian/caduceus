"""CLI ↔ daemon E2E over real HTTP (no marker — always runs).

A fake-backed daemon (fake hermes/docker/upstream, real U2 planes) is served by
uvicorn in a background thread; the CLI's real entry funnel `main(argv)` talks
to it through env-resolved connection config — exercising S1→S3 plus the chat
relay exactly as a user would (minus real hermes)."""

from __future__ import annotations

import io
import json
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from rich.console import Console

from caduceus.cli.chat import ChatApp
from caduceus.cli.client import ApiClient, resolve_client_config
from caduceus.cli.main import main
from caduceus.cli.output import Renderer
from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import CommandResult, RealClock
from caduceus.core.types import CaduceusConfig, UpstreamConfig
from caduceus.daemon import Daemon, build_daemon
from tests.integration.test_daemon_asgi import SpawnerForDaemon, attach_lifespan
from tests.unit.fakes import InMemoryFileStore, ScriptedRunner

CADUCEUS_HOME = Path("/home/u/.caduceus")
HERMES_HOME = Path("/home/u/.hermes")


def sse_bytes(*events: dict[str, Any]) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events)


def sse_response(payload: bytes) -> httpx.Response:
    """A *streamable* mock response — bytes content would be marked consumed."""

    async def agen() -> Any:
        yield payload

    return httpx.Response(
        200, content=agen(), headers={"content-type": "text/event-stream"}
    )


def agent_api_handler(request: httpx.Request) -> httpx.Response:
    """Fake hermes api_server behind the daemon's chat relay."""
    path, method = request.url.path, request.method
    if path == "/health":
        return httpx.Response(200, json={"status": "ok"})
    if path == "/api/sessions" and method == "GET":
        return httpx.Response(200, json={"object": "list", "data": []})
    if path == "/api/sessions" and method == "POST":
        return httpx.Response(201, json={"session": {"id": "sess-1"}})
    if path.endswith("/messages"):
        return httpx.Response(200, json={"object": "list", "data": []})
    if path == "/v1/runs" and method == "POST":
        return httpx.Response(202, json={"run_id": "run-9", "status": "started"})
    if path == "/v1/runs/run-9/events":
        return sse_response(
            sse_bytes(
                {"event": "message.delta", "delta": "streamed "},
                {"event": "message.delta", "delta": "pong"},
                {"event": "run.completed", "output": "streamed pong", "usage": {}},
            )
        )
    return httpx.Response(404, json={"error": {"message": f"nope {path}"}})


def make_daemon() -> tuple[Daemon, InMemoryFileStore]:
    files = InMemoryFileStore()
    files.mkdir(HERMES_HOME)
    runner = ScriptedRunner()

    async def run(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
        runner.calls.append(list(argv))
        if argv[:3] == ["hermes", "profile", "create"]:
            files.mkdir(HERMES_HOME / "profiles" / argv[3])
        if argv[:2] == ["hermes", "--version"]:
            return CommandResult(0, "hermes 1.0\n", "")
        if argv[:2] == ["docker", "version"]:
            return CommandResult(0, "27\n", "")
        return CommandResult(0, "", "")

    runner.run = run  # type: ignore[method-assign]

    config = CaduceusConfig(
        upstream=UpstreamConfig(base_url="http://upstream.test/v1", default_model="test-model")
    )
    config_store = CaduceusConfigStore(CADUCEUS_HOME / "config.yaml", files)
    config_store.save(config)
    daemon = build_daemon(
        config=config,
        config_store=config_store,
        caduceus_home=CADUCEUS_HOME,
        files=files,
        clock=RealClock(),  # real time: reconcile/probe loops stay idle
        runner=runner,
        spawner=SpawnerForDaemon(),
        hermes_home=HERMES_HOME,
        upstream_transport=httpx.MockTransport(
            lambda _: httpx.Response(200, json={"choices": [], "usage": {}})
        ),
        agent_transport=httpx.MockTransport(agent_api_handler),
    )
    return daemon, files


@pytest.fixture(scope="module")
def live_daemon() -> Iterator[tuple[str, str]]:
    daemon, files = make_daemon()
    app = attach_lifespan(daemon)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error", access_log=False)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline:
            raise AssertionError("uvicorn did not start")
        time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    token = files.read_text(CADUCEUS_HOME / "admin.token").strip()
    yield f"http://127.0.0.1:{port}", token
    server.should_exit = True
    thread.join(timeout=10)


@pytest.fixture()
def cli_env(live_daemon: tuple[str, str], monkeypatch: pytest.MonkeyPatch) -> tuple[str, str]:
    url, token = live_daemon
    monkeypatch.setenv("CADUCEUS_URL", url)
    monkeypatch.setenv("CADUCEUS_ADMIN_TOKEN", token)
    return url, token


def test_cli_full_lifecycle_over_real_http(
    cli_env: tuple[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    # create (waits on the real job engine)
    assert main(["agent", "create", "coder", "--network", "none"]) == 0
    capsys.readouterr()

    # ls --json: pure document, agent present and running
    assert main(["agent", "ls", "--json"]) == 0
    statuses = json.loads(capsys.readouterr().out)
    assert statuses[0]["name"] == "coder"
    assert statuses[0]["desired_state"] == "running"

    # status human view
    assert main(["agent", "status", "coder"]) == 0
    assert "coder" in capsys.readouterr().out

    # gateway status reflects config
    assert main(["gateway", "upstream", "get"]) == 0
    assert "upstream.test" in capsys.readouterr().out

    # remove with confirmation flag; job runs to completion
    assert main(["agent", "rm", "coder", "--yes"]) == 0
    capsys.readouterr()
    assert main(["agent", "ls", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == []


def test_cli_chat_streams_through_the_relay(cli_env: tuple[str, str]) -> None:
    # provision the agent the chat will target
    assert main(["agent", "create", "chatty", "--network", "none"]) == 0
    try:
        client = ApiClient(resolve_client_config())
        out_buf, err_buf = io.StringIO(), io.StringIO()
        renderer = Renderer(
            stdout=Console(file=out_buf, force_terminal=False, soft_wrap=True, width=200),
            stderr=Console(file=err_buf, stderr=True, force_terminal=False, width=200),
        )
        script = iter(["ping", "/exit"])
        chat = ChatApp(client, renderer, "chatty", input_fn=lambda _: next(script))
        assert chat.run(new=True) == 0
        assert "streamed pong" in out_buf.getvalue()
        assert "session sess-1 (new)" in err_buf.getvalue()
    finally:
        main(["agent", "rm", "chatty", "--yes"])


def test_cli_bad_token_exits_3(
    live_daemon: tuple[str, str],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    url, _ = live_daemon
    monkeypatch.setenv("CADUCEUS_URL", url)
    monkeypatch.setenv("CADUCEUS_ADMIN_TOKEN", "wrong-token")
    assert main(["agent", "ls"]) == 3
    assert "admin" in capsys.readouterr().err.lower()
