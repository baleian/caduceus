"""Hermes Adapter (C6) — the ONLY place Caduceus touches hermes (P1/P3).

Everything here is either a hermes CLI invocation (argv arrays, timeouts — E1)
or a file edit inside the profile's HERMES_HOME using hermes' own conventions,
verified against hermes source (hermes-research.md):

- profiles:            ``hermes profile create|delete <name> [--yes]``
- model routing:       config.yaml ``model.provider/base_url/default``
- terminal backend:    config.yaml ``terminal.*`` (docker, persistent, extra args)
- api_server + token:  profile ``.env`` (``API_SERVER_*``, ``OPENAI_API_KEY``)
- persona:             ``SOUL.md``
- skills toggle:       config.yaml ``skills.disabled`` (hermes_cli/skills_config.py)
- toolsets:            config.yaml ``platform_toolsets.<platform>`` (tools_config.py)
- containers:          labeled ``hermes-profile=<profile>`` (tools/environments/docker.py)
"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from caduceus.core.errors import (
    CaduceusError,
    ConflictError,
    DockerError,
    HermesError,
    NotFoundError,
)
from caduceus.core.ports import (
    Clock,
    CommandRunner,
    FileStore,
    ProcessSignaller,
    RealProcessSignaller,
)
from caduceus.core.render import (
    managed_config,
    merge_config_text,
    set_env_lines,
    terminal_env,
)
from caduceus.core.types import AgentSpec

logger = logging.getLogger(__name__)

HERMES_TIMEOUT_S = 60.0  # E1 / RESILIENCY-10
DOCKER_TIMEOUT_S = 30.0
GATEWAY_REAP_GRACE_S = 5.0  # SIGTERM → grace → SIGKILL window per signal
_REAP_POLL_STEP_S = 0.25

_ENV_FILE_MODE = 0o600  # G3
_SECRET_RE = re.compile(r"[A-Fa-f0-9]{32,}")  # hex secrets (tokens, keys)


def redact(text: str, *, limit: int = 500) -> str:
    """Mask hex secrets and truncate — safe to put into error details (S1)."""
    return _SECRET_RE.sub("***", text)[:limit]


@dataclass(frozen=True)
class DoctorCheck:
    name: str
    ok: bool
    detail: str


@dataclass(frozen=True)
class DoctorReport:
    checks: list[DoctorCheck] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return all(c.ok for c in self.checks)


@dataclass(frozen=True)
class SkillInfo:
    name: str
    enabled: bool


@dataclass(frozen=True)
class GatewayPidInfo:
    """Parsed ``<profile>/gateway.pid`` — hermes' durable record of the live
    gateway, independent of any in-memory process manager state."""

    pid: int
    kind: str
    argv: list[str]
    start_time: int | None


class HermesAdapter:
    def __init__(
        self,
        runner: CommandRunner,
        files: FileStore,
        *,
        hermes_home: Path,
        hermes_bin: str = "hermes",
        docker_bin: str = "docker",
        signaller: ProcessSignaller | None = None,
    ) -> None:
        self._runner = runner
        self._files = files
        self._home = hermes_home.expanduser()
        self._hermes = hermes_bin
        self._docker = docker_bin
        self._signaller = signaller or RealProcessSignaller()

    async def _run(self, argv: list[str], *, timeout_s: float) -> Any:
        return await self._runner.run(argv, timeout_s=timeout_s)

    # -- paths ---------------------------------------------------------------

    def profile_dir(self, profile: str) -> Path:
        return self._home / "profiles" / profile

    def _config_path(self, profile: str) -> Path:
        return self.profile_dir(profile) / "config.yaml"

    def _env_path(self, profile: str) -> Path:
        return self.profile_dir(profile) / ".env"

    def _soul_path(self, profile: str) -> Path:
        return self.profile_dir(profile) / "SOUL.md"

    def _gateway_pid_path(self, profile: str) -> Path:
        return self.profile_dir(profile) / "gateway.pid"

    # -- profile lifecycle (logic §6) -----------------------------------------

    async def create_profile(self, profile: str) -> None:
        if self._files.exists(self.profile_dir(profile)):
            raise ConflictError(f"hermes profile {profile!r} already exists (L5)")
        result = await self._run(
            [self._hermes, "profile", "create", profile], timeout_s=HERMES_TIMEOUT_S
        )
        if not result.ok:
            raise HermesError(
                f"hermes profile create {profile} failed (exit {result.returncode})",
                detail=redact(result.stderr or result.stdout),
            )
        if not self._files.exists(self.profile_dir(profile)):
            raise HermesError(
                f"hermes reported success but profile dir missing: {self.profile_dir(profile)}"
            )

    async def delete_profile(self, profile: str, *, image: str | None = None) -> None:
        if not self._files.exists(self.profile_dir(profile)):
            return  # already gone — deletion is idempotent
        result = await self._run(
            [self._hermes, "profile", "delete", profile, "--yes"],
            timeout_s=HERMES_TIMEOUT_S,
        )
        if result.ok:
            return
        # Lazy ownership recovery: hermes runs its docker sandboxes as container
        # root, leaving root-owned bind-mount artifacts inside the profile that
        # hermes' own ``shutil.rmtree`` can't delete when the daemon runs as a
        # non-root user (rootless docker was retired in d2b69f3). Reclaim
        # ownership via a privileged throwaway container — using the agent's own
        # image, already pulled — then retry the delete once. Without an image
        # (e.g. integration callers) there's nothing to reclaim with, so the
        # original failure surfaces unchanged.
        if image is not None and await self.reclaim_profile_ownership(profile, image=image):
            result = await self._run(
                [self._hermes, "profile", "delete", profile, "--yes"],
                timeout_s=HERMES_TIMEOUT_S,
            )
            if result.ok:
                return
        raise HermesError(
            f"hermes profile delete {profile} failed (exit {result.returncode})",
            detail=redact(result.stderr or result.stdout),
        )

    async def reclaim_profile_ownership(self, profile: str, *, image: str) -> bool:
        """``chown`` the profile tree back to the host uid:gid via a throwaway
        root docker container. The docker daemon runs as root, so it can reclaim
        the root-owned sandbox artifacts it created. Best-effort: returns True on
        success, False on any failure (never raises) so callers can decide."""
        profile_dir = self.profile_dir(profile)
        if not self._files.exists(profile_dir):
            return True
        owner = f"{os.getuid()}:{os.getgid()}"
        try:
            result = await self._run(
                [
                    self._docker, "run", "--rm", "--network", "none",
                    "-v", f"{profile_dir}:/target",
                    image,
                    "chown", "-R", owner, "/target",
                ],
                timeout_s=DOCKER_TIMEOUT_S,
            )
        except CaduceusError:
            return False
        return bool(result.ok)

    # -- gateway reaping (orphan prevention) ----------------------------------

    def read_gateway_pidinfo(self, profile: str) -> GatewayPidInfo | None:
        """Parse ``<profile>/gateway.pid``. Returns None when absent, malformed,
        or not a hermes-gateway record — i.e. nothing safe to reap."""
        path = self._gateway_pid_path(profile)
        if not self._files.exists(path):
            return None
        try:
            data = json.loads(self._files.read_text(path))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or data.get("kind") != "hermes-gateway":
            return None
        pid = data.get("pid")
        if not isinstance(pid, int) or isinstance(pid, bool):
            return None
        start = data.get("start_time")
        start_time = start if isinstance(start, int) and not isinstance(start, bool) else None
        raw_argv = data.get("argv")
        argv = [str(a) for a in raw_argv] if isinstance(raw_argv, list) else []
        return GatewayPidInfo(pid=pid, kind="hermes-gateway", argv=argv, start_time=start_time)

    def _gateway_identity_ok(self, profile: str, info: GatewayPidInfo) -> bool:
        """Strict identity check (Q1=A) guarding against PID recycling: the live
        process must have the exact recorded start_time AND a cmdline naming this
        profile's gateway. Any gap → refuse to signal."""
        if info.start_time is None:
            return False
        if self._signaller.start_time(info.pid) != info.start_time:
            return False
        cmd = self._signaller.cmdline(info.pid)
        if not cmd:
            return False
        tokens = set(cmd)
        return profile in tokens and "gateway" in tokens

    async def reap_gateway(
        self, profile: str, *, clock: Clock, grace_s: float = GATEWAY_REAP_GRACE_S
    ) -> str:
        """Terminate the gateway recorded in ``<profile>/gateway.pid`` regardless
        of any in-memory manager state. SIGTERM → grace → SIGKILL, only after the
        identity check passes. Returns one of:
        ``absent`` (no pidfile), ``dead`` (stale pidfile, process gone),
        ``mismatch`` (identity check failed — not signalled), ``terminated``,
        ``survived`` (still alive after SIGKILL)."""
        info = self.read_gateway_pidinfo(profile)
        if info is None:
            return "absent"
        pid = info.pid
        if not self._signaller.alive(pid):
            return "dead"
        if not self._gateway_identity_ok(profile, info):
            logger.warning(
                "gateway.pid for %s names pid %d but identity mismatch — not signalling",
                profile, pid,
            )
            return "mismatch"
        self._signaller.terminate(pid)
        if await self._await_death(pid, grace_s, clock):
            return "terminated"
        logger.warning(
            "gateway pid %d (%s) survived SIGTERM; escalating to SIGKILL", pid, profile
        )
        self._signaller.kill(pid)
        if await self._await_death(pid, grace_s, clock):
            return "terminated"
        return "survived"

    async def _await_death(self, pid: int, grace_s: float, clock: Clock) -> bool:
        if not self._signaller.alive(pid):
            return True
        waited = 0.0
        while waited < grace_s:
            await clock.sleep(_REAP_POLL_STEP_S)
            waited += _REAP_POLL_STEP_S
            if not self._signaller.alive(pid):
                return True
        return not self._signaller.alive(pid)

    # Login-shell profile seeded into the default terminal sandbox home.
    # hermes captures its terminal env snapshot from ``bash -l`` (base.py
    # init_session); Debian/Ubuntu /etc/profile unconditionally resets root's
    # PATH without the games directories, where apt installs some packages
    # (cowsay et al.). The sandbox home bind shadows the image's /root, so
    # ``~/.profile`` (read after /etc/profile) is the config-only hook that
    # survives into the snapshot.
    SANDBOX_PROFILE_CONTENT = (
        "# Seeded by caduceus at agent creation (edit freely — never rewritten).\n"
        'case ":$PATH:" in\n'
        "  *:/usr/games:*) ;;\n"
        '  *) PATH="$PATH:/usr/games:/usr/local/games" ;;\n'
        "esac\n"
        "export PATH\n"
    )

    def seed_sandbox_profile(self, profile: str, sandbox: str = "default") -> None:
        """Seed the terminal sandbox home ``.profile`` (once, create-time).

        Only the top-level terminal sandbox (``default``) is seeded — hermes
        keys sandboxes by task and the top-level agent always lands on
        ``default`` (terminal_tool). An existing file is left untouched: it
        belongs to the user after creation."""
        path = (
            self.profile_dir(profile) / "sandboxes" / "docker" / sandbox
            / "home" / ".profile"
        )
        if not self._files.exists(path):
            self._files.write_text_atomic(path, self.SANDBOX_PROFILE_CONTENT)

    # -- managed configuration (FD2, logic §5) --------------------------------

    def apply_managed_config(
        self,
        profile: str,
        spec: AgentSpec,
        *,
        daemon_v1_url: str,
        workspace_dir: str,
        default_model: str | None,
    ) -> None:
        managed = managed_config(
            spec,
            daemon_v1_url=daemon_v1_url,
            workspace_dir=workspace_dir,
            default_model=default_model,
        )
        path = self._config_path(profile)
        existing = self._files.read_text(path) if self._files.exists(path) else None
        self._files.write_text_atomic(path, merge_config_text(existing, managed))

    def read_config_text(self, profile: str) -> str | None:
        path = self._config_path(profile)
        return self._files.read_text(path) if self._files.exists(path) else None

    def write_env(self, profile: str, updates: dict[str, str]) -> None:
        path = self._env_path(profile)
        existing = self._files.read_text(path) if self._files.exists(path) else None
        self._files.write_text_atomic(
            path, set_env_lines(existing, updates), mode=_ENV_FILE_MODE
        )

    def write_api_server_env(self, profile: str, *, port: int, key: str) -> None:
        self.write_env(
            profile,
            {
                "API_SERVER_ENABLED": "1",
                "API_SERVER_HOST": "127.0.0.1",  # N3 loopback
                "API_SERVER_PORT": str(port),
                "API_SERVER_KEY": key,
            },
        )

    def write_gateway_token(self, profile: str, token_plaintext: str) -> None:
        self.write_env(profile, {"OPENAI_API_KEY": token_plaintext})

    # -- persona / skills / toolsets (F7) --------------------------------------

    def read_soul(self, profile: str) -> str:
        path = self._soul_path(profile)
        if not self._files.exists(path):
            return ""
        return self._files.read_text(path)

    def write_soul(self, profile: str, content: str) -> None:
        self._files.write_text_atomic(self._soul_path(profile), content)

    def list_skills(self, profile: str) -> list[SkillInfo]:
        """Skills = subdirectories of ``<profile>/skills``; disabled set comes
        from config ``skills.disabled`` (hermes_cli/skills_config.py)."""
        skills_dir = self.profile_dir(profile) / "skills"
        disabled = set(self._read_config_value(profile, "skills", "disabled") or [])
        return [
            SkillInfo(name=entry, enabled=entry not in disabled)
            for entry in self._files.list_subdirs(skills_dir)
            if not entry.startswith(".")
        ]

    def set_skill_enabled(self, profile: str, skill: str, enabled: bool) -> None:
        disabled = set(self._read_config_value(profile, "skills", "disabled") or [])
        if enabled:
            disabled.discard(skill)
        else:
            disabled.add(skill)
        self._merge_config(profile, {"skills": {"disabled": sorted(disabled)}})

    def get_toolsets(self, profile: str, platform: str = "api_server") -> list[str]:
        value = self._read_config_value(profile, "platform_toolsets", platform)
        return [str(v) for v in value] if isinstance(value, list) else []

    def set_toolsets(self, profile: str, toolsets: list[str], platform: str = "api_server") -> None:
        self._merge_config(profile, {"platform_toolsets": {platform: list(toolsets)}})

    # -- containers (FD4 rm path) ----------------------------------------------

    async def remove_containers(self, profile: str) -> int:
        """``docker rm -f`` every container labeled for this profile. Returns count."""
        listing = await self._run(
            [
                self._docker, "ps", "-aq",
                "--filter", f"label=hermes-profile={profile}",
            ],
            timeout_s=DOCKER_TIMEOUT_S,
        )
        if not listing.ok:
            raise DockerError(
                f"docker ps failed (exit {listing.returncode})",
                detail=redact(listing.stderr),
            )
        ids = [line.strip() for line in listing.stdout.splitlines() if line.strip()]
        if not ids:
            return 0
        removal = await self._run(
            [self._docker, "rm", "-f", *ids], timeout_s=DOCKER_TIMEOUT_S
        )
        if not removal.ok:
            raise DockerError(
                f"docker rm -f failed (exit {removal.returncode})",
                detail=redact(removal.stderr),
            )
        return len(ids)

    async def container_state(self, profile: str) -> str:
        """State of this profile's container: running/exited/absent/unknown (E3)."""
        try:
            result = await self._run(
                [
                    self._docker, "ps", "-a",
                    "--filter", f"label=hermes-profile={profile}",
                    "--format", "{{.State}}",
                ],
                timeout_s=DOCKER_TIMEOUT_S,
            )
        except CaduceusError:
            return "unknown"
        if not result.ok:
            return "unknown"
        states = [line.strip() for line in result.stdout.splitlines() if line.strip()]
        if not states:
            return "absent"
        return "running" if "running" in states else "exited"

    async def list_container_profiles(self) -> set[str]:
        """Profiles that own hermes-labeled containers (orphan detection input)."""
        try:
            result = await self._run(
                [
                    self._docker, "ps", "-a",
                    "--filter", "label=hermes-agent=1",
                    "--format", '{{.Label "hermes-profile"}}',
                ],
                timeout_s=DOCKER_TIMEOUT_S,
            )
        except CaduceusError:
            return set()
        if not result.ok:
            return set()
        return {line.strip() for line in result.stdout.splitlines() if line.strip()}

    def list_profiles(self) -> list[str]:
        """Existing hermes profile names (directory scan)."""
        return self._files.list_subdirs(self._home / "profiles")

    # -- gateway process argv (consumed by GatewayProcessManager) ---------------

    def gateway_argv(self, profile: str) -> list[str]:
        return [self._hermes, "-p", profile, "gateway"]

    def gateway_env(self, spec: AgentSpec, workspace_dir: str) -> dict[str, str]:
        """``TERMINAL_*`` env injected into the gateway process so hermes'
        terminal_tool resolves the docker backend + ``network_mode`` +
        persistence from env (it reads these ONLY from ``TERMINAL_*`` vars, never
        from the profile config.yaml directly). Derived from the same source as
        the managed config — see ``render.terminal_env``."""
        return terminal_env(spec, workspace_dir)

    # -- preflight (logic §7) ----------------------------------------------------

    async def preflight(self) -> DoctorReport:
        checks: list[DoctorCheck] = []

        hermes = await self._try_version([self._hermes, "--version"])
        checks.append(
            DoctorCheck("hermes-cli", hermes is not None, hermes or "hermes not on PATH")
        )
        docker = await self._try_version(
            [self._docker, "version", "--format", "{{.Server.Version}}"]
        )
        checks.append(
            DoctorCheck("docker-daemon", docker is not None, docker or "docker daemon unreachable")
        )
        checks.append(
            DoctorCheck(
                "hermes-home",
                self._files.exists(self._home),
                str(self._home),
            )
        )
        return DoctorReport(checks=checks)

    async def _try_version(self, argv: list[str]) -> str | None:
        try:
            result = await self._run(argv, timeout_s=10.0)
        except Exception:
            return None
        if not result.ok:
            return None
        return result.stdout.strip().splitlines()[0] if result.stdout.strip() else "ok"

    # -- internals ---------------------------------------------------------------

    def _merge_config(self, profile: str, sections: dict[str, dict[str, Any]]) -> None:
        path = self._config_path(profile)
        if not self._files.exists(self.profile_dir(profile)):
            raise NotFoundError(f"profile {profile!r} does not exist")
        existing = self._files.read_text(path) if self._files.exists(path) else None
        self._files.write_text_atomic(path, merge_config_text(existing, sections))

    def _read_config_value(self, profile: str, section: str, key: str) -> Any:
        from ruamel.yaml import YAML

        path = self._config_path(profile)
        if not self._files.exists(path):
            return None
        data = YAML(typ="safe").load(self._files.read_text(path)) or {}
        node = data.get(section)
        return node.get(key) if isinstance(node, dict) else None
