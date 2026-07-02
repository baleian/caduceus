"""AdminAuth + JobEngine example tests (A1–A4, serial execution, E4)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from caduceus.control.auth import AdminAuth, AdminAuthMiddleware, load_or_create_admin_token
from caduceus.control.jobs import JobEngine
from tests.unit.fakes import FakeClock, InMemoryFileStore, RecordingEventSink

HOME = Path("/home/u/.caduceus")


class TestAdminToken:
    def test_created_once_with_mode_600(self) -> None:
        files = InMemoryFileStore()
        token1 = load_or_create_admin_token(HOME, files)
        token2 = load_or_create_admin_token(HOME, files)
        assert token1 == token2  # stable across restarts
        assert len(token1) == 64
        assert files.modes[str(HOME / "admin.token")] == 0o600

    def test_verify_constant_time_semantics(self) -> None:
        auth = AdminAuth("secret-token")
        assert auth.verify("secret-token")
        assert not auth.verify("wrong")
        assert not auth.verify(None)
        assert not auth.verify("")


def make_protected_app() -> tuple[TestClient, str]:
    app = FastAPI()
    auth = AdminAuth("tok-123")

    @app.get("/api/agents")
    async def agents() -> dict:  # type: ignore[type-arg]
        return {"ok": True}

    @app.get("/healthz")
    async def healthz() -> dict:  # type: ignore[type-arg]
        return {"ok": True}

    @app.get("/other")
    async def other() -> dict:  # type: ignore[type-arg]
        return {"ok": True}

    app.add_middleware(AdminAuthMiddleware, auth=auth)
    return TestClient(app), "tok-123"


class TestAuthMiddleware:
    def test_api_requires_token(self) -> None:
        client, token = make_protected_app()
        assert client.get("/api/agents").status_code == 401
        assert client.get("/api/agents", headers={"X-Caduceus-Token": token}).status_code == 200
        assert (
            client.get("/api/agents", headers={"Authorization": f"Bearer {token}"}).status_code
            == 200
        )

    def test_healthz_public_and_unprotected_paths_pass(self) -> None:
        client, _ = make_protected_app()
        assert client.get("/healthz").status_code == 200
        assert client.get("/other").status_code == 200  # /v1 등은 별도 체계 (A2)

    def test_401_body_is_undifferentiated(self) -> None:
        client, _ = make_protected_app()
        r1 = client.get("/api/agents")
        r2 = client.get("/api/agents", headers={"X-Caduceus-Token": "wrong"})
        assert r1.json() == r2.json() == {"error": "unauthorized"}  # A3


class TestJobEngine:
    async def test_jobs_execute_serially_in_submit_order(self) -> None:
        engine = JobEngine(RecordingEventSink(), FakeClock())
        engine.start_worker()
        order: list[str] = []

        def step(tag: str):  # type: ignore[no-untyped-def]
            async def run() -> None:
                order.append(f"{tag}-begin")
                await asyncio.sleep(0)
                order.append(f"{tag}-end")

            return run

        job_a = engine.submit("create", "a", [("s1", step("a1")), ("s2", step("a2"))])
        job_b = engine.submit("create", "b", [("s1", step("b1"))])
        for _ in range(50):
            await asyncio.sleep(0)
        assert order == ["a1-begin", "a1-end", "a2-begin", "a2-end", "b1-begin", "b1-end"]
        assert engine.get(job_a.id).state == "done"
        assert engine.get(job_b.id).state == "done"
        await engine.stop_worker()

    async def test_failed_step_fails_job_and_skips_rest(self) -> None:
        sink = RecordingEventSink()
        engine = JobEngine(sink, FakeClock())
        engine.start_worker()

        async def ok() -> None:
            return None

        async def boom() -> None:
            raise RuntimeError("secret deadbeefdeadbeefdeadbeefdeadbeef")

        async def never() -> None:
            raise AssertionError("must not run")

        job = engine.submit(
            "create", "x", [("one", ok), ("two", boom), ("three", never)]
        )
        for _ in range(50):
            await asyncio.sleep(0)
        snap = engine.get(job.id).snapshot()
        assert snap["state"] == "failed"
        assert [s["state"] for s in snap["steps"]] == ["ok", "failed", "skipped"]
        assert "deadbeef" not in (snap["error"] or "")  # redacted
        assert any(e.kind == "job.failed" for e in sink.events)
        await engine.stop_worker()
