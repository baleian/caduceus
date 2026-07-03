"""`caduceus gateway *` — upstream config and traffic summary (F4/F11)."""

from __future__ import annotations

from typing import Annotated

import typer

from caduceus.cli.context import finish, get_client, get_renderer
from caduceus.cli.errors import ExitCode

gateway_app = typer.Typer(no_args_is_help=True, help="Central gateway upstream & traffic")
upstream_app = typer.Typer(no_args_is_help=True, help="Upstream LLM endpoint")
gateway_app.add_typer(upstream_app, name="upstream")

JsonFlag = Annotated[bool, typer.Option("--json", help="machine-readable output")]


@gateway_app.command()
def status(ctx: typer.Context, json_output: JsonFlag = False) -> None:
    """Upstream + per-agent traffic summary."""
    info = get_client(ctx).gateway_info()
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(info)
        finish(ExitCode.OK)
    upstream = info.get("upstream", {})
    listen = info.get("listen", {})
    renderer.data_text(
        f"listen   {listen.get('host')}:{listen.get('port')}\n"
        f"upstream {upstream.get('base_url')} "
        f"(api_key_env={upstream.get('api_key_env') or '-'})"
    )
    traffic = info.get("traffic", {})
    agents = traffic.get("agents", {}) if isinstance(traffic, dict) else {}
    rows = [
        [
            name,
            str(t.get("requests", "")),
            str(t.get("input_tokens", "")),
            str(t.get("output_tokens", "")),
            str(t.get("errors", "")),
        ]
        for name, t in sorted(agents.items())
        if isinstance(t, dict)
    ]
    if rows:
        renderer.data_table(["AGENT", "REQUESTS", "IN TOKENS", "OUT TOKENS", "ERRORS"], rows)
    finish(ExitCode.OK)


@upstream_app.command("get")
def upstream_get(ctx: typer.Context, json_output: JsonFlag = False) -> None:
    """Show the configured upstream endpoint."""
    upstream = get_client(ctx).gateway_info().get("upstream", {})
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(upstream)
    else:
        renderer.data_text(
            f"{upstream.get('base_url')} (api_key_env={upstream.get('api_key_env') or '-'}, "
            f"default_model={upstream.get('default_model') or '-'})"
        )
    finish(ExitCode.OK)


@upstream_app.command("set")
def upstream_set(
    ctx: typer.Context,
    base_url: str,
    api_key_env: Annotated[
        str | None, typer.Option(help="env var NAME holding the upstream key (S4)")
    ] = None,
    default_model: Annotated[str | None, typer.Option(help="default model id")] = None,
) -> None:
    """Hot-swap the upstream endpoint (S4) — in-flight requests drain on the old one."""
    result = get_client(ctx).put_upstream(
        base_url, api_key_env=api_key_env, default_model=default_model
    )
    get_renderer(ctx).progress(f"upstream switched to {result.get('base_url')}")
    finish(ExitCode.OK)
