"""Shared per-invocation CLI state (typer ctx.obj) and small helpers."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import NoReturn

import typer

from caduceus.cli.client import ApiClient, resolve_client_config
from caduceus.cli.errors import ExitCode
from caduceus.cli.output import Renderer


@dataclass
class AppState:
    home: Path
    no_color: bool = False
    quiet: bool = False
    debug: bool = False
    client_factory: Callable[[AppState], ApiClient] | None = None  # test seam
    _client: ApiClient | None = field(default=None, repr=False)

    def client(self) -> ApiClient:
        if self._client is None:
            if self.client_factory is not None:
                self._client = self.client_factory(self)
            else:
                self._client = ApiClient(resolve_client_config(home=self.home))
        return self._client


def get_state(ctx: typer.Context) -> AppState:
    state = ctx.find_object(AppState)
    if state is None:  # direct function invocation in tests
        state = AppState(home=Path.home() / ".caduceus")
        ctx.obj = state
    return state


def get_client(ctx: typer.Context) -> ApiClient:
    return get_state(ctx).client()


def get_renderer(ctx: typer.Context, *, json_mode: bool = False) -> Renderer:
    state = get_state(ctx)
    return Renderer(json_mode=json_mode, quiet=state.quiet, no_color=state.no_color)


def finish(code: ExitCode) -> NoReturn:
    raise typer.Exit(int(code))
