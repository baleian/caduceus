"""Domain error hierarchy (business-rules.md E1–E4, SECURITY-15 fail-closed).

Every external failure (subprocess, filesystem, parsing) is translated into one
of these errors at the boundary where it occurs; callers never see raw
``OSError``/``CalledProcessError``/pydantic internals leaking through core APIs.
"""

from __future__ import annotations


class CaduceusError(Exception):
    """Base class for all Caduceus domain errors."""

    def __init__(self, message: str, *, detail: str | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail

    def __str__(self) -> str:
        if self.detail:
            return f"{self.message} ({self.detail})"
        return self.message


class DomainValidationError(CaduceusError):
    """Input failed validation rules V1–V6."""


class NotFoundError(CaduceusError):
    """Referenced agent/resource does not exist."""


class ConflictError(CaduceusError):
    """Uniqueness or existence conflict (duplicate agent, existing profile — L5)."""


class RegistryCorruptError(CaduceusError):
    """registry.json unreadable or invariant-violating; startup must halt (E2)."""

    def __init__(
        self, message: str, *, backup_path: str | None = None, detail: str | None = None
    ) -> None:
        super().__init__(message, detail=detail)
        self.backup_path = backup_path


class HermesError(CaduceusError):
    """hermes CLI invocation failed (non-zero exit, redacted stderr in detail)."""


class DockerError(CaduceusError):
    """docker CLI invocation failed."""


class SubprocessTimeoutError(CaduceusError):
    """External command exceeded its timeout (E1, RESILIENCY-10)."""


class WorkspaceError(CaduceusError):
    """Workspace path invalid or escapes the managed root (V6/P9)."""


class ConfigError(CaduceusError):
    """Caduceus config.yaml missing required values or invalid."""
