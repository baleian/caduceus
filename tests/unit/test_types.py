"""Example-based validation tests for rules V1–V5 and invariants I1–I5."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from caduceus.core.errors import DomainValidationError
from caduceus.core.types import (
    AgentRecord,
    AgentSpec,
    RegistryFile,
    UpstreamConfig,
    validate_agent_name,
)

TOKEN_HASH_A = "a" * 64
TOKEN_HASH_B = "b" * 64


def make_record(
    name: str = "coder", port: int = 42800, token_hash: str = TOKEN_HASH_A
) -> AgentRecord:
    return AgentRecord(
        spec=AgentSpec(name=name),
        profile_name=f"cad-{name}",
        workspace_dir=f"/home/u/.caduceus/workspaces/{name}",
        api_port=port,
        api_server_key="k" * 32,
        token_hash=token_hash,
        created_at="2026-07-02T00:00:00Z",
    )


class TestV1AgentName:
    @pytest.mark.parametrize("bad", ["", "-x", "UPPER", "a" * 61, "한글", "a b", "a.b"])
    def test_rejects_invalid(self, bad: str) -> None:
        with pytest.raises(DomainValidationError):
            validate_agent_name(bad)

    def test_rejects_reserved_default(self) -> None:
        with pytest.raises(DomainValidationError):
            validate_agent_name("default")

    @pytest.mark.parametrize("ok", ["a", "coder", "a-b_c", "0agent", "a" * 60])
    def test_accepts_valid(self, ok: str) -> None:
        assert validate_agent_name(ok) == ok


class TestSpecValidation:
    def test_v2_empty_image(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            AgentSpec(name="x", docker_image="  ")

    def test_v2_control_chars(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            AgentSpec(name="x", docker_image="img\nname")

    def test_v3_network_mode(self) -> None:
        with pytest.raises(ValidationError):
            AgentSpec.model_validate({"name": "x", "network_mode": "bridge"})

    def test_v4_bounds(self) -> None:
        with pytest.raises(ValidationError):
            AgentSpec(name="x", memory_mb=64)
        with pytest.raises(ValidationError):
            AgentSpec(name="x", cpu=0)

    def test_v5_persona_size(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            AgentSpec(name="x", persona="가" * (64 * 1024))


class TestRecordInvariants:
    def test_i5_profile_mismatch(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            AgentRecord(
                spec=AgentSpec(name="coder"),
                profile_name="cad-other",
                workspace_dir="/w/coder",
                api_port=42800,
                api_server_key="k" * 32,
                token_hash=TOKEN_HASH_A,
                created_at="2026-07-02T00:00:00Z",
            )

    def test_i4_workspace_mismatch(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            AgentRecord(
                spec=AgentSpec(name="coder"),
                profile_name="cad-coder",
                workspace_dir="/w/other",
                api_port=42800,
                api_server_key="k" * 32,
                token_hash=TOKEN_HASH_A,
                created_at="2026-07-02T00:00:00Z",
            )


class TestRegistryInvariants:
    def test_i1_key_consistency(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            RegistryFile(agents={"other": make_record("coder")})

    def test_i2_duplicate_port(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            RegistryFile(
                agents={
                    "a": make_record("a", port=42800, token_hash=TOKEN_HASH_A),
                    "b": make_record("b", port=42800, token_hash=TOKEN_HASH_B),
                }
            )

    def test_i3_duplicate_token_hash(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            RegistryFile(
                agents={
                    "a": make_record("a", port=42800, token_hash=TOKEN_HASH_A),
                    "b": make_record("b", port=42801, token_hash=TOKEN_HASH_A),
                }
            )

    def test_valid_registry_ok(self) -> None:
        reg = RegistryFile(
            agents={
                "a": make_record("a", port=42800, token_hash=TOKEN_HASH_A),
                "b": make_record("b", port=42801, token_hash=TOKEN_HASH_B),
            }
        )
        assert len(reg.agents) == 2


class TestUpstreamConfig:
    def test_v5_url(self) -> None:
        with pytest.raises((DomainValidationError, ValidationError)):
            UpstreamConfig(base_url="ftp://nope")

    def test_trailing_slash_normalized(self) -> None:
        assert UpstreamConfig(
            base_url="http://localhost:11434/v1/", default_model="m"
        ).base_url.endswith("/v1")


class TestUpstreamConfigHardening:
    def test_default_model_is_required(self) -> None:
        import pytest as _pytest
        from pydantic import ValidationError

        with _pytest.raises(ValidationError):
            UpstreamConfig(base_url="http://x/v1")  # type: ignore[call-arg]

    def test_default_model_must_be_non_empty(self) -> None:
        import pytest as _pytest

        with _pytest.raises(DomainValidationError):
            UpstreamConfig(base_url="http://x/v1", default_model="   ")

    def test_extra_headers_reject_control_characters(self) -> None:
        import pytest as _pytest

        with _pytest.raises(DomainValidationError):
            UpstreamConfig(
                base_url="http://x/v1", default_model="m",
                extra_headers={"x-a": "v\r\nInjected: 1"},
            )

    def test_extra_headers_reject_bad_names_and_hop_headers(self) -> None:
        import pytest as _pytest

        with _pytest.raises(DomainValidationError):
            UpstreamConfig(
                base_url="http://x/v1", default_model="m",
                extra_headers={"bad name": "v"},
            )
        with _pytest.raises(DomainValidationError):
            UpstreamConfig(
                base_url="http://x/v1", default_model="m",
                extra_headers={"Host": "evil"},
            )
