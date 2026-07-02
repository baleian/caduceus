"""Example-based token tests: masking, format, empty-resolver behavior."""

from __future__ import annotations

from caduceus.core.tokens import TokenResolver, issue_token


def test_issued_token_repr_masks_plaintext() -> None:
    issued = issue_token("coder")
    assert issued.plaintext not in repr(issued)
    assert "***" in repr(issued)


def test_token_format() -> None:
    issued = issue_token("coder")
    assert issued.plaintext.startswith("cad-coder-")
    random_part = issued.plaintext.rsplit("-", 1)[-1]
    assert len(random_part) == 32  # 128 bits hex


def test_empty_resolver_rejects_everything() -> None:
    resolver = TokenResolver()
    assert resolver.resolve("anything") is None


def test_two_issues_differ() -> None:
    a, b = issue_token("coder"), issue_token("coder")
    assert a.plaintext != b.plaintext
    assert a.token_hash != b.token_hash
