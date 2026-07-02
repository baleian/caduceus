"""P8 — backoff schedule invariants (pure function extracted for PBT)."""

from __future__ import annotations

import pytest
from hypothesis import given
from hypothesis import strategies as st

from caduceus.core.process_manager import BACKOFF_BASE_S, BACKOFF_CAP_S, next_backoff_s

attempts = st.integers(min_value=0, max_value=10_000)


@given(attempts)
def test_p8_backoff_within_bounds(attempt: int) -> None:
    delay = next_backoff_s(attempt)
    assert BACKOFF_BASE_S <= delay <= BACKOFF_CAP_S


@given(attempts, attempts)
def test_p8_backoff_monotone_nondecreasing(a: int, b: int) -> None:
    low, high = sorted((a, b))
    assert next_backoff_s(low) <= next_backoff_s(high)


def test_p8_initial_and_cap_examples() -> None:
    assert next_backoff_s(0) == 1.0
    assert next_backoff_s(1) == 2.0
    assert next_backoff_s(2) == 4.0
    assert next_backoff_s(6) == 60.0
    assert next_backoff_s(999) == 60.0


def test_p8_negative_attempt_rejected() -> None:
    with pytest.raises(ValueError):
        next_backoff_s(-1)
