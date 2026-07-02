"""Registry example tests: fail-closed corruption, CRUD, conflicts (E2, I-rules)."""

from __future__ import annotations

from pathlib import Path

import pytest

from caduceus.core.errors import ConflictError, NotFoundError, RegistryCorruptError
from caduceus.core.registry import Registry, RegistryStore
from tests.unit.fakes import FakeClock, InMemoryFileStore
from tests.unit.test_types import TOKEN_HASH_A, TOKEN_HASH_B, make_record

REG_PATH = Path("/reg/registry.json")


def new_registry(files: InMemoryFileStore | None = None) -> Registry:
    files = files or InMemoryFileStore()
    return Registry(
        RegistryStore(REG_PATH, files, FakeClock()),
        port_in_use=lambda _: False,
    )


def test_missing_file_yields_empty_registry() -> None:
    assert new_registry().list() == []


def test_corrupt_file_fails_closed_with_backup() -> None:
    files = InMemoryFileStore()
    files.write_text_atomic(REG_PATH, "{not json!!")
    with pytest.raises(RegistryCorruptError) as exc_info:
        new_registry(files)
    assert exc_info.value.backup_path is not None
    assert str(REG_PATH) not in files.files  # original moved aside, not overwritten


def test_invariant_violating_file_fails_closed() -> None:
    files = InMemoryFileStore()
    # two agents sharing a port (violates I2) — hand-crafted JSON
    a = make_record("a", port=42800, token_hash=TOKEN_HASH_A).model_dump_json()
    b = make_record("b", port=42800, token_hash=TOKEN_HASH_B).model_dump_json()
    files.write_text_atomic(
        REG_PATH,
        f'{{"schema_version": 1, "agents": {{"a": {a}, "b": {b}}}}}',
    )
    with pytest.raises(RegistryCorruptError):
        new_registry(files)


def test_add_get_remove_cycle() -> None:
    reg = new_registry()
    record = make_record("coder")
    reg.add(record)
    assert reg.get("coder") == record
    reg.remove("coder")
    with pytest.raises(NotFoundError):
        reg.get("coder")


def test_add_duplicate_conflicts() -> None:
    reg = new_registry()
    reg.add(make_record("coder"))
    with pytest.raises(ConflictError):
        reg.add(make_record("coder", port=42801, token_hash=TOKEN_HASH_B))


def test_registry_file_mode_is_owner_only() -> None:
    files = InMemoryFileStore()
    reg = new_registry(files)
    reg.add(make_record("coder"))
    assert files.modes[str(REG_PATH)] == 0o600  # S3


def test_persist_failure_does_not_mutate_memory() -> None:
    files = InMemoryFileStore()
    reg = new_registry(files)
    reg.add(make_record("a", port=42800, token_hash=TOKEN_HASH_A))

    def broken_write(path: Path, content: str, *, mode: int = 0o644) -> None:
        raise OSError("disk full")

    files.write_text_atomic = broken_write  # type: ignore[method-assign]
    with pytest.raises(OSError, match="disk full"):
        reg.add(make_record("b", port=42801, token_hash=TOKEN_HASH_B))
    assert [r.spec.name for r in reg.list()] == ["a"]  # memory unchanged


def test_allocate_port_skips_os_busy_ports() -> None:
    files = InMemoryFileStore()
    busy = {42800, 42801}
    reg = Registry(
        RegistryStore(REG_PATH, files, FakeClock()),
        port_in_use=lambda p: p in busy,
    )
    assert reg.allocate_port(42800) == 42802


def test_set_desired_state_and_token_rotation_persist() -> None:
    files = InMemoryFileStore()
    reg = new_registry(files)
    reg.add(make_record("coder"))
    reg.set_desired_state("coder", "running")
    reg.rotate_token_hash("coder", TOKEN_HASH_B)
    reloaded = Registry(
        RegistryStore(REG_PATH, files, FakeClock()), port_in_use=lambda _: False
    )
    assert reloaded.get("coder").desired_state == "running"
    assert reloaded.get("coder").token_hash == TOKEN_HASH_B
