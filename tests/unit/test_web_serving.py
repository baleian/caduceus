"""U4 — SPA serving + SECURITY-04 headers (daemon side) and `caduceus ui`
fragment attachment (W5/U4-SEC-1, FD Q1=A)."""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from caduceus.core.config import CaduceusConfigStore
from caduceus.core.types import CaduceusConfig, UpstreamConfig
from caduceus.daemon import SECURITY_HEADERS, build_daemon
from tests.unit.fakes import FakeClock, InMemoryFileStore, ScriptedRunner
from tests.unit.test_process_manager import FakeHandle

CADUCEUS_HOME = Path("/home/u/.caduceus")
HERMES_HOME = Path("/home/u/.hermes")


class _Spawner:
    async def spawn(self, argv: list[str], *, env: dict[str, str] | None = None) -> FakeHandle:
        return FakeHandle()


def make_app(
    tmp_path: Path,
    *,
    with_dist: bool,
    agent_transport: object | None = None,
) -> tuple[TestClient, InMemoryFileStore, object]:
    files = InMemoryFileStore()
    config = CaduceusConfig(
        upstream=UpstreamConfig(base_url="http://upstream.test/v1", default_model="m")
    )
    store = CaduceusConfigStore(CADUCEUS_HOME / "config.yaml", files)
    store.save(config)
    web_dist = tmp_path / "web_dist"
    if with_dist:
        (web_dist / "assets").mkdir(parents=True)
        (web_dist / "index.html").write_text("<!doctype html><title>caduceus</title>")
        (web_dist / "assets" / "app-abc123.js").write_text("console.log('x')")
    daemon = build_daemon(
        config=config,
        config_store=store,
        caduceus_home=CADUCEUS_HOME,
        files=files,
        clock=FakeClock(),
        runner=ScriptedRunner(),
        spawner=_Spawner(),
        hermes_home=HERMES_HOME,
        agent_transport=agent_transport,  # type: ignore[arg-type]
        web_dist=web_dist,
    )
    return TestClient(daemon.app), files, daemon


def admin_headers(files: InMemoryFileStore) -> dict[str, str]:
    token = files.read_text(CADUCEUS_HOME / "admin.token").strip()
    return {"X-Caduceus-Token": token}


class TestSpaServing:
    def test_root_serves_index_html_publicly(self, tmp_path: Path) -> None:
        client, _, _daemon = make_app(tmp_path, with_dist=True)
        response = client.get("/")
        assert response.status_code == 200
        assert "caduceus" in response.text
        assert response.headers["content-type"].startswith("text/html")

    def test_spa_deep_links_fall_back_to_index(self, tmp_path: Path) -> None:
        client, _, _daemon = make_app(tmp_path, with_dist=True)
        for path in ("/agents", "/agents/my-agent", "/chat/my-agent", "/gateway", "/system"):
            response = client.get(path)
            assert response.status_code == 200, path
            assert "caduceus" in response.text, path

    def test_agent_relay_paths_stay_token_gated(self, tmp_path: Path) -> None:
        client, files, _daemon = make_app(tmp_path, with_dist=True)
        assert client.get("/agents/foo/api/api/sessions").status_code == 401
        assert client.get("/api/agents").status_code == 401
        # and with the token, /api answers (empty list) — not the SPA shell
        response = client.get("/api/agents", headers=admin_headers(files))
        assert response.status_code == 200
        assert response.json() == []

    def test_unknown_api_paths_return_json_404_not_html(self, tmp_path: Path) -> None:
        client, files, _daemon = make_app(tmp_path, with_dist=True)
        response = client.get("/api/nope", headers=admin_headers(files))
        assert response.status_code == 404
        assert response.headers["content-type"].startswith("application/json")

    def test_assets_are_served_with_immutable_cache(self, tmp_path: Path) -> None:
        client, _, _daemon = make_app(tmp_path, with_dist=True)
        response = client.get("/assets/app-abc123.js")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"

    def test_index_and_api_are_no_store(self, tmp_path: Path) -> None:
        client, files, _daemon = make_app(tmp_path, with_dist=True)
        assert client.get("/").headers["cache-control"] == "no-store"
        assert (
            client.get("/api/agents", headers=admin_headers(files)).headers["cache-control"]
            == "no-store"
        )

    def test_missing_dist_yields_actionable_404(self, tmp_path: Path) -> None:
        client, _, _daemon = make_app(tmp_path, with_dist=False)
        response = client.get("/")
        assert response.status_code == 404
        assert "web UI not built" in response.json()["error"]


class TestRelayHeaderHygiene:
    """Browser-context headers must never reach the agent api_server: its CORS
    middleware 403s on any non-allowlisted Origin (found in real use — the
    browser attaches Origin on POST, the CLI never does)."""

    def test_origin_referer_cookie_are_stripped(self, tmp_path: Path) -> None:
        import httpx

        from caduceus.core.types import AgentRecord, AgentSpec

        seen: dict[str, str] = {}

        def agent_handler(request: httpx.Request) -> httpx.Response:
            seen.clear()
            seen.update({k.lower(): v for k, v in request.headers.items()})
            return httpx.Response(201, json={"session": {"id": "s1"}})

        client, files, daemon = make_app(
            tmp_path, with_dist=True, agent_transport=httpx.MockTransport(agent_handler)
        )
        daemon.registry.add(  # type: ignore[attr-defined]
            AgentRecord(
                spec=AgentSpec(name="a1"),
                profile_name="cad-a1",
                workspace_dir="/w/a1",
                api_port=39001,
                api_server_key="k" * 32,
                token_hash="0" * 64,
                desired_state="stopped",
                created_at="2026-07-03T00:00:00Z",
            )
        )
        response = client.post(
            "/agents/a1/api/api/sessions",
            headers={
                **admin_headers(files),
                "Origin": "http://127.0.0.1:4285",
                "Referer": "http://127.0.0.1:4285/chat/a1",
                "Cookie": "tracking=1",
            },
            json={},
        )
        assert response.status_code == 201
        for banned in ("origin", "referer", "cookie", "x-caduceus-token"):
            assert banned not in seen
        assert seen["authorization"] == "Bearer " + "k" * 32  # server-side key attach


class TestSecurityHeaders:
    def test_every_response_carries_the_security_header_set(self, tmp_path: Path) -> None:
        client, files, _daemon = make_app(tmp_path, with_dist=True)
        for response in (
            client.get("/"),
            client.get("/healthz"),
            client.get("/api/agents", headers=admin_headers(files)),
            client.get("/api/agents"),  # 401 too
        ):
            for name, value in SECURITY_HEADERS.items():
                assert response.headers.get(name) == value

    def test_csp_forbids_external_origins(self, tmp_path: Path) -> None:
        client, _, _daemon = make_app(tmp_path, with_dist=True)
        csp = client.get("/").headers["content-security-policy"]
        assert "default-src 'self'" in csp
        assert "frame-ancestors 'none'" in csp


class TestUiFragment:
    """`caduceus ui` attaches the admin token as a URL fragment (FD Q1=A)."""

    def _run_ui(self, tmp_path: Path, monkeypatch: object) -> str:
        import caduceus.cli.bootstrap as bootstrap
        from caduceus.cli.main import main

        opened: list[str] = []

        def fake_open_ui(renderer: object, url: str) -> int:
            opened.append(url)
            return 0

        monkeypatch.setattr(bootstrap, "open_ui", fake_open_ui)  # type: ignore[attr-defined]
        assert main(["--home", str(tmp_path), "ui"]) == 0
        assert len(opened) == 1
        return opened[0]

    def test_token_file_present_appends_fragment(
        self, tmp_path: Path, monkeypatch: object
    ) -> None:
        (tmp_path / "admin.token").write_text("cafe1234\n")
        url = self._run_ui(tmp_path, monkeypatch)
        assert url.endswith("/#token=cafe1234")
        # fragment, not query/path — nothing after the origin travels to the server
        assert "?" not in url

    def test_without_token_file_opens_bare_url(
        self, tmp_path: Path, monkeypatch: object
    ) -> None:
        url = self._run_ui(tmp_path, monkeypatch)
        assert "#token=" not in url


class TestOpenUi:
    """open_ui must never block the terminal (no console browsers — U4 fix)
    and must always print the URL first."""

    def _renderer(self) -> object:
        from rich.console import Console

        from caduceus.cli.output import Renderer

        return Renderer(
            stdout=Console(record=True, force_terminal=False),
            stderr=Console(record=True, force_terminal=False),
        )

    def test_prints_full_url_unredacted_even_with_no_opener(
        self, monkeypatch: object
    ) -> None:
        import caduceus.cli.bootstrap as bootstrap

        monkeypatch.setattr(bootstrap.shutil, "which", lambda name: None)  # type: ignore[attr-defined]
        monkeypatch.delenv("DISPLAY", raising=False)  # type: ignore[attr-defined]
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)  # type: ignore[attr-defined]
        renderer = self._renderer()
        # a hex token would be masked by the redact gate — the ui URL print is
        # the documented user-approved exception (decision 2026-07-03)
        hex_token = "cafe" * 16
        assert bootstrap.open_ui(renderer, f"http://x/#token={hex_token}") == 0  # type: ignore[arg-type]
        text = renderer.out.export_text()  # type: ignore[attr-defined]
        assert f"http://x/#token={hex_token}" in text
        assert "***" not in text

    def test_spawns_only_gui_openers_fire_and_forget(self, monkeypatch: object) -> None:
        import caduceus.cli.bootstrap as bootstrap

        spawned: list[list[str]] = []

        class FakeProc:
            pass

        def fake_popen(argv: list[str], **kwargs: object) -> FakeProc:
            spawned.append(list(argv))
            return FakeProc()

        monkeypatch.setattr(  # type: ignore[attr-defined]
            bootstrap.shutil,
            "which",
            lambda name: f"/usr/bin/{name}" if name == "wslview" else None,
        )
        monkeypatch.setattr(bootstrap, "_is_wsl", lambda: True)  # type: ignore[attr-defined]
        monkeypatch.setattr(bootstrap.subprocess, "Popen", fake_popen)  # type: ignore[attr-defined]
        renderer = self._renderer()
        assert bootstrap.open_ui(renderer, "http://x/#token=s") == 0  # type: ignore[arg-type]
        assert spawned == [["/usr/bin/wslview", "http://x/#token=s"]]

    def test_gui_openers_never_include_console_browsers(self, monkeypatch: object) -> None:
        import caduceus.cli.bootstrap as bootstrap

        # even with w3m/lynx present, they are never candidates
        monkeypatch.setattr(  # type: ignore[attr-defined]
            bootstrap.shutil,
            "which",
            lambda name: f"/usr/bin/{name}" if name in ("w3m", "lynx", "www-browser") else None,
        )
        monkeypatch.setattr(bootstrap, "_is_wsl", lambda: False)  # type: ignore[attr-defined]
        monkeypatch.delenv("DISPLAY", raising=False)  # type: ignore[attr-defined]
        monkeypatch.delenv("WAYLAND_DISPLAY", raising=False)  # type: ignore[attr-defined]
        assert bootstrap._gui_openers() == []
