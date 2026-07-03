"""Profile config rendering + comment-preserving merge (FD2, logic §5).

- ``managed_config`` produces exactly the keys Caduceus owns (ManagedConfigKeys).
- ``merge_config_text`` rewrites ONLY those keys inside an existing config.yaml,
  preserving user comments/ordering via ruamel round-trip (G1).
- ``set_env_lines`` edits ``.env`` content line-wise, preserving unrelated lines.
- ``diff_managed`` reports drift between a config text and the expected managed keys.
"""

from __future__ import annotations

import io
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.scalarstring import SingleQuotedScalarString

from caduceus.core.errors import DomainValidationError
from caduceus.core.types import AgentSpec, NetworkMode

# P10 table: network_mode → docker run extra args (config-only, hermes-native).
_NETWORK_EXTRA_ARGS: dict[NetworkMode, list[str]] = {
    "host": ["--network=host"],
    "bridge_hostgw": ["--add-host=host.docker.internal:host-gateway"],
    "none": ["--network=none"],
}


def network_extra_args(mode: NetworkMode) -> list[str]:
    try:
        return list(_NETWORK_EXTRA_ARGS[mode])
    except KeyError:
        raise DomainValidationError(f"unknown network_mode {mode!r}") from None


def managed_config(
    spec: AgentSpec,
    *,
    daemon_v1_url: str,
    workspace_dir: str,
    default_model: str | None,
) -> dict[str, Any]:
    """Managed key tree (domain-entities.md ManagedConfigKeys).

    ``model.api_key`` must be rendered explicitly: hermes' ``custom`` provider
    reads its key from config (``model.api_key``), not from any env var
    (``env_vars=()`` in the provider profile) — the ``${OPENAI_API_KEY}``
    reference is expanded by hermes from the profile ``.env``, so the gateway
    token never appears literally in config.yaml (S1).
    """
    model: dict[str, Any] = {
        "provider": "custom",
        "base_url": daemon_v1_url,
        "api_key": "${OPENAI_API_KEY}",
    }
    if default_model:
        model["default"] = default_model

    # approvals.mode MUST be emitted quoted: bare `off` is YAML-1.1 boolean
    # False. hermes normalizes that back to "off", but our own drift check
    # would then compare False (loaded) vs "off" (expected) forever.
    approvals = {"mode": SingleQuotedScalarString(spec.approvals_mode)}

    terminal: dict[str, Any] = {
        "backend": "docker",
        "cwd": "/workspace",
        "docker_image": spec.docker_image,
        "container_persistent": True,
        # The sandbox runs as container root so system package managers work
        # (F3). The docker daemon itself is ROOTLESS (preflight-enforced):
        # container root maps to the daemon user on the host, so everything
        # written into bind mounts (workspace, sandbox home, dockerd-created
        # mountpoints) is host-owned — no ownership workarounds needed here.
        "docker_volumes": [f"{workspace_dir}:/workspace"],
        "docker_extra_args": network_extra_args(spec.network_mode),
    }
    if spec.cpu is not None:
        terminal["container_cpu"] = spec.cpu
    if spec.memory_mb is not None:
        terminal["container_memory"] = spec.memory_mb
    if spec.disk_mb is not None:
        terminal["container_disk"] = spec.disk_mb

    return {
        "model": model,
        "terminal": terminal,
        "approvals": approvals,
        # hermes ships hard_stop disabled; without it a model that wants a
        # missing capability can retry a failing/hallucinated tool call
        # forever. Bounded turns are non-negotiable for unattended agents.
        "tool_loop_guardrails": {"hard_stop_enabled": True},
    }


# Toolsets rendered into ``platform_toolsets.api_server`` at agent creation.
#
# Why explicit: when the key is absent, hermes infers enabled toolsets by a
# subset test of each toolset's tools against the platform composite. On
# hermes versions without the #49622 fix, registry-registered tools pollute
# that test (desktop-only ``read_terminal`` joins the ``terminal`` toolset,
# which the api_server composite never lists) and ``terminal``/``process``
# silently never reach the model. An explicit list forces hermes' direct-
# membership branch on every version. Every key below is validated against
# CONFIGURABLE_TOOLSETS. Interactive-only (clarify, tts, computer_use) and
# default-off (homeassistant, spotify, discord*, x_search, video*) toolsets
# are intentionally excluded — matching api_server's non-interactive intent.
# Seeded once at creation; user-editable afterwards via `agent toolsets`.
DEFAULT_API_SERVER_TOOLSETS = (
    "browser",
    "code_execution",
    "cronjob",
    "delegation",
    "file",
    "image_gen",
    "memory",
    "session_search",
    "skills",
    "terminal",
    "todo",
    "vision",
    "web",
)


def _yaml() -> YAML:
    yaml = YAML()  # round-trip mode: preserves comments, order, formatting
    yaml.preserve_quotes = True
    yaml.indent(mapping=2, sequence=2, offset=0)
    return yaml


def merge_config_text(existing_text: str | None, managed: dict[str, Any]) -> str:
    """Replace managed keys, preserve everything else (idempotent — P5)."""
    yaml = _yaml()
    data: Any
    if existing_text and existing_text.strip():
        data = yaml.load(existing_text)
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise DomainValidationError("profile config.yaml root is not a mapping")
    else:
        data = {}

    for section, values in managed.items():
        node = data.get(section)
        if not isinstance(node, dict):
            node = {}
            data[section] = node
        for key, value in values.items():
            node[key] = value

    buf = io.StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def diff_managed(existing_text: str | None, managed: dict[str, Any]) -> list[tuple[str, Any, Any]]:
    """Drift report: (dotted key, expected, actual). Empty list = no drift (G2)."""
    yaml = _yaml()
    data: Any = {}
    if existing_text and existing_text.strip():
        loaded = yaml.load(existing_text)
        if isinstance(loaded, dict):
            data = loaded

    drift: list[tuple[str, Any, Any]] = []
    for section, values in managed.items():
        node = data.get(section) if isinstance(data, dict) else None
        for key, expected in values.items():
            actual = node.get(key) if isinstance(node, dict) else None
            # ruamel round-trip types (CommentedSeq/Map) compare equal to plain
            # lists/dicts, so a direct != is a faithful drift check.
            if actual != expected:
                drift.append((f"{section}.{key}", expected, actual))
    return drift


def set_env_lines(existing_text: str | None, updates: dict[str, str]) -> str:
    """Replace/append ``KEY=value`` lines, preserving all other lines (P7).

    Values must be single-line; keys are validated as env-var names (defense
    against injection through crafted values — V6 spirit).
    """
    for key, value in updates.items():
        if not key or not key.replace("_", "").isalnum() or key[0].isdigit():
            raise DomainValidationError(f"invalid env key {key!r}")
        if "\n" in value or "\r" in value:
            raise DomainValidationError(f"env value for {key} must be single-line")

    lines = (existing_text or "").splitlines()
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        stripped = line.strip()
        replaced = False
        if stripped and not stripped.startswith("#") and "=" in stripped:
            existing_key = stripped.split("=", 1)[0].strip()
            if existing_key in remaining:
                out.append(f"{existing_key}={remaining.pop(existing_key)}")
                replaced = True
        if not replaced:
            out.append(line)
    for key, value in remaining.items():
        out.append(f"{key}={value}")
    return "\n".join(out) + "\n"
