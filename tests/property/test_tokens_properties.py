"""P4 — token lifecycle invariants (PBT-03 category: Invariant)."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from caduceus.core.tokens import TokenResolver, hash_token, issue_token
from tests.property.strategies import agent_names


@given(agent_names())
def test_p4_issue_then_resolve_identity(name: str) -> None:
    issued = issue_token(name)
    resolver = TokenResolver()
    resolver.rebuild({issued.token_hash: name})
    assert resolver.resolve(issued.plaintext) == name


@given(agent_names())
def test_p4_hash_differs_from_plaintext_and_is_stable(name: str) -> None:
    issued = issue_token(name)
    assert issued.token_hash != issued.plaintext
    assert hash_token(issued.plaintext) == issued.token_hash
    assert len(issued.token_hash) == 64


@given(agent_names())
def test_p4_rotation_invalidates_old_token(name: str) -> None:
    old = issue_token(name)
    new = issue_token(name)
    resolver = TokenResolver()
    resolver.rebuild({new.token_hash: name})  # rotation = rebuild without old hash
    assert resolver.resolve(old.plaintext) is None
    assert resolver.resolve(new.plaintext) == name


@given(agent_names(), st.text(min_size=1, max_size=80))
def test_p4_unknown_bearer_never_resolves(name: str, random_bearer: str) -> None:
    issued = issue_token(name)
    resolver = TokenResolver()
    resolver.rebuild({issued.token_hash: name})
    if random_bearer != issued.plaintext:
        assert resolver.resolve(random_bearer) is None
