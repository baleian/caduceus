"""P9 — workspace paths are always contained under the managed root."""

from __future__ import annotations

from pathlib import Path

import pytest
from hypothesis import given
from hypothesis import strategies as st

from caduceus.core.errors import CaduceusError
from caduceus.core.workspace import WorkspaceManager
from tests.property.strategies import agent_names
from tests.unit.fakes import InMemoryFileStore

ROOT = Path("/home/u/.caduceus/workspaces")


@given(agent_names())
def test_p9_valid_names_stay_inside_root(name: str) -> None:
    manager = WorkspaceManager(ROOT, InMemoryFileStore())
    path = manager.path_for(name)
    assert path.parent == ROOT
    assert path.name == name


@given(st.text(min_size=1, max_size=40))
def test_p9_arbitrary_input_never_escapes_root(raw: str) -> None:
    manager = WorkspaceManager(ROOT, InMemoryFileStore())
    try:
        path = manager.path_for(raw)
    except CaduceusError:
        return  # rejected — fine (fail-closed)
    assert path.parent == ROOT  # accepted → must be contained


@pytest.mark.parametrize("evil", ["../evil", "a/../../b", "..", "a/b", ".", "x/"])
def test_p9_traversal_examples_rejected(evil: str) -> None:
    manager = WorkspaceManager(ROOT, InMemoryFileStore())
    with pytest.raises(CaduceusError):
        manager.path_for(evil)
