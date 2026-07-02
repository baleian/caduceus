"""P1 (registry round-trip) and P3 (port allocation invariants)."""

from __future__ import annotations

from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st

from caduceus.core.registry import Registry, RegistryStore
from caduceus.core.types import RegistryFile
from tests.property.strategies import registry_files
from tests.unit.fakes import FakeClock, InMemoryFileStore


def make_registry(doc: RegistryFile | None = None) -> Registry:
    files = InMemoryFileStore()
    store = RegistryStore(Path("/reg/registry.json"), files, FakeClock())
    if doc is not None:
        store.save(doc)
    return Registry(store, port_in_use=lambda _: False)


@given(registry_files())
def test_p1_save_load_round_trip(doc: RegistryFile) -> None:
    files = InMemoryFileStore()
    store = RegistryStore(Path("/reg/registry.json"), files, FakeClock())
    store.save(doc)
    assert store.load() == doc


@given(registry_files(), st.integers(min_value=1024, max_value=60000))
def test_p3_allocated_port_is_free_and_deterministic(doc: RegistryFile, base: int) -> None:
    reg = make_registry(doc)
    used = {r.api_port for r in doc.agents.values()}
    p1 = reg.allocate_port(base)
    p2 = reg.allocate_port(base)
    assert p1 not in used
    assert p1 >= base
    assert p1 == p2  # deterministic: same inputs → same result


@given(registry_files(), st.integers(min_value=1024, max_value=60000))
def test_p3_allocation_does_not_mutate_registry(doc: RegistryFile, base: int) -> None:
    reg = make_registry(doc)
    before = {r.spec.name: r.api_port for r in reg.list()}
    reg.allocate_port(base)
    after = {r.spec.name: r.api_port for r in reg.list()}
    assert before == after
