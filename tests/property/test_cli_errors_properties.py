"""PU3-1 — total error mapping: any input resolves to exactly one exit code."""

from __future__ import annotations

import httpx
from hypothesis import given
from hypothesis import strategies as st

from caduceus.cli.errors import (
    CliError,
    ExitCode,
    _status_exit_code,
    error_from_response,
    map_exception,
)
from caduceus.core.errors import (
    CaduceusError,
    ConfigError,
    DomainValidationError,
    HermesError,
    NotFoundError,
)


def _oracle(status: int) -> ExitCode:
    """Independent restatement of business-logic §7."""
    table = {401: 3, 403: 3, 404: 4, 409: 5, 400: 2, 422: 2}
    return ExitCode(table.get(status, 1))


@given(st.integers(min_value=100, max_value=599))
def test_status_mapping_matches_oracle(status: int) -> None:
    assert _status_exit_code(status) == _oracle(status)


@given(st.integers(min_value=100, max_value=599), st.binary(max_size=200))
def test_error_from_response_is_total(status: int, body: bytes) -> None:
    err = error_from_response(status, body)
    assert isinstance(err, CliError)
    assert err.exit_code == _oracle(status)
    assert err.message  # never empty


@given(
    st.integers(min_value=100, max_value=599),
    st.one_of(
        st.builds(lambda m: {"error": m}, st.text(min_size=1, max_size=50)),
        st.builds(lambda m: {"detail": m}, st.text(min_size=1, max_size=50)),
        st.builds(
            lambda m: {"error": {"message": m, "code": "x"}},
            st.text(min_size=1, max_size=50),
        ),
    ),
)
def test_error_message_extracted_from_all_body_shapes(status: int, body: dict) -> None:
    import json

    err = error_from_response(status, json.dumps(body))
    expected = body.get("detail") or body["error"]
    if isinstance(expected, dict):
        expected = expected["message"]
    assert err.message == expected or "***" in err.message  # redaction may mask


_EXCEPTIONS = st.one_of(
    st.builds(lambda m: httpx.ConnectError(m), st.text(max_size=20)),
    st.builds(lambda m: httpx.ConnectTimeout(m), st.text(max_size=20)),
    st.builds(lambda m: httpx.ReadTimeout(m), st.text(max_size=20)),
    st.builds(lambda m: NotFoundError(m), st.text(min_size=1, max_size=20)),
    st.builds(lambda m: DomainValidationError(m), st.text(min_size=1, max_size=20)),
    st.builds(lambda m: ConfigError(m), st.text(min_size=1, max_size=20)),
    st.builds(lambda m: HermesError(m), st.text(min_size=1, max_size=20)),
    st.builds(lambda m: CaduceusError(m), st.text(min_size=1, max_size=20)),
    st.builds(lambda m: ValueError(m), st.text(max_size=20)),
    st.builds(lambda m: RuntimeError(m), st.text(max_size=20)),
)


@given(_EXCEPTIONS)
def test_map_exception_is_total(exc: Exception) -> None:
    err = map_exception(exc)
    assert isinstance(err, CliError)
    assert err.exit_code in ExitCode
    # class → code contract
    if isinstance(exc, httpx.TransportError):
        assert err.exit_code == ExitCode.UNREACHABLE
    elif isinstance(exc, NotFoundError):
        assert err.exit_code == ExitCode.NOT_FOUND
    elif isinstance(exc, DomainValidationError):
        assert err.exit_code == ExitCode.USAGE
    elif isinstance(exc, ConfigError):
        assert err.exit_code == ExitCode.UNREACHABLE
    elif isinstance(exc, CaduceusError):
        assert err.exit_code == ExitCode.ERROR


@given(st.text(alphabet="0123456789abcdef", min_size=32, max_size=64))
def test_secret_hex_is_redacted_in_messages(secret: str) -> None:
    err = map_exception(CaduceusError(f"token {secret} leaked"))
    assert secret not in err.message  # CLI-P2


def test_map_exception_passes_cli_error_through() -> None:
    original = CliError("x", ExitCode.REFUSED)
    assert map_exception(original) is original
