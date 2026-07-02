"""Admin API authentication (FD6, rules A1–A4).

A single CSPRNG token, generated at init time, stored 0600, compared in
constant time. Applies to every /api/* and /agents/* route; /healthz is the
only public path.
"""

from __future__ import annotations

import hmac
import secrets
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint

from caduceus.core.ports import FileStore

ADMIN_TOKEN_FILE = "admin.token"  # noqa: S105 - file NAME, not a credential
_TOKEN_BYTES = 32
_PUBLIC_PATHS = frozenset({"/healthz"})
_PROTECTED_PREFIXES = ("/api/", "/agents/")


def load_or_create_admin_token(caduceus_home: Path, files: FileStore) -> str:
    path = caduceus_home / ADMIN_TOKEN_FILE
    if files.exists(path):
        token = files.read_text(path).strip()
        if token:
            return token
    token = secrets.token_hex(_TOKEN_BYTES)
    files.write_text_atomic(path, token + "\n", mode=0o600)
    return token


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
        protected = path.startswith(_PROTECTED_PREFIXES) and path not in _PUBLIC_PATHS
        if protected and not self._auth.verify_request(request):
            # A3: undifferentiated 401
            return JSONResponse(status_code=401, content={"error": "unauthorized"})
        return await call_next(request)
