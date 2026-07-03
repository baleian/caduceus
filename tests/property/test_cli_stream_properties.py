"""PU3-3 (SSE parser totality + round-trip) and PU3-6 (tail dedup)."""

from __future__ import annotations

from hypothesis import given
from hypothesis import strategies as st

from caduceus.cli.sse import SseEvent, iter_sse
from caduceus.cli.tail import advance

# -- PU3-3: SSE ------------------------------------------------------------------

EVENT_NAMES = st.text(
    alphabet=st.characters(min_codepoint=33, max_codepoint=126, exclude_characters=":"),
    min_size=1,
    max_size=12,
)
DATA_TEXT = st.text(
    alphabet=st.characters(exclude_characters="\r\n"), max_size=40
)


def _serialize(events: list[tuple[str, str]]) -> bytes:
    out = ""
    for name, data in events:
        out += f"event: {name}\ndata: {data}\n\n"
    return out.encode()


@st.composite
def chunked(draw: st.DrawFn, payload: bytes) -> list[bytes]:
    if not payload:
        return []
    cuts = draw(
        st.lists(st.integers(min_value=1, max_value=len(payload)), max_size=8, unique=True)
    )
    points = [0, *sorted(cuts), len(payload)]
    return [payload[a:b] for a, b in zip(points, points[1:], strict=False) if a < b]


@st.composite
def events_and_chunks(draw: st.DrawFn) -> tuple[list[tuple[str, str]], list[bytes]]:
    events = draw(st.lists(st.tuples(EVENT_NAMES, DATA_TEXT), max_size=6))
    chunks = draw(chunked(_serialize(events)))
    return events, chunks


@given(events_and_chunks())
def test_pu3_3_round_trip_under_any_chunking(
    case: tuple[list[tuple[str, str]], list[bytes]],
) -> None:
    events, chunks = case
    parsed = list(iter_sse(chunks))
    assert parsed == [SseEvent(event=n, data=d) for n, d in events]


@given(st.lists(st.binary(max_size=64), max_size=10))
def test_pu3_3_parser_is_total_on_garbage(chunks: list[bytes]) -> None:
    events = list(iter_sse(chunks))  # must not raise, must terminate
    for event in events:
        assert isinstance(event.event, str) and isinstance(event.data, str)


def test_keepalive_comments_and_multiline_data() -> None:
    raw = b": keepalive\n\nevent: e\ndata: a\ndata: b\n\n"
    assert list(iter_sse([raw])) == [SseEvent(event="e", data="a\nb")]


def test_truncated_final_event_is_not_fabricated() -> None:
    raw = b"event: e\ndata: complete\n\nevent: e2\ndata: parti"
    assert list(iter_sse([raw])) == [SseEvent(event="e", data="complete")]


# -- PU3-6: tail -------------------------------------------------------------------


@st.composite
def log_growth(draw: st.DrawFn) -> tuple[list[list[str]], int]:
    """Unique (timestamped-like) log lines appended over several polls."""
    total = draw(st.integers(min_value=1, max_value=40))
    lines = [f"line-{i}" for i in range(total)]
    cut_points = draw(
        st.lists(st.integers(min_value=1, max_value=total), min_size=1, max_size=6, unique=True)
    )
    points = sorted(set(cut_points) | {total})
    snapshots_growth = [lines[:p] for p in points]
    window = draw(st.integers(min_value=total, max_value=total + 10))
    return snapshots_growth, window


@given(log_growth())
def test_pu3_6_no_duplication_no_loss(case: tuple[list[list[str]], int]) -> None:
    growth, window = case
    prev: list[str] = []
    emitted: list[str] = []
    for full_log in growth:
        fetched = full_log[-window:]
        step = advance(prev, fetched)
        assert not step.gap  # window covers the full log in this generator
        emitted.extend(step.new_lines)
        prev = fetched
    assert emitted == growth[-1]  # exact reconstruction: no dupes, no loss


def test_gap_reported_when_overlap_vanishes() -> None:
    step = advance(["a", "b"], ["x", "y"])
    assert step.gap is True
    assert step.new_lines == ["x", "y"]


def test_first_poll_prints_snapshot_as_is() -> None:
    assert advance([], ["a", "b"]).new_lines == ["a", "b"]
