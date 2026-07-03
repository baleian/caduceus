"""`caduceus agent *` command group (F9/F7) — thin: parse → ApiClient → render."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Annotated, Any

import typer

from caduceus.cli.bootstrap import require_confirmation
from caduceus.cli.context import finish, get_client, get_renderer
from caduceus.cli.errors import CliError, ExitCode
from caduceus.cli.tail import advance

agent_app = typer.Typer(no_args_is_help=True, help="Agent lifecycle and configuration")
token_app = typer.Typer(no_args_is_help=True, help="Gateway token operations")
agent_app.add_typer(token_app, name="token")

JsonFlag = Annotated[bool, typer.Option("--json", help="machine-readable output")]
NoWaitFlag = Annotated[bool, typer.Option("--no-wait", help="print job id and return")]


def _run_job(ctx: typer.Context, job_id: str, *, no_wait: bool, json_mode: bool) -> None:
    renderer = get_renderer(ctx, json_mode=json_mode)
    client = get_client(ctx)
    if no_wait:
        if json_mode:
            renderer.data_json({"job_id": job_id})
        else:
            renderer.data_text(job_id)
        finish(ExitCode.OK)
    snapshot = client.wait_job(job_id, on_snapshot=renderer.job_progress_sink())
    finish(renderer.job_outcome(snapshot))


@agent_app.command()
def create(
    ctx: typer.Context,
    name: str,
    image: Annotated[str | None, typer.Option(help="docker image")] = None,
    network: Annotated[
        str | None, typer.Option(help="network mode: host | bridge_hostgw | none")
    ] = None,
    cpu: Annotated[float | None, typer.Option(help="cpu limit (cores)")] = None,
    memory: Annotated[int | None, typer.Option(help="memory limit (MB)")] = None,
    disk: Annotated[int | None, typer.Option(help="disk limit (MB)")] = None,
    persona: Annotated[
        Path | None, typer.Option(help="initial SOUL.md content file")
    ] = None,
    no_wait: NoWaitFlag = False,
    json_output: JsonFlag = False,
) -> None:
    """Provision an isolated hermes agent (F1)."""
    spec: dict[str, Any] = {"name": name}
    if image is not None:
        spec["docker_image"] = image
    if network is not None:
        spec["network_mode"] = network
    if cpu is not None:
        spec["cpu"] = cpu
    if memory is not None:
        spec["memory_mb"] = memory
    if disk is not None:
        spec["disk_mb"] = disk
    if persona is not None:
        spec["persona"] = persona.read_text()
    job_id = get_client(ctx).create_agent(spec)
    _run_job(ctx, job_id, no_wait=no_wait, json_mode=json_output)


@agent_app.command("ls")
def list_agents(
    ctx: typer.Context,
    probe: Annotated[bool, typer.Option(help="probe container state (slower)")] = False,
    json_output: JsonFlag = False,
) -> None:
    """List agents with synthesized status."""
    statuses = get_client(ctx).list_agents(probe=probe)
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(statuses)
    else:
        renderer.data_table(
            ["NAME", "DESIRED", "PROCESS", "HEALTH", "CONTAINER", "SUMMARY"],
            [
                [
                    str(s.get("name", "")),
                    str(s.get("desired_state", "")),
                    str(s.get("process", "")),
                    str(s.get("health", "")),
                    str(s.get("container", "")),
                    str((s.get("detail") or {}).get("summary", "")),
                ]
                for s in statuses
            ],
        )
    finish(ExitCode.OK)


@agent_app.command()
def status(ctx: typer.Context, name: str, json_output: JsonFlag = False) -> None:
    """Record + synthesized status for one agent."""
    data = get_client(ctx).get_agent(name)
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(data)
    else:
        record, agent_status = data.get("record", {}), data.get("status", {})
        spec = record.get("spec", {})
        rows = [
            ["name", str(spec.get("name", name))],
            ["desired", str(record.get("desired_state", ""))],
            ["process", str(agent_status.get("process", ""))],
            ["health", str(agent_status.get("health", ""))],
            ["container", str(agent_status.get("container", ""))],
            ["image", str(spec.get("docker_image", ""))],
            ["network", str(spec.get("network_mode", ""))],
            ["api_port", str(record.get("api_port", ""))],
            ["workspace", str(record.get("workspace_dir", ""))],
            ["summary", str((agent_status.get("detail") or {}).get("summary", ""))],
        ]
        renderer.data_table(["FIELD", "VALUE"], rows)
    finish(ExitCode.OK)


@agent_app.command()
def start(ctx: typer.Context, name: str) -> None:
    """Start the agent's gateway (desired=running)."""
    get_client(ctx).start_agent(name)
    get_renderer(ctx).progress(f"{name}: start requested")
    finish(ExitCode.OK)


@agent_app.command()
def stop(ctx: typer.Context, name: str) -> None:
    """Stop the agent's gateway (non-destructive — L2)."""
    get_client(ctx).stop_agent(name)
    get_renderer(ctx).progress(f"{name}: stop requested")
    finish(ExitCode.OK)


@agent_app.command()
def rm(
    ctx: typer.Context,
    name: str,
    yes: Annotated[bool, typer.Option("--yes", help="skip confirmation")] = False,
    no_wait: NoWaitFlag = False,
    json_output: JsonFlag = False,
) -> None:
    """Remove agent (profile + container). The workspace is always preserved (L3)."""
    renderer = get_renderer(ctx, json_mode=json_output)
    require_confirmation(
        renderer, agent=name, yes=yes, is_tty=sys.stdin.isatty() and sys.stderr.isatty()
    )
    job_id = get_client(ctx).remove_agent(name)
    if not no_wait and not json_output:
        renderer.progress(f"workspace preserved at ~/.caduceus/workspaces/{name}")
    _run_job(ctx, job_id, no_wait=no_wait, json_mode=json_output)


@agent_app.command()
def logs(
    ctx: typer.Context,
    name: str,
    lines: Annotated[int, typer.Option("-n", "--lines", help="lines to show")] = 200,
    follow: Annotated[bool, typer.Option("-f", "--follow", help="poll for new lines")] = False,
) -> None:
    """Show (and optionally follow) the agent gateway log."""
    client = get_client(ctx)
    renderer = get_renderer(ctx)
    window = client.logs(name, last=lines)
    renderer.data_lines(window)
    if not follow:
        finish(ExitCode.OK)
    import time as _time

    try:
        while True:
            _time.sleep(1.0)
            fetched = client.logs(name, last=2000)
            step = advance(window, fetched)
            if step.gap:
                renderer.notice("— log rotated or gap detected —")
            renderer.data_lines(step.new_lines)
            window = fetched
    except KeyboardInterrupt:
        finish(ExitCode.OK)


@agent_app.command()
def soul(
    ctx: typer.Context,
    name: str,
    edit: Annotated[bool, typer.Option("--edit", help="open in $EDITOR")] = False,
    set_file: Annotated[
        str | None, typer.Option("--set", help="file path or '-' for stdin")
    ] = None,
) -> None:
    """Show or update the agent persona (SOUL.md)."""
    if edit and set_file is not None:
        raise CliError("--edit and --set are mutually exclusive", ExitCode.USAGE)
    client = get_client(ctx)
    renderer = get_renderer(ctx)
    if set_file is not None:
        content = sys.stdin.read() if set_file == "-" else Path(set_file).read_text()
        client.put_soul(name, content)
        renderer.progress(f"{name}: persona updated")
        finish(ExitCode.OK)
    current = client.get_soul(name)
    if not edit:
        renderer.data_text(current)
        finish(ExitCode.OK)
    import click

    edited = click.edit(current)  # 0600 tempfile, removed after the editor exits
    if edited is None or edited == current:
        renderer.progress("no changes")
        finish(ExitCode.OK)
    client.put_soul(name, edited)
    renderer.progress(f"{name}: persona updated")
    finish(ExitCode.OK)


@agent_app.command()
def skills(
    ctx: typer.Context,
    name: str,
    enable: Annotated[str | None, typer.Option(help="skill to enable")] = None,
    disable: Annotated[str | None, typer.Option(help="skill to disable")] = None,
    json_output: JsonFlag = False,
) -> None:
    """List or toggle agent skills."""
    if enable is not None and disable is not None:
        raise CliError("--enable and --disable are mutually exclusive", ExitCode.USAGE)
    client = get_client(ctx)
    renderer = get_renderer(ctx, json_mode=json_output)
    if enable is not None or disable is not None:
        skill = enable if enable is not None else disable
        if skill is None:  # pragma: no cover - guarded by the branch condition
            raise CliError("missing skill name", ExitCode.USAGE)
        client.set_skill(name, skill, enabled=enable is not None)
        renderer.progress(f"{name}: skill {skill} {'enabled' if enable else 'disabled'}")
        finish(ExitCode.OK)
    listing = client.get_skills(name)
    if json_output:
        renderer.data_json(listing)
    else:
        renderer.data_table(
            ["SKILL", "ENABLED"],
            [[str(s.get("name", "")), str(s.get("enabled", ""))] for s in listing],
        )
    finish(ExitCode.OK)


@agent_app.command()
def toolsets(
    ctx: typer.Context,
    name: str,
    set_file: Annotated[
        str | None, typer.Option("--set", help="JSON list file path or '-' for stdin")
    ] = None,
    json_output: JsonFlag = False,
) -> None:
    """Show or replace the agent's platform toolsets."""
    client = get_client(ctx)
    renderer = get_renderer(ctx, json_mode=json_output)
    if set_file is not None:
        raw = sys.stdin.read() if set_file == "-" else Path(set_file).read_text()
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise CliError(f"--set expects a JSON list: {exc}", ExitCode.USAGE) from exc
        if not isinstance(parsed, list) or not all(isinstance(x, str) for x in parsed):
            raise CliError("--set expects a JSON list of strings", ExitCode.USAGE)
        client.put_toolsets(name, parsed)
        renderer.progress(f"{name}: toolsets updated")
        finish(ExitCode.OK)
    data = client.get_toolsets(name)
    if json_output:
        renderer.data_json(data)
    else:
        renderer.data_text(json.dumps(data, ensure_ascii=False, indent=2))
    finish(ExitCode.OK)


@token_app.command()
def rotate(ctx: typer.Context, name: str) -> None:
    """Rotate the agent's gateway token (plaintext lives only in profile .env)."""
    get_client(ctx).rotate_token(name)
    get_renderer(ctx).progress(f"{name}: token rotated")  # CLI-P1: never printed
    finish(ExitCode.OK)
