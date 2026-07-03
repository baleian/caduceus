"""ApiClient contract tests over httpx.MockTransport (U3-TEST-2)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from caduceus.cli.client import ApiClient, ClientConfig, resolve_client_config
from caduceus.cli.errors import CliError, ExitCode

TOKEN = "a" * 64


def make_client(handler: Any) -> ApiClient:
    config = ClientConfig(base_url="http://test", admin_token=TOKEN, home=Path("/tmp/x"))
    return ApiClient(config, transport=httpx.MockTransport(handler), sleep=lambda _: None)


class Recorder:
    def __init__(self, responses: dict[str, Any] | None = None) -> None:
        self.requests: list[httpx.Request] = []
        self.responses = responses or {}

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = f"{request.method} {request.url.path}"
        entry = self.responses.get(key, (200, {}))
        status, body = entry
        return httpx.Response(status, json=body)


def test_every_request_carries_admin_bearer_token() -> None:
    rec = Recorder({"GET /api/agents": (200, [])})
    client = make_client(rec)
    client.list_agents()
    assert rec.requests[0].headers["authorization"] == f"Bearer {TOKEN}"


def test_remove_agent_sends_x_confirm_header() -> None:
    rec = Recorder({"DELETE /api/agents/bob": (202, {"job_id": "job-1"})})
    client = make_client(rec)
    assert client.remove_agent("bob") == "job-1"
    assert rec.requests[0].headers["x-confirm"] == "bob"


def test_create_agent_posts_spec_and_returns_job_id() -> None:
    rec = Recorder({"POST /api/agents": (202, {"job_id": "job-2"})})
    client = make_client(rec)
    job = client.create_agent({"name": "bob", "network_mode": "none"})
    assert job == "job-2"
    assert json.loads(rec.requests[0].content) == {"name": "bob", "network_mode": "none"}


def test_http_error_maps_to_cli_error() -> None:
    rec = Recorder({"GET /api/agents/ghost": (404, {"error": "agent 'ghost' not found"})})
    client = make_client(rec)
    with pytest.raises(CliError) as exc:
        client.get_agent("ghost")
    assert exc.value.exit_code == ExitCode.NOT_FOUND
    assert "ghost" in exc.value.message


def test_conflict_maps_to_refused() -> None:
    rec = Recorder({"POST /api/agents": (409, {"error": "agent 'bob' already exists"})})
    client = make_client(rec)
    with pytest.raises(CliError) as exc:
        client.create_agent({"name": "bob"})
    assert exc.value.exit_code == ExitCode.REFUSED


def test_wait_job_polls_until_terminal_state() -> None:
    states = iter(["queued", "running", "running", "done"])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "job-3", "state": next(states), "steps": []})

    client = make_client(handler)
    seen: list[str] = []
    final = client.wait_job("job-3", on_snapshot=lambda s: seen.append(s["state"]))
    assert final["state"] == "done"
    assert seen == ["queued", "running", "running", "done"]


def test_wait_job_returns_failed_snapshot() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"id": "j", "state": "failed", "error": "boom"})

    client = make_client(handler)
    assert client.wait_job("j")["state"] == "failed"


def test_skill_toggle_and_toolsets_bodies() -> None:
    rec = Recorder(
        {
            "PUT /api/agents/bob/skills/web": (204, None),
            "PUT /api/agents/bob/toolsets": (204, None),
        }
    )
    client = make_client(rec)
    client.set_skill("bob", "web", enabled=False)
    client.put_toolsets("bob", ["shell", "files"])
    assert json.loads(rec.requests[0].content) == {"enabled": False}
    assert json.loads(rec.requests[1].content) == {"toolsets": ["shell", "files"]}


def test_agent_api_relay_paths() -> None:
    rec = Recorder({"POST /agents/bob/api/v1/runs": (202, {"run_id": "r1"})})
    client = make_client(rec)
    data = client.agent_api("bob", "POST", "v1/runs", json={"input": "hi", "session_id": "s"})
    assert data == {"run_id": "r1"}
    assert rec.requests[0].url.path == "/agents/bob/api/v1/runs"


def test_agent_api_stream_error_raises_before_yield() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, json={"error": {"message": "Run not found", "code": "x"}})

    client = make_client(handler)
    with pytest.raises(CliError) as exc, client.agent_api_stream("bob", "GET", "v1/runs/r/events"):
        pass
    assert exc.value.exit_code == ExitCode.NOT_FOUND


# -- ClientConfig resolution (domain-entities §1) -------------------------------


def test_resolve_env_overrides_win(tmp_path: Path) -> None:
    config = resolve_client_config(
        home=tmp_path,
        env={"CADUCEUS_URL": "http://10.0.0.1:9999/", "CADUCEUS_ADMIN_TOKEN": "tok"},
    )
    assert config.base_url == "http://10.0.0.1:9999"
    assert config.admin_token == "tok"


def test_resolve_reads_config_yaml_and_token_file(tmp_path: Path) -> None:
    (tmp_path / "config.yaml").write_text(
        "listen: {host: 127.0.0.1, port: 5000}\n"
        "upstream: {base_url: http://up, default_model: m}\n"
    )
    (tmp_path / "admin.token").write_text("filetoken\n")
    config = resolve_client_config(home=tmp_path, env={})
    assert config.base_url == "http://127.0.0.1:5000"
    assert config.admin_token == "filetoken"


def test_resolve_without_token_raises_unreachable(tmp_path: Path) -> None:
    with pytest.raises(CliError) as exc:
        resolve_client_config(home=tmp_path, env={})
    assert exc.value.exit_code == ExitCode.UNREACHABLE
    assert exc.value.hint is not None
