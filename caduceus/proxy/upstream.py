"""Upstream OpenAI-compatible client with atomic hot swap (S4, logic §1.2)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os

import httpx

from caduceus.core.errors import ConfigError
from caduceus.core.types import UpstreamConfig

logger = logging.getLogger(__name__)

CONNECT_TIMEOUT_S = 10.0
STREAM_IDLE_TIMEOUT_S = 120.0  # httpx read timeout = per-chunk idle for streams
WRITE_TIMEOUT_S = 30.0
POOL_TIMEOUT_S = 10.0
NONSTREAM_TOTAL_TIMEOUT_S = 600.0
OLD_CLIENT_LINGER_S = 600.0  # let in-flight streams finish before closing


def _resolve_api_key(config: UpstreamConfig) -> str | None:
    """S4: keys are referenced by env-var name, never stored literally."""
    if not config.api_key_env:
        return None
    value = os.environ.get(config.api_key_env, "").strip()
    if not value:
        raise ConfigError(
            f"upstream api_key_env {config.api_key_env!r} is set but the "
            "environment variable is empty or missing"
        )
    return value


class UpstreamClient:
    """Holds the current httpx client; ``swap`` replaces it atomically."""

    def __init__(
        self, config: UpstreamConfig, *, transport: httpx.AsyncBaseTransport | None = None
    ) -> None:
        self._transport = transport  # test seam (MockTransport)
        self._config = config
        self._client = self._build(config)

    @property
    def config(self) -> UpstreamConfig:
        return self._config

    @property
    def client(self) -> httpx.AsyncClient:
        return self._client

    def target_url(self, proxy_path: str) -> str:
        """Map incoming ``/v1/...`` to the upstream base (which ends in /v1)."""
        sub_path = proxy_path.removeprefix("/v1")
        return f"{self._config.base_url}{sub_path}"

    def swap(self, config: UpstreamConfig) -> None:
        """Atomic reference swap; the old client lingers for in-flight streams."""
        new_client = self._build(config)
        old_client = self._client
        self._client = new_client
        self._config = config
        with contextlib.suppress(RuntimeError):  # no running loop in some tests
            asyncio.get_running_loop().create_task(self._close_later(old_client))

    async def aclose(self) -> None:
        await self._client.aclose()

    def _build(self, config: UpstreamConfig) -> httpx.AsyncClient:
        headers = {}
        api_key = _resolve_api_key(config)
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        return httpx.AsyncClient(
            transport=self._transport,
            headers=headers,
            timeout=httpx.Timeout(
                connect=CONNECT_TIMEOUT_S,
                read=STREAM_IDLE_TIMEOUT_S,
                write=WRITE_TIMEOUT_S,
                pool=POOL_TIMEOUT_S,
            ),
        )

    @staticmethod
    async def _close_later(client: httpx.AsyncClient) -> None:
        await asyncio.sleep(OLD_CLIENT_LINGER_S)
        with contextlib.suppress(Exception):
            await client.aclose()
