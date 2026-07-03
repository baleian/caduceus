"""Full-surface contract tests through the real entry funnel `main(argv)`.

Covers: exit codes per path, --json stdout purity at the surface level,
X-Confirm plumbing, mutual exclusions, connection-refused guidance (CLI-E1).
"""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from caduceus.cli.client import ApiClient, ClientConfig
from caduceus.cli.context import AppState
from caduceus.cli.main import main


class AdminFake:
    """MockTransport handler for the admin REST surface."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.job_polls = 0
        self.job_state = "done"
        self.statuses = [
            {"name": "bob", "desired_state": "running", "process": "running",
             "health": "healthy", "container": "running", "detail": {"summary": "ok"}},
        ]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, method = request.url.path, request.method
        if path == "/api/agents" and method == "GET":
            return httpx.Response(200, json=self.statuses)
        if path == "/api/agents" and method == "POST":
            return httpx.Response(202, json={"job_id": "job-1"})
        if path == "/api/agents/bob" and method == "DELETE":
            return httpx.Response(202, json={"job_id": "job-2"})
        if path == "/api/agents/ghost":
            return httpx.Response(404, json={"error": "agent 'ghost' not found"})
        if path.startswith("/api/jobs/"):
            self.job_polls += 1
            done = self.job_state == "done"
            return httpx.Response(200, json={
                "id": path.rsplit("/", 1)[-1], "kind": "create", "agent": "bob",
                "state": self.job_state, "error": None if done else "boom",
                "steps": [{"name": "workspace", "state": "ok" if done else "failed"}],
            })
        if path == "/api/jobs":
            return httpx.Response(200, json=[{"id": "job-1", "kind": "create",
                                              "agent": "bob", "state": "done",
                                              "created_at": "t", "steps": []}])
        if path == "/api/agents/bob/soul" and method == "GET":
            return httpx.Response(200, json={"content": "# SOUL"})
        if path == "/api/agents/bob/token/rotate":
            return httpx.Response(204)
        if path == "/api/gateway/upstream" and method == "PUT":
            return httpx.Response(200, json={"base_url": json.loads(request.content)["base_url"]})
        if path == "/api/gateway":
            return httpx.Response(200, json={
                "listen": {"host": "127.0.0.1", "port": 4285},
                "upstream": {"base_url": "http://up", "api_key_env": "K",
                             "default_model": None},
                "traffic": {"agents": {"bob": {"requests": 3, "input_tokens": 10,
                                               "output_tokens": 20, "errors": 0}},
                            "totals": {}},
            })
        if path == "/api/agents/bob/logs":
            return httpx.Response(200, json={"lines": ["l1", "l2"]})
        return httpx.Response(500, json={"error": f"unhandled {method} {path}"})


@pytest.fixture()
def fake(monkeypatch: pytest.MonkeyPatch) -> AdminFake:
    handler = AdminFake()

    def patched_client(self: AppState) -> ApiClient:
        return ApiClient(
            ClientConfig(base_url="http://test", admin_token="t", home=Path("/tmp/x")),
            transport=httpx.MockTransport(handler),
            sleep=lambda _: None,
        )

    monkeypatch.setattr(AppState, "client", patched_client)
    return handler


def test_agent_ls_json_stdout_is_pure(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "ls", "--json"]) == 0
    captured = capsys.readouterr()
    assert json.loads(captured.out)[0]["name"] == "bob"


def test_agent_ls_human_table(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "ls"]) == 0
    out = capsys.readouterr().out
    assert "bob" in out and "healthy" in out


def test_not_found_maps_to_exit_4(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "status", "ghost"]) == 4
    err = capsys.readouterr().err
    assert "ghost" in err and "agent ls" in err  # CLI-E3 hint


def test_create_waits_and_succeeds(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "create", "bob"]) == 0
    assert fake.job_polls >= 1
    assert "✓ workspace" in capsys.readouterr().err  # progress on stderr


def test_create_failed_job_exits_1(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    fake.job_state = "failed"
    assert main(["agent", "create", "bob"]) == 1
    assert "boom" in capsys.readouterr().err


def test_create_no_wait_json(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "create", "bob", "--no-wait", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == {"job_id": "job-1"}
    assert fake.job_polls == 0


def test_rm_without_yes_non_tty_is_usage_error(fake: AdminFake) -> None:
    assert main(["agent", "rm", "bob"]) == 2
    assert not any(r.method == "DELETE" for r in fake.requests)  # nothing destructive ran


def test_rm_with_yes_sends_x_confirm(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "rm", "bob", "--yes"]) == 0
    delete = next(r for r in fake.requests if r.method == "DELETE")
    assert delete.headers["x-confirm"] == "bob"
    assert "workspace preserved" in capsys.readouterr().err  # CLI-C3/C4


def test_token_rotate_never_prints_a_token(
    fake: AdminFake, capsys: pytest.CaptureFixture[str]
) -> None:
    assert main(["agent", "token", "rotate", "bob"]) == 0
    captured = capsys.readouterr()
    assert "rotated" in captured.err
    assert "cad-" not in captured.out and "cad-" not in captured.err  # CLI-P1


def test_soul_prints_content(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "soul", "bob"]) == 0
    assert "# SOUL" in capsys.readouterr().out


def test_soul_edit_and_set_are_mutually_exclusive(fake: AdminFake) -> None:
    assert main(["agent", "soul", "bob", "--edit", "--set", "x"]) == 2


def test_skills_enable_disable_mutually_exclusive(fake: AdminFake) -> None:
    assert main(["agent", "skills", "bob", "--enable", "a", "--disable", "b"]) == 2


def test_toolsets_set_rejects_non_list_json(
    fake: AdminFake, tmp_path: Path
) -> None:
    bad = tmp_path / "t.json"
    bad.write_text('{"not": "a list"}')
    assert main(["agent", "toolsets", "bob", "--set", str(bad)]) == 2


def test_chat_session_and_new_mutually_exclusive(fake: AdminFake) -> None:
    assert main(["chat", "bob", "--session", "s", "--new"]) == 2


def test_gateway_status_human(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["gateway", "status"]) == 0
    out = capsys.readouterr().out
    assert "http://up" in out and "bob" in out


def test_gateway_upstream_set(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["gateway", "upstream", "set", "http://new-up"]) == 0
    assert "http://new-up" in capsys.readouterr().err


def test_job_ls_json(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["job", "ls", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)[0]["id"] == "job-1"


def test_logs_snapshot(fake: AdminFake, capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["agent", "logs", "bob"]) == 0
    out = capsys.readouterr().out
    assert "l1" in out and "l2" in out


def test_connection_refused_exits_3_with_serve_hint(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    def refusing_client(self: AppState) -> ApiClient:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        return ApiClient(
            ClientConfig(base_url="http://test", admin_token="t", home=Path("/tmp/x")),
            transport=httpx.MockTransport(handler),
        )

    monkeypatch.setattr(AppState, "client", refusing_client)
    assert main(["agent", "ls"]) == 3
    assert "caduceus serve" in capsys.readouterr().err  # CLI-E1


def test_unauthorized_exits_3(monkeypatch: pytest.MonkeyPatch,
                              capsys: pytest.CaptureFixture[str]) -> None:
    def denied_client(self: AppState) -> ApiClient:
        return ApiClient(
            ClientConfig(base_url="http://test", admin_token="t", home=Path("/tmp/x")),
            transport=httpx.MockTransport(
                lambda _: httpx.Response(401, json={"error": "unauthorized"})
            ),
        )

    monkeypatch.setattr(AppState, "client", denied_client)
    assert main(["agent", "ls"]) == 3
    assert "admin" in capsys.readouterr().err.lower()
