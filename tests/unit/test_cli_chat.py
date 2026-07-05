"""ChatApp example tests over scripted named-SSE streams (U3-TEST-3).

The turn runs on ``POST {agent}/api/api/sessions/{id}/chat/stream`` whose SSE
uses NAMED events (the ``event:`` line); the ``run_id`` arrives in
``run.started`` and stop/approval reuse ``/v1/runs/{run_id}/...``.
"""

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
    """Named-SSE frames: the event name is the ``event:`` line (sessions
    chat/stream contract), the JSON payload is the ``data:`` line."""
    return b"".join(
        f"event: {e.get('event', 'message')}\ndata: {json.dumps(e)}\n\n".encode()
        for e in events
    )


class FakeDaemon:
    """MockTransport handler emulating the agent-proxy relay for one agent."""

    def __init__(self) -> None:
        self.sessions: list[dict[str, Any]] = []
        self.messages: list[dict[str, Any]] = []
        # optional: one messages payload per successive GET
        self.messages_queue: list[list[dict[str, Any]]] = []
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
        if path.endswith("/chat/stream") and request.method == "POST":
            return httpx.Response(200, content=self.stream,
                                  headers={"content-type": "text/event-stream"})
        if path.endswith("/messages"):
            data = self.messages_queue.pop(0) if self.messages_queue else self.messages
            return httpx.Response(200, json={"object": "list", "data": data})
        if path.startswith("/agents/bob/api/api/sessions/"):
            session_id = path.rsplit("/", 1)[-1]
            known = [s["id"] for s in self.sessions]
            if session_id in known:
                return httpx.Response(200, json={"session": {"id": session_id}})
            return httpx.Response(404, json={"error": {"message": "Session not found"}})
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


def test_full_turn_renders_deltas_and_tools(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "assistant.delta", "delta": "Hel"},
        {"event": "assistant.delta", "delta": "lo"},
        {"event": "tool.progress", "tool_name": "_thinking", "delta": "pondering"},
        {"event": "tool.started", "tool_name": "shell", "preview": "ls -la"},
        {"event": "tool.completed", "tool_name": "shell"},
        {"event": "assistant.completed", "content": "Hello"},
    )
    script.extend(["hi there", "/exit"])
    code = app.run(new=True)
    out = out_buf.getvalue()
    assert code == ExitCode.OK
    assert "Hello" in out            # deltas joined in order
    assert out.count("Hello") == 1   # assistant.completed does NOT re-echo the streamed reply
    assert "pondering" not in out    # reasoning suppressed (Q1=B3)
    assert "∴" not in out
    assert "⚙ shell ls -la" in out
    assert "✓ shell" in out
    assert app.state == "idle"


def test_reasoning_is_not_rendered(harness: Any) -> None:
    """Q1=B3 — sessions reasoning (tool.progress{_thinking}) is suppressed: it
    arrives after content and the console cannot re-order it intuitively."""
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "assistant.delta", "delta": "answer"},
        {"event": "tool.progress", "tool_name": "_thinking", "delta": "secret thoughts"},
        {"event": "assistant.completed", "content": "answer"},
    )
    script.extend(["hi", "/exit"])
    app.run(new=True)
    out = out_buf.getvalue()
    assert "answer" in out
    assert out.count("answer") == 1  # no re-echo via assistant.completed
    assert "secret thoughts" not in out
    assert "∴" not in out


def test_assistant_completed_content_rendered_when_no_deltas(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "assistant.completed", "content": "non-streaming reply"},
    )
    script.extend(["hi", "/exit"])
    app.run(new=True)
    assert "non-streaming reply" in out_buf.getvalue()


def test_failed_tool_detail_from_run_completed_transcript(harness: Any) -> None:
    """The tool.* events omit results — run.completed carries THIS turn's
    role=tool messages (content), paired with the streamed completions to show
    WHY a tool failed. Only this turn's tools appear, so prior turns can't leak."""
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "tool.started", "tool_name": "terminal", "preview": "cowsay hi"},
        {"event": "tool.failed", "tool_name": "terminal"},
        {"event": "tool.started", "tool_name": "terminal", "preview": "ls"},
        {"event": "tool.completed", "tool_name": "terminal"},
        {"event": "assistant.delta", "delta": "설치가 필요합니다."},
        {"event": "assistant.completed", "content": "설치가 필요합니다."},
        {"event": "run.completed", "usage": {}, "messages": [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "1"}]},
            {"role": "tool", "tool_name": "terminal",
             "content": '{"output": "bash: line 3: cowsay: command not found",'
                        ' "exit_code": 127, "error": null}'},
            {"role": "tool", "tool_name": "terminal",
             "content": '{"output": "a.txt", "exit_code": 0}'},
            {"role": "assistant", "content": "설치가 필요합니다."},
        ]},
    )
    script.extend(["cowsay 해봐", "/exit"])
    app.run(new=True)
    out = out_buf.getvalue()
    assert "✗ terminal cowsay hi" in out
    assert "└ exit 127 · bash: line 3: cowsay: command not found" in out
    assert out.count("└") == 1  # the succeeded call gets no annotation


def test_failure_detail_skipped_on_pairing_mismatch(harness: Any) -> None:
    """A denied/dropped tool leaves run.completed with a different tool-message
    count than the streamed completions → exact-match guard skips (no wrong
    attribution), the very case the last-N/`<` guard would have mis-rendered."""
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "tool.started", "tool_name": "terminal", "preview": "x"},
        {"event": "tool.failed", "tool_name": "terminal"},
        # this turn persisted TWO tool messages (e.g. a second, denied tool) but
        # only one completion streamed → count mismatch → skip
        {"event": "run.completed", "usage": {}, "messages": [
            {"role": "tool", "tool_name": "terminal", "content": '{"exit_code": 1}'},
            {"role": "tool", "tool_name": "other", "content": '{"error": "denied"}'},
        ]},
    )
    script.extend(["hi", "/exit"])
    app.run(new=True)
    assert "└" not in out_buf.getvalue()


def test_resume_posts_message_to_recent_session_chat_stream(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.sessions = [
        {"id": "old", "last_active": "2026-01-01"},
        {"id": "recent", "last_active": "2026-07-01"},
    ]
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "assistant.completed", "content": ""},
    )
    script.extend(["continue please", "/exit"])
    app.run()
    streams = [r for r in daemon.requests if r[1].endswith("/chat/stream")]
    assert len(streams) == 1
    method, path, body = streams[0]
    assert method == "POST"
    # most recent session resumed (Q4=A); the turn just posts {message} — the
    # server replays history natively (no client-side conversation_history)
    assert path == "/agents/bob/api/api/sessions/recent/chat/stream"
    assert json.loads(body) == {"message": "continue please"}
    assert "resumed" in err_buf.getvalue()


def test_explicit_session_id_missing_raises_not_found(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    with pytest.raises(CliError) as exc:
        app.resolve_session(session_id="ghost", new=False)
    assert exc.value.exit_code == ExitCode.NOT_FOUND


def test_interrupt_sends_stop_exactly_once(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    app.state = "streaming"
    app._run_id = "run-1"
    app._interrupt()
    app._interrupt()  # second Ctrl+C while stopping
    stops = [r for r in daemon.requests if r[1].endswith("/stop")]
    assert len(stops) == 1
    assert stops[0][1] == "/agents/bob/api/v1/runs/run-1/stop"
    assert app.state == "stopping"
    assert app.stops_sent_this_turn == 1


def test_stop_before_run_started_is_deferred_then_sent(harness: Any) -> None:
    """Stop pressed before run.started delivers the run_id must be deferred and
    fired when run.started arrives — never silently dropped."""
    daemon, app, out_buf, err_buf, script = harness
    app.state = "streaming"
    app._run_id = None
    app._pending_stop = False
    app._interrupt()  # no run_id yet
    assert app._pending_stop is True
    assert [r for r in daemon.requests if r[1].endswith("/stop")] == []
    # run.started arrives → the deferred stop fires exactly once
    app._dispatch("run.started", json.dumps({"run_id": "run-1"}))
    stops = [r for r in daemon.requests if r[1].endswith("/stop")]
    assert len(stops) == 1
    assert stops[0][1] == "/agents/bob/api/v1/runs/run-1/stop"
    assert app._pending_stop is False


def test_approval_prompt_posts_choice_and_resumes(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "approval.request", "command": "rm -rf /tmp/x", "run_id": "run-1",
         "choices": ["once", "session", "always", "deny"]},
        {"event": "assistant.delta", "delta": "done"},
        {"event": "assistant.completed", "content": "done"},
    )
    script.extend(["do it", "y", "/exit"])
    app.run(new=True)
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert len(approvals) == 1
    assert approvals[0][1] == "/agents/bob/api/v1/runs/run-1/approval"
    assert json.loads(approvals[0][2]) == {"choice": "once"}
    assert "approval requested" in err_buf.getvalue()
    assert "rm -rf /tmp/x" in err_buf.getvalue()
    assert "done" in out_buf.getvalue()


def test_auto_deny_when_approval_arrives_during_stop(harness: Any) -> None:
    """approval.request while stopping → auto-deny so the turn never hangs."""
    daemon, app, out_buf, err_buf, script = harness
    app.state = "stopping"
    app._run_id = "run-1"
    app._dispatch("approval.request", json.dumps({"command": "x", "run_id": "run-1"}))
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert len(approvals) == 1
    assert json.loads(approvals[0][2]) == {"choice": "deny"}
    assert app.state == "stopping"


def test_auto_deny_when_interrupted_while_awaiting_approval(harness: Any) -> None:
    """Ctrl+C at the live approval prompt → auto-deny + resume streaming."""
    daemon, app, out_buf, err_buf, script = harness
    app.state = "awaiting_approval"
    app._run_id = "run-1"
    app._interrupt()
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert len(approvals) == 1
    assert json.loads(approvals[0][2]) == {"choice": "deny"}
    assert app.state == "streaming"


def test_garbled_json_frame_is_tolerated(harness: Any) -> None:
    """A malformed data line is dropped (PU3-3), not fatal — rendering continues."""
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = (
        b'event: run.started\ndata: {"run_id": "run-1"}\n\n'
        b"event: assistant.delta\ndata: {not valid json}\n\n"
        b'event: assistant.completed\ndata: {"content": "ok"}\n\n'
    )
    script.extend(["hi", "/exit"])
    assert app.run(new=True) == ExitCode.OK
    assert "ok" in out_buf.getvalue()  # continued past the garbled frame


def test_invalid_approval_answer_denies(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "approval.request", "command": "danger", "run_id": "run-1"},
        {"event": "assistant.completed", "content": ""},
    )
    script.extend(["go", "whatever", "/exit"])
    app.run(new=True)
    approvals = [r for r in daemon.requests if r[1].endswith("/approval")]
    assert json.loads(approvals[0][2]) == {"choice": "deny"}


def test_error_event_renders_error_and_returns_to_idle(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "error", "message": "upstream exploded"},
    )
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
        {"event": "done"},
    )
    script.extend(["hi", "/exit"])
    assert app.run(new=True) == ExitCode.OK


def test_no_session_destroying_calls_ever_made(harness: Any) -> None:
    daemon, app, out_buf, err_buf, script = harness
    daemon.stream = sse(
        {"event": "run.started", "run_id": "run-1"},
        {"event": "assistant.completed", "content": ""},
    )
    script.extend(["hi", "/exit"])
    app.run(new=True)
    assert all(method != "DELETE" for method, _, _ in daemon.requests)  # PU3-5 (c)
