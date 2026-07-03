"""Example-based render tests: comment preservation snapshot, drift, env safety."""

from __future__ import annotations

import pytest

from caduceus.core.errors import DomainValidationError
from caduceus.core.render import (
    diff_managed,
    managed_config,
    merge_config_text,
    set_env_lines,
)
from caduceus.core.types import AgentSpec

# Shaped like hermes' cli-config.yaml.example: comments + unmanaged sections.
HERMES_STYLE_CONFIG = """\
# Hermes Agent CLI Configuration
# Environment variables in .env take precedence.

model:
  # my custom note about the default model
  default: "anthropic/claude-opus-4.6"
  provider: "auto"

# user's own section
browser:
  inactivity_timeout: 120

terminal:
  backend: "local"
  cwd: "."  # keep my comment
"""


def make_managed() -> dict:
    return managed_config(
        AgentSpec(name="coder", network_mode="bridge_hostgw"),
        daemon_v1_url="http://127.0.0.1:4285/v1",
        workspace_dir="/home/u/.caduceus/workspaces/coder",
        default_model="hermes-large",
    )


def test_merge_preserves_comments_and_unmanaged_sections() -> None:
    from ruamel.yaml import YAML

    merged = merge_config_text(HERMES_STYLE_CONFIG, make_managed())
    # comments and user formatting survive (ruamel even keeps the original
    # quoting style when replacing scalar values — that's the point of FD2)
    assert "# Hermes Agent CLI Configuration" in merged
    assert "# user's own section" in merged
    assert "# keep my comment" in merged
    loaded = YAML().load(merged)
    assert loaded["browser"]["inactivity_timeout"] == 120  # unmanaged preserved
    assert loaded["model"]["provider"] == "custom"  # managed replaced
    assert loaded["model"]["base_url"] == "http://127.0.0.1:4285/v1"
    assert loaded["terminal"]["backend"] == "docker"
    assert list(loaded["terminal"]["docker_extra_args"]) == [
        "--add-host=host.docker.internal:host-gateway"
    ]


def test_merge_from_empty_creates_document() -> None:
    merged = merge_config_text(None, make_managed())
    assert "provider: custom" in merged
    assert "container_persistent: true" in merged


def test_merge_rejects_non_mapping_root() -> None:
    with pytest.raises(DomainValidationError):
        merge_config_text("- just\n- a\n- list\n", make_managed())


def test_diff_managed_reports_drift_then_clean_after_merge() -> None:
    managed = make_managed()
    drift_before = diff_managed(HERMES_STYLE_CONFIG, managed)
    assert any(key == "model.provider" for key, _, _ in drift_before)
    merged = merge_config_text(HERMES_STYLE_CONFIG, managed)
    assert diff_managed(merged, managed) == []


def test_env_rejects_multiline_value_injection() -> None:
    with pytest.raises(DomainValidationError):
        set_env_lines("A=1\n", {"OPENAI_API_KEY": "x\nEVIL=1"})


def test_env_rejects_bad_key() -> None:
    with pytest.raises(DomainValidationError):
        set_env_lines(None, {"1BAD KEY": "x"})


def test_env_replaces_existing_key_in_place() -> None:
    result = set_env_lines("OPENAI_API_KEY=old\nOTHER=1\n", {"OPENAI_API_KEY": "new"})
    assert result.count("OPENAI_API_KEY") == 1
    assert "OPENAI_API_KEY=new" in result
    assert "OTHER=1" in result


def test_managed_model_renders_api_key_env_reference() -> None:
    """hermes' custom provider reads model.api_key from config (not env vars),
    so the managed tree must reference the gateway token via ${OPENAI_API_KEY}
    — expanded by hermes from the profile .env, never stored literally."""
    managed = make_managed()
    assert managed["model"]["api_key"] == "${OPENAI_API_KEY}"
    from ruamel.yaml import YAML

    merged = merge_config_text(HERMES_STYLE_CONFIG, make_managed())
    assert YAML().load(merged)["model"]["api_key"] == "${OPENAI_API_KEY}"


def test_workspace_mounted_via_native_cwd_passthrough() -> None:
    """P1/P2: the managed workspace is mounted through hermes' native
    docker_mount_cwd_to_workspace, not a hand-written bind mount.

    Contract that keeps the flag from being a no-op: terminal.cwd is the HOST
    workspace path (so hermes captures it as host_cwd and mounts it to
    /workspace), and docker_volumes is empty (a ":/workspace" entry would win
    and make hermes skip the cwd auto-mount)."""
    managed = make_managed()
    terminal = managed["terminal"]
    assert terminal["docker_mount_cwd_to_workspace"] is True
    assert terminal["cwd"] == "/home/u/.caduceus/workspaces/coder"  # HOST path
    assert terminal["docker_volumes"] == []  # no explicit :/workspace mount
    # host path must match hermes' _HOST_CWD_PREFIXES so it is honored as host_cwd
    assert terminal["cwd"].startswith(("/home/", "/Users/"))


def test_switching_from_explicit_mount_clears_stale_docker_volumes() -> None:
    """Existing profiles carried an explicit docker_volumes bind; re-applying
    the managed tree must force-clear it (else the flag stays a no-op)."""
    from ruamel.yaml import YAML

    legacy = (
        "terminal:\n"
        "  backend: docker\n"
        "  cwd: /workspace\n"
        "  docker_volumes:\n"
        "  - /home/u/.caduceus/workspaces/coder:/workspace\n"
    )
    merged = merge_config_text(legacy, make_managed())
    loaded = YAML().load(merged)
    assert list(loaded["terminal"]["docker_volumes"]) == []
    assert loaded["terminal"]["cwd"] == "/home/u/.caduceus/workspaces/coder"
    assert loaded["terminal"]["docker_mount_cwd_to_workspace"] is True
    assert diff_managed(merged, make_managed()) == []  # clean after re-apply


def test_managed_config_renders_unattended_defaults() -> None:
    """approvals off (quoted — YAML-1.1 bool trap) + hard_stop guardrail on."""
    from ruamel.yaml import YAML

    merged = merge_config_text(None, make_managed())
    assert "mode: 'off'" in merged or 'mode: "off"' in merged  # never bare `off`
    loaded = YAML().load(merged)
    assert loaded["approvals"]["mode"] == "off"  # str, not bool False
    assert loaded["tool_loop_guardrails"]["hard_stop_enabled"] is True


def test_managed_approvals_follows_spec_and_roundtrips_drift_free() -> None:
    from caduceus.core.render import diff_managed

    managed = managed_config(
        AgentSpec(name="coder", approvals_mode="manual"),
        daemon_v1_url="http://127.0.0.1:4285/v1",
        workspace_dir="/w/coder",
        default_model="m",
    )
    merged = merge_config_text(None, managed)
    assert diff_managed(merged, managed) == []  # quoting survives the round-trip


def test_default_api_server_toolsets_include_terminal() -> None:
    from caduceus.core.render import DEFAULT_API_SERVER_TOOLSETS

    assert "terminal" in DEFAULT_API_SERVER_TOOLSETS  # the whole point (#49622)
    assert len(set(DEFAULT_API_SERVER_TOOLSETS)) == len(DEFAULT_API_SERVER_TOOLSETS)
