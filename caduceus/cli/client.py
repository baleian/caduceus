"""Admin API client (sync httpx) — the CLI's only channel to the daemon.

Connection context resolution (domain-entities §1):
``CADUCEUS_URL``/``CADUCEUS_ADMIN_TOKEN`` env → ``~/.caduceus/config.yaml`` +
``admin.token`` → defaults. Every request carries the admin bearer token; every
non-2xx response is converted to :class:`CliError` through the single mapping
table (errors.py). No retries anywhere (U3-REL-4).
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx

from caduceus.cli.errors import CliError, ExitCode, error_from_response
from caduceus.core.config import CaduceusConfigStore
from caduceus.core.ports import RealFileStore

DEFAULT_HOME = Path.home() / ".caduceus"
DEFAULT_URL = "http://127.0.0.1:4285"

CONNECT_TIMEOUT_S = 5.0
READ_TIMEOUT_S = 30.0
JOB_POLL_INTERVAL_S = 0.5

JobSink = Callable[[dict[str, Any]], None]


@dataclass(frozen=True)
class ClientConfig:
    base_url: str
    admin_token: str
    home: Path


def resolve_client_config(
    *, home: Path | None = None, env: Mapping[str, str] | None = None
) -> ClientConfig:
    """Resolution order: env override → local files → defaults (CLI-D3 scope)."""
    import os

    env = env if env is not None else os.environ
    home = home or Path(env.get("CADUCEUS_HOME", "")) or DEFAULT_HOME

    base_url = env.get("CADUCEUS_URL", "").strip()
    if not base_url:
        base_url = DEFAULT_URL
        store = CaduceusConfigStore(home / "config.yaml", RealFileStore())
        if store.exists():
            listen = store.load().listen
            base_url = f"http://{listen.host}:{listen.port}"

    token = env.get("CADUCEUS_ADMIN_TOKEN", "").strip()
    if not token:
        token_path = home / "admin.token"
        if token_path.exists():
            token = token_path.read_text().strip()
    if not token:
        raise CliError(
            "no admin token found — caduceus is not initialized",
            ExitCode.UNREACHABLE,
            hint="run `caduceus init` or `caduceus serve` first",
        )
    return ClientConfig(base_url=base_url.rstrip("/"), admin_token=token, home=home)


class ApiClient:
    """Thin, retry-free wrapper over the Admin API contract (business-logic §1)."""

    def __init__(
        self,
        config: ClientConfig,
        *,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._config = config
        self._sleep = sleep
        self._http = httpx.Client(
            base_url=config.base_url,
            transport=transport,
            headers={"Authorization": f"Bearer {config.admin_token}"},
            timeout=httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=READ_TIMEOUT_S,
                                  write=30.0, pool=CONNECT_TIMEOUT_S),
        )

    def close(self) -> None:
        self._http.close()

    # -- plumbing -------------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        timeout: httpx.Timeout | None = None,
    ) -> httpx.Response:
        response = self._http.request(
            method, path, json=json, params=params, headers=headers,
            timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
        )
        if response.status_code >= 400:
            raise error_from_response(response.status_code, response.content)
        return response

    def _json(self, method: str, path: str, **kw: Any) -> Any:
        return self._request(method, path, **kw).json()

    # -- agents (F9) ----------------------------------------------------------

    def list_agents(self, *, probe: bool = False) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = self._json(
            "GET", "/api/agents", params={"probe": probe} if probe else None
        )
        return result

    def get_agent(self, name: str, *, probe: bool = False) -> dict[str, Any]:
        result: dict[str, Any] = self._json(
            "GET", f"/api/agents/{name}", params={"probe": probe} if probe else None
        )
        return result

    def create_agent(self, spec: dict[str, Any]) -> str:
        data = self._json("POST", "/api/agents", json=spec)
        return str(data["job_id"])

    def remove_agent(self, name: str) -> str:
        # A5: the confirmation decision was made interactively by the caller
        data = self._json("DELETE", f"/api/agents/{name}", headers={"X-Confirm": name})
        return str(data["job_id"])

    def start_agent(self, name: str) -> None:
        self._request("POST", f"/api/agents/{name}/start")

    def stop_agent(self, name: str) -> None:
        self._request("POST", f"/api/agents/{name}/stop")

    def logs(self, name: str, *, last: int = 200) -> list[str]:
        lines: list[str] = self._json("GET", f"/api/agents/{name}/logs", params={"last": last})[
            "lines"
        ]
        return lines

    def rotate_token(self, name: str) -> None:
        self._request("POST", f"/api/agents/{name}/token/rotate")

    # -- persona / skills / toolsets (F7) --------------------------------------

    def get_soul(self, name: str) -> str:
        return str(self._json("GET", f"/api/agents/{name}/soul")["content"])

    def put_soul(self, name: str, content: str) -> None:
        self._request("PUT", f"/api/agents/{name}/soul", json={"content": content})

    def get_skills(self, name: str) -> list[dict[str, Any]]:
        skills: list[dict[str, Any]] = self._json("GET", f"/api/agents/{name}/skills")["skills"]
        return skills

    def set_skill(self, name: str, skill: str, *, enabled: bool) -> None:
        self._request(
            "PUT", f"/api/agents/{name}/skills/{skill}", json={"enabled": enabled}
        )

    def get_toolsets(self, name: str) -> Any:
        return self._json("GET", f"/api/agents/{name}/toolsets")["toolsets"]

    def put_toolsets(self, name: str, toolsets: list[str]) -> None:
        self._request("PUT", f"/api/agents/{name}/toolsets", json={"toolsets": toolsets})

    # -- gateway / status -------------------------------------------------------

    def gateway_info(self) -> dict[str, Any]:
        result: dict[str, Any] = self._json("GET", "/api/gateway")
        return result

    def put_upstream(
        self, base_url: str, *, api_key_env: str | None = None, default_model: str | None = None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"base_url": base_url}
        if api_key_env is not None:
            body["api_key_env"] = api_key_env
        if default_model is not None:
            body["default_model"] = default_model
        result: dict[str, Any] = self._json("PUT", "/api/gateway/upstream", json=body)
        return result

    def deep_status(self) -> dict[str, Any]:
        result: dict[str, Any] = self._json("GET", "/api/status")
        return result

    def healthz(self) -> dict[str, Any]:
        result: dict[str, Any] = self._json("GET", "/healthz")
        return result

    # -- jobs (business-logic §2) -----------------------------------------------

    def list_jobs(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = self._json("GET", "/api/jobs")
        return result

    def get_job(self, job_id: str) -> dict[str, Any]:
        result: dict[str, Any] = self._json("GET", f"/api/jobs/{job_id}")
        return result

    def wait_job(self, job_id: str, on_snapshot: JobSink | None = None) -> dict[str, Any]:
        """Poll until the job reaches a terminal state; no overall timeout —
        the daemon owns job state (U3-REL-3)."""
        while True:
            snapshot = self.get_job(job_id)
            if on_snapshot is not None:
                on_snapshot(snapshot)
            if snapshot.get("state") in ("done", "failed"):
                return snapshot
            self._sleep(JOB_POLL_INTERVAL_S)

    # -- agent api_server relay (chat — S2, business-logic §3) -------------------

    def agent_api(
        self,
        name: str,
        method: str,
        subpath: str,
        *,
        json: Any | None = None,
    ) -> Any:
        response = self._request(method, f"/agents/{name}/api/{subpath}", json=json)
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    @contextmanager
    def agent_api_stream(
        self, name: str, method: str, subpath: str, *, json: Any | None = None
    ) -> Iterator[httpx.Response]:
        """SSE stream via the daemon relay — read timeout unlimited (U3-REL-3)."""
        with self._http.stream(
            method,
            f"/agents/{name}/api/{subpath}",
            json=json,
            timeout=httpx.Timeout(connect=CONNECT_TIMEOUT_S, read=None, write=30.0,
                                  pool=CONNECT_TIMEOUT_S),
        ) as response:
            if response.status_code >= 400:
                response.read()
                raise error_from_response(response.status_code, response.content)
            yield response
