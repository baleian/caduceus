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
