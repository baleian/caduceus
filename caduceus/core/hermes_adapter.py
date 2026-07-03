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
from caduceus.core.ports import CommandRunner, FileStore
from caduceus.core.render import (
    managed_config,
    merge_config_text,
    set_env_lines,
    terminal_env,
)
from caduceus.core.types import AgentSpec

HERMES_TIMEOUT_S = 60.0  # E1 / RESILIENCY-10
DOCKER_TIMEOUT_S = 30.0

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


class HermesAdapter:
    def __init__(
        self,
        runner: CommandRunner,
        files: FileStore,
        *,
        hermes_home: Path,
        hermes_bin: str = "hermes",
        docker_bin: str = "docker",
    ) -> None:
        self._runner = runner
        self._files = files
        self._home = hermes_home.expanduser()
        self._hermes = hermes_bin
        self._docker = docker_bin

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
