"""Real-hermes CLI E2E (marker: integration — Build & Test phase).

Serves a fully-real daemon (real hermes/docker/spawner) on a loopback port and
drives it through the CLI entry funnel: create → ls → status → rm --yes.
Requires hermes + docker on the host."""

from __future__ import annotations

import json
import shutil
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import uvicorn

from caduceus.cli.main import main
from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import RealClock, RealCommandRunner, RealFileStore, RealProcessSpawner
from caduceus.core.types import CaduceusConfig, UpstreamConfig
from caduceus.daemon import build_daemon
from tests.integration.test_daemon_asgi import attach_lifespan

pytestmark = pytest.mark.integration

AGENT = "caduceus-cli-e2e"


@pytest.fixture()
def real_cli_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Iterator[Path]:
    if shutil.which("hermes") is None or shutil.which("docker") is None:
        pytest.skip("hermes + docker required")
    files = RealFileStore()
    home = tmp_path / "caduceus-home"
    config = CaduceusConfig(
        upstream=UpstreamConfig(base_url="http://127.0.0.1:11434/v1", default_model="llama3")
    )
    config_store = CaduceusConfigStore(home / "config.yaml", files)
    config_store.save(config)
    daemon = build_daemon(
        config=config,
        config_store=config_store,
        caduceus_home=home,
        files=files,
        clock=RealClock(),
        runner=RealCommandRunner(),
        spawner=RealProcessSpawner(),
        hermes_home=Path.home() / ".hermes",
    )
    app = attach_lifespan(daemon)
    server = uvicorn.Server(
        uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error", access_log=False)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 15
    while not server.started:
        if time.monotonic() > deadline:
            raise AssertionError("uvicorn did not start")
        time.sleep(0.05)
    port = server.servers[0].sockets[0].getsockname()[1]
    monkeypatch.setenv("CADUCEUS_URL", f"http://127.0.0.1:{port}")
    monkeypatch.setenv(
        "CADUCEUS_ADMIN_TOKEN", (home / "admin.token").read_text().strip()
    )
    yield home
    server.should_exit = True
    thread.join(timeout=15)


def test_cli_lifecycle_against_real_hermes(
    real_cli_env: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["agent", "create", AGENT]) == 0
    capsys.readouterr()
    try:
        assert main(["agent", "ls", "--json"]) == 0
        statuses = json.loads(capsys.readouterr().out)
        assert any(s["name"] == AGENT for s in statuses)

        assert main(["agent", "logs", AGENT, "-n", "5"]) == 0
        capsys.readouterr()
    finally:
        assert main(["agent", "rm", AGENT, "--yes"]) == 0
