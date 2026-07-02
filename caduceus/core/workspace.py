"""Workspace directory management (FD4/AMD-2, rules V6/L3, property P9).

Workspaces live OUTSIDE the hermes profile at ``~/.caduceus/workspaces/<name>``
so that agent removal (profile purge) never touches produced artifacts.

This module intentionally exposes NO delete operation (L3): removal of a
workspace is a deliberate manual action by the user, never Caduceus code.
"""

from __future__ import annotations

from pathlib import Path

from caduceus.core.errors import WorkspaceError
from caduceus.core.ports import FileStore
from caduceus.core.types import validate_agent_name

_WORKSPACE_DIR_MODE = 0o700


class WorkspaceManager:
    def __init__(self, root: Path, files: FileStore) -> None:
        self._root = root.expanduser().resolve()
        self._files = files

    @property
    def root(self) -> Path:
        return self._root

    def path_for(self, agent_name: str) -> Path:
        """Containment-checked workspace path (V6/P9) — no filesystem effects."""
        name = validate_agent_name(agent_name)
        candidate = (self._root / name).resolve()
        if candidate.parent != self._root or candidate == self._root:
            raise WorkspaceError(
                f"workspace path escapes managed root for agent {name!r}",
                detail=str(candidate),
            )
        return candidate

    def ensure(self, agent_name: str) -> tuple[Path, bool]:
        """Create (or reuse — L5) the workspace. Returns (path, already_existed)."""
        path = self.path_for(agent_name)
        existed = self._files.exists(path)
        if not existed:
            self._files.mkdir(path, mode=_WORKSPACE_DIR_MODE)
        return path, existed
