"""PU2-4 — chat relay path containment (security invariant)."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from caduceus.control.agent_proxy import ALLOWED_PREFIXES, allowed_subpath, target_url


@given(st.text(max_size=120))
def test_pu2_4_arbitrary_paths_never_escape(path: str) -> None:
    if allowed_subpath(path):
        # accepted paths always produce a loopback URL under the agent port
        url = target_url(42800, path)
        assert url.startswith("http://127.0.0.1:42800/")
        # and cannot smuggle traversal or absolute redirects
        assert ".." not in path
        assert not path.startswith("/")
        assert "://" not in path


@given(st.sampled_from(list(ALLOWED_PREFIXES)), st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789/-", max_size=40,
))
def test_pu2_4_allowed_prefixes_accepted_unless_traversal(prefix: str, rest: str) -> None:
    path = prefix + rest
    if ".." in path or "//" in path:
        assert not allowed_subpath("/" + path)  # still rejected with leading slash
    else:
        assert allowed_subpath(path)


def test_pu2_4_examples() -> None:
    assert allowed_subpath("v1/chat/completions")
    assert allowed_subpath("api/sessions")
    assert allowed_subpath("api/sessions/abc/chat/stream")
    assert allowed_subpath("health")
    assert not allowed_subpath("api/config")  # not allowlisted
    assert not allowed_subpath("../etc/passwd")
    assert not allowed_subpath("/v1/chat")
    assert not allowed_subpath("v1/../api/config")
    assert not allowed_subpath("http://evil/")
