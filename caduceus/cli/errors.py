"""CLI error domain: exit-code contract and the single total error-mapping table.

Exit codes are a public scripting contract (domain-entities §3); every failure
path in the CLI funnels through :func:`map_exception` /
:func:`error_from_response` exactly once, at the top level (rules CLI-E2,
U3-MAINT-3). The mapping is total: any (status, body) or raised exception
resolves to exactly one ``CliError`` — verified by PU3-1.
"""

from __future__ import annotations

import json
from enum import IntEnum
from typing import Any

import httpx

from caduceus.core.errors import CaduceusError, ConfigError, DomainValidationError, NotFoundError
from caduceus.core.hermes_adapter import redact


class ExitCode(IntEnum):
    OK = 0
    ERROR = 1  # generic failure, failed job, daemon-side 5xx
    USAGE = 2  # argument/flag misuse, validation rejection
    UNREACHABLE = 3  # daemon not running / not initialized / auth mismatch
    NOT_FOUND = 4  # agent/session/job/skill does not exist
    REFUSED = 5  # confirmation declined, conflict (409)


class CliError(Exception):
    """Terminal CLI failure carrying its exit code and an optional next-step hint."""

    def __init__(self, message: str, exit_code: ExitCode, *, hint: str | None = None) -> None:
        super().__init__(message)
        self.message = redact(message)  # CLI-P2: defense in depth
        self.exit_code = exit_code
        self.hint = hint


_HINT_SERVE = "start the daemon with `caduceus serve` (or `caduceus init` first)"
_HINT_AUTH = (
    "admin token mismatch — check ~/.caduceus/admin.token or CADUCEUS_ADMIN_TOKEN"
)


def _status_exit_code(status: int) -> ExitCode:
    """Total mapping HTTP status → exit code (business-logic §7)."""
    if status in (401, 403):
        return ExitCode.UNREACHABLE
    if status == 404:
        return ExitCode.NOT_FOUND
    if status == 409:
        return ExitCode.REFUSED
    if status in (400, 422):
        return ExitCode.USAGE
    return ExitCode.ERROR


def _extract_message(body: bytes | str) -> str | None:
    """Pull a human message out of any error-body shape the stack produces.

    Shapes seen across the daemon and hermes api_server:
    ``{"error": "msg"}`` (admin API), ``{"detail": "msg"}`` (FastAPI),
    ``{"error": {"message": "msg", ...}}`` (OpenAI-style, relayed by the
    agent proxy).
    """
    try:
        parsed: Any = json.loads(body)
    except (ValueError, TypeError, UnicodeDecodeError):
        return None
    if not isinstance(parsed, dict):
        return None
    for key in ("error", "detail", "message"):
        value = parsed.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            inner = value.get("message")
            if isinstance(inner, str) and inner:
                return inner
    return None


def error_from_response(status: int, body: bytes | str) -> CliError:
    code = _status_exit_code(status)
    message = _extract_message(body) or f"daemon returned HTTP {status}"
    hint: str | None = None
    if code is ExitCode.UNREACHABLE:
        hint = _HINT_AUTH
    elif code is ExitCode.NOT_FOUND:
        hint = "list what exists with `caduceus agent ls` / `caduceus job ls`"
    return CliError(message, code, hint=hint)


def map_exception(exc: Exception) -> CliError:
    """Total mapping of anything raised inside a command → CliError (PU3-1)."""
    if isinstance(exc, CliError):
        return exc
    if isinstance(exc, httpx.HTTPStatusError):
        return error_from_response(exc.response.status_code, exc.response.content)
    if isinstance(exc, httpx.TransportError):
        # connection refused / DNS / timeouts — the daemon side never spoke
        return CliError(f"cannot reach the daemon: {exc}", ExitCode.UNREACHABLE, hint=_HINT_SERVE)
    if isinstance(exc, NotFoundError):
        return CliError(str(exc), ExitCode.NOT_FOUND)
    if isinstance(exc, DomainValidationError):
        return CliError(str(exc), ExitCode.USAGE)
    if isinstance(exc, ConfigError):
        return CliError(str(exc), ExitCode.UNREACHABLE, hint="run `caduceus init` first")
    if isinstance(exc, CaduceusError):
        return CliError(str(exc), ExitCode.ERROR)
    return CliError(f"unexpected error: {exc!r}", ExitCode.ERROR)
