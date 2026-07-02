"""HermesAdapter tests with fake runner/filestore (argv, timeouts, errors, L5)."""

from __future__ import annotations

from pathlib import Path

import pytest

from caduceus.core.errors import ConflictError, DockerError, HermesError
from caduceus.core.hermes_adapter import HermesAdapter, redact
from caduceus.core.ports import CommandResult
from caduceus.core.types import AgentSpec
from tests.unit.fakes import InMemoryFileStore, ScriptedRunner

HOME = Path("/home/u/.hermes")
PROFILE = "cad-coder"
PROFILE_DIR = HOME / "profiles" / PROFILE


def make_adapter(
    runner: ScriptedRunner | None = None, files: InMemoryFileStore | None = None
) -> tuple[HermesAdapter, ScriptedRunner, InMemoryFileStore]:
    runner = runner or ScriptedRunner()
    files = files or InMemoryFileStore()
    return HermesAdapter(runner, files, hermes_home=HOME), runner, files


class TestProfileLifecycle:
    async def test_create_profile_invokes_hermes_cli(self) -> None:
        adapter, runner, files = make_adapter()

        # simulate hermes creating the dir as a side effect
        async def run_and_create(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
            runner.calls.append(list(argv))
            files.mkdir(PROFILE_DIR)
            return CommandResult(0, "", "")

        runner.run = run_and_create  # type: ignore[method-assign]
        await adapter.create_profile(PROFILE)
        assert runner.calls == [["hermes", "profile", "create", PROFILE]]

    async def test_create_existing_profile_conflicts_without_cli_call(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        with pytest.raises(ConflictError):  # L5
            await adapter.create_profile(PROFILE)
        assert runner.calls == []

    async def test_create_failure_raises_hermes_error_with_redacted_stderr(self) -> None:
        adapter, runner, files = make_adapter()
        runner.on(
            "hermes", "profile", "create",
            result=CommandResult(1, "", "boom secret deadbeefdeadbeefdeadbeefdeadbeef"),
        )
        with pytest.raises(HermesError) as exc_info:
            await adapter.create_profile(PROFILE)
        assert "deadbeef" not in str(exc_info.value)

    async def test_delete_is_idempotent_when_profile_absent(self) -> None:
        adapter, runner, _ = make_adapter()
        await adapter.delete_profile(PROFILE)
        assert runner.calls == []

    async def test_delete_passes_yes_flag(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        await adapter.delete_profile(PROFILE)
        assert runner.calls == [["hermes", "profile", "delete", PROFILE, "--yes"]]


class TestManagedConfigAndEnv:
    def test_apply_managed_config_writes_merged_yaml(self) -> None:
        adapter, _, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        files.write_text_atomic(PROFILE_DIR / "config.yaml", "# user note\nfoo: 1\n")
        adapter.apply_managed_config(
            PROFILE,
            AgentSpec(name="coder"),
            daemon_v1_url="http://127.0.0.1:4285/v1",
            workspace_dir="/w/coder",
            default_model=None,
        )
        text = files.read_text(PROFILE_DIR / "config.yaml")
        assert "# user note" in text
        assert "--network=host" in text  # AD-2 default

    def test_write_api_server_env_sets_mode_600_and_loopback(self) -> None:
        adapter, _, files = make_adapter()
        adapter.write_api_server_env(PROFILE, port=42800, key="k" * 32)
        env_path = PROFILE_DIR / ".env"
        text = files.read_text(env_path)
        assert "API_SERVER_ENABLED=1" in text
        assert "API_SERVER_HOST=127.0.0.1" in text
        assert "API_SERVER_PORT=42800" in text
        assert files.modes[str(env_path)] == 0o600

    def test_write_gateway_token_replaces_existing(self) -> None:
        adapter, _, files = make_adapter()
        files.write_text_atomic(PROFILE_DIR / ".env", "OPENAI_API_KEY=old\nKEEP=1\n")
        adapter.write_gateway_token(PROFILE, "cad-coder-" + "a" * 32)
        text = files.read_text(PROFILE_DIR / ".env")
        assert "OPENAI_API_KEY=cad-coder-" + "a" * 32 in text
        assert "KEEP=1" in text
        assert text.count("OPENAI_API_KEY") == 1


class TestSoulSkillsToolsets:
    def test_soul_round_trip(self) -> None:
        adapter, _, files = make_adapter()
        assert adapter.read_soul(PROFILE) == ""
        adapter.write_soul(PROFILE, "# Persona\nBe helpful.\n")
        assert adapter.read_soul(PROFILE).startswith("# Persona")

    def test_skills_listing_respects_disabled_config(self) -> None:
        adapter, _, files = make_adapter()
        files.mkdir(PROFILE_DIR / "skills" / "web-search")
        files.mkdir(PROFILE_DIR / "skills" / "coder")
        files.write_text_atomic(
            PROFILE_DIR / "config.yaml", "skills:\n  disabled:\n  - coder\n"
        )
        skills = {s.name: s.enabled for s in adapter.list_skills(PROFILE)}
        assert skills == {"web-search": True, "coder": False}

    def test_set_skill_enabled_updates_disabled_list(self) -> None:
        adapter, _, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        adapter.set_skill_enabled(PROFILE, "coder", enabled=False)
        adapter.set_skill_enabled(PROFILE, "web", enabled=False)
        adapter.set_skill_enabled(PROFILE, "coder", enabled=True)
        text = files.read_text(PROFILE_DIR / "config.yaml")
        assert "web" in text
        assert adapter.get_toolsets(PROFILE) == []

    def test_toolsets_round_trip_uses_platform_toolsets_key(self) -> None:
        adapter, _, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        adapter.set_toolsets(PROFILE, ["hermes-cli", "spotify"])
        assert adapter.get_toolsets(PROFILE) == ["hermes-cli", "spotify"]
        assert "platform_toolsets" in files.read_text(PROFILE_DIR / "config.yaml")


class TestContainers:
    async def test_remove_containers_filters_by_profile_label(self) -> None:
        adapter, runner, _ = make_adapter()
        runner.on("docker", "ps", result=CommandResult(0, "abc123\ndef456\n", ""))
        count = await adapter.remove_containers(PROFILE)
        assert count == 2
        assert runner.calls[0] == [
            "docker", "ps", "-aq", "--filter", f"label=hermes-profile={PROFILE}",
        ]
        assert runner.calls[1] == ["docker", "rm", "-f", "abc123", "def456"]

    async def test_remove_containers_none_found(self) -> None:
        adapter, runner, _ = make_adapter()
        runner.on("docker", "ps", result=CommandResult(0, "\n", ""))
        assert await adapter.remove_containers(PROFILE) == 0
        assert len(runner.calls) == 1

    async def test_docker_failure_raises(self) -> None:
        adapter, runner, _ = make_adapter()
        runner.on("docker", "ps", result=CommandResult(1, "", "cannot connect"))
        with pytest.raises(DockerError):
            await adapter.remove_containers(PROFILE)


class TestMisc:
    def test_gateway_argv(self) -> None:
        adapter, _, _ = make_adapter()
        assert adapter.gateway_argv(PROFILE) == ["hermes", "-p", PROFILE, "gateway"]

    async def test_preflight_reports_failures_without_raising(self) -> None:
        adapter, runner, _ = make_adapter()
        runner.on("hermes", "--version", result=CommandResult(0, "hermes 1.2.3\n", ""))
        runner.on("docker", "version", result=CommandResult(1, "", "no daemon"))
        report = await adapter.preflight()
        by_name = {c.name: c for c in report.checks}
        assert by_name["hermes-cli"].ok
        assert by_name["hermes-cli"].detail == "hermes 1.2.3"
        assert not by_name["docker-daemon"].ok
        assert not report.ok

    def test_redact_masks_long_hex(self) -> None:
        assert "***" in redact("token=" + "ab" * 20)
        assert "ab" * 20 not in redact("token=" + "ab" * 20)
