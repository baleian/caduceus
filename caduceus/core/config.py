"""Caduceus daemon configuration store (``~/.caduceus/config.yaml``)."""

from __future__ import annotations

import io
from pathlib import Path

from pydantic import ValidationError
from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from caduceus.core.errors import ConfigError, DomainValidationError
from caduceus.core.ports import FileStore
from caduceus.core.types import CaduceusConfig

_CONFIG_MODE = 0o600  # may reference secret env names; keep owner-only anyway


class CaduceusConfigStore:
    def __init__(self, path: Path, files: FileStore) -> None:
        self._path = path
        self._files = files

    @property
    def path(self) -> Path:
        return self._path

    def exists(self) -> bool:
        return self._files.exists(self._path)

    def load(self) -> CaduceusConfig:
        if not self._files.exists(self._path):
            raise ConfigError(
                f"caduceus config not found at {self._path}",
                detail="run `caduceus init` to create it",
            )
        try:
            raw = YAML(typ="safe").load(self._files.read_text(self._path)) or {}
            return CaduceusConfig.model_validate(raw)
        except (ValidationError, DomainValidationError, YAMLError) as exc:
            raise ConfigError(
                f"invalid caduceus config at {self._path}", detail=str(exc)[:500]
            ) from exc

    def save(self, config: CaduceusConfig) -> None:
        yaml = YAML()
        yaml.indent(mapping=2, sequence=2, offset=0)
        buf = io.StringIO()
        yaml.dump(config.model_dump(mode="json", exclude_none=True), buf)
        self._files.write_text_atomic(self._path, buf.getvalue(), mode=_CONFIG_MODE)
