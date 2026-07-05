"""Real HTTP daemon over fake hermes/upstream — the Playwright E2E backend.

Runs the genuine composed app (build_daemon: admin API, WS events, proxy,
relay, SPA serving from the real ``caduceus/web_dist``) with:
- an in-memory file store + scripted hermes CLI (profile create/delete succeed)
- a stateful fake api_server behind the relay (sessions/messages/runs with
  scripted SSE: plain, "slow" for stop, "approve" for the approval flow)
- a fixed admin token (E2E_TOKEN) and a 1s probe interval

Usage: ``uv run python -m tests.e2e_support.fake_daemon`` (port 43285).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI

from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import CommandResult
from caduceus.core.types import CaduceusConfig, ReconcileConfig, UpstreamConfig
from caduceus.daemon import Daemon, build_daemon
from tests.unit.fakes import FakeClock, InMemoryFileStore, ScriptedRunner
from tests.unit.test_process_manager import FakeHandle

CADUCEUS_HOME = Path("/home/e2e/.caduceus")
HERMES_HOME = Path("/home/e2e/.hermes")
E2E_TOKEN = "e2e-test-token"  # noqa: S105 - test fixture credential
PORT = 43285
WEB_DIST = Path(__file__).resolve().parents[2] / "caduceus" / "web_dist"


class Spawner:
    async def spawn(self, argv: list[str], *, env: dict[str, str] | None = None) -> FakeHandle:
        return FakeHandle()


def upstream_handler(request: httpx.Request) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "choices": [{"message": {"content": "pong"}}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 1},
        },
    )


class FakeAgentServer:
    """Stateful api_server: enough surface for the F11 chat flows (W7)."""

    def __init__(self) -> None:
        self.sessions: dict[str, dict[str, Any]] = {}
        self.messages: dict[str, list[dict[str, Any]]] = {}
        self.runs: dict[str, dict[str, Any]] = {}
        self.seq = 0

    def _next(self, prefix: str) -> str:
        self.seq += 1
        return f"{prefix}-{self.seq}"

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        if path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if path == "/api/sessions" and method == "GET":
            return httpx.Response(200, json={"data": list(self.sessions.values())})
        if path == "/api/sessions" and method == "POST":
            session_id = self._next("sess")
            self.sessions[session_id] = {
                "id": session_id,
                "title": None,
                "started_at": f"2026-07-03T00:00:{self.seq:02d}Z",
                "last_active": f"2026-07-03T00:00:{self.seq:02d}Z",
            }
            self.messages[session_id] = []
            return httpx.Response(201, json={"session": {"id": session_id}})
        if path.startswith("/api/sessions/"):
            rest = path.removeprefix("/api/sessions/")
            if rest.endswith("/chat/stream") and method == "POST":
                session_id = rest.removesuffix("/chat/stream")
                if session_id not in self.sessions:
                    return httpx.Response(404, json={"error": "no such session"})
                body = json.loads(request.content or b"{}")
                message = str(body.get("message", body.get("input", "")))
                if "http500" in message:
                    # partial outage: the chat/stream POST fails (5xx) while the
                    # session GET still works — exercises ChatView's catch
                    # (toast + input restore) against the finally hydrate
                    return httpx.Response(500, json={"error": {"message": "boom"}})
                run_id = self._next("run")
                self.runs[run_id] = {
                    "session_id": session_id,
                    "input": message,
                    "stopped": asyncio.Event(),
                    "approval": asyncio.Queue(maxsize=1),
                }
                self.messages.setdefault(session_id, []).append(
                    {"role": "user", "content": message}
                )
                self.sessions[session_id]["last_active"] = f"2026-07-03T01:00:{self.seq:02d}Z"
                return httpx.Response(
                    200,
                    content=self._session_events(run_id),
                    headers={"content-type": "text/event-stream"},
                )
            if rest.endswith("/messages") and method == "GET":
                session_id = rest.removesuffix("/messages")
                return httpx.Response(200, json={"data": self.messages.get(session_id, [])})
            session_id = rest
            if method == "PATCH" and session_id in self.sessions:
                body = json.loads(request.content or b"{}")
                self.sessions[session_id]["title"] = body.get("title")
                return httpx.Response(200, json={"ok": True})
            if method == "DELETE" and session_id in self.sessions:
                self.sessions.pop(session_id)
                self.messages.pop(session_id, None)
                return httpx.Response(200, json={"ok": True})
            if method == "GET" and session_id in self.sessions:
                return httpx.Response(200, json=self.sessions[session_id])
            return httpx.Response(404, json={"error": "no such session"})
        if path == "/v1/runs" and method == "POST":
            body = json.loads(request.content or b"{}")
            run_id = self._next("run")
            session_id = str(body.get("session_id", ""))
            user_input = str(body.get("input", ""))
            self.runs[run_id] = {
                "session_id": session_id,
                "input": user_input,
                "stopped": asyncio.Event(),
                "approval": asyncio.Queue(maxsize=1),
            }
            self.messages.setdefault(session_id, []).append(
                {"role": "user", "content": user_input}
            )
            if session_id in self.sessions:
                self.sessions[session_id]["last_active"] = f"2026-07-03T01:00:{self.seq:02d}Z"
            return httpx.Response(202, json={"run_id": run_id, "status": "started"})
        if path.startswith("/v1/runs/"):
            rest = path.removeprefix("/v1/runs/")
            run_id, _, action = rest.partition("/")
            run = self.runs.get(run_id)
            if run is None:
                return httpx.Response(404, json={"error": "no such run"})
            if action == "events" and method == "GET":
                return httpx.Response(
                    200,
                    content=self._events(run_id),
                    headers={"content-type": "text/event-stream"},
                )
            if action == "stop" and method == "POST":
                run["stopped"].set()
                return httpx.Response(200, json={"ok": True})
            if action == "approval" and method == "POST":
                body = json.loads(request.content or b"{}")
                with contextlib.suppress(asyncio.QueueFull):
                    run["approval"].put_nowait(str(body.get("choice", "deny")))
                return httpx.Response(200, json={"ok": True})
        return httpx.Response(404, json={"error": f"nope {method} {path}"})

    async def _events(self, run_id: str) -> AsyncIterator[bytes]:
        def frame(payload: dict[str, Any]) -> bytes:
            return f"data: {json.dumps(payload)}\n\n".encode()

        run = self.runs[run_id]
        session_id: str = run["session_id"]
        user_input: str = run["input"]

        def finish(text: str) -> None:
            self.messages.setdefault(session_id, []).append(
                {"role": "assistant", "content": text}
            )

        if "slow" in user_input:
            emitted = ""
            for i in range(40):
                if run["stopped"].is_set():
                    finish(emitted + " [stopped]")
                    yield frame({"event": "run.cancelled"})
                    return
                chunk = f"tick{i} "
                emitted += chunk
                yield frame({"event": "message.delta", "delta": chunk})
                await asyncio.sleep(0.25)
            finish(emitted)
            yield frame({"event": "run.completed", "output": emitted})
            return

        if "approve" in user_input:
            yield frame(
                {"event": "approval.request", "tool": "terminal", "preview": "touch /tmp/e2e"}
            )
            try:
                choice = await asyncio.wait_for(run["approval"].get(), timeout=20.0)
            except TimeoutError:
                choice = "deny"
            if choice == "deny":
                finish("tool denied")
                yield frame({"event": "run.completed", "output": "tool denied"})
                return
            yield frame({"event": "tool.started", "tool": "terminal", "preview": "touch /tmp/e2e"})
            yield frame(
                {"event": "tool.completed", "tool": "terminal", "duration": 0.1, "error": False}
            )
            finish("tool ran fine")
            yield frame({"event": "message.delta", "delta": "tool ran fine"})
            yield frame({"event": "run.completed", "output": "tool ran fine"})
            return

        reply = "Hello from fake agent."
        for chunk in ("Hello ", "from ", "fake agent."):
            yield frame({"event": "message.delta", "delta": chunk})
            await asyncio.sleep(0.05)
        finish(reply)
        yield frame({"event": "run.completed", "output": reply})

    async def _session_events(self, run_id: str) -> AsyncIterator[bytes]:
        """Named-SSE mirror of _events for POST /api/sessions/{id}/chat/stream:
        run.started (carries run_id) → assistant.delta / tool.progress{_thinking}
        / tool.* / approval.request → assistant.completed → run.completed → done.
        Approval/stop reuse the same self.runs entry the /v1/runs endpoints key
        on, so no new control routes are needed."""

        def frame(name: str, payload: dict[str, Any]) -> bytes:
            return f"event: {name}\ndata: {json.dumps(payload)}\n\n".encode()

        run = self.runs[run_id]
        session_id: str = run["session_id"]
        user_input: str = run["input"]

        def finish(text: str, reasoning: str | None = None) -> None:
            msg: dict[str, Any] = {"role": "assistant", "content": text}
            if reasoning:
                msg["reasoning"] = reasoning
            self.messages.setdefault(session_id, []).append(msg)

        async def close(text: str, *, interrupted: bool = False) -> AsyncIterator[bytes]:
            yield frame(
                "assistant.completed", {"content": text, "interrupted": interrupted}
            )
            yield frame("run.completed", {"usage": {}, "messages": []})
            yield frame("done", {})

        yield frame("run.started", {"run_id": run_id, "session_id": session_id})
        yield frame(
            "message.started", {"message": {"id": f"msg-{run_id}", "role": "assistant"}}
        )

        if "slow" in user_input:
            emitted = ""
            for i in range(40):
                if run["stopped"].is_set():
                    finish(emitted + " [stopped]")
                    async for f in close(emitted + " [stopped]", interrupted=True):
                        yield f
                    return
                chunk = f"tick{i} "
                emitted += chunk
                yield frame("assistant.delta", {"delta": chunk})
                await asyncio.sleep(0.25)
            finish(emitted)
            async for f in close(emitted):
                yield f
            return

        if "approve" in user_input:
            yield frame(
                "approval.request",
                {
                    "command": "touch /tmp/e2e",
                    "choices": ["once", "session", "always", "deny"],
                    "run_id": run_id,
                },
            )
            try:
                choice = await asyncio.wait_for(run["approval"].get(), timeout=20.0)
            except TimeoutError:
                choice = "deny"
            if choice == "deny":
                finish("tool denied")
                async for f in close("tool denied"):
                    yield f
                return
            yield frame("tool.started", {"tool_name": "terminal", "preview": "touch /tmp/e2e"})
            yield frame("tool.completed", {"tool_name": "terminal"})
            finish("tool ran fine")
            yield frame("assistant.delta", {"delta": "tool ran fine"})
            async for f in close("tool ran fine"):
                yield f
            return

        if "think" in user_input:
            for chunk in ("reason ", "about it"):
                yield frame("tool.progress", {"tool_name": "_thinking", "delta": chunk})
                await asyncio.sleep(0.05)
            reply = "Thought it through."
            for chunk in ("Thought ", "it ", "through."):
                yield frame("assistant.delta", {"delta": chunk})
                await asyncio.sleep(0.05)
            finish(reply, reasoning="reason about it")
            async for f in close(reply):
                yield f
            return

        if "toolfail" in user_input:
            yield frame("tool.started", {"tool_name": "terminal", "preview": "bad cmd"})
            await asyncio.sleep(0.1)
            yield frame("tool.failed", {"tool_name": "terminal"})
            # hold so the live failed card is observable before the turn
            # completes and re-hydration replaces the live buffer
            await asyncio.sleep(0.5)
            reply = "recovered from the failure"
            yield frame("assistant.delta", {"delta": reply})
            finish(reply)
            async for f in close(reply):
                yield f
            return

        if "boom" in user_input:
            # mid-stream hermes error → error event then done (no content)
            yield frame("error", {"message": "upstream 529 overloaded"})
            yield frame("done", {})
            return

        reply = "Hello from fake agent."
        for chunk in ("Hello ", "from ", "fake agent."):
            yield frame("assistant.delta", {"delta": chunk})
            await asyncio.sleep(0.05)
        finish(reply)
        async for f in close(reply):
            yield f


def make_daemon() -> Daemon:
    files = InMemoryFileStore()
    files.mkdir(CADUCEUS_HOME)
    files.mkdir(HERMES_HOME)
    files.write_text_atomic(CADUCEUS_HOME / "admin.token", E2E_TOKEN + "\n", mode=0o600)

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
        upstream=UpstreamConfig(base_url="http://upstream.test/v1", default_model="fake-model"),
        reconcile=ReconcileConfig(interval_s=1.0),
    )
    config_store = CaduceusConfigStore(CADUCEUS_HOME / "config.yaml", files)
    config_store.save(config)

    agent = FakeAgentServer()
    return build_daemon(
        config=config,
        config_store=config_store,
        caduceus_home=CADUCEUS_HOME,
        files=files,
        clock=FakeClock(),
        runner=runner,
        spawner=Spawner(),
        hermes_home=HERMES_HOME,
        upstream_transport=httpx.MockTransport(upstream_handler),
        agent_transport=httpx.MockTransport(agent.handle),
        web_dist=WEB_DIST,
    )


def main() -> None:
    daemon = make_daemon()

    @contextlib.asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await daemon.startup()
        try:
            yield
        finally:
            await daemon.shutdown()

    daemon.app.router.lifespan_context = lifespan

    import uvicorn

    uvicorn.run(daemon.app, host="127.0.0.1", port=PORT, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
