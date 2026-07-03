"""ChatApp example tests over scripted SSE streams (U3-TEST-3)."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from rich.console import Console

from caduceus.cli.chat import ChatApp
from caduceus.cli.client import ApiClient, ClientConfig
from caduceus.cli.errors import CliError, ExitCode
from caduceus.cli.output import Renderer


def sse(*events: dict[str, Any]) -> bytes:
    return b"".join(f"data: {json.dumps(e)}\n\n".encode() for e in events)


class FakeDaemon:
    """MockTransport handler emulating the agent-proxy relay for one agent."""

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []
        self.stream = sse()
        self.requests: list[tuple[str, str, bytes]] = []
        self.created = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append((request.method, path, request.content))
        if path == "/agents/bob/api/api/sessions" and request.method == "GET":
            return httpx.Response(200, json={"object": "list", "data": self.sessions})
        if path == "/agents/bob/api/api/sessions" and request.method == "POST":
            self.created += 1
            return httpx.Response(201, json={"session": {"id": f"new-{self.created}"}})
        if path.endswith("/messages"):
            return httpx.Response(200, json={"object": "list", "data": self.messages})
        if path.startswith("/agents/bob/api/api/sessions/"):
            session_id = path.rsplit("/", 1)[-1]
            known = [s["id"] for s in self.sessions]
            if session_id in known:
                return httpx.Response(200, json={"session": {"id": session_id}})
            return httpx.Response(404, json={"error": {"message": "Session not found"}})
        if path == "/agents/bob/api/v1/runs":
            return httpx.Response(202, json={"run_id": "run-1", "status": "started"})
        if path.endswith("/events"):
            return httpx.Response(200, content=self.stream,
                                  headers={"content-type": "text/event-stream"})
        if path.endswith("/stop"):
            return httpx.Response(200, json={"run_id": "run-1", "status": "stopping"})
        if path.endswith("/approval"):
            return httpx.Response(200, json={"resolved": True})
        return httpx.Response(500, json={"error": "unexpected " + path})


@pytest.fixture()
def harness() -> tuple[FakeDaemon, ChatApp, io.StringIO, io.StringIO, list[str]]:
    daemon = FakeDaemon()
    client = ApiClient(
        ClientConfig(base_url="http://test", admin_token="t", home=Path("/tmp/x")),
        transport=httpx.MockTransport(daemon),
    )
    out_buf, err_buf = io.StringIO(), io.StringIO()
    renderer = Renderer(
        stdout=Console(file=out_buf, force_terminal=False, soft_wrap=True, width=200),
        stderr=Console(file=err_buf, stderr=True, force_terminal=False, width=200),
    )
    script: list[str] = []

    def input_fn(prompt: str) -> str:
        if not script:
            raise EOFError
        return script.pop(0)

    app = ChatApp(client, renderer, "bob", input_fn=input_fn)
    return daemon, app, out_buf, err_buf, script


def test_full_turn_renders_deltas_thinking_and_tools(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "message.delta", "delta": "Hel"},
        {"event": "message.delta", "delta": "lo"},
        {"event": "reasoning.available", "text": "pondering"},
        {"event": "tool.started", "tool": "shell", "preview": "ls -la"},
        {"event": "tool.completed", "tool": "shell", "duration": 0.2},
        {"event": "run.completed", "output": "Hello", "usage": {}},
    )
    script.extend(["hi there", "/exit"])
    code = app.run(new=True)
    out = out_buf.getvalue()
    assert code == ExitCode.OK
    assert "Hello" in out          # deltas joined in order
    assert "∴ pondering" in out    # thinking
    assert "⚙ shell ls -la" in out
    assert app.state == "idle"


def test_resume_passes_history_to_runs(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.sessions = [
        {"id": "old", "last_active": "2026-01-01"},
        {"id": "recent", "last_active": "2026-07-01"},
    ]
    daemon.messages = [
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": "earlier answer"},
        {"role": "tool", "content": "ignored"},
    ]
    daemon.stream = sse({"event": "run.completed", "output": "", "usage": {}})
    script.extend(["continue please", "/exit"])
    app.run()
    runs = [r for r in daemon.requests if r[1] == "/agents/bob/api/v1/runs"]
    assert len(runs) == 1
    body = json.loads(runs[0][2])
    assert body["session_id"] == "recent"  # most recent session resumed (Q4=A)
    assert body["conversation_history"] == [
        {"role": "user", "content": "earlier question"},
        {"role": "assistant", "content": "earlier answer"},
    ]
    assert "resumed" in err_buf.getvalue()


def test_explicit_session_id_missing_raises_not_found(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    with pytest.raises(CliError) as exc:
        app.resolve_session(session_id="ghost", new=False)
    assert exc.value.exit_code == ExitCode.NOT_FOUND


def test_interrupt_sends_stop_exactly_once(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    app.state = "streaming"
    app._interrupt("run-1")
    app._interrupt("run-1")  # second Ctrl+C while stopping
    stops = [r for r in daemon.requests if r[1].endswith("/stop")]
    assert len(stops) == 1
    assert app.state == "stopping"
    assert app.stops_sent_this_turn == 1


def test_approval_prompt_posts_choice_and_resumes(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "approval.request", "tool": "shell", "preview": "rm -rf /tmp/x",
         "choices": ["once", "session", "always", "deny"]},
        {"event": "message.delta", "delta": "done"},
        {"event": "run.completed", "output": "done", "usage": {}},
    )
    script.extend(["do it", "y", "/exit"])
    app.run(new=True)
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert len(approvals) == 1
    assert json.loads(approvals[0][2]) == {"choice": "once"}
    assert "approval requested" in err_buf.getvalue()
    assert "done" in out_buf.getvalue()


def test_invalid_approval_answer_denies(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "approval.request", "tool": "shell"},
        {"event": "run.completed", "output": "", "usage": {}},
    )
    script.extend(["go", "whatever", "/exit"])
    app.run(new=True)
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert json.loads(approvals[0][2]) == {"choice": "deny"}


def test_run_failed_renders_error_and_returns_to_idle(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse({"event": "run.failed", "error": "upstream exploded"})
    script.extend(["hi", "/exit"])
    code = app.run(new=True)
    assert code == ExitCode.OK  # chat itself exits cleanly (idle Ctrl+D later)
    assert "upstream exploded" in err_buf.getvalue()
    assert app.state == "idle"


def test_unknown_events_are_ignored(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "future.event", "mystery": True},
        {"not_even_event": 1},
        {"event": "run.completed", "output": "", "usage": {}},
    )
    script.extend(["hi", "/exit"])
    assert app.run(new=True) == ExitCode.OK


def test_no_session_destroying_calls_ever_made(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse({"event": "run.completed", "output": "", "usage": {}})
    script.extend(["hi", "/exit"])
    app.run(new=True)
    assert all(method != "DELETE" for method, _, _ in daemon.requests)  # PU3-5 (c)
