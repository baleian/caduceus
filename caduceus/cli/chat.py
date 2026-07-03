"""Interactive chat (F6) — session resume, streaming render, stop, approvals.

Native-endpoint composition (P1/P2, verified against hermes api_server source):
- sessions:   ``GET/POST {agent}/api/api/sessions`` (+ ``/messages`` hydration)
- turn:       ``POST {agent}/api/v1/runs`` with ``session_id`` +
              ``conversation_history`` (the runs API does not hydrate history
              from the session store itself — the CLI passes it explicitly)
- stream:     ``GET {agent}/api/v1/runs/{run_id}/events`` — SSE ``data:``-only
              blocks, event name inside the JSON payload
- stop:       ``POST {agent}/api/v1/runs/{run_id}/stop`` (turn interrupt)
- approval:   ``POST {agent}/api/v1/runs/{run_id}/approval`` {choice}

The interrupt state machine is a pure transition function (pattern P3);
``ChatApp`` merely executes the actions it returns. Invariants (PU3-5):
at most one stop per turn, exit only from ``idle``, no session-destroying call
exists anywhere in this module.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from rich.text import Text

from caduceus.cli.client import ApiClient
from caduceus.cli.errors import CliError, ExitCode, map_exception
from caduceus.cli.output import Renderer
from caduceus.cli.sse import iter_sse
from caduceus.core.hermes_adapter import redact

ChatState = Literal["idle", "streaming", "stopping", "awaiting_approval"]
ChatEvent = Literal[
    "interrupt", "eof", "user_message", "approval_request", "approval_answered", "stream_end"
]
Action = Literal["none", "exit", "start_turn", "send_stop", "prompt_approval", "auto_deny"]

_TRANSITIONS: dict[tuple[ChatState, ChatEvent], tuple[ChatState, Action]] = {
    ("idle", "interrupt"): ("idle", "exit"),
    ("idle", "eof"): ("idle", "exit"),
    ("idle", "user_message"): ("streaming", "start_turn"),
    ("streaming", "interrupt"): ("stopping", "send_stop"),
    ("streaming", "approval_request"): ("awaiting_approval", "prompt_approval"),
    ("streaming", "stream_end"): ("idle", "none"),
    ("streaming", "eof"): ("streaming", "none"),
    ("stopping", "interrupt"): ("stopping", "none"),  # never a second stop
    ("stopping", "approval_request"): ("stopping", "auto_deny"),
    ("stopping", "stream_end"): ("idle", "none"),
    ("stopping", "eof"): ("stopping", "none"),
    ("awaiting_approval", "interrupt"): ("streaming", "auto_deny"),
    ("awaiting_approval", "approval_answered"): ("streaming", "none"),
    ("awaiting_approval", "stream_end"): ("idle", "none"),
    ("awaiting_approval", "eof"): ("awaiting_approval", "none"),
}


def transition(state: ChatState, event: ChatEvent) -> tuple[ChatState, Action]:
    """Pure, total over the defined vocabulary; unknown pairs are no-ops."""
    return _TRANSITIONS.get((state, event), (state, "none"))


@dataclass
class SessionRef:
    id: str
    resumed: bool


APPROVAL_CHOICES = ("once", "session", "always", "deny")

FAILURE_DETAIL_LIMIT = 200


def tool_failure_summary(content: Any, *, limit: int = FAILURE_DETAIL_LIMIT) -> str:
    """One-line failure detail from a persisted tool message's content.

    Terminal-style results are JSON ``{"output", "exit_code", "error"}``;
    other tools store plain text. Whitespace is flattened — this renders as
    a single annotation line under the ✗ mark."""
    text = str(content or "")
    try:
        parsed = json.loads(text)
    except ValueError:
        parsed = None
    if isinstance(parsed, dict):
        parts: list[str] = []
        exit_code = parsed.get("exit_code")
        if isinstance(exit_code, int) and exit_code != 0:
            parts.append(f"exit {exit_code}")
        for key in ("error", "output", "message", "detail"):
            value = parsed.get(key)
            if isinstance(value, str) and value.strip():
                parts.append(value.strip())
                break
        if parts:
            text = " · ".join(parts)
    return redact(" ".join(text.split()))[:limit]


class ChatApp:
    def __init__(
        self,
        client: ApiClient,
        renderer: Renderer,
        agent: str,
        *,
        input_fn: Callable[[str], str] = input,
    ) -> None:
        self._client = client
        self._render = renderer
        self._agent = agent
        self._input = input_fn
        self.state: ChatState = "idle"
        self.stops_sent_this_turn = 0  # PU3-5 observability
        self._turn_text = ""  # raw delta accumulator (reasoning dedupe + completed fallback)
        # per-turn tool bookkeeping: the live SSE contract carries only
        # {tool, duration, error:bool} on tool.completed — the failure detail
        # exists solely in the session store, fetched after the turn.
        self._turn_tools: list[dict[str, Any]] = []
        self._turn_baseline = 0  # session message count before this turn

    # -- session resolution (Q4=A) ----------------------------------------------

    def resolve_session(self, *, session_id: str | None, new: bool) -> SessionRef:
        api = self._client.agent_api
        if session_id is not None:
            api(self._agent, "GET", f"api/sessions/{session_id}")  # 404 → exit 4
            return SessionRef(id=session_id, resumed=True)
        if not new:
            listing = api(self._agent, "GET", "api/sessions") or {}
            sessions = [s for s in listing.get("data", []) if s.get("id")]
            if sessions:
                sessions.sort(key=lambda s: s.get("last_active") or s.get("started_at") or "")
                return SessionRef(id=str(sessions[-1]["id"]), resumed=True)
        created = api(self._agent, "POST", "api/sessions", json={})
        return SessionRef(id=str(created["session"]["id"]), resumed=False)

    def _messages_raw(self, session_id: str) -> list[dict[str, Any]]:
        listing = self._client.agent_api(
            self._agent, "GET", f"api/sessions/{session_id}/messages"
        ) or {}
        return [m for m in listing.get("data", []) if isinstance(m, dict)]

    @staticmethod
    def _history(raw_messages: list[dict[str, Any]]) -> list[dict[str, str]]:
        history = []
        for message in raw_messages:
            role, content = message.get("role"), message.get("content")
            if role in ("user", "assistant") and isinstance(content, str) and content:
                history.append({"role": role, "content": content})
        return history

    # -- REPL ---------------------------------------------------------------------

    def run(self, *, session_id: str | None = None, new: bool = False) -> ExitCode:
        session = self.resolve_session(session_id=session_id, new=new)
        self._render.notice(
            f"chat with {self._agent} — session {session.id}"
            f" ({'resumed' if session.resumed else 'new'}); /exit or Ctrl+C to leave"
        )
        while True:
            try:
                line = self._input("you › ").strip()
            except KeyboardInterrupt:
                self.state, action = transition(self.state, "interrupt")
                if action == "exit":
                    return ExitCode.OK
                continue
            except EOFError:
                return ExitCode.OK
            if not line:
                continue
            if line == "/exit":
                return ExitCode.OK
            self.state, action = transition(self.state, "user_message")
            if action == "start_turn":
                self._turn(session.id, line)

    # -- one turn -------------------------------------------------------------------

    def _turn(self, session_id: str, user_message: str) -> None:
        self.stops_sent_this_turn = 0
        self._turn_text = ""
        self._turn_tools = []
        run_id: str | None = None
        try:
            raw = self._messages_raw(session_id)
            self._turn_baseline = len(raw)
            started = self._client.agent_api(
                self._agent,
                "POST",
                "v1/runs",
                json={
                    "input": user_message,
                    "session_id": session_id,
                    "conversation_history": self._history(raw),
                },
            )
            run_id = str(started["run_id"])
            self._consume_stream(run_id)
            self._render_tool_failures(session_id)
        except CliError as err:
            self._render.error(err)
        except Exception as exc:  # noqa: BLE001 - stream cut / transport: idle recovery
            self._render.error(map_exception(exc))
            self._render.notice("connection lost — the session is preserved")
        finally:
            self.state = "idle"

    def _consume_stream(self, run_id: str) -> None:
        subpath = f"v1/runs/{run_id}/events"
        with self._client.agent_api_stream(self._agent, "GET", subpath) as response:
            stream = iter_sse(response.iter_bytes())
            while True:
                try:
                    event = next(stream)
                except StopIteration:
                    break
                except KeyboardInterrupt:
                    self._interrupt(run_id)
                    continue
                try:
                    self._dispatch(run_id, event.data)
                except KeyboardInterrupt:
                    self._interrupt(run_id)
        self.state, _ = transition(self.state, "stream_end")

    def _interrupt(self, run_id: str) -> None:
        self.state, action = transition(self.state, "interrupt")
        if action == "send_stop":
            self.stops_sent_this_turn += 1
            self._render.notice("\nstopping current turn — session preserved")
            try:
                self._client.agent_api(self._agent, "POST", f"v1/runs/{run_id}/stop")
            except CliError as err:
                self._render.warn(f"stop request failed: {err.message}")
        elif action == "auto_deny":
            self._send_approval(run_id, "deny")

    # -- event rendering (domain-entities §5) -------------------------------------------

    def _dispatch(self, run_id: str, data: str) -> None:
        try:
            payload: dict[str, Any] = json.loads(data)
        except ValueError:
            return  # tolerate unknown/garbled frames (PU3-3 posture)
        if not isinstance(payload, dict):
            return
        kind = payload.get("event", "")
        out = self._render.out
        if kind == "message.delta":
            delta = str(payload.get("delta", ""))
            self._turn_text += delta
            out.print(Text(redact(delta, limit=1_000_000)), end="")
        elif kind == "reasoning.available":
            # hermes fills this event with the assistant message text itself
            # (content[:500], a progress relay — conversation_loop.py), so
            # rendering it verbatim would echo every reply a second time.
            # Show it only when it carries text the delta stream did not.
            text = str(payload.get("text", "")).strip()
            if text and text not in self._turn_text:
                out.print(Text("∴ " + redact(text), style="dim"))
        elif kind == "tool.started":
            preview = redact(str(payload.get("preview") or ""))[:120]
            self._turn_tools.append(
                {"tool": str(payload.get("tool", "?")), "preview": preview, "error": None}
            )
            out.print(Text(f"⚙ {payload.get('tool', '?')} {preview}", style="cyan"))
        elif kind == "tool.completed":
            error = bool(payload.get("error"))
            self._record_tool_completed(str(payload.get("tool", "?")), error)
            mark = "✗" if error else "✓"
            out.print(Text(f"  {mark} {payload.get('tool', '?')}"
                           f" ({payload.get('duration', '?')}s)", style="dim"))
        elif kind == "approval.request":
            self.state, action = transition(self.state, "approval_request")
            if action == "prompt_approval":
                self._prompt_approval(run_id, payload)
            elif action == "auto_deny":
                self._send_approval(run_id, "deny")
        elif kind == "run.completed":
            output = str(payload.get("output") or "")
            if output and not self._turn_text.strip():
                # provider streamed no deltas — the reply only exists here
                out.print(Text(redact(output, limit=1_000_000)))
            else:
                out.print()  # newline after last delta
        elif kind == "run.failed":
            self._render.error(
                CliError(str(payload.get("error", "run failed")), ExitCode.ERROR)
            )
        elif kind == "run.cancelled":
            out.print()
            self._render.notice("turn stopped")
        # unknown event kinds are ignored (forward compatibility)

    def _record_tool_completed(self, tool: str, error: bool) -> None:
        """Pair a completion with its started record (last open entry of the
        same tool — parallel calls of one tool complete in start order)."""
        for entry in reversed(self._turn_tools):
            if entry["tool"] == tool and entry["error"] is None:
                entry["error"] = error
                return
        self._turn_tools.append({"tool": tool, "preview": "", "error": error})

    def _render_tool_failures(self, session_id: str) -> None:
        """After the turn: show WHY tools failed. The live event stream omits
        results, but the session store persists each tool message (verified:
        role=tool, content carries output/exit_code) — fetch and pair by order.
        Silent skip on any pairing mismatch (blocked calls, cut streams):
        wrong attribution is worse than no annotation."""
        completed = [t for t in self._turn_tools if t["error"] is not None]
        if not any(t["error"] for t in completed):
            return
        try:
            raw = self._messages_raw(session_id)
        except CliError:
            return
        tool_messages = [
            m for m in raw[self._turn_baseline:] if m.get("role") == "tool"
        ]
        if len(tool_messages) != len(completed):
            return
        for event, message in zip(completed, tool_messages, strict=True):
            if not event["error"]:
                continue
            detail = tool_failure_summary(message.get("content"))
            if not detail:
                continue
            label = f"✗ {event['tool']}" + (f" {event['preview']}" if event["preview"] else "")
            self._render.out.print(Text(label, style="red"))
            self._render.out.print(Text(f"  └ {detail}", style="dim"))

    def _prompt_approval(self, run_id: str, payload: dict[str, Any]) -> None:
        summary = redact(str(payload.get("preview") or payload.get("command")
                              or payload.get("tool") or "tool execution"))[:200]
        self._render.err.print(
            Text(f"⚠ approval requested: {summary} [once/session/always/deny]",
                 style="bold yellow")
        )
        try:
            answer = self._input("approve › ").strip().lower() or "deny"
        except (KeyboardInterrupt, EOFError):
            answer = "deny"
        if answer in ("y", "yes"):
            answer = "once"
        if answer in ("n", "no") or answer not in APPROVAL_CHOICES:
            answer = "deny"
        self._send_approval(run_id, answer)
        self.state, _ = transition(self.state, "approval_answered")

    def _send_approval(self, run_id: str, choice: str) -> None:
        try:
            self._client.agent_api(
                self._agent, "POST", f"v1/runs/{run_id}/approval", json={"choice": choice}
            )
        except CliError as err:
            self._render.warn(f"approval response failed: {err.message}")
