"""Gateway token lifecycle (AD-6, rules S1–S2, logic §3).

Plaintext tokens exist only (a) in the one-shot issue result and (b) in the
profile ``.env`` written by the provisioner. The registry stores sha256 hex.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from dataclasses import dataclass
from pathlib import Path

from caduceus.core.ports import FileStore
from caduceus.core.types import validate_agent_name

_TOKEN_RANDOM_HEX = 32  # 128 bits (S1)

ADMIN_TOKEN_FILE = "admin.token"  # noqa: S105 - file NAME, not a credential
_ADMIN_TOKEN_BYTES = 32


def load_or_create_admin_token(caduceus_home: Path, files: FileStore) -> str:
    """Admin API token (FD6): CSPRNG at first use, stored 0600.

    Lives in core (not control) so the CLI's ``init`` can create it without
    importing the daemon planes (CLI-D1/D3); control.auth delegates here.
    """
    path = caduceus_home / ADMIN_TOKEN_FILE
    if files.exists(path):
        token = files.read_text(path).strip()
        if token:
            return token
    token = secrets.token_hex(_ADMIN_TOKEN_BYTES)
    files.write_text_atomic(path, token + "\n", mode=0o600)
    return token


@dataclass(frozen=True)
class IssuedToken:
    """One-shot issue result. ``plaintext`` must never be persisted by callers
    other than the profile ``.env`` writer; ``repr`` masks it defensively."""

    agent: str
    plaintext: str
    token_hash: str

    def __repr__(self) -> str:  # S1: no plaintext in logs/reprs
        return f"IssuedToken(agent={self.agent!r}, plaintext='***', token_hash={self.token_hash!r})"


def hash_token(plaintext: str) -> str:
    return hashlib.sha256(plaintext.encode("utf-8")).hexdigest()


def issue_token(agent_name: str) -> IssuedToken:
    name = validate_agent_name(agent_name)
    plaintext = f"cad-{name}-{secrets.token_hex(_TOKEN_RANDOM_HEX // 2)}"
    return IssuedToken(agent=name, plaintext=plaintext, token_hash=hash_token(plaintext))


class TokenResolver:
    """In-memory bearer→agent resolution for the proxy hot path (<1ms).

    Rebuilt from the registry on startup and after every registry change
    (explicit invalidation — a removed token must stop resolving immediately).
    """

    def __init__(self) -> None:
        self._by_hash: dict[str, str] = {}

    def rebuild(self, token_hash_to_agent: dict[str, str]) -> None:
        self._by_hash = dict(token_hash_to_agent)

    def resolve(self, bearer: str) -> str | None:
        """Constant-time-per-entry comparison over all entries (S2).

        Iterates every entry without early exit so response timing does not
        depend on which (or whether an) entry matched.
        """
        digest = hash_token(bearer)
        found: str | None = None
        for stored_hash, agent in self._by_hash.items():
            if hmac.compare_digest(digest, stored_hash):
                found = agent
        return found
