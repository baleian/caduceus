"""Domain types (functional-design/domain-entities.md).

All models are pydantic v2. ``AgentSpec``/``AgentRecord`` are frozen — state
changes go through ``Registry`` which re-validates invariants I1–I5 before
persisting.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from caduceus.core.errors import DomainValidationError

# V1: same shape hermes enforces for profile ids, minus the "cad-" prefix budget.
AGENT_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,59}$")
RESERVED_AGENT_NAMES = frozenset({"default"})

PROFILE_PREFIX = "cad-"

NetworkMode = Literal["host", "bridge_hostgw", "none"]
DesiredState = Literal["running", "stopped"]

REGISTRY_SCHEMA_VERSION = 1

DEFAULT_DOCKER_IMAGE = "nikolaik/python-nodejs:python3.11-nodejs20"
MAX_PERSONA_BYTES = 64 * 1024  # V5
MAX_IMAGE_LEN = 512  # V2


def validate_agent_name(name: str) -> str:
    """Validate rule V1; returns the name or raises DomainValidationError."""
    if not AGENT_NAME_RE.fullmatch(name):
        raise DomainValidationError(
            f"invalid agent name {name!r}",
            detail="must match ^[a-z0-9][a-z0-9_-]{0,59}$",
        )
    if name in RESERVED_AGENT_NAMES:
        raise DomainValidationError(f"agent name {name!r} is reserved")
    return name


def profile_name_for(agent_name: str) -> str:
    """Derive the hermes profile name (FD1): agent ``x`` → profile ``cad-x``."""
    return PROFILE_PREFIX + validate_agent_name(agent_name)


def agent_name_from_profile(profile_name: str) -> str:
    """Inverse of :func:`profile_name_for` (P2 round-trip)."""
    if not profile_name.startswith(PROFILE_PREFIX):
        raise DomainValidationError(
            f"not a caduceus-managed profile: {profile_name!r}",
            detail=f"expected prefix {PROFILE_PREFIX!r}",
        )
    return validate_agent_name(profile_name[len(PROFILE_PREFIX):])


class AgentSpec(BaseModel):
    """Declarative agent creation/edit input (user-facing)."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    name: str
    docker_image: str = DEFAULT_DOCKER_IMAGE
    network_mode: NetworkMode = "host"  # AD-2 default
    cpu: float | None = Field(default=None, gt=0)
    memory_mb: int | None = Field(default=None, ge=256)
    disk_mb: int | None = Field(default=None, ge=1024)
    persona: str | None = None

    @field_validator("name")
    @classmethod
    def _name_v1(cls, v: str) -> str:
        return validate_agent_name(v)

    @field_validator("docker_image")
    @classmethod
    def _image_v2(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped or len(stripped) > MAX_IMAGE_LEN:
            raise DomainValidationError("docker_image must be a non-empty string ≤512 chars")
        if any(c in stripped for c in "\x00\n\r\t"):
            raise DomainValidationError("docker_image contains control characters")
        return stripped

    @field_validator("persona")
    @classmethod
    def _persona_v5(cls, v: str | None) -> str | None:
        if v is not None and len(v.encode("utf-8")) > MAX_PERSONA_BYTES:
            raise DomainValidationError("persona exceeds 64KB")
        return v


class AgentRecord(BaseModel):
    """Registry-persisted agent state (domain-entities.md).

    ``api_server_key`` is a local secret consumed server-side only (S3); the
    registry file itself is written 0600. The gateway auth token is stored as
    ``token_hash`` only — plaintext lives solely in the profile ``.env`` (S1).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    spec: AgentSpec
    profile_name: str
    workspace_dir: str
    api_port: int = Field(ge=1, le=65535)
    api_server_key: str = Field(min_length=16, repr=False)
    token_hash: str = Field(pattern=r"^[0-9a-f]{64}$", repr=False)
    desired_state: DesiredState = "stopped"
    created_at: str  # ISO 8601, injected via Clock (no ambient time reads)

    @model_validator(mode="after")
    def _derived_consistency(self) -> AgentRecord:
        # I5: profile name is always the derived one.
        expected = profile_name_for(self.spec.name)
        if self.profile_name != expected:
            raise DomainValidationError(
                f"profile_name {self.profile_name!r} != derived {expected!r} (I5)"
            )
        # I4: workspace dir ends with the agent name (full containment is
        # checked against the configured root by workspace.py — V6/P9).
        if not self.workspace_dir or not self.workspace_dir.rstrip("/").endswith(self.spec.name):
            raise DomainValidationError("workspace_dir does not match agent name (I4)")
        return self


class RegistryFile(BaseModel):
    """Persistent registry document (schema v1)."""

    model_config = ConfigDict(extra="forbid")

    schema_version: int = REGISTRY_SCHEMA_VERSION
    agents: dict[str, AgentRecord] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _invariants(self) -> RegistryFile:
        if self.schema_version != REGISTRY_SCHEMA_VERSION:
            raise DomainValidationError(
                f"unsupported registry schema_version {self.schema_version}"
            )
        ports: dict[int, str] = {}
        hashes: dict[str, str] = {}
        for key, record in self.agents.items():
            if key != record.spec.name:  # I1 key consistency
                raise DomainValidationError(
                    f"registry key {key!r} != record name {record.spec.name!r} (I1)"
                )
            if record.api_port in ports:  # I2
                raise DomainValidationError(
                    f"duplicate api_port {record.api_port} "
                    f"({ports[record.api_port]!r} vs {key!r}) (I2)"
                )
            ports[record.api_port] = key
            if record.token_hash in hashes:  # I3
                raise DomainValidationError(
                    f"duplicate token_hash between {hashes[record.token_hash]!r} "
                    f"and {key!r} (I3)"
                )
            hashes[record.token_hash] = key
        return self


class UpstreamConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    base_url: str
    api_key_env: str | None = None  # S4: env-var reference only, never a literal key
    default_model: str | None = None

    @field_validator("base_url")
    @classmethod
    def _url_v5(cls, v: str) -> str:
        if not re.fullmatch(r"https?://\S+", v.strip()):
            raise DomainValidationError(f"upstream base_url must be an http(s) URL: {v!r}")
        return v.strip().rstrip("/")


class ListenConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    host: str = "127.0.0.1"  # N3 loopback default
    port: int = Field(default=4285, ge=1, le=65535)


class AgentDefaults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    port_base: int = Field(default=42800, ge=1024, le=65535)
    default_image: str = DEFAULT_DOCKER_IMAGE


class ReconcileConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    interval_s: float = Field(default=30.0, gt=0)


class CaduceusConfig(BaseModel):
    """``~/.caduceus/config.yaml`` document."""

    model_config = ConfigDict(extra="forbid")

    listen: ListenConfig = Field(default_factory=ListenConfig)
    upstream: UpstreamConfig
    agents: AgentDefaults = Field(default_factory=AgentDefaults)
    reconcile: ReconcileConfig = Field(default_factory=ReconcileConfig)


ProcessState = Literal["starting", "running", "stopping", "exited", "crashlooping"]
HealthState = Literal["healthy", "unhealthy", "unreachable", "unknown"]
ContainerState = Literal["running", "exited", "absent", "unknown"]


class AgentStatus(BaseModel):
    """Synthesized runtime view (never persisted) — E3: unknown means unknown."""

    model_config = ConfigDict(frozen=True)

    name: str
    desired_state: DesiredState
    process: ProcessState | Literal["not-running"]
    health: HealthState = "unknown"
    container: ContainerState = "unknown"
    detail: dict[str, Any] = Field(default_factory=dict)


class CoreEvent(BaseModel):
    """Event emitted through the EventSink port (implemented by U2's EventBus)."""

    model_config = ConfigDict(frozen=True)

    kind: str  # e.g. "process.state", "registry.changed", "drift.detected"
    agent: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    ts: str = ""  # ISO 8601, filled by emitter via Clock
