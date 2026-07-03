"""Full-daemon ASGI flow with fake upstream/api_server/hermes (no marker — always runs).

Covers S1/S2/S3/S4 end to end inside one assembled app: create agent → status
→ LLM call through /v1 → chat relay → upstream hot swap → stop → remove.
"""

from __future__ import annotations

import contextlib
import time
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import CommandResult
from caduceus.core.types import CaduceusConfig, UpstreamConfig
from caduceus.daemon import Daemon, build_daemon
from tests.unit.fakes import FakeClock, InMemoryFileStore, ScriptedRunner
from tests.unit.test_process_manager import FakeHandle

CADUCEUS_HOME = Path("/home/u/.caduceus")
HERMES_HOME = Path("/home/u/.hermes")


class SpawnerForDaemon:
    def __init__(self) -> None:
        self.spawned: list[FakeHandle] = []

    async def spawn(self, argv: list[str], *, env: dict[str, str] | None = None) -> FakeHandle:
        handle = FakeHandle()
        self.spawned.append(handle)
        return handle


def upstream_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={"choices": [{"message": {"content": "pong"}}],
              "usage": {"prompt_tokens": 3, "completion_tokens": 1},
              "served_by": str(request.url.host)},
    )


def agent_api_handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path == "/health":
        return httpx.Response(200, json={"status": "ok"})
    if path == "/api/sessions" and request.method == "GET":
        # echo back the auth header so the test can assert key attachment
        return httpx.Response(
            200,
            json={"sessions": [], "auth_seen": request.headers.get("authorization", "")},
        )
    return httpx.Response(404, json={"error": "nope"})


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
        upstream=UpstreamConfig(base_url="http://upstream-a.test/v1", default_model="hermes")
    )
    config_store = CaduceusConfigStore(CADUCEUS_HOME / "config.yaml", files)
    config_store.save(config)

    daemon = build_daemon(
        config=config,
        config_store=config_store,
        caduceus_home=CADUCEUS_HOME,
        files=files,
        clock=FakeClock(),
        runner=runner,
        spawner=SpawnerForDaemon(),
        hermes_home=HERMES_HOME,
        upstream_transport=httpx.MockTransport(upstream_handler),
        agent_transport=httpx.MockTransport(agent_api_handler),
    )
    return daemon, files


def attach_lifespan(daemon: Daemon) -> FastAPI:
    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await daemon.startup()
        try:
            yield
        finally:
            await daemon.shutdown()

    daemon.app.router.lifespan_context = lifespan
    return daemon.app


def admin_headers(files: InMemoryFileStore) -> dict[str, str]:
    token = files.read_text(CADUCEUS_HOME / "admin.token").strip()
    return {"X-Caduceus-Token": token}


def wait_job(client: TestClient, headers: dict[str, str], job_id: str) -> dict:
    for _ in range(200):
        snapshot = client.get(f"/api/jobs/{job_id}", headers=headers).json()
        if snapshot["state"] in ("done", "failed"):
            return snapshot
        time.sleep(0.01)
    raise AssertionError("job did not settle")


def test_full_agent_lifecycle_through_the_daemon() -> None:
    daemon, files = make_daemon()
    app = attach_lifespan(daemon)

    with TestClient(app) as client:
        headers = admin_headers(files)

        # public vs protected surfaces
        assert client.get("/healthz").status_code == 200
        assert client.get("/api/agents").status_code == 401

        # S1: create agent
        response = client.post("/api/agents", json={"name": "coder"}, headers=headers)
        assert response.status_code == 202
        job = wait_job(client, headers, response.json()["job_id"])
        assert job["state"] == "done", job

        statuses = client.get("/api/agents", headers=headers).json()
        assert statuses[0]["name"] == "coder"
        assert statuses[0]["desired_state"] == "running"

        record = client.get("/api/agents/coder", headers=headers).json()["record"]
        assert "api_server_key" not in record  # S3
        assert "token_hash" not in record

        # F4: agent's LLM call through /v1 with its .env token
        env_text = files.read_text(HERMES_HOME / "profiles" / "cad-coder" / ".env")
        agent_token = next(
            line.split("=", 1)[1]
            for line in env_text.splitlines()
            if line.startswith("OPENAI_API_KEY=")
        )
        llm = client.post(
            "/v1/chat/completions",
            json={"model": "hermes", "messages": [{"role": "user", "content": "ping"}]},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert llm.status_code == 200
        assert llm.json()["served_by"] == "upstream-a.test"

        gateway = client.get("/api/gateway", headers=headers).json()
        assert gateway["traffic"]["totals"]["requests"] == 1
        assert gateway["traffic"]["agents"]["coder"]["input_tokens"] == 3

        # S2: chat relay attaches API_SERVER_KEY server-side
        sessions = client.get("/agents/coder/api/api/sessions", headers=headers)
        assert sessions.status_code == 200
        auth_seen = sessions.json()["auth_seen"]
        assert auth_seen.startswith("Bearer ")
        assert auth_seen != f"Bearer {agent_token}"  # api key ≠ gateway token
        # disallowed subpath 404s
        assert client.get("/agents/coder/api/api/config", headers=headers).status_code == 404

        # S4: upstream hot swap via API — no agent config change needed
        swap = client.put(
            "/api/gateway/upstream",
            json={"base_url": "http://upstream-b.test/v1", "default_model": "hermes-b"},
            headers=headers,
        )
        assert swap.status_code == 200
        llm2 = client.post(
            "/v1/chat/completions",
            json={"model": "hermes", "messages": [{"role": "user", "content": "ping"}]},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert llm2.json()["served_by"] == "upstream-b.test"

        # destructive ops guarded (A5)
        assert client.delete("/api/agents/coder", headers=headers).status_code == 400
        removal = client.delete(
            "/api/agents/coder", headers={**headers, "X-Confirm": "coder"}
        )
        assert removal.status_code == 202
        assert wait_job(client, headers, removal.json()["job_id"])["state"] == "done"
        assert client.get("/api/agents", headers=headers).json() == []
        # FD4: workspace survives removal
        assert str(CADUCEUS_HOME / "workspaces" / "coder") in files.dirs

        # rotated/removed token no longer accepted by the proxy (fail-closed)
        rejected = client.post(
            "/v1/chat/completions",
            json={"model": "hermes", "messages": []},
            headers={"Authorization": f"Bearer {agent_token}"},
        )
        assert rejected.status_code == 401


def test_events_websocket_replays_history() -> None:
    daemon, files = make_daemon()
    app = attach_lifespan(daemon)
    with TestClient(app) as client:
        headers = admin_headers(files)
        response = client.post("/api/agents", json={"name": "coder"}, headers=headers)
        wait_job(client, headers, response.json()["job_id"])

        token = files.read_text(CADUCEUS_HOME / "admin.token").strip()
        with client.websocket_connect(f"/api/events?token={token}") as ws:
            first = ws.receive_json()
            assert first["kind"].startswith("job.")  # replayed history

        # bad token → 4401 close (auth enforced on WS too)
        import pytest as _pytest

        with _pytest.raises(Exception), client.websocket_connect(  # noqa: B017
            "/api/events?token=wrong"
        ) as ws:
            ws.receive_json()


def test_soul_and_toolsets_editing_through_api() -> None:
    daemon, files = make_daemon()
    app = attach_lifespan(daemon)
    with TestClient(app) as client:
        headers = admin_headers(files)
        response = client.post("/api/agents", json={"name": "coder"}, headers=headers)
        wait_job(client, headers, response.json()["job_id"])

        assert client.put(
            "/api/agents/coder/soul", json={"content": "# be kind"}, headers=headers
        ).status_code == 204
        assert client.get("/api/agents/coder/soul", headers=headers).json() == {
            "content": "# be kind"
        }

        assert client.put(
            "/api/agents/coder/toolsets", json={"toolsets": ["hermes-cli"]}, headers=headers
        ).status_code == 204
        assert client.get("/api/agents/coder/toolsets", headers=headers).json() == {
            "toolsets": ["hermes-cli"]
        }

        assert client.post(
            "/api/agents/coder/token/rotate", headers=headers
        ).status_code == 204
