"""CaduceusConfigStore example tests: defaults, round-trip, error paths."""

from __future__ import annotations

from pathlib import Path

import pytest

from caduceus.core.config import CaduceusConfigStore
from caduceus.core.errors import ConfigError
from caduceus.core.types import CaduceusConfig, UpstreamConfig
from tests.unit.fakes import InMemoryFileStore

CFG_PATH = Path("/home/u/.caduceus/config.yaml")


def make_store(files: InMemoryFileStore | None = None) -> CaduceusConfigStore:
    return CaduceusConfigStore(CFG_PATH, files or InMemoryFileStore())


def test_missing_config_raises_with_init_hint() -> None:
    with pytest.raises(ConfigError, match="caduceus init"):
        make_store().load()


def test_save_load_round_trip_with_defaults() -> None:
    files = InMemoryFileStore()
    store = make_store(files)
    config = CaduceusConfig(upstream=UpstreamConfig(base_url="http://localhost:11434/v1"))
    store.save(config)
    loaded = store.load()
    assert loaded == config
    assert loaded.listen.host == "127.0.0.1"
    assert loaded.agents.port_base == 42800
    assert files.modes[str(CFG_PATH)] == 0o600


def test_invalid_yaml_fails_closed() -> None:
    files = InMemoryFileStore()
    files.write_text_atomic(CFG_PATH, "upstream: [unclosed")
    with pytest.raises(ConfigError):
        make_store(files).load()


def test_unknown_keys_rejected() -> None:
    files = InMemoryFileStore()
    files.write_text_atomic(
        CFG_PATH,
        "upstream:\n  base_url: http://x/v1\ntypo_section:\n  a: 1\n",
    )
    with pytest.raises(ConfigError):
        make_store(files).load()


def test_workspace_ensure_reuse_flag() -> None:
    from caduceus.core.workspace import WorkspaceManager

    files = InMemoryFileStore()
    manager = WorkspaceManager(Path("/root/.caduceus/workspaces"), files)
    path, existed = manager.ensure("coder")
    assert existed is False
    path2, existed2 = manager.ensure("coder")
    assert path2 == path
    assert existed2 is True  # L5: leftover workspace is reused, caller informs user
    assert files.modes[str(path)] == 0o700
