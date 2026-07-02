"""Agent registry persistence + port allocation (logic §1–§2, rules E2/I1–I5).

Single-writer model: only the daemon process mutates the registry; duplicate
daemons are prevented by the listen-port bind, so no file locking is needed.
"""

from __future__ import annotations

from pathlib import Path

from pydantic import ValidationError

from caduceus.core.errors import (
    ConflictError,
    DomainValidationError,
    NotFoundError,
    RegistryCorruptError,
)
from caduceus.core.ports import Clock, FileStore, PortProbe, loopback_port_in_use
from caduceus.core.types import AgentRecord, DesiredState, RegistryFile

_REGISTRY_MODE = 0o600  # holds api_server keys — owner-only (S3)


class RegistryStore:
    """Load/save ``registry.json`` with fail-closed corruption handling."""

    def __init__(self, path: Path, files: FileStore, clock: Clock) -> None:
        self._path = path
        self._files = files
        self._clock = clock

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> RegistryFile:
        if not self._files.exists(self._path):
            return RegistryFile()
        try:
            raw = self._files.read_text(self._path)
            return RegistryFile.model_validate_json(raw)
        except (ValidationError, DomainValidationError, ValueError, OSError) as exc:
            backup = self._backup_corrupt()
            raise RegistryCorruptError(
                f"registry file {self._path} is corrupt; startup halted (E2)",
                backup_path=str(backup) if backup else None,
                detail=str(exc)[:500],
            ) from exc

    def save(self, registry: RegistryFile) -> None:
        # Re-validate invariants I1–I5 before any bytes hit disk.
        validated = RegistryFile.model_validate(registry.model_dump())
        content = validated.model_dump_json(indent=2)
        self._files.write_text_atomic(self._path, content, mode=_REGISTRY_MODE)

    def _backup_corrupt(self) -> Path | None:
        try:
            ts = self._clock.now_iso().replace(":", "-")
            backup = self._path.with_name(f"{self._path.name}.corrupt-{ts}")
            self._files.rename(self._path, backup)
            return backup
        except OSError:
            return None


class Registry:
    """In-memory registry over a :class:`RegistryStore` (C2 contract)."""

    def __init__(
        self,
        store: RegistryStore,
        *,
        port_in_use: PortProbe = loopback_port_in_use,
    ) -> None:
        self._store = store
        self._port_in_use = port_in_use
        self._doc = store.load()

    # -- queries -----------------------------------------------------------

    def list(self) -> list[AgentRecord]:
        return sorted(self._doc.agents.values(), key=lambda r: r.spec.name)

    def get(self, name: str) -> AgentRecord:
        try:
            return self._doc.agents[name]
        except KeyError:
            raise NotFoundError(f"agent {name!r} not found") from None

    def token_map(self) -> dict[str, str]:
        """token_hash → agent name (feeds TokenResolver.rebuild)."""
        return {r.token_hash: r.spec.name for r in self._doc.agents.values()}

    # -- mutations (each persists atomically before returning) --------------

    def add(self, record: AgentRecord) -> None:
        if record.spec.name in self._doc.agents:
            raise ConflictError(f"agent {record.spec.name!r} already exists (I1)")
        updated = self._doc.model_copy(
            update={"agents": {**self._doc.agents, record.spec.name: record}}
        )
        self._persist(updated)

    def replace(self, record: AgentRecord) -> None:
        self.get(record.spec.name)
        updated = self._doc.model_copy(
            update={"agents": {**self._doc.agents, record.spec.name: record}}
        )
        self._persist(updated)

    def set_desired_state(self, name: str, state: DesiredState) -> AgentRecord:
        record = self.get(name).model_copy(update={"desired_state": state})
        self.replace(record)
        return record

    def remove(self, name: str) -> None:
        self.get(name)
        agents = dict(self._doc.agents)
        del agents[name]
        self._persist(self._doc.model_copy(update={"agents": agents}))

    def rotate_token_hash(self, name: str, new_hash: str) -> AgentRecord:
        record = self.get(name).model_copy(update={"token_hash": new_hash})
        self.replace(record)
        return record

    # -- port allocation (logic §2) -----------------------------------------

    def allocate_port(self, port_base: int, *, reserved: set[int] | None = None) -> int:
        used = {r.api_port for r in self._doc.agents.values()} | (reserved or set())
        port = port_base
        while port in used or self._port_in_use(port):
            port += 1
            if port > 65535:
                raise DomainValidationError("no free TCP port available above port_base")
        return port

    def _persist(self, updated: RegistryFile) -> None:
        self._store.save(updated)  # raises before mutating memory (fail-closed)
        self._doc = updated
