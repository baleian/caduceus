"""Reusable Hypothesis strategies for Caduceus domain types (PBT-07).

Domain generators live here so every property test shares the same realistic,
constraint-respecting inputs instead of raw primitives.
"""

from __future__ import annotations

import string

from hypothesis import strategies as st

from caduceus.core.types import RESERVED_AGENT_NAMES, AgentRecord, AgentSpec, RegistryFile

_NAME_FIRST = string.ascii_lowercase + string.digits
_NAME_REST = _NAME_FIRST + "_-"


def agent_names() -> st.SearchStrategy[str]:
    return (
        st.builds(
            lambda first, rest: first + rest,
            st.sampled_from(_NAME_FIRST),
            st.text(alphabet=_NAME_REST, min_size=0, max_size=59),
        )
        .filter(lambda n: n not in RESERVED_AGENT_NAMES)
    )


def network_modes() -> st.SearchStrategy[str]:
    return st.sampled_from(["host", "bridge_hostgw", "none"])


def agent_specs() -> st.SearchStrategy[AgentSpec]:
    return st.builds(
        AgentSpec,
        name=agent_names(),
        docker_image=st.text(
            alphabet=string.ascii_letters + string.digits + ":/.-_", min_size=1, max_size=64
        ).filter(lambda s: s.strip()),
        network_mode=network_modes(),
        allow_private_urls=st.booleans(),
        cpu=st.one_of(st.none(), st.floats(min_value=0.5, max_value=32, allow_nan=False)),
        memory_mb=st.one_of(st.none(), st.integers(min_value=256, max_value=1 << 20)),
        disk_mb=st.one_of(st.none(), st.integers(min_value=1024, max_value=1 << 22)),
        persona=st.one_of(st.none(), st.text(max_size=200)),
    )


def token_hashes() -> st.SearchStrategy[str]:
    return st.text(alphabet="0123456789abcdef", min_size=64, max_size=64)


def agent_records() -> st.SearchStrategy[AgentRecord]:
    def build(spec: AgentSpec, port: int, key: str, token_hash: str) -> AgentRecord:
        return AgentRecord(
            spec=spec,
            profile_name=f"cad-{spec.name}",
            workspace_dir=f"/home/user/.caduceus/workspaces/{spec.name}",
            api_port=port,
            api_server_key=key,
            token_hash=token_hash,
            desired_state="stopped",
            created_at="2026-07-02T00:00:00Z",
        )

    return st.builds(
        build,
        agent_specs(),
        st.integers(min_value=1024, max_value=65535),
        st.text(alphabet="0123456789abcdef", min_size=32, max_size=32),
        token_hashes(),
    )


def registry_files() -> st.SearchStrategy[RegistryFile]:
    """Valid registries: unique names, ports and token hashes (I1–I3 hold)."""

    def assemble(records: list[AgentRecord]) -> RegistryFile:
        agents: dict[str, AgentRecord] = {}
        used_ports: set[int] = set()
        used_hashes: set[str] = set()
        port = 42800
        for i, rec in enumerate(records):
            if rec.spec.name in agents:
                continue
            while port in used_ports:
                port += 1
            unique_hash = f"{i:04x}" + rec.token_hash[4:]
            if unique_hash in used_hashes:
                continue
            used_ports.add(port)
            used_hashes.add(unique_hash)
            agents[rec.spec.name] = rec.model_copy(
                update={"api_port": port, "token_hash": unique_hash}
            )
        return RegistryFile(agents=agents)

    return st.builds(assemble, st.lists(agent_records(), max_size=8))
