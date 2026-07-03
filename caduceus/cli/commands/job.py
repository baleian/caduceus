"""`caduceus job *` — provisioning job inspection (S1 observability)."""

from __future__ import annotations

from typing import Annotated

import typer

from caduceus.cli.context import finish, get_client, get_renderer
from caduceus.cli.errors import ExitCode
from caduceus.cli.output import STEP_ICONS

job_app = typer.Typer(no_args_is_help=True, help="Provisioning jobs")

JsonFlag = Annotated[bool, typer.Option("--json", help="machine-readable output")]


@job_app.command("ls")
def list_jobs(ctx: typer.Context, json_output: JsonFlag = False) -> None:
    """List known jobs (in-memory, daemon lifetime)."""
    jobs = get_client(ctx).list_jobs()
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(jobs)
    else:
        renderer.data_table(
            ["ID", "KIND", "AGENT", "STATE", "CREATED"],
            [
                [
                    str(j.get("id", "")),
                    str(j.get("kind", "")),
                    str(j.get("agent", "")),
                    str(j.get("state", "")),
                    str(j.get("created_at", "")),
                ]
                for j in jobs
            ],
        )
    finish(ExitCode.OK)


@job_app.command()
def status(ctx: typer.Context, job_id: str, json_output: JsonFlag = False) -> None:
    """Show one job with step states."""
    snapshot = get_client(ctx).get_job(job_id)
    renderer = get_renderer(ctx, json_mode=json_output)
    if json_output:
        renderer.data_json(snapshot)
    else:
        renderer.data_text(
            f"{snapshot.get('id')} [{snapshot.get('kind')}/{snapshot.get('agent')}] "
            f"{snapshot.get('state')}"
        )
        for step in snapshot.get("steps", []):
            icon = STEP_ICONS.get(str(step.get("state")), "?")
            renderer.data_text(f"  {icon} {step.get('name')}")
        if snapshot.get("error"):
            renderer.data_text(f"  error: {snapshot['error']}")
    finish(ExitCode.OK)


@job_app.command()
def wait(ctx: typer.Context, job_id: str, json_output: JsonFlag = False) -> None:
    """Wait for a job to finish (picks up a --no-wait submission)."""
    renderer = get_renderer(ctx, json_mode=json_output)
    snapshot = get_client(ctx).wait_job(job_id, on_snapshot=renderer.job_progress_sink())
    finish(renderer.job_outcome(snapshot))
