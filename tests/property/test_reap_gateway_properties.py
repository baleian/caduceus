"""reap_gateway properties (orphan-gateway hardening, PBT extension).

Safety and effectiveness invariants for the pidfile-based gateway reaper:
- SAFETY: a live process whose identity does NOT match the recorded gateway is
  never signalled (guards against PID recycling).
- EFFECTIVENESS: a live, identity-matching gateway is always signalled, and a
  killable one ends up dead.
- NO-OP: an absent or already-dead pidfile signals nothing.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st

from caduceus.core.hermes_adapter import HermesAdapter
from tests.unit.fakes import FakeClock, FakeProc, FakeSignaller, InMemoryFileStore, ScriptedRunner

HOME = Path("/home/u/.hermes")
PROFILE = "cad-prop"


def _adapter(sig: FakeSignaller) -> tuple[HermesAdapter, InMemoryFileStore]:
    files = InMemoryFileStore()
    return HermesAdapter(ScriptedRunner(), files, hermes_home=HOME, signaller=sig), files


def _write_pidfile(files: InMemoryFileStore, pid: int, start_time: int | None) -> None:
    files.write_text_atomic(
        HOME / "profiles" / PROFILE / "gateway.pid",
        json.dumps({"pid": pid, "kind": "hermes-gateway", "argv": [], "start_time": start_time}),
    )


pids = st.integers(min_value=1, max_value=99999)
starts = st.integers(min_value=1, max_value=10_000)


@settings(max_examples=200, deadline=None)
@given(
    pid=pids,
    file_start=st.one_of(st.none(), starts),
    live_start=starts,
    profile_in_cmd=st.booleans(),
    gateway_in_cmd=st.booleans(),
)
def test_identity_mismatch_never_signals(
    pid: int,
    file_start: int | None,
    live_start: int,
    profile_in_cmd: bool,
    gateway_in_cmd: bool,
) -> None:
    cmd = ["/x/hermes"]
    if profile_in_cmd:
        cmd.append(PROFILE)
    if gateway_in_cmd:
        cmd.append("gateway")
    identity_ok = (
        file_start is not None
        and file_start == live_start
        and profile_in_cmd
        and gateway_in_cmd
    )
    if identity_ok:
        return  # this example is a genuine match — covered by the effectiveness test

    sig = FakeSignaller({pid: FakeProc(alive=True, start_time=live_start, cmdline=cmd)})
    adapter, files = _adapter(sig)
    _write_pidfile(files, pid, file_start)

    result = asyncio.run(adapter.reap_gateway(PROFILE, clock=FakeClock(), grace_s=0.5))
    assert result == "mismatch"
    assert sig.signals == []  # SAFETY: an unmatched live process is never touched


@settings(max_examples=100, deadline=None)
@given(pid=pids, start=starts, dies_on=st.sampled_from(["SIGTERM", "SIGKILL", None]))
def test_matching_gateway_is_signalled_and_killable_dies(
    pid: int, start: int, dies_on: str | None
) -> None:
    sig = FakeSignaller(
        {pid: FakeProc(
            alive=True, start_time=start,
            cmdline=["/x/hermes", "-p", PROFILE, "gateway"], dies_on=dies_on,
        )}
    )
    adapter, files = _adapter(sig)
    _write_pidfile(files, pid, start)

    result = asyncio.run(adapter.reap_gateway(PROFILE, clock=FakeClock(), grace_s=0.5))

    assert (pid, "SIGTERM") in sig.signals  # always at least SIGTERM
    if dies_on is None:
        assert result == "survived"
        assert (pid, "SIGKILL") in sig.signals  # escalated
        assert sig.alive(pid)
    else:
        assert result == "terminated"
        assert not sig.alive(pid)


@settings(max_examples=100, deadline=None)
@given(pid=pids, start=starts, present=st.booleans())
def test_absent_or_dead_signals_nothing(pid: int, start: int, present: bool) -> None:
    # present=False → no pidfile at all (absent); present=True → pidfile but the
    # process is not alive (stale/dead). Neither may signal.
    sig = FakeSignaller({pid: FakeProc(alive=False, start_time=start)})
    adapter, files = _adapter(sig)
    if present:
        _write_pidfile(files, pid, start)

    result = asyncio.run(adapter.reap_gateway(PROFILE, clock=FakeClock(), grace_s=0.5))
    assert result == ("dead" if present else "absent")
    assert sig.signals == []
