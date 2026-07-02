"""P2 — agent name ↔ profile name round-trip (PBT-02 category: Round-trip)."""

from __future__ import annotations

import pytest
from hypothesis import given

from caduceus.core.errors import DomainValidationError
from caduceus.core.types import (
    agent_name_from_profile,
    profile_name_for,
    validate_agent_name,
)
from tests.property.strategies import agent_names


@given(agent_names())
def test_p2_profile_name_round_trip(name: str) -> None:
    assert agent_name_from_profile(profile_name_for(name)) == name


@given(agent_names())
def test_p2_profile_name_is_valid_hermes_profile_id(name: str) -> None:
    profile = profile_name_for(name)
    # hermes profile id rule: ^[a-z0-9][a-z0-9_-]{0,63}$
    assert len(profile) <= 64
    assert profile.startswith("cad-")
    validate_agent_name(name)  # still a valid agent name


@given(agent_names())
def test_p2_non_prefixed_profiles_are_rejected(name: str) -> None:
    with pytest.raises(DomainValidationError):
        agent_name_from_profile(name if not name.startswith("cad-") else "x" + name)
