"""PU3-7 — argument-parsing contract: valid command lines never exit 2 for
parsing reasons; unknown flags and mutual-exclusion violations always exit 2."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from caduceus.cli.client import ApiClient, ClientConfig
from caduceus.cli.context import AppState
from caduceus.cli.main import main

VALID_READ_COMMANDS = [
    ["agent", "ls"],
    ["agent", "ls", "--json"],
    ["agent", "status", "bob"],
    ["agent", "logs", "bob", "-n", "5"],
    ["agent", "soul", "bob"],
    ["agent", "skills", "bob"],
    ["agent", "toolsets", "bob"],
    ["gateway", "status"],
    ["gateway", "upstream", "get"],
    ["job", "ls"],
    ["job", "status", "job-1"],
]

EXCLUSION_VIOLATIONS = [
    ["chat", "bob", "--session", "s", "--new"],
    ["agent", "soul", "bob", "--edit", "--set", "f"],
    ["agent", "skills", "bob", "--enable", "a", "--disable", "b"],
]


@pytest.fixture(autouse=True)
def stub_client(monkeypatch: pytest.MonkeyPatch) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        empties: dict[str, object] = {
            "/api/agents": [],
            "/api/jobs": [],
            "/api/gateway": {"listen": {}, "upstream": {}, "traffic": {"agents": {}}},
        }
        path = request.url.path
        if path in empties:
            return httpx.Response(200, json=empties[path])
        if path.endswith("/soul"):
            return httpx.Response(200, json={"content": ""})
        if path.endswith("/skills"):
            return httpx.Response(200, json={"skills": []})
        if path.endswith("/toolsets"):
            return httpx.Response(200, json={"toolsets": []})
        if path.endswith("/logs"):
            return httpx.Response(200, json={"lines": []})
        if "/api/jobs/" in path:
            return httpx.Response(200, json={"id": "job-1", "state": "done", "steps": []})
        if "/api/agents/" in path:
            return httpx.Response(200, json={"record": {"spec": {}}, "status": {}})
        return httpx.Response(200, json={})

    def patched(self: AppState) -> ApiClient:
        return ApiClient(
            ClientConfig(base_url="http://test", admin_token="t", home=Path("/tmp/x")),
            transport=httpx.MockTransport(handler),
            sleep=lambda _: None,
        )

    monkeypatch.setattr(AppState, "client", patched)


@settings(max_examples=30, deadline=None)
@given(st.sampled_from(VALID_READ_COMMANDS))
def test_valid_commands_never_exit_usage(argv: list[str]) -> None:
    assert main(list(argv)) != 2


@settings(max_examples=30, deadline=None)
@given(
    st.sampled_from(VALID_READ_COMMANDS),
    st.text(alphabet="abcdefghij", min_size=3, max_size=10),
)
def test_unknown_flags_always_exit_usage(argv: list[str], flag: str) -> None:
    assert main([*argv, f"--zz-{flag}"]) == 2


@settings(max_examples=10, deadline=None)
@given(st.sampled_from(EXCLUSION_VIOLATIONS))
def test_mutual_exclusions_exit_usage(argv: list[str]) -> None:
    assert main(list(argv)) == 2
