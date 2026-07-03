"""`caduceus` — typer root: command registration, global flags, the single
top-level error handler (pattern P2), shell completion (Q3=A).

Heavy imports (daemon/uvicorn/fastapi) never load here — `serve` pulls them
lazily inside serve_cmd (P4 / U3-PERF-1 / CLI-D2).
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Annotated

import typer

from caduceus.cli.commands.agent import agent_app
from caduceus.cli.commands.gateway import gateway_app
from caduceus.cli.commands.job import job_app
from caduceus.cli.context import AppState, finish, get_renderer, get_state
from caduceus.cli.errors import CliError, ExitCode, map_exception

app = typer.Typer(
    name="caduceus",
    no_args_is_help=True,
    help="Provision, observe and chat with isolated hermes agents.",
    context_settings={"help_option_names": ["-h", "--help"]},
)
app.add_typer(agent_app, name="agent")
app.add_typer(gateway_app, name="gateway")
app.add_typer(job_app, name="job")

serve_app = typer.Typer(help="Run / control the caduceusd daemon")
app.add_typer(serve_app, name="serve", invoke_without_command=True)


def _version_callback(value: bool) -> None:
    if value:
        from caduceus import __version__

        typer.echo(f"caduceus {__version__}")
        raise typer.Exit(0)


@app.callback()
def root(
    ctx: typer.Context,
    home: Annotated[
        Path | None, typer.Option(envvar="CADUCEUS_HOME", help="caduceus home dir")
    ] = None,
    no_color: Annotated[bool, typer.Option("--no-color", help="disable colors")] = False,
    quiet: Annotated[bool, typer.Option("-q", "--quiet", help="suppress progress")] = False,
    debug: Annotated[bool, typer.Option("--debug", help="show tracebacks")] = False,
    version: Annotated[
        bool,
        typer.Option("--version", callback=_version_callback, is_eager=True,
                     help="print version and exit"),
    ] = False,
) -> None:
    state = ctx.find_object(AppState)
    if state is None:
        state = AppState(home=home or Path.home() / ".caduceus")
        ctx.obj = state
    if home is not None:
        state.home = home
    state.no_color = state.no_color or no_color
    state.quiet = state.quiet or quiet
    state.debug = state.debug or debug


# -- bootstrap commands -----------------------------------------------------------


@app.command()
def init(ctx: typer.Context) -> None:
    """Create ~/.caduceus (config, admin token) and configure the upstream."""
    from caduceus.cli.bootstrap import run_init

    state = get_state(ctx)
    code = run_init(
        get_renderer(ctx),
        state.home,
        interactive=sys.stdin.isatty(),
    )
    finish(code)


@app.command()
def doctor(ctx: typer.Context) -> None:
    """Diagnose hermes/docker/home/daemon/upstream/registry."""
    import asyncio

    from caduceus.cli.bootstrap import doctor_rows, render_doctor
    from caduceus.core.hermes_adapter import HermesAdapter
    from caduceus.core.ports import RealCommandRunner, RealFileStore

    state = get_state(ctx)
    renderer = get_renderer(ctx)
    adapter = HermesAdapter(
        RealCommandRunner(), RealFileStore(), hermes_home=Path.home() / ".hermes"
    )
    report = asyncio.run(adapter.preflight())
    preflight_checks = [(c.name, c.ok, c.detail) for c in report.checks]

    def probe() -> dict[str, object]:
        return state.client().healthz()

    rows = doctor_rows(
        state.home,
        files=RealFileStore(),
        preflight_checks=preflight_checks,
        daemon_probe=probe,
        gateway_info=lambda: state.client().gateway_info(),
        agent_count=lambda: len(state.client().list_agents()),
    )
    finish(render_doctor(renderer, rows))


@app.command()
def ui(ctx: typer.Context) -> None:
    """Open the web UI in the default browser (token never placed in the URL)."""
    from caduceus.cli.bootstrap import open_ui
    from caduceus.core.config import CaduceusConfigStore
    from caduceus.core.ports import RealFileStore

    state = get_state(ctx)
    url = "http://127.0.0.1:4285"
    store = CaduceusConfigStore(state.home / "config.yaml", RealFileStore())
    if store.exists():
        listen = store.load().listen
        url = f"http://{listen.host}:{listen.port}"
    finish(open_ui(get_renderer(ctx), url))


# -- serve group (Q2=B) --------------------------------------------------------------


@serve_app.callback(invoke_without_command=True)
def serve(
    ctx: typer.Context,
    host: Annotated[str | None, typer.Option(help="bind host")] = None,
    port: Annotated[int | None, typer.Option(help="bind port")] = None,
    detach: Annotated[
        bool, typer.Option("-d", "--detach", help="daemonize (POSIX only)")
    ] = False,
) -> None:
    """Run caduceusd in the foreground, or detached with -d."""
    if ctx.invoked_subcommand is not None:
        return
    from caduceus.cli.serve_cmd import run_serve

    state = get_state(ctx)
    finish(run_serve(get_renderer(ctx), state.home, host=host, port=port, detach=detach))


@serve_app.command("stop")
def serve_stop(ctx: typer.Context) -> None:
    """Stop a detached caduceusd (single SIGTERM, graceful)."""
    from caduceus.cli.serve_cmd import run_serve_stop

    finish(run_serve_stop(get_renderer(ctx), get_state(ctx).home))


@serve_app.command("status")
def serve_status(ctx: typer.Context) -> None:
    """Report detached daemon liveness + health."""
    from caduceus.cli.serve_cmd import run_serve_status

    finish(run_serve_status(get_renderer(ctx), get_state(ctx).home))


# -- chat (F6) -----------------------------------------------------------------------


@app.command()
def chat(
    ctx: typer.Context,
    name: str,
    session: Annotated[str | None, typer.Option(help="resume a specific session")] = None,
    new: Annotated[bool, typer.Option("--new", help="start a fresh session")] = False,
) -> None:
    """Streaming chat with an agent (resume, thinking/tool render, Ctrl+C = stop turn)."""
    if session is not None and new:
        raise CliError("--session and --new are mutually exclusive", ExitCode.USAGE)
    from caduceus.cli.chat import ChatApp

    state = get_state(ctx)
    chat_app = ChatApp(state.client(), get_renderer(ctx), name)
    finish(chat_app.run(session_id=session, new=new))


# -- entry point ----------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    """The single error funnel (P2): CliError → rendered message + exit code;
    click owns usage errors (SystemExit 2); anything else is mapped, never a
    traceback (CLI-E4) unless --debug."""
    args = argv if argv is not None else sys.argv[1:]
    try:
        app(args=args, prog_name="caduceus", standalone_mode=True)
    except SystemExit as exit_:  # click standalone exit (success or usage error)
        code = exit_.code
        return code if isinstance(code, int) else (0 if code is None else 1)
    except CliError as err:
        _report(err)
        return int(err.exit_code)
    except Exception as exc:  # noqa: BLE001 - last-resort mapping
        if "--debug" in args:
            raise
        mapped = map_exception(exc)
        _report(mapped)
        return int(mapped.exit_code)
    return 0


def _report(err: CliError) -> None:
    from caduceus.cli.output import Renderer

    Renderer(no_color="--no-color" in sys.argv).error(err)


if __name__ == "__main__":
    sys.exit(main())
