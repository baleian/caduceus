"""Core foundation (U1): domain types, registry, hermes adapter, process manager.

Layering rules (unit-of-work.md):
- ``types``/``errors``/``ports`` are the bottom layer — everything may import them.
- ``registry``/``tokens``/``render`` are pure-ish domain services over ports.
- ``hermes_adapter``/``process_manager``/``workspace``/``config`` are effectful
  boundary components. Nothing in ``core`` may import from ``caduceus.proxy``,
  ``caduceus.control`` or ``caduceus.cli`` (upward imports forbidden).
"""
