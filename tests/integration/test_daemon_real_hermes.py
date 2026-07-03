"""Real-hermes daemon E2E (marker: integration).

Provisions a throwaway agent through the fully-real daemon (real hermes CLI,
real docker, real gateway child process), talks to its api_server through the
chat relay, then removes it. Requires hermes + docker on the host; executed in
the Build & Test phase, not in the default unit run.
"""

from __future__ import annotations

import contextlib
import shutil
import time
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import RealClock, RealCommandRunner, RealFileStore, RealProcessSpawner
from caduceus.core.types import CaduceusConfig, ListenConfig, UpstreamConfig
from caduceus.daemon import build_daemon

pytestmark = pytest.mark.integration

AGENT = "caduceus-e2e"


def requirements_met() -> bool:
    return shutil.which("hermes") is not None and shutil.which("docker") is not None


@pytest.fixture
def daemon_client(tmp_path: Path):  # type: ignore[no-untyped-def]
    if not requirements_met():
        pytest.skip("hermes + docker required")
    files = RealFileStore()
    home = tmp_path / "caduceus-home"
    config = CaduceusConfig(
        listen=ListenConfig(port=4299),
        upstream=UpstreamConfig(base_url="http://127.0.0.1:11434/v1", default_model="llama3"),
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

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await daemon.startup()
        try:
            yield
        finally:
            await daemon.shutdown()

    daemon.app.router.lifespan_context = lifespan
    token = None
    with TestClient(daemon.app) as client:
        token = files.read_text(home / "admin.token").strip()
        yield client, {"X-Caduceus-Token": token}


def wait_job(
    client: TestClient, headers: dict[str, str], job_id: str, timeout_s: float = 180
) -> dict:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        snapshot = client.get(f"/api/jobs/{job_id}", headers=headers).json()
        if snapshot["state"] in ("done", "failed"):
            return snapshot
        time.sleep(1)
    raise AssertionError("job did not settle in time")


def test_real_agent_provision_chat_remove(daemon_client) -> None:  # type: ignore[no-untyped-def]
    client, headers = daemon_client

    created = client.post("/api/agents", json={"name": AGENT}, headers=headers)
    assert created.status_code == 202
    job = wait_job(client, headers, created.json()["job_id"])
    try:
        assert job["state"] == "done", job

        # agent api_server reachable through the chat relay
        health = client.get(f"/agents/{AGENT}/api/health", headers=headers)
        assert health.status_code == 200

        statuses = client.get("/api/agents", headers=headers).json()
        assert statuses and statuses[0]["name"] == AGENT
    finally:
        removal = client.delete(
            f"/api/agents/{AGENT}", headers={**headers, "X-Confirm": AGENT}
        )
        if removal.status_code == 202:
            wait_job(client, headers, removal.json()["job_id"])
