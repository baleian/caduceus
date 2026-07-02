"""P5/P6/P7/P10 — config merge and .env editing properties."""

from __future__ import annotations

import string

from hypothesis import given
from hypothesis import strategies as st
from ruamel.yaml import YAML

from caduceus.core.render import (
    managed_config,
    merge_config_text,
    network_extra_args,
    set_env_lines,
)
from caduceus.core.types import AgentSpec
from tests.property.strategies import agent_specs


def load_yaml(text: str) -> dict:
    return YAML().load(text) or {}


def make_managed(spec: AgentSpec) -> dict:
    return managed_config(
        spec,
        daemon_v1_url="http://127.0.0.1:4285/v1",
        workspace_dir=f"/home/u/.caduceus/workspaces/{spec.name}",
        default_model="hermes",
    )


# Arbitrary-ish user config bodies that remain valid YAML mappings.
user_configs = st.dictionaries(
    keys=st.text(alphabet=string.ascii_lowercase, min_size=1, max_size=10),
    values=st.one_of(st.integers(), st.text(alphabet=string.printable[:60], max_size=20)),
    max_size=5,
)


@given(agent_specs(), user_configs)
def test_p5_merge_is_idempotent(spec: AgentSpec, user_cfg: dict) -> None:
    yaml_text = merge_config_text(None, {"user": user_cfg} if user_cfg else {})
    once = merge_config_text(yaml_text, make_managed(spec))
    twice = merge_config_text(once, make_managed(spec))
    assert once == twice


@given(agent_specs(), user_configs)
def test_p5_merge_preserves_unmanaged_keys(spec: AgentSpec, user_cfg: dict) -> None:
    base = merge_config_text(None, {"custom_section": user_cfg} if user_cfg else {})
    merged = merge_config_text(base, make_managed(spec))
    loaded = load_yaml(merged)
    if user_cfg:
        assert dict(loaded["custom_section"]) == user_cfg


@given(agent_specs())
def test_p6_managed_keys_match_render(spec: AgentSpec) -> None:
    managed = make_managed(spec)
    merged = merge_config_text("# user comment\nfoo: 1\n", managed)
    loaded = load_yaml(merged)
    assert loaded["model"]["provider"] == "custom"
    assert loaded["model"]["base_url"] == "http://127.0.0.1:4285/v1"
    assert loaded["terminal"]["backend"] == "docker"
    assert loaded["terminal"]["container_persistent"] is True
    assert loaded["terminal"]["docker_image"] == spec.docker_image
    assert list(loaded["terminal"]["docker_extra_args"]) == network_extra_args(
        spec.network_mode
    )
    assert loaded["foo"] == 1


env_keys = st.text(alphabet=string.ascii_uppercase + "_", min_size=1, max_size=20).filter(
    lambda k: not k[0].isdigit() and k.replace("_", "").isalnum()
)
env_values = st.text(
    alphabet=string.ascii_letters + string.digits + "-_.:/", max_size=30
)


@given(st.dictionaries(env_keys, env_values, min_size=1, max_size=5))
def test_p7_env_set_idempotent(updates: dict[str, str]) -> None:
    once = set_env_lines(None, updates)
    twice = set_env_lines(once, updates)
    assert once == twice


@given(st.dictionaries(env_keys, env_values, min_size=1, max_size=5))
def test_p7_env_set_preserves_other_lines(updates: dict[str, str]) -> None:
    existing = "# comment line\nUNRELATED_KEY=keepme\n\n"
    result = set_env_lines(existing, updates)
    assert "# comment line" in result
    assert "UNRELATED_KEY=keepme" in result
    for key, value in updates.items():
        if key != "UNRELATED_KEY":
            assert f"{key}={value}" in result


@given(st.sampled_from(["host", "bridge_hostgw", "none"]))
def test_p10_network_mode_table(mode: str) -> None:
    expected = {
        "host": ["--network=host"],
        "bridge_hostgw": ["--add-host=host.docker.internal:host-gateway"],
        "none": ["--network=none"],
    }
    assert network_extra_args(mode) == expected[mode]  # type: ignore[arg-type]
