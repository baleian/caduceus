"""Overlap-dedup follow for snapshot log endpoints (pattern P8, PU3-6).

The daemon exposes logs as "last N lines" snapshots; ``advance`` computes the
newly appended suffix between two snapshots by matching the largest overlap
between the previous snapshot's tail and the new snapshot's head.

Known limitation (documented, business-rules CLI-E2 no-silent-failure): with
fully repetitive identical lines the overlap is ambiguous and the largest-match
rule may conservatively dedup; gateway logs are timestamped so this does not
occur in practice. A vanished overlap (rotation/gap) is reported, never
silently skipped.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TailStep:
    new_lines: list[str]
    gap: bool  # True when no overlap was found (rotation or window overrun)


def advance(prev: list[str], fetched: list[str]) -> TailStep:
    """Pure: previous snapshot × new snapshot → newly appended lines."""
    if not prev:
        return TailStep(new_lines=list(fetched), gap=False)
    if not fetched:
        return TailStep(new_lines=[], gap=False)
    max_k = min(len(prev), len(fetched))
    for k in range(max_k, 0, -1):
        if prev[len(prev) - k:] == fetched[:k]:
            return TailStep(new_lines=list(fetched[k:]), gap=False)
    return TailStep(new_lines=list(fetched), gap=True)
