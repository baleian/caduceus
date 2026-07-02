"""Real-hermes integration tests (marker: integration — excluded by default).

Run with: ``uv run pytest -m integration``
Requires hermes CLI on PATH; docker checks skip gracefully when absent.

Uses an isolated HERMES_HOME? No — hermes profiles live under the real
``~/.hermes/profiles``; we use a throwaway ``cad-caduceus-itest`` profile and
delete it afterwards. The test never touches other profiles (FD1 namespace).
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from caduceus.core.hermes_adapter import HermesAdapter
from caduceus.core.ports import RealCommandRunner, RealFileStore
from caduceus.core.types import AgentSpec

pytestmark = pytest.mark.integration

PROFILE = "cad-caduceus-itest"
HERMES_HOME = Path.home() / ".hermes"


def hermes_available() -> bool:
    return shutil.which("hermes") is not None


@pytest.fixture
def adapter() -> HermesAdapter:
    if not hermes_available():
        pytest.skip("hermes CLI not on PATH")
    return HermesAdapter(RealCommandRunner(), RealFileStore(), hermes_home=HERMES_HOME)


async def test_profile_create_configure_delete_round_trip(adapter: HermesAdapter) -> None:
    if adapter._files.exists(adapter.profile_dir(PROFILE)):  # leftover from crash
        await adapter.delete_profile(PROFILE)

    await adapter.create_profile(PROFILE)
    try:
        assert adapter.profile_dir(PROFILE).is_dir()

        adapter.apply_managed_config(
            PROFILE,
            AgentSpec(name="caduceus-itest", network_mode="bridge_hostgw"),
            daemon_v1_url="http://127.0.0.1:4285/v1",
            workspace_dir=str(Path.home() / ".caduceus/workspaces/caduceus-itest"),
            default_model="hermes",
        )
        config_text = adapter.read_config_text(PROFILE)
        assert config_text is not None
        assert "custom" in config_text
        assert "--add-host=host.docker.internal:host-gateway" in config_text

        adapter.write_api_server_env(PROFILE, port=42899, key="k" * 32)
        adapter.write_gateway_token(PROFILE, "cad-caduceus-itest-" + "a" * 32)
        env_text = adapter._files.read_text(adapter.profile_dir(PROFILE) / ".env")
        assert "API_SERVER_PORT=42899" in env_text
        assert "OPENAI_API_KEY=cad-caduceus-itest-" in env_text

        adapter.write_soul(PROFILE, "# itest persona\n")
        assert adapter.read_soul(PROFILE).startswith("# itest persona")
    finally:
        await adapter.delete_profile(PROFILE)
    assert not adapter.profile_dir(PROFILE).exists()


async def test_preflight_reports_environment(adapter: HermesAdapter) -> None:
    report = await adapter.preflight()
    names = {c.name for c in report.checks}
    assert {"hermes-cli", "docker-daemon", "hermes-home"} <= names
    hermes_check = next(c for c in report.checks if c.name == "hermes-cli")
    assert hermes_check.ok  # fixture guarantees hermes exists
