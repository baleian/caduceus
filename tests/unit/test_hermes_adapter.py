"""HermesAdapter tests with fake runner/filestore (argv, timeouts, errors, L5)."""

from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from caduceus.core.errors import ConflictError, DockerError, HermesError
from caduceus.core.hermes_adapter import HermesAdapter, redact
from caduceus.core.ports import CommandResult
from caduceus.core.types import AgentSpec
from tests.unit.fakes import (
    FakeClock,
    FakeProc,
    FakeSignaller,
    InMemoryFileStore,
    ScriptedRunner,
)

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

    async def test_delete_reclaims_root_owned_dir_then_retries(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        delete_calls = 0

        async def run(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
            nonlocal delete_calls
            runner.calls.append(list(argv))
            if argv[:3] == ["hermes", "profile", "delete"]:
                delete_calls += 1
                if delete_calls == 1:  # root-owned artifacts block rmtree
                    return CommandResult(1, "", "PermissionError: [Errno 13]")
                return CommandResult(0, "", "")
            return CommandResult(0, "", "")  # docker run chown

        runner.run = run  # type: ignore[method-assign]
        await adapter.delete_profile(PROFILE, image="ubuntu:24.04")

        assert delete_calls == 2  # failed once, retried after reclaim
        chown = [c for c in runner.calls if c[:2] == ["docker", "run"]]
        assert len(chown) == 1
        assert "ubuntu:24.04" in chown[0]
        assert f"{PROFILE_DIR}:/target" in chown[0]
        assert chown[0][-4:] == ["chown", "-R", f"{os.getuid()}:{os.getgid()}", "/target"]

    async def test_delete_raises_when_reclaim_does_not_help(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)

        async def run(argv, *, timeout_s, env=None, cwd=None):  # type: ignore[no-untyped-def]
            runner.calls.append(list(argv))
            if argv[:3] == ["hermes", "profile", "delete"]:
                return CommandResult(1, "", "PermissionError deadbeefdeadbeefdeadbeefdeadbeef")
            return CommandResult(0, "", "")  # chown "succeeds" but dir still stuck

        runner.run = run  # type: ignore[method-assign]
        with pytest.raises(HermesError) as exc:
            await adapter.delete_profile(PROFILE, image="ubuntu:24.04")
        assert "deadbeef" not in str(exc.value)  # stderr redacted
        assert sum(1 for c in runner.calls if c[:3] == ["hermes", "profile", "delete"]) == 2

    async def test_delete_without_image_raises_without_reclaim(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        runner.on("hermes", "profile", "delete", result=CommandResult(1, "", "boom"))
        with pytest.raises(HermesError):
            await adapter.delete_profile(PROFILE)  # no image → nothing to reclaim with
        assert not any(c[:2] == ["docker", "run"] for c in runner.calls)

    async def test_reclaim_ownership_noop_when_profile_absent(self) -> None:
        adapter, runner, _ = make_adapter()
        assert await adapter.reclaim_profile_ownership(PROFILE, image="ubuntu") is True
        assert runner.calls == []

    async def test_reclaim_ownership_false_on_docker_failure(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(PROFILE_DIR)
        runner.on("docker", "run", result=CommandResult(1, "", "no such image"))
        assert await adapter.reclaim_profile_ownership(PROFILE, image="ubuntu") is False

    def test_seed_sandbox_profile_writes_once_and_respects_user_edits(self) -> None:
        adapter, _, files = make_adapter()
        adapter.seed_sandbox_profile(PROFILE)
        path = f"{PROFILE_DIR}/sandboxes/docker/default/home/.profile"
        assert "/usr/games" in files.files[path]  # Debian games-dir PATH fix
        files.files[path] = "# my custom profile\n"
        adapter.seed_sandbox_profile(PROFILE)  # second call must not clobber
        assert files.files[path] == "# my custom profile\n"


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

    async def test_preflight_all_checks_pass(self) -> None:
        adapter, runner, files = make_adapter()
        files.mkdir(HOME)
        runner.on("hermes", "--version", result=CommandResult(0, "hermes 1.2.3\n", ""))
        runner.on("docker", "version", result=CommandResult(0, "27\n", ""))
        report = await adapter.preflight()
        assert {c.name for c in report.checks} == {"hermes-cli", "docker-daemon", "hermes-home"}
        assert report.ok

    def test_redact_masks_long_hex(self) -> None:
        assert "***" in redact("token=" + "ab" * 20)
        assert "ab" * 20 not in redact("token=" + "ab" * 20)


REAP_PROFILE = "cad-reap"
REAP_CMDLINE = ["/x/hermes", "-p", REAP_PROFILE, "gateway"]


class TestReapGateway:
    def _adapter(
        self, signaller: FakeSignaller
    ) -> tuple[HermesAdapter, InMemoryFileStore]:
        files = InMemoryFileStore()
        adapter = HermesAdapter(
            ScriptedRunner(), files, hermes_home=HOME, signaller=signaller
        )
        return adapter, files

    def _write_pidfile(self, files: InMemoryFileStore, data: object) -> None:
        path = HOME / "profiles" / REAP_PROFILE / "gateway.pid"
        files.write_text_atomic(path, json.dumps(data))

    def _pidfile(self, **overrides: object) -> dict[str, object]:
        data: dict[str, object] = {
            "pid": 123,
            "kind": "hermes-gateway",
            "argv": ["/x/hermes", "gateway"],
            "start_time": 100,
        }
        data.update(overrides)
        return data

    async def test_absent_when_no_pidfile(self) -> None:
        sig = FakeSignaller()
        adapter, _ = self._adapter(sig)
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "absent"
        assert sig.signals == []

    async def test_absent_when_malformed_pidfile(self) -> None:
        sig = FakeSignaller()
        adapter, files = self._adapter(sig)
        files.write_text_atomic(
            HOME / "profiles" / REAP_PROFILE / "gateway.pid", "not-json{"
        )
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "absent"
        assert sig.signals == []

    async def test_absent_when_wrong_kind(self) -> None:
        sig = FakeSignaller({123: FakeProc()})
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile(kind="something-else"))
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "absent"
        assert sig.signals == []

    async def test_dead_when_pid_not_alive(self) -> None:
        sig = FakeSignaller({123: FakeProc(alive=False)})
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile())
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "dead"
        assert sig.signals == []

    async def test_mismatch_start_time_never_signals(self) -> None:
        sig = FakeSignaller(
            {123: FakeProc(start_time=999, cmdline=REAP_CMDLINE)}
        )
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile(start_time=100))
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "mismatch"
        assert sig.signals == []

    async def test_mismatch_cmdline_never_signals(self) -> None:
        # live process is a gateway for a DIFFERENT profile → do not touch it
        sig = FakeSignaller(
            {123: FakeProc(start_time=100, cmdline=["/x/hermes", "-p", "cad-other", "gateway"])}
        )
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile(start_time=100))
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "mismatch"
        assert sig.signals == []

    async def test_mismatch_when_start_time_missing_from_pidfile(self) -> None:
        sig = FakeSignaller({123: FakeProc(start_time=100, cmdline=REAP_CMDLINE)})
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile(start_time=None))
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "mismatch"
        assert sig.signals == []

    async def test_graceful_sigterm(self) -> None:
        sig = FakeSignaller(
            {123: FakeProc(start_time=100, cmdline=REAP_CMDLINE, dies_on="SIGTERM")}
        )
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile())
        assert await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock()) == "terminated"
        assert sig.signals == [(123, "SIGTERM")]

    async def test_escalates_to_sigkill(self) -> None:
        sig = FakeSignaller(
            {123: FakeProc(start_time=100, cmdline=REAP_CMDLINE, dies_on="SIGKILL")}
        )
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile())
        out = await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock(), grace_s=0.5)
        assert out == "terminated"
        assert sig.signals == [(123, "SIGTERM"), (123, "SIGKILL")]

    async def test_survives_even_sigkill(self) -> None:
        sig = FakeSignaller(
            {123: FakeProc(start_time=100, cmdline=REAP_CMDLINE, dies_on=None)}
        )
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile())
        out = await adapter.reap_gateway(REAP_PROFILE, clock=FakeClock(), grace_s=0.5)
        assert out == "survived"
        assert sig.signals == [(123, "SIGTERM"), (123, "SIGKILL")]

    def test_read_pidinfo_rejects_bool_pid(self) -> None:
        sig = FakeSignaller()
        adapter, files = self._adapter(sig)
        self._write_pidfile(files, self._pidfile(pid=True))
        assert adapter.read_gateway_pidinfo(REAP_PROFILE) is None

