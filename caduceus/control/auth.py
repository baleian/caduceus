"""Admin API authentication (FD6, rules A1–A4).

A single CSPRNG token, generated at init time, stored 0600, compared in
constant time. Applies to every /api/* and /agents/* route; /healthz is the
only public path.
"""

from __future__ import annotations

import hmac
import re

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from caduceus.core.tokens import ADMIN_TOKEN_FILE, load_or_create_admin_token

__all__ = [
    "ADMIN_TOKEN_FILE",
    "AdminAuth",
    "AdminAuthMiddleware",
    "load_or_create_admin_token",
]

_PUBLIC_PATHS = frozenset({"/healthz"})
# /api/* plus the agent api_server relay. Plain /agents/{name} (no /api
# segment) is a browser SPA route — it must serve the public index.html
# shell so deep links survive a refresh (U4; the shell carries no data,
# every /api call from it is still token-gated).
_AGENT_RELAY_RE = re.compile(r"^/agents/[^/]+/api(?:/|$)")


class AdminAuth:
    def __init__(self, token: str) -> None:
        self._token = token

    def verify(self, presented: str | None) -> bool:
        if not presented:
            return False
        return hmac.compare_digest(presented, self._token)  # A3 constant time

    def verify_request(self, request: Request) -> bool:
        header = request.headers.get("x-caduceus-token")
        if header is None:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                header = auth[7:].strip()
        return self.verify(header)


class AdminAuthMiddleware(BaseHTTPMiddleware):
    """Deny-by-default gate (A1): rejects before any body parsing."""

    def __init__(self, app, auth: AdminAuth) -> None:  # type: ignore[no-untyped-def]
        super().__init__(app)
        self._auth = auth

    async def dispatch(
        self, request: Request, call_next: RequestResponseEndpoint
    ) -> Response:
        path = request.url.path
        protected = (
            path.startswith("/api/") or bool(_AGENT_RELAY_RE.match(path))
        ) and path not in _PUBLIC_PATHS
        if protected and not self._auth.verify_request(request):
            # A3: undifferentiated 401
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
        return await call_next(request)
