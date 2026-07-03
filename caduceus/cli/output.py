"""Renderer — the single output path of the CLI (patterns P6/P10).

Rules enforced here and nowhere else:
- stdout carries data only; progress/notices/errors go to stderr (CLI-O1)
- ``--json`` mode prints exactly one plain JSON document to stdout (PU3-4)
- every daemon-originated string is passed through ``redact()`` once more
  before display (CLI-P2), and rich escapes control sequences (U3-SEC-5)
- job-progress rendering is a pure snapshot-diff function (PU3-2) executed
  by this renderer; TTY gets live updates, pipes get transition lines
"""

from __future__ import annotations

import json
from typing import Any

from rich.console import Console
from rich.table import Table
from rich.text import Text

from caduceus.cli.errors import CliError, ExitCode
from caduceus.core.hermes_adapter import redact

STEP_ICONS = {
    "pending": "·",
    "running": "…",
    "ok": "✓",
    "failed": "✗",
    "skipped": "↷",
}

TERMINAL_JOB_STATES = ("done", "failed")


def job_transitions(prev: dict[str, Any] | None, cur: dict[str, Any]) -> list[str]:
    """Pure diff: lines describing step-state changes between two snapshots."""
    lines: list[str] = []
    prev_steps = {s["name"]: s["state"] for s in (prev or {}).get("steps", [])}
    for step in cur.get("steps", []):
        state = step["state"]
        if prev_steps.get(step["name"]) != state and state != "pending":
            lines.append(f"{STEP_ICONS.get(state, '?')} {step['name']}")
    if cur.get("state") in TERMINAL_JOB_STATES and (prev or {}).get("state") != cur.get("state"):
        lines.append(f"job {cur.get('id', '?')}: {cur['state']}")
    return lines


def job_exit_code(snapshot: dict[str, Any]) -> ExitCode:
    return ExitCode.OK if snapshot.get("state") == "done" else ExitCode.ERROR


class Renderer:
    def __init__(
        self,
        *,
        stdout: Console | None = None,
        stderr: Console | None = None,
        json_mode: bool = False,
        quiet: bool = False,
        no_color: bool = False,
    ) -> None:
        self.json_mode = json_mode
        self.quiet = quiet
        self.out = stdout or Console(no_color=no_color, soft_wrap=True)
        self.err = stderr or Console(stderr=True, no_color=no_color, soft_wrap=True)

    # -- data (stdout) ----------------------------------------------------------

    def data_json(self, obj: Any) -> None:
        """The whole stdout payload in --json mode: one plain JSON document."""
        self.out.print(json.dumps(obj, ensure_ascii=False, indent=2), markup=False,
                       highlight=False)

    def data_text(self, text: str) -> None:
        self.out.print(Text(redact(text, limit=1_000_000)))

    def data_table(self, columns: list[str], rows: list[list[str]]) -> None:
        table = Table(show_edge=False, pad_edge=False)
        for col in columns:
            table.add_column(col)
        for row in rows:
            table.add_row(*[Text(redact(cell)) for cell in row])
        self.out.print(table)

    def data_lines(self, lines: list[str]) -> None:
        for line in lines:
            self.out.print(Text(redact(line, limit=1_000_000)))

    # -- progress / notices (stderr) ---------------------------------------------

    def notice(self, message: str) -> None:
        self.err.print(Text(redact(message)), style="dim")

    def progress(self, message: str) -> None:
        if not self.quiet:
            self.err.print(Text(redact(message)))

    def warn(self, message: str) -> None:
        self.err.print(Text("warning: " + redact(message)), style="yellow")

    def error(self, err: CliError) -> None:
        self.err.print(Text("error: " + redact(err.message)), style="bold red")
        if err.hint:
            self.err.print(Text("  hint: " + err.hint), style="dim")

    # -- job progress (business-logic §2) ------------------------------------------

    def job_progress_sink(self) -> Any:
        """Returns an ``on_snapshot`` callable that renders transitions to stderr."""
        prev: dict[str, Any] | None = None

        def sink(snapshot: dict[str, Any]) -> None:
            nonlocal prev
            for line in job_transitions(prev, snapshot):
                self.progress(line)
            prev = snapshot

        return sink

    def job_outcome(self, snapshot: dict[str, Any]) -> ExitCode:
        code = job_exit_code(snapshot)
        if code is not ExitCode.OK and snapshot.get("error"):
            self.err.print(Text("job failed: " + redact(str(snapshot["error"]))),
                           style="bold red")
        if self.json_mode:
            self.data_json(snapshot)
        return code
